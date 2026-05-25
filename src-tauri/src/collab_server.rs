#![allow(dead_code)]
// Phase 0 wires the server up but doesn't yet expose any Tauri commands or
// UI that exercise it from non-test code. Phase 1 (share-pane UX) is the
// first consumer. The allow above keeps clippy -D warnings quiet on
// unused-by-design scaffolding until then.

//! In-app HTTP/WebSocket server for collab share sessions.
//!
//! Phase 0 of the multiplayer plan — see `docs/multiplayer-design.md` and
//! `docs/adr/0001-multiplayer-via-tailscale.md`. The server runs inside the
//! wmux process and is started by the share UX when the user mints their
//! first share. Each share session is tracked in [`ShareSessionStore`] and
//! has its own broadcast channel that fan-outs host PTY bytes to every
//! attached viewer.
//!
//! Auth: viewers present a secret on the WebSocket handshake URL (query
//! parameter for Phase 0). Phase 1 will migrate this to an in-band Auth
//! message so the secret stays out of access logs — for now the test fixture
//! is the only consumer.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use collab_proto::{ParticipantId, SessionCode, SessionMessage, PROTOCOL_VERSION};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::{broadcast, RwLock};

const OUTPUT_BROADCAST_CAPACITY: usize = 256;

/// Single live share session: who can join, when it expires, and the
/// broadcast channel that fan-outs host PTY bytes to every connected viewer.
#[derive(Clone)]
pub struct ShareSession {
    pub secret_hash: [u8; 32],
    pub expires_at: Instant,
    pub output_tx: broadcast::Sender<Vec<u8>>,
}

/// In-memory registry of active share sessions.
///
/// Lost on wmux restart — that's intentional. We treat each wmux launch as
/// a fresh boundary; sharing a pane doesn't outlive the session that created
/// it. Re-share is one click.
#[derive(Clone, Default)]
pub struct ShareSessionStore {
    inner: Arc<RwLock<HashMap<SessionCode, ShareSession>>>,
}

impl ShareSessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a new share. Returns the raw secret (caller embeds it in the
    /// share URL fragment) and a sender the host writes PTY bytes into.
    pub async fn create(&self, code: SessionCode, ttl: Duration) -> (String, broadcast::Sender<Vec<u8>>) {
        let secret = random_secret();
        let secret_hash = sha256(secret.as_bytes());
        let (output_tx, _rx) = broadcast::channel(OUTPUT_BROADCAST_CAPACITY);
        let session = ShareSession {
            secret_hash,
            expires_at: Instant::now() + ttl,
            output_tx: output_tx.clone(),
        };
        self.inner.write().await.insert(code, session);
        (secret, output_tx)
    }

    pub async fn get(&self, code: &SessionCode) -> Option<ShareSession> {
        self.inner.read().await.get(code).cloned()
    }

    pub async fn revoke(&self, code: &SessionCode) {
        self.inner.write().await.remove(code);
    }

    /// Drop entries past their `expires_at`. Cheap; runs from a background
    /// sweeper every minute (see [`Self::spawn_expiry_sweeper`]).
    pub async fn sweep_expired(&self) {
        let now = Instant::now();
        self.inner.write().await.retain(|_, s| s.expires_at > now);
    }

    pub fn spawn_expiry_sweeper(self: Arc<Self>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.tick().await; // skip the immediate first tick
            loop {
                interval.tick().await;
                self.sweep_expired().await;
            }
        })
    }
}

#[derive(Clone)]
struct AppState {
    store: ShareSessionStore,
}

#[derive(Deserialize)]
struct WsQuery {
    secret: String,
}

async fn health() -> &'static str {
    "ok"
}

async fn ws_handler(
    Path(code): Path<String>,
    Query(query): Query<WsQuery>,
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let code = SessionCode(code);
    let Some(session) = state.store.get(&code).await else {
        return (StatusCode::NOT_FOUND, "no such share").into_response();
    };
    if session.expires_at <= Instant::now() {
        return (StatusCode::GONE, "share expired").into_response();
    }
    let presented = sha256(query.secret.as_bytes());
    if !constant_time_eq(&presented, &session.secret_hash) {
        return (StatusCode::UNAUTHORIZED, "bad secret").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, session))
        .into_response()
}

