#![allow(dead_code)]
// Phase 0 wired the protocol; Phase 1 wires it to real panes. Most of the
// share-session lifecycle now has consumers (Tauri commands), but the
// pane-broadcast hook in commands.rs and the frontend UI are still being
// wired in this PR — the allow keeps clippy quiet on items the compiler
// can't yet see used until both ends land.

//! In-app HTTP/WebSocket server for collab share sessions.
//!
//! See `docs/multiplayer-design.md` and `docs/adr/0001-multiplayer-via-tailscale.md`.
//!
//! ## Lifecycle
//!
//! 1. User clicks "Share pane" in wmux. The frontend calls the `share_pane`
//!    Tauri command, which mints a [`ShareSession`] bound to a specific pane.
//! 2. The frontend captures the current pane buffer via xterm.js's
//!    `SerializeAddon` and calls `provide_share_snapshot` so a join-later
//!    viewer sees the current screen, not just bytes after they connected.
//! 3. The host's [`crate::commands::start_session_stream`] is responsible
//!    for forking pane output bytes into every active share's broadcast
//!    channel (see [`ShareSessionStore::for_each_share_on_pane`]).
//! 4. A viewer opens the share URL. The PWA viewer reads the secret from
//!    the URL fragment, opens a WS to `/ws/:code`, and sends an `Auth`
//!    message. The secret never appears in URL paths/queries or server
//!    access logs.
//! 5. After Auth + Hello, the server sends the cached snapshot (if any)
//!    as the first `OutputChunk`, then enters the pump loop.

use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use collab_proto::{ParticipantId, SessionCode, SessionMessage, PROTOCOL_VERSION};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Mutex, RwLock};

const OUTPUT_BROADCAST_CAPACITY: usize = 256;
const AUDIT_RING_CAPACITY: usize = 1024;
const REPLAY_BUFFER_MAX_BYTES: usize = 4 * 1024 * 1024; // ~4 MB
const REPLAY_BUFFER_MAX_AGE: Duration = Duration::from_secs(5 * 60); // 5 minutes

/// What a viewer is allowed to do on a share. Read-only in Phase 1; the
/// read-write variant exists so the wire format and the Tauri command
/// surface don't change again in Phase 3.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SharePermission {
    Read,
    ReadWrite,
}

/// Bounded ring of recent PTY chunks. Replayed verbatim to any connecting
/// or reconnecting viewer. Bounded by total byte count and per-entry age
/// (whichever fires first). Cheap pushes: O(1) amortised, no allocations
/// for the chunk itself (caller hands us the Vec).
pub struct ReplayBuffer {
    entries: std::collections::VecDeque<(Instant, Vec<u8>)>,
    total_bytes: usize,
    max_bytes: usize,
    max_age: Duration,
}

impl Default for ReplayBuffer {
    fn default() -> Self {
        Self::new(REPLAY_BUFFER_MAX_BYTES, REPLAY_BUFFER_MAX_AGE)
    }
}

impl ReplayBuffer {
    pub fn new(max_bytes: usize, max_age: Duration) -> Self {
        Self {
            entries: std::collections::VecDeque::new(),
            total_bytes: 0,
            max_bytes,
            max_age,
        }
    }

    pub fn push(&mut self, chunk: Vec<u8>) {
        let now = Instant::now();
        self.total_bytes += chunk.len();
        self.entries.push_back((now, chunk));
        // Prune entries older than max_age.
        let age_cutoff = now.checked_sub(self.max_age).unwrap_or(now);
        while let Some((t, _)) = self.entries.front() {
            if *t < age_cutoff {
                let (_, c) = self.entries.pop_front().unwrap();
                self.total_bytes = self.total_bytes.saturating_sub(c.len());
            } else {
                break;
            }
        }
        // Then prune by total size — always keep at least the just-pushed
        // entry so a single oversized chunk doesn't leave the buffer empty.
        while self.total_bytes > self.max_bytes && self.entries.len() > 1 {
            let (_, c) = self.entries.pop_front().unwrap();
            self.total_bytes = self.total_bytes.saturating_sub(c.len());
        }
    }

