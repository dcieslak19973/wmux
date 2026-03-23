export function createPaneAuxRuntime({
  invoke,
  document,
  tabs,
  panes,
  SETTINGS_DEFAULTS,
  getActiveTabId,
  setActiveTabId: _setActiveTabId,
  getActivePaneId,
  setActivePaneId: _setActivePaneId,
  getZoomedSurfaceEl,
  setZoomedSurfaceEl,
  getActiveWorkspaceId,
  getCurrentSurfaceElement,
  getActiveTabState,
  activatePane,
  activateBrowser,
  activateMarkdown,
  closeMarkdownSurface,
  closeBrowserSurface,
  closePane,
  loadSettings,
  saveSettings,
}) {
  async function updateTabCwd(tabId, cwd, options = {}) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    tab.cwd = cwd;
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    const short = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : (parts.join('/') || cwd);
    const el = tab.tabEl.querySelector('.tab-cwd');
    if (el) el.textContent = short;
    let gitContext = options.gitContext ?? null;
    let branch = options.gitBranch ?? '';
    if (!options.skipLocalGit) {
      try {
        gitContext = await invoke('get_git_context', { cwd });
        branch = gitContext?.branch ?? '';
      } catch {}
    }
    tab.gitBranch = branch;
    const bEl = tab.tabEl.querySelector('.tab-branch');
    if (bEl) bEl.textContent = branch ? `⎋ ${branch}` : '';
    return { shortCwd: short, gitContext };
  }

  async function fitAndResizePane(sessionId) {
    const pane = panes.get(sessionId);
    if (!pane) return;
    const tab = tabs.get(pane.tabId);
    if (!tab || !tab.contentEl.classList.contains('visible')) return;
    pane.fitAddon.fit();
    const { cols, rows } = pane.terminal;
    try { await invoke('resize_session', { id: sessionId, cols, rows }); } catch {}
  }

  function setTabRing(tab, active) {
    tab.hasRing = active;
    tab.tabEl.querySelector('.tab-ring').classList.toggle('ring-active', active);
  }

  function toggleSurfaceZoom(surfaceEl) {
    const tab = getActiveTabState();
    if (!tab || !surfaceEl) return;
    if (getZoomedSurfaceEl() === surfaceEl) {
      tab.contentEl.classList.remove('zoom-mode');
      surfaceEl.classList.remove('zoomed-pane');
      tab.zoomedSurfaceEl = null;
      setZoomedSurfaceEl(null);
    } else {
      if (getZoomedSurfaceEl()) {
        const prevTab = getActiveTabState();
        if (prevTab?.zoomedSurfaceEl) prevTab.zoomedSurfaceEl = null;
      }
      tab.contentEl.querySelectorAll('.zoomed-pane').forEach((el) => el.classList.remove('zoomed-pane'));
      tab.contentEl.classList.add('zoom-mode');
      surfaceEl.classList.add('zoomed-pane');
      tab.zoomedSurfaceEl = surfaceEl;
      setZoomedSurfaceEl(surfaceEl);
    }
    requestAnimationFrame(() => {
      for (const paneId of tab.paneIds) fitAndResizePane(paneId);
    });
  }

  function updateTabNumbers() {
    const termTabs = [...tabs.values()].filter((tab) => tab.workspaceId === getActiveWorkspaceId()
      && !tab.userRenamed && (tab.title === 'Terminal' || /^Terminal \d+$/.test(tab.title)));
    let n = 1;
    for (const tab of termTabs) {
      tab.title = termTabs.length === 1 ? 'Terminal' : `Terminal ${n}`;
      const el = tab.tabEl.querySelector('.tab-title');
      if (el) el.textContent = tab.title;
      n += 1;
    }
  }

  function getFocusableSurfaces(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return [];
    return [...tab.contentEl.querySelectorAll('.pane-leaf')]
      .map((el) => ({
        el,
        rect: el.getBoundingClientRect(),
        paneId: el.dataset.sessionId || null,
        browserLabel: el.dataset.browserLabel || null,
        markdownLabel: el.dataset.markdownLabel || null,
      }))
      .filter((item) => item.rect.width > 0 && item.rect.height > 0);
  }

  function focusAdjacentSurface(direction) {
    if (!getActiveTabId()) return false;
    const currentEl = getCurrentSurfaceElement();
    if (!currentEl) return false;
    const surfaces = getFocusableSurfaces(getActiveTabId());
    const current = surfaces.find((item) => item.el === currentEl);
    if (!current) return false;
    const currentCx = current.rect.left + current.rect.width / 2;
    const currentCy = current.rect.top + current.rect.height / 2;
    const candidates = surfaces.filter((item) => item.el !== currentEl).map((item) => {
      const cx = item.rect.left + item.rect.width / 2;
      const cy = item.rect.top + item.rect.height / 2;
      const dx = cx - currentCx;
      const dy = cy - currentCy;
      return { ...item, dx, dy, distance: Math.hypot(dx, dy) };
    }).filter((item) => {
      if (direction === 'left') return item.dx < -8;
      if (direction === 'right') return item.dx > 8;
      if (direction === 'up') return item.dy < -8;
      return item.dy > 8;
    }).sort((a, b) => a.distance - b.distance);
    const target = candidates[0];
    if (!target) return false;
    if (target.paneId) activatePane(target.paneId);
    else if (target.browserLabel) activateBrowser(target.browserLabel);
    else if (target.markdownLabel) activateMarkdown(target.markdownLabel);
    return true;
  }

  function closeCurrentSurface() {
    if (document.activeElement?.closest?.('#settings-panel')) return false;
    if (document.activeElement?.closest?.('#find-bar')) return false;
    if (document.activeElement?.closest?.('#history-picker')) return false;
    const tab = tabs.get(getActiveTabId());
    if (tab?.lastActiveSurfaceEl?.dataset?.markdownLabel) {
      closeMarkdownSurface(tab.lastActiveSurfaceEl.dataset.markdownLabel);
      return true;
    }
    if (tab?.lastActiveSurfaceEl?.dataset?.browserLabel) {
      closeBrowserSurface(tab.lastActiveSurfaceEl.dataset.browserLabel);
      return true;
    }
    if (getActivePaneId()) {
      closePane(getActivePaneId());
      return true;
    }
    return false;
  }

  function handlePaneFontShortcut(key) {
    const pane = panes.get(getActivePaneId());
    if (!pane) return false;
    if (key === '=' || key === '+') {
      const ns = Math.min(32, (pane.terminal.options.fontSize ?? 13) + 1);
      for (const [, p] of panes) { p.terminal.options.fontSize = ns; fitAndResizePane(p.sessionId ?? p.id ?? [...panes.entries()].find((entry) => entry[1] === p)?.[0]); }
      const sv = loadSettings(); sv.fontSize = ns; saveSettings(sv);
      return true;
    }
    if (key === '-' || key === '_') {
      const ns = Math.max(8, (pane.terminal.options.fontSize ?? 13) - 1);
      for (const [, p] of panes) { p.terminal.options.fontSize = ns; fitAndResizePane(p.sessionId ?? p.id ?? [...panes.entries()].find((entry) => entry[1] === p)?.[0]); }
      const sv = loadSettings(); sv.fontSize = ns; saveSettings(sv);
      return true;
    }
    if (key === '0') {
      const ns = SETTINGS_DEFAULTS.fontSize;
      for (const [, p] of panes) { p.terminal.options.fontSize = ns; fitAndResizePane(p.sessionId ?? p.id ?? [...panes.entries()].find((entry) => entry[1] === p)?.[0]); }
      const sv = loadSettings(); sv.fontSize = ns; saveSettings(sv);
      return true;
    }
    return false;
  }

  return {
    updateTabCwd,
    fitAndResizePane,
    setTabRing,
    toggleSurfaceZoom,
    updateTabNumbers,
    getFocusableSurfaces,
    focusAdjacentSurface,
    closeCurrentSurface,
    handlePaneFontShortcut,
  };
}