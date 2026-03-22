# wmux vs cmux

This note is intentionally not part of the main README. It is a product and architecture comparison reference for maintainers.

## Scope

This document compares wmux against:

- cmux-windows: the Windows-native WPF + ConPTY project at `mkurman/cmux-windows`
- cmux, in the broader sense of native local terminal multiplexer apps inspired by tmux workflows

It is not meant to be a feature matrix for end users. It is meant to help decide what wmux should copy, what it should ignore, and where it is deliberately trying to be a different product.

## Short version

- cmux-windows currently looks stronger as a focused Windows terminal multiplexer.
- wmux is broader and more ambitious.
- wmux has stronger remote-workflow and mixed-surface potential.
- cmux-windows currently looks tighter on persistence, terminal-first UX, and overall polish.

## Where cmux-windows currently looks better

### 1. Persistence is treated like a core product feature

cmux-windows is explicitly built around strong session recall, transcript capture, and a Session Vault. Its architecture and product language line up around the idea that a user should be able to close or crash the app and come back to something very close to the previous state.

That matters because terminal multiplexers get judged less by the number of features they have and more by whether users trust them not to lose working context.

### 2. The terminal-first workflow is more cohesive

cmux-windows appears to center the experience around:

- workspaces
- surfaces/tabs
- split panes
- command logs
- command history picker
- transcript capture
- Session Vault
- automation via a dedicated CLI

That is a very coherent product shape. wmux currently has many of those building blocks, but its UX is more distributed across a wider set of capabilities.

### 3. The automation story is easier to explain

cmux-windows has a dedicated `cmux` CLI layered over its local app/daemon model. That makes the automation surface feel packaged and intentional.

wmux also has strong automation, but today it is more of a power-user/developer-oriented control plane:

- named-pipe automation
- tmux compatibility shim
- frontend control bridge

That is powerful, but less immediately legible than a simple CLI.

### 4. It looks more productized today

cmux-windows reads like a tool with one clear job: be a very good Windows-native terminal multiplexer.

wmux is trying to do more than that, which is strategically interesting, but also means there are more edges where the experience can feel less settled.

## Where wmux currently looks better

### 1. wmux is much broader than a terminal multiplexer

wmux can combine:

- terminal panes
- browser panes
- markdown panes
- workspace persistence across those surfaces

That is a real product difference, not a cosmetic feature gap.

### 2. Remote workflows are a major differentiator

wmux has explicit support for:

- local shells
- WSL
- SSH targets
- remote tmux hybrid workflows

That gives wmux a stronger answer to real remote development than cmux-windows currently appears to have.

### 3. Agent-oriented compatibility is stronger

wmux has invested in:

- OSC notification handling
- named-pipe automation
- tmux.exe compatibility for agent harnesses
- remote tmux inspection and management

This is strategically important. A lot of the interesting workflows around coding agents are not just “open a terminal”; they depend on being able to detect multiplexer context, emit notifications, and interoperate with tmux-shaped tooling.

### 4. The architectural ceiling is higher

wmux is closer to a developer workspace shell than a pure terminal app. If executed well, that gives it more upside than a narrow terminal multiplexer.

The cost is complexity.

## Where wmux is currently weaker

### 1. Restore fidelity has not been consistently closed-loop

This is the most important gap.

If a user expects the app to come back with:

- the same working directory
- the same layout
- the same browser/markdown surfaces
- the same terminal context

then any mismatch feels like a trust failure, not a minor bug.

cmux-windows seems to have treated this as a first-class product problem. wmux has sometimes had the pieces present in the data model without fully wiring them through restore behavior.

### 2. UX consistency is not yet at the same level

wmux is moving quickly, but small regressions matter:

- spacing issues
- inconsistent menu styling
- restore edge cases
- form flow roughness

These individually look minor. Together they change how “solid” the app feels.

### 3. Feature breadth increases integration risk

wmux has more interacting systems than cmux-windows:

- Tauri app shell
- xterm-based terminal panes
- browser child webviews
- markdown panes
- local/WSL/SSH/remote tmux targets
- automation bridge
- tmux compatibility shim
- workspace persistence

That is a harder system to keep coherent than a narrower terminal product.

## Where cmux-windows is weaker

### 1. It appears much more local-machine centric

cmux-windows looks like a strong local Windows terminal multiplexer. It does not appear to have wmux-style explicit remote target modeling or remote tmux workflows.

### 2. It does not appear to compete on mixed-surface workspaces

wmux’s browser and markdown surfaces are not just “extra panes”; they change the product category. cmux-windows does not appear to be trying to do that.

### 3. It is less differentiated if the goal is an agent-oriented remote workspace tool

If the target is “best local Windows multiplexer,” cmux-windows is easier to evaluate and easier to like.

If the target is “best environment for remote, agent-assisted development workflows,” wmux has the stronger direction.

## Direct answer: do cmux or cmux-windows roll their own "tmux server" on remote hosts?

Short answer: no, not in the sense tmux itself does.

### cmux-windows

cmux-windows appears to run a local Windows app plus a local daemon/session manager for its own terminal sessions. That is a local process model, not a remote-host multiplexer server.

Based on its public architecture and code:

- it is a local WPF + ConPTY application
- it has a local daemon/session manager for persistence/reconnect semantics
- it does not appear to deploy or emulate a tmux server on remote hosts

So the answer for cmux-windows is clearly: no.

### cmux

If by “cmux” you mean the local native terminal-multiplexer family of tools that are inspired by tmux workflows, the answer is also generally no.

They may have:

- a local daemon
- local session state
- local pane/surface/workspace persistence
- local CLI or IPC

But that is not the same as rolling their own tmux server process on remote machines.

In other words:

- local app/daemon/session manager: yes, often
- remote-host tmux-server replacement: no

### How that compares to wmux

wmux also does not try to deploy its own tmux server process onto remote hosts.

Instead, wmux’s current remote model is:

- SSH to the remote machine
- optionally attach to or create a real remote tmux session
- keep wmux-native browser/markdown surfaces local
- inspect/manage the remote tmux session over SSH when needed

That is a hybrid model, not a custom remote tmux-server implementation.

## Practical takeaway for wmux

The right comparison is not “should wmux build its own tmux server on remote hosts?”

It is:

- should wmux keep using real remote tmux when tmux semantics are needed?
- should wmux make local restore/persistence as trustworthy as cmux-windows?
- should wmux keep doubling down on mixed local surfaces plus remote terminal workflows?

The answer today is probably:

- yes, keep using real remote tmux
- yes, raise the bar on persistence/restore correctness
- yes, keep leaning into the broader workspace model rather than becoming a narrower clone

## Honest verdict

If the goal is to beat cmux-windows specifically as a local Windows terminal multiplexer, wmux still has polish and persistence work to do.

If the goal is to build a more capable developer workspace system, wmux is already on a more interesting path.

The main thing wmux should borrow from cmux-windows is discipline around product coherence and restore fidelity, not the narrower scope.