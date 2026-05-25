# ADR 0001 — Multiplayer transport: LAN-first HTTP/WS + Tailscale, not custom WebRTC rendezvous

**Status:** Accepted (2026-05-25). Supersedes the initial multiplayer architecture in `docs/multiplayer-design.md`.

## Context

wmux planned a multiplayer feature (pair-terminal, remote-yourself, agent supervision). The first iteration of `docs/multiplayer-design.md` proposed:

- A custom Rust rendezvous server (`collab-server` crate) running on the public internet.
- WebRTC `RTCDataChannel` as the peer-to-peer transport, with DTLS encryption.
- STUN + bundled TURN (coturn or webrtc-rs's TURN) for NAT traversal.
- A token-mint/redeem subsystem with SQLite-backed access tokens.
- Persistent host-signaling WebSockets so phones could "call" laptops behind NAT.

Phase 0 was scoped at 3–4 days (7 sub-tasks) *just to exchange a hello*, with full multiplayer arriving across 5–7 phases.

While scaffolding that design (PR #35, `feat/multiplayer-phase-0`), three observations collapsed it:

1. **The hard requirement driving WebRTC was "viewer doesn't install anything."** Once questioned, that was a self-imposed constraint, not a user requirement. For wmux's actual use cases — pair with a coworker, peek from my own phone — having the other endpoint install something once is acceptable.
2. **Most pair-terminal use cases are LAN-local.** Same office, same VPN, same Wi-Fi. The entire NAT-traversal apparatus solves a problem these cases don't have. A plain HTTP/WS server binding to the LAN interface works.
3. **The remaining cross-network cases are exactly the coordination-server problem that Tailscale solves.** Our proposed rendezvous was structurally a wmux-specific reimplementation of a Tailscale-coordination-server-shaped thing:

   | | Tailscale/Headscale coordination | Custom rendezvous (rejected) |
   |---|---|---|
   | Introduce peers to each other | WireGuard pubkey exchange | WebRTC SDP / ICE exchange |
   | Hold long-lived presence | Each client's control connection | Host's persistent signaling WS |
   | Relay fallback when direct fails | DERP | Bundled TURN |
   | See session plaintext | No | No |
   | Gate who can join | Tailnet ACLs | `access_tokens` table |
   | Production-tested, multi-platform clients | Yes | No — we'd build it |

Building it ourselves would mean owning auth, persistence, signaling, and TURN forever.

## Decision

Drop the custom rendezvous. Adopt a **two-tier transport**:

1. **Same-network (default).** wmux hosts an HTTP/WebSocket server inside the Tauri process and binds it to the user-selected interface (loopback / LAN / Tailnet / all). Viewers — browser PWA or another wmux — connect directly. No external infrastructure.

2. **Cross-network.** Users install Tailscale (or self-host its open-source equivalent, [Headscale](https://github.com/juanfont/headscale)) on the endpoints that need to reach each other. wmux detects the Tailnet interface via `tailscale status --json` and surfaces Tailnet URLs in the share UI. From wmux's perspective, Tailscale ≡ Headscale: same Tailnet IPs, same routing.

Phase 2 default is **Option A**: rely on the regular Tailscale daemon being installed. **Option B** — embedding Tailscale via `tailscale-rs`/tsnet — is deferred until that crate hits 1.0 (pre-1.0 experimental preview as of Aug 2025).

The `collab-proto` crate survives in slimmed form: keep `SessionMessage` (OutputChunk / InputChunk / LayoutDelta) and `Hello`; drop `SignalingMessage` (Offer / Answer / IceCandidate) — there is no signaling. The `collab-server` crate is deleted entirely; its functionality (HTTP/WS server, share-session store) moves into a `collab_server` module inside `src-tauri`.

## Consequences

Gained:
- Phase 0 shrinks from "deploy a server + WebRTC handshake" to "axum module + integration test." ~2 days instead of 3–4.
- No operations work: nothing for users to deploy, nothing for the project to maintain.
- The transport layer becomes a single WebSocket — easy to reason about, easy to debug, no DTLS / ICE / TURN failure modes.
- Cross-network access piggybacks on a battle-tested product (Tailscale's coordination server / DERP relay) instead of one we'd build.
- Phase 1 is genuinely buildable in days, not weeks.

Given up:
- Cross-network viewers must install Tailscale (or Headscale) on their device. For the "share a link with a stranger on cellular over a browser" case, we don't have an answer. We accept this trade — that case wasn't a real wmux requirement.
- We can never run a community-hosted "wmux.io/collab" service that lets users multiplayer without any setup. We weren't going to anyway (it was already a non-goal in the original design — operational burden, abuse surface, GDPR exposure).

Future revisitation triggers:
- If a real user need emerges for browser-from-anywhere viewers with no install, revisit by adding an Iroh-based WASM viewer or a thin WebRTC layer. Tailscale-first stays the default; this would be an addition, not a replacement.
- If `tailscale-rs`/tsnet matures to a stable 1.0, evaluate Option B (embed Tailscale, drop the daemon dependency). Should be a contained change behind the same Tailnet-presence detection.

## References

- [`docs/multiplayer-design.md`](../multiplayer-design.md) — Architecture and phased plan as of this ADR.
- PR #35 (closed without merging) — The scaffolded `collab-server` crate that prompted the pivot.
- Conversation transcript driving the pivot — `transcripts/` (local only).
