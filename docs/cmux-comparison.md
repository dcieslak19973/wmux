# wmux vs cmux

This note is intentionally not part of the main README. It is a maintainer-facing product and architecture comparison against the original cmux at cmux.com / `manaflow-ai/cmux`, not against older Windows-local lookalikes.

## Scope

This document compares:

- `wmux`: the current Windows-first Tauri + Rust + ConPTY project in this repo
- `cmux`: the current native macOS app built by Manaflow, publicly positioned as a Ghostty-based terminal and browser for coding-agent workflows

It is not meant to be a marketing page. The goal is to clarify:

- where cmux is currently ahead
- where wmux is meaningfully differentiated
- what has changed since earlier comparisons
- what wmux should copy versus where it should stay intentionally different

## What changed since the last comparison

The old comparison had drifted in two ways:

- it spent too much time on `cmux-windows` instead of the actual cmux product
- it underrated how much the public cmux product has solidified around agent workflows, browser automation, session restore, and product polish

wmux also moved materially since then. It now has stronger evidence of being a real workspace shell rather than a thin terminal multiplexer clone:

- multiple workspaces with restore
- browser and markdown surfaces alongside terminals
- Session Vault and transcript capture
- explicit local / WSL / SSH / remote tmux targets
- remote tmux inspection and management
- tmux compatibility shim for agent harnesses
- OSC notifications plus OSC 52 clipboard handling

So the updated comparison is less about “which local multiplexer looks nicer?” and more about “what product category each app is actually competing in?”

## Short version

- cmux currently looks stronger as a polished, coherent agent-first terminal product.
- wmux is broader on Windows-specific and hybrid remote workflows.
- cmux looks far more mature on productization, performance story, and user-facing coherence.
- wmux is more differentiated where the problem is Windows + WSL + SSH + remote tmux + mixed local surfaces.

## Current public snapshot of cmux

Based on the current public repo and site, cmux is now very clearly defined:

- native macOS only, built in Swift + AppKit
- terminal rendering via `libghostty`
- vertical tabs with rich sidebar metadata
- browser panes built into the product, with a scriptable API
- split panes, workspaces, notification rings, and a notification panel
- explicit SSH workflow support
- CLI plus socket API for automation
- session restore with supported agent resume integrations
- product language aimed directly at Claude Code / Codex / OpenCode / agent-heavy workflows

That is no longer just “a native terminal multiplexer inspired by tmux.” It is a fairly opinionated macOS agent-workspace product with real momentum, real polish, and a large public user base.

## Current wmux snapshot

wmux’s current shape is different:

- Windows-first desktop app using Tauri v2 + WebView2 + Rust + ConPTY
- local Windows shells, WSL, SSH, and remote tmux targets from one launcher
- split-pane layouts containing terminal, browser, and markdown surfaces
- workspace persistence and per-pane state restore
- Session Vault plus transcript capture
- named-pipe automation server plus `window.wmux` frontend automation surface
- `tmux.exe` compatibility shim for practical agent harness interoperability
- remote tmux hybrid model with inspector / create / rename / kill flows

That makes wmux less “native terminal with nice tabs” and more “Windows developer workspace shell with terminal compatibility ambitions.”

## Feature matrix

| Area | cmux | wmux |
|---|---|---|
| Primary platform | macOS only | Windows only |
| App shell | Native Swift + AppKit | Tauri v2 + WebView2 |
| Terminal renderer | `libghostty` | `xterm.js` on top of ConPTY |
| Core positioning | Native terminal/browser for coding agents | Windows port of cmux with broader Windows + remote workflow focus |
| Split panes | Yes | Yes |
| Vertical tab/sidebar model | Yes, heavily productized | Yes, but less polished |
| Embedded/scriptable browser | Yes | Yes |
| Markdown surface | Not a public core feature | Yes |
| Local shells | Yes | Yes |
| WSL | Not relevant | Yes, explicit first-class target |
| SSH target modeling | Yes | Yes |
| Remote tmux hybrid workflows | Not the public focus | Yes, explicit product feature |
| Session restore | Strongly emphasized publicly | Present, improved, but still less trustworthy overall |
| Agent resume integrations | Deep, productized | Partial; stronger tmux-shaped compatibility than native agent resume |
| Notification rings / unread model | Core product feature | Present and useful |
| CLI / socket automation | Core public story | Present, but less legible as a packaged CLI story |
| tmux compatibility shim | No | Yes |
| Browser auth/session import | Public feature | Not currently |
| Remote browser routing through remote network | Public cmux SSH feature | Not currently a core wmux story |

## Where cmux currently looks better

### 1. Product coherence is much stronger

cmux has a much clearer product sentence:

- native macOS terminal + browser for coding agents
- fast
- polished
- scriptable
- cohesive

wmux can explain itself, but the explanation is still more architectural than experiential.

### 2. The terminal performance story is easier to believe

cmux’s public stack is a strong differentiator:

- native Swift + AppKit
- Ghostty rendering engine
- explicit anti-Electron positioning

wmux is not Electron either, but it still inherits the WebView/Tauri perception cost, and `xterm.js + WebView2` is a harder stack to sell as premium terminal infrastructure than `libghostty`.

### 3. Session restore is more central to the product promise

cmux explicitly documents:

- what gets restored
- what does not
- how supported agent sessions resume
- where state is stored

