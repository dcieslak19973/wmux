# wmux competitive landscape

Maintainer-facing comparison of wmux against the closest tools in the agent-terminal and AI-coding-workspace category. Snapshot date: **2026-06-02**.

> **This category churns weekly.** The previous snapshot (2026-05-25) was stale within hours — wmux shipped first-party worktree isolation ~6 hours after that doc was written, and three competitors shipped category-relevant features in the same six days. Treat every row as perishable. Re-run the recheck in [`roadmap.md`](../roadmap.md) before relying on any claim here.
>
> **Methodology.** wmux state is verified against the current repo (HEAD on `main`, v0.1.4). Other tools are summarized from their public repos, release notes, and docs as of the snapshot date; sources are linked inline. Where a claim couldn't be confirmed, it says so.

## Tools covered

| Tool | Category | Platform | License | Repo |
|---|---|---|---|---|
| **wmux** | Agent-aware terminal multiplexer | Windows-native (WSL/SSH-aware) | AGPL-3.0 | (this repo) |
| **Warp** | Agent-first terminal + cloud orchestration platform | macOS, Linux, Windows (all GA) | AGPL-3.0 core / MIT UI crates | [warpdotdev/warp](https://github.com/warpdotdev/warp) |
| **cmux** | macOS agent terminal | macOS only | GPL-3.0-or-later | [manaflow-ai/cmux](https://github.com/manaflow-ai/cmux) |
| **Zed** | GPU code editor + agent panel + terminal threads | macOS, Linux, Windows (all stable) | GPL-3.0 editor / AGPL-3.0 server / Apache-2.0 GPUI | [zed-industries/zed](https://github.com/zed-industries/zed) |
| **herdr** | TUI agent runtime/multiplexer | Linux, macOS (POSIX) | AGPL-3.0 | [ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) |
| **mux** (coder) | Parallel-agent desktop with worktree isolation | macOS, Linux, **Windows (alpha)** | AGPL-3.0 | [coder/mux](https://github.com/coder/mux) |
| **t3code** | GUI harness for official agent CLIs | macOS, Linux, Windows | MIT | [pingdotgg/t3code](https://github.com/pingdotgg/t3code) |

**Watched but not yet tabled:** **Windows Terminal** — Microsoft has spent ~6 months adding Warp-style features ([XDA, 2026](https://www.xda-developers.com/microsoft-has-spent-six-months-turning-windows-terminal-into-a-rival-to-warp-and-its-working/)). It is the free, pre-installed default on wmux's only platform and is the most likely tool to compress wmux's niche from below. It is not an agent-multiplexer today, so it stays off the matrix — but it belongs on the watchlist.

## Maturity & sustainability

The feature matrix below uses ✅/⚠️/❌ for *capability*, which says nothing about *how proven* a capability is. This is the most important corrective to the matrix: a wmux ✅ is tested by one person at v0.1.x; a cmux or Warp ✅ is hardened by a large user base. Read the two tables together.

| Tool | Version | Backing | Adoption | Cadence | Honest "proven?" read |
|---|---|---|---|---|---|
| **wmux** | 0.1.5 | **Solo maintainer** | — | very high (multiple commits/day) | Young. ~14k LOC Rust, 72 Rust tests, **82 frontend tests** (was 0). Several flagship features are days-old, single-commit. Bus factor = 1. |
| **Warp** | weekly (v0.2026.05.27 stable) | VC + OpenAI sponsor, paid team | large commercial install base | weekly (Thu) + daily dev | Mature, funded, hardened. |
| **cmux** | ~v0.64.10 | Manaflow (company) | ~18k GitHub stars | very high | Young product, large community fast finding edge cases. |
| **Zed** | 1.0+ (stable) | Zed Industries (VC, ~50 devs) | large | weekly | Mature editor; agent/terminal-thread surface is newer. |
| **herdr** | v0.6.x | Solo/small, very active | ~2.6k stars | very high | Young but disciplined; narrow scope keeps it coherent. |
| **mux** | active | Coder (company) | growing | high | Established vendor; Windows build is **alpha**. |
| **t3code** | v0.0.24 | Ping Labs (Theo Browne) | growing | high | Pre-1.0, thin wrapper over Codex CLI. |

## Feature matrix

Legend: ✅ shipped first-party · ⚠️ partial / new / opinionated punt · ❌ not shipped

| Dimension | wmux | Warp | cmux | Zed | herdr | mux | t3code |
|---|---|---|---|---|---|---|---|
| Windows GA / stable | ✅ | ✅ | ❌ | ✅ | ❌ | ⚠️ alpha (no WSL) | ✅ |
| First-class WSL routing (per-distro shell flavor) | ✅ | ⚠️ | ❌ | ⚠️ | ⚠️ | ❌ explicitly unsupported | ❌ |
| MCP **server** (callable by external agents) | ✅ HTTP `:7766/mcp` + named pipe | ❌ MCP **client** only | ❌ (community `cmux-mcp`) | ❌ | ❌ | ❌ | ❌ |
| Code Mode (server-side JS sandbox over MCP tools) | ✅ `wmux_eval` default surface | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Programmatic external control of the app | ✅ MCP + named pipe + tmux shim | ⚠️ "control via CLI" on May–Jun roadmap | ⚠️ CLI + socket | ⚠️ via ACP | ✅ CLI + socket API | ⚠️ | ❌ |
| tmux compatibility shim | ✅ `tmux.exe` | ❌ | ❌ | ❌ | native tmux | ❌ | ❌ |
| Multi-agent in one window | ✅ sidebar + cross-workspace rollup | ✅ vertical agent tabs (branch/worktree/PR metadata) | ✅ vertical workspace tabs | ✅ Parallel Agents + Terminal Threads | ✅ ~14 agent integrations | ✅ + git-divergence dashboard | ✅ |
| Agent-CLI lifecycle hooks (authoritative state) | ⚠️ **Claude + Codex** → "live" badge | ✅ for built-in agent surfaces | ✅ 14+ agents (incl. `PermissionRequest`) | ⚠️ via ACP agents | ✅ 14+ agents, socket-forwarded | partial | ❌ |
| Screen-content state fallback for any TUI agent | ✅ shell-prompt + bottom-rows heuristic | ✅ (own surface) | ✅ | n/a | ✅ | ❌ | ❌ |
| First-party git worktree isolation per pane | ✅ **on-demand, shipped 2026-05-25** (days-old) | ✅ auto-detect + per-worktree review/index | ⚠️ rough (sidebar/new-pane bugs, #156) | ✅ per-thread, detached HEAD | ✅ worktree CLI + socket API | ✅ core runtime mode + divergence dashboard | ✅ task isolation |
| Process/agent persistence (survives host restart) | ⚠️ **layout + scrollback only — live process dies** | ✅ via Drive | ✅ scrollback + session resume | partial | ✅ **detach/reattach + agent-conversation resume** | ✅ | ❌ |
| Real-time multi-device collab (pane / workspace) | ✅ Tailscale-aware PWA viewer, R/W, local-first | ✅ live — **cloud-only via Warp backend** | ❌ | ✅ DeltaDB CRDT (code/state) | ❌ | ❌ | ❌ |
| Browser surface in pane | ✅ iframe + in-pane CEF fallback (CDP screencast) | ❌ | ✅ scriptable browser (separate window) | ❌ | ❌ | ✅ browser tabs | ❌ |
| Markdown / notebook surface in pane | ✅ | ✅ Notebooks | ❌ | ✅ in-editor | ❌ | ❌ | ⚠️ diff viewer |
| Activity log (per-agent tool calls + I/O) | ✅ + per-pane agent timeline | ✅ Blocks history | partial | ✅ thread history | ⚠️ | partial | ✅ |
| Per-pane one-shot ask against any installed agent CLI | ✅ Claude/Codex/Gemini/OpenCode/Aider | ✅ (own agent) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Customizable keybindings (JSON, hot-reload) | ✅ | ✅ | partial | ✅ | ✅ | partial | ❌ |
| SSH / remote terminal | ✅ ConPTY + WSL + SSH spawn | ✅ Warp SSH | ✅ SSH workspace attach | ⚠️ basic | ✅ thin-client | ✅ runtime mode | ❌ |
| Multi-shell (bash/zsh/fish/PowerShell, per-pane flavor) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| GPU-accelerated terminal renderer | ❌ **xterm.js over WebView2** | ✅ Rust GPU | ✅ libghostty | ✅ Rust/Metal/D3D11 | terminal host | Electron | Electron |
| OSC notification ring (9 / 99 / 777) | ✅ | partial | ✅ | ❌ | ✅ | ❌ | ❌ |
| Workbook / charts via MCP | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| PR review pane | ✅ multi-CLI inline Ask AI | ⚠️ via cloud agent | ⚠️ PR linkage in sidebar | ✅ in-editor diff | ❌ | ✅ integrated review | ✅ |
| Cloud / login required for full feature set | ❌ local-first | ✅ (Agent Mode / Oz / Shared Sessions) | ❌ | optional | ❌ | optional | optional |

## What changed 2026-05-31 → 2026-06-02

**wmux:**

- ✅ **82 frontend tests** — agent state machine (`agent_state.mjs`, 21 tests), session-restore round-trip (`buildTerminalPaneSnapshot → buildRestoredTerminalState`, 10 tests), `createLeafPane` init normalization (42 tests), syntax-check suite, worktree helpers (9 tests). Closes the "0 frontend tests" gap called out in the maturity table.
- ✅ **Agent state machine extracted** — `computeAgentState` / `hasLiveHookState` / `looksLikeShellPrompt` live in a pure, DOM-free module (`agent_state.mjs`). The sidebar delegates via two 1-line wrappers; ~40 lines of duplicated logic removed.
- `v0.1.5` tagged.

**Competitors:** no significant category moves observed in this window.

## What changed 2026-05-25 → 2026-05-31

**wmux (the doc was understating us):**

- ✅ **Worktree isolation shipped** (`feat(worktree): on-demand git worktree isolation per pane`, 2026-05-25 22:36) — closing the prior doc's #1 "no longer defensible" gap ~6 hours after it was written.
- ⚠️ **Codex lifecycle hooks added** (`feat(hooks)`, 2026-05-25 23:12) — the hooks gap goes from 1 harness to 2 (Claude + Codex).
- Workbook custom-HTML + bidirectional state loop; browser/MD/PR pane screenshots in workspace share; collab viewer canvas renderer + host-size mirroring.
- Heavy SSH/WSL hardening: WSL key auto-copy, tunnel-failure detection, VDI/admin updater paths, **dynamic HTTP port + non-inheritable socket** (security), WSL self-heal MCP + one-click firewall fix. 0.1.0 → 0.1.4.
- **Untouched:** GPU renderer; true process persistence.

**Competitors (pressure went up):**

- **Warp** — weekly cadence (stable v0.2026.05.27, daily dev). **Agents 3.0** (full terminal use / plan / code review / integration). Vertical agent tabs now show git branch + **worktree** + PR metadata. May–Jun roadmap: best-of-k, subagents, **control the Warp client via CLI** (the nearest anyone is creeping toward wmux's external-drive niche).
- **Zed** — **Terminal Threads went live 2026-05-20**: run claude/codex/amp/any terminal as managed sidebar threads; "the only way to keep using Claude Code in Zed with your subscription." Plus agent skills, global `AGENTS.md`, MCP image output. Erodes the "Zed is just an editor" framing — but still **no tmux-style terminal layouts** (#16174).
- **herdr** — **native agent session restore** (`resume_agents_on_restore`): Claude/Codex/OpenCode/Hermes/Pi panes restart into their *previous conversation* after a server restart. Widens herdr's lead on the persistence axis. POSIX-only.
- **mux (coder)** — **Windows support now in alpha** (Git Bash required, **no WSL**) + git-divergence dashboard. Directly contests wmux's "only Windows-first" claim.
- **cmux** — fast point releases to ~v0.64.10, ~18k stars, command palette, cross-window workspace move, Claude Code Teams; worktree still rough (#156). macOS-only.
- **t3code** — v0.0.24, now Codex-CLI-based, tri-platform, still pre-1.0.

## Where wmux is genuinely still ahead

These four held through the week and are the real defensible core:

1. **MCP server + Code Mode.** Still the only tool that exposes *itself* as an MCP server for an external agent to drive, with a JS-sandbox (`wmux_eval`) that collapses N round-trips into one. Warp's "control via CLI" roadmap is the closest threat and isn't shipped.
2. **Local-first, real-time, multi-device pane/workspace share** over Tailscale — no cloud, no broker, no account. Warp's live share is cloud-only; Zed's DeltaDB is code-state sync, not pane share.
3. **First-class WSL depth** — per-distro shell-flavor detection, key handling, reverse-tunneled API. This is the durable core of the old "Windows-first" moat now that mux ships Windows-alpha *without* WSL and Windows Terminal isn't an agent-multiplexer.
4. **`tmux.exe` shim** for tmux-driven harnesses on Windows.

## Where wmux lags

### Process / agent persistence (the namesake gap, now widening)

wmux "session restore" rebuilds the **layout graph + scrollback text**; the live process is dead and agents do not resume their conversation. herdr now restarts agents into their previous conversation after a server restart; Warp and mux persist sessions too. For a tool named `-mux`, true persistence is the most conspicuous missing primitive, and a competitor extended its lead here this week. **Highest-leverage gap.** See [`roadmap.md`](../roadmap.md).

### GPU-accelerated renderer

xterm.js over WebView2 vs Rust/Metal/D3D11 (Zed), Rust GPU (Warp), libghostty (cmux). Untouched; the perception gap widens every competitor release.

### Multi-harness lifecycle hooks

Now 2 of ~6 (Claude + Codex). cmux covers 14+ agents with richer events (incl. `PermissionRequest`); herdr covers 14+ via socket. The state machine's `ready`/`idle`/`blocked` still leans on screen-scraping for everything but the two hooked harnesses.

### Cross-platform reach / moat erosion

Windows-only by design. The "only Windows-first agent terminal" line is no longer clean: **mux shipped Windows alpha**, and **Windows Terminal** is being pushed as a Warp rival on the same platform. Reframe the pitch around **WSL depth + MCP server**, not "Windows."

### Editor integration

Zed's ACP (+ now Terminal Threads) puts agents next to file tree/git/diff. wmux's nearest equivalent is a read-only PR-review pane.

### Maturity / bus factor

Solo maintainer, v0.1.x, **82 frontend tests** (closed the 0-test gap — agent state machine, session-restore round-trip, init normalization, worktree helpers, syntax-check suite), several flagship features days-old. Every "only we do X" advantage is one a funded incumbent could ship in a sprint if the market validates it. This is the real ceiling, and it isn't a feature gap — it's a depth-and-sustainability gap.

## Tool-by-tool notes

### Warp ([warpdotdev/warp](https://github.com/warpdotdev/warp))
Open-source (AGPL core + MIT UI), all three platforms GA, **weekly** stable + daily dev. Agents 3.0 (full terminal use, plan, code review, integration). Universal Agent Support groups CLI agents (Claude Code, Codex, Gemini, OpenCode) into vertical tabs with git branch/worktree/PR metadata. Oz cloud orchestration (schedulable, event-triggered). May–Jun roadmap: best-of-k, subagents, conversation history, **CLI control of the client**. Still **MCP client only**. Where wmux beats Warp: MCP server, Code Mode, tmux shim, local-first share, in-pane browser, WSL depth. Where Warp beats wmux: renderer, polish, persistence, cadence, install base. Sources: [changelog](https://docs.warp.dev/changelog/2026/), [Agents 3.0](https://www.warp.dev/blog/agents-3-full-terminal-use-plan-code-review-integration), [Universal Agent Support](https://www.warp.dev/blog/universal-agent-support-level-up-coding-agent-warp), [roadmap #9233](https://github.com/warpdotdev/warp/issues/9233).

### cmux ([manaflow-ai/cmux](https://github.com/manaflow-ai/cmux))
macOS-only, GPL-3.0-or-later, libghostty, ~18k stars, very fast point releases (~v0.64.10). Vertical-tab workspaces with PR metadata, scriptable in-app browser, lifecycle hooks for 14+ agents (incl. `PermissionRequest`), Claude Code Teams. Worktree still NOT first-class (sidebar lacks a worktree indicator; new panes open in main dir; #156). No first-party MCP server. Not a wmux threat on platform (macOS-only) but the momentum benchmark. Source: [changelog](https://manaflow-ai-cmux.mintlify.app/resources/changelog).

### Zed ([zed-industries/zed](https://github.com/zed-industries/zed))
Editor first; 1.0 (Apr 29). **Parallel Agents** (Apr 22) + **Terminal Threads (May 20)** make it a credible parallel-agent terminal host: claude/codex/amp/any terminal as managed sidebar threads, per-thread model/worktree. ACP open standard (Claude Code, Codex, Gemini, Copilot, OpenCode, Cursor). DeltaDB CRDT for human+agent code-state sync. Still **no tmux-style terminal layouts** (#16174). Sources: [Terminal Threads](https://zed.dev/blog/terminal-threads), [Parallel Agents](https://zed.dev/blog/parallel-agents).

### herdr ([ogulcancelik/herdr](https://github.com/ogulcancelik/herdr))
Runs **inside** your existing terminal; single Rust binary. ~14 agent integrations forwarding semantic state over a socket. **New:** native **agent session restore** (`resume_agents_on_restore`) + searchable session navigator (prefix+g). True detach/reattach + agent-conversation resume — the persistence model wmux's restore only superficially resembles. POSIX-only. Source: [releases](https://github.com/ogulcancelik/herdr/releases).

### mux (coder) ([coder/mux](https://github.com/coder/mux))
By Coder. **Now Windows-alpha** (Git Bash required, **no WSL**) in addition to macOS/Linux. Three runtime modes (local/worktree/ssh); central **git-divergence dashboard** across workspaces; Plan/Exec/Review tri-mode; multi-model (Sonnet-4/Grok/GPT-5/Opus-4/Ollama). Strongest disciplined parallel-agent workflow. Sources: [repo](https://github.com/coder/mux), [install](https://mux.coder.com/install).

### t3code ([pingdotgg/t3code](https://github.com/pingdotgg/t3code))
GUI harness over CLI agents (now built on **Codex CLI** — BYO Codex subscription). MIT, Electron, tri-platform, v0.0.24, pre-1.0. Worktree task isolation, per-turn diff viewer, one-click PR. No multiplexing, no MCP, no automation API. Source: [releases](https://github.com/pingdotgg/t3code/releases).

## Strategic takeaway

The defensible core is now **four things**, not "Windows":

1. The only **MCP server + Code Mode** in the category.
2. The only **local-first, multi-device pane/workspace share**.
3. The deepest **WSL** integration (the survivable remnant of the Windows moat).
4. The only **`tmux.exe` shim**.

Worktrees are now table stakes (wmux has them; so does everyone). The exposed flanks are **process persistence** (herdr extended its lead this week), the **GPU renderer**, **multi-harness hooks** (2 of 6), and — above all — **maturity/bus-factor**. Gaps and the weekly recheck procedure live in [`roadmap.md`](../roadmap.md).
