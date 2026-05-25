# wmux competitive landscape

Maintainer-facing comparison of wmux against the closest tools in the agent-terminal and AI-coding-workspace category. Snapshot date: **2026-05-25**.

> **Methodology.** wmux state is verified against the current repo (HEAD on `main`). Other tools are summarized from their public repos, release notes, and docs as of the snapshot date; sources are linked inline below. Where claims couldn't be confirmed, the entry says so.

## Tools covered

| Tool | Category | Platform | License | Repo |
|---|---|---|---|---|
| **wmux** | Agent-aware terminal multiplexer | Windows-native (WSL/SSH-aware) | AGPL-3.0 | (this repo) |
| **Warp** | Agent-first terminal + cloud orchestration platform | macOS, Linux, Windows (all GA) | AGPL-3.0 core / MIT UI crates ([open-sourced Apr 30 2026](https://www.warp.dev/blog/warp-is-now-open-source)) | [warpdotdev/warp](https://github.com/warpdotdev/warp) |
| **cmux** | macOS agent terminal | macOS only | GPL-3.0-or-later | [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux) |
| **Zed** | GPU-accelerated code editor + agent panel | macOS, Linux, Windows (all stable) | GPL-3.0 editor / AGPL-3.0 server / Apache-2.0 GPUI | [zed-industries/zed](https://github.com/zed-industries/zed) |
| **herdr** | TUI agent runtime/multiplexer | Linux, macOS (POSIX) | AGPL-3.0 | [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) |
| **mux** (coder) | Parallel-agent desktop with worktree isolation | macOS, Linux | AGPL-3.0 | [coder/mux](https://github.com/coder/mux) |
| **t3code** | GUI harness for official agent CLIs | macOS, Linux, Windows | MIT | [pingdotgg/t3code](https://github.com/pingdotgg/t3code) |

## Feature matrix

Legend: ✅ shipped first-party · ⚠️ partial / opinionated punt · ❌ not shipped

| Dimension | wmux | Warp | cmux | Zed | herdr | mux | t3code |
|---|---|---|---|---|---|---|---|
| Windows GA / stable | ✅ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ |
| MCP **server** (callable by external agents) | ✅ HTTP `:7766/mcp` + named pipe | ❌ MCP **client** only | ❌ (community `cmux-mcp` exists) | ❌ | ❌ | ❌ | ❌ |
| Code Mode (server-side JS sandbox over MCP tools) | ✅ `wmux_eval` default surface | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| MCP client (consume external MCP servers) | ⚠️ via Claude Code in pane | ✅ Streamable HTTPS + SSE + OAuth | ⚠️ via agent in pane | ✅ via agent | ⚠️ via agent | ⚠️ via agent | ⚠️ via agent |
| tmux compatibility shim | ✅ `tmux.exe` | ❌ | ❌ | ❌ | native tmux | ❌ | ❌ |
| Multi-agent in one window | ✅ sidebar + cross-workspace rollup | ✅ Universal Agent Support (tabs side-by-side) | ✅ vertical workspace tabs | ✅ Parallel Agents — threads sidebar | ✅ ~14 agent integrations | ✅ sub-agents + Best-of-N | ✅ |
| Agent-CLI lifecycle hooks (authoritative state) | ✅ Claude Code only → "live" badge | ✅ for built-in agent surfaces | ✅ lifecycle hooks (SessionStart/Stop/PreToolUse/PermissionRequest/…) across 14+ agents | ⚠️ via ACP-aware agents | ✅ socket forwarding for 14+ agents, 4-state (idle/working/blocked/done) | partial | ❌ |
| Screen-content state fallback for any TUI agent | ✅ shell-prompt + bottom-rows heuristic | ✅ (own surface) | ✅ | n/a | ✅ | ❌ | ❌ |
| Browser surface in pane | ✅ iframe + auto-fallback to in-pane CEF (CDP screencast) | ❌ | ✅ scriptable browser (separate window) | ❌ | ❌ | ✅ browser tabs for live sessions | ❌ |
| Markdown / notebook surface in pane | ✅ | ✅ Notebooks | ❌ | ✅ in-editor | ❌ | ❌ | ⚠️ diff viewer |
| Activity log (per-agent tool calls + I/O) | ✅ + per-pane agent timeline | ✅ Blocks history | partial | ✅ thread history | ⚠️ | partial | ✅ |
| Per-pane one-shot ask against any installed agent CLI | ✅ Claude/Codex/Gemini/OpenCode/Aider | ✅ (own agent) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Real-time multi-device collab (live pane / workspace share) | ✅ Tailscale-aware, PWA viewer, read/write, local-first | ✅ live multi-cursor/viewer — **cloud-only via Warp backend** | ❌ | ✅ DeltaDB CRDT (human + agent character-level) | ❌ | ❌ | ❌ |
| Git worktree isolation per agent (first-party) | ❌ delegated to Claude Code's `isolation:"worktree"` | ✅ auto-detect + per-worktree review/indexing | ❌ ([issue #156](https://github.com/manaflow-ai/cmux/issues/156) open) | ✅ per-thread, detached HEAD | ✅ worktree CLI + socket API | ✅ core runtime mode | ✅ task isolation |
| Customizable keybindings (JSON, hot-reload) | ✅ | ✅ | partial | ✅ | ✅ | partial | ❌ |
| Session restore (layout + scrollback + state) | ✅ full layout graph | ✅ via Drive | ✅ (incl. scrollback + browser history) | partial | ✅ detach/reattach | ✅ | ❌ |
| SSH / remote terminal | ✅ ConPTY + WSL + SSH spawn | ✅ Warp SSH | ✅ SSH workspace attach | ⚠️ basic | ✅ first-class thin client | ✅ runtime mode | ❌ |
| Multi-shell (bash / zsh / fish / PowerShell, per-pane flavor) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| GPU-accelerated terminal renderer | xterm.js over WebView2 | ✅ Rust GPU | ✅ libghostty | ✅ Rust/Metal/D3D11 | terminal host | Electron | Electron |
| OSC notification ring (9 / 99 / 777) | ✅ | partial | ✅ | ❌ | ✅ | ❌ | ❌ |
| Workbook / charts via MCP | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| PR review pane | ✅ with multi-CLI inline Ask AI | ⚠️ via cloud agent | ⚠️ via PR linkage in sidebar | ✅ in-editor diff | ❌ | ✅ integrated review pane | ✅ |
| Cloud / login required for full feature set | ❌ local-first | ✅ (Active AI / Agent Mode / Oz / Shared Sessions all cloud) | ❌ | optional | ❌ | optional | optional |

## Where wmux is ahead

### MCP server (not just client) + Code Mode

Every other tool in this list is, at best, an MCP **client** — they consume external MCP servers (Warp is the most aggressive consumer with OAuth installs and hot-add) but none of them expose themselves as an MCP server for an external agent to drive. wmux is the only one. On top of that, the default MCP surface is **Code Mode** (`wmux_eval`): an agent writes a JS script in a `boa_engine` sandbox where every other wmux tool is a bound function — collapsing N tool-call round-trips into one. Nothing else here does this.

### Multi-device collab over Tailscale, local-first

wmux runs an in-app HTTP/WebSocket server that surfaces a PWA viewer for any pane or whole workspace. Tailscale-aware URLs (uses the 100.x tailnet IP when available); read/write share with mutual confirmation on first device; viewer reconnect with per-share replay buffer; layout mirrored across multi-tab workspaces; agent timeline panel in the viewer. **No cloud, no broker, no account.**

Warp's Shared Sessions are live and multi-viewer but require publishing to Warp's cloud — no self-host, no Tailscale, no LAN-only option documented. Zed's DeltaDB tackles a different angle (real-time CRDT sync of code/state with agents and humans) but isn't a pane-share surface. cmux, mux, herdr, t3code don't ship multi-device collab.

### tmux.exe shim

Agent harnesses that drive tmux commands (Claude Code's own session management, many automation scripts) work on Windows without modification because wmux ships a `tmux.exe` that maps the agent-facing tmux subset onto the wmux automation API. herdr targets real tmux; nobody else in this list ships a shim.

### Browser-in-pane with iframe → CEF auto-fallback

Headers like `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors` kill the cheap iframe path. wmux auto-detects header-blocked navigation and re-opens the page in an out-of-process CEF helper, embedded in the pane via CDP `Page.startScreencast` → JPEG → `<canvas>`. Input forwarding (mouse, wheel, keyboard) routed back over CDP. Helper HWND hidden via `WS_EX_LAYERED` + alpha=0. cmux has a scriptable Chromium but in a separate window; mux has browser tabs in live sessions; Warp/Zed/herdr/t3code don't ship in-pane browser.

### Per-pane one-shot ask against any installed agent CLI

The PR-review panel can spawn any installed agent CLI in one-shot mode (`claude -p`, `codex exec`, `gemini -p`, `opencode run`, `aider --message`), pipe the diff context, and render the response inline. The user's own auth applies — no per-provider API-key plumbing in wmux. Warp's inline-ask is tied to its own agent surface. t3code is the closest analogue — a CLI harness with BYOK — but isn't a terminal multiplexer.

### Windows-first, fully local

Still a moat, but narrower than the prior version of this doc implied. Zed Windows went stable Oct 15 2025. Warp Windows shipped Feb 2025 (GA). t3code is Electron, runs on Windows. cmux and herdr remain POSIX/macOS-only; mux is macOS+Linux only. wmux is still the only agent-first terminal multiplexer built **from the ground up for Windows** with explicit ConPTY/PowerShell/WSL/WebView2 integration — but Windows availability alone is no longer the headline.

## Where wmux lags

### First-party git worktree isolation

The biggest correction vs. the prior version of this doc. Every other tool in the matrix except cmux ships first-party worktree isolation:

- **Warp** auto-detects worktrees, runs per-worktree code review and codebase indexing, can spawn worktrees from the `+` menu.
- **Zed** can start each agent thread in a new worktree with detached HEAD.
- **mux** makes worktree-per-workspace one of three runtime modes; worktrees share `.git` with the main repo.
- **herdr** shipped worktree CLI + socket API for agents to drive worktree workflows.
- **t3code** ships worktree task isolation.

wmux's framing has been: delegate to Claude Code's native `isolation:"worktree"`. That covers the within-Claude-subagent case but **not** the cross-pane case — running two top-level Claude (or Codex, or Gemini) panes against the same repo still requires the user to manage worktrees by hand. Earlier versions of this doc called this an "intentional non-feature." Given how universally it has been adopted, that framing is no longer defensible — it's a real gap.

### Terminal renderer speed

Warp ships a Rust GPU renderer; cmux on libghostty; Zed on Rust + Metal/D3D11. wmux is xterm.js over WebView2. Now that Warp is open source (AGPL core), there's no longer a "proprietary thing we can't match" excuse — but the integration work to swap renderers is still substantial. Ghostty/wgpu replacement remains on the roadmap, not started.

### Universal agent-lifecycle adapter

wmux captures Claude Code's 5 lifecycle hooks (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `UserPromptSubmit`) with tool name + notification message + timestamp per pane. The "live" badge in the sidebar uses only two of those (`working`, `completed`); the rest of the wmux state machine (`ready` / `idle` / `blocked`) comes from screen-scraping, not from hooks. Other agents fall back entirely to the shell-prompt heuristic. Meanwhile:

- **cmux** installs lifecycle hooks for 14+ agents (Codex, Grok, OpenCode, Pi, Amp, Cursor, Gemini, Antigravity, RovoDev, Hermes, Copilot, CodeBuddy, Factory, Qoder) plus a Claude Code wrapper, capturing `SessionStart` / `Stop` / `UserPromptSubmit` / `Notification` / `PreToolUse` / `PermissionRequest`. Broadest *and* deepest hook integration in the matrix.
- **herdr** has a socket API that forwards a 4-state machine (idle / working / blocked / done) across 14+ agent integrations — less per-event detail than cmux, but bidirectional and well-documented.
- **Zed** gets lifecycle state for free from ACP-aware agents.

Honest read: wmux is narrower than cmux on agent coverage *and* narrower than cmux on event detail (cmux captures `PermissionRequest`, which is genuinely useful and which wmux doesn't surface). wmux is narrower than herdr on coverage but captures somewhat richer per-event data on the one harness it does support (Claude Code). The cleanest path forward is a per-harness adapter layer that maps each agent's lifecycle events into the existing `AgentHookState` shape — cmux has already done the integration work, so the per-agent hook recipes are at least demonstrable.

### Editor integration

Zed's Agent Client Protocol lets ~6 agents (Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, OpenCode, Cursor) attach into the editor with file tree, git, and diff context as first-class structured surfaces. ACP clients have spread beyond Zed (JetBrains AI Assistant, Neovim). wmux is a terminal — the PR-review pane is the closest thing to a code-aware surface, and it is read-only diff inspection. Users who want an agent + editor combo in one window pick Zed.

### Cross-platform reach

t3code, mux, Warp, and Zed all run on multiple OSes. wmux is Windows-only — a deliberate architecture choice that limits mixed-OS teams. macOS users default to cmux, Warp, or Zed; Linux users default to Warp, Zed, or herdr.

### Polish budget vs. Warp

Warp has a paid team, years of UX investment, and now open-source visibility. Object Inspector (structured parsing of command output), command palette, autosuggest, voice control, and the overall block-based UX outpace what an xterm-over-WebView2 surface can reach without significant work. Warp's Oz cloud-orchestration platform also defines an upper bar on "scale" that wmux is not chasing — and probably shouldn't, given the local-first positioning.

## Tool-by-tool notes

### Warp ([warpdotdev/warp](https://github.com/warpdotdev/warp))

The 800-pound gorilla, and as of April 30 2026 also open source (AGPLv3 core + MIT UI crates, OpenAI as founding sponsor). All three platforms GA. **Universal Agent Support** runs Claude Code, Codex, and Gemini CLI side-by-side in tabs. **Oz** (Feb 2026) is a cloud-orchestration platform that runs autonomous agents in parallel, schedulable, event-triggered — usable standalone outside the terminal. Shared Sessions are genuinely live (multi-cursor, multi-viewer, optional edit access) but **cloud-mediated only** — no self-host, no Tailscale, no LAN. **MCP client only**, not server — external agents can't drive Warp. BYOK pricing in 2026: free tier 150 credits/mo, Build $20/mo, Business $50/user/mo. Where wmux beats Warp: MCP server, Code Mode, tmux shim, local-first multi-device collab, in-pane browser. Where Warp beats wmux: renderer, polish, Oz, cross-platform install base.

### cmux ([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux))

macOS-only, GPL-3.0-or-later (not AGPL — correcting earlier versions of this doc), libghostty renderer, ~19k stars. Differentiators: vertical-tab workspace sidebar with PR linkage, an in-app scriptable browser ported from vercel-labs/agent-browser, browser-data import from 20+ browsers, persistent scrollback. **Lifecycle-hook installer for 14+ agents** (Codex, Grok, OpenCode, Pi, Amp, Cursor, Gemini, Antigravity, RovoDev, Hermes, Copilot, CodeBuddy, Factory, Qoder) plus a Claude Code wrapper. Hooks capture `SessionStart` / `Stop` / `UserPromptSubmit` / `Notification` / `PreToolUse` / `PermissionRequest` and feed both session-resume and a permission-request "Feed" sidebar — this is the broadest + deepest hook integration in the matrix, by a wide margin. **Worktree NOT first-class** — issue #156 is open. **No first-party MCP server**; a community `cmux-mcp` exposes `write_to_terminal` / `read_terminal_output` / `send_control_character`. SSH workspace attachment shipped; Cloud VMs + iOS app advertised but not GA.

### Zed ([zed-industries/zed](https://github.com/zed-industries/zed))

A code editor first; agent panel second. Windows went stable Oct 15 2025. **Zed 1.0** shipped April 29 2026 with **Parallel Agents** as the headline feature — concurrent agent + terminal threads in one window, per-thread agent selection, per-thread worktree (detached HEAD). The **Agent Client Protocol (ACP)** is an open standard with a registry; registered agents include Claude Code, Codex CLI, Gemini CLI, Copilot CLI, OpenCode, and Cursor. ACP clients beyond Zed include JetBrains AI Assistant and Neovim. **DeltaDB** (announced at 1.0) is a CRDT sync engine for real-time character-level shared state between humans and agents — different angle on "collab" than wmux's pane share. Terminal panel has tabs and splits but **not** tmux-style layouts (issue [#16174](https://github.com/zed-industries/zed/issues/16174) open). License: GPL editor, AGPL server, Apache GPUI.

### herdr ([ogulcancelik/herdr](https://github.com/ogulcancelik/herdr))

The most terminal-native option: runs **inside** an existing terminal rather than replacing it, so fonts, SSH setup, and keybindings carry over. AGPL-3.0, Rust, ~2.4k stars, very actively developed (v0.6.2 May 2026). Native integrations for ~14 agent harnesses (Claude Code, Codex, opencode, Copilot CLI, Kiro, hermes, pi, omp, …) with a socket API that forwards semantic state (blocked / working / done). Detach/reattach, SSH thin-client mode, git worktree workflows shipped including CLI + socket API. POSIX-only, no Windows.

### mux (coder) ([coder/mux](https://github.com/coder/mux))

By Coder (coder.com). macOS + Linux only (no Windows — correcting earlier versions of this doc). AGPL-3.0. Three runtime modes: `local`, `worktree`, `ssh`. Worktrees auto-created per workspace under `~/.mux/src/<project>/<workspace>` sharing `.git` with the main repo. **Plan / Exec / Review** tri-mode separates architect / implementer / read-only auditor. Recent 2026 work: `/goal` auto-prompting, `/btw` side-Q&A, DeepSeek V4 + monorepo sub-projects, browser tabs for live sessions, "Best of N" parallel launches. Strongest of the matrix on disciplined parallel-agent workflows.

### t3code ([pingdotgg/t3code](https://github.com/pingdotgg/t3code))

GUI harness on top of existing CLI agents (Codex, Claude Code, OpenCode) — BYOK. MIT, Electron, all three platforms. Created Feb 2026, still pre-1.0 (v0.0.24 at snapshot). Multi-agent parallelism, git-worktree task isolation, turn-by-turn diff viewer, embedded terminal, one-click Commit/Push/Open-PR. Best fit for users who want a visual diff/chat front-end without leaving their shell environment. No terminal multiplexing, no session restore, no automation API. Theo Browne (Ping) is the public face; design thesis is "wrap the official vendor CLIs, don't reinvent the agent."

## Strategic takeaway

wmux's defensible position, narrowed against the current field:

1. **The only MCP server in the terminal-multiplexer category.** Every other tool here is an MCP client at best. Combined with Code Mode (`wmux_eval`), wmux is the only tool that lets an external agent drive a script across the whole UI surface in one round-trip.
2. **The only local-first, real-time, multi-device pane/workspace share.** Warp's Shared Sessions are live but cloud-locked. Zed's DeltaDB is real-time but optimized for code state, not pane share. wmux's Tailscale-aware share is the only "ship your terminal to your phone over your own network, no broker" option in the list.
3. **The only Windows-first agent terminal.** Zed and Warp are on Windows but architected elsewhere first. The depth of wmux's Windows integration (ConPTY, WSL routing, WebView2, per-shell-flavor detection) is still unmatched.
4. **The only `tmux.exe` shim** for agent harnesses that drive tmux commands on Windows.

Real gaps to close, in priority order:

1. **First-party git worktree isolation per pane.** The previous version of this doc called this an intentional non-feature; that's no longer credible given universal adoption across Warp / Zed / mux / herdr / t3code. Cross-pane parallel-agent use is a real workflow and wmux makes the user do it manually.
2. **GPU-accelerated terminal renderer.** Warp going open-source removes the prior "proprietary" framing — Warp/cmux/Zed all ship native renderers and the perception gap widens every release. Ghostty/wgpu replacement is still the candidate.
3. **Multi-harness agent-lifecycle hooks.** wmux supports 1 harness (Claude Code) via hooks. cmux supports 14+ harnesses with richer event coverage (including `PermissionRequest`); herdr supports 14+ harnesses with a normalized 4-state machine. wmux is behind on both axes — per-harness adapter recipes that map each agent's lifecycle events into the existing `AgentHookState` shape would close this. cmux's open-source hook installer is a reference for what to wire up.
4. **Polish-tier UX investments** (command palette, structured output inspector, autosuggest). Lower priority — these are obvious "we're not Warp" gaps, not features that win specific users.

Everything else in the matrix (in-pane browser, MCP surface depth, OSC notifications, multi-shell support, workbook/charts, automation API breadth) is already competitive or ahead of field.
