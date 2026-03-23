# wmux vs cmux and cmux-windows

This note is intentionally not part of the main README. It is a product and architecture comparison reference for maintainers.

## Scope

This document compares wmux against two distinct products:

- cmux: the native macOS app at `cmux.com` / `manaflow-ai/cmux`
- cmux-windows: the Windows-native WPF + ConPTY project at `mkurman/cmux-windows`

It is not meant to be a feature matrix for end users. It is meant to help decide what wmux should copy, what it should ignore, and where it is deliberately trying to be a different product.

## Short version

- Original cmux is the clearest product benchmark for wmux’s broader direction: agent-oriented terminal, browser-in-the-loop workflow, notifications, and automation.
- cmux-windows is the clearest benchmark for Windows-local terminal-product coherence: CLI-first automation packaging, transcript/history UX, and focused desktop polish.
- wmux is now closer to the cmux shape than this note previously gave it credit for.
- wmux still has the biggest gap on restore trust, renderer/performance ceiling, and overall consistency under complexity.

## Product shape by project

### cmux

cmux is a native macOS app built around:

- vertical tabs with sidebar metadata
- split panes
- notification rings
- an embedded browser
- automation through a CLI and socket API
- Ghostty-based rendering

This is not just “a terminal multiplexer inspired by tmux.” It is a concrete product that is already trying to be a workspace shell for coding-agent workflows.

### cmux-windows

cmux-windows is a Windows-native terminal multiplexer built around:

- workspaces
- surfaces/tabs
- split panes
- command logs
- command history picker
- transcript capture
- Session Vault browsing
- a dedicated `cmux` CLI over local IPC/daemon semantics

It reads like a tighter, more terminal-first Windows product than wmux today.

### wmux

wmux is now best understood as a Windows workspace shell with terminal-multiplexer roots. Its current shape includes:

- local, WSL, SSH, and remote tmux targets
- terminal, browser, and markdown surfaces in one layout model
- named workspaces with tab movement and restore state
- OSC notifications and unread tracking
- Session Vault capture and replay metadata
- named-pipe automation plus a tmux compatibility shim
- remote tmux inspection and management over SSH

That puts wmux closer to original cmux in ambition, while still competing with cmux-windows on Windows-local usability.

## Where cmux currently looks better than wmux

### 1. The core story is more legible

cmux has a very clear product sentence: native macOS terminal for coding-agent multitasking, with vertical tabs, browser, notifications, and automation built in.

wmux has most of the same strategic ingredients, but the story is less compressed because it also carries Windows-specific concerns, Tauri/WebView integration, tmux compatibility, and remote target modeling.

### 2. The renderer and platform stack set a higher ceiling

cmux is native Swift + AppKit and uses libghostty for rendering. That gives it a stronger default position on perceived smoothness, input fidelity, and terminal credibility.

wmux is still xterm.js plus ConPTY inside Tauri. That is workable and productive, but it is a lower-ceiling stack for a terminal product than Ghostty-backed native rendering.

### 3. The UI concept feels more unified

cmux’s browser, notifications, vertical tab model, and keyboard-first flow read as one product concept rather than a collection of subsystems.

wmux has similar breadth, but its UX still shows the seams between:

- Tauri app shell behavior
- terminal panes
- browser child webviews
- markdown panes
- workspace and tab orchestration
- remote tmux overlays and inspectors

## Where cmux-windows currently looks better than wmux

### 1. The Windows-local terminal workflow is tighter

cmux-windows appears more intentionally centered on the local Windows developer who wants:

- workspaces
- terminal surfaces
- pane management
- logs/history
- transcript capture
- Session Vault recall
- CLI automation

That narrower focus makes the product easier to explain and easier to evaluate quickly.

### 2. The automation packaging is easier to understand

wmux has strong automation, but it is spread across:

- named-pipe IPC
- frontend control bridge
- `window.wmux`
- `tmux.exe` compatibility shim

cmux-windows has the simpler outward story: there is a `cmux` CLI and it talks to the app.

### 3. It still looks more disciplined as a local terminal product

wmux has made real progress on persistence and lifecycle wiring, but cmux-windows still reads more like a tool with one clear primary job: be a solid Windows terminal multiplexer with transcript-aware recall.

## Where wmux currently looks better than both

### 1. Remote workflow depth is a real differentiator

wmux has explicit modeling for:

- local shells
- WSL
- SSH targets
- remote tmux targets with attach/create intent

Neither cmux nor cmux-windows currently appears to compete at that level of remote-target awareness.

### 2. wmux is stronger on hybrid remote tmux workflows

wmux does not just open SSH terminals. It can:

- reconnect remote tmux tabs
- probe remote tmux session/window/cwd metadata
- inspect remote tmux sessions, windows, and panes
- switch and manage remote tmux state over SSH

That is a concrete product edge, not just an implementation detail.

### 3. wmux keeps mixed-surface local context while using real remote tmux

wmux’s current hybrid model is strategically strong:

- remote terminal semantics stay with real tmux on the host
- local browser and markdown surfaces remain native to wmux
- the app can still persist workspace-level composition around that remote terminal session

