export function createAgentSidebarRuntime({
  document,
  panes,
  listPaneSummaries,
  activateTab,
  activatePane,
  closePane,
  createTab,
  getDefaultTarget,
  escHtml,
  addNotification = () => {},
  clearPaneNotifications = () => {},
}) {
  let sidebarEl = null;
  let _refreshing = false;
  const prevStates = new Map();       // paneId → last known state
  const lastNotifyTime = new Map();   // paneId → timestamp of last blocked notification
  // Authoritative hook state from Claude Code lifecycle hooks.
  const hookStates = new Map();       // paneId → { hook_event, tool, message, event_ms }

  // Hook events older than this are considered stale; fall back to screen-scraping.
  const HOOK_STALE_MS = 5 * 60 * 1000;

  // ── Agent registry ──────────────────────────────────────────────────────

  const AGENTS = {
    'claude':   { label: 'Claude',   color: '#d97706', bg: 'rgba(217,119,6,0.15)',   border: 'rgba(217,119,6,0.35)' },
    'codex':    { label: 'Codex',    color: '#10b981', bg: 'rgba(16,185,129,0.15)',  border: 'rgba(16,185,129,0.35)' },
    'gemini':   { label: 'Gemini',   color: '#4285f4', bg: 'rgba(66,133,244,0.15)',  border: 'rgba(66,133,244,0.35)' },
    'opencode': { label: 'OpenCode', color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.35)' },
    'aider':    { label: 'Aider',    color: '#ec4899', bg: 'rgba(236,72,153,0.15)',  border: 'rgba(236,72,153,0.35)' },
    'amp':      { label: 'Amp',      color: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  border: 'rgba(245,158,11,0.35)' },
  };

  function detectAgent(pane) {
    if (pane.preferredAgent && AGENTS[pane.preferredAgent]) return AGENTS[pane.preferredAgent];
    if (!pane.blocks?.length) return null;
    for (let i = pane.blocks.length - 1; i >= 0; i--) {
      const cmd = pane.blocks[i].command;
      if (!cmd) continue;
      const bin = cmd.trim().split(/\s+/)[0].replace(/^.*[\\/]/, '').toLowerCase();
      if (AGENTS[bin]) return AGENTS[bin];
    }
    return null;
  }

  // ── Status helpers ──────────────────────────────────────────────────────

  const BLOCKED_MIN_MS = 8_000;
  const BLOCKED_MAX_MS = 30 * 60 * 1000;
  const NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;

  // Track visible screen content changes (bottom 10 rows of the terminal buffer).
  function tickScreenSnapshot(pane) {
    const screen = pane.serializeAddon?.serialize({ rows: 10 }) ?? null;
    if (screen !== null && screen !== pane._screenSnapshot) {
      pane._screenSnapshot = screen;
      pane._screenSnapshotTime = Date.now();
      pane._screenChangeCount = (pane._screenChangeCount ?? 0) + 1;
    }
  }

  // Shell prompt suffixes — deliberately narrow: bash ($), zsh (%), root (#).
  // Exclude ❯ and > because Claude Code's interactive menus also end lines with those.
  const SHELL_PROMPT_RE = /[$%#]\s*$/;

  function looksLikeShellPrompt(snapshot) {
    if (!snapshot) return false;
    const plain = snapshot.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const lines = plain.split(/\r?\n/).filter((l) => l.trim());
    const last = lines[lines.length - 1] ?? '';
    return SHELL_PROMPT_RE.test(last);
  }

  function agentState(pane) {
    // Prefer authoritative hook state when it's fresh.
    const hook = hookStates.get(pane.sessionId);
    if (hook && Date.now() - hook.event_ms < HOOK_STALE_MS) {
      switch (hook.hook_event) {
        case 'PreToolUse':
        case 'PostToolUse':
        case 'UserPromptSubmit':
          return 'working';
        case 'Stop':
          return 'completed';
        case 'Notification':
          // Keep showing previous state; notification is supplemental.
          return prevStates.get(pane.sessionId) ?? 'working';
      }
    }

    // Fall back to screen-scraping heuristics.

    // OSC 133 panes: if last block finished, the agent process exited.
    if (pane.blocks?.length > 0 && pane.blocks[pane.blocks.length - 1].ended_ms) return 'ready';

    // Need at least a few screen changes before we can meaningfully detect state,
    // to avoid false positives on panes that just opened.
    const changes = pane._screenChangeCount ?? 0;
    if (!pane._screenSnapshotTime || changes < 3) return 'idle';

    const sinceLastChange = Date.now() - pane._screenSnapshotTime;
    if (sinceLastChange < BLOCKED_MIN_MS) return 'working';

    // Screen has been stable for 8 s+. Decide what that means:
    // - Shell prompt visible → agent exited, pane is ready for a new task.
    // - No shell prompt → some TUI (agent, vim, etc.) is waiting for input.
    if (looksLikeShellPrompt(pane._screenSnapshot)) return 'ready';
    if (sinceLastChange < BLOCKED_MAX_MS) return 'blocked';
    return 'idle';
  }

  function hasLiveHookState(pane) {
    const hook = hookStates.get(pane.sessionId);
    return !!(hook && Date.now() - hook.event_ms < HOOK_STALE_MS);
  }

  function getLastCommand(pane) {
    if (pane.blocks) {
      for (let i = pane.blocks.length - 1; i >= 0; i--) {
        if (pane.blocks[i].command) return pane.blocks[i].command;
      }
    }
    return null;
  }

  // ── Item creation ───────────────────────────────────────────────────────

  function agentBadgeHtml(agent) {
    if (!agent) return '';
    return `<span class="agent-badge" style="color:${agent.color};background:${agent.bg};border-color:${agent.border}">${escHtml(agent.label)}</span>`;
  }

  function createPaneItem(summary, pane, state, lastCmd) {
    const agent = detectAgent(pane);
    const hook = hookStates.get(summary.paneId);
    const live = hasLiveHookState(pane);
    const notifMsg = live && hook?.hook_event === 'Notification' ? hook.message : null;
    const el = document.createElement('div');
    el.className = `agent-sidebar-item${state === 'working' || state === 'ready' ? ' running' : ''}${state === 'blocked' ? ' blocked' : ''}${state === 'completed' ? ' completed' : ''}${summary.active ? ' active' : ''}`;
    el.dataset.paneId = summary.paneId;
    el.dataset.agent = agent?.label ?? '';
    el.innerHTML = `
      <div class="agent-item-top">
        <span class="agent-status-dot ${state}"></span>
        <span class="agent-item-name">${escHtml(summary.paneTitle || summary.targetLabel)}</span>
        ${agentBadgeHtml(agent)}
        ${live ? '<span class="agent-live-badge" title="Authoritative state via Claude Code hooks">live</span>' : ''}
        <button class="agent-kill-btn" title="Close pane">&#x2715;</button>
      </div>
      ${notifMsg ? `<div class="agent-item-notif">${escHtml(notifMsg)}</div>` : ''}
      ${lastCmd ? `<div class="agent-item-cmd">${escHtml(lastCmd)}</div>` : '<div class="agent-item-cmd agent-item-cmd-empty">no commands yet</div>'}
      <div class="agent-item-meta">
        <span class="agent-item-ws">${escHtml(summary.workspaceName)}</span>
        ${summary.gitBranch ? `<span class="agent-item-branch">${escHtml(summary.gitBranch)}</span>` : ''}
        ${summary.cwd ? `<span class="agent-item-cwd">${escHtml(shortCwd(summary.cwd))}</span>` : ''}
      </div>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.agent-kill-btn')) return;
      activateTab(summary.tabId);
      activatePane(summary.paneId);
    });
    el.querySelector('.agent-kill-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closePane(summary.paneId);
    });
    return el;
  }

  function shortCwd(cwd) {
    const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) return '';
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
  }

  // ── Render / refresh ────────────────────────────────────────────────────

  function refresh() {
    if (_refreshing) return;
    _refreshing = true;
    try { _refresh(); } finally { _refreshing = false; }
  }

  function _refresh() {
    const summaries = listPaneSummaries();

    // Tick screen snapshots and compute states
    for (const summary of summaries) {
      const pane = panes.get(summary.paneId);
      if (!pane) continue;
      tickScreenSnapshot(pane);

      const state = agentState(pane);
      const prev = prevStates.get(summary.paneId);

      // H2: notify on →blocked, but only for panes running a known agent
      if (state === 'blocked' && prev !== 'blocked') {
        const agent = detectAgent(pane);
        const lastNotify = lastNotifyTime.get(summary.paneId) ?? 0;
        if (agent && Date.now() - lastNotify > NOTIFY_COOLDOWN_MS) {
          const lastCmd = getLastCommand(pane);
          addNotification(pane.tabId, {
            title: `${agent.label} waiting for input`,
            body: lastCmd ? `Last command: ${lastCmd}` : 'Agent is waiting for your input.',
            paneId: summary.paneId,
            time: Date.now(),
          });
          lastNotifyTime.set(summary.paneId, Date.now());
        }
      }

      // Clear notification when agent exits or starts working again
      if (prev === 'blocked' && state !== 'blocked') {
        clearPaneNotifications(pane.tabId, summary.paneId);
        lastNotifyTime.delete(summary.paneId);
      }

      prevStates.set(summary.paneId, state);
    }

    // Clean up closed panes
    for (const id of prevStates.keys()) {
      if (!panes.has(id)) {
        prevStates.delete(id);
        lastNotifyTime.delete(id);
      }
    }

    // H3: AG button badge — blocked count across all workspaces
    const blockedCount = summaries.filter((s) => {
      const p = panes.get(s.paneId);
      return p && agentState(p) === 'blocked';
    }).length;
    const agBtn = document.getElementById('btn-agent-sidebar');
    if (agBtn) {
      let badge = agBtn.querySelector('.ag-blocked-badge');
      if (blockedCount > 0) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'ag-blocked-badge';
          agBtn.appendChild(badge);
        }
        badge.textContent = String(blockedCount);
      } else {
        badge?.remove();
      }
    }

    if (!sidebarEl) return;
    const listEl = sidebarEl.querySelector('.agent-sidebar-list');
    if (!listEl) return;

    const currentIds = new Set(summaries.map((s) => s.paneId));
    for (const el of [...listEl.querySelectorAll('[data-pane-id]')]) {
      if (!currentIds.has(el.dataset.paneId)) el.remove();
    }

    if (!summaries.length) {
      if (!listEl.querySelector('.agent-sidebar-empty')) {
        listEl.innerHTML = '<div class="agent-sidebar-empty">No terminal panes open.</div>';
      }
      return;
    }
    listEl.querySelector('.agent-sidebar-empty')?.remove();

    for (const summary of summaries) {
      const pane = panes.get(summary.paneId);
      if (!pane) continue;
      const state = agentState(pane);
      const lastCmd = getLastCommand(pane);

      let el = listEl.querySelector(`[data-pane-id="${summary.paneId}"]`);
      if (!el) {
        el = createPaneItem(summary, pane, state, lastCmd);
        listEl.appendChild(el);
      } else {
        el.classList.toggle('running', state === 'working' || state === 'ready');
        el.classList.toggle('blocked', state === 'blocked');
        el.classList.toggle('active', summary.active);
        const dot = el.querySelector('.agent-status-dot');
        if (dot) dot.className = `agent-status-dot ${state}`;
        const cmdEl = el.querySelector('.agent-item-cmd');
        if (cmdEl && lastCmd) {
          cmdEl.textContent = lastCmd;
          cmdEl.classList.remove('agent-item-cmd-empty');
        }
        const agent = detectAgent(pane);
        const agentLabel = agent?.label ?? '';
        if (el.dataset.agent !== agentLabel) {
          el.dataset.agent = agentLabel;
          const existing = el.querySelector('.agent-badge');
          const killBtn = el.querySelector('.agent-kill-btn');
          if (existing) existing.remove();
          if (agent) {
            const badge = document.createElement('span');
            badge.className = 'agent-badge';
            badge.style.color = agent.color;
            badge.style.background = agent.bg;
            badge.style.borderColor = agent.border;
            badge.textContent = agent.label;
            killBtn?.insertAdjacentElement('beforebegin', badge);
          }
        }
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  function open() {
    if (sidebarEl) return;
    sidebarEl = document.createElement('div');
    sidebarEl.className = 'agent-sidebar';
    sidebarEl.innerHTML = `
      <div class="agent-sidebar-header">
        <span class="agent-sidebar-title">Agents</span>
        <div class="agent-sidebar-actions">
          <button class="notif-btn agent-spawn-btn" title="New terminal tab">+ New</button>
          <button class="notif-close agent-sidebar-close">&#x2715;</button>
        </div>
      </div>
      <div class="agent-sidebar-list"></div>
    `;
    document.querySelector('#content')?.appendChild(sidebarEl);
    sidebarEl.querySelector('.agent-sidebar-close').addEventListener('click', close);
    sidebarEl.querySelector('.agent-spawn-btn').addEventListener('click', () => createTab(getDefaultTarget()));
    refresh();
  }

  function close() {
    sidebarEl?.remove();
    sidebarEl = null;
  }

  function toggle() { if (sidebarEl) close(); else open(); }
  function isOpen() { return !!sidebarEl; }

  function handleHookEvent(payload) {
    const { pane_id, hook_event, tool, message, event_ms } = payload ?? {};
    if (!pane_id) return;
    hookStates.set(pane_id, { hook_event, tool, message, event_ms });
    // Clear completed state once the user opens the pane (handled in activatePane).
    refresh();
  }

  setInterval(refresh, 600);

  return { toggle, open, close, isOpen, refresh, handleHookEvent };
}
