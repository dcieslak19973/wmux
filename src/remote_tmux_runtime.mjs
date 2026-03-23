export function createRemoteTmuxRuntime({
  tabs,
  panes,
  invoke,
  normalizeSshTarget,
  sshTargetsEqual,
  REMOTE_TMUX_SESSION_MODES,
  defaultTargetLabel,
  updateTabMeta,
  markLayoutDirty,
  updateTabCwd,
  renderPaneContextBadge,
  createWorkspaceMeta,
  renderWorkspaceBar,
  switchWorkspace,
  getActiveWorkspaceId,
  serializeTabState,
  closeTab,
  createTab,
  getNotifPanelTabId,
  setNotifPanelTabId,
  renderNotifPanel,
  isInspectorOpen,
  renderInspector,
}) {
  const REMOTE_TMUX_SPLIT_DISABLED_TITLE = 'Remote tmux tabs keep one terminal session per tab. Use tmux splits inside the remote session.';
  const REMOTE_TMUX_SPLIT_BLOCKED_MESSAGE = 'Remote tmux tabs keep one terminal session per tab. Use tmux splits inside the remote session; wmux browser and markdown splits still work here.';
  const REMOTE_TMUX_DISCONNECTED_MESSAGE = 'Remote tmux session disconnected.';

  function isRemoteTmuxTarget(target) {
    return normalizeSshTarget(target)?.type === 'remote_tmux';
  }

  function getRemoteTmuxPaneForTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    return [...tab.paneIds]
      .map((paneId) => panes.get(paneId))
      .find((pane) => isRemoteTmuxTarget(pane?.target)) ?? null;
  }

  function tabHasRemoteTmux(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return false;
    return [...tab.paneIds].some((paneId) => isRemoteTmuxTarget(panes.get(paneId)?.target));
  }

  function workspaceRemoteTmuxTabIds(workspaceId = getActiveWorkspaceId()) {
    return [...tabs.values()]
      .filter((tab) => tab.workspaceId === workspaceId && tabHasRemoteTmux(tab.tabId))
      .map((tab) => tab.tabId);
  }

  async function probeRemoteTmuxMetadata(tabId, sessionId, target) {
    const normalized = normalizeSshTarget(target);
    if (!normalized || normalized.type !== 'remote_tmux') return;
    const tab = tabs.get(tabId);
    if (tab) {
      tab.connectionStatus = 'connecting';
      tab.remoteProbeError = '';
      updateTabMeta(tabId);
    }
    try {
      const metadata = await invoke('probe_remote_tmux_metadata', { target: normalized });
      const pane = panes.get(sessionId);
      const nextTab = tabs.get(tabId);
      if (!pane || !nextTab || !isRemoteTmuxTarget(pane.target) || !sshTargetsEqual(pane.target, normalized)) {
        return;
      }

      if (pane.target.session_mode === REMOTE_TMUX_SESSION_MODES.CREATE) {
        pane.target = {
          ...pane.target,
          session_mode: REMOTE_TMUX_SESSION_MODES.ATTACH,
        };
        nextTab.targetLabel = defaultTargetLabel(pane.target);
      }

      nextTab.remoteTmuxSessionName = metadata.session_name ?? normalized.session_name;
      nextTab.remoteTmuxWindowName = metadata.window_name ?? '';
      nextTab.connectionStatus = 'connected';
      nextTab.remoteProbeError = '';
      nextTab.lastRemoteProbeAt = Date.now();

      if (metadata.cwd) {
        pane.cwd = metadata.cwd;
        const gitContext = metadata.repo_name ? {
          repo_root: metadata.repo_root || metadata.cwd,
          repo_name: metadata.repo_name,
          branch: metadata.git_branch || null,
          worktree_name: metadata.worktree_name || null,
          is_worktree: !!metadata.is_worktree,
        } : null;
        const cwdMeta = await updateTabCwd(tabId, metadata.cwd, {
          skipLocalGit: true,
          gitBranch: metadata.git_branch || '',
          gitContext,
        });
        pane.gitContext = cwdMeta?.gitContext ?? gitContext;
        renderPaneContextBadge(sessionId);
      }

      if (!nextTab.userRenamed && metadata.window_name) {
        nextTab.title = `${nextTab.remoteTmuxSessionName}:${metadata.window_name}`;
        const titleEl = nextTab.tabEl.querySelector('.tab-title');
        if (titleEl) titleEl.textContent = nextTab.title;
      }

      updateTabMeta(tabId);
      markLayoutDirty();
      if (isInspectorOpen(tabId)) renderInspector();
    } catch (err) {
      const nextTab = tabs.get(tabId);
      if (nextTab) {
        nextTab.connectionStatus = 'disconnected';
        nextTab.remoteProbeError = String(err);
        nextTab.lastRemoteProbeAt = Date.now();
        updateTabMeta(tabId);
      }
      if (isInspectorOpen(tabId)) renderInspector();
      console.warn('probe_remote_tmux_metadata error:', err);
    }
  }

  async function refreshRemoteTmuxTabHealth(tabId, { force = false } = {}) {
    const tab = tabs.get(tabId);
    if (!tab || tab.targetKind !== 'remote_tmux') return;
    if (!force && tab.connectionStatus === 'connecting') return;
    if (!force && tab.lastRemoteProbeAt && Date.now() - tab.lastRemoteProbeAt < 30_000) return;
    const remotePane = getRemoteTmuxPaneForTab(tabId);
    if (!remotePane) return;
    await probeRemoteTmuxMetadata(tabId, remotePane.sessionId, remotePane.target);
  }

  async function reconnectRemoteTmuxTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tabHasRemoteTmux(tabId)) return false;
    if (tab.workspaceId !== getActiveWorkspaceId()) switchWorkspace(tab.workspaceId);
    const remotePane = getRemoteTmuxPaneForTab(tabId);
    if (!remotePane) return false;

    const restoreData = serializeTabState(tab);
    const reopenTarget = remotePane.target;
    const showNotifPanel = getNotifPanelTabId() === tabId;

    await closeTab(tabId);
    const newTabId = await createTab(reopenTarget, restoreData);
    if (showNotifPanel) {
      setNotifPanelTabId(newTabId);
      renderNotifPanel(newTabId);
    }
    return true;
  }

  async function reconnectRemoteTmuxWorkspace(workspaceId = getActiveWorkspaceId()) {
    if (workspaceId !== getActiveWorkspaceId()) switchWorkspace(workspaceId);
    const tabIds = workspaceRemoteTmuxTabIds(workspaceId);
    for (const tabId of tabIds) {
      await reconnectRemoteTmuxTab(tabId);
    }
  }

  async function openRemoteTmuxWorkspaceFromProfile(target) {
    const normalized = normalizeSshTarget(target);
    if (!normalized || normalized.type !== 'remote_tmux') return null;
    const workspaceName = normalized.name || `tmux ${normalized.session_name}`;
    const workspaceId = createWorkspaceMeta(workspaceName);
    renderWorkspaceBar();
    switchWorkspace(workspaceId);
    return createTab(normalized);
  }

  function handleRemoteTmuxSessionExit(tabId, paneId) {
    const pane = panes.get(paneId);
    const tab = tabs.get(tabId);
    if (!pane || !tab || !isRemoteTmuxTarget(pane.target)) return;
    tab.connectionStatus = 'disconnected';
    tab.remoteProbeError = REMOTE_TMUX_DISCONNECTED_MESSAGE;
    tab.lastRemoteProbeAt = Date.now();
    updateTabMeta(tabId);
  }

  function applyRemoteTmuxPanePolicy(target, toolbarEl) {
    if (!isRemoteTmuxTarget(target)) return;
    for (const selector of ['[data-action="split-h"]', '[data-action="split-v"]']) {
      const btn = toolbarEl.querySelector(selector);
      if (btn) {
        btn.disabled = true;
        btn.title = REMOTE_TMUX_SPLIT_DISABLED_TITLE;
      }
    }
  }

  function getRemoteTmuxSplitBlockedMessage() {
    return REMOTE_TMUX_SPLIT_BLOCKED_MESSAGE;
  }

  return {
    isRemoteTmuxTarget,
    getRemoteTmuxPaneForTab,
    tabHasRemoteTmux,
    workspaceRemoteTmuxTabIds,
    probeRemoteTmuxMetadata,
    refreshRemoteTmuxTabHealth,
    reconnectRemoteTmuxTab,
    reconnectRemoteTmuxWorkspace,
    openRemoteTmuxWorkspaceFromProfile,
    handleRemoteTmuxSessionExit,
    applyRemoteTmuxPanePolicy,
    getRemoteTmuxSplitBlockedMessage,
  };
}