That is a better answer to remote agent-driven development than trying to reimplement tmux semantics from scratch on remote machines.

### 4. Compatibility for agent harnesses is stronger

wmux has invested in:

- OSC 9/99/777 notification ingestion
- named-pipe automation
- a practical `tmux.exe` compatibility shim
- multiplexer-presence environment hints for child shells

That matters because many agent-oriented workflows need more than “a terminal app.” They need interoperability with tmux-shaped scripts and harnesses.

## Where wmux is still weaker

### 1. Restore trust is better, but not done

This note previously overstated the gap by treating persistence as mostly aspirational. That is no longer accurate.

wmux now has:

- change-driven layout persistence
- lifecycle wiring for hide/page-close/app-close save paths
- Session Vault capture and metadata linkage
- restored workspaces, tabs, browser panes, markdown panes, and pane metadata

But the most important trust gap remains: terminal restore fidelity is still intentionally conservative. In particular, persisted terminal screen and output snapshots are currently sanitized down rather than replayed as a full “resume exactly where I was” experience.

That is a rational stability tradeoff, but it still means wmux is behind the best local-recall story.

### 2. Product coherence still lags the best benchmark in each category

Against cmux, wmux lags on product unity and rendering stack.

Against cmux-windows, wmux lags on local Windows terminal-first cohesion and simplicity.

This is the tax of trying to be both broader and more remote-capable.

### 3. Complexity remains the main execution risk

wmux has more interacting systems than either comparison target:

- Tauri app shell
- ConPTY backend
- xterm-based terminals
- browser child webviews
- markdown surfaces
- local/WSL/SSH/remote tmux targets
- Session Vault
- automation bridge
- tmux shim
- workspace persistence

That creates more opportunities for edge-case regressions and less room for sloppy UX.

## Where cmux is weaker

### 1. It is macOS-only

That is not a small caveat. It means cmux is the design benchmark, not a direct deployment answer for Windows users.

### 2. It does not appear to have wmux’s remote target model

cmux clearly competes on agent workflows, notifications, browser integration, and automation. It does not appear to expose wmux-style explicit target types for WSL, SSH, and remote tmux hybrid flows.

### 3. It is less about interoperating with existing tmux-shaped remote infrastructure

cmux looks optimized for local agent-centric terminal work. wmux has a stronger answer when the user already depends on real tmux running on remote Linux hosts.

## Where cmux-windows is weaker

### 1. It appears much more local-machine centric

cmux-windows looks like a strong local Windows terminal multiplexer. It does not appear to have wmux-style explicit remote target modeling or remote tmux workflows.

### 2. It does not appear to compete on mixed-surface workspaces as deeply

wmux’s browser and markdown surfaces are not side features. They are part of the core workspace model. cmux-windows appears more terminal-centric, even where it offers adjacent tooling like logs and vault browsing.

### 3. It is less differentiated if the target is remote, agent-assisted development

If the target is “best local Windows terminal multiplexer,” cmux-windows is easier to like.

If the target is “best Windows workspace shell for remote agent-assisted development,” wmux still has the more differentiated direction.

## Direct answer: do cmux or cmux-windows roll their own "tmux server" on remote hosts?

Short answer: no.

### cmux

cmux presents as a local native macOS app with built-in browser, notifications, and a socket/CLI automation surface. That is local app automation, not a remote-host tmux-server replacement.

### cmux-windows

cmux-windows appears to run a local Windows app plus local CLI/daemon-style session management. That is also local process orchestration, not a remote-host multiplexer server.

### wmux

wmux also does not try to deploy its own tmux server process onto remote hosts.

Instead, wmux’s current remote model is:

- SSH to the remote machine
- optionally attach to or create a real remote tmux session
- keep wmux-native browser and markdown surfaces local
- inspect and manage the remote tmux session over SSH when needed

That is a hybrid model, not a custom remote tmux-server implementation.

## Practical takeaway for wmux

The right questions are not:

- should wmux become a narrower clone of cmux-windows?
- should wmux try to replace tmux on remote hosts?

They are:

- should wmux keep using real remote tmux when tmux semantics are needed?
- should wmux close the restore-trust gap without regressing startup stability?
- should wmux keep leaning into mixed local surfaces plus remote-terminal workflows?
- should wmux make its automation surface easier to explain without losing power?

The answer today is probably:

- yes, keep using real remote tmux
- yes, keep pushing restore fidelity upward carefully
- yes, keep leaning into the broader workspace model
- yes, simplify the automation story at the product boundary

## Honest verdict

Against original cmux, wmux is now in the same category of product ambition, but still behind on renderer stack, product unity, and polish.

Against cmux-windows, wmux is more differentiated and more interesting on remote workflows, but still behind on simplicity and local terminal-first coherence.

The main thing wmux should borrow from both is discipline:

- from cmux: a tighter product story and more unified UX
- from cmux-windows: clearer local automation packaging and higher restore trust

The main thing wmux should not borrow is narrower scope. Its best chance is to be the strongest Windows-native mixed-surface workspace shell for remote and agent-assisted development, not just another local terminal multiplexer.