    pub fn snapshot(&self) -> Vec<Vec<u8>> {
        self.entries.iter().map(|(_, b)| b.clone()).collect()
    }

    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Single live share session. Cloning is cheap — only the cached snapshot
/// is behind a mutex; everything else is either Copy or Arc-shared.
#[derive(Clone)]
pub struct ShareSession {
    pub code: SessionCode,
    pub target_pane_id: String,
    pub permission: SharePermission,
    pub created_at: Instant,
    pub expires_at: Instant,
    pub secret_hash: [u8; 32],
    pub output_tx: broadcast::Sender<Vec<u8>>,
    pub presence: Arc<AtomicUsize>,
    pub snapshot: Arc<Mutex<Option<Vec<u8>>>>,
    /// Rolling ring of recent PTY bytes. Replayed to any connecting (or
    /// reconnecting) viewer so a dropped WebSocket reopens to the current
    /// screen rather than the screen at share-creation time. std::sync
    /// because start_session_stream feeds this from a sync closure.
    pub replay_buffer: Arc<std::sync::Mutex<ReplayBuffer>>,
}

impl ShareSession {
    pub fn presence_count(&self) -> usize {
        self.presence.load(Ordering::Relaxed)
    }
}

/// Audit-log entry. Persisted to a ring buffer at the store level — fine for
/// a single wmux session. Persistence to SQLite is deferred.
#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    /// Unix-epoch milliseconds.
    pub at_ms: u64,
    pub code: String,
    pub participant: Option<String>,
    pub event: AuditEventKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditEventKind {
    Created,
    Revoked,
    Expired,
    Connected,
    Disconnected,
    AuthFailed,
}

/// Lightweight serialisable projection of a [`ShareSession`] for the Tauri
/// command surface (`list_active_shares`). Excludes the broadcast sender,
/// snapshot bytes, and secret hash.
#[derive(Debug, Clone, Serialize)]
pub struct ShareInfo {
    pub code: String,
    pub target_pane_id: String,
    pub permission: SharePermission,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub presence: usize,
    /// Path component for the viewer URL — `/s/<code>`. Host doesn't know
    /// its own IP for sure, so the frontend assembles the full URL.
    pub path: String,
}

impl ShareInfo {
    fn from_session(s: &ShareSession) -> Self {
        // Convert monotonic Instants to wall-clock millis by anchoring on
        // SystemTime now() and offsetting. Close enough for UI display.
        let now_inst = Instant::now();
        let now_ms = system_now_ms();
        let created_at_ms = now_ms.saturating_sub(now_inst.duration_since(s.created_at).as_millis() as u64);
        let remaining_ms = s.expires_at.saturating_duration_since(now_inst).as_millis() as u64;
        Self {
            code: s.code.0.clone(),
            target_pane_id: s.target_pane_id.clone(),
            permission: s.permission,
            created_at_ms,
            expires_at_ms: now_ms.saturating_add(remaining_ms),
            presence: s.presence_count(),
            path: format!("/s/{}", s.code.0),
        }
    }
}

#[derive(Default)]
struct AuditLog {
    entries: VecDeque<AuditEntry>,
}

impl AuditLog {
    fn push(&mut self, entry: AuditEntry) {
        if self.entries.len() >= AUDIT_RING_CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }
}

/// In-memory registry of active share sessions plus the audit ring buffer.
/// Lost on wmux restart — intentional. Re-share is one click.
#[derive(Clone, Default)]
pub struct ShareSessionStore {
    inner: Arc<RwLock<StoreInner>>,
}

#[derive(Default)]
struct StoreInner {
    sessions: HashMap<SessionCode, ShareSession>,
    audit: AuditLog,
}

/// Returned by [`ShareSessionStore::create`] — pairs the raw secret (the
/// caller embeds it in the share URL fragment) with the sender side of the
/// output broadcast.
pub struct MintedShare {
    pub secret: String,
    pub session: ShareSession,
}

impl ShareSessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a new share bound to `target_pane_id`. The secret returned in
    /// [`MintedShare`] is never stored — only its SHA-256 hash is.
    pub async fn create(
        &self,
        code: SessionCode,
        target_pane_id: String,
        permission: SharePermission,
        ttl: Duration,
    ) -> MintedShare {
        let secret = random_secret();
        let secret_hash = sha256(secret.as_bytes());
        let (output_tx, _rx) = broadcast::channel(OUTPUT_BROADCAST_CAPACITY);
        let session = ShareSession {
            code: code.clone(),
            target_pane_id,
            permission,
            created_at: Instant::now(),
            expires_at: Instant::now() + ttl,
            secret_hash,
            output_tx,
            presence: Arc::new(AtomicUsize::new(0)),
            snapshot: Arc::new(Mutex::new(None)),
            replay_buffer: Arc::new(std::sync::Mutex::new(ReplayBuffer::default())),
        };
        let mut inner = self.inner.write().await;
        inner.sessions.insert(code.clone(), session.clone());
        inner.audit.push(AuditEntry {
            at_ms: system_now_ms(),
            code: code.0,
            participant: None,
            event: AuditEventKind::Created,
        });
        MintedShare { secret, session }
    }

