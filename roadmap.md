# wmux roadmap — gaps to close

Derived from [`docs/competitive-landscape.md`](docs/competitive-landscape.md) (snapshot **2026-05-31**). This file is the prioritized worklist: each entry is a gap the competitive analysis exposed, who is ahead on it, what "closed" means, and how to verify. The category churns weekly — re-run the [recheck](#weekly-landscape-recheck) before trusting priorities.

Priority key: **P0** = defends or extends the core; do next. **P1** = closes a visible, exploited gap. **P2** = worth doing, not urgent. **P3** = watch / opportunistic.

---

## P0 — defend the core / close the most-exploited gap

### P0.1 — Process & agent persistence (true detach/reattach)
- **Gap.** wmux "session restore" rebuilds layout + scrollback *text*; the live process dies on host restart and agents do not resume their conversation. For a tool named `-mux` this is the most conspicuous missing primitive.
- **Who's ahead.** herdr (shipped `resume_agents_on_restore` — agents restart into their previous conversation, 2026-05); Warp, mux.
- **Direction.** A background/headless session host that owns the PTYs independently of the WebView window, so closing/reopening (and ideally crashing) the app reattaches to live processes. Layer agent-conversation resume on top for Claude/Codex (hooks already exist) using each CLI's `--resume`/`--continue` semantics.
- **Done when.** Closing the wmux window and reopening reattaches to a still-running `npm run dev` / long job without restarting it; a hooked Claude/Codex pane offers "resume previous conversation." Add an integration test that spawns a session, drops the frontend, and reattaches.
- **Risk.** Touches `session_manager.rs` / `conpty.rs` lifecycle — load-bearing, historically fragile (see project memory on `createLeafPane` init order). Spike behind a flag; do not regress the blank-terminal path.

### P0.2 — Frontend & lifecycle test coverage
- **Gap.** ~~0 frontend tests~~ **22 tests now exist** (`npm test`, Node built-in runner, `test/*.test.mjs`). Baseline and pattern established 2026-05-31 via worktree-state extraction. Still uncovered: the load-bearing init paths, session-restore round-trip, collab reconnect, and agent-state transitions.
- **Who's ahead.** Everyone with a user base finding edge cases for them; wmux has bus factor 1.
- **What's covered.** `connection_targets`, `layout_state` (serialization, markdown path, pinned workspace restore), `terminal_restore` (transcript normalization, CWD inference, sanitization), `worktree_state` (branch label, split CWD inheritance — caught a Windows drive-letter edge case in the red-green cycle).
- **Pattern.** Extract pure logic into a side-effect-free `.mjs` (no DOM, no Tauri imports) → test that module → wire it into `main.js`. Each new feature should add its module + test file together.
- **Next targets.** `createLeafPane` init order (broke the blank-terminal bug twice — highest risk); session-restore serialization round-trip (`buildSerializedLayout` → `buildRestoredTerminalState`); collab reconnect/replay buffer; agent-state machine transitions (`AgentHookState` shape).
- **Done when.** CI runs `npm test` on every PR and blocks on failure; the `createLeafPane` init order and session-restore round-trip have explicit regression tests.

---

## P1 — close visible, exploited gaps

### P1.1 — Multi-harness lifecycle hooks (beyond Claude + Codex)
- **Gap.** Authoritative state for 2 of ~6 supported agents; the rest fall back to screen-scraping for `ready`/`idle`/`blocked`.
- **Who's ahead.** cmux (14+ agents, incl. `PermissionRequest`); herdr (14+ via socket).
- **Direction.** A per-harness adapter that maps each agent's lifecycle events into the existing `AgentHookState` shape. Add Gemini, OpenCode, Aider, Amp next. Capture `PermissionRequest`-equivalents where available (cmux's open-source installer is a reference for the recipes).
- **Done when.** ≥4 harnesses drive the "live" badge from real events; a blocked-on-permission agent surfaces distinctly from idle.

