# wmux demo script — 15 minutes

**Audience:** developers / engineers  
**Goal:** show the four differentiators in sequence — parallel agent state, worktree isolation, MCP server, collab share

---

## Pre-demo setup checklist

Do all of this before the room fills up. Nothing in the demo should be a first-time action.

- [ ] Two panes split left/right, each running `claude` (Claude Code)
- [ ] Shell integration installed in both panes (`⚡` toolbar button → "Install")
- [ ] Claude Code lifecycle hooks installed in both panes (`HK` toolbar button → "Install")
- [ ] A local git repo checked out with a few recent commits
- [ ] `npm run dev` or a similar long-running command ready to paste
- [ ] Agent sidebar hidden (`Ctrl+Shift+A` to toggle off if it's open)
- [ ] Collab panel hidden
- [ ] Second device (phone or another laptop) on the same Tailscale network, browser open
- [ ] Tailscale running and connected on the host machine
- [ ] Run through the full script once end-to-end before going live

---

## Beat 1 — Parallel agents + live state detection (0:00–3:00)

**Say:**
> "Most people running parallel AI agents today have them all crammed into the same terminal, same directory, stepping on each other. wmux fixes that at the multiplexer level — it's a terminal that was built for parallel agents from the start."

**Do:**
1. Show the two Claude Code panes already running side by side — each working on something different
2. Press `Ctrl+Shift+A` — agent sidebar slides in on the right
3. Point to the status dots:
   - Green = **working** — "wmux is watching the Claude Code hooks in real time — this dot isn't a label I set, it's live from the lifecycle events Claude fires"
   - Grey = **idle**, orange = **blocked**
4. Let one pane's agent go **blocked** (waiting for input) — the sidebar dot turns orange and a badge appears on the AG toolbar button
5. Click that pane's entry in the sidebar — focus jumps directly to it
6. "The sidebar spans every workspace and tab, not just the visible one. If an agent in a background workspace gets stuck, you'll know."

**Key line:**
> "The sidebar is the control tower. You always know which agent needs attention."

---

## Beat 2 — Worktree isolation (3:00–6:00)

**Say:**
> "Now the bigger problem — two agents editing the same repo at the same time will conflict. They'll fight over the working tree. wmux solves this natively."

**Do:**
1. In the **left pane**, click the **WT** button in the pane toolbar
2. Menu appears — hit **"Create new worktree"**
3. wmux creates a fresh `git worktree` on a new branch; the shell `cd`s into it automatically
4. Point to the agent sidebar — the pane now shows a ⎇ chip with the branch name and a `↑0 ↓0` divergence counter
5. Do the same in the **right pane** — different branch name suggested automatically
6. Make a small edit in each pane — "These are completely independent working trees. No conflicts, no coordination needed. Each agent has its own sandbox."
7. In one pane, click **WT** → **"Remove worktree"** — the shell `cd`s back to the main repo automatically

**Key line:**
> "This is what git worktrees are built for. wmux makes them a one-click thing."

---

## Beat 3 — MCP server + Code Mode (6:00–10:30)

**Say:**
> "Here's the thing nobody else ships. wmux isn't just a place to run agents — it's an MCP server that agents can drive. An agent can create panes, read their output, send keystrokes, navigate workspaces. From inside a conversation."

**Do:**
1. Open a fresh pane and start Claude Code: `claude`
2. Paste this prompt:

   ```
   Split the current tab horizontally and start `npm run dev` in the new pane.
   ```

3. Watch Claude call `wmux_eval` — a new pane splits, `npm run dev` starts inside it
4. "Claude just created a pane. One tool call."
5. Paste a second prompt:

   ```
   Read the output from the dev server pane and tell me if there are any errors or warnings.
   ```

6. Watch Claude call `pane_read_screen` and respond with the content

**Say:**
> "This is Code Mode — the default MCP surface is a JavaScript sandbox where every wmux tool is a bound function. What would be 20 round-trip tool calls can become one script. No other terminal in this space ships itself as an MCP server."

**Key line:**
> "Every other terminal is a client. wmux is also a server."

---

## Beat 4 — Collab share over Tailscale (10:30–13:30)

**Say:**
> "Last one. I'm going to share this whole workspace to my phone, live — no cloud, no account, no broker."

**Do:**
1. Click the **Collab** panel button in the toolbar
2. Click **"Share workspace"** → choose **Read-only**
3. The share dialog appears with a list of URLs — point to the Tailnet URL:
   - "That's a direct connection over my Tailscale network. The traffic never leaves devices I control."
4. Copy the Tailnet URL and open it on the second device
5. The PWA viewer loads — the split layout mirrors in the browser, terminal output streaming live
6. Type something in one of the host panes — it appears in the viewer in real time
7. "If the viewer drops and reconnects, there's a replay buffer — it catches up automatically. No missed output."

**Say:**
> "Warp does real-time share too, but only through their cloud. Zed does code-state sync but not pane share. wmux does it locally, over your tailnet, for free."

**Key line:**
> "Local-first. Your data doesn't leave your network."

---

## Wrap (13:30–15:00)

**Say:**
> "So: parallel agents with live state detection, per-pane worktree isolation so they don't conflict, an MCP server agents can drive to orchestrate the workspace, and real-time multi-device share over Tailscale — no cloud required. Windows-native, WSL-aware, v0.1.5."

- Show the GitHub repo: `github.com/dcieslak19973/wmux`
- "It's open source, AGPL-3."
- Open for questions

---

## Contingency table

| What goes wrong | Recovery |
|---|---|
| **No "live" badge on agent state** | Lifecycle hooks aren't installed. Click `HK` in the toolbar — takes 10 seconds. Narrate it: "Let me install the Claude Code hooks so you can see the live state in action." |
| **WT button fires a manual path prompt** | Shell integration isn't active (no OSC 7). Click `⚡` → "Install" first. Or: narrate the fallback prompt as intentional — "You can also type a path directly." |
| **Tailscale URL doesn't load on second device** | Switch to the LAN URL from the same dialog — it's listed right below the Tailnet one. |
| **`wmux_eval` tool call fails or Claude can't find the tool** | Fall back to the `pane_read_screen` prompt only — it's equally concrete. Skip the split-and-start step, pick up from "Read the dev server output." |
| **Dev server pane has nothing interesting to show** | Have `npm test` running instead — it produces enough output and a clear pass/fail is easy to narrate. |