    pub async fn get(&self, code: &SessionCode) -> Option<ShareSession> {
        self.inner.read().await.sessions.get(code).cloned()
    }

    pub async fn revoke(&self, code: &SessionCode) -> bool {
        let mut inner = self.inner.write().await;
        let removed = inner.sessions.remove(code).is_some();
        if removed {
            inner.audit.push(AuditEntry {
                at_ms: system_now_ms(),
                code: code.0.clone(),
                participant: None,
                event: AuditEventKind::Revoked,
            });
        }
        removed
    }

    /// Apply `f` to every share that targets `pane_id`. Used by
    /// `start_session_stream` to fan-out PTY bytes.
    pub async fn for_each_share_on_pane(&self, pane_id: &str, mut f: impl FnMut(&ShareSession)) {
        let inner = self.inner.read().await;
        for session in inner.sessions.values() {
            if session.target_pane_id == pane_id {
                f(session);
            }
        }
    }

    pub async fn list(&self) -> Vec<ShareInfo> {
        let inner = self.inner.read().await;
        inner.sessions.values().map(ShareInfo::from_session).collect()
    }

    pub async fn set_snapshot(&self, code: &SessionCode, bytes: Vec<u8>) -> bool {
        let Some(session) = self.get(code).await else { return false };
        let mut snap = session.snapshot.lock().await;
        *snap = Some(bytes);
        true
    }

    pub async fn audit_entries(&self) -> Vec<AuditEntry> {
        let inner = self.inner.read().await;
        inner.entries_to_vec()
    }

    pub async fn push_audit(&self, entry: AuditEntry) {
        self.inner.write().await.audit.push(entry);
    }

    /// Drop entries past their `expires_at`, recording an `Expired` audit
    /// entry for each. Cheap; runs from a background sweeper every minute.
    pub async fn sweep_expired(&self) {
        let now = Instant::now();
        let mut inner = self.inner.write().await;
        let expired: Vec<SessionCode> = inner
            .sessions
            .iter()
            .filter(|(_, s)| s.expires_at <= now)
            .map(|(k, _)| k.clone())
            .collect();
        for code in expired {
            inner.sessions.remove(&code);
            inner.audit.push(AuditEntry {
                at_ms: system_now_ms(),
                code: code.0,
                participant: None,
                event: AuditEventKind::Expired,
            });
        }
    }

    pub fn spawn_expiry_sweeper(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.tick().await;
            loop {
                interval.tick().await;
                self.sweep_expired().await;
            }
        })
    }
}

impl StoreInner {
    fn entries_to_vec(&self) -> Vec<AuditEntry> {
        self.audit.entries.iter().cloned().collect()
    }
}

#[derive(Clone)]
struct AppState {
    store: ShareSessionStore,
}

// ── Routes ──────────────────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
}

async fn ws_handler(
    Path(code): Path<String>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let code = SessionCode(code);
    ws.on_upgrade(move |socket| handle_socket(socket, state.store, code))
}