### P1.2 — Worktree polish (cross-pane, not just on-demand)
- **Gap.** Worktree isolation shipped (2026-05-25) but is per-pane/on-demand. Running two top-level agent panes against one repo still needs manual coordination, and there's no divergence visibility.
- **Who's ahead.** Warp (worktree metadata on agent tabs), mux (git-divergence dashboard), Zed (per-thread worktree).
- **Shipped 2026-05-31.** WT button shows active branch name (green, truncated); split inherits parent worktree CWD via `inheritedCwdForSplit`; `tab-branch` badge now populated.
- **Known gap (Rust-side).** WT button requires shell integration when the pane has no git context — without OSC 7, wmux cannot read the ConPTY child process's current directory. Current workaround: fallback prompt. Proper fix: store `startup_cwd` in `SessionEntry` and/or read the child process CWD via `NtQueryInformationProcess`.
- **Still to do.** Sidebar worktree indicator per pane; lightweight cross-workspace git-divergence view (mux's dashboard is the benchmark).
- **Done when.** A pane visibly shows its worktree/branch in the sidebar; spawning a sibling pane offers same-worktree vs new-worktree; divergence across panes is glanceable; WT button works without shell integration.

### P1.3 — Reframe positioning: WSL + MCP server, not "Windows-first"
- **Gap.** "Only Windows-first agent terminal" is no longer clean — mux shipped Windows-alpha and Windows Terminal is becoming a Warp rival. This is a messaging/README gap, cheap to fix.
- **Direction.** Lead the README and store copy with the four durable differentiators (MCP server + Code Mode, local-first Tailscale share, deepest WSL integration, `tmux.exe` shim). Demote "Windows-first" to a platform fact, not the headline.
- **Done when.** README "Why wmux" leads with the defensible core; the Windows claim is stated as "the only one with first-class WSL," not "the only Windows one."

---

## P2 — worth doing, not urgent

### P2.1 — GPU-accelerated renderer
- **Gap.** xterm.js over WebView2 vs native GPU renderers (Zed, Warp, cmux). Real perception gap, but large effort and not the highest-leverage gap right now.
- **Direction.** Evaluate a wgpu/Ghostty-backed renderer as a long-running spike; gate on whether persistence (P0.1) and tests (P0.2) are stable first.
- **Done when.** A scoped spike exists with a go/no-go decision and a measured throughput/latency comparison — not necessarily a swap.

### P2.2 — Editor-adjacent surface
- **Gap.** Zed (ACP + Terminal Threads) puts agents next to file tree/git/diff; wmux's nearest equivalent is a read-only PR-review pane.
- **Direction.** Decide explicitly whether to compete here or stay terminal-first. If competing: richer diff/edit affordances in the PR pane. If not: document the non-goal so it stops reading as a gap.

---

## P3 — watch / opportunistic

- **P3.1 — Widen the MCP-server lead.** It's the one thing nobody else has. Warp's roadmap ("control the client via CLI") is creeping toward this space. Invest in Code-Mode ergonomics, discoverability (`wmux_search`), and example agent workflows so the lead is *used*, not just *novel*.
- **P3.2 — Tailscale share depth.** Local-first multi-device share is differentiated. Candidate depth: audit-log persistence (currently a ring buffer; SQLite deferred), more granular per-share permissions.
- **P3.3 — Windows Terminal watch.** If MS adds session persistence or agent-state awareness to the free default, the niche compresses fast. Track its changelog (see recheck).

---

## Weekly landscape recheck

This category moved materially in 6 days (the 2026-05-25 snapshot was stale within hours). Before trusting `competitive-landscape.md` or these priorities, re-pull:

| Tool | Watch |
|---|---|
| Warp | [changelog](https://docs.warp.dev/changelog/2026/) · [blog](https://www.warp.dev/blog) · [roadmap #9233](https://github.com/warpdotdev/warp/issues/9233) |
| cmux | [changelog](https://manaflow-ai-cmux.mintlify.app/resources/changelog) · [releases](https://github.com/manaflow-ai/cmux/releases) |
| Zed | [blog](https://zed.dev/blog) · [releases](https://github.com/zed-industries/zed/releases) |
| herdr | [releases](https://github.com/ogulcancelik/herdr/releases) |
| mux | [repo](https://github.com/coder/mux) · [install](https://mux.coder.com/install) (track Windows alpha → GA, WSL support) |
| t3code | [releases](https://github.com/pingdotgg/t3code/releases) |
| Windows Terminal | MS changelog (track persistence / agent-state features) |

When rechecking: bump the snapshot date, flip changed matrix rows, note anything that moves a moat in **What changed**, and re-sort this file's priorities.

> **Honest caveat for AI agents updating this file:** every claim here is perishable and several wmux entries describe days-old code. Verify against the repo (`git log`, the actual `src-tauri/src` modules) before asserting a gap is open or closed.
