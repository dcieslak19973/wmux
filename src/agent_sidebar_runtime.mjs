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
}) {
  let sidebarEl = null;
  let refreshTimer = null;

  // ── Status helpers ──────────────────────────────────────────────────────

  function isRunning(pane) {
    const last = pane.blocks?.[pane.blocks.length - 1];
    return last != null && last.exitCode === null;
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

  function createPaneItem(summary, pane, running, lastCmd) {
    const el = document.createElement('div');
    el.className = `agent-sidebar-item${running ? ' running' : ''}${summary.active ? ' active' : ''}`;
    el.dataset.paneId = summary.paneId;
    el.innerHTML = `
      <div class="agent-item-top">
        <span class="agent-status-dot ${running ? 'running' : 'idle'}"></span>
        <span class="agent-item-name">${escHtml(summary.paneTitle || summary.targetLabel)}</span>
        <button class="agent-kill-btn" title="Close pane">&#x2715;</button>
      </div>
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
    if (!sidebarEl) return;
    const listEl = sidebarEl.querySelector('.agent-sidebar-list');
    if (!listEl) return;

    const summaries = listPaneSummaries();
    const currentIds = new Set(summaries.map((s) => s.paneId));

    // Remove stale entries
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
      const running = isRunning(pane);
      const lastCmd = getLastCommand(pane);

      let el = listEl.querySelector(`[data-pane-id="${summary.paneId}"]`);
      if (!el) {
        el = createPaneItem(summary, pane, running, lastCmd);
        listEl.appendChild(el);
      } else {
        // In-place update — avoids losing hover state on kill button
        el.classList.toggle('running', running);
        el.classList.toggle('active', summary.active);
        const dot = el.querySelector('.agent-status-dot');
        if (dot) { dot.className = `agent-status-dot ${running ? 'running' : 'idle'}`; }
        const cmdEl = el.querySelector('.agent-item-cmd');
        if (cmdEl && lastCmd) {
          cmdEl.textContent = lastCmd;
          cmdEl.classList.remove('agent-item-cmd-empty');
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
    sidebarEl.querySelector('.agent-spawn-btn').addEventListener('click', () => {
      createTab(getDefaultTarget());
    });

    refresh();
    refreshTimer = setInterval(refresh, 600);
  }

  function close() {
    sidebarEl?.remove();
    sidebarEl = null;
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  function toggle() {
    if (sidebarEl) close(); else open();
  }

  function isOpen() { return !!sidebarEl; }

  return { toggle, open, close, isOpen, refresh };
}
