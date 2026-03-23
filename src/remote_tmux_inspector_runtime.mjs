export function createRemoteTmuxInspectorRuntime({
  document,
  windowObject,
  invoke,
  tabs,
  panes,
  defaultTargetLabel,
  normalizeSshTarget,
  REMOTE_TMUX_SESSION_MODES,
  hasRemoteTmuxTab,
  isRemoteTmuxTarget,
  escHtml,
  updateTabMeta,
  probeRemoteTmuxMetadata,
  refreshRemoteTmuxTabHealth,
}) {
  let inspectorCleanup = null;
  let inspectorState = null;

  function closeInspector() {
    inspectorCleanup?.();
    inspectorCleanup = null;
    inspectorState = null;
  }

  function isOpenForTab(tabId) {
    return inspectorState?.tabId === tabId;
  }

  function getRemoteTmuxPaneForTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    return [...tab.paneIds]
      .map((paneId) => panes.get(paneId))
      .find((pane) => isRemoteTmuxTarget(pane?.target)) ?? null;
  }

  function quotePosixShellArg(value) {
    return `'${String(value ?? '').replace(/'/g, `"'"'`)}'`;
  }

  function remoteTmuxEndpointLabel(target) {
    const normalized = normalizeSshTarget(target);
    if (!normalized) return 'remote tmux';
    const host = normalized.user ? `${normalized.user}@${normalized.host}` : normalized.host;
    return normalized.port ? `${host}:${normalized.port}` : host;
  }

  async function sendRemoteTmuxCommand(tabId, command, { nextSessionName = null } = {}) {
    const pane = getRemoteTmuxPaneForTab(tabId);
    const tab = tabs.get(tabId);
    if (!pane || !tab) return false;

    await invoke('write_to_session', { id: pane.sessionId, data: `${command}\r` });

    if (nextSessionName && isRemoteTmuxTarget(pane.target)) {
      pane.target = {
        ...pane.target,
        session_name: nextSessionName,
        session_mode: REMOTE_TMUX_SESSION_MODES.ATTACH,
      };
      tab.remoteTmuxSessionName = nextSessionName;
      tab.targetLabel = defaultTargetLabel(pane.target);
      tab.connectionStatus = 'connecting';
      updateTabMeta(tabId);
    }

    await new Promise((resolve) => windowObject.setTimeout(resolve, 180));
    await probeRemoteTmuxMetadata(tabId, pane.sessionId, pane.target);
    if (isOpenForTab(tabId)) {
      await refreshInspector({ force: true, preserveSelection: true });
    }
    return true;
  }

  async function manageRemoteTmux(tabId, scope, action, { tmuxTarget = null, name = null } = {}) {
    const pane = getRemoteTmuxPaneForTab(tabId);
    const target = normalizeSshTarget(pane?.target);
    if (!pane || !target || target.type !== 'remote_tmux') return null;

    const result = await invoke('manage_remote_tmux', {
      target,
      scope,
      action,
      tmuxTarget,
      name,
    });

    if (isOpenForTab(tabId)) {
      await refreshInspector({ force: true, preserveSelection: true });
    }
    return result;
  }

  function promptRemoteTmuxName(message, defaultValue = '') {
    const value = windowObject.prompt(message, defaultValue);
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  async function createRemoteTmuxSession(tabId) {
    const state = inspectorState;
    const sessionName = promptRemoteTmuxName(
      'New remote tmux session name',
      state?.selectedSessionName ? `${state.selectedSessionName}-2` : 'team-shell',
    );
    if (!sessionName) return false;
    await manageRemoteTmux(tabId, 'session', 'create', { name: sessionName });
    await switchRemoteTmuxSession(tabId, sessionName);
    return true;
  }

  async function renameRemoteTmuxSession(tabId, sessionName) {
    const nextName = promptRemoteTmuxName(`Rename remote tmux session ${sessionName}`, sessionName);
    if (!nextName || nextName === sessionName) return false;
    await manageRemoteTmux(tabId, 'session', 'rename', { tmuxTarget: sessionName, name: nextName });
    const pane = getRemoteTmuxPaneForTab(tabId);
    const tab = tabs.get(tabId);
    if (pane && tab && isRemoteTmuxTarget(pane.target) && tab.remoteTmuxSessionName === sessionName) {
      pane.target = { ...pane.target, session_name: nextName };
      tab.remoteTmuxSessionName = nextName;
      tab.targetLabel = defaultTargetLabel(pane.target);
    }
    await refreshRemoteTmuxTabHealth(tabId, { force: true });
    await refreshInspector({ force: true, preserveSelection: false });
    return true;
  }

  async function killRemoteTmuxSession(tabId, sessionName, isCurrent) {
    const confirmed = windowObject.confirm(`Kill remote tmux session ${sessionName}?${isCurrent ? ' This is the current session for this wmux tab.' : ''}`);
    if (!confirmed) return false;
    await manageRemoteTmux(tabId, 'session', 'kill', { tmuxTarget: sessionName });
    if (isCurrent) {
      await refreshRemoteTmuxTabHealth(tabId, { force: true });
    }
    await refreshInspector({ force: true, preserveSelection: false });
    return true;
  }

  async function createRemoteTmuxWindow(tabId, sessionName) {
    const windowName = promptRemoteTmuxName(`New window name for session ${sessionName}`, 'editor');
    if (!windowName) return false;
    const result = await manageRemoteTmux(tabId, 'window', 'create', { tmuxTarget: sessionName, name: windowName });
    if (result?.resolved_target) {
      await switchRemoteTmuxWindow(tabId, result.resolved_target);
    }
    return true;
  }

  async function renameRemoteTmuxWindow(tabId, windowId, windowName) {
    const nextName = promptRemoteTmuxName(`Rename remote tmux window ${windowName || windowId}`, windowName || 'window');
    if (!nextName || nextName === windowName) return false;
    await manageRemoteTmux(tabId, 'window', 'rename', { tmuxTarget: windowId, name: nextName });
    await refreshRemoteTmuxTabHealth(tabId, { force: true });
    await refreshInspector({ force: true, preserveSelection: true });
    return true;
  }

  async function killRemoteTmuxWindow(tabId, windowId, windowName, isCurrent) {
    const confirmed = windowObject.confirm(`Kill remote tmux window ${windowName || windowId}?${isCurrent ? ' This is the current window for this wmux tab.' : ''}`);
    if (!confirmed) return false;
    await manageRemoteTmux(tabId, 'window', 'kill', { tmuxTarget: windowId });
    await refreshRemoteTmuxTabHealth(tabId, { force: true });
    await refreshInspector({ force: true, preserveSelection: false });
    return true;
  }

  async function switchRemoteTmuxSession(tabId, sessionName) {
    return sendRemoteTmuxCommand(
      tabId,
      `tmux switch-client -t ${quotePosixShellArg(sessionName)}`,
      { nextSessionName: sessionName },
    );
  }

  async function switchRemoteTmuxWindow(tabId, windowId) {
    return sendRemoteTmuxCommand(tabId, `tmux select-window -t ${quotePosixShellArg(windowId)}`);
  }

  async function switchRemoteTmuxPane(tabId, paneId) {
    return sendRemoteTmuxCommand(tabId, `tmux select-pane -t ${quotePosixShellArg(paneId)}`);
  }

  function renderInspector() {
    const panel = document.getElementById('remote-tmux-inspector');
    const state = inspectorState;
    if (!panel || !state) return;

    const body = panel.querySelector('.rti-body');
    const titleEl = panel.querySelector('.rti-title');
    const subtitleEl = panel.querySelector('.rti-subtitle');
    const refreshBtn = panel.querySelector('[data-action="refresh"]');
    const closeBtn = panel.querySelector('[data-action="close"]');

    const tab = tabs.get(state.tabId);
    const remotePane = getRemoteTmuxPaneForTab(state.tabId);
    titleEl.textContent = tab ? `Remote tmux - ${tab.title}` : 'Remote tmux';
    subtitleEl.textContent = remotePane ? remoteTmuxEndpointLabel(remotePane.target) : 'Remote tmux tab not available';

    refreshBtn.onclick = () => { void refreshInspector({ force: true, preserveSelection: true }); };
    closeBtn.onclick = () => closeInspector();

    if (!tab || !remotePane) {
      body.innerHTML = '<div class="rti-empty">This remote tmux tab is no longer available.</div>';
      return;
    }

    if (state.loading) {
      body.innerHTML = '<div class="rti-loading">Loading remote tmux sessions, windows, and panes...</div>';
      return;
    }

    if (state.error) {
      body.innerHTML = `
        <div class="rti-error">${escHtml(state.error)}</div>
        <button class="rti-inline-action" data-action="retry">Retry</button>
      `;
      body.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
        void refreshInspector({ force: true, preserveSelection: true });
      });
      return;
    }

    const data = state.data;
    if (!data?.sessions?.length) {
      body.innerHTML = '<div class="rti-empty">No remote tmux sessions were found.</div>';
      return;
    }

    const selectedSession = data.sessions.find((session) => session.session_name === state.selectedSessionName)
      ?? data.sessions.find((session) => session.session_name === data.current_session_name)
      ?? data.sessions[0];
    state.selectedSessionName = selectedSession?.session_name ?? '';

    const selectedWindow = selectedSession?.windows.find((windowState) => windowState.window_id === state.selectedWindowId)
      ?? selectedSession?.windows.find((windowState) => windowState.window_id === data.current_window_id)
      ?? selectedSession?.windows[0]
      ?? null;
    state.selectedWindowId = selectedWindow?.window_id ?? '';

    body.innerHTML = `
      <div class="rti-grid">
        <section class="rti-column">
          <div class="rti-column-head">
            <div class="rti-column-title">Sessions</div>
            <button class="rti-mini-action" data-action="new-session">New</button>
          </div>
          <div class="rti-list rti-sessions"></div>
        </section>
        <section class="rti-column">
          <div class="rti-column-head">
            <div class="rti-column-title">Windows</div>
            <button class="rti-mini-action" data-action="new-window" ${selectedSession ? '' : 'disabled'}>New</button>
          </div>
          <div class="rti-list rti-windows"></div>
        </section>
        <section class="rti-column">
          <div class="rti-column-title">Panes</div>
          <div class="rti-list rti-panes"></div>
        </section>
      </div>
    `;

    const sessionsEl = body.querySelector('.rti-sessions');
    const windowsEl = body.querySelector('.rti-windows');
    const panesEl = body.querySelector('.rti-panes');

    for (const session of data.sessions) {
      const row = document.createElement('div');
      row.className = `rti-row${session.session_name === state.selectedSessionName ? ' is-selected' : ''}${session.is_current ? ' is-current' : ''}`;
      row.innerHTML = `
        <button class="rti-main" data-session-name="${escHtml(session.session_name)}">
          <span class="rti-primary">${escHtml(session.session_name)}</span>
          <span class="rti-secondary">${session.window_count} windows · ${session.attached_clients} clients</span>
        </button>
        <button class="rti-action" data-switch-session="${escHtml(session.session_name)}" ${session.is_current ? 'disabled' : ''}>Switch</button>
        <button class="rti-action" data-rename-session="${escHtml(session.session_name)}">Rename</button>
        <button class="rti-action danger" data-kill-session="${escHtml(session.session_name)}">Kill</button>
      `;
      sessionsEl.appendChild(row);
    }

    if (!selectedSession?.windows?.length) {
      windowsEl.innerHTML = '<div class="rti-empty">No windows in this session.</div>';
    } else {
      for (const windowState of selectedSession.windows) {
        const row = document.createElement('div');
        row.className = `rti-row${windowState.window_id === state.selectedWindowId ? ' is-selected' : ''}${windowState.window_id === data.current_window_id ? ' is-current' : ''}`;
        row.innerHTML = `
          <button class="rti-main" data-window-id="${escHtml(windowState.window_id)}">
            <span class="rti-primary">${escHtml(`${windowState.window_index}: ${windowState.window_name || 'window'}`)}</span>
            <span class="rti-secondary">${windowState.panes.length} panes · ${escHtml(windowState.window_id)}</span>
          </button>
          <button class="rti-action" data-switch-window="${escHtml(windowState.window_id)}" ${windowState.window_id === data.current_window_id ? 'disabled' : ''}>Switch</button>
          <button class="rti-action" data-rename-window="${escHtml(windowState.window_id)}">Rename</button>
          <button class="rti-action danger" data-kill-window="${escHtml(windowState.window_id)}">Kill</button>
        `;
        windowsEl.appendChild(row);
      }
    }

    if (!selectedWindow?.panes?.length) {
      panesEl.innerHTML = '<div class="rti-empty">No panes in this window.</div>';
    } else {
      for (const paneState of selectedWindow.panes) {
        const row = document.createElement('div');
        row.className = `rti-row${paneState.pane_id === data.current_pane_id ? ' is-current' : ''}`;
        row.innerHTML = `
          <div class="rti-main rti-pane-main">
            <span class="rti-primary">${escHtml(`${paneState.pane_index}: ${paneState.current_command || paneState.title || paneState.pane_id}`)}</span>
            <span class="rti-secondary">${escHtml([
              paneState.cwd || paneState.title || paneState.pane_id,
              paneState.command_age ? `age ${paneState.command_age}` : '',
              paneState.was_last_active ? 'last-active' : '',
            ].filter(Boolean).join(' · '))}</span>
          </div>
          <button class="rti-action" data-switch-pane="${escHtml(paneState.pane_id)}" ${paneState.pane_id === data.current_pane_id ? 'disabled' : ''}>Select</button>
        `;
        panesEl.appendChild(row);
      }
    }

    sessionsEl.querySelectorAll('[data-session-name]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedSessionName = btn.dataset.sessionName ?? '';
        state.selectedWindowId = '';
        renderInspector();
      });
    });
    sessionsEl.querySelectorAll('[data-switch-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void switchRemoteTmuxSession(state.tabId, btn.dataset.switchSession ?? '');
      });
    });
    sessionsEl.querySelectorAll('[data-rename-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void renameRemoteTmuxSession(state.tabId, btn.dataset.renameSession ?? '');
      });
    });
    sessionsEl.querySelectorAll('[data-kill-session]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sessionName = btn.dataset.killSession ?? '';
        void killRemoteTmuxSession(state.tabId, sessionName, sessionName === data.current_session_name);
      });
    });
    windowsEl.querySelectorAll('[data-window-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedWindowId = btn.dataset.windowId ?? '';
        renderInspector();
      });
    });
    windowsEl.querySelectorAll('[data-switch-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void switchRemoteTmuxWindow(state.tabId, btn.dataset.switchWindow ?? '');
      });
    });
    windowsEl.querySelectorAll('[data-rename-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const windowId = btn.dataset.renameWindow ?? '';
        const windowState = selectedSession?.windows.find((candidate) => candidate.window_id === windowId);
        void renameRemoteTmuxWindow(state.tabId, windowId, windowState?.window_name ?? '');
      });
    });
    windowsEl.querySelectorAll('[data-kill-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const windowId = btn.dataset.killWindow ?? '';
        const windowState = selectedSession?.windows.find((candidate) => candidate.window_id === windowId);
        void killRemoteTmuxWindow(state.tabId, windowId, windowState?.window_name ?? '', windowId === data.current_window_id);
      });
    });
    panesEl.querySelectorAll('[data-switch-pane]').forEach((btn) => {
      btn.addEventListener('click', () => {
        void switchRemoteTmuxPane(state.tabId, btn.dataset.switchPane ?? '');
      });
    });
    body.querySelector('[data-action="new-session"]')?.addEventListener('click', () => {
      void createRemoteTmuxSession(state.tabId);
    });
    body.querySelector('[data-action="new-window"]')?.addEventListener('click', () => {
      if (selectedSession?.session_name) {
        void createRemoteTmuxWindow(state.tabId, selectedSession.session_name);
      }
    });
  }

  async function refreshInspector({ force = false, preserveSelection = false } = {}) {
    const state = inspectorState;
    if (!state) return;
    const pane = getRemoteTmuxPaneForTab(state.tabId);
    const target = normalizeSshTarget(pane?.target);
    if (!pane || !target || target.type !== 'remote_tmux') {
      state.error = 'Remote tmux pane is not available.';
      state.data = null;
      state.loading = false;
      renderInspector();
      return;
    }

    if (!force && state.loading) return;

    const previousSessionName = preserveSelection ? state.selectedSessionName : '';
    const previousWindowId = preserveSelection ? state.selectedWindowId : '';
    state.loading = true;
    state.error = '';
    renderInspector();

    try {
      state.data = await invoke('inspect_remote_tmux_state', { target });
      state.selectedSessionName = previousSessionName || state.data.current_session_name || state.data.sessions[0]?.session_name || '';
      const currentSession = state.data.sessions.find((session) => session.session_name === state.selectedSessionName);
      state.selectedWindowId = previousWindowId || state.data.current_window_id || currentSession?.windows[0]?.window_id || '';
    } catch (err) {
      state.data = null;
      state.error = String(err);
    } finally {
      state.loading = false;
      renderInspector();
    }
  }

  async function openInspector(tabId, { forceRefresh = false } = {}) {
    if (!hasRemoteTmuxTab(tabId)) return;
    const previousState = inspectorState;
    closeInspector();

    const panel = document.createElement('div');
    panel.id = 'remote-tmux-inspector';
    panel.className = 'remote-tmux-inspector';
    panel.innerHTML = `
      <div class="rti-header">
        <div>
          <div class="rti-title">Remote tmux</div>
          <div class="rti-subtitle"></div>
        </div>
        <div class="rti-header-actions">
          <button class="rti-header-btn" data-action="refresh">Refresh</button>
          <button class="rti-header-btn" data-action="close">Close</button>
        </div>
      </div>
      <div class="rti-body"></div>
    `;
    document.body.appendChild(panel);

    const onEscape = (event) => {
      if (event.key === 'Escape') closeInspector();
    };
    inspectorCleanup = () => {
      panel.remove();
      document.removeEventListener('keydown', onEscape);
    };
    document.addEventListener('keydown', onEscape);

    inspectorState = {
      tabId,
      loading: false,
      error: '',
      data: null,
      selectedSessionName: previousState?.tabId === tabId ? previousState.selectedSessionName : '',
      selectedWindowId: previousState?.tabId === tabId ? previousState.selectedWindowId : '',
    };
    renderInspector();
    await refreshInspector({ force: forceRefresh || previousState?.tabId !== tabId, preserveSelection: true });
  }

  return {
    closeInspector,
    isOpenForTab,
    getRemoteTmuxPaneForTab,
    renderInspector,
    refreshInspector,
    openInspector,
  };
}