async fn handle_socket(mut socket: WebSocket, store: ShareSessionStore, code: SessionCode) {
    // Auth phase: first frame must be Auth carrying the secret.
    let Some(Ok(first)) = socket.recv().await else { return };
    let Message::Text(first_text) = first else { return };
    let Ok(SessionMessage::Auth { secret }) = serde_json::from_str(&first_text) else {
        return;
    };

    let Some(session) = store.get(&code).await else {
        push_audit(&store, &code.0, None, AuditEventKind::AuthFailed).await;
        return;
    };
    if session.expires_at <= Instant::now() {
        push_audit(&store, &code.0, None, AuditEventKind::AuthFailed).await;
        return;
    }
    if !constant_time_eq(&sha256(secret.as_bytes()), &session.secret_hash) {
        push_audit(&store, &code.0, None, AuditEventKind::AuthFailed).await;
        return;
    }

    // Hello handshake.
    let Some(Ok(second)) = socket.recv().await else { return };
    let Message::Text(second_text) = second else { return };
    let Ok(SessionMessage::Hello { protocol_version, participant }) = serde_json::from_str(&second_text) else {
        return;
    };
    if protocol_version != PROTOCOL_VERSION {
        return;
    }

    let server_hello = SessionMessage::Hello {
        protocol_version: PROTOCOL_VERSION,
        participant: ParticipantId("host".to_string()),
    };
    if socket
        .send(Message::Text(serde_json::to_string(&server_hello).unwrap()))
        .await
        .is_err()
    {
        return;
    }

    // Send the cached snapshot, if any, as the first OutputChunk so the
    // viewer renders the current buffer rather than waiting for new bytes.
    if let Some(bytes) = session.snapshot.lock().await.clone() {
        let frame = SessionMessage::OutputChunk { bytes };
        if socket
            .send(Message::Text(serde_json::to_string(&frame).unwrap()))
            .await
            .is_err()
        {
            return;
        }
    }

    // Replay the recent-output ring so a (re)connecting viewer catches up
    // to the current pane state without the host having to push fresh
    // bytes. Bounded ~4 MB / ~5 minutes — see [`ReplayBuffer`].
    let replay_chunks = {
        let buf = session.replay_buffer.lock().unwrap();
        buf.snapshot()
    };
    for bytes in replay_chunks {
        let frame = SessionMessage::OutputChunk { bytes };
        if socket
            .send(Message::Text(serde_json::to_string(&frame).unwrap()))
            .await
            .is_err()
        {
            return;
        }
    }

    // Presence + audit for this connection.
    session.presence.fetch_add(1, Ordering::Relaxed);
    push_audit(
        &store,
        &code.0,
        Some(participant.0.clone()),
        AuditEventKind::Connected,
    )
    .await;

    let mut output_rx = session.output_tx.subscribe();
    loop {
        tokio::select! {
            chunk = output_rx.recv() => {
                let Ok(bytes) = chunk else { break };
                let frame = SessionMessage::OutputChunk { bytes };
                let text = serde_json::to_string(&frame).unwrap();
                if socket.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Err(_)) => break,
                    _ => continue,
                }
            }
        }
    }

    session.presence.fetch_sub(1, Ordering::Relaxed);
    push_audit(
        &store,
        &code.0,
        Some(participant.0),
        AuditEventKind::Disconnected,
    )
    .await;
}

async fn push_audit(
    store: &ShareSessionStore,
    code: &str,
    participant: Option<String>,
    event: AuditEventKind,
) {
    store
        .push_audit(AuditEntry {
            at_ms: system_now_ms(),
            code: code.to_string(),
            participant,
            event,
        })
        .await;
}

// ── PWA viewer (static assets, embedded at compile time) ────────────────

const VIEWER_INDEX: &str = include_str!("../../viewer-pwa/index.html");
const VIEWER_MJS: &str = include_str!("../../viewer-pwa/viewer.mjs");
const VIEWER_SW: &str = include_str!("../../viewer-pwa/sw.js");
const VIEWER_MANIFEST: &str = include_str!("../../viewer-pwa/manifest.webmanifest");
const VIEWER_CSS: &str = include_str!("../../viewer-pwa/viewer.css");
const VIEWER_XTERM_CSS: &str = include_str!("../../viewer-pwa/vendor/xterm.css");
const VIEWER_XTERM_JS: &str = include_str!("../../viewer-pwa/vendor/xterm.js");
const VIEWER_ADDON_FIT_JS: &str = include_str!("../../viewer-pwa/vendor/addon-fit.js");

