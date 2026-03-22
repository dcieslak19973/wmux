# wmux — Windows port of cmux

GPU-accelerated terminal multiplexer for Windows, built on Tauri v2 + ConPTY.

## Stack

| Layer | Choice |
|---|---|
| App shell | Tauri v2 (WebView2) |
| Core logic | Rust |
| PTY / shell | Windows ConPTY API |
| Terminal renderer | xterm.js v5 (FitAddon, WebLinksAddon) |
| Frontend build | Vite 6 |
| Packaging | WiX via `cargo tauri build` |

## Prerequisites (one-time setup)

> The steps below use **winget** (pre-installed on Windows 11 / updated Windows 10).

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
```

## Development

```powershell
# Install frontend dependencies (first run only)
npm install

# Start dev mode (hot-reload WebView + Rust watch)
cargo tauri dev
```

> On first run Cargo downloads ~200 crates — subsequent builds are incremental.

## Git hooks

This repo ships `pre-commit` and `pre-push` hooks.

`pre-commit` blocks direct commits to `main` and `master`, and it also runs `cargo clippy --manifest-path src-tauri/Cargo.toml -p wmux -- -D warnings` when staged Rust or Cargo files under `src-tauri/` change.

`pre-push` blocks direct pushes to `main` and `master`.

To enable the checked-in hooks for this clone:

```powershell
git config core.hooksPath .githooks
```

The guard is local to your clone, so if you want server-side enforcement too, enable GitHub branch protection on `main`.

For a true one-off bypass, prefer a per-command Git config flag:

```powershell
git -c wmux.allowMainCommit=true commit -m "..."
git -c wmux.allowMainCommit=true push origin HEAD
```

The `ALLOW_MAIN_COMMIT=1` environment-variable bypass is still accepted by the hooks if you prefer it.

For example:

```powershell
$env:ALLOW_MAIN_COMMIT = "1"
git commit -m "..."
Remove-Item Env:ALLOW_MAIN_COMMIT
```

## Release build

```powershell
npm run build          # bundle frontend → dist/
cargo tauri build      # compile Rust, sign, produce MSI
# Output: target/release/bundle/msi/wmux_*.msi
```

## Project layout

```
wmux/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs           # binary entry point
│   │   ├── lib.rs            # Tauri app setup & command registration
│   │   ├── control_bridge.rs # frontend control request bridge
│   │   ├── conpty.rs         # Windows ConPTY pseudoterminal wrapper
│   │   ├── session_manager.rs# owns the Map<id, ConPtySession>
│   │   ├── ipc_server.rs     # named-pipe automation server
│   │   ├── osc_parser.rs     # OSC 9 / 99 / 777 notification parsing
│   │   ├── url_detector.rs   # localhost / URL metadata detection
│   │   ├── commands.rs       # Tauri IPC handlers (create/close/write/resize)
│   │   └── bin/tmux.rs       # tmux.exe compatibility shim
│   ├── icons/                # app icons (auto-generated placeholders)
│   ├── Cargo.toml
│   ├── build.rs
│   └── tauri.conf.json
├── src/
│   ├── main.js               # app orchestration and layout persistence
│   ├── automation_bridge.mjs # browser/workspace/tab/pane automation API
│   ├── layout_runtime.mjs    # layout restore + split tree runtime
│   ├── pane_aux_runtime.mjs  # pane focus/zoom helpers
│   ├── surfaces_runtime.mjs  # browser + markdown surfaces
│   ├── ui_panels_runtime.mjs # settings and side panels
│   ├── workspace_state.mjs   # workspace state model
│   └── style.css             # split-pane UI styles
├── index.html
├── vite.config.js
├── package.json
└── Cargo.toml                # workspace root
```

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+T` | New terminal tab |
| `Ctrl+Shift+W` | Close active tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |

## Current features

- Local PowerShell or cmd tabs, WSL tabs, and SSH tabs from the same launcher.
- Remote tmux tabs that SSH to a host and, from the same SSH connection form, optionally attach to or create a named tmux session.
- Multiple named workspaces with pinning, rename, move-tab-between-workspaces, and per-workspace active tab restore.
- Split-pane layouts with terminal, browser, and markdown surfaces in the same tab.
- Browser panes backed by separate WebView2 windows, including restored URL history and back/forward state.
- Markdown panes that can load files or inline content with syntax highlighting.
- Notification ring and notification panel fed by OSC 9, OSC 99, and OSC 777 messages.
- Sidebar metadata for cwd, git branch, detected localhost ports, unread notification counts, and latest notification text.
- HTML artifact preview support for generated files.
- Change-driven layout persistence across launches, with debounced saves plus hide/close fallback for workspaces, tabs, split trees, pinned state, active selections, zoom state, and browser history.
- Named-pipe automation server for sessions, workspaces, tabs/windows, panes, browser panes, notifications, and layout export.
- `tmux.exe` compatibility shim that covers the practical command/query subset agent harnesses expect for session creation, pane control, listing, capture, focus changes, and metadata queries. Detailed shim command and flag tracking lives in `docs/tmux-shim-compat.md`.
- Child shells inherit honest terminal capability vars plus minimal tmux-presence env (`TMUX`, `TMUX_PANE`) and wmux-native identifiers (`WMUX`, `WMUX_PANE_ID`) so agent CLIs can detect multiplexer context without spoofing the terminal itself.

## Architecture notes

- **ConPTY session lifecycle**: `create_session` → spawns shell via `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` → background thread reads output pipe → broadcasts via `tokio::broadcast` → Tauri emits `terminal-output-{id}` events to WebView.
- **Workspace model**: The frontend keeps workspace, tab, pane, browser, and markdown state in memory and serializes that graph to JSON with debounced save-on-change plus visibility/close fallback for restore on the next launch.
- **Remote tmux model**: The new-connection popover uses one SSH form with optional tmux fields (`Use tmux`, `Session mode`, `Session name`). A remote tmux tab stores SSH destination plus tmux session intent and reconnects to that session on restore; wmux does not mirror remote tmux pane topology into native wmux terminal splits yet.
- **Notifications**: OSC 9, 99, and 777 payloads are parsed into per-tab notifications, unread counts, and sidebar ring state.
- **Embedded browser surfaces**: Browser panes are coordinated through Tauri commands that create and position sibling WebView2 windows so they behave like split panes inside the main layout.
- **Resize**: A `ResizeObserver` on each terminal pane calls `fitAddon.fit()` then `resize_session` Tauri command → `ResizePseudoConsole`.
- **Automation surface**: The frontend exposes a `window.wmux` control API, the backend bridges those requests over a named pipe at `\\.\pipe\wmux-ipc`, and the `tmux.exe` shim maps a practical agent-oriented tmux subset onto that API.

For remote tmux specifically, the current contract is one wmux terminal tab equals one remote tmux session. Use tmux itself for remote terminal splits/windows inside that session; wmux browser and markdown splits can still sit alongside the remote terminal surface.

## Roadmap

- [ ] Widen `tmux.exe` compatibility for additional harness-driven tmux behaviors and edge cases.
- [ ] Add agent-grade browser automation primitives beyond open/navigate/close and manual browser panes.
- [ ] Enrich sidebar metadata with PR/review state, explicit service status, and stronger port attribution.
- [ ] Add layout import and other state mutation APIs for full external workspace provisioning.
- [ ] Continue improving restore fidelity for more transient UI state and cross-window coordination.
- [ ] Replace xterm.js renderer with Ghostty/wgpu terminal for GPU acceleration
