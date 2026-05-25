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

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

/// Callback for emitting events to the host frontend. Concrete impl is
/// constructed in `lib.rs` from a `tauri::AppHandle::emit` closure; we keep
/// this module Tauri-free so test binaries don't pull in WebView2 at link
/// time (Windows `STATUS_ENTRYPOINT_NOT_FOUND` if they do).
pub type CollabEventEmitter = std::sync::Arc<
    dyn Fn(&str, serde_json::Value) + Send + Sync + 'static,
>;

/// Callback that delivers viewer keystrokes to the host PTY identified
/// by `pane_id`. Sync — the lib.rs side spawns a tokio task internally.
/// Same Tauri-decoupling rationale as [`CollabEventEmitter`].
pub type CollabInputHandler = std::sync::Arc<
    dyn Fn(&str, &[u8]) + Send + Sync + 'static,
>;
use collab_proto::{ParticipantId, SessionCode, SessionMessage, SharePermission, PROTOCOL_VERSION};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, Mutex, RwLock};

const OUTPUT_BROADCAST_CAPACITY: usize = 256;
const AUDIT_RING_CAPACITY: usize = 1024;
const REPLAY_BUFFER_MAX_BYTES: usize = 4 * 1024 * 1024; // ~4 MB
const REPLAY_BUFFER_MAX_AGE: Duration = Duration::from_secs(5 * 60); // 5 minutes

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
    /// Phase 2.6: when true, the host has to approve every new
    /// IP+UA fingerprint before its WebSocket proceeds past Auth.
    pub mutual_confirm: bool,
    /// Fingerprints already approved by the host for this share. Keyed
    /// by short hex of `sha256(ip + ua)`. Skipped when `mutual_confirm`
    /// is false. Resets when the share is revoked.
    pub seen_fingerprints: Arc<Mutex<HashSet<String>>>,
    /// Pending approval requests — fingerprint → oneshot::Sender<bool>.
    /// The WS handler creates the channel and stashes the sender here,
    /// then awaits the receiver. The host's `respond_to_collab_approval`
    /// Tauri command (or a test) plucks the sender out and signals.
    pub pending_approvals: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
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
    ApprovalRequested,
    ApprovalGranted,
    ApprovalDenied,
    ApprovalTimedOut,
    /// A viewer sent an InputChunk on a Read-Write share. Body carries
    /// only the byte count, not the content.
    InputReceived,
    /// InputChunk received on a Read-only share — dropped.
    InputDropped,
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
    pub mutual_confirm: bool,
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
            mutual_confirm: s.mutual_confirm,
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
        mutual_confirm: bool,
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
            mutual_confirm,
            seen_fingerprints: Arc::new(Mutex::new(HashSet::new())),
            pending_approvals: Arc::new(Mutex::new(HashMap::new())),
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

    /// Resolve a pending mutual-confirm prompt. Returns `true` if a waiter
    /// was found and signalled; `false` if there was no pending request for
    /// this (code, fingerprint) pair — e.g. it already timed out, or the
    /// host clicked Allow/Deny twice.
    pub async fn respond_to_approval(
        &self,
        code: &SessionCode,
        fingerprint: &str,
        allow: bool,
    ) -> bool {
        let Some(session) = self.get(code).await else { return false };
        let tx = session.pending_approvals.lock().await.remove(fingerprint);
        if let Some(tx) = tx {
            let _ = tx.send(allow);
            true
        } else {
            false
        }
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
    /// `None` in tests; when present, the WS handler invokes it to
    /// emit `collab-approval-needed` events to the host frontend.
    emitter: Option<CollabEventEmitter>,
    /// `None` in tests; when present, viewer InputChunks on a
    /// Read-Write share route through this into the host PTY.
    input_handler: Option<CollabInputHandler>,
}

// ── Routes ──────────────────────────────────────────────────────────────

async fn health() -> &'static str {
    "ok"
}

async fn ws_handler(
    Path(code): Path<String>,
    State(state): State<AppState>,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let code = SessionCode(code);
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            state.store,
            state.emitter,
            state.input_handler,
            code,
            peer_addr,
            ua,
        )
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct ApprovalRequest {
    pub code: String,
    pub fingerprint: String,
    pub peer_ip: String,
    pub ua_hint: String,
    pub ua_full: String,
}

