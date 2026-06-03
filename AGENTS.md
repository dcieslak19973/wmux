You are an experienced, pragmatic software engineering AI agent. Do not over-engineer a solution when a simple one is possible. Keep edits minimal. If you want an exception to ANY rule, you MUST stop and get permission first.

# AGENTS.md — wmux contributor guide

## Project Overview

**wmux** is an agent-aware terminal multiplexer for Windows. It is a Tauri v2 desktop application (WebView2 + xterm.js frontend, Rust backend) built around ConPTY for native Windows terminal hosting. Its headline differentiators:

- **MCP server** at `http://localhost:7766/mcp` — exposes a JS-sandbox tool layer (`wmux_eval` / Code Mode) that lets external agents (Claude Code, any MCP client) drive the entire UI in a single round-trip.
- **Multi-agent first** — per-pane agent picker, live agent sidebar, cross-workspace blocked-agent rollup, Claude Code lifecycle hook integration.
- **Local-first collab** — share panes/workspaces over Tailscale as a PWA (no cloud broker).
- **tmux.exe shim** — practical tmux subset mapped onto the wmux automation API so agent harnesses that assume tmux work unmodified on Windows.

### Technology stack

| Layer | Technology |
|---|---|
| Desktop shell | Tauri v2 (Rust + WebView2) |
| Frontend | Vanilla ES modules (`.mjs`), xterm.js, Vite |
| Backend | Rust (Cargo workspace: `src-tauri`, `browser-helper`, `collab-proto`) |
| Terminal | ConPTY (Windows-native) |
| IPC | Named pipe `\.\pipe\wmux-ipc` + HTTP `:7766` |
| Collab transport | Tailscale (Tauri plugin) |
| Build | `npm run tauri build` (wraps `cargo build` + Vite) |
| Tests | Node built-in test runner (`node --test`) for frontend; `cargo test` for Rust |

---

## Reference

### Important directories

```
src/                    Frontend ES modules (runtime, state machines, UI panels)
src-tauri/src/          Rust backend (commands, ConPTY, MCP/HTTP server, session manager)
src-tauri/src/bin/      Standalone binaries (tmux.exe shim)
browser-helper/         Out-of-process CEF helper for browser panes
collab-proto/           Shared Protobuf types for collab/share feature
test/                   Frontend unit tests (Node test runner, *.test.mjs)
docs/adr/               Architecture Decision Records
docs/agents/            Agent-specific metadata (issue tracker, triage labels, domain docs)
.githooks/              pre-commit (Clippy) and pre-push (block direct pushes to main)
.github/workflows/      CI: ci.yml (check + clippy + tests), release.yml
```

### Key source files

| File | Purpose |
|---|---|
| `src/main.js` | Frontend entry point |
| `src/layout_state.mjs` | Core layout state machine (panes, tabs, workspaces) |
| `src/agent_state.mjs` | Per-pane agent state tracking |
| `src/pane_init.mjs` | Pane construction and initialisation |
| `src/worktree_state.mjs` | Git worktree menu / navigation |
| `src-tauri/src/lib.rs` | Tauri app setup, plugin registration |
| `src-tauri/src/commands.rs` | Tauri IPC commands (called from frontend via `invoke`) |
| `src-tauri/src/session_manager.rs` | Session persist/restore |
| `src-tauri/src/http_server.rs` | HTTP API + MCP endpoint |
| `src-tauri/src/conpty.rs` | ConPTY terminal process management |
| `src-tauri/src/control_bridge.rs` | Code Mode JS sandbox execution |

---

## Essential Commands

> All commands run from the repo root.

### Install dependencies
```sh
npm ci
```

### Frontend dev (Vite)
```sh
npm run dev
```

### Full app dev (Tauri)
```sh
npm run tauri dev
```

### Frontend build only
```sh
npm run build
```

### Full app build (Tauri + Rust + installer)
```sh
npm run tauri build
```

### Frontend tests
```sh
npm test
# runs: node --test test/*.test.mjs
```

### Rust check
```sh
cargo check -p wmux -p collab-proto
```