async fn viewer_index(State(state): State<AppState>, Path(code): Path<String>) -> Response {
    // 404 fast if the code doesn't exist so we don't ship the viewer to
    // someone who's just guessing.
    if state.store.get(&SessionCode(code)).await.is_none() {
        return (StatusCode::NOT_FOUND, "no such share").into_response();
    }
    static_response(VIEWER_INDEX.as_bytes(), "text/html; charset=utf-8")
}

async fn viewer_asset(Path((_code, name)): Path<(String, String)>) -> Response {
    let (body, ctype): (&[u8], &str) = match name.as_str() {
        "viewer.mjs" => (VIEWER_MJS.as_bytes(), "text/javascript; charset=utf-8"),
        "viewer.css" => (VIEWER_CSS.as_bytes(), "text/css; charset=utf-8"),
        "sw.js" => (VIEWER_SW.as_bytes(), "text/javascript; charset=utf-8"),
        "manifest.webmanifest" => (VIEWER_MANIFEST.as_bytes(), "application/manifest+json"),
        "xterm.css" => (VIEWER_XTERM_CSS.as_bytes(), "text/css; charset=utf-8"),
        "xterm.js" => (VIEWER_XTERM_JS.as_bytes(), "text/javascript; charset=utf-8"),
        "addon-fit.js" => (VIEWER_ADDON_FIT_JS.as_bytes(), "text/javascript; charset=utf-8"),
        _ => return (StatusCode::NOT_FOUND, "not found").into_response(),
    };
    static_response(body, ctype)
}

fn static_response(body: &'static [u8], content_type: &str) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .body(axum::body::Body::from(body))
        .unwrap()
}

pub fn router(store: ShareSessionStore) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws/:code", get(ws_handler))
        .route("/s/:code", get(viewer_index))
        .route("/s/:code/:name", get(viewer_asset))
        .with_state(AppState { store })
}

pub async fn serve(
    addr: SocketAddr,
    store: ShareSessionStore,
) -> std::io::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    let app = router(store);
    let handle = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok((local, handle))
}

// ── Helpers ──────────────────────────────────────────────────────────────

