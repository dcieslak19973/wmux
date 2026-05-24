# wmux Multiplayer — Design & Implementation Plan

> Real-time collaboration for wmux: share panes, pair on terminals, supervise agents, sync workspaces. Self-hostable, terminal-native, agent-aware.

## Why

Zed's killer feature is the multiplayer/Live Share-style system that lets two engineers pair-program from a single workspace. wmux's analog is **pair-terminal-ing + agent-supervision**: collaborate on the surfaces we already have — panes, agents, workspaces, blocks — rather than text buffers.

The use cases worth optimizing for are:
- "Look over my shoulder while I debug this prod issue" — read-only pane viewing
- "Pair on a trade-tooling refactor in shared terminals" — collaborative input
- "Audit what my coworker's Claude agent just did" — agent-session sharing with compliance trail
- "Open the same workspace layout on my home machine" — workspace state replication

What this doc is: an end-to-end architecture proposal plus a phased implementation plan with concrete tasks.

What this doc is **not**: a finished spec. Open questions and unknowns are called out below.

---

## Survey of prior art

| System | Topology | Sync primitive | Strengths | Mismatch for wmux |
|---|---|---|---|---|
| **[Zed](https://zed.dev/docs/collaboration/overview)** | Centralized [Axum collab server](https://deepwiki.com/zed-industries/zed/11-collaboration-and-remote-development), [RPC over WS + protobuf](https://deepwiki.com/zed-industries/zed/11.1-project-panel), [LiveKit](https://github.com/zed-industries/zed/blob/main/livekit.yaml) for voice/screen | [CRDTs for buffers](https://zed.dev/blog/crdts) | Polished UX, voice, screen-follow | Editor-centric — text-buffer CRDTs don't map to PTY streams |
| **[VS Code Live Share](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-server-visual-studio-code)** | MS-hosted relay, E2E encrypted, ~50KB/s per peer | File-system-level sync + terminal sharing | Cheap bandwidth, terminal sharing already a feature | Closed SaaS — won't fly anywhere with strict data-handling rules |
| **[P2P Live Share](https://github.com/kermanx/p2p-live-share)** | WebRTC direct between peers | Same idea minus relay | No central infra | Corporate firewalls block WebRTC often |
| **[tmate](https://cloudthrill.ca/how-to-remotely-share-your-terminal)** | Public SSH infrastructure (4 regions) | Plain stream | Battle-tested, zero install for viewer (just SSH) | Public servers; org-hostable variant exists but limited |
| **[Warp Session Sharing](https://docs.warp.dev/knowledge-and-collaboration/session-sharing)** | Warp cloud, shareable link | Cloud-published stream | Closest to "wmux but with sharing", incl. [agent session sharing](https://docs.warp.dev/knowledge-and-collaboration/session-sharing/agent-session-sharing) | Closed SaaS, mandatory cloud account |

**Takeaways for wmux:**
- Centralized relay is the right topology — corporate-firewall-friendly, simple ACL, auditable.
- CRDTs are overkill for terminal panes; reserve them for the layout document.
- Treat the relay as content-transparent (does see plaintext) in v1, with E2E as a v3+ upgrade for compliance-sensitive deployments.
- Web viewer (browser-based, no wmux install) is non-negotiable for "send a link to anyone in the org."
- Voice/screen-share is a third-party integration concern, not core infra — LiveKit / Daily / Jitsi are all good options. Skip in v1.

---

## Architecture

### Topology

```
                 ┌───────────────────────────────┐
   wmux host ──► │   wmux-collab-server (Rust)   │ ◄── web viewer (browser, xterm.js)
                 │   Axum + WebSocket + SQLite   │
   wmux guest ──►│                               │ ◄── wmux guest (another wmux instance)
                 └───────────────────────────────┘
```

- **Self-hostable Rust server.** Single binary + SQLite for session metadata + audit log. Docker image for ops. Orgs with strict data-handling rules run it on internal infra; OSS users either self-host or use a community-hosted instance.
- **WebSocket transport.** Works through corporate proxies. No WebRTC dependency in v1.
- **Identity pluggable.** Shared-secret for MVP, OIDC/OAuth/SAML pluggable later.

### Object model

The collab server owns three first-class concepts:

1. **Session** — a wmux instance has connected and offered to share resources. Identified by a short URL-friendly code (e.g. `j3k-r9p`). Has an owner.
2. **Surface** — a single shared thing inside a session: a pane, a workspace, an agent. Surfaces have a kind (`pane:terminal`, `pane:agent`, `workspace`) and a permission level (`read`, `read-write`, `admin`).
3. **Participant** — a viewer/collaborator connected to a session with a specific role.

### What gets synced and how

| Surface kind | Source of truth | Sync mechanism | Conflict resolution |
|---|---|---|---|
| Terminal pane (read-only) | Host's ConPTY output stream | Broadcast bytes over WS as base64-framed events | None needed |
| Terminal pane (collaborative) | Host's ConPTY, but multiple writers | Broadcast output; merge input via per-participant write-locks held briefly per keystroke chord | "Whoever typed the byte first wins"; the PTY linearizes naturally |
| Workspace layout | Host's `layout_state` JSON | Periodic snapshot + delta events | Last-write-wins from owner; v2: CRDT (Yjs/yrs) |
| Agent pane state | Host's pane block-store + agent-state hooks | Event stream of agent-state-detected events | Host-authoritative |
| Cursor / selection in URL bar of browser pane | Per-participant | Ephemeral broadcast | None |

For v1 we ship **read-only terminal pane streaming** and **workspace layout snapshots**. That's the smallest unit of value that's actually useful.

### Threat model

In-scope:
- Snooping on a session by parties without the join link
- Host-relay impersonation (TLS solves)
- Replay of audit-log entries
- Authorization (only invited participants can join)

Out-of-scope (v1):
- E2E encryption — server sees content. Compliance-sensitive deployers can add E2E in v3 via a per-session symmetric key derived at the host and shared out-of-band with viewers.
- DDoS-style abuse — small-team usage assumed; add rate-limiting later.

### Critical UX choices

- **Read-only by default.** A new join is observation-only. Promoting to read-write is an explicit host action ("Grant Alice write access to pane 2").
- **Per-pane permissions, not per-session.** Sharing a workspace doesn't share the contents of every pane within it. You explicitly nominate panes to share.
- **Audit log surfaces by default.** Every join, leave, write-promotion, and (optionally) every keystroke is logged with the participant's identity. Required for any regulated trading-firm context.
- **In-app collaborator presence indicator.** Each shared pane shows a small badge of who's currently viewing it.
- **Web viewer is feature-parity for read-only.** Pane bytes stream into a stock xterm.js. Workspace browsing shows a thumbnail tree of the host's panes.

---

## Phased implementation plan

### Phase 0 — Foundation (1–2 days)

Set up the scaffolding so the rest of the work has a place to land. No user-visible behavior yet.

**Tasks:**

- [ ] **0.1 — New crate `wmux-collab-server`** in the workspace. Axum 0.7 + tokio + sqlx (SQLite) + tower. Single binary entry point. Health endpoint. Dockerfile.
- [ ] **0.2 — Protocol crate `wmux-collab-proto`** shared between server and wmux client. Define message types (Hello, Join, SurfaceOffered, OutputChunk, InputChunk, etc.) as protobuf or serde-tagged JSON. Decision needed: protobuf for compactness vs serde-JSON for simplicity. Probably **serde-JSON to start** — easier to debug, switch to bincode if bandwidth becomes a problem.
- [ ] **0.3 — Server schema** for sessions, participants, surfaces, audit_log. SQLite migrations via `refinery` or `sqlx-cli`.
- [ ] **0.4 — Tauri-managed `CollabClient` state** in wmux. WebSocket client that connects to a configured collab-server URL, handshakes, and stays idle until activated. Initial implementation: shared-secret auth.
- [ ] **0.5 — Settings UI** to configure the collab-server URL + per-user identity (name, email/token). Persists to wmux config.

**Done when:** A wmux instance can `connect → handshake → disconnect` against a locally-running `wmux-collab-server` and the server logs the connection in its audit table.

### Phase 1 — Read-only pane sharing (3–5 days)

The minimum viable product. Pick a terminal pane, get a shareable link, others can watch.

**Tasks:**

- [ ] **1.1 — "Share this pane" pane-toolbar button.** Right-click context menu entry too. On click: opens a session if none exists, creates a `pane:terminal` surface with `read` permission, returns a join link.
- [ ] **1.2 — Output broadcast plumbing.** Tap into the existing `terminal-output-{sessionId}` event stream in `commands.rs::start_session_stream`. When a surface is shared, fork the byte stream to the collab client, which forwards to the server, which fans out to all participants via WebSocket.
- [ ] **1.3 — Initial-state snapshot.** A new joiner needs to see the existing terminal contents, not just bytes that arrive after they join. Use the existing `SerializeAddon` snapshot we already capture for layout-persistence. Send as the first message after Join.
- [ ] **1.4 — Web viewer.** Static HTML page served by `wmux-collab-server` at `/s/{code}`. Imports xterm.js + addon-fit, opens a WebSocket back to the server, renders the snapshot then live bytes. No wmux install required.
- [ ] **1.5 — Native wmux viewer.** When wmux opens a `wmux://join/{server}/{code}` URL (registered URL handler), it joins as a guest and opens a read-only pane displaying the shared terminal. Same xterm.js rendering path as a normal pane.
- [ ] **1.6 — Presence indicators.** A small `👁 N` badge on the shared pane in the host's wmux, showing the count of active viewers. Tooltip lists their names.
- [ ] **1.7 — Audit log entries.** Every join/leave/output-byte-count rolls up into the server's audit_log table. Server exposes a `GET /sessions/{id}/audit` endpoint.

**Done when:** Host clicks "Share pane", copies the link, opens it in a fresh browser, sees the terminal content rendered live including ongoing output. Closes the share, sharing stops.

### Phase 2 — Collaborative input on shared panes (2–4 days)

Promote a shared pane from read to read-write. Multiple users can type into the same terminal.

**Tasks:**

- [ ] **2.1 — Permission promotion UI.** Host clicks a viewer's name in the presence indicator → "Grant write access". Updates server-side permission row + audit log.
- [ ] **2.2 — Viewer-side input capture.** When a viewer has write access on a pane surface, their xterm.js input events get forwarded over WS as `InputChunk` events instead of being captured locally.
- [ ] **2.3 — Host-side input merge.** Server forwards `InputChunk` events to the host. The host's wmux pipes them to the same `write_to_session` Tauri command that handles local input. The PTY is the natural linearizer; no explicit ordering needed for v1.
- [ ] **2.4 — Input attribution.** Each `InputChunk` carries the participant ID. The host's pane shows a brief subtle indicator ("Alice is typing") in the status bar — purely informational, no input throttling.
- [ ] **2.5 — Keystroke audit.** Optional flag in server config: log every InputChunk to audit_log. Off by default (privacy/volume), on for compliance deployments.

**Done when:** Host promotes Alice to write-access, Alice types `ls` in the web viewer, Alice's typing appears in the host's terminal, the output is broadcast back.

### Phase 3 — Workspace sharing (3–4 days)

Share a whole workspace layout, not just one pane. The viewer sees the host's tab/pane tree.

**Tasks:**

- [ ] **3.1 — Workspace as a surface kind.** New `workspace` surface. Host's wmux opts in to sharing the active workspace; the server now tracks both the workspace surface and all its child pane surfaces.
- [ ] **3.2 — Layout snapshot + delta.** Host publishes the workspace's layout JSON on connect, then sends deltas on every meaningful change (pane open/close/split/swap/resize, tab rename). Reuse the existing layout-persistence machinery.
- [ ] **3.3 — Viewer-side layout rendering.** Viewer's wmux opens a "joined workspace" view that mirrors the host's pane tree as read-only panes. Native viewer only — web viewer for workspaces is v4.
- [ ] **3.4 — Per-pane opt-in.** Sharing a workspace doesn't auto-share every pane. Each pane in the workspace gets a "share" checkbox; unshared panes show as opaque placeholders to viewers.
- [ ] **3.5 — Optimistic CRDT path for layout.** If multiple admins want to co-edit the layout (rare but real), wrap the layout JSON in a Yrs (Yjs Rust port) document. Defer until someone asks; for now host owns layout.

**Done when:** Alice opens her dev workspace, marks two panes as shared, sends Bob the link. Bob opens a wmux instance and joins; he sees Alice's pane tree with the two shared panes rendering live and the others as locked placeholders.

### Phase 4 — Agent supervision (2–3 days)

The big differentiator vs Live Share or tmate. An agent pane's state — block tracking, agent state events, MCP activity — is observable to invited viewers in a structured way, not just as terminal bytes.

**Tasks:**

- [ ] **4.1 — Agent pane as a richer surface.** Beyond the terminal byte stream, broadcast the structured agent-state events (working/blocked/ready transitions, OSC 133 block start/end, hook-driven state) over a separate channel.
- [ ] **4.2 — Viewer-side agent timeline.** Web viewer renders a richer panel for agent panes: terminal on one side, agent-event timeline on the other. Each block shows its command + exit status + timing.
- [ ] **4.3 — Handoff request flow.** "Pass control of this Claude" — viewer asks for write access; host approves; viewer now drives the agent's input. Audit log captures every handoff.
- [ ] **4.4 — Agent-session-sharing MCP tools.** `share_agent_pane(label, permission)` and `revoke_agent_share(label)` so an external orchestrator can grant/revoke shares programmatically.

**Done when:** Host opens a Claude pane and shares it. Viewer sees both the terminal and a live timeline of the agent's blocks. Viewer requests control; host approves; viewer types a follow-up prompt; the host's Claude responds. Compliance officer reviews the audit log showing the handoff.

### Phase 5 — Voice / screen integration (1 day, mostly config)

Not core infra — wire up an existing service.

**Tasks:**

- [ ] **5.1 — LiveKit room per session.** When a session has 2+ participants, server provisions a LiveKit room and returns the join token to each participant.
- [ ] **5.2 — In-app voice toggle.** Floating widget in the corner of the wmux window. Opens a microphone, joins the room.
- [ ] **5.3 — Hosted-LiveKit option for OSS users.** Document how to self-host LiveKit or use the LiveKit Cloud free tier.

**Done when:** Two collaborators in the same session can hear each other while pairing.

### Phase 6 — E2E encryption (1–2 days, deferred until compliance needs it)

Make the relay content-transparent so even the most paranoid compliance auditors are happy.

**Tasks:**

- [ ] **6.1 — Per-session symmetric key generated at the host.** Distributed to each viewer via a short out-of-band code (or via the existing wmux pane that's already authenticated). Server never sees the key.
- [ ] **6.2 — Encrypt all OutputChunk / InputChunk / LayoutDelta payloads** with the session key. Server only sees ciphertext + routing metadata.
- [ ] **6.3 — Hashed audit log entries.** Server records timestamps + participant IDs + chunk sizes but not content.

**Done when:** A wireshark trace of the server's traffic shows only opaque ciphertext for shared-content payloads.

---

## Cross-cutting concerns

### Performance budget

Target: **<100KB/s per participant** for a busy terminal at 80×24 with continuous output. tmate and Live Share both come in well under this; xterm-rendered streams compress well with permessage-deflate.

### Reconnection

- Both host and viewer can drop and reconnect within 30s without re-handshaking.
- Servers buffer up to 4 MB of recent output per surface so reconnecting viewers don't miss bytes.
- Snapshot on every reconnect for viewers that disconnected longer than the buffer covers.

### Backwards compatibility / upgrade story

- Pin the protocol version in every message. Server refuses sessions where host/viewer protocol versions don't match major.
- v0.x protocol: 6 months of additive-only changes after release. v1.x: stable wire format.

### Open questions

1. **Hosted vs self-hosted balance.** Do we offer a wmux-hosted relay for OSS users so onboarding is one click, even though we expect serious deployers to self-host? Affects roadmap & costs.
2. **OIDC vs OAuth vs both.** Enterprise deployers will want SAML/OIDC. OSS users will want GitHub OAuth. Time-boxed answer: start with shared-secret + GitHub OAuth, add OIDC adapter when a real customer asks.
3. **Workspace-level CRDT now or never?** Skipping for v3 reduces scope. If two admins co-edit the layout, last-write-wins will sometimes lose work. Acceptable trade for v3; revisit when complaints land.
4. **Audit log retention.** Indefinite vs N days. Configurable, defaulting to 90 days, probably right.
5. **Voice — built-in LiveKit vs "use any tool you want."** Building it in is high-effort, low-differentiator. Recommendation: skip; users have Zoom / Slack / Teams already.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| WebSocket through corporate proxies blocked | medium | Standard ports (443) + Host header; document proxy config |
| Per-keystroke latency too high to feel collaborative | medium | Bench early; switch transport to binary if needed; preview during Phase 1 |
| ConPTY output bursts overflow buffer / dropped bytes | low | Already an issue locally; backpressure already in place |
| Viewer device has different terminal-renderer behavior than host | low | xterm.js both ends; addon-image works fine cross-device |
| Enterprise compliance review blocks any SaaS-hosted variant | high | Self-hosted-first design; never hard-depend on a hosted relay |
| Server-side hot spot during big shares | low | One session ≈ one process / sqlite db; horizontal scale later |

---

## Where this lives in the codebase

```
wmux/
├── browser-helper/                    (existing — out-of-process CEF browser)
├── collab-server/                     ← NEW: Axum + sqlx, self-hostable relay
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs
│   │   ├── http.rs                    (routes: WS handlers, web viewer, audit)
│   │   ├── room.rs                    (Session + surface fan-out)
│   │   ├── persistence.rs             (sqlx queries)
│   │   ├── auth.rs                    (shared-secret + OAuth provider)
│   │   └── static/                    (web-viewer HTML + xterm.js)
│   └── migrations/
├── collab-proto/                      ← NEW: shared message types
│   └── src/lib.rs
├── src-tauri/src/
│   ├── collab_client.rs               ← NEW: WS client + session/surface state
│   └── commands.rs                    (add share_pane, revoke_share, list_participants...)
└── src/
    └── collab_runtime.mjs             ← NEW: frontend hooks for shares + presence
```

---

## Concrete next step

The smallest thing we could ship that proves the architecture is **Phase 0 + Phase 1.1–1.4** — that's the read-only-pane-sharing MVP, end-to-end. Roughly a week of work. After that lands, the rest is incremental.

If we want a smaller-still gut-check first, **Phase 0 alone** (one wmux instance handshaking with a local collab server, no actual sharing) is one solid afternoon and tells us whether the protocol shape and the Tauri-state plumbing feel right before we invest in fan-out.

I'd recommend kicking off Phase 0 in a new branch (`feat/collab-foundation`) and treating Phase 1 as a follow-up PR once Phase 0's plumbing is in.
