# wmux Multiplayer — Design & Implementation Plan

> Real-time collaboration for wmux: share panes with coworkers, connect to your own work machine from elsewhere, supervise agents together. Peer-to-peer by default, tiny rendezvous server, no required identity provider.

## Why

Zed's killer feature is the multiplayer/Live Share-style system that lets two engineers pair-program from a single workspace. wmux's analog is **pair-terminal-ing + remote-yourself + agent-supervision**: collaborate on (or self-access) the surfaces we already have — panes, agents, workspaces, blocks — rather than text buffers.

What this doc is: an end-to-end architecture proposal plus a phased implementation plan with concrete tasks.

What this doc is **not**: a finished spec. Open questions are called out as we go.

---

## Use cases the design must serve

Two distinct trust models, both common, both deserving first-class support.

### A. Pair with someone else

- "Look over my shoulder while I debug this prod issue"
- "Pair on this refactor in shared terminals"
- "Audit what my coworker's Claude agent just did"

Properties: short-lived (minutes to hours), shared with one or two specific people, link expires automatically.

### B. Remote-yourself

- "Leave wmux running at work, peek at the build from my phone on the train"
- "iPad on the couch, see the running deploy on my desktop"
- "Generate a token once for my phone, use it for months"

Properties: long-lived (days to weeks), one user across multiple devices, intermittent connectivity, cellular ↔ corporate-firewall NAT path.

Both use the **same wire protocol and the same connection topology** — they differ only in the auth-token type and lifetime, not in mechanism. Build them together.

### Distribution assumption

90%+ of sharing sessions are expected to be one host + one viewer. The long tail (1 host + several viewers, demo-style fan-out) is rare. This distribution shapes the architecture decision below.

### Non-goals

Decisions we are explicitly **not** doing, so they don't keep coming back as open questions:

- **Voice / video calling inside wmux.** Users already have Zoom, Slack huddles, Teams, Discord. Building this in is meaningful complexity for marginal differentiation. Anyone who wants voice while pairing can keep a separate call open.
- **Project-hosted community rendezvous service.** We won't run a "wmux.io/collab" instance ourselves — it's an ongoing operations + abuse-handling + security burden we're not signing up for. Self-hosting is the only supported path. See the "Hosting the rendezvous" section below for what we *do* support.
- **Native mobile app.** A PWA web viewer covers the mobile use case at a fraction of the cost. No iOS or Android project.
- **Per-user "device family" abstraction.** A self-token maps to exactly one (device, host) pair. Accessing N machines from one phone means generating N tokens. Unifying via a per-user account is the obvious refactor, but it's effectively reintroducing OAuth/accounts as a base requirement — we're keeping things simple instead. N tokens per device-host pair is by design, not a TODO.

---

## Survey of prior art

