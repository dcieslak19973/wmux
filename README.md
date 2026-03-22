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
│   │   ├── conpty.rs         # Windows ConPTY pseudoterminal wrapper
│   │   ├── session_manager.rs# owns the Map<id, ConPtySession>
│   │   └── commands.rs       # Tauri IPC handlers (create/close/write/resize)
│   ├── icons/                # app icons (auto-generated placeholders)
│   ├── Cargo.toml
│   ├── build.rs
│   └── tauri.conf.json
├── src/
│   ├── main.js               # xterm.js wiring, tab management
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

## Architecture notes

- **ConPTY session lifecycle**: `create_session` → spawns shell via `CreateProcessW` with `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` → background thread reads output pipe → broadcasts via `tokio::broadcast` → Tauri emits `terminal-output-{id}` events to WebView.
- **Notification rings**: When a non-active tab receives output, a yellow dot appears on the sidebar entry; it clears on activation.
- **Resize**: A `ResizeObserver` on each terminal pane calls `fitAddon.fit()` then `resize_session` Tauri command → `ResizePseudoConsole`.

## Roadmap

- [ ] In-app browser panel (WebView2 second pane)
- [ ] Pattern-based notification ring (`agent done`, `error:`, etc.)
- [ ] Named-pipe scripting API compatible with cmux protocol
- [ ] Git branch/status in tab title (via `git` subprocess)
- [ ] Session persistence (serialize layout to JSON on exit, restore on launch)
- [ ] Replace xterm.js renderer with Ghostty/wgpu terminal for GPU acceleration
