export function createTabSurfaceRuntime({
  document,
  tabs,
  panes,
  browserPanes,
  markdownPanes,
  workspaces,
  getActiveTabId,
  setActiveTabId,
  getActivePaneId,
  setActivePaneId,
  getActiveBrowserLabel,
  setActiveBrowserLabel,
  getActiveMarkdownLabel,
  setActiveMarkdownLabel,
  setZoomedSurfaceEl,
  getNotifPanelTabId,
  setNotifPanelTabId,
  syncBrowserVisibility,
  fitAndResizePane,
  setPaneRing,
  markPaneNotificationsRead,
  markTabNotificationsRead,
  updateTabMeta,
  setTabRing,
  markLayoutDirty,
  activateBrowser,
  activateMarkdown,
  closeBrowserSurface,
  closeMarkdownSurface,
  saveSessionVaultEntryForPane,
  destroyPane,
  updateTabNumbers,
  closeRemoteTmuxInspector,
  isRemoteTmuxInspectorOpen,
  refreshRemoteTmuxTabHealth,
}) {
  function getCurrentSurfaceElement() {
    const activePaneId = getActivePaneId();
    if (activePaneId) return panes.get(activePaneId)?.domEl ?? null;
    const activeBrowserLabel = getActiveBrowserLabel();
    if (activeBrowserLabel) return browserPanes.get(activeBrowserLabel)?.browserEl ?? null;
    const activeMarkdownLabel = getActiveMarkdownLabel();
    if (activeMarkdownLabel) return markdownPanes.get(activeMarkdownLabel)?.markdownEl ?? null;
    return null;
  }

  function getActiveTabState() {
    const activeTabId = getActiveTabId();
    return activeTabId ? tabs.get(activeTabId) : null;
  }

  function clearActiveSurface() {
    const activePaneId = getActivePaneId();
    if (activePaneId) panes.get(activePaneId)?.domEl.classList.remove('active-pane');
    const activeBrowserLabel = getActiveBrowserLabel();
    if (activeBrowserLabel) browserPanes.get(activeBrowserLabel)?.browserEl.classList.remove('active-pane');
    const activeMarkdownLabel = getActiveMarkdownLabel();
    if (activeMarkdownLabel) markdownPanes.get(activeMarkdownLabel)?.markdownEl.classList.remove('active-pane');
    setActivePaneId(null);
    setActiveBrowserLabel(null);
    setActiveMarkdownLabel(null);
  }

  function activateSurfaceElement(surfaceEl) {
    if (!surfaceEl) return;
    if (surfaceEl.classList.contains('browser-pane-leaf')) {
      activateBrowser(surfaceEl.dataset.browserLabel);
      return;
    }
    if (surfaceEl.classList.contains('markdown-pane-leaf')) {
      activateMarkdown(surfaceEl.dataset.markdownLabel);
      return;
    }
    if (surfaceEl.classList.contains('pane-leaf')) activatePane(surfaceEl.dataset.sessionId);
  }

  function activatePane(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;

    clearActiveSurface();
    setActivePaneId(paneId);
    pane.domEl.classList.add('active-pane');
    const tab = tabs.get(pane.tabId);
    if (tab) tab.lastActiveSurfaceEl = pane.domEl;
    setPaneRing(paneId, false);
    markPaneNotificationsRead(pane.tabId, paneId);
    markLayoutDirty();

    if (pane.tabId !== getActiveTabId()) {
      activateTab(pane.tabId);
      return;
    }

    requestAnimationFrame(() => {
      fitAndResizePane(paneId);
      pane.terminal.focus();
      if (tab) setTabRing(tab, false);
    });
  }

  function activateTab(tabId) {
    const previousTabId = getActiveTabId();
    if (previousTabId && previousTabId !== tabId) {
      const prev = tabs.get(previousTabId);
      if (prev) {
        prev.contentEl.classList.remove('visible');
        prev.tabEl.classList.remove('active');
      }
    }

    setActiveTabId(tabId);
    const tab = tabs.get(tabId);
    if (!tab) return;
    const workspace = workspaces.get(tab.workspaceId);
    if (workspace) workspace.lastActiveTabId = tabId;

    tab.contentEl.classList.add('visible');
    tab.tabEl.classList.add('active');
    setTabRing(tab, false);
    markTabNotificationsRead(tabId);
    updateTabMeta(tabId);
    syncBrowserVisibility();
    markLayoutDirty();

    requestAnimationFrame(() => {
      const currentActivePaneId = getActivePaneId();
      const target = (currentActivePaneId && tab.paneIds.has(currentActivePaneId))
        ? currentActivePaneId
        : [...tab.paneIds][0];
      if (target) activatePane(target);
      if (tab.pendingRestoreUi) {
        const { activeSurfacePath, zoomedSurfacePath } = tab.pendingRestoreUi;
        tab.pendingRestoreUi = null;
        const surfaceEl = getTabSurfaceElementByPath(tab, activeSurfacePath);
        if (surfaceEl) activateSurfaceElement(surfaceEl);
        const zoomEl = getTabSurfaceElementByPath(tab, zoomedSurfacePath);
        if (zoomEl) {
          tab.contentEl.classList.add('zoom-mode');
          zoomEl.classList.add('zoomed-pane');
          tab.zoomedSurfaceEl = zoomEl;
          setZoomedSurfaceEl(zoomEl);
        }
      }
      syncBrowserVisibility();
      void refreshRemoteTmuxTabHealth(tabId);
    });
  }

  function collapsePaneBranch(leafEl) {
    if (!leafEl) return;

    let branchEl = leafEl;
    let parentEl = leafEl.parentElement;

    while (parentEl && !parentEl.classList.contains('pane-split')) {
      branchEl = parentEl;
      parentEl = parentEl.parentElement;
    }

    if (parentEl && parentEl.classList.contains('pane-split')) {
      const sibling = [...parentEl.children].find(
        (child) => child !== branchEl && !child.classList.contains('pane-divider'),
      );
      if (sibling) {
        let promote = sibling;
        if (!sibling.classList.contains('pane-leaf') && !sibling.classList.contains('pane-split')) {
          const inner = [...sibling.children].find((child) => !child.classList.contains('pane-divider'));
          if (inner) promote = inner;
        }
        promote.style.flex = '';
        parentEl.parentElement.replaceChild(promote, parentEl);
        return;
      }
    }

    leafEl.remove();
  }

  async function closePane(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;

    const tab = tabs.get(pane.tabId);
    if (!tab || tab.paneIds.size <= 1) {
      await closeTab(pane.tabId);
      return;
    }

    await saveSessionVaultEntryForPane(paneId, { reason: 'pane-close' });
    await destroyPane(paneId);
    collapsePaneBranch(pane.domEl);

    if (getActivePaneId() === paneId) {
      const remaining = [...tab.paneIds];
      if (remaining.length > 0) activatePane(remaining[remaining.length - 1]);
    }

    requestAnimationFrame(() => {
      for (const pid of [...tab.paneIds]) fitAndResizePane(pid);
    });
    markLayoutDirty();
  }

  async function closeTab(tabId, _skipWorkspaceCheck = false) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (isRemoteTmuxInspectorOpen(tabId)) closeRemoteTmuxInspector();
    const workspace = workspaces.get(tab.workspaceId);

    for (const browserEl of [...tab.contentEl.querySelectorAll('.browser-pane-leaf')]) {
      const label = browserEl.dataset.browserLabel;
      if (label) await closeBrowserSurface(label, { collapse: false });
    }

    for (const markdownEl of [...tab.contentEl.querySelectorAll('.markdown-pane-leaf')]) {
      const label = markdownEl.dataset.markdownLabel;
      if (label) closeMarkdownSurface(label, { collapse: false });
    }

    for (const paneId of [...tab.paneIds]) {
      await saveSessionVaultEntryForPane(paneId, { reason: 'tab-close' });
      await destroyPane(paneId);
    }

    tab.contentEl.remove();
    tab.tabEl.remove();
    tabs.delete(tabId);
    if (getNotifPanelTabId() === tabId) setNotifPanelTabId(null);
    if (workspace?.lastActiveTabId === tabId) {
      const replacement = [...tabs.values()].find((entry) => entry.workspaceId === tab.workspaceId);
      workspace.lastActiveTabId = replacement?.tabId ?? null;
    }

    if (getActiveTabId() === tabId) {
      setActiveTabId(null);
      setActivePaneId(null);
      const remaining = [...tabs.values()].filter((entry) => entry.workspaceId === workspace?.id);
      if (remaining.length > 0) {
        activateTab(remaining[remaining.length - 1].tabId);
      } else {
        document.body.classList.remove('has-tabs');
      }
    }

    updateTabNumbers();
    syncBrowserVisibility();
    markLayoutDirty();
  }

  async function destroyPaneSession(paneId) {
    await destroyPane(paneId);
  }

  function getTabSurfaceElementByPath(tab, path) {
    if (!tab || !Array.isArray(path)) return null;
    let current = tab.contentEl;
    for (const index of path) {
      if (!current?.children?.[index]) return null;
      current = current.children[index];
    }
    return current;
  }

  return {
    getCurrentSurfaceElement,
    getActiveTabState,
    clearActiveSurface,
    activateSurfaceElement,
    activatePane,
    activateTab,
    collapsePaneBranch,
    closePane,
    closeTab,
    destroyPaneSession,
  };
}