| System | Topology | Sync primitive | Strengths | Mismatch for wmux |
|---|---|---|---|---|
| **[Zed](https://zed.dev/docs/collaboration/overview)** | Centralized [Axum collab server](https://deepwiki.com/zed-industries/zed/11-collaboration-and-remote-development), [RPC over WS + protobuf](https://deepwiki.com/zed-industries/zed/11.1-project-panel), [LiveKit](https://github.com/zed-industries/zed/blob/main/livekit.yaml) for voice | [CRDTs for buffers](https://zed.dev/blog/crdts) | Polished UX | Editor-centric; CRDTs don't map to PTY streams; central relay model |
| **[VS Code Live Share](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-server-visual-studio-code)** | MS-hosted relay, E2E encrypted | File-system sync + terminal sharing | Cheap bandwidth, terminal sharing already a feature | Closed SaaS; won't fly in restricted-data environments |
| **[P2P Live Share](https://github.com/kermanx/p2p-live-share)** | WebRTC direct between peers | Same idea minus relay | Proves P2P is feasible for this use case | Editor-centric still |
| **[tmate](https://cloudthrill.ca/how-to-remotely-share-your-terminal)** | Public SSH infrastructure | Plain byte stream | Battle-tested, zero install for viewer | No persistent identity / remote-yourself flow |
| **[Warp Session Sharing](https://docs.warp.dev/knowledge-and-collaboration/session-sharing)** | Warp cloud, shareable link | Cloud-published stream | Closest to "wmux but with sharing" | Closed SaaS; mandatory cloud account |
| **[Tailscale](https://tailscale.com/)** (architectural inspiration only) | WireGuard mesh + coordination server + DERP relay fallback | TCP/UDP tunnels | Solves remote-yourself perfectly | Not session-aware; users must already be on a tailnet |

**Takeaways:**
- Centralized "relays every byte" is overkill for our 1↔1-dominant distribution. P2P avoids it.
- A small rendezvous server is still useful — for NAT-traversal signaling, hosting a web viewer, optionally for TURN fallback when direct connection fails.
- OAuth/SAML/IdP is the *enterprise* answer, not the *default* answer. A token-based pairing model works for the OSS / solo-developer case with no IdP at all.

---

## Architecture

### Topology: P2P with thin rendezvous

```
   ┌───────────┐                    ┌─────────────────┐                    ┌────────────┐
   │  Host     │                    │  rendezvous     │                    │  Viewer    │
   │  wmux     │◄─── signaling ───►│  server         │◄─── signaling ───►│  (wmux or  │
   │           │     (WSS)          │  (Axum, ~500    │     (WSS)          │  web PWA)  │
   │           │                    │   lines + tiny  │                    │            │
   │           │                    │   SQLite)       │                    │            │
   │           │                    └─────────────────┘                    │            │
   │           │                                                            │            │
   │           │◄══════════ WebRTC RTCDataChannel (direct, P2P) ═══════════►│            │
   │           │                                                            │            │
   │           │                  ┌──────────────┐                          │            │
   │           │◄── STUN ────────►│  STUN server │                          │            │
   │           │ "my public IP?"  │  (public,    │                          │            │
   │           │                  │  free)       │                          │            │
   │           │                  └──────────────┘                          │            │
   │           │                                                            │            │
   │           │◄═════════════ TURN relay (fallback only) ════════════════►│            │
   │           │                  ┌──────────────┐                          │            │
   │           │                  │  TURN server │  used only when direct  │            │
   │           │                  │  (coturn,    │  WebRTC fails (~25% on  │            │
   │           │                  │  bundled)    │  corporate ↔ cellular)  │            │
   │           │                  └──────────────┘                          │            │
   └───────────┘                                                            └────────────┘
```

The **only piece that's ours in the hot path is the rendezvous**, and it doesn't see session content. Session bytes go P2P over a WebRTC data channel, encrypted by default at the DTLS layer.

### Why not centralized relay

An earlier draft of this doc had a centralized relay that fanned out session bytes to all viewers. P2P is preferable because:

- **Under the expected 1↔1 distribution, the fan-out cost the relay was solving never materializes.** With one viewer, the host sends each chunk once whether it's P2P or via a relay. The relay's O(1)-at-server win is irrelevant.
- **The server never sees content.** Solves the compliance/privacy question by default, not as a v6 add-on.
- **Lower operational cost.** Rendezvous bandwidth is tiny (signaling messages only); TURN bandwidth is paid only for the ~25% of sessions that need NAT relay.
- **Direct path is lower latency** than relay-hop for peers on the same continent.

For the rare big-fan-out case (one host, 10+ viewers — demos, team standup), the host can *additively* opt into "also stream to the rendezvous as a recording/fan-out source." That's a Phase 6 bolt-on, not a core architectural concern.

### The four moving parts

| Component | What it does | Who runs it | Sees content? |
|---|---|---|---|
| **wmux (host + viewer)** | Hosts an `RTCPeerConnection`, sends/receives session bytes over an `RTCDataChannel` | The end user | Yes (it *is* the endpoint) |
| **Rendezvous server** | Forwards SDP offers/answers + ICE candidates between peers; serves the web viewer page; maintains long-lived WS to hosts so they can be "called" by remote-self viewers | OSS user self-hosts; community-hosted instance for casual users | **No** |
| **STUN server** | Tells each peer its public IP/port as seen from the internet | Public free servers (Google, Cloudflare); we don't run this | No |
| **TURN server** | Encrypted relay when direct WebRTC fails to punch through NAT | Bundled with rendezvous binary (coturn or webrtc-rs's built-in); user runs alongside | **No** (ciphertext only) |

The rendezvous server's job is genuinely small: ~500 lines of Rust + a SQLite token table.

### The session handshake — step by step

**Host shares a pane:**
1. User clicks "Share pane" in wmux.
2. wmux generates a session code (e.g. `j3k-r9p`), creates a `share` access token in the rendezvous's token table.
3. wmux opens `wss://collab.wmux/signal/j3k-r9p?role=host`, identified by the token.
4. wmux creates an `RTCPeerConnection` with STUN + TURN URLs configured.
5. Returns `https://collab.wmux/s/j3k-r9p#t=<short-secret>` for the user to share.

**Viewer joins:**
1. Opens the URL. Browser PWA or wmux deep-link loads, extracts token from URL fragment.
2. Opens `wss://collab.wmux/signal/j3k-r9p?role=guest`, identified by token.
3. Rendezvous matches host + guest, exchanges SDPs and ICE candidates between them.
4. Both sides converge on a connection path (LAN direct → public-IP direct via STUN → TURN relay), establish the data channel.
5. Signaling WS can close. Session bytes flow directly between peers.

**Remote-yourself (slight variation):**
1. Host's wmux holds a **persistent** signaling WebSocket to the rendezvous, marked with its registered host-device ID.
2. User's phone (or other device) opens the rendezvous PWA, identifies as the holder of a `self` access token.
3. Rendezvous looks up "what host does this self-token grant access to?", finds the host's persistent WS, asks it to produce an offer.
4. Normal WebRTC handshake follows. Data channel is direct between phone and laptop.

The host being **persistently online with the rendezvous** is the one structural addition for remote-yourself. Same wire protocol, same handshake, just an always-on heartbeat WebSocket so the phone can reach the laptop even when the laptop wasn't expecting a call.

### Authentication: two token types, zero IdP required

The auth model is intentionally lightweight: bearer tokens in the URL fragment, scoped at creation time, revocable from the host. No accounts, no SSO, no OAuth — those become enterprise add-ons (Phase 7), not core requirements.

#### Share token

- Generated by clicking "Share pane" or "Share workspace" on a specific surface.
- Short-lived (default 4 hours, configurable).
- Scoped to a single named surface.
- Read-only by default; host can promote a specific guest to read-write.
- **Encoding: raw high-entropy secret carried in the URL fragment**, e.g. `https://collab.example/s/j3k-r9p#t=<256-bit-base64>`. Fragments aren't sent to the server in the HTTP request line and don't appear in server access logs. They do live in the viewer's browser history — but share tokens are short-lived and scoped enough that this is an acceptable trade for the "paste a link" UX.
- Goes in a Slack DM / IM / paste.

#### Self (personal-access) token

- Generated once, on the host wmux, from a "Devices" settings panel.
- Long-lived (default 90 days, auto-renewed when the device connects; user can set "no expiry" or shorter).
- Scoped to *all* of the host's surfaces — same trust as a desktop login.
- Read-write.
- **Encoding: short-lived redemption code, not the raw token.** Host wmux shows a 6–8-character code (e.g. `3-foggy-puppet` style) as a QR + plaintext on screen. New device opens the rendezvous URL, presents the redemption code over WSS, and receives the real long-lived token + saves it to local secure storage (keychain on macOS, Credential Manager on Windows, equivalent on Linux). The redemption code expires after ~5 minutes whether it's been redeemed or not. The real long-lived token never appears in any URL or browser history.
- Initial transfer to the new device: QR scan on phone, or copy-paste the short code if no camera handy.

#### Storage

The rendezvous server keeps one small table:

```sql
CREATE TABLE access_tokens (
    token_hash     TEXT PRIMARY KEY,    -- SHA-256 of the secret; we never store the plaintext
    kind           TEXT NOT NULL,       -- 'share' | 'self'
    host_device_id TEXT NOT NULL,       -- which wmux instance this token routes to
    scope          TEXT,                -- 'pane:<label>' | 'workspace:<id>' | 'all'
    label          TEXT,                -- human-readable: "Dan's iPhone", "Alice for Tuesday review"
    permission     TEXT NOT NULL,       -- 'read' | 'read-write'
    created_at     TIMESTAMP,
    expires_at     TIMESTAMP NULL,
    last_used_at   TIMESTAMP,
    revoked_at     TIMESTAMP NULL
);
```

That's the entire identity model. No user accounts needed.

#### Optional mutual-confirm on first use

For security-conscious deployments, a per-device "trust on first use" prompt: when a new device presents a previously-unseen IP/UA combination against a self-token, the host wmux pops a dialog: *"New device 'iPhone (cellular, AT&T)' connecting. Allow? [Allow] [Allow once] [Deny]"*. SSH-style known-hosts pattern, inverted (host-side rather than client-side). Off by default (token is enough); toggle-on in settings.

### Object model

The rendezvous tracks three first-class concepts:

1. **Session** — an active sharing arrangement. Identified by a short URL-friendly code.
2. **Surface** — a single shared thing inside a session: a pane, a workspace, an agent. Surfaces have a kind (`pane:terminal`, `pane:agent`, `workspace`) and a permission level (`read`, `read-write`, `admin`).
3. **Participant** — a viewer/collaborator connected to a session with a specific role, attached to an access token.

Each session is created by a specific access token; each participant connection is gated by token validity.

### What gets synced and how — by surface kind

| Surface kind | Source of truth | Sync mechanism | Conflict resolution |
|---|---|---|---|
| Terminal pane (read-only) | Host's ConPTY output stream | Broadcast bytes over WebRTC data channel as length-framed records | None needed |
| Terminal pane (read-write) | Host's ConPTY, multiple writers | Broadcast output; guests' input multiplexed back to host's `write_to_session` command | "Whoever's bytes arrive first wins"; PTY linearizes naturally |
| Workspace layout | Host's `layout_state` JSON | Periodic snapshot + delta events | Host-authoritative; v3+: CRDT (Yrs) if co-edit becomes a real need |
| Agent pane state | Host's pane block-store + agent-state hooks | Event stream of agent-state transitions, separate from terminal bytes | Host-authoritative |
| Cursor / selection in browser-pane URL bar | Per-participant | Ephemeral broadcast over data channel | None |

For v1 we ship **read-only terminal pane streaming** and **workspace layout snapshots**. That's the minimal unit of value.

### Threat model

In-scope:
- Eavesdropping on a session by anyone without the token (defeated by WebRTC's DTLS encryption + token-scoped signaling).
- Rendezvous server impersonation (TLS on the WSS endpoint).
- Replay of expired share tokens (server enforces `expires_at` and `revoked_at`).
- Token theft via screenshot or shoulder-surfing (high-entropy tokens; tokens in URL fragments so they don't appear in server access logs; revoke + regenerate).

Out-of-scope (v1, addressed in later phases or layers):
- Bearer-token phishing — if user is tricked into sending their `self` token to an attacker, the attacker gets access until revocation. Mitigations: short-ish default TTLs, optional mutual-confirm-on-first-use, public-key device pairing as a v8+ upgrade.
- DDoS abuse of the rendezvous — assumed small-team usage; layer in rate-limiting as the project grows.
- Compromised host machine — outside the scope of multiplayer.

### Critical UX choices

- **Read-only by default for share links.** Promoting a guest to read-write is an explicit host action ("Grant Alice write access").
- **Per-surface scope, not per-session.** A share token authorizes one pane (or one workspace's enumerated panes). You explicitly nominate what to share.
- **In-app collaborator presence indicator.** Each shared pane shows a small badge of who's currently viewing it, color-coded by participant.
- **Devices settings panel.** wmux Settings → Devices → list of active self-tokens with labels, last-seen times, revoke buttons. Personal-access-link revocation has to be one click.
- **Audit log on the host, not the server.** Every connection/disconnection/permission-change/byte-count is logged at the host, signed by the participant's token. The audit log lives on the host's local disk.
- **Web viewer is feature-parity for read-only.** Pane bytes stream into stock xterm.js. The web viewer is installable as a PWA so it's home-screen-able on phones.

---

## Phased implementation plan

### Phase 0 — Foundation (3–4 days)

Scaffolding for everything that follows. End state: wmux instances can authenticate to the rendezvous via tokens and exchange a "hello" over a data channel. No useful sharing yet.

**Tasks:**

- [ ] **0.1 — New crate `collab-server`** in the workspace. Axum + tokio + sqlx (SQLite) + tower. Single binary entry. Health endpoint. Dockerfile. Bundles a TURN server (coturn or webrtc-rs's TURN feature) on the same binary or as a sibling process.
- [ ] **0.2 — Protocol crate `collab-proto`** shared between server and wmux. Signaling envelope (Offer/Answer/IceCandidate/Hello) + session-layer messages (OutputChunk/InputChunk/LayoutDelta). Serde-JSON for v0.x — switch to bincode later if bandwidth matters.
- [ ] **0.3 — Rendezvous schema** for `access_tokens`, `sessions`, `signaling_messages` (transient), `audit_log`. SQLite migrations via `refinery` or `sqlx-cli`.
- [ ] **0.4 — Token mint/redeem endpoints** in the rendezvous. `POST /tokens` (authenticated by an existing token; bootstrap via a server-config secret for first token), `DELETE /tokens/:hash`, `GET /tokens` (list for revocation UI). Plus the WSS endpoints `/signal/:code` for hosts and guests.
- [ ] **0.5 — wmux `CollabClient` state** managed by Tauri. Knows the rendezvous URL, persists tokens to wmux's user-data-dir, opens the persistent host-WS, manages an `RTCPeerConnection` (via `webrtc-rs`) per active session.
- [ ] **0.6 — Devices settings panel.** Lists self-tokens, lets user mint a new one (shows QR + URL), revoke an existing one. Lists active host sessions and their `share` tokens with expiry / revoke.
- [ ] **0.7 — End-to-end smoke test:** two wmux instances on the same machine; one mints a self-token, the second redeems it, signaling handshake completes, a "ping" is exchanged over the data channel.

**Done when:** the smoke test passes locally and against a deployed rendezvous (free-tier VPS or k8s).

### Phase 1 — Read-only pane sharing (3–5 days)

The MVP: share a pane, viewer sees it live in a browser or in another wmux.

**Tasks:**

- [ ] **1.1 — "Share this pane" pane-toolbar button.** Mints a share token scoped to that pane, opens a session, returns the join URL.
- [ ] **1.2 — Output broadcast over the data channel.** Tap into the existing `terminal-output-{sessionId}` event stream in `commands.rs::start_session_stream`. When a pane is shared, fork the byte stream to the data channel.
- [ ] **1.3 — Initial-state snapshot.** A new joiner needs the full visible buffer, not just bytes that arrive after join. Use the existing `SerializeAddon` snapshot. Send as the first record after the data channel opens.
- [ ] **1.4 — Web viewer (PWA).** Static page served from `collab-server` at `/s/:code`. Imports xterm.js + addon-fit, opens an `RTCPeerConnection` directly to the host (the rendezvous's signaling WS is the broker). Installable as a PWA — home-screen icon, offline manifest, mobile-viewport-friendly.
- [ ] **1.5 — Native wmux viewer.** Custom URL handler `wmux://join/...` opens a host's session as a read-only pane via the same WebRTC path.
- [ ] **1.6 — Presence indicators.** A small `👁 N` badge on the shared pane in the host's wmux, with names from participant labels. Updates live as guests join/leave.
- [ ] **1.7 — Audit log entries** at the host. Every join/leave/byte-count rolls up into a local SQLite table; viewable from Settings → Audit Log.
- [ ] **1.8 — TURN fallback verified.** Force a peer connection through TURN (disable host candidates), verify the data channel still works. Required because ~25% of corporate-↔-cellular sessions need it.

**Done when:** Host shares a pane, opens the link on a phone over cellular, sees the terminal rendering live including ongoing output.

### Phase 2 — Remote-yourself (2–3 days)

Long-lived self-tokens + persistent host-side rendezvous WS + PWA-friendly mobile flow.

**Tasks:**

- [ ] **2.1 — Persistent host-signaling WebSocket.** wmux opens a long-lived WSS to the rendezvous on startup (if any self-tokens exist) and reconnects with backoff. This is the "phone home" channel that lets a remote viewer ring the bell.
- [ ] **2.2 — Self-token generation flow.** Devices settings → "Add device" → QR code on screen, scannable by phone. Phone opens the URL, gets added as a device with label "iPhone (model X)" auto-inferred from UA.
- [ ] **2.3 — Phone-arrives → host-creates-offer flow.** Rendezvous receives a join from a self-token's URL, looks up the host's persistent WS, sends a "new join request" message; host produces an offer; standard WebRTC handshake.
- [ ] **2.4 — Reconnection / resume.** Train tunnels and laptop sleep both happen. WebRTC reconnect within 30 s shouldn't require re-handshake; longer disconnects re-handshake but resume seamlessly (host buffers up to N minutes of output for replay). Configurable buffer size, defaulting to ~5 minutes' worth (a few MB).
- [ ] **2.5 — Optional mutual-confirm.** Toggle in Devices settings: "Confirm new IPs on this device before allowing access". When enabled, the host's wmux pops a dialog on first connection from a new IP/UA fingerprint per token.
- [ ] **2.6 — Mobile-viewport polish on the PWA.** Pinch-to-zoom for xterm.js, tap-and-hold for selection, virtual-keyboard handling. Most of this is xterm.js config + a few CSS tweaks.

**Done when:** I generate a self-token at my desk, scan with my phone, leave wmux running, walk to the train, open the PWA on my phone over LTE, see my running terminal session and can interact with it.

### Phase 3 — Collaborative input (2–4 days)

Promote a shared pane from read to read-write. Multiple users can type into the same terminal.

**Tasks:**

- [ ] **3.1 — Permission-promotion UI.** Host clicks a participant in the presence indicator → "Grant write access". Updates the access token's `permission` field; emits a permission-change message over the data channel.
- [ ] **3.2 — Viewer-side input capture.** When a viewer's role is read-write, xterm.js input events get forwarded to the host as `InputChunk` events over the data channel.
- [ ] **3.3 — Host-side input merge.** Input events get piped into the same `write_to_session` Tauri command that local input uses. The PTY linearizes; no explicit ordering required for v1.
- [ ] **3.4 — Input attribution.** Each `InputChunk` carries the participant ID; host pane shows a brief "Alice is typing" status-bar hint.
- [ ] **3.5 — Optional keystroke audit.** Server flag: log every InputChunk's metadata (length, participant, timestamp) — content optional, off by default for privacy/volume, on for compliance.

**Done when:** Host promotes Alice to write-access, Alice types `ls` in the PWA, host's terminal runs it and broadcasts output back.

### Phase 4 — Workspace sharing (3–4 days)

Share a whole workspace layout, not just one pane.

**Tasks:**

- [ ] **4.1 — Workspace as a surface kind.** New `workspace` surface; share token can be scoped to a whole workspace + an explicit list of pane surfaces inside it.
- [ ] **4.2 — Layout snapshot + delta.** Host publishes the workspace's layout JSON on connect, then sends deltas on every meaningful change. Reuse the existing layout-persistence machinery.
- [ ] **4.3 — Viewer-side layout rendering.** Viewer's wmux opens a "joined workspace" view that mirrors the host's pane tree as read-only panes. Native viewer only — web/PWA viewer for workspaces is v5+.
- [ ] **4.4 — Per-pane opt-in.** Sharing a workspace doesn't auto-share every pane. Each pane in the workspace gets a "share" checkbox; unshared panes show as opaque placeholders to viewers.
- [ ] **4.5 — Optimistic CRDT path for layout** (deferred until it's needed). Multiple admins co-editing the layout = rare. Wrap in Yrs only when complaints land.

**Done when:** Alice opens her workspace, marks two panes as shared, sends Bob the link. Bob joins; sees Alice's pane tree with two live shared panes and the rest as placeholders.

### Phase 5 — Agent supervision (2–3 days)

The real differentiator vs Live Share / tmate. Agent panes broadcast structured state in addition to terminal bytes.

**Tasks:**

- [ ] **5.1 — Agent pane as a richer surface.** Beyond the terminal byte stream, broadcast structured agent-state events (working/blocked/ready transitions, OSC 133 block start/end, hook-driven state) over a parallel data-channel track.
- [ ] **5.2 — Viewer-side agent timeline.** Web viewer renders a richer panel for agent panes: terminal on one side, agent-event timeline on the other.
- [ ] **5.3 — Handoff request flow.** "Pass control of this Claude" — viewer requests write access; host approves; viewer drives the agent's input. Every handoff is logged in the audit log.
- [ ] **5.4 — Agent-session-sharing MCP tools.** `share_agent_pane(label, permission)` / `revoke_agent_share(label)` so an external orchestrator can grant/revoke programmatically.

**Done when:** Host shares a Claude pane. Viewer sees terminal + live timeline of agent blocks. Viewer requests control; host approves; viewer types a follow-up prompt; the host's Claude responds. Audit log shows the handoff.

### Phase 6 — Optional centralized recording / fan-out relay (1–2 days)

For the rare big-fan-out and "watch a recording later" cases.

**Tasks:**

- [ ] **6.1 — Opt-in flag on the host: "Also stream to rendezvous as a recording source."** Host opens a second data channel — this one to the rendezvous itself, which can record bytes server-side and fan them out to many viewers without the host re-encoding N times.
- [ ] **6.2 — Recording playback** — rendezvous serves `/recording/:id` with the captured stream + timestamps, replayable in the web viewer's xterm.js.
- [ ] **6.3 — Delayed-join replay** — when fan-out mode is active, viewers who join late get the full history from the rendezvous, not just the live tail.

**Done when:** Host enables fan-out mode for a workshop demo, 20 viewers join the same session, they all see the live terminal and can scroll back through earlier output.

### Phase 7 — Enterprise auth add-on (when a real customer asks; ~2–3 days)

Layer SSO over the existing token model — does not replace it.

**Tasks:**

- [ ] **7.1 — OAuth / OIDC config on the rendezvous.** Pluggable identity provider — Google, GitHub, custom OIDC, SAML via something like `samael`.
- [ ] **7.2 — Token creation gated by SSO.** All `POST /tokens` require an authenticated SSO session; the resulting token carries the SSO subject ID.
- [ ] **7.3 — Group-based scoping.** Org admins can write policy like "users in the `traders` group can mint self-tokens with no expiry; users in `interns` are limited to 8-hour share tokens."
- [ ] **7.4 — Revoke-on-leave hooks.** SCIM/SAML "user deprovisioned" event → revoke all of that user's active tokens.
- [ ] **7.5 — Audit attributes by SSO identity** rather than just token label.

**Done when:** An org configures the rendezvous against their IdP; all tokens are minted under SSO identities; the audit log shows real names instead of "Dan's iPhone".

---

## Cross-cutting concerns

### Performance budget

Target: **<100 KB/s per peer** for a busy 80×24 terminal at sustained output. WebRTC's data channels with built-in DTLS overhead come in well under this for typical terminal traffic.

### Reconnection

- **Short disconnect (<30 s):** WebRTC reconnect logic handles it without re-handshake.
- **Medium disconnect (30 s – buffer size):** re-handshake transparently; host replays buffered output to bring the viewer current.
- **Long disconnect (> buffer size):** viewer reconnects to a new session position, sees a snapshot of the current state instead of full replay.

Host buffer defaults to ~5 minutes / ~4 MB per shared surface, configurable.

### TURN sizing

The rendezvous server's bundled TURN handles the ~25% of sessions that can't direct-connect. Sizing rough cut: average 50 KB/s × 25% of sessions × N concurrent sessions = bandwidth budget. A modest VPS handles hundreds of concurrent users.

If self-hosted-TURN bandwidth becomes a problem:
- Use a managed TURN service (Cloudflare's TURN free tier is generous; Twilio is paid).
- Document Tailscale integration so users skip TURN entirely.
- Server CPU is unaffected — TURN is dumb byte forwarding.

### Hosting the rendezvous

Each user (or team / org) runs their own rendezvous server — see the non-goals section. To make that as low-friction as possible, the project ships:

**Tier 1 — supported, tested, recommended:**
- **Docker image** (`ghcr.io/dcieslak19973/wmux-collab-server:latest`) bundling rendezvous + coturn TURN. Single command: `docker run -p 443:443/tcp -p 3478:3478/udp ...`. Runs on any VPS, k8s cluster, or NAS.
- **Fly.io template** in `collab-server/deploy/fly.toml`. Free-tier eligible for a single-instance signaling-only deployment; small spend (~$5/mo) once TURN bandwidth kicks in.
- **One-shot bootstrap script** in `collab-server/deploy/bootstrap.sh` that sets up coturn + the rendezvous on a fresh Ubuntu VPS, including a Let's Encrypt cert.

**Tier 2 — documented, user-supported:**
- **Cloudflare Tunnel + a home server.** Keeps everything on your LAN; tunnel exposes the rendezvous endpoint to the internet without a public IP. Cloudflare's free TURN tier covers most users' bandwidth.
- **Tailscale assumption.** If host + viewers are already on the same tailnet, skip the rendezvous entirely — direct wmux↔wmux WebRTC over the tailnet works because there's no NAT to traverse.

**Tier 3 — not supported but possible:**
- Self-built rendezvous on Railway / Render / serverless-of-the-week. Probably works but we don't actively test against these.

**What the rendezvous costs to run:**
- **CPU / RAM:** trivial. A few hundred MB and minimal CPU. Even a `t2.nano`-class VPS is overkill.
- **Bandwidth:** signaling alone is negligible (~KB per session). TURN is the variable: ~25% of sessions × ~50 KB/s × session duration. For a single user with occasional shares, well within free-tier limits everywhere. For a team with dozens of concurrent shares, expect ~$10–50/mo on commercial bandwidth.
- **Storage:** SQLite database grows slowly (audit log + token table). Single-MB scale even after a year of heavy use.

**Onboarding the first user:**
- New wmux install prompts for a rendezvous URL on first attempt to share or generate a self-token.
- "I don't have one yet" → opens the docs page with the Tier 1 deployment options + a 5-minute Fly.io walkthrough.
- Future: a `wmux collab-server quickstart` CLI subcommand that runs through Fly.io setup interactively. Not in initial scope.

### Mobile PWA — what it is and how it gets onto a phone

The mobile viewer is a **Progressive Web App (PWA)**, not a native iOS/Android app. For the mobile-unfamiliar reader, the short version:

A PWA is a regular web page with two extras: a small "manifest" file (icon, name, colors) and a "service worker" (cached JS that lets it load offline). Together they let mobile browsers treat the page as an installable app instead of a tab.

**How a viewer ends up with the "app" on their phone:**

1. Host sends them a share link (e.g. via Slack) or shows them a QR code.
2. They open it in their phone's browser. Just a web page — no install yet.
3. The browser sees the PWA manifest and offers "Add to Home Screen" (iOS Safari: share button → Add to Home Screen; Android Chrome: usually a banner prompt).
4. They tap accept. An icon appears on their home screen.
5. Tapping the icon launches the viewer in fullscreen mode (no browser address bar) — feels like a regular app.

Subsequent launches are fast because the service worker has cached the assets locally. Updates happen automatically when wmux's rendezvous serves a new build.

**Why we use a PWA instead of a native app:**

- **One codebase.** The same files at `collab-server/static/` serve desktop browsers AND mobile, with only CSS / touch-handler differences. No iOS or Android project to maintain.
- **No app stores.** No Apple Developer fees, no app review, no Google Play console. Users get the link, add to home screen, done.
- **Updates are instant.** No release cycle — push a new version of the static files, users get it next launch.
- **Works on iPad / desktop the same way.** Same code, same install flow on any platform.

What PWAs can't do that we don't need: background processing, Bluetooth, push notifications on iOS (technically possible since iOS 16.4 but with restrictions). For "render a terminal and talk WebRTC," PWAs are fully sufficient.

Concretely, the implementation work is:
- Web App Manifest (`/manifest.webmanifest`) with icons + `display: standalone`.
- Service worker (`/sw.js`) that caches xterm.js and the viewer page.
- Touch-friendly xterm.js config: pinch-zoom, tap-and-hold-to-select, virtual-keyboard handling.

Writing a native iOS/Android app is a non-goal — the PWA covers the mobile case at a fraction of the engineering cost.

### Open questions

1. **TURN credentials.** TURN servers traditionally use short-lived credentials issued by the signaling server. Plenty of well-known patterns; needs a small implementation in the rendezvous.

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| WebRTC blocked by aggressive corporate firewalls (no UDP, no STUN, no TURN) | low–medium | Document TURN-over-TCP fallback (port 443); for the rare totally-locked-down case, fall back to a "tunneled WebSocket" mode where the rendezvous bridges. Hard-gate Phase 1 acceptance on confirming a few corporate environments work. |
| `webrtc-rs` integration burden | medium | The crate is mature and used in production. Budget 2–3 days extra in Phase 0 to internalize the API. |
| Bearer-token leak via screenshot / shoulder-surf | medium | Short default TTLs for share tokens; opt-in mutual-confirm-on-first-use for self tokens; clearly-visible "this URL grants access" warning when minting. |
| Host buffer overflow on long output bursts | low | Already handled at the pane level for layout-persistence; reuse that backpressure. |
| Mobile PWA on iOS Safari has subtle xterm.js bugs | medium | Plan a day in Phase 1 for mobile-specific QA. xterm.js has known mobile issues that mostly are addon-fit + virtual-keyboard related; well-trodden ground. |
| `webrtc-rs` data channel reliability mode mismatches xterm output expectations | low | Use reliable+ordered mode (default). Same delivery semantics as TCP/WebSocket — no surprises. |
| User generates a self-token, never revokes it, leaves company / loses phone | medium | UX nudges: "you have N tokens with no expiry; review them"; periodic reminders surfaced inside wmux. |
| Self-hosting the rendezvous is a barrier to OSS adoption ("I just want to share my pane, do I really have to deploy a server?") | high | Make the deployment story very polished: tested Docker image, Fly.io template with one-command setup, in-product "I don't have a rendezvous yet" wizard that walks the user through Fly.io. Highlight the Tailscale-only path which sidesteps the rendezvous for users who already have a tailnet. |

---

## Where this lives in the codebase

```
wmux/
├── browser-helper/                     (existing — out-of-process CEF browser)
├── collab-server/                      ← NEW: rendezvous + bundled TURN
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs
│   │   ├── http.rs                     (routes: WS signaling, web/PWA viewer, audit, tokens)
│   │   ├── signaling.rs                (offer/answer/ICE forwarding)
│   │   ├── token.rs                    (mint/redeem/revoke)
│   │   ├── persistence.rs              (sqlx)
│   │   ├── auth.rs                     (token verification + optional OAuth/OIDC adapter)
│   │   └── static/                     (web-viewer PWA: HTML + xterm.js + service worker)
│   └── migrations/
├── collab-proto/                       ← NEW: shared message types (signaling + session)
│   └── src/lib.rs
├── src-tauri/src/
│   ├── collab_client.rs                ← NEW: webrtc-rs PeerConnection + DataChannel mgmt
│   ├── collab_tokens.rs                ← NEW: local token storage / mint requests
│   └── commands.rs                     (add share_pane, mint_self_token, revoke_token, list_devices...)
└── src/
    └── collab_runtime.mjs              ← NEW: frontend hooks for shares + presence + devices UI
```

---

## Concrete next step

The smallest thing that proves the architecture is **Phase 0 + Phase 1.1–1.4** — read-only-share MVP end-to-end via WebRTC. About a week. After that lands, the rest is incremental.

If a smaller gut-check first: **Phase 0.1–0.5 alone** — two wmux instances handshaking and exchanging a "hello" over a data channel — is roughly two solid days and validates the WebRTC + token model before we invest in the share UX.

I'd kick off Phase 0 in a new branch (`feat/collab-foundation`) and treat Phase 1 as a follow-up PR once the plumbing is in.
