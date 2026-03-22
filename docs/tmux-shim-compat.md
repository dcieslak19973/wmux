# wmux tmux Shim Compatibility

This file tracks the current compatibility surface of the `tmux.exe` shim in `src-tauri/src/bin/tmux.rs`.

The goal is practical interoperability with agent harnesses and wrapper scripts, not full tmux parity. Keep the README high-level; use this file for the current command/flag/query matrix.

## Scope

- Source of truth: `src-tauri/src/bin/tmux.rs`
- Purpose: document the practical subset that currently maps onto wmux automation APIs
- Non-goal: claim full tmux server/client behavior parity

## Supported Commands

### Session and window lifecycle

- `new-session [-d] [-s name] [-x cols] [-y rows] [-P] [-F format]`
- `new-window -t name`
- `kill-session -t name`
- `has-session -t name`
- `attach-session [-t name]`
- `switch-client [-t name]`

### Pane and window control

- `split-window [-h|-v] -t pane_id`
- `select-pane -t pane_id`
- `kill-pane -t pane_id`
- `select-window -t tab_id`

### Input and capture

- `send-keys -t name [keys...] [Enter|Space|Escape|Tab|BSpace|C-c|C-d|C-z]`
- `capture-pane [-p] -t name`

### Listing and query commands

- `list-sessions`
- `list-windows [-F format]`
- `list-panes [-t tab_id] [-F format]`
- `display-message [-p] [-F format] [-t target] message...`

### Compatibility/control verbs

These verbs now provide bounded compatibility behavior:

- `wait-for [-L|-S|-U] channel`
- `source-file [-q] path`
- `set-option`
- `set-window-option`
- `refresh-client`

### Session/client mapping notes

- `attach-session` and `switch-client` now resolve a wmux workspace by name or id and switch to it.
- `new-window -t name` now resolves the target workspace/session and creates a new tab inside it.
- `list-sessions` now surfaces wmux workspaces first and merges legacy named backend sessions only as a fallback.
- `send-keys` and `capture-pane` can resolve a workspace/session name through its active pane, not only through legacy named backend sessions.

## Output and Format Support

### Listing output

- `list-sessions` emits tmux-style session lines
- `list-windows -F ...` preserves the provided format string
- `list-panes -F ...` preserves the provided format string
- `new-session -P -F ...` preserves creation output formatting

### `display-message -p`

`display-message -p` resolves data from wmux workspaces, tabs, and panes and renders tmux-style tokens for practical metadata queries.

Currently supported tokens include:

- `#{pane_id}`
- `#{pane_current_path}`
- `#{pane_title}`
- `#{pane_current_command}`
- `#{pane_active}`
- `#{window_id}`
- `#{window_name}`
- `#{window_active}`
- `#{session_id}`
- `#{session_name}`
- `#{session_attached}`
- `#{client_termtype}`
- `#{client_termname}`

Pane label notes:

- `#{pane_title}` and `#{pane_current_command}` now prefer the pane’s propagated wmux context label when available.
- In practice this means worktree-aware pane labels can flow through `list-panes -F ...` and `display-message -p ...` for agent-oriented status queries.

Compatibility verb notes:

- `wait-for` is now backed by named IPC-server channels.
- Plain `wait-for channel` blocks until a signal is delivered.
- `wait-for -S channel` delivers a signal.
- `wait-for -L channel` acquires a lightweight named lock.
- `wait-for -U channel` releases that lock.
- `source-file` now reads a file and replays supported tmux commands line by line.
- `source-file` ignores blank lines, strips inline comments outside quotes, supports trailing `\` line continuations, and splits `;`-separated commands outside quotes.
- `source-file` keeps unsupported commands harmless rather than trying to interpret the full tmux configuration language.
- `set-option` and `set-window-option` now write to a compatibility-only allowlisted sink for common harmless UI and terminal options.
- `refresh-client` remains a compatibility no-op.

## Environment Hints for Child Shells

wmux injects a minimal set of multiplexer-presence variables for child shells:

- `TMUX`
- `TMUX_PANE`
- `WMUX`
- `WMUX_PANE_ID`

It intentionally keeps terminal capability reporting honest rather than broadly spoofing a different terminal host:

- `TERM=xterm-256color`
- `COLORTERM=truecolor`

## Behavioral Notes

- The shim is aimed at agent-driven usage patterns from tools such as Claude Code and Codex.
- Unsupported commands are generally ignored cleanly rather than trying to emulate deep tmux server semantics.
- The named pipe automation layer and `window.wmux` bridge are broader than the shim; the shim is only one compatibility surface.

## Compatibility Priority Plan

The highest-risk remaining compatibility verb is no longer `wait-for`. The implemented behavior below is the baseline to preserve and validate.

### Completed Priority 0

- `wait-for`

Why this comes first:

- A no-op `wait-for` can create real ordering bugs in wrapper scripts because it removes synchronization rather than merely dropping cosmetic state.
- A bounded implementation exists: add lightweight named wait channels in the wmux IPC server and support the practical subset of `wait-for -L`, `wait-for -S`, and `wait-for -U`.

Implemented behavior:

- wait state is centralized in the IPC server, not the shim process
- the practical subset of wait, signal, lock, and unlock semantics is supported for named channels
- blocking behavior stays explicit and minimal rather than attempting full tmux server semantics

### Completed Priority 1

- `source-file`

Why this is next:

- Many tmux-oriented wrappers bootstrap through a sourced file before they issue direct control commands.
- A partial implementation can provide high leverage even if most tmux syntax remains unsupported.

Implemented behavior:

- read the file and replay supported commands line by line
- ignore blank lines, strip comments outside quotes, support simple line continuations, and split `;`-separated command groups outside quotes
- keep unsupported commands cleanly harmless
- treat `source-file` as a compatibility loader, not as a full tmux config interpreter

### Completed Priority 2

- `set-option`
- `set-window-option`

Why these are behind `source-file`:

- Today they are mostly cosmetic for harness workflows.
- They become more useful once `source-file` exists, because sourced bootstrap files often contain them.

Implemented behavior:

- support a write-only compatibility sink for a curated allowlist of common harmless options
- start with options that wrappers commonly set for non-interactive use, such as status/UI toggles and terminal hints
- do not attempt broad option parity or full readback semantics unless a real client requires it

### Priority 3

- `refresh-client`

Why this stays last:

- In current wmux usage it is usually equivalent to an acknowledgement that the client state should be redrawn.
- A no-op here is less likely to break correctness than a no-op `wait-for`.

Implementation target:

- keep as a no-op until a concrete harness demonstrates a need for redraw, resize, or focus side effects
- if needed later, map it to a narrow frontend refresh path rather than inventing tmux client semantics

## Recommended Next Pass

The next implementation pass should be:

1. validate the new `wait-for` and `source-file` behavior against real harness bootstrap scripts
2. expand the option allowlist only when a concrete client needs another harmless key
3. leave `refresh-client` as a no-op unless a real harness proves otherwise

## Maintenance Notes

- When adding shim support, update this file if the change affects externally visible commands, flags, output, or token behavior.
- Keep the README at the capability level and avoid duplicating the matrix here.