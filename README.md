# wmux

**Agent-aware terminal multiplexer for Windows.** ConPTY-native, with built-in support for parallel AI coding agents, an MCP server other agents can drive, and local-first multi-device session share over Tailscale.

> Started as a Windows port of [cmux](https://github.com/manaflow-ai/cmux); has since diverged in scope. See [`docs/competitive-landscape.md`](docs/competitive-landscape.md) for an honest comparison against cmux, Warp, Zed, mux, herdr, and t3code.

## Why wmux

- **MCP server + Code Mode.** wmux exposes an HTTP MCP endpoint at `:7766/mcp` that external agents (Claude Code, anything MCP-speaking) can drive. The default mode is **Code Mode** (`wmux_eval`): the agent writes a JavaScript script in a sandbox where every wmux tool — pane I/O, workspace/tab/pane structural ops, browser CDP, workbook charts — is a bound function. N tool-call round-trips collapse to one. No other terminal multiplexer in this space ships an MCP server, let alone a JS-sandbox tool layer.
- **Local-first multi-device collab.** Share any pane or whole workspace to a phone, tablet, or other laptop via a PWA viewer over your tailnet. Layout mirrored, live, read-only or read-write, reconnect with replay buffer. No broker, no cloud, no account.
- **Multi-agent first.** Per-pane agent picker covers Claude Code, Codex, Gemini, OpenCode, Aider, Amp. Sidebar shows live state across panes; cross-workspace blocked-agent rollup; Claude Code lifecycle hooks for authoritative state on Claude panes; shell-prompt + bottom-rows heuristic for everything else. PR-review panel can ask any installed agent CLI one-shot (no API keys in wmux) and render the response inline.
- **Windows-first, deeply.** ConPTY for local Windows shells, full WSL routing (per-distro shell flavor detection — bash/zsh/fish), SSH spawn with reverse-tunneled API. WebView2 + xterm.js renderer. Built-in `tmux.exe` shim so Claude Code's own session management and other tmux-driven harnesses work without modification on Windows.
- **Browser in a pane.** iframe by default; auto-falls-back to an out-of-process Chromium (CEF) helper when `X-Frame-Options` blocks the iframe path. Helper renders into the pane via CDP screencast; input forwarded back over CDP.
- **Workspaces + split layouts that survive restarts.** Multi-tab, multi-pane, mixed terminal / browser / markdown surfaces. Full layout graph (with browser URLs, scrollback, pinned tabs) restored on launch.

## Install

Pre-built MSI installers ship via GitHub Releases:

```
https://github.com/dcieslak19973/wmux/releases/latest
```

Or build from source — see [Building from source](#building-from-source) below.

## Quick start

After installing:

1. **Launch a shell.** New tab via `Ctrl+Shift+T`. Pick local PowerShell, WSL (with distro), or SSH.
2. **(Optional) Install shell integration.** Click the ⚡ button in a pane's toolbar to install OSC 133 shell integration. Wmux uses it for command-block capture, `get_blocks` MCP queries, and the activity log.
3. **(Optional) Wire up Claude Code as an MCP client.** Click the `MCP` button in a pane to copy the `claude mcp add --transport http wmux …` command. Paste it once in Claude Code; Claude can now call wmux tools (workbook, structural pane control, agent-to-agent messaging, etc.) from any conversation.
4. **(Optional) Install Claude Code lifecycle hooks.** Click `HK` in the toolbar. Wmux gets authoritative agent state (`PreToolUse` / `PostToolUse` / `Stop` / `Notification` / `UserPromptSubmit`) and surfaces a "live" badge in the agent sidebar.
5. **(Optional) Share a pane.** From a pane's `SH` menu, share to your tailnet — the PWA viewer URL works on any device on your Tailscale network. Mutual-confirm on the first device; reconnect with replay if the viewer drops.

## Key features

### Multi-agent orchestration

- **Per-pane agent picker** — Claude / Codex / Gemini / OpenCode / Aider / Amp. Each pane remembers its preferred agent for fix-command dispatch.
- **Agent sidebar** (`Ctrl+Shift+A`) — every running agent pane with CWD, state (working / blocked / ready / idle), last output. Cross-workspace blocked-agent rollup badge on the toolbar.
- **Activity log** (`Ctrl+Shift+L`) — running history of agent tool calls + I/O across all panes.
- **Authoritative state for Claude Code** — install hooks once, get sub-second state transitions.
- **Multi-CLI inline Ask AI** in the PR review pane — `claude -p`, `codex exec`, `gemini -p`, `opencode run`, `aider --message`. The agent's own auth applies.

### Surfaces beyond terminals

- **Browser panes** — iframe-first with automatic Chromium (CEF) fallback when iframe is blocked. Restored URL history, back/forward, devtools.
- **Markdown panes** — file-backed or inline, syntax highlighting.
- **Workbook surface** — MCP-driven rows + multi-chart workbook. Agents can call `workbook_create`, `workbook_add_chart`, `workbook_update_chart` and render a live preview. See [`docs/mcp-workbook-app.md`](docs/mcp-workbook-app.md).
- **PR review pane** — file-by-file diff with inline Ask AI against any installed agent CLI.

### Automation surfaces

- **MCP server** at `http://localhost:7766/mcp` (or via `$WMUX_API_BASE` for WSL/SSH panes). Default mode exposes `wmux_eval` (Code Mode) + workbook tools; `WMUX_MCP_MODE=full` exposes every underlying tool individually.
- **`tmux.exe` shim** in PATH — practical agent-facing tmux subset (`new-session`, `split-window`, `send-keys`, `list-panes`, `capture-pane`, …) mapped onto the wmux automation API. See [`docs/tmux-shim-compat.md`](docs/tmux-shim-compat.md).
- **Named pipe** at `\\.\pipe\wmux-ipc` — local JSON-RPC for PowerShell scripts.
- **HTTP API** at `:7766` — `/info`, `/sessions`, `/blocks`, plus the `/mcp` endpoint.

### Collab / share

- **Per-pane and per-workspace share** via in-app HTTP/WebSocket server.
- **Tailscale-aware** — share URLs use your tailnet's 100.x IP when available; falls back to your LAN address otherwise.
- **PWA viewer** — open on phone, tablet, or any browser. Read-only or read-write. Mobile-viewport-friendly.
- **Mutual confirm** on the first device to connect; reconnect with per-share replay buffer.
- **Multi-tab workspace share** — layout mirrors in the viewer with drag-to-resize splits and agent timeline panel.

### Quality-of-life

- **Customizable keybindings** — JSON config in app data dir, settings-panel UI with click-to-rebind, conflict toasts, hot-reload. ~25 commands rebindable by stable ID.
- **Multi-shell** — bash, zsh, fish, PowerShell. Per-pane shell-flavor detection so agent quoting (e.g. fix-agent commands) uses the right escape rules per shell.
- **Workspaces** — named, pinned, reorderable; per-workspace active tab restore.
- **Notifications** — OSC 9 / 99 / 777 captured into a per-tab notification ring with badge counts.
- **Session restore** — full layout graph + per-pane state across launches, with debounced save on change and visibility/close fallback.
- **Updater** — in-app auto-check + manual `Check now` against GitHub Releases.

## Default keybindings

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+T` | New terminal tab |
| `Ctrl+Shift+W` | Close active tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+Shift+A` | Toggle agent sidebar |
| `Ctrl+Shift+L` | Toggle activity log |

All bindings customizable in Settings → Keybindings (or by editing the JSON file directly).

## Configuration files

- **Keybindings** — `%APPDATA%\com.wmux.app\keybindings.json` (open via Settings → Reveal in Explorer).
- **Layout state** — `%APPDATA%\com.wmux.app\workspace-state-*.json` (auto-saved).
- **Session vault** — `%APPDATA%\com.wmux.app\session-vault\` (saved SSH targets).

## Building from source

### Prerequisites

> Steps below use **winget** (pre-installed on Windows 11 / updated Windows 10).

```powershell
# 1. MSVC C++ build tools
winget install --id Microsoft.VisualStudio.2022.BuildTools --silent `
  --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

# 2. Rust toolchain
winget install --id Rustlang.Rustup --silent

# 3. Node.js LTS
winget install --id OpenJS.NodeJS.LTS --silent

# 4. Allow PowerShell scripts (needed for npm)
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force

# 5. Reload PATH in your current shell
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("PATH","User")

# 6. Tauri CLI
cargo install tauri-cli --version "^2" --locked

# 7. CMake + Ninja (required only to build the out-of-process CEF browser helper).
#    These have no winget user-scope install path, so we use scoop —
#    it runs in user mode without admin elevation.
Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
scoop install cmake ninja
```

> CMake + Ninja are needed by `cef-rs` (the Tauri-team CEF binding) when building the `browser-helper` workspace member. If you're only working on the Tauri frontend / `src-tauri` crate, you can skip step 7 — but then `cargo build` at the workspace root will fail on the helper crate. Build just the main app with `cargo build --package wmux` (or `npm run tauri dev`) to skip the helper.

### Development

```powershell
# Install frontend dependencies (first run only)
npm install

# Start dev mode (hot-reload WebView + Rust watch)
cargo tauri dev
```

> On first run Cargo downloads ~200 crates — subsequent builds are incremental.

### Release build

```powershell
npm run build          # bundle frontend → dist/
cargo tauri build      # compile Rust, sign, produce MSI
# Output: target/release/bundle/msi/wmux_*.msi
```

### Git hooks

This repo ships `pre-commit` and `pre-push` hooks under `.githooks/`.

`pre-commit` blocks direct commits to `main`/`master` and runs `cargo clippy --manifest-path src-tauri/Cargo.toml -p wmux -- -D warnings` when staged Rust or Cargo files under `src-tauri/` change. `pre-push` blocks direct pushes to `main`/`master`.

To enable for this clone:

```powershell
git config core.hooksPath .githooks
```

The guard is local-only — for server-side enforcement enable GitHub branch protection on `main`.

For a one-off bypass, prefer a per-command Git config flag:

```powershell
git -c wmux.allowMainCommit=true commit -m "..."
git -c wmux.allowMainCommit=true push origin HEAD
```

`ALLOW_MAIN_COMMIT=1` is also accepted by the hooks.

### Auto-updater

The Tauri v2 updater is wired in: updater plugin registration, artifact generation during release builds, built-in defaults for the wmux GitHub Releases endpoint, in-app update prompt, and Settings-panel actions for manual check and install.

Operationally before releasing:

1. Generate a signing keypair: `npm run tauri signer generate -- -w ~/.tauri/wmux.key`.
2. Save the public key somewhere durable (wmux needs that exact value to verify updates).
3. Add the private key content to the GitHub repo secret `TAURI_SIGNING_PRIVATE_KEY`. If password-protected, also add `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
4. Push a semver tag (e.g. `v0.0.7`); `.github/workflows/release.yml` builds, signs, and uploads the MSI, `.sig`, and `latest.json` to the GitHub release.
5. The stable updater endpoint is `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`.

Notes: signature verification is mandatory (no unsigned production mode). The release workflow fails fast if `TAURI_SIGNING_PRIVATE_KEY` is missing. On Windows the app exits when the installer takes over.

## Project layout

```
wmux/
├── src-tauri/              # Rust app: ConPTY, session manager, IPC, MCP, HTTP server
│   └── src/
│       ├── main.rs         # binary entry point
│       ├── lib.rs          # Tauri app setup & command registration
│       ├── commands.rs     # Tauri IPC handlers
│       ├── conpty.rs       # Windows ConPTY pseudoterminal wrapper
│       ├── session_manager.rs
│       ├── http_server.rs  # MCP + agent-facing HTTP API
│       ├── code_mode.rs    # wmux_eval boa_engine sandbox
│       ├── collab_server.rs# multi-device share server
│       ├── ipc_server.rs   # named-pipe automation server
│       ├── osc_parser.rs   # OSC 9 / 99 / 133 / 777 parsing
│       └── bin/tmux.rs     # tmux.exe compatibility shim
├── browser-helper/         # out-of-process CEF helper crate (in-pane Chromium)
├── collab-proto/           # share-protocol crate (HTTP/WS messages)
├── viewer-pwa/             # PWA viewer for shared panes/workspaces
├── src/                    # JS frontend (Vite + xterm.js)
│   ├── main.js
│   ├── automation_bridge.mjs
│   ├── agent_sidebar_runtime.mjs
│   ├── activity_log_runtime.mjs
│   ├── pr_review_runtime.mjs
│   ├── collab_runtime.mjs
│   ├── layout_runtime.mjs
│   └── surfaces_runtime.mjs
└── docs/                   # competitive landscape, ADRs, internal docs
```

## Architecture notes

- **ConPTY session lifecycle**: `create_session` → spawn shell via `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` → background thread reads output pipe → broadcast via `tokio::broadcast` → Tauri emits `terminal-output-{id}` to WebView.
- **Workspace model**: Frontend keeps workspace/tab/pane/browser/markdown state in memory; serialized to JSON with debounced save-on-change + visibility/close fallback for restore.
- **Remote tmux**: One wmux tab = one remote tmux session. SSH form has optional tmux fields; reconnects to that session on restore. Use tmux itself for remote terminal splits inside that session.
- **Notifications**: OSC 9/99/777 parsed into per-tab notifications, unread counts, sidebar ring state.
- **Browser surfaces**: Tauri commands position sibling WebView2 windows so they behave like split panes. Header-blocked navigation auto-fallback to out-of-process CEF helper, embedded via CDP screencast.
- **Resize**: `ResizeObserver` on each terminal pane calls `fitAddon.fit()` then `resize_session` → `ResizePseudoConsole`.
- **Automation surface**: Frontend exposes `window.wmux`; backend bridges named-pipe + HTTP + MCP. `tmux.exe` maps the agent-facing tmux subset onto the same API.
- **Collab**: In-app HTTP/WS server (port from `wmux-proto` crate). Tailscale-aware share URL construction. Per-share replay buffer for reconnect. Layout mirroring uses the same workspace graph as local restore.

## Roadmap

See [`roadmap.md`](roadmap.md) for the prioritized gap list with competitive context. Top items:

- [ ] **Process / agent persistence** — true detach/reattach so closing the window doesn't kill running jobs; agent-conversation resume for hooked harnesses.
- [ ] **Frontend test coverage** — 0 frontend tests today; need regression coverage for session restore, collab reconnect, and agent-state transitions.
- [ ] **Multi-harness lifecycle hooks** — Claude + Codex are hooked; Gemini / OpenCode / Aider / Amp still fall back to screen-scraping.
- [x] ~~First-party git worktree isolation per pane~~ — shipped 2026-05-25.
- [ ] GPU terminal renderer — replace xterm.js with a wgpu-backed renderer.
- [ ] Widen `tmux.exe` compatibility for additional harness-driven edge cases.

## License

[AGPL-3.0](LICENSE). The `collab-proto` and `wmux-proto` library subcrates are MIT-OR-Apache-2.0 to ease reuse.

## Contributing

Issues + PRs welcome. See [`docs/competitive-landscape.md`](docs/competitive-landscape.md) for the strategic context behind feature priorities, and [`docs/adr/`](docs/adr/) for architecture decisions.

For help or feedback, file at [github.com/dcieslak19973/wmux/issues](https://github.com/dcieslak19973/wmux/issues).
