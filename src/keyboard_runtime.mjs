export function createKeyboardRuntime({
  document,
  tabs,
  panes,
  getActiveWorkspaceId,
  getActiveTabId,
  getActivePaneId,
  createTab,
  getDefaultTarget,
  closeCurrentSurface,
  splitPane,
  activateTab,
  toggleNotifPanel,
  previewArtifactFromPane,
  toggleSessionVaultPanel,
  unreadNotificationCount,
  switchWorkspace,
  showHistoryPicker,
  showFindBar,
  splitPaneWithBrowser,
  openBrowserSplitForTab,
  splitPaneWithMarkdown,
  openMarkdownSplitForTab,
  focusBrowserUrl,
  browserNavigateRelative,
  reloadActiveBrowser,
  showSettingsPanel,
  handlePaneFontShortcut,
  createWorkspace,
  toggleSurfaceZoom,
  getCurrentSurfaceElement,
  focusAdjacentSurface,
  orderedWorkspaceIds,
}) {
  function handleKeydown(event) {
    const ctrl = event.ctrlKey;
    const shift = event.shiftKey;
    const alt = event.altKey;
    const key = event.key;
    const activePaneId = getActivePaneId();
    const activeTabId = getActiveTabId();
    const activeWorkspaceId = getActiveWorkspaceId();

    if (ctrl && shift && key === 'T') {
      event.preventDefault();
      createTab(getDefaultTarget());
      return;
    }
    if (ctrl && shift && key === 'W') {
      event.preventDefault();
      closeCurrentSurface();
      return;
    }

    if (ctrl && shift && (key === '\\' || key === '|')) {
      event.preventDefault();
      if (activePaneId) splitPane(activePaneId, 'h');
      return;
    }
    if (ctrl && shift && (key === '_' || key === '-')) {
      event.preventDefault();
      if (activePaneId) splitPane(activePaneId, 'v');
      return;
    }

    if (ctrl && key === 'Tab') {
      event.preventDefault();
      const workspaceTabIds = [...tabs.values()]
        .filter((tab) => tab.workspaceId === activeWorkspaceId)
        .map((tab) => tab.tabId);
      if (workspaceTabIds.length < 2) return;
      const index = workspaceTabIds.indexOf(activeTabId);
      const next = shift
        ? workspaceTabIds[(index - 1 + workspaceTabIds.length) % workspaceTabIds.length]
        : workspaceTabIds[(index + 1) % workspaceTabIds.length];
      activateTab(next);
      return;
    }

    if (ctrl && !shift && !alt && key === 'i') {
      event.preventDefault();
      toggleNotifPanel();
      return;
    }

    if (ctrl && shift && !alt && key.toUpperCase() === 'O') {
      event.preventDefault();
      previewArtifactFromPane();
      return;
    }

    if (ctrl && shift && !alt && key.toUpperCase() === 'J') {
      event.preventDefault();
      void toggleSessionVaultPanel();
      return;
    }

    if (ctrl && shift && key === 'U') {
      event.preventDefault();
      const unread = [...tabs.values()]
        .filter((tab) => tab.workspaceId === activeWorkspaceId && unreadNotificationCount(tab.tabId) > 0);
      if (unread.length > 0) {
        activateTab(unread[unread.length - 1].tabId);
      } else {
        const allUnread = [...tabs.values()].filter((tab) => unreadNotificationCount(tab.tabId) > 0);
        if (allUnread.length > 0) {
          const tab = allUnread[allUnread.length - 1];
          switchWorkspace(tab.workspaceId);
          activateTab(tab.tabId);
        }
      }
      return;
    }

    if (ctrl && alt && key.toLowerCase() === 'h') {
      event.preventDefault();
      showHistoryPicker();
      return;
    }
    if (ctrl && !shift && !alt && key === 'f') {
      event.preventDefault();
      showFindBar();
      return;
    }

    if (ctrl && shift && !alt && key.toUpperCase() === 'L') {
      event.preventDefault();
      if (activePaneId) splitPaneWithBrowser(activePaneId, 'h');
      else if (activeTabId) openBrowserSplitForTab(activeTabId);
      return;
    }

    if (ctrl && shift && !alt && key.toUpperCase() === 'M') {
      event.preventDefault();
      if (activePaneId) splitPaneWithMarkdown(activePaneId, 'h');
      else if (activeTabId) openMarkdownSplitForTab(activeTabId);
      return;
    }

    if (ctrl && !shift && !alt && key.toLowerCase() === 'l' && focusBrowserUrl()) {
      event.preventDefault();
      return;
    }

    if (ctrl && !shift && !alt && key === '[' && browserNavigateRelative('back')) {
      event.preventDefault();
      return;
    }

    if (ctrl && !shift && !alt && key === ']' && browserNavigateRelative('forward')) {
      event.preventDefault();
      return;
    }

    if (ctrl && !shift && !alt && key.toLowerCase() === 'r' && reloadActiveBrowser()) {
      event.preventDefault();
      return;
    }

    if (ctrl && !shift && !alt && key === 'k') {
      const pane = panes.get(activePaneId);
      if (pane) {
        event.preventDefault();
        pane.terminal.clear();
      }
      return;
    }

    if (ctrl && !shift && !alt) {
      const pane = panes.get(activePaneId);
      if (key === ',' && !pane) {
        event.preventDefault();
        showSettingsPanel();
        return;
      }
      if (!pane) return;
      if (key === '=' || key === '+' || key === '-' || key === '_' || key === '0') {
        if (handlePaneFontShortcut(key)) event.preventDefault();
        return;
      }
      if (key === ',') {
        event.preventDefault();
        showSettingsPanel();
      }
      return;
    }

    if (ctrl && alt && key.toLowerCase() === 'n') {
      event.preventDefault();
      createWorkspace();
      return;
    }
    if (ctrl && alt && key === 'Enter') {
      event.preventDefault();
      toggleSurfaceZoom(getCurrentSurfaceElement());
      return;
    }
    if (alt && ctrl && key === 'ArrowLeft') {
      event.preventDefault();
      focusAdjacentSurface('left');
      return;
    }
    if (alt && ctrl && key === 'ArrowRight') {
      event.preventDefault();
      focusAdjacentSurface('right');
      return;
    }
    if (alt && ctrl && key === 'ArrowUp') {
      event.preventDefault();
      focusAdjacentSurface('up');
      return;
    }
    if (alt && ctrl && key === 'ArrowDown') {
      event.preventDefault();
      focusAdjacentSurface('down');
      return;
    }
    if (ctrl && alt && (key === '[' || key === '{')) {
      event.preventDefault();
      const ids = orderedWorkspaceIds();
      const index = ids.indexOf(activeWorkspaceId);
      if (index > 0) switchWorkspace(ids[index - 1]);
      return;
    }
    if (ctrl && alt && (key === ']' || key === '}')) {
      event.preventDefault();
      const ids = orderedWorkspaceIds();
      const index = ids.indexOf(activeWorkspaceId);
      if (index < ids.length - 1) switchWorkspace(ids[index + 1]);
      return;
    }
    if (ctrl && alt && /^[1-9]$/.test(key)) {
      event.preventDefault();
      const workspaceIndex = parseInt(key, 10) - 1;
      const ids = orderedWorkspaceIds();
      if (ids[workspaceIndex]) switchWorkspace(ids[workspaceIndex]);
    }
  }

  function bindKeyboardShortcuts() {
    document.addEventListener('keydown', handleKeydown);
  }

  return {
    bindKeyboardShortcuts,
  };
}