fn random_secret() -> String {
    // Phase 1 still doesn't need cryptographic-grade randomness — the secret
    // is bound to a session that lives at most hours and is hashed before
    // storage. Stir in process id + a few sources of nondeterminism via
    // multiple SystemTime reads to defeat trivial guessing.
    let mut hasher = Sha256::new();
    hasher.update(system_now_ns().to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    // Read again to capture more entropy from inter-call jitter.
    hasher.update(system_now_ns().to_le_bytes());
    let digest = hasher.finalize();
    hex(&digest)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn system_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn system_now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use collab_proto::{ParticipantId, SessionMessage};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as TMessage;

    async fn mint_and_serve(
        pane_id: &str,
    ) -> (String, ShareSession, ShareSessionStore, SocketAddr) {
        let store = ShareSessionStore::new();
        let MintedShare { secret, session } = store
            .create(
                SessionCode("smoke-abc".to_string()),
                pane_id.to_string(),
                SharePermission::Read,
                Duration::from_secs(30),
            )
            .await;
        let (addr, _h) = serve(([127, 0, 0, 1], 0).into(), store.clone())
            .await
            .expect("server binds");
        (secret, session, store, addr)
    }

    async fn connect_and_auth(addr: SocketAddr, code: &str, secret: &str) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
        let url = format!("ws://{addr}/ws/{code}");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let auth = SessionMessage::Auth { secret: secret.to_string() };
        ws.send(TMessage::Text(serde_json::to_string(&auth).unwrap())).await.unwrap();
        let hello = SessionMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            participant: ParticipantId("viewer".to_string()),
        };
        ws.send(TMessage::Text(serde_json::to_string(&hello).unwrap())).await.unwrap();
        ws
    }

    async fn next_message(ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) -> SessionMessage {
        let msg = ws.next().await.unwrap().unwrap();
        let text = match msg {
            TMessage::Text(t) => t,
            other => panic!("expected text, got {other:?}"),
        };
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test]
    async fn auth_then_hello_then_output_chunk() {
        let (secret, session, _store, addr) = mint_and_serve("pane-1").await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;

        // Server hello.
        assert!(matches!(next_message(&mut ws).await, SessionMessage::Hello { .. }));

        // Host publishes a chunk.
        session.output_tx.send(b"hello viewer".to_vec()).unwrap();
        match next_message(&mut ws).await {
            SessionMessage::OutputChunk { bytes } => assert_eq!(bytes, b"hello viewer"),
            other => panic!("expected OutputChunk, got {other:?}"),
        }
    }

    #[test]
    fn replay_buffer_prunes_by_age() {
        let mut buf = ReplayBuffer::new(usize::MAX, Duration::from_millis(20));
        buf.push(b"old".to_vec());
        std::thread::sleep(Duration::from_millis(60));
        buf.push(b"new".to_vec());
        let chunks = buf.snapshot();
        assert_eq!(chunks, vec![b"new".to_vec()]);
    }

    #[test]
    fn replay_buffer_prunes_by_size() {
        let mut buf = ReplayBuffer::new(10, Duration::from_secs(60));
        buf.push(b"AAAAA".to_vec()); // 5
        buf.push(b"BBBBB".to_vec()); // 5 → 10 total, at cap
        buf.push(b"CCCCC".to_vec()); // 5 → would be 15, drops AAAAA
        let chunks = buf.snapshot();
        assert_eq!(chunks, vec![b"BBBBB".to_vec(), b"CCCCC".to_vec()]);
        assert_eq!(buf.total_bytes(), 10);
    }

    #[test]
    fn replay_buffer_keeps_just_pushed_even_if_oversized() {
        // Single oversized chunk must remain in the buffer; otherwise a
        // reconnecting viewer would see nothing at all.
        let mut buf = ReplayBuffer::new(4, Duration::from_secs(60));
        buf.push(b"this is too big".to_vec());
        let chunks = buf.snapshot();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0], b"this is too big");
    }

    #[tokio::test]
    async fn replay_buffer_replays_to_reconnecting_viewer() {
        let store = ShareSessionStore::new();
        let MintedShare { secret, session } = store
            .create(
                SessionCode("rep".to_string()),
                "pane-rep".to_string(),
                SharePermission::Read,
                Duration::from_secs(30),
            )
            .await;

        // Simulate output that arrived BEFORE any viewer connected.
        {
            let mut buf = session.replay_buffer.lock().unwrap();
            buf.push(b"early-1 ".to_vec());
            buf.push(b"early-2 ".to_vec());
        }

        let (addr, _h) = serve(([127, 0, 0, 1], 0).into(), store).await.unwrap();
        let mut ws = connect_and_auth(addr, "rep", &secret).await;

        // Server hello.
        assert!(matches!(next_message(&mut ws).await, SessionMessage::Hello { .. }));

        // Then the two replay entries, in order.
        let m1 = next_message(&mut ws).await;
        let m2 = next_message(&mut ws).await;
        let bytes = |m: SessionMessage| match m {
            SessionMessage::OutputChunk { bytes } => bytes,
            other => panic!("expected OutputChunk, got {other:?}"),
        };
        assert_eq!(bytes(m1), b"early-1 ");
        assert_eq!(bytes(m2), b"early-2 ");

        // Live broadcast still works after replay drains.
        session.output_tx.send(b"live!".to_vec()).unwrap();
        let m3 = next_message(&mut ws).await;
        assert_eq!(bytes(m3), b"live!");
    }

    #[tokio::test]
    async fn snapshot_sent_as_first_chunk_when_present() {
        let (secret, _session, store, addr) = mint_and_serve("pane-snap").await;
        let saved = store.set_snapshot(&SessionCode("smoke-abc".to_string()), b"PRELOADED".to_vec()).await;
        assert!(saved);

        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        // Server hello first.
        assert!(matches!(next_message(&mut ws).await, SessionMessage::Hello { .. }));
        // Then the snapshot.
        match next_message(&mut ws).await {
            SessionMessage::OutputChunk { bytes } => assert_eq!(bytes, b"PRELOADED"),
            other => panic!("expected snapshot OutputChunk, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn presence_increments_and_decrements() {
        let (secret, session, _store, addr) = mint_and_serve("pane-p").await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        // Drain the hello to ensure the server processed the connect.
        assert!(matches!(next_message(&mut ws).await, SessionMessage::Hello { .. }));

        // Give the server a beat to bump the counter.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(session.presence_count(), 1);

        drop(ws);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(session.presence_count(), 0);
    }

    #[tokio::test]
    async fn for_each_share_on_pane_iterates_only_matching() {
        let store = ShareSessionStore::new();
        let m1 = store
            .create(SessionCode("a".to_string()), "pane-1".into(), SharePermission::Read, Duration::from_secs(60))
            .await;
        let _m2 = store
            .create(SessionCode("b".to_string()), "pane-2".into(), SharePermission::Read, Duration::from_secs(60))
            .await;

        let mut hits: Vec<String> = Vec::new();
        store
            .for_each_share_on_pane("pane-1", |s| hits.push(s.code.0.clone()))
            .await;
        assert_eq!(hits, vec!["a".to_string()]);
        // Sanity: the second share is bound to pane-2.
        let _ = m1; // suppress unused warning
    }

    #[tokio::test]
    async fn audit_log_records_lifecycle() {
        let (secret, _session, store, addr) = mint_and_serve("pane-audit").await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        let _ = next_message(&mut ws).await; // server hello
        drop(ws);
        tokio::time::sleep(Duration::from_millis(80)).await;

        let entries = store.audit_entries().await;
        let kinds: Vec<_> = entries.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "Created"), "missing Created: {kinds:?}");
        assert!(kinds.iter().any(|k| k == "Connected"), "missing Connected: {kinds:?}");
        assert!(kinds.iter().any(|k| k == "Disconnected"), "missing Disconnected: {kinds:?}");
    }

    #[tokio::test]
    async fn auth_with_bad_secret_records_audit_and_closes() {
        let (_secret, _session, store, addr) = mint_and_serve("pane-bad").await;
        let url = format!("ws://{addr}/ws/smoke-abc");
        let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let auth = SessionMessage::Auth { secret: "wrong".to_string() };
        ws.send(TMessage::Text(serde_json::to_string(&auth).unwrap())).await.unwrap();

        // Server should close the socket.
        let _ = ws.next().await;
        tokio::time::sleep(Duration::from_millis(50)).await;

        let entries = store.audit_entries().await;
        let kinds: Vec<_> = entries.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "AuthFailed"), "missing AuthFailed: {kinds:?}");
    }

    #[tokio::test]
    async fn expiry_sweeper_drops_stale_entries() {
        let store = ShareSessionStore::new();
        let _m = store
            .create(SessionCode("exp".to_string()), "pane-x".into(), SharePermission::Read, Duration::from_millis(10))
            .await;
        assert!(store.get(&SessionCode("exp".to_string())).await.is_some());
        tokio::time::sleep(Duration::from_millis(50)).await;
        store.sweep_expired().await;
        assert!(store.get(&SessionCode("exp".to_string())).await.is_none());
        let kinds: Vec<_> = store.audit_entries().await.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "Expired"));
    }

    #[tokio::test]
    async fn viewer_index_404s_for_unknown_code() {
        let store = ShareSessionStore::new();
        let (addr, _h) = serve(([127, 0, 0, 1], 0).into(), store).await.unwrap();
        let resp = reqwest::get(format!("http://{addr}/s/missing")).await.unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn viewer_index_serves_html_for_known_code() {
        let (_secret, _session, _store, addr) = mint_and_serve("pane-html").await;
        let resp = reqwest::get(format!("http://{addr}/s/smoke-abc")).await.unwrap();
        assert_eq!(resp.status(), 200);
        let ctype = resp.headers().get("content-type").unwrap().to_str().unwrap();
        assert!(ctype.starts_with("text/html"));
        let body = resp.text().await.unwrap();
        // viewer-pwa/index.html should contain a recognisable marker.
        assert!(body.to_lowercase().contains("wmux"), "expected 'wmux' in viewer HTML, got: {body:.120}…");
    }

    #[tokio::test]
    async fn viewer_asset_serves_javascript() {
        let (_secret, _session, _store, addr) = mint_and_serve("pane-js").await;
        let resp = reqwest::get(format!("http://{addr}/s/smoke-abc/viewer.mjs")).await.unwrap();
        assert_eq!(resp.status(), 200);
        let ctype = resp.headers().get("content-type").unwrap().to_str().unwrap();
        assert!(ctype.contains("javascript"));
    }
}