wmux has closed some earlier restore gaps with layout persistence, Session Vault, transcript capture, and better terminal replay, but it still does not present restore as a product-defining capability with the same clarity or apparent trust level.

### 4. Automation is simpler to explain

cmux’s public automation story is straightforward:

- CLI
- socket API
- browser API
- hooks setup

wmux has equivalent or stronger low-level pieces in some areas, but they are spread across:

- named-pipe IPC
- frontend automation bridge
- tmux compatibility shim
- Tauri commands

That is powerful, but harder to package into one obvious “do this” story.

### 5. Community and momentum are materially stronger

cmux now has:

- a large public star count
- a steady release cadence
- a strong public social loop
- obvious word-of-mouth momentum in agent-heavy communities

wmux should treat this as signal, not marketing noise. Momentum changes what users assume is “the default serious tool” in a category.

## Where wmux currently looks better

### 1. wmux has the better Windows answer

This is the most obvious and most defensible differentiator.

cmux is macOS only. wmux is not just “Windows support”; it is shaped around real Windows-native concerns:

- ConPTY
- PowerShell/cmd
- WSL
- WebView2
- Windows packaging and automation constraints

If the user lives on Windows, cmux is not a direct replacement today.

### 2. WSL and remote tmux are real strategic differentiators

wmux has explicit, productized target modeling for:

- local shells
- WSL
- SSH
- remote tmux over SSH

That gives wmux a stronger answer for hybrid Windows-local / Linux-remote development than cmux currently advertises.

### 3. wmux is broader as a workspace shell

cmux is terminal + browser. wmux is terminal + browser + markdown, plus a more obvious multi-surface persistence story inside a single tab/workspace graph.

That is strategically interesting because it opens workflows where the terminal is only one surface among several local developer artifacts.

### 4. Agent-oriented compatibility is stronger in tmux-shaped environments

wmux has invested in:

- practical `tmux.exe` compatibility
- minimal tmux-presence env hints
- named-pipe automation
- remote tmux inspection / management
- OSC notifications and clipboard handling

cmux has a cleaner native agent workflow story. wmux has a stronger “make existing tmux-ish harnesses work on Windows” story.

That matters for users who are not willing to wait for every agent tool to add first-class wmux support.

## Where wmux is still weaker

### 1. It still feels less settled

wmux has improved, but it is still easier to imagine edge cases in:

- restore fidelity
- layout coordination
- keyboard/input handling
- browser pane coordination
- polish across multiple surfaces and targets

cmux benefits from a narrower product shape and a native app stack that makes the whole thing feel more singular.

### 2. The architecture is more complex to keep coherent

wmux currently spans:

- Tauri shell
- Rust backend
- xterm frontend terminal runtime
- browser child webviews
- markdown surface runtime
- workspace persistence
- local / WSL / SSH / remote tmux target logic
- automation bridge
- tmux shim

That is a lot of interacting seams. The product upside is real, but so is the integration tax.

### 3. Browser and remote workflows are less unified than cmux’s public story

cmux publicly claims a smoother “SSH workspace + browser pane + localhost just works through the remote network” workflow.

wmux is stronger at remote tmux hybrid workflows, but weaker at presenting one seamless remote terminal/browser story.

### 4. The value proposition is still harder to explain in one sentence

cmux: native macOS terminal and browser for coding agents.

wmux today: Windows port of cmux, but also a Windows-native workspace shell, but also a remote tmux hybrid environment, but also a tmux compatibility layer.

That is all real. It is also too many product sentences at once.

## Direct answer: does cmux roll its own tmux server on remote hosts?

Short answer: no.

cmux’s public model is not “deploy our own tmux-compatible server to the remote machine.” It is closer to:

- native local app
- local session/workspace state
- SSH workflows
- local browser/automation surfaces
- CLI/socket control

That is not the same thing as implementing a remote tmux-server replacement.

wmux also does not try to do that. Its current remote answer is:

- SSH to the host
- optionally attach to or create a real remote tmux session
- keep wmux-native surfaces local
- inspect and manage remote tmux over SSH

That remains the right design. wmux should keep using real remote tmux where true tmux semantics matter.

## Practical takeaway for wmux

wmux should not try to out-cmux cmux on macOS-native polish. That is the wrong fight.

The better strategy is:

- be the best Windows answer for cmux-like workflows
- keep leaning into WSL + SSH + remote tmux hybrid workflows
- keep the mixed-surface workspace model
- copy cmux’s discipline around restore trust, shortcut clarity, docs, and product coherence

The most valuable things to borrow from cmux are not “native Swift” or “vertical tabs.” wmux already has its own stack and tab model. The important things to borrow are:

- sharper product language
- stronger restore guarantees
- clearer automation entry points
- cleaner keyboard and UX contracts
- less ambiguity about what the app is for

## Honest verdict

If the question is “is wmux now closer to current cmux than it was two months ago?” the answer is yes.

wmux now looks less like a rough Windows port and more like a credible Windows-specific branch of the same broader category.

If the question is “does wmux beat current cmux overall?” the honest answer is no.

cmux currently looks ahead on:

- polish
- coherence
- performance story
- public packaging of agent workflows
- community momentum

wmux is ahead where the problem is specifically:

- Windows
- WSL
- remote tmux
- tmux-shaped compatibility
- broader mixed-surface local workspaces

That is enough for wmux to be strategically interesting. It is not yet enough for wmux to win a general head-to-head comparison on overall finish.