fn ua_hint(ua: &str) -> String {
    let lower = ua.to_lowercase();
    let device = if lower.contains("iphone") { "iPhone" }
        else if lower.contains("ipad") { "iPad" }
        else if lower.contains("android") { "Android" }
        else if lower.contains("macintosh") || lower.contains("mac os") { "Mac" }
        else if lower.contains("windows") { "Windows" }
        else if lower.contains("linux") { "Linux" }
        else { "Device" };
    let browser = if lower.contains("firefox") { "Firefox" }
        else if lower.contains("edg/") { "Edge" }
        else if lower.contains("chrome") { "Chrome" }
        else if lower.contains("safari") { "Safari" }
        else { "Browser" };
    format!("{device} {browser}")
}

fn fingerprint_of(peer: &SocketAddr, ua: &str) -> String {
    // Use IP only (not port) so the fingerprint is stable across reconnects.
    let ip_str = peer.ip().to_string();
    let mut hasher = Sha256::new();
    hasher.update(ip_str.as_bytes());
    hasher.update(b"|");
    hasher.update(ua.as_bytes());
    hex(&hasher.finalize())[..16].to_string()
}

async fn handle_socket(
    mut socket: WebSocket,
    store: ShareSessionStore,
    emitter: Option<CollabEventEmitter>,
    input_handler: Option<CollabInputHandler>,
    code: SessionCode,
    peer_addr: SocketAddr,
    ua: String,
) {
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

    // Mutual-confirm gate (Phase 2.6). If enabled AND we haven't seen this
    // fingerprint before for this share, ring the host's bell and wait up
    // to 30 s for a decision.
    if session.mutual_confirm {
        let fp = fingerprint_of(&peer_addr, &ua);
        let already_approved = session.seen_fingerprints.lock().await.contains(&fp);
        if !already_approved {
            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
            session.pending_approvals.lock().await.insert(fp.clone(), tx);

            if let Some(emit) = &emitter {
                let req = ApprovalRequest {
                    code: code.0.clone(),
                    fingerprint: fp.clone(),
                    peer_ip: peer_addr.ip().to_string(),
                    ua_hint: ua_hint(&ua),
                    ua_full: ua.clone(),
                };
                if let Ok(payload) = serde_json::to_value(&req) {
                    emit("collab-approval-needed", payload);
                }
            }
            push_audit(&store, &code.0, Some(fp.clone()), AuditEventKind::ApprovalRequested).await;

            let decision = tokio::time::timeout(Duration::from_secs(30), rx).await;
            // Always clear the pending entry, regardless of outcome.
            session.pending_approvals.lock().await.remove(&fp);
            match decision {
                Ok(Ok(true)) => {
                    session.seen_fingerprints.lock().await.insert(fp.clone());
                    push_audit(&store, &code.0, Some(fp), AuditEventKind::ApprovalGranted).await;
                }
                Ok(Ok(false)) => {
                    push_audit(&store, &code.0, Some(fp), AuditEventKind::ApprovalDenied).await;
                    return;
                }
                _ => {
                    push_audit(&store, &code.0, Some(fp), AuditEventKind::ApprovalTimedOut).await;
                    return;
                }
            }
        }
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

    // Capabilities tells the viewer what it can do — Phase 3 ships
    // share-level Read or Read-Write permission. Future extensions live
    // here (e.g. server limits, supported feature flags).
    let capabilities = SessionMessage::Capabilities {
        permission: session.permission,
    };
    if socket
        .send(Message::Text(serde_json::to_string(&capabilities).unwrap()))
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
                    Some(Ok(Message::Text(text))) => {
                        // Only InputChunks meaningfully come from a viewer
                        // post-handshake. Anything else is ignored.
                        let Ok(SessionMessage::InputChunk { from: _, bytes }) =
                            serde_json::from_str::<SessionMessage>(&text)
                        else {
                            continue;
                        };
                        if session.permission == SharePermission::ReadWrite {
                            if let Some(handler) = &input_handler {
                                handler(&session.target_pane_id, &bytes);
                            }
                            push_audit(&store, &code.0, Some(participant.0.clone()), AuditEventKind::InputReceived).await;
                        } else {
                            push_audit(&store, &code.0, Some(participant.0.clone()), AuditEventKind::InputDropped).await;
                        }
                    }
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

pub fn router(
    store: ShareSessionStore,
    emitter: Option<CollabEventEmitter>,
    input_handler: Option<CollabInputHandler>,
) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws/:code", get(ws_handler))
        .route("/s/:code", get(viewer_index))
        .route("/s/:code/:name", get(viewer_asset))
        .with_state(AppState { store, emitter, input_handler })
}

pub async fn serve(
    addr: SocketAddr,
    store: ShareSessionStore,
    emitter: Option<CollabEventEmitter>,
    input_handler: Option<CollabInputHandler>,
) -> std::io::Result<(SocketAddr, tokio::task::JoinHandle<()>)> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local = listener.local_addr()?;
    let app = router(store, emitter, input_handler)
        .into_make_service_with_connect_info::<SocketAddr>();
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
        mint_and_serve_opts(pane_id, false).await
    }

    async fn mint_and_serve_opts(
        pane_id: &str,
        mutual_confirm: bool,
    ) -> (String, ShareSession, ShareSessionStore, SocketAddr) {
        mint_and_serve_full(pane_id, SharePermission::Read, mutual_confirm, None).await
    }

    async fn mint_and_serve_full(
        pane_id: &str,
        permission: SharePermission,
        mutual_confirm: bool,
        input_handler: Option<CollabInputHandler>,
    ) -> (String, ShareSession, ShareSessionStore, SocketAddr) {
        let store = ShareSessionStore::new();
        let MintedShare { secret, session } = store
            .create(
                SessionCode("smoke-abc".to_string()),
                pane_id.to_string(),
                permission,
                Duration::from_secs(30),
                mutual_confirm,
            )
            .await;
        let (addr, _h) = serve(([127, 0, 0, 1], 0).into(), store.clone(), None, input_handler)
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

    /// Server sends Hello then Capabilities right after a successful Auth.
    /// Most tests don't care about either — drain them with this helper.
    async fn drain_handshake(ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) {
        assert!(matches!(next_message(ws).await, SessionMessage::Hello { .. }));
        assert!(matches!(next_message(ws).await, SessionMessage::Capabilities { .. }));
    }

    async fn next_message(ws: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) -> SessionMessage {
        let msg = ws.next().await.unwrap().unwrap();
        let text = match msg {
            TMessage::Text(t) => t,
            other => panic!("expected text, got {other:?}"),
        };
        serde_json::from_str(&text).unwrap()
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn auth_then_hello_then_output_chunk() {
        let (secret, session, _store, addr) = mint_and_serve("pane-1").await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        drain_handshake(&mut ws).await;

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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replay_buffer_replays_to_reconnecting_viewer() {
        let store = ShareSessionStore::new();
        let MintedShare { secret, session } = store
            .create(
                SessionCode("rep".to_string()),
                "pane-rep".to_string(),
                SharePermission::Read,
                Duration::from_secs(30),
                false,
            )
            .await;

        // Simulate output that arrived BEFORE any viewer connected.
        {
            let mut buf = session.replay_buffer.lock().unwrap();
            buf.push(b"early-1 ".to_vec());
            buf.push(b"early-2 ".to_vec());
        }

        let (addr, _h) = serve(([127, 0, 0, 1], 0).into(), store, None, None).await.unwrap();
        let mut ws = connect_and_auth(addr, "rep", &secret).await;
        drain_handshake(&mut ws).await;

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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_sent_as_first_chunk_when_present() {
        let (secret, _session, store, addr) = mint_and_serve("pane-snap").await;
        let saved = store.set_snapshot(&SessionCode("smoke-abc".to_string()), b"PRELOADED".to_vec()).await;
        assert!(saved);

        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        drain_handshake(&mut ws).await;
        // Then the snapshot.
        match next_message(&mut ws).await {
            SessionMessage::OutputChunk { bytes } => assert_eq!(bytes, b"PRELOADED"),
            other => panic!("expected snapshot OutputChunk, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn presence_increments_and_decrements() {
        let (secret, session, _store, addr) = mint_and_serve("pane-p").await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        drain_handshake(&mut ws).await;

        // Give the server a beat to bump the counter.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(session.presence_count(), 1);

        drop(ws);
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(session.presence_count(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn for_each_share_on_pane_iterates_only_matching() {
        let store = ShareSessionStore::new();
        let m1 = store
            .create(SessionCode("a".to_string()), "pane-1".into(), SharePermission::Read, Duration::from_secs(60), false)
            .await;
        let _m2 = store
            .create(SessionCode("b".to_string()), "pane-2".into(), SharePermission::Read, Duration::from_secs(60), false)
            .await;

        let mut hits: Vec<String> = Vec::new();
        store
            .for_each_share_on_pane("pane-1", |s| hits.push(s.code.0.clone()))
            .await;
        assert_eq!(hits, vec!["a".to_string()]);
        // Sanity: the second share is bound to pane-2.
        let _ = m1; // suppress unused warning
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn audit_log_records_lifecycle() {
        let (secret, _session, store, addr) = mint_and_serve("pane-audit").await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        drain_handshake(&mut ws).await;
        drop(ws);
        tokio::time::sleep(Duration::from_millis(80)).await;

        let entries = store.audit_entries().await;
        let kinds: Vec<_> = entries.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "Created"), "missing Created: {kinds:?}");
        assert!(kinds.iter().any(|k| k == "Connected"), "missing Connected: {kinds:?}");
        assert!(kinds.iter().any(|k| k == "Disconnected"), "missing Disconnected: {kinds:?}");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn expiry_sweeper_drops_stale_entries() {
        let store = ShareSessionStore::new();
        let _m = store
            .create(SessionCode("exp".to_string()), "pane-x".into(), SharePermission::Read, Duration::from_millis(10), false)
            .await;
        assert!(store.get(&SessionCode("exp".to_string())).await.is_some());
        tokio::time::sleep(Duration::from_millis(50)).await;
        store.sweep_expired().await;
        assert!(store.get(&SessionCode("exp".to_string())).await.is_none());
        let kinds: Vec<_> = store.audit_entries().await.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "Expired"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mutual_confirm_blocks_until_approved() {
        let (secret, _session, store, addr) = mint_and_serve_opts("pane-mc", true).await;
        // Spawn the connect on a task so we can poke the store while it's waiting.
        let secret_for_task = secret.clone();
        let connect_task = tokio::spawn(async move {
            let mut ws = connect_and_auth(addr, "smoke-abc", &secret_for_task).await;
            // After approval the server should send its Hello.
            next_message(&mut ws).await
        });

        // Give the WS handler a moment to enter the wait state and emit the
        // ApprovalRequested audit entry.
        tokio::time::sleep(Duration::from_millis(80)).await;
        let entries = store.audit_entries().await;
        let kinds: Vec<_> = entries.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "ApprovalRequested"), "missing ApprovalRequested: {kinds:?}");

        // Find the pending fingerprint and approve it.
        let session = store.get(&SessionCode("smoke-abc".to_string())).await.unwrap();
        let pending = session.pending_approvals.lock().await;
        let fp = pending.keys().next().cloned().expect("pending approval present");
        drop(pending);
        let ok = store.respond_to_approval(&SessionCode("smoke-abc".to_string()), &fp, true).await;
        assert!(ok);

        // The connect should now complete with a server Hello.
        let msg = connect_task.await.unwrap();
        assert!(matches!(msg, SessionMessage::Hello { .. }));

        // Reconnect from the same fingerprint should not require a fresh
        // approval (fingerprint cached in seen_fingerprints).
        let mut ws2 = connect_and_auth(addr, "smoke-abc", &secret).await;
        drain_handshake(&mut ws2).await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn mutual_confirm_denied_closes_socket() {
        let (secret, _session, store, addr) = mint_and_serve_opts("pane-deny", true).await;
        let connect_task = tokio::spawn(async move {
            let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
            // Server should close without a Hello.
            ws.next().await
        });

        tokio::time::sleep(Duration::from_millis(80)).await;
        let session = store.get(&SessionCode("smoke-abc".to_string())).await.unwrap();
        let fp = session.pending_approvals.lock().await.keys().next().cloned().unwrap();
        store.respond_to_approval(&SessionCode("smoke-abc".to_string()), &fp, false).await;

        // Server dropped the socket without a Close frame; tokio-tungstenite
        // reports that as None / a Close message / a ResetWithoutClosing
        // protocol error depending on timing. All three mean "denied,
        // socket gone" — accept any of them.
        let _final_msg = connect_task.await.unwrap();
        let kinds: Vec<_> = store.audit_entries().await.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "ApprovalDenied"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capabilities_announces_share_permission() {
        let (secret, _session, _store, addr) = mint_and_serve_full(
            "pane-cap",
            SharePermission::ReadWrite,
            false,
            None,
        )
        .await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        assert!(matches!(next_message(&mut ws).await, SessionMessage::Hello { .. }));
        match next_message(&mut ws).await {
            SessionMessage::Capabilities { permission } => {
                assert_eq!(permission, SharePermission::ReadWrite);
            }
            other => panic!("expected Capabilities, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn input_chunk_routes_to_handler_on_read_write_share() {
        let received: Arc<std::sync::Mutex<Vec<(String, Vec<u8>)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let received_clone = received.clone();
        let handler: CollabInputHandler = Arc::new(move |pane: &str, bytes: &[u8]| {
            received_clone.lock().unwrap().push((pane.to_string(), bytes.to_vec()));
        });
        let (secret, _session, store, addr) = mint_and_serve_full(
            "pane-rw",
            SharePermission::ReadWrite,
            false,
            Some(handler),
        )
        .await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        drain_handshake(&mut ws).await;

        let input = SessionMessage::InputChunk {
            from: ParticipantId("alice".to_string()),
            bytes: b"ls\r".to_vec(),
        };
        ws.send(TMessage::Text(serde_json::to_string(&input).unwrap())).await.unwrap();

        // Give the server a moment to route the chunk.
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            if !received.lock().unwrap().is_empty() { break; }
        }
        let captured = received.lock().unwrap().clone();
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].0, "pane-rw");
        assert_eq!(captured[0].1, b"ls\r");

        let kinds: Vec<_> = store.audit_entries().await.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "InputReceived"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn input_chunk_dropped_on_read_only_share() {
        let received: Arc<std::sync::Mutex<Vec<(String, Vec<u8>)>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
        let received_clone = received.clone();
        let handler: CollabInputHandler = Arc::new(move |pane: &str, bytes: &[u8]| {
            received_clone.lock().unwrap().push((pane.to_string(), bytes.to_vec()));
        });
        let (secret, _session, store, addr) = mint_and_serve_full(
            "pane-ro",
            SharePermission::Read,
            false,
            Some(handler),
        )
        .await;
        let mut ws = connect_and_auth(addr, "smoke-abc", &secret).await;
        drain_handshake(&mut ws).await;

        let input = SessionMessage::InputChunk {
            from: ParticipantId("alice".to_string()),
            bytes: b"rm -rf /".to_vec(),
        };
        ws.send(TMessage::Text(serde_json::to_string(&input).unwrap())).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert!(received.lock().unwrap().is_empty(), "RO share must not forward inputs");
        let kinds: Vec<_> = store.audit_entries().await.iter().map(|e| format!("{:?}", e.event)).collect();
        assert!(kinds.iter().any(|k| k == "InputDropped"));
        assert!(!kinds.iter().any(|k| k == "InputReceived"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn viewer_index_404s_for_unknown_code() {
        let store = ShareSessionStore::new();
        let (addr, _h) = serve(([127, 0, 0, 1], 0).into(), store, None, None).await.unwrap();
        let resp = reqwest::get(format!("http://{addr}/s/missing")).await.unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn viewer_asset_serves_javascript() {
        let (_secret, _session, _store, addr) = mint_and_serve("pane-js").await;
        let resp = reqwest::get(format!("http://{addr}/s/smoke-abc/viewer.mjs")).await.unwrap();
        assert_eq!(resp.status(), 200);
        let ctype = resp.headers().get("content-type").unwrap().to_str().unwrap();
        assert!(ctype.contains("javascript"));
    }
}
