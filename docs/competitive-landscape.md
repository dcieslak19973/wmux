# wmux competitive landscape

Maintainer-facing comparison of wmux against the five closest tools in the agent-terminal and AI-coding-workspace category as of May 2026.

## Tools covered

| Tool | Category | Platform |
|---|---|---|
| **wmux** | Agent-aware terminal multiplexer | Windows-native |
| **cmux** | macOS agent terminal (libghostty) | macOS only |
| **zed** | GPU-accelerated code editor | macOS, Linux (Windows: preview) |
| **herdr** | TUI agent runtime/multiplexer | Linux/macOS (POSIX) |
| **mux** (coder) | Isolated parallel-agent desktop | macOS, Windows |
| **t3code** | GUI front-end for CLI agents | Mac/Win/Linux |

## Feature matrix

| Dimension | wmux | cmux | zed | herdr | mux | t3code |
|---|---|---|---|---|---|---|
| Windows-native | ✅ first-class | ❌ | partial | ❌ | ✅ Electron | ✅ Electron |
| Multi-agent sidebar | ✅ | ✅ | ✅ Threads | ✅ TUI | ✅ | ✅ |
| Authoritative agent state (hooks) | ✅ Claude Code lifecycle hooks | ❌ screen-scrape | ❌ | socket API | ❌ | ❌ |
| tmux compatibility shim | ✅ tmux.exe | ❌ | ❌ | native tmux | ❌ | ❌ |
| MCP server | ✅ HTTP :7766/mcp | ❌ | ❌ | ❌ | ❌ | ❌ |
| Browser surface in pane | ✅ WebView2 split | ✅ Chromium/Playwright | ❌ | ❌ | ❌ | ❌ |
| Markdown surface in pane | ✅ | ❌ | ✅ in-editor | ❌ | ❌ | ✅ diff viewer |
| Activity log (tool calls w/ I/O) | ✅ | ❌ | ✅ thread history | ❌ | partial | ✅ |
| Git worktree isolation | ❌ (roadmap) | ❌ | ✅ per agent | ❌ | ✅ core feature | ✅ |
| Session restore | ✅ full layout graph | ✅ | partial | ✅ detach/reattach | ✅ | ❌ |
| SSH / remote tmux | ✅ | ❌ | ❌ | ✅ SSH attach | ✅ SSH mode | ❌ |
| GPU terminal renderer | xterm.js (wgpu roadmap) | libghostty ✅ | ✅ Rust/Metal | terminal host | Electron | Electron |
| Automation API | ✅ named pipe + HTTP | Unix socket | ACP open spec | socket | VS Code ext | ❌ |
| OSC notification ring | ✅ OSC 9/99/777 | ✅ | ❌ | ❌ | ❌ | ❌ |
| Workbook/charts via MCP | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Open source | ✅ | ✅ AGPL | ✅ GPL | ✅ | ✅ | ✅ |

## Where wmux is ahead

### Authoritative agent state via hooks

cmux, herdr, and mux detect agent state by screen-scraping or idle timeouts. wmux receives Claude Code lifecycle events (`PreToolUse`, `PostToolUse`, `Stop`, `Notification`) directly and stores them in `hookStates` in the agent sidebar. The "live" badge in the sidebar is real event data, not a heuristic. Agents running other CLIs (Codex, Gemini, Aider, Amp, OpenCode) fall back gracefully to screen-scraping, but Claude Code panes get sub-second authoritative state.

### tmux.exe shim

Agent harnesses that drive tmux commands (Claude Code, many automation scripts) work on Windows without modification. wmux ships a `tmux.exe` binary in PATH that maps the practical agent-facing tmux subset onto the wmux automation API. No other tool in this list does this.

### MCP server

The HTTP endpoint at `:7766/mcp` exposes workbook tools, pane control, and workspace automation as MCP resources. External agents can call `workbook_create`, `workbook_add_chart`, and related tools against a live wmux session. No competitor has an MCP server built into the terminal.

### Browser + terminal + markdown in one tab

cmux has an embedded Chromium, but it is a separate window. wmux's split-pane layout puts WebView2 browser panes, xterm terminal panes, and markdown panes in the same resizable split tree with shared workspace persistence.

### Windows

This is the widest gap. cmux (the closest analogue) is macOS-only by architecture. herdr requires POSIX. wmux is the only agent-first terminal multiplexer built from the ground up for Windows, with explicit ConPTY, PowerShell, WSL, and WebView2 integration.

## Where wmux lags

### Git worktree isolation (roadmap)

mux (coder) and zed give each agent its own git worktree so parallel agents can work on separate branches without interfering with each other's working tree. This is on the wmux roadmap but not implemented. Until it is, running multiple agents that write files requires manual branch discipline from the user.

### Terminal renderer speed

cmux on libghostty/wgpu and zed on Rust/Metal are faster than xterm.js over WebView2. The Ghostty/wgpu renderer replacement is on the wmux roadmap.

### Editor integration

Zed's Agent Client Protocol lets Claude Code attach into the editor with file tree, git, and diff context. wmux is a terminal — it does not have an editor surface or structural code context for agents.

### Cross-platform

t3code and mux work on all three OSes. wmux is Windows-only, which is a deliberate architecture choice but limits mixed-OS teams.

## Tool-by-tool notes

### cmux

The closest analogue. macOS-only by design (libghostty). Strong on product polish, community momentum, and native agent session resume. Weak on Windows, WSL, remote tmux, and tmux-shaped agent harness compat. See `docs/cmux-comparison.md` for a deeper breakdown.

### zed

A code editor first, terminal multiplexer second. Its parallel agent story (multiple agents per worktree, Agent Client Protocol) is architecturally ahead of every terminal-only tool here. The tradeoff is that it is an editor — users who live in a different editor get nothing from Zed. Windows is still in preview.

### herdr

The most terminal-native option: runs inside an existing terminal rather than replacing it, so fonts, SSH setup, and keybindings carry over automatically. Detach/reattach semantics are strong. Weakest on Windows (POSIX-only), browser surfaces, and agent hook integration.

### mux (coder)

Strongest on worktree isolation and remote/SSH execution. The Plan/Exec loop and isolated workspaces are well-thought-out for parallel agent work. Electron-based desktop, so no rendering performance advantage over wmux. No tmux shim. No OSC notification ring.

### t3code

A GUI management layer on top of existing CLI agents, not a new runtime. Cross-platform and model-agnostic. Best suited for users who want a visual diff/chat interface without leaving their existing shell environment. No terminal multiplexing, session restore, or automation API.

## Strategic takeaway

wmux's defensible position is: **the only agent-first terminal multiplexer for Windows**, with the deepest Claude Code integration (hooks, MCP, tmux shim) of any tool here.

The two investments most worth prioritizing to close the gap with the field:

1. **Git worktree isolation** — the single most-cited capability wmux lacks vs. mux and zed; enables true parallel agent workflows without branch collision.
2. **Ghostty/wgpu renderer** — closes the performance perception gap vs. cmux and zed.

Everything else (browser integration, workspace persistence, notification ring, automation API) is already competitive or ahead of field.
