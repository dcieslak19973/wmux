export function createRemoteTmuxUiRuntime({
  hasRemoteTmuxTab,
  activateTab,
  openRemoteTmuxInspector,
  reconnectRemoteTmuxTab,
  workspaceRemoteTmuxTabIds,
  reconnectRemoteTmuxWorkspace,
  openRemoteTmuxWorkspaceFromProfile,
}) {
  function buildTabContextMenuItems(tabId) {
    if (!hasRemoteTmuxTab(tabId)) return [];
    return [
      { label: 'Browse remote tmux', action: () => openRemoteTmuxInspector(tabId) },
      { label: 'Refresh remote tmux state', action: () => openRemoteTmuxInspector(tabId, { forceRefresh: true }) },
      { type: 'separator' },
      { label: 'Reconnect remote tmux tab', action: () => reconnectRemoteTmuxTab(tabId) },
      { type: 'separator' },
    ];
  }

  function handleTabTargetClick(tabId, event) {
    if (!hasRemoteTmuxTab(tabId)) return;
    event.stopPropagation();
    activateTab(tabId);
    void openRemoteTmuxInspector(tabId);
  }

  function buildWorkspaceContextMenuItems(workspaceId) {
    const remoteTmuxTabIds = workspaceRemoteTmuxTabIds(workspaceId);
    return [{
      label: 'Reconnect remote tmux tabs',
      action: () => reconnectRemoteTmuxWorkspace(workspaceId),
      disabled: remoteTmuxTabIds.length === 0,
    }];
  }

  return {
    buildTabContextMenuItems,
    handleTabTargetClick,
    buildWorkspaceContextMenuItems,
    openWorkspaceFromProfile: openRemoteTmuxWorkspaceFromProfile,
  };
}