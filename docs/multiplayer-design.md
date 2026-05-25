# wmux Multiplayer — Design & Implementation Plan

> Real-time collaboration for wmux: share panes with coworkers on the same network, connect to your own work machine from elsewhere, supervise agents together. **LAN-first** — no rendezvous server, no signaling broker, no WebRTC. Cross-network access piggybacks on Tailscale.

## Why

Zed's killer feature is the multiplayer/Live Share-style system that lets two engineers pair-program from a single workspace. wmux's analog is **pair-terminal-ing + remote-yourself + agent-supervision**: collaborate on (or self-access) the surfaces we already have — panes, agents, workspaces, blocks — rather than text buffers.

What this doc is: an end-to-end architecture proposal plus a phased implementation plan.

What this doc is **not**: a finished spec. Open questions are called out as we go.

This doc supersedes an earlier version that proposed a custom Axum rendezvous server + WebRTC + bundled TURN. The "Rejected alternatives" section at the bottom records why that was scrapped — short version: most pair-terminal use cases are LAN-local, and "remote yourself" is exactly what Tailscale was built for. Building our own NAT-traversal stack to solve a problem someone else already solved was a waste.

---

## Use cases the design must serve

### A. Pair with someone on the same network

- "Look over my shoulder while I debug this prod issue"
- "Pair on this refactor in shared terminals"
- "Audit what my coworker's Claude agent just did"

Properties: short-lived, both peers on the same LAN / corp VPN / Wi-Fi, link expires automatically. **This is the 80% case.**

### B. Remote-yourself across networks

- "Leave wmux running at work, peek at the build from my phone on the train"
- "iPad on the couch, see the running deploy on my desktop"

Properties: long-lived, one user across multiple devices, intermittent cellular connectivity, **the two endpoints are on different networks**. Needs explicit cross-network help — Tailscale provides it.

### C. Pair with someone on a different network

- "Remote coworker wants to look at my session over their LTE / home Wi-Fi"

Same trust model as A, same transport need as B. We assume the coworker is willing to install Tailscale and join a shared tailnet — same infra as B, no additional architecture.

### Distribution assumption

90%+ of sharing sessions are one host + one viewer. Fan-out (1 host + many viewers) is rare enough to be Phase 6's problem.

### Non-goals

- **Voice / video calling inside wmux.** Users have Zoom / Slack / Teams.
- **Project-hosted rendezvous service.** We're not running infra for users.
- **Native mobile app.** PWA covers it.
- **Custom NAT traversal.** Tailscale's coordination server + DERP relay network is operational, free for the use cases wmux cares about, and more battle-tested than anything we'd build.
- **A "viewer doesn't need to install anything" cross-network story.** This was the requirement that forced WebRTC + custom signaling in the old design. We're explicitly dropping it: cross-network viewers install Tailscale once. Within-network viewers don't install anything.

---

## Survey of prior art

| System | Topology | Sync primitive | Strengths | Mismatch for wmux |
|---|---|---|---|---|
| **[Zed](https://zed.dev/docs/collaboration/overview)** | Centralized [Axum collab server](https://deepwiki.com/zed-industries/zed/11-collaboration-and-remote-development), [RPC over WS + protobuf](https://deepwiki.com/zed-industries/zed/11.1-project-panel), [LiveKit](https://github.com/zed-industries/zed/blob/main/livekit.yaml) for voice | [CRDTs for buffers](https://zed.dev/blog/crdts) | Polished UX | Editor-centric; CRDTs don't map to PTY streams; central relay model |
| **[VS Code Live Share](https://learn.microsoft.com/en-us/visualstudio/liveshare/use/share-server-visual-studio-code)** | MS-hosted relay, E2E encrypted | File-system sync + terminal sharing | Cheap bandwidth | Closed SaaS; won't fly in restricted-data environments |
| **[tmate](https://cloudthrill.ca/how-to-remotely-share-your-terminal)** | Public SSH infrastructure | Plain byte stream | Battle-tested | No persistent identity; viewer needs SSH client |
| **[Warp Session Sharing](https://docs.warp.dev/knowledge-and-collaboration/session-sharing)** | Warp cloud, shareable link | Cloud-published stream | Closest to "wmux but with sharing" | Closed SaaS; mandatory cloud account |
| **[Tailscale](https://tailscale.com/)** | WireGuard mesh + coordination + DERP fallback | TCP/UDP tunnels | Solves cross-network access generically | None — we're using it directly |

**Takeaways:**
- For same-network sharing, every line of NAT-traversal code is dead weight. Bind an HTTP/WS server and ship.
- For cross-network access, the work has already been done — by Tailscale, in production, for years.

---

## Architecture

### Topology: HTTP server in wmux + Tailscale for cross-network

```
   ┌─────────────────┐                                ┌────────────┐
   │  Host wmux      │                                │  Viewer    │
   │                 │                                │  (browser  │
   │  ┌───────────┐  │  ◄── WebSocket (binary) ────►  │  PWA or    │
   │  │ HTTP/WS   │  │                                │  wmux)     │
   │  │ server    │  │                                │            │
   │  │ on local  │  │                                │            │
   │  │ interface │  │                                │            │
   │  └───────────┘  │                                │            │
   └─────────────────┘                                └────────────┘
        Same LAN: bind 0.0.0.0:<port>, viewer hits http://host.local:<port>/s/<code>
        Same Tailnet: bind to Tailnet interface, viewer hits http://<host>.<tailnet>.ts.net:<port>/s/<code>
```

That's it. **No rendezvous server. No signaling broker. No STUN, no TURN, no WebRTC.** A plain HTTP server inside wmux, a WebSocket per active sharing session, a static page that loads xterm.js.

Cross-network access works because **Tailscale makes the cross-network case look identical to the same-network case from wmux's perspective.** When both peers are on the same tailnet, the laptop and phone have stable Tailnet IPs that route to each other through Tailscale's WireGuard mesh — wmux doesn't know or care that one of them is on cellular.

### The two moving parts

| Component | What it does | Sees content? |
|---|---|---|
| **wmux (host)** | Hosts HTTP server + WebSocket endpoint; serves the PWA viewer's static assets; streams pane output / accepts pane input | Yes (it *is* the endpoint) |
| **Viewer (PWA in a browser, or another wmux)** | Renders pane state, optionally sends input | Yes (it *is* the endpoint) |

That's the whole supply chain. **Tailscale is in the path for cross-network access but doesn't see plaintext** — its WireGuard tunnel terminates at the host's Tailscale daemon, which then routes the still-encrypted-by-the-app traffic (we use HTTPS internally) to wmux's HTTP server.

### The session handshake

**Host shares a pane:**
1. User clicks "Share pane" in wmux.
2. wmux generates a short session code (e.g. `j3k-r9p`) and an entropy-laden bearer secret. Stores `{code, secret_hash, pane_label, permission, expires_at}` in an in-memory map.
3. Starts (if not already running) an HTTP/WS server bound to the configured interface. Default: bind to all non-loopback interfaces on a randomized port.
4. Returns one or more URLs based on what's bindable:
   - LAN: `http://<host-mDNS-or-IP>:<port>/s/j3k-r9p#t=<secret>`
   - Tailnet (if Tailscale is up): `http://<host>.<tailnet>.ts.net:<port>/s/j3k-r9p#t=<secret>`

**Viewer joins:**
1. Opens the URL. The static PWA loads, reads the secret from the URL fragment.
2. Opens `ws://<host>:<port>/ws/j3k-r9p` and presents the secret as the first message (or as a `Sec-WebSocket-Protocol` header).
3. Host validates the secret hash, checks expiry, attaches the WebSocket to the pane's output broadcast.
4. Host sends the initial-state snapshot (SerializeAddon dump) as the first frame.
5. Bytes flow in both directions over the WebSocket. Same protocol locally as over Tailscale.

**Remote-yourself:**
Identical to the above. Your phone hits `http://<your-laptop>.<your-tailnet>.ts.net:<port>/s/<code>` instead of `http://your-laptop.local`. No "persistent host-signaling WebSocket," no "phone home" channel — Tailscale's coordination server is the phone-home channel, and it's already running on both endpoints.

### Tailscale integration: two options

We've narrowed to two paths. Both work; pick based on the maturity-vs-friction trade.

**Option A — require users to install Tailscale daemon.**
wmux assumes Tailscale is running on the host machine. It detects the Tailnet interface (via `tailscale status --json` or the local Tailscale API on port 41112) and offers Tailnet URLs in the share UX when available. **One-time install for the user; rock-solid path.** Stable, supported, what most Tailscale users do anyway.

**Option B — embed Tailscale via `tailscale-rs` (tsnet).**
wmux brings its own Tailscale stack — no daemon to install. The user still needs a Tailscale account to associate the embedded node with a tailnet, but doesn't have to install or run the daemon separately. **`tailscale-rs` was pre-1.0 experimental preview as of Aug 2025 (per the research that drove this rewrite); current maturity needs to be confirmed before committing.**

**Default: Option A.** Smaller surface area, no pre-1.0 dependency. Revisit Option B once `tailscale-rs` hits 1.0 or once enough users object to installing the daemon.

#### Tailscale vs Headscale: equivalent from wmux's perspective

[Headscale](https://github.com/juanfont/headscale) is an open-source reimplementation of Tailscale's coordination server. Users point their Tailscale clients at a Headscale instance they (or their org) run, instead of `controlplane.tailscale.com`. **From wmux's point of view, the two are indistinguishable** — the client on each device is still the regular Tailscale client, `tailscale status --json` returns the same shape, the Tailnet IPs route the same way.

Headscale users get:
- No Tailscale account / no third-party trust.
- No free-tier device caps (Tailscale's free tier is 3 users / 100 devices personal; generous but real).
- Operational burden: they run the coordination server themselves.

Whether someone uses Tailscale.com or self-hosts Headscale is **a user choice that doesn't affect wmux's design**. We document both as supported paths, write no special-case code for either.

### Authentication

The auth model is intentionally lightweight: a per-session short code paired with a high-entropy bearer secret in the URL fragment. **No accounts, no SSO, no token-mint server, no IdP.** The host's own running wmux is the issuer.

| Property | Value |
|---|---|
| Code shape | Human-pasteable short ID, e.g. `j3k-r9p`. ~24 bits — not secret on its own. |
| Secret shape | 256-bit base64 in URL fragment, e.g. `#t=<hash>`. The actual auth material. |
| Storage | In-memory map on the host. Lost on wmux restart (which we treat as a feature: shares don't outlive the session). |
| TTL | Configurable per share. Default 4 hours for pair-share. Default `until wmux exits` for remote-yourself. |
| Revoke | One click on the share's row in the Devices/Shares panel. |

Why URL-fragment, not URL-path: fragments don't appear in server access logs, proxy logs, or HTTP request lines. They do live in the viewer's browser history, but for short-lived share codes that's an acceptable trade.

The **server-side audit log** (every connect/disconnect/byte count) lives on the host's local disk only. No third party sees it.

### Trust model & threat scenarios

In-scope, addressed:
- **Eavesdropping inside the LAN.** For untrusted LANs (coffee shop), generate a self-signed cert and bind HTTPS — see Open Question #1 below.
- **Eavesdropping in transit cross-network.** Tailscale's WireGuard tunnel is the answer.
- **Replay of expired share codes.** Server enforces `expires_at` and `revoked_at` in-memory.
- **Bearer-token theft via screenshot.** Short default TTLs + revocation.

Out-of-scope:
- **Compromised host machine.** Outside multiplayer's scope.
- **Bearer-token phishing.** Same mitigations as the old design: short TTLs, optional "confirm on first connection from a new IP" toggle.

### Object model

The host wmux tracks two first-class concepts:

1. **ShareSession** — an active sharing arrangement. Identified by a short code. Holds the secret, pane reference, expiry, permission level, and the list of currently-connected participants.
2. **Participant** — a WebSocket connection currently attached to a ShareSession. Has a participant ID, an IP/UA fingerprint, and a permission level (inherited from the share or promoted by the host).

The previous design had a separate `Surface` abstraction; in the simpler model, `ShareSession` directly references the pane/workspace/agent being shared.

### What gets synced — by surface kind

| Surface kind | Source of truth | Sync mechanism |
|---|---|---|
| Terminal pane (read-only) | Host's ConPTY output | Length-framed byte chunks over the WebSocket |
| Terminal pane (read-write) | Host's ConPTY, multiple writers | Output broadcast; viewer input forwarded to `write_to_session` |
| Workspace layout | Host's `layout_state` JSON | Periodic snapshot + delta on change |
| Agent pane state | Host's pane block-store + agent-state hooks | Parallel event stream alongside terminal bytes |

For Phase 1 we ship **read-only terminal pane streaming**.

---

## Phased implementation plan

### Phase 0 — Foundation

End state: wmux exposes an HTTP/WS server that two wmux instances can talk to over loopback, exchanging a `Hello` message and a `SessionMessage::OutputChunk`. No share UX, no real auth yet. Validates the wire protocol on a real socket.

**Tasks:**

- [ ] **0.1 — Slim `collab-proto` crate.** Keep `SessionMessage` (OutputChunk / InputChunk / LayoutDelta) and `Hello`. Drop the WebRTC `SignalingMessage` enum from the old design — there's no signaling.
- [ ] **0.2 — `collab_server.rs` module inside `src-tauri`.** New module — *not* a separate crate; it runs inside the wmux process, shares state with the session manager, and goes away when wmux closes. Uses `axum` (already a candidate from earlier scaffolding) and `tokio-tungstenite`. Exposes `/ws/:code` and a `/s/:code` static-asset handler.
- [ ] **0.3 — In-memory `ShareSessionStore`** behind a `tokio::sync::RwLock`. CRUD for `(code, secret_hash, target_pane_id, permission, expires_at, created_at)` records. Background task expires stale entries every 60s.
- [ ] **0.4 — Bind-policy plumbing.** Settings option: `collab.bind` = `loopback` | `lan` | `tailnet` | `all`. Defaults to `lan`. Server starts on first share and stops when no shares remain.
- [ ] **0.5 — Two-wmux smoke test.** A `cargo test` integration test that spawns two `axum::Router`s in-process, has one mint a share, the other connect to `/ws/:code`, validates a `Hello` round-trip and a single `OutputChunk` propagating. No real PTY needed.

**Done when:** the smoke test passes. No UI yet.

### Phase 1 — LAN-only read-only pane sharing

The MVP: click "Share pane," send a coworker on your LAN a link, they see the terminal live in their browser.

**Tasks:**

- [ ] **1.1 — "Share this pane" pane-toolbar button.** Mints a ShareSession scoped to that pane. Shows a dialog with the LAN URL + a copy button + an expiry selector.
- [ ] **1.2 — Output broadcast.** Tap into the existing `terminal-output-{sessionId}` event stream in `commands.rs::start_session_stream`. When a pane has one or more active share viewers, fork the byte stream to each viewer's WebSocket.
- [ ] **1.3 — Initial-state snapshot.** A new joiner gets the full visible buffer via the existing `SerializeAddon` snapshot, sent as the first frame after `Hello`.
- [ ] **1.4 — Web viewer (PWA).** Static page served from wmux at `/s/:code`. Imports xterm.js + addon-fit, opens the WebSocket, renders bytes. PWA manifest + service worker so it installs to the home screen.
- [ ] **1.5 — Presence indicators.** Small `👁 N` badge on the shared pane in the host's wmux, with names from participant labels. Updates live as viewers join / leave.
- [ ] **1.6 — Audit log entries** at the host. Connect / disconnect / byte-count rolls up into a local SQLite table; viewable from Settings → Audit Log.
- [ ] **1.7 — Manual share-revoke.** Devices/Shares panel lets the host kill an active share with one click; connected viewers disconnect immediately.
- [ ] **1.8 — Optional TLS-self-signed.** For LANs the user doesn't fully trust: generate a per-session self-signed cert, prompt the viewer to accept once. Off by default (plain HTTP for LAN is fine on a trusted home / corp network); opt-in for untrusted Wi-Fi.

**Done when:** Host shares a pane, coworker on the same LAN pastes the URL into their browser, sees the terminal rendering live including ongoing output.

### Phase 2 — Cross-network via Tailscale

End state: same share flow works between a laptop and a phone on cellular, with Tailscale providing the transport.

**Tasks:**

- [ ] **2.1 — Tailscale-presence detection.** Read `tailscale status --json` (or hit `http://localhost:41112/localapi/v0/status` — Tailscale's documented local API) on startup and on a settings refresh. Cache the result for ~30 s.
- [ ] **2.2 — Tailnet URLs in the share UX.** When Tailscale is up, the share dialog shows both LAN and Tailnet URLs (clearly labeled). User picks which to send.
- [ ] **2.3 — "Tailscale not installed" empty-state.** Devices settings shows install instructions + a link to Tailscale's setup docs when no daemon is detected. We don't reproduce their onboarding.
- [ ] **2.4 — Reconnection on the WebSocket.** Train tunnels and laptop sleep both happen. Viewer's WebSocket reconnects with exponential backoff (1s / 2s / 4s / 8s, capped at 30s). On reconnect, the host replays buffered output (5-minute / ~4MB ring buffer per share).
- [ ] **2.5 — Mobile-viewport polish.** Pinch-to-zoom for xterm.js, tap-and-hold for selection, virtual-keyboard handling. Mostly xterm.js config + CSS.
- [ ] **2.6 — Optional mutual-confirm.** Toggle in settings: "Confirm new IPs/UAs before allowing access." When on, the host's wmux pops a dialog on first connection from a new fingerprint per share.

**Done when:** I share a pane, walk to the train, open the URL on my phone over LTE, see my running terminal live and reconnect cleanly through tunnels.

### Phase 3 — Collaborative input

Promote a shared pane from read to read-write. Multiple users can type into the same terminal.

**Tasks:**

- [ ] **3.1 — Permission-promotion UI.** Host clicks a participant in the presence indicator → "Grant write access." Updates the ShareSession's per-participant permission; emits a permission-change frame.
- [ ] **3.2 — Viewer-side input capture.** Read-write viewers forward xterm.js input events as `SessionMessage::InputChunk` over the WebSocket.
- [ ] **3.3 — Host-side input merge.** Input chunks pipe into the same `write_to_session` Tauri command that local input uses. The PTY linearizes — no explicit ordering required for v1.
- [ ] **3.4 — Input attribution.** Each `InputChunk` carries the participant ID; host pane shows a brief "Alice is typing" status-bar hint.
- [ ] **3.5 — Optional keystroke audit.** Setting: log every InputChunk's metadata (length, participant, timestamp). Content optional. Off by default.

**Done when:** Host promotes Alice to write-access, Alice types `ls`, host's terminal runs it and broadcasts output back.

### Phase 4 — Workspace sharing

Share a whole workspace layout, not just one pane.

**Tasks:**

- [ ] **4.1 — Workspace-as-a-share-target.** A ShareSession can reference a workspace + an explicit list of pane labels inside it.
- [ ] **4.2 — Layout snapshot + delta.** Host publishes the workspace's layout JSON on connect, then sends deltas on every meaningful change. Reuses existing layout-persistence machinery.
- [ ] **4.3 — Viewer-side layout rendering.** Viewer's wmux opens a "joined workspace" view that mirrors the host's pane tree as read-only panes. Native viewer only; PWA workspace view is later.
- [ ] **4.4 — Per-pane opt-in.** Sharing a workspace doesn't auto-share every pane. Each pane gets a "share" checkbox; unshared panes show as opaque placeholders to viewers.

**Done when:** Alice opens her workspace, marks two panes as shared, sends Bob the link. Bob joins; sees Alice's pane tree with two live panes and the rest as placeholders.

### Phase 5 — Agent supervision

The real differentiator vs Live Share / tmate. Agent panes broadcast structured state in addition to terminal bytes.

**Tasks:**

- [ ] **5.1 — Agent surface broadcast.** Beyond the terminal byte stream, broadcast structured agent-state events (working/blocked/ready, OSC 133 block start/end, hook-driven state) on a separate channel.
- [ ] **5.2 — Viewer-side agent timeline.** Web viewer renders a richer panel for agent panes: terminal on one side, agent-event timeline on the other.
- [ ] **5.3 — Handoff request flow.** "Pass control of this Claude" — viewer requests write access; host approves; viewer drives the agent's input. Every handoff is in the audit log.
- [ ] **5.4 — Agent-share MCP tools.** `share_agent_pane(label, permission)` / `revoke_agent_share(label)` so an external orchestrator can grant/revoke programmatically.

**Done when:** Host shares a Claude pane. Viewer sees terminal + live timeline. Viewer requests control; host approves; viewer types a follow-up prompt; host's Claude responds.

### Phase 6 — Fan-out and recording (deferred)

For the rare big-fan-out and "watch a recording later" cases. Same problem as before; same solution shape (host opens an extra recording sink). Deferred until somebody actually asks.

### Phase 7 — Enterprise auth (deferred)

If a customer ever asks: layer OAuth/OIDC over the share-mint flow. SSO becomes another way to authorize "is this user allowed to receive a share token?" but the transport doesn't change.

---

## Cross-cutting concerns

### Performance budget

Target: **<100 KB/s per peer** for a busy 80×24 terminal at sustained output. A WebSocket carries this trivially over LAN or Tailscale.

### Reconnection

- **Short disconnect (<30 s):** WebSocket reconnect logic handles it.
- **Medium disconnect (up to buffer size):** re-handshake; host replays buffered output.
- **Long disconnect (> buffer size):** viewer gets a fresh snapshot, no full replay.

Host buffer defaults to ~5 minutes / ~4 MB per shared surface, configurable.

### Bind interface policy

Default to "all non-loopback IPv4 interfaces" — covers LAN + Tailnet without special-casing. Users on coffee-shop Wi-Fi can switch to `tailnet-only` from settings.

### Mobile PWA

Same as before: regular web page + manifest + service worker. Installable from iOS Safari and Android Chrome. Updated automatically on next launch. No app store. The implementation work is just xterm.js config for touch-friendly behavior (pinch-zoom, tap-and-hold-to-select, virtual-keyboard handling).

### Open questions

1. **LAN HTTPS story.** Plain HTTP on a trusted LAN is fine; on untrusted Wi-Fi (coffee shop) we want TLS. Self-signed certs work but require viewer cert-acceptance UX. Mitigation: default to `tailnet-only` if Tailscale is detected (which gives transport encryption for free) and only fall back to LAN for explicitly-trusted networks. Worth a closer look in Phase 1.
2. **mDNS / `.local` resolution on Windows hosts.** Phone-to-Windows-machine over LAN needs the phone to resolve a hostname. Bonjour on iOS, mDNS on Android — both work in practice but are flaky. Likely punt and just use the host's LAN IP in the URL (`http://192.168.1.42:port/...`).
3. **`tailscale-rs` maturity (Aug 2025: pre-1.0).** Decision deferred to when we revisit Option B. Until then, Phase 2 is on Option A (user installs the daemon).

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Users on locked-down corporate networks can't expose ports on the host | medium | Tailscale path doesn't need ports exposed — it's outbound-only. Document this as the recommended path for corporate environments. |
| LAN HTTPS UX (self-signed cert) is bad enough to push users to Tailscale even on LAN | medium | That's fine — we're not married to LAN HTTP. Tailscale-everywhere is a reasonable fallback recommendation. |
| `tailscale-rs` not yet stable, blocking embed (Option B) path | n/a | Option A doesn't need it. Revisit Option B post-1.0. |
| User generates a long-TTL self-share, never revokes it | medium | UX nudges in Devices panel; periodic reminders for long-TTL shares. |
| Mobile PWA on iOS Safari has subtle xterm.js bugs | medium | Plan a day in Phase 2 for mobile QA. xterm.js mobile gotchas are well-documented. |
| Coworker doesn't have Tailscale → cross-network pair-program path broken | high | Acknowledge it: cross-network pairing requires the coworker to install Tailscale. Document the install flow. For most pair-programming, same-network suffices. |

---

## Where this lives in the codebase

```
wmux/
├── browser-helper/                        (existing — out-of-process CEF browser)
├── collab-proto/                          ← slim shared-types crate (SessionMessage, Hello only)
│   └── src/lib.rs
├── src-tauri/src/
│   ├── collab_server.rs                   ← NEW: axum HTTP/WS server, started on demand
│   ├── collab_share_store.rs              ← NEW: in-memory ShareSessionStore
│   ├── collab_tailscale.rs                ← NEW: Tailscale-presence detection (Phase 2)
│   └── commands.rs                        (+ share_pane, revoke_share, list_active_shares...)
├── src/
│   └── collab_runtime.mjs                 ← NEW: frontend hooks for shares + presence + devices UI
└── viewer-pwa/                            ← NEW: static assets served by wmux at /s/:code
    ├── index.html
    ├── manifest.webmanifest
    ├── sw.js
    └── viewer.mjs
```

The `collab-server` *crate* from the previous design is **gone** — its functionality moves into a module inside `src-tauri`. The `collab-proto` crate stays but slimmed (no SignalingMessage).

---

## Concrete next step

**Phase 0** — slim the proto crate, drop `collab-server`, stand up `collab_server.rs` inside src-tauri, write the two-wmux smoke test. ~2 days. Validates the wire protocol on a real WebSocket without any UI work.

**Phase 1** — share-pane UX + PWA viewer over LAN. ~3 days after Phase 0. Done when you can share a pane to a coworker's laptop on your LAN and see it render.

**Phase 2** — Tailscale-aware URLs. ~1 day after Phase 1, mostly settings/UI work and a `tailscale status --json` call.

---

## Rejected alternatives

The previous version of this doc (see git history) proposed:

- **A separate `collab-server` Rust crate** running as an internet-facing rendezvous, accepting WSS signaling traffic from hosts and viewers.
- **WebRTC RTCDataChannel** as the peer-to-peer transport with DTLS encryption.
- **STUN + bundled TURN** to handle NAT traversal, with a fallback path for ~25% of corporate↔cellular sessions.
- **A token-mint/redeem subsystem** in the rendezvous, with SQLite-backed `access_tokens`.
- **Persistent host-signaling WebSockets** so phones could "ring the bell" of a laptop sitting behind NAT.

**The realization:** the rendezvous wasn't a small thing on the side. It was a wmux-specific reimplementation of a *Tailscale-coordination-server-shaped* thing. Both solve the same problem with the same shape:

| | Tailscale/Headscale coordination | Custom rendezvous (rejected) |
|---|---|---|
| Introduces peers to each other | WireGuard pubkey exchange | WebRTC SDP / ICE exchange |
| Holds long-lived presence so peers can be "called" | Each client maintains a control connection | Host's persistent signaling WebSocket |
| Provides relay fallback when direct fails | DERP | Bundled TURN |
| Sees session plaintext | No | No |
| Gates who can join | Tailnet ACLs | `access_tokens` table |
| Production-tested, clients exist for every platform | Yes | No — we'd build it |

Why scrapped:
- **Most use cases are LAN-local.** Pair-programming with someone in the same office, demo'ing to the team, pair-debugging — all same-network. The entire NAT-traversal apparatus solves a problem these cases don't have.
- **The cross-network cases are exactly the coordination-server problem.** Reinventing NAT traversal, identity, and relay infrastructure to compete with a free, working, battle-tested product (Tailscale, or self-hosted via Headscale) was poor engineering judgment. The constraint that drove it ("viewer must not install anything") was mine, not the user's; once dropped, the WebRTC architecture collapses.
- **Operational burden of running a rendezvous, even self-hosted.** Every user who wanted cross-network access had to deploy a server. The Phase-0 plan was 7 sub-tasks long *just to get a hello-world handshake working*. With Tailscale, cross-network is a settings toggle.
- **`collab-server` would have meant maintaining auth, persistence, signaling, and TURN forever.** Removing that crate removes a whole vector of future maintenance.

The brief life of the `collab-server` crate (PR #35, opened and closed without merging) is the artifact of this pivot.
