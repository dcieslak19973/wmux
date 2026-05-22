export function createPaneRegistry({
  tabs,
  panes,
  workspaces,
  invoke,
  document,
  // Active-state getters/setters — the variables live in main.js so all
  // existing code that reads them directly keeps working without changes.
  getActivePaneId,
  setActivePaneId,
  getActiveTabId,
  setActiveTabId,
  getActiveWorkspaceId,
  getZoomedSurface,
  setZoomedSurface,
  getNotifPanelTabId,
  setNotifPanelTabId,
  getRemoteTmuxInspectorState,
  // Callbacks into main.js and the runtime modules
  clearActiveSurface,
  setPaneRing,
  markPaneNotificationsRead,
  fitAndResizePane,
  setTabRing,
  markTabNotificationsRead,
  updateTabMeta,
  syncBrowserVisibility,
  markLayoutDirty,
  getTabSurfaceElementByPath,
  activateSurfaceElement,
  refreshRemoteTmuxTabHealth,
  saveSessionVaultEntryForPane,
  closeRemoteTmuxInspector,
  closeBrowserSurface,
  closeMarkdownSurface,
  updateTabNumbers,
}) {
  // ── Internal helpers ────────────────────────────────────────────────────────

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
        c => c !== branchEl && !c.classList.contains('pane-divider'),
      );
      if (sibling) {
        let promote = sibling;
        if (!sibling.classList.contains('pane-leaf') && !sibling.classList.contains('pane-split')) {
          const inner = [...sibling.children].find(c => !c.classList.contains('pane-divider'));
          if (inner) promote = inner;
        }
        promote.style.flex = '';
        parentEl.parentElement.replaceChild(promote, parentEl);
        return;
      }
    }

    leafEl.remove();
  }

  async function _destroyPane(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;
    pane.unlisten();
    pane.resizeObserver.disconnect();
    pane.terminal.dispose();
    const tab = tabs.get(pane.tabId);
    if (tab) {
      tab.paneIds.delete(paneId);
      if (tab.lastActiveSurfaceEl === pane.domEl) tab.lastActiveSurfaceEl = null;
      if (tab.zoomedSurfaceEl === pane.domEl) tab.zoomedSurfaceEl = null;
    }
    if (getZoomedSurface() === pane.domEl) setZoomedSurface(null);
    panes.delete(paneId);
    try { await invoke('close_session', { id: paneId }); } catch { /* already dead */ }
  }

  // ── Exported lifecycle ──────────────────────────────────────────────────────

  function activatePane(paneId) {
    const pane = panes.get(paneId);
    if (!pane) return;

    clearActiveSurface();
    setActivePaneId(paneId);
    pane.domEl.classList.add('active-pane');
    pane.tbFlash?.();
    const tab = tabs.get(pane.tabId);
    if (tab) tab.lastActiveSurfaceEl = pane.domEl;
    setPaneRing(paneId, false);
    markPaneNotificationsRead(pane.tabId, paneId);
    markLayoutDirty();

    if (pane.tabId !== getActiveTabId()) {
      activateTab(pane.tabId);
      return;
    }

    syncBrowserVisibility();
    requestAnimationFrame(() => {
      fitAndResizePane(paneId);
      pane.terminal.focus();
      if (tab) setTabRing(tab, false);
    });
  }

  function activateTab(tabId) {
    if (getActiveTabId() && getActiveTabId() !== tabId) {
      const prev = tabs.get(getActiveTabId());
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
      const target = (getActivePaneId() && tab.paneIds.has(getActivePaneId()))
        ? getActivePaneId()
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
          setZoomedSurface(zoomEl);
        }
      }
      syncBrowserVisibility();
      void refreshRemoteTmuxTabHealth(tabId);
    });
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
    await _destroyPane(paneId);
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

  async function closeTab(tabId, skipWorkspaceCheck = false) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    if (getRemoteTmuxInspectorState()?.tabId === tabId) closeRemoteTmuxInspector();
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
      await _destroyPane(paneId);
    }

    tab.contentEl.remove();
    tab.tabEl.remove();
    tabs.delete(tabId);
    if (getNotifPanelTabId() === tabId) setNotifPanelTabId(null);
    if (workspace?.lastActiveTabId === tabId) {
      const replacement = [...tabs.values()].find(t => t.workspaceId === tab.workspaceId);
      workspace.lastActiveTabId = replacement?.tabId ?? null;
    }

    if (getActiveTabId() === tabId) {
      setActiveTabId(null);
      setActivePaneId(null);
      const remaining = [...tabs.values()].filter(
        t => t.workspaceId === getActiveWorkspaceId(),
      );
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

  return {
    activatePane,
    activateTab,
    closePane,
    closeTab,
    collapsePaneBranch,
  };
}
