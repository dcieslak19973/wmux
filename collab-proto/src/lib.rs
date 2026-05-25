//! Wire protocol for wmux collab.
//!
//! Two layers:
//! - [`SignalingMessage`] travels over WSS between a wmux instance and the
//!   rendezvous server. Used to negotiate WebRTC connections.
//! - [`SessionMessage`] travels over the WebRTC data channel directly between
//!   peers, once signaling is complete.
//!
//! Both layers use JSON over the wire for v0.x. Switching to bincode is a
//! future optimisation if bandwidth ever matters; until then, JSON keeps
//! tooling and the PWA viewer trivial.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// Stable identity for a participant (host or viewer) within a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ParticipantId(pub String);

/// Short, human-shareable code for a session (e.g. the `:code` in `/s/:code`).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionCode(pub String);

/// Envelope carried over the rendezvous WSS. Tagged on `kind` so additional
/// variants can be added without breaking older clients (they ignore unknown
/// kinds).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SignalingMessage {
    /// First message each side sends after the WS opens. Negotiates protocol
    /// version and identifies the participant.
    Hello {
        protocol_version: u32,
        participant: ParticipantId,
    },
    /// WebRTC SDP offer from the host.
    Offer {
        from: ParticipantId,
        sdp: String,
    },
    /// WebRTC SDP answer from a viewer.
    Answer {
        from: ParticipantId,
        sdp: String,
    },
    /// Trickled ICE candidate.
    IceCandidate {
        from: ParticipantId,
        candidate: String,
        sdp_mid: Option<String>,
        sdp_mline_index: Option<u32>,
    },
}

/// Messages exchanged peer-to-peer over the established WebRTC data channel.
/// Same tagging convention as [`SignalingMessage`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionMessage {
    /// Raw terminal output from host → viewers.
    OutputChunk {
        bytes: Vec<u8>,
    },
    /// Keystroke input from a viewer → host (only honoured if the viewer has
    /// write permission).
    InputChunk {
        from: ParticipantId,
        bytes: Vec<u8>,
    },
    /// Opaque layout-change payload. Defined more concretely once Phase 4
    /// (workspace sharing) is in scope.
    LayoutDelta {
        payload: serde_json::Value,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signaling_hello_round_trips() {
        let msg = SignalingMessage::Hello {
            protocol_version: PROTOCOL_VERSION,
            participant: ParticipantId("dan".to_string()),
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"kind\":\"hello\""));
        assert!(json.contains("\"participant\":\"dan\""));
        let back: SignalingMessage = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, SignalingMessage::Hello { .. }));
    }

    #[test]
    fn signaling_ice_candidate_round_trips() {
        let msg = SignalingMessage::IceCandidate {
            from: ParticipantId("host".to_string()),
            candidate: "candidate:1 1 udp ...".to_string(),
            sdp_mid: Some("0".to_string()),
            sdp_mline_index: Some(0),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let back: SignalingMessage = serde_json::from_str(&json).unwrap();
        match back {
            SignalingMessage::IceCandidate { sdp_mid, sdp_mline_index, .. } => {
                assert_eq!(sdp_mid.as_deref(), Some("0"));
                assert_eq!(sdp_mline_index, Some(0));
            }
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn session_output_chunk_round_trips() {
        let msg = SessionMessage::OutputChunk { bytes: vec![1, 2, 3, 0xff] };
        let json = serde_json::to_string(&msg).unwrap();
        let back: SessionMessage = serde_json::from_str(&json).unwrap();
        match back {
            SessionMessage::OutputChunk { bytes } => assert_eq!(bytes, vec![1, 2, 3, 0xff]),
            _ => panic!("wrong variant"),
        }
    }

    #[test]
    fn session_input_chunk_carries_attribution() {
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
        assert!(serde_json::from_str::<SignalingMessage>(json).is_err());
    }
}