async fn handle_socket(mut socket: WebSocket, session: ShareSession) {
    // Hello handshake: expect a Hello from the viewer, respond with the
    // host's Hello. Anything else closes the socket.
    let Some(Ok(first)) = socket.recv().await else { return };
    let Message::Text(first_text) = first else { return };
    let Ok(SessionMessage::Hello { protocol_version, participant: _ }) = serde_json::from_str(&first_text) else {
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

    // Pump output broadcasts to the viewer. Viewer InputChunks are
    // accepted but ignored in Phase 0 — input merge lands in Phase 3.
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
}

pub fn router(store: ShareSessionStore) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/ws/:code", get(ws_handler))
        .with_state(AppState { store })
}

/// Bind the collab server on `addr` and serve until the returned shutdown
/// signal fires. Returns the bound address (useful when caller passed
/// port 0) and a handle to abort the server.
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

fn random_secret() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // Phase 0 doesn't need cryptographic-grade randomness — the secret is
    // bound to a session that lives at most hours, validated against a
    // SHA-256 hash, and is regenerated on every share. Phase 1 will switch
    // to OS rand.
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(now.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
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

#[cfg(test)]
mod tests {
    use super::*;
    use collab_proto::{ParticipantId, SessionMessage};
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as TMessage;

    /// End-to-end smoke for Phase 0: spin up the collab server, mint a
    /// share, connect a WS client, exchange Hellos, broadcast an
    /// OutputChunk from the host side and observe it on the viewer side.
    #[tokio::test]
    async fn share_session_hello_then_output_chunk_round_trips() {
        let store = ShareSessionStore::new();
        let code = SessionCode("smoke-abc".to_string());
        let (secret, output_tx) = store.create(code.clone(), Duration::from_secs(30)).await;

        let (addr, _handle) = serve(([127, 0, 0, 1], 0).into(), store)
            .await
            .expect("server binds");

        let url = format!("ws://{addr}/ws/{}?secret={secret}", code.0);
        let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
            .await
            .expect("ws handshake");

        // Viewer says hello.
        let viewer_hello = SessionMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            participant: ParticipantId("viewer".to_string()),
        };
        ws.send(TMessage::Text(serde_json::to_string(&viewer_hello).unwrap()))
            .await
            .unwrap();

        // Server replies with its own hello.
        let first = ws.next().await.expect("server msg").expect("ok msg");
        let text = match first {
            TMessage::Text(t) => t,
            other => panic!("expected text, got {other:?}"),
        };
        let parsed: SessionMessage = serde_json::from_str(&text).unwrap();
        assert!(matches!(parsed, SessionMessage::Hello { .. }));

        // Host publishes a chunk; viewer receives it framed as OutputChunk.
        output_tx.send(b"hello viewer".to_vec()).unwrap();
        let chunk = ws.next().await.expect("chunk").expect("ok chunk");
        let chunk_text = match chunk {
            TMessage::Text(t) => t,
            other => panic!("expected text, got {other:?}"),
        };
        let chunk_parsed: SessionMessage = serde_json::from_str(&chunk_text).unwrap();
        match chunk_parsed {
            SessionMessage::OutputChunk { bytes } => assert_eq!(bytes, b"hello viewer"),
            other => panic!("expected OutputChunk, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn ws_rejects_unknown_share_code() {
        let store = ShareSessionStore::new();
        let (addr, _handle) = serve(([127, 0, 0, 1], 0).into(), store).await.unwrap();
        let url = format!("ws://{addr}/ws/nope?secret=anything");
        let result = tokio_tungstenite::connect_async(&url).await;
        assert!(result.is_err(), "expected handshake failure for unknown code");
    }

    #[tokio::test]
    async fn ws_rejects_wrong_secret() {
        let store = ShareSessionStore::new();
        let code = SessionCode("auth-test".to_string());
        let (_real_secret, _tx) = store.create(code.clone(), Duration::from_secs(30)).await;
        let (addr, _handle) = serve(([127, 0, 0, 1], 0).into(), store).await.unwrap();
        let url = format!("ws://{addr}/ws/{}?secret=wrong", code.0);
        let result = tokio_tungstenite::connect_async(&url).await;
        assert!(result.is_err(), "expected handshake failure for bad secret");
    }

    #[tokio::test]
    async fn expiry_sweeper_drops_stale_entries() {
        let store = ShareSessionStore::new();
        let code = SessionCode("exp-test".to_string());
        let (_secret, _tx) = store.create(code.clone(), Duration::from_millis(10)).await;
        assert!(store.get(&code).await.is_some());
        tokio::time::sleep(Duration::from_millis(50)).await;
        store.sweep_expired().await;
        assert!(store.get(&code).await.is_none());
    }
}
