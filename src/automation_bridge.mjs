export function createAutomationBridge({
  invoke,
  windowObject,
  orderedWorkspaceEntries,
  getWorkspaceTheme,
  getActiveWorkspaceId,
  getActiveTabId,
  getActivePaneId,
  getActiveBrowserLabel,
  browserPanes,
  tabs,
  notifications,
  requireWorkspace,
  requireTab,
  requirePane,
  focusTabById,
  switchWorkspace,
  setWorkspacePinned,
  setWorkspaceTheme,
  createWorkspace,
  closeWorkspace,
  createTab,
  listTabSummaries,
  listPaneSummaries,
  activatePane,
  splitPane,
  closePane,
  moveTabToWorkspace,
  closeTab,
  openBrowserSplitForTab,
  splitPaneWithBrowser,
  activateBrowser,
  browserNavigateRelative,
  reloadActiveBrowser,
  addNotification,
  unreadNotificationCount,
  markTabNotificationsRead,
  clearTabNotifications,
  serializeLayout,
  getDefaultTarget,
  renderWorkspaceBar,
}) {
  async function dispatchControlRequest(action, payload = {}) {
    switch (action) {
      case 'list-workspaces':
        return windowObject.wmux.workspace.list();
      case 'create-workspace':
        return windowObject.wmux.workspace.create(payload.name ?? undefined);
      case 'switch-workspace':
        windowObject.wmux.workspace.switch(payload.workspaceId);
        return { workspaceId: payload.workspaceId };
      case 'pin-workspace':
        windowObject.wmux.workspace.pin(payload.workspaceId, payload.pinned !== false);
        return { workspaceId: payload.workspaceId, pinned: payload.pinned !== false };
      case 'rename-workspace':
        windowObject.wmux.workspace.rename(payload.workspaceId, payload.name ?? 'Workspace');
        return { workspaceId: payload.workspaceId, name: payload.name ?? 'Workspace' };
      case 'set-workspace-theme':
        return windowObject.wmux.workspace.setTheme(payload.workspaceId, payload.themeId ?? 'violet');
      case 'close-workspace':
        await windowObject.wmux.workspace.close(payload.workspaceId);
        return {};
      case 'list-tabs':
        return windowObject.wmux.tabs.list(payload.workspaceId ?? null);
      case 'create-tab':
        return windowObject.wmux.tabs.create(payload.workspaceId ?? getActiveWorkspaceId(), payload.target ?? getDefaultTarget());
      case 'focus-tab':
        await windowObject.wmux.tabs.focus(payload.tabId);
        return { tabId: payload.tabId };
      case 'move-tab':
        await windowObject.wmux.tabs.move(payload.tabId, payload.workspaceId);
        return { tabId: payload.tabId, workspaceId: payload.workspaceId };
      case 'close-tab':
        await windowObject.wmux.tabs.close(payload.tabId);
        return {};
      case 'list-panes':
        return windowObject.wmux.panes.list(payload.tabId ?? null);
      case 'split-pane':
        return windowObject.wmux.panes.split(payload.paneId, payload.direction ?? 'v');
      case 'focus-pane':
        return windowObject.wmux.panes.focus(payload.paneId);
      case 'close-pane':
        await windowObject.wmux.panes.close(payload.paneId);
        return {};
      case 'list-windows':
        return windowObject.wmux.tabs.list(payload.workspaceId ?? null);
      case 'focus-window':
        return windowObject.wmux.tabs.focus(payload.tabId);
      case 'list-browsers':
        return windowObject.wmux.browser.list(payload.tabId ?? null);
      case 'open-browser':
        return windowObject.wmux.browser.openSplit(payload.url ?? '', payload.tabId ?? getActiveTabId());
      case 'navigate-browser':
        await windowObject.wmux.browser.navigate(payload.label, payload.url ?? '');
        return windowObject.wmux.browser.getState(payload.label);
      case 'close-browser':
        await windowObject.wmux.browser.close(payload.label);
        return {};
      case 'list-notifications':
        return windowObject.wmux.notifications.list(payload.tabId ?? getActiveTabId());
      case 'publish-notification':
        return windowObject.wmux.notifications.publish(payload.title ?? '', payload.body ?? '', payload.tabId ?? getActiveTabId());
      case 'get-layout':
        return windowObject.wmux.layout.export();
      default:
        throw new Error(`Unknown control action '${action}'`);
    }
  }

  const api = {
    browser: {
      list: (tabId = null) => [...browserPanes.values()]
        .filter((browser) => tabId === null || browser.tabId === tabId)
        .map((browser) => ({
          label: browser.label,
          tabId: browser.tabId,
          url: browser.currentUrl,
          history: [...browser.history],
          historyIndex: browser.historyIndex,
          active: browser.label === getActiveBrowserLabel(),
        })),
      openSplit: async (url = '', tabId = getActiveTabId()) => {
        const tab = await focusTabById(tabId);
        if (getActivePaneId()) {
          await splitPaneWithBrowser(getActivePaneId(), 'h', { url });
        } else {
          await openBrowserSplitForTab(tab.tabId, url);
        }
        const latestLabel = [...tabs.get(tab.tabId)?.browserLabels ?? []].at(-1) ?? null;
        return latestLabel ? api.browser.getState(latestLabel) : null;
      },
      navigate: async (label, url) => {
        const browser = browserPanes.get(label);
        if (!browser) throw new Error(`Browser '${label}' not found`);
        await invoke('navigate_browser', { label, url });
        browser.currentUrl = url;
        browser.history = browser.history.slice(0, browser.historyIndex + 1);
        browser.history.push(url);
        browser.historyIndex = browser.history.length - 1;
        const input = browser.browserEl.querySelector('.browser-url');
        if (input) input.value = url;
        return api.browser.getState(label);
      },
      back: (label) => {
        if (label) activateBrowser(label);
        return browserNavigateRelative('back');
      },
      forward: (label) => {
        if (label) activateBrowser(label);
        return browserNavigateRelative('forward');
      },
      reload: (label) => {
        if (label) activateBrowser(label);
        return reloadActiveBrowser();
      },
      close: async (label) => {
        const browser = browserPanes.get(label);
        if (!browser) return;
        browser.browserEl.querySelector(`#bc-${label}`)?.click();
      },
      getState: (label) => {
        const browser = browserPanes.get(label);
        if (!browser) return null;
        return {
          label: browser.label,
          tabId: browser.tabId,
          url: browser.currentUrl,
          history: [...browser.history],
          historyIndex: browser.historyIndex,
          active: browser.label === getActiveBrowserLabel(),
        };
      },
    },
    workspace: {
      list: () => orderedWorkspaceEntries().map((ws) => ({
        id: ws.id,
        name: ws.name,
        pinned: ws.pinned,
        themeId: ws.themeId,
        themeLabel: getWorkspaceTheme(ws.themeId).label,
        active: ws.id === getActiveWorkspaceId(),
        tabCount: [...tabs.values()].filter((tab) => tab.workspaceId === ws.id).length,
      })),
      switch: (wsId) => switchWorkspace(requireWorkspace(wsId).id),
      create: async (name) => {
        await createWorkspace(name);
        return api.workspace.list().find((ws) => ws.id === getActiveWorkspaceId()) ?? null;
      },
      rename: (wsId, name) => {
        const ws = requireWorkspace(wsId);
        ws.name = name;
        renderWorkspaceBar();
        return { id: ws.id, name: ws.name, pinned: ws.pinned };
      },
      pin: (wsId, pinned = true) => {
        const ws = requireWorkspace(wsId);
        setWorkspacePinned(ws.id, pinned);
        return { id: ws.id, pinned: !!pinned };
      },
      setTheme: (wsId, themeId) => {
        const ws = requireWorkspace(wsId);
        setWorkspaceTheme(ws.id, themeId);
        return { id: ws.id, themeId: ws.themeId, themeLabel: getWorkspaceTheme(ws.themeId).label };
      },
      close: (wsId) => closeWorkspace(requireWorkspace(wsId).id),
    },
    tabs: {
      list: (workspaceId = null) => listTabSummaries(workspaceId),
      create: async (workspaceId = getActiveWorkspaceId(), target = getDefaultTarget()) => {
        if (workspaceId !== null) api.workspace.switch(workspaceId);
        const tabId = await createTab(target);
        return listTabSummaries().find((tab) => tab.tabId === tabId) ?? null;
      },
      focus: (tabId) => focusTabById(tabId).then(() => listTabSummaries().find((tab) => tab.tabId === tabId) ?? null),
      move: (tabId, workspaceId) => moveTabToWorkspace(requireTab(tabId).tabId, requireWorkspace(workspaceId).id),
      close: (tabId) => closeTab(requireTab(tabId).tabId),
    },
    panes: {
      list: (tabId = null) => listPaneSummaries(tabId),
      focus: async (paneId) => {
        const pane = requirePane(paneId);
        const tab = await focusTabById(pane.tabId);
        if (tab.workspaceId !== getActiveWorkspaceId()) switchWorkspace(tab.workspaceId);
        activatePane(pane.sessionId);
        return listPaneSummaries().find((item) => item.paneId === pane.sessionId) ?? null;
      },
      split: async (paneId, direction = 'v') => {
        const pane = requirePane(paneId);
        await focusTabById(pane.tabId);
        await splitPane(pane.sessionId, direction === 'h' ? 'h' : 'v');
        const tab = tabs.get(pane.tabId);
        const newPaneId = [...tab.paneIds].find((id) => id !== pane.sessionId && !listPaneSummaries().some((existing) => existing.paneId === id && existing.tabId !== pane.tabId)) ?? getActivePaneId();
        return listPaneSummaries().find((item) => item.paneId === (newPaneId ?? getActivePaneId())) ?? null;
      },
      close: async (paneId) => {
        const pane = requirePane(paneId);
        await closePane(pane.sessionId);
      },
    },
    notifications: {
      list: (tabId = getActiveTabId()) => [...(notifications.get(tabId) ?? [])],
      publish: (title, body = '', tabId = getActiveTabId()) => {
        const tab = requireTab(tabId);
        addNotification(tab.tabId, { title, body, paneId: null, time: Date.now() });
        return {
          tabId: tab.tabId,
          notificationCount: (notifications.get(tab.tabId) ?? []).length,
          unreadNotifications: unreadNotificationCount(tab.tabId),
        };
      },
      markAllRead: (tabId = getActiveTabId()) => markTabNotificationsRead(tabId),
      clear: (tabId = getActiveTabId()) => clearTabNotifications(tabId),
    },
    layout: {
      export: () => serializeLayout(),
    },
  };

  async function handleControlRequest(event) {
    const { requestId, action, payload } = event.payload ?? {};
    if (!requestId || !action) return;

    try {
      const result = await dispatchControlRequest(action, payload ?? {});
      await invoke('complete_control_request', {
        requestId,
        ok: true,
        payload: result ?? null,
        error: null,
      });
    } catch (err) {
      await invoke('complete_control_request', {
        requestId,
        ok: false,
        payload: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { api, handleControlRequest };
}