### Rust lint (Clippy)
```sh
cargo clippy -p wmux -p collab-proto -- -D warnings
```

### Rust tests
```sh
cargo test -p wmux -p collab-proto
```

### CI-equivalent (run before opening a PR)
```sh
# Create dist placeholder if needed (tauri-build panics without it):
mkdir -p dist && echo placeholder > dist/index.html

cargo check -p wmux -p collab-proto
cargo clippy -p wmux -p collab-proto -- -D warnings
cargo test -p wmux -p collab-proto
npm ci
npm test
npm run build
```

---

## Patterns

### Frontend module conventions
- All frontend modules use ES module syntax (`.mjs` extension).
- Runtime files are named `*_runtime.mjs`; pure state is in `*_state.mjs`.
- State machines are pure functions — no Tauri or DOM calls — so they can be unit-tested with Node's built-in runner without a browser.
- UI wiring (event listeners, `invoke`, DOM mutations) lives in `*_runtime.mjs`.

### Tauri IPC
- Frontend calls Rust via `invoke('command_name', { ...args })`.
- Commands are defined in `src-tauri/src/commands.rs` and registered in `src-tauri/src/lib.rs`.

### Testing
- Frontend unit tests live in `test/*.test.mjs` and import pure state modules directly.
- Do **not** import Tauri/DOM APIs in state modules — keep them testable without a Tauri context.
- Add a test for every new state function; the CI `npm test` step must pass.

### Cargo workspace
- Three members: `wmux` (`src-tauri`), `browser-helper`, `collab-proto`.
- `cargo check/clippy/test` targets `-p wmux -p collab-proto`; `browser-helper` is built as part of `tauri build`.

---

## Anti-patterns

- **Don't commit directly to `main`.** The pre-commit hook blocks it. Create a feature branch: `git switch -c type/short-description`.
- **Don't bypass Clippy warnings.** The pre-commit hook runs Clippy on staged Rust files and fails the commit on any warning. Fix warnings; do not add `#[allow(...)]` without a documented reason.
- **Don't put DOM or Tauri calls in `*_state.mjs` files.** These modules are tested in Node — any browser/Tauri API call breaks the test suite.
- **Don't create a `dist/` placeholder manually in normal dev** — `npm run dev`/`npm run tauri dev` handles it. The placeholder is only needed for bare `cargo check` runs in CI.

---

## Code Style

- **Rust:** standard `rustfmt` formatting. Run `cargo fmt` before committing Rust changes.
- **JavaScript:** no formatter is currently enforced; match the surrounding file's style (2-space indent).
- **Commit messages:** `type(scope): short description` (e.g., `feat(agent): add sidebar rollup`, `fix(worktree): async handler`). Use the scopes visible in `git log`.

---

## Commit and Pull Request Guidelines

### Before committing
1. Run `cargo fmt` on any changed Rust files.
2. Ensure `cargo clippy -p wmux -p collab-proto -- -D warnings` passes (the pre-commit hook enforces this for staged Rust).
3. Run `npm test` to confirm frontend tests pass.
4. Run `npm run build` to confirm the Vite build succeeds.

### Branching
- **Never commit or push directly to `main`**. Both the pre-commit and pre-push hooks block this.
- Branch naming: `type/short-description` — e.g., `feat/workbook-export`, `fix/conpty-resize`, `docs/adr-mcp`.

### Commit messages
```
type(scope): imperative description

# Types: feat, fix, docs, test, refactor, ci, chore
# Scope: optional, matches the main module changed (agent, worktree, layout, mcp, collab, …)
```

### Pull requests
- Reference the GitHub issue number if one exists (`Closes #42`).
- PRs merge into `main` via GitHub. CI must be green before merge.
- Keep PRs focused — one logical change per PR.

---

## Agent skills & issue tracker

- Issues: GitHub Issues at `github.com/dcieslak19973/wmux`. See `docs/agents/issue-tracker.md`.
- Triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.
- Domain docs: `CONTEXT.md` at root (if present), ADRs in `docs/adr/`. See `docs/agents/domain.md`.
