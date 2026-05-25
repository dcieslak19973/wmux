//! Wire protocol for wmux collab.
//!
//! Messages exchanged over the WebSocket between a wmux host and a viewer
//! (browser PWA or another wmux). JSON-encoded for v0.x; bincode is a future
//! switch if bandwidth ever matters. Until then JSON keeps the PWA viewer
//! trivial (`JSON.parse(evt.data)`).
//!
//! There is no signaling layer — wmux runs the HTTP/WS server itself, so
//! viewers connect directly without a third-party broker. See
//! `docs/multiplayer-design.md` and `docs/adr/0001-multiplayer-via-tailscale.md`
//! for the architecture and why this is so small.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// Stable identity for a participant (host or viewer) within a share session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ParticipantId(pub String);

/// Short, human-shareable code for a share session (the `:code` in `/s/:code`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionCode(pub String);

/// What a viewer is allowed to do on a share. Wire-shared between host and
/// viewer (the viewer needs to know at handshake time whether to enable
/// keystroke capture).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SharePermission {
    Read,
    ReadWrite,
}

/// Frames carried over the WebSocket. Tagged on `kind` so new variants from
/// a newer peer fail cleanly (deserialization errors) rather than silently
/// dropping fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionMessage {
    /// First frame from a viewer. Presents the share secret read from the
    /// share URL's fragment. Kept distinct from `Hello` so the secret never
    /// appears in URL paths / query strings / access logs.
    Auth {
        secret: String,
    },
    /// First frame from the host (after a viewer's successful Auth), or
    /// from a viewer immediately after Auth. Negotiates protocol version
    /// and identifies the participant.
    Hello {
        protocol_version: u32,
        participant: ParticipantId,
    },
    /// Server → viewer right after Hello: announces what the viewer can
    /// do. Phase 3 adds `permission`; future extensions live here too so
    /// the wire format stays open.
    Capabilities {
        permission: SharePermission,
    },
    /// Raw terminal output from host → viewers.
    OutputChunk {
        bytes: Vec<u8>,
    },
    /// Keystroke input from a viewer → host. Honoured only if the participant
    /// has write permission for this share.
    InputChunk {
        from: ParticipantId,
        bytes: Vec<u8>,
    },
    /// Opaque layout-change payload. Defined more concretely in Phase 4
    /// (workspace sharing).
    LayoutDelta {
        payload: serde_json::Value,
    },
    /// Structured agent state event (Phase 5). Wraps an OSC 133 block
    /// boundary, a Claude Code hook callback, or any other structured
    /// signal the host wants to surface alongside terminal bytes. The
    /// payload's shape is defined by convention between host and viewer,
    /// not by the proto, so additional event kinds don't need a proto
    /// version bump.
    AgentEvent {
        payload: serde_json::Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_round_trips() {
        let msg = SessionMessage::Auth { secret: "secret-abc".to_string() };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"kind\":\"auth\""));
        let back: SessionMessage = serde_json::from_str(&json).unwrap();
        match back {
            SessionMessage::Auth { secret } => assert_eq!(secret, "secret-abc"),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn hello_round_trips() {
        let msg = SessionMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            participant: ParticipantId("dan".to_string()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"kind\":\"hello\""));
        assert!(json.contains("\"participant\":\"dan\""));
        let back: SessionMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, SessionMessage::Hello { .. }));
    }

    #[test]
    fn output_chunk_round_trips() {
        let msg = SessionMessage::OutputChunk { bytes: vec![1, 2, 3, 0xff] };
        let json = serde_json::to_string(&msg).unwrap();
        let back: SessionMessage = serde_json::from_str(&json).unwrap();
        match back {
            SessionMessage::OutputChunk { bytes } => assert_eq!(bytes, vec![1, 2, 3, 0xff]),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn input_chunk_carries_attribution() {
        let msg = SessionMessage::InputChunk {
            from: ParticipantId("alice".to_string()),
            bytes: b"ls\r".to_vec(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"from\":\"alice\""));
        let back: SessionMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, SessionMessage::InputChunk { .. }));
    }

    #[test]
    fn unknown_kind_fails_cleanly() {
        let json = r#"{"kind":"future_thing","payload":{}}"#;
        assert!(serde_json::from_str::<SessionMessage>(json).is_err());
    }
}
