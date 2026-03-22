export function basenameFromPath(path) {
  return String(path ?? '').split(/[\\/]/).pop() || '';
}

export function dirnameFromPath(path) {
  const value = String(path ?? '').replace(/[\\/]+$/, '');
  const match = value.match(/^(.*)[\\/][^\\/]+$/);
  return match?.[1] ?? '';
}

export function isAbsolutePath(path) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);
}

export function resolveMarkdownPath(input, baseDir = '') {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  if (isAbsolutePath(trimmed) || !baseDir) return trimmed;
  const separator = baseDir.includes('\\') ? '\\' : '/';
  return `${baseDir.replace(/[\\/]+$/, '')}${separator}${trimmed.replace(/^[\\/]+/, '')}`;
}

export function buildSerializedLayout({
  version = 4,
  workspaces,
  tabs,
  activeWorkspaceId,
  notifPanelTabId,
  serializeTabState,
}) {
  const workspaceEntries = Array.from(workspaces ?? []);
  const tabEntries = Array.from(tabs ?? []);
  const wsTabMap = new Map();

  for (const tab of tabEntries) {
    const tabList = wsTabMap.get(tab.workspaceId) ?? [];
    tabList.push(serializeTabState(tab));
    wsTabMap.set(tab.workspaceId, tabList);
  }

  const notifTab = notifPanelTabId
    ? tabEntries.find((tab) => tab.tabId === notifPanelTabId) ?? null
    : null;

  return {
    version,
    activeWorkspaceIndex: workspaceEntries.findIndex((ws) => ws.id === activeWorkspaceId),
    workspaces: workspaceEntries.map((ws) => {
      const workspaceTabs = tabEntries.filter((tab) => tab.workspaceId === ws.id);
      const activeIndex = workspaceTabs.findIndex((tab) => tab.tabId === ws.lastActiveTabId);

      return {
        name: ws.name,
        pinned: !!ws.pinned,
        themeId: ws.themeId ?? 'violet',
        tabs: wsTabMap.get(ws.id) ?? [],
        activeTabIndex: activeIndex >= 0 ? activeIndex : 0,
      };
    }),
    ui: {
      notifPanel: notifTab
        ? (() => {
            const workspaceIndex = workspaceEntries.findIndex((ws) => ws.id === notifTab.workspaceId);
            const workspaceTabs = tabEntries.filter((tab) => tab.workspaceId === notifTab.workspaceId);
            return {
              workspaceIndex,
              tabIndex: Math.max(0, workspaceTabs.findIndex((tab) => tab.tabId === notifPanelTabId)),
            };
          })()
        : null,
    },
  };
}