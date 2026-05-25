# wmux competitive landscape

Maintainer-facing comparison of wmux against the closest tools in the agent-terminal and AI-coding-workspace category. Snapshot date: **2026-05-25**.

> **Methodology note.** wmux state is verified against the current repo (HEAD on `main`, recent merged PRs through #52). Other tools are described from publicly available info at the snapshot date; where the maintainer has not personally verified recent changes for a given competitor, the entry says so.

## Tools covered

| Tool | Category | Platform | License |
|---|---|---|---|
| **wmux** | Agent-aware terminal multiplexer | Windows-native (WSL/SSH-aware) | MIT |
| **Warp** | Agent-first terminal | macOS, Linux, Windows | Closed; freemium + subscription |
| **cmux** | macOS agent terminal (libghostty) | macOS only | AGPL |
| **zed** | GPU-accelerated code editor + agent panel | macOS, Linux (Windows: preview) | GPL |
| **herdr** | TUI agent runtime/multiplexer | Linux/macOS (POSIX) | Open source |
| **mux** (coder) | Isolated parallel-agent desktop | macOS, Windows | Open source |
| **t3code** | GUI front-end for CLI agents | Mac/Win/Linux | Open source |

## Feature matrix

| Dimension | wmux | Warp | cmux | zed | herdr | mux | t3code |
|---|---|---|---|---|---|---|---|
| Windows-native | ✅ first-class | ✅ GA | ❌ | preview | ❌ | ✅ Electron | ✅ Electron |
| Multi-agent sidebar | ✅ + cross-workspace rollup | ✅ Agent threads | ✅ | ✅ Threads | ✅ TUI | ✅ | ✅ |
| Authoritative agent state (lifecycle events) | ✅ Claude Code hooks → "live" badge | partial (proprietary agent only) | ❌ screen-scrape | partial (ACP) | socket API | ❌ | ❌ |
| Screen-content state fallback for any TUI agent | ✅ shell-prompt + bottom-rows heuristic | ✅ (own agent only) | ✅ | n/a | ❌ | ❌ | ❌ |
| MCP server (callable by external agents) | ✅ HTTP `:7766/mcp` + named pipe | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Code Mode (server-side JS over MCP tools) | ✅ `wmux_eval` default surface | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| tmux compatibility shim | ✅ `tmux.exe` | ❌ | ❌ | ❌ | native tmux | ❌ | ❌ |
| Browser surface in pane | ✅ iframe + auto-fallback to in-pane CEF (CDP screencast) | ❌ | ✅ Chromium/Playwright (separate window) | ❌ | ❌ | ❌ | ❌ |
| Markdown surface in pane | ✅ | ✅ Notebooks | ❌ | ✅ in-editor | ❌ | ❌ | ✅ diff viewer |
| Activity log (tool calls w/ I/O) | ✅ + per-pane agent timeline | ✅ Blocks history | ❌ | ✅ thread history | ❌ | partial | ✅ |
| Per-pane inline ask any agent CLI (one-shot) | ✅ Claude/Codex/Gemini/OpenCode/Aider | ✅ (own agent) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Multi-device live collab (real-time pane/workspace share) | ✅ Tailscale-aware, PWA viewer, read/write | ✅ Warp Drive sessions (cloud-mediated) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Customizable keybindings (JSON file, hot-reload) | ✅ | ✅ | partial | ✅ | ✅ | partial | ❌ |
| Git worktree isolation | ⚠️ delegated — relies on Claude Code's native `isolation: "worktree"` | ❌ | ❌ | ✅ per agent | ❌ | ✅ core feature | ✅ |
| Session restore | ✅ full layout graph + per-pane state | ✅ via Drive | ✅ | partial | ✅ detach/reattach | ✅ | ❌ |
| SSH / remote terminal | ✅ ConPTY + WSL + SSH spawn | ✅ Warp SSH | ❌ | ❌ | ✅ SSH attach | ✅ SSH mode | ❌ |
| Multi-shell support (bash/zsh/fish/PowerShell) | ✅ per-pane shell flavor detection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| GPU terminal renderer | xterm.js over WebView2 (Ghostty/wgpu on roadmap) | ✅ Rust/Metal-class native | libghostty ✅ | ✅ Rust/Metal | terminal host | Electron | Electron |
| Automation API | ✅ named pipe + HTTP + MCP | Warp Drive API (cloud) | Unix socket | ACP open spec | socket | VS Code ext | ❌ |
| OSC notification ring (9/99/777) | ✅ | partial | ✅ | ❌ | ❌ | ❌ | ❌ |
| Workbook/charts via MCP | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| PR review pane | ✅ inline Ask AI via any agent CLI | ❌ | ❌ | ✅ in-editor diff | ❌ | ❌ | ✅ |
| Open source | ✅ MIT | ❌ proprietary | ✅ AGPL | ✅ GPL | ✅ | ✅ | ✅ |
| Cloud / login required for full feature set | ❌ local-first | ✅ for AI/Drive/sessions | ❌ | ❌ | ❌ | ❌ | optional |

## Where wmux is ahead

### Multi-device real-time collab over Tailscale (PRs #37–#49)

The most distinctive recent shift. wmux runs an in-app HTTP/WebSocket server that surfaces a PWA viewer for any pane or whole workspace. Tailscale-aware URLs (uses the 100.x tailnet IP when available); read/write share with mutual confirmation on first device; viewer reconnect with per-share replay buffer; layout mirrored across multi-tab workspaces; mobile-viewport polish; agent timeline panel in the viewer. **Local-first**: no cloud, no broker, no account. Warp has multi-device sessions via Warp Drive but they are cloud-mediated and require login. cmux, zed, herdr, mux, t3code have no equivalent.

### MCP server + Code Mode + 20+ structured tools

wmux ships an MCP HTTP endpoint exposing: pane I/O (`pane_send_text`, `pane_send_keys`, `pane_read_screen`), structural (`list_workspaces`, `list_tabs`, `split_pane`, …), workspace orchestration, browser CDP tools (`browser_screenshot`, `browser_evaluate`, `browser_click`, …), agent-to-agent messaging (`ask_agent`, `broadcast`), and `get_blocks` for terminal history. The default MCP mode is **Code Mode** (`wmux_eval`, PR #30) — agents write a JS script that calls every other tool as a bound function, collapsing N round-trips into one call. No other tool in this list has an MCP server, let alone a JS-sandbox tool layer.

### Authoritative agent state via Claude Code hooks

cmux, herdr, and mux infer agent state by screen-scraping or idle timeouts. wmux receives Claude Code lifecycle events (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`, `UserPromptSubmit`) directly via an installable hooks adapter, persists them per-pane, and shows a "live" badge in the sidebar for hook-derived state. Panes running other CLIs (Codex, Gemini, Aider, OpenCode, Amp) gracefully fall back to the shell-prompt + bottom-rows heuristic.

### tmux.exe shim

Agent harnesses that drive tmux commands (Claude Code's own session management, many automation scripts) work on Windows without modification. wmux ships a `tmux.exe` binary that maps the practical agent-facing tmux subset onto the wmux automation API. No other tool in this list does this.

### Browser-in-pane with iframe → CEF auto-fallback (PR #32)

Headers like `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors` kill the cheap iframe path. wmux auto-detects header-blocked navigation and re-opens the page in an out-of-process CEF helper, embedded in the pane via CDP `Page.startScreencast` → JPEG → `<canvas>`. Input forwarding (mouse, wheel, keyboard) routed back over CDP. Helper HWND hidden via `WS_EX_LAYERED` + alpha=0. cmux has Chromium but in a separate window; nothing else in the list does in-pane.

### Per-pane inline ask any agent CLI (PR #52)

The PR-review panel can spawn any installed agent CLI in one-shot mode (`claude -p`, `codex exec`, `gemini -p`, `opencode run`, `aider --message`), pipe the diff context, and render the response inline. The user's own auth applies — no per-provider API-key plumbing in wmux. Warp's inline-ask is tied to their own agent.

### Windows-first, fully local

Still the widest moat. cmux is macOS-only by architecture. herdr requires POSIX. Warp's full feature set requires login and cloud (AI, Drive, sessions). wmux is the only agent-first terminal multiplexer built from the ground up for Windows, with explicit ConPTY, PowerShell, WSL, and WebView2 integration, and no cloud dependency.

## Where wmux lags

### Terminal renderer speed

Warp on its native renderer, cmux on libghostty/wgpu, and Zed on Rust/Metal are faster than xterm.js over WebView2. The Ghostty/wgpu renderer replacement is on the roadmap but not started.

### Editor integration

Zed's Agent Client Protocol lets Claude Code attach into the editor with file tree, git, and diff context as first-class structured surfaces. wmux is a terminal — the PR-review pane is the closest thing to a code-aware surface, and it is read-only diff inspection, not editing. Users who want an agent + editor combo in one window pick Zed.

### Cross-platform reach

t3code, mux, and Warp work on all three OSes. wmux is Windows-only — a deliberate architecture choice that limits mixed-OS teams. macOS users default to cmux or Warp; Linux users default to Warp or herdr.

### Polish budget vs. Warp

Warp has a paid team and years of UX investment. Object Inspector (structured parsing of command output), command palette, autosuggest, voice control, and the overall block-based UX are areas where wmux's xterm-over-WebView2 surface still feels like a terminal-multiplexer-with-extras rather than a reimagined terminal.

## Tool-by-tool notes

### Warp

The 800-pound gorilla of agent terminals. Strongest on terminal UX (blocks, autosuggest, command palette, Object Inspector), now GA on Linux and Windows. Agent Mode runs longer multi-step tasks; Warp Drive syncs workflows/notebooks/teams across devices; Shared Sessions enable multi-device collab — but everything beyond local typing requires login and is cloud-mediated. Closed source, freemium with a Pro subscription. **Where wmux beats Warp**: open source, no login, no cloud, MCP server, Code Mode, tmux shim, Claude Code hook integration, in-pane browser surface. **Where Warp beats wmux**: terminal renderer, polish, Object Inspector, cross-platform breadth, install base.

### cmux

The closest open-source analogue on macOS. libghostty renderer, AGPL, strong session resume, embedded Chromium for browser tasks. macOS-only by design — uses libghostty which doesn't port. Weak on Windows, WSL, remote tmux, MCP, and multi-device share. Maintainer has not personally verified recent cmux changes; entries here reflect last-checked state.

### zed

A code editor first, terminal multiplexer second. Agent Client Protocol (ACP) lets multiple agents attach to the editor with file tree, git, and diff context as structured surfaces. Per-agent git worktree isolation is shipped. The tradeoff is that it is an editor — users who live in a different editor get little from Zed. Windows still in preview.

### herdr

The most terminal-native option: runs inside an existing terminal rather than replacing it, so fonts, SSH setup, and keybindings carry over automatically. Detach/reattach semantics are strong. POSIX-only (no Windows), no browser surfaces, no MCP, no hook integration. Maintainer has not personally verified recent herdr changes.

### mux (coder)

Strongest on worktree-per-agent isolation and the Plan/Exec parallel-agent loop. Cross-platform (Mac/Windows) via Electron, so no renderer-performance advantage over wmux. No tmux shim, no MCP server, no OSC notification ring, no multi-device share. Maintainer has not personally verified recent mux changes.

### t3code

A GUI management layer on top of existing CLI agents, not a new runtime. Cross-platform, model-agnostic, has its own inline ask via one-shot CLIs (similar in spirit to wmux PR #52). Best suited for users who want a visual diff/chat interface without leaving their existing shell environment. No terminal multiplexing, no session restore, no automation API.

## Strategic takeaway

wmux's defensible position is: **the only open-source, local-first, agent-first terminal multiplexer for Windows, with the deepest agent-orchestration surface (MCP + Code Mode + tmux shim + Claude hooks + per-CLI one-shot ask) of any tool here, plus Tailscale-aware multi-device collab that even Warp can't match on local-first terms.**

The roadmap items most worth prioritizing to close remaining gaps:

1. **Ghostty/wgpu renderer** — closes the perception gap vs. Warp/cmux/Zed and is the only "wmux feels old" complaint not already addressed.
2. **PR review heatmap** + **Workspace templates** — small lifts that turn current surfaces into more obvious wins.
3. **Multi-CLI hook adapter** — extends the "live" agent-state badge beyond Claude Code (Codex, Gemini have no equivalent today; an adapter that normalizes lifecycle events from any harness would generalize the moat).

Two items that earlier versions of this doc flagged as "wmux lags" and are now intentionally not on the roadmap:

- **Git worktree creation/management.** Claude Code's `isolation: "worktree"` covers the within-session case (the high-frequency one). cmux and mux ship worktree-per-agent for parallel top-level agents; wmux delegates to Claude Code rather than duplicating ecosystem solutions. Reconsider only if specific demand surfaces.
- **Per-pane environment isolation.** Every scenario is solved by existing tooling (direnv, `AWS_PROFILE=foo` invocations, virtualenvs). Adding another env layer duplicates ecosystem solutions for a feature looking for a problem.

Everything else (browser integration, MCP surface, collab, Claude Code integration, automation API, tmux shim) is already competitive or ahead of field.
