import { buildSerializedLayout } from './layout_state.mjs';

export function createLayoutPersistence({
  browserPanes,
  markdownPanes,
  panes,
  tabs,
  workspaces,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  getNotifPanelTabId,
  setNotifPanelTabId,
  serializeTabState,
  createLeafPane,
  createBrowserLeaf,
  createMarkdownLeaf,
  makeDividerDrag,
  createWorkspaceMeta,
  renderWorkspaceBar,
  applyWorkspaceTheme,
  createTab,
  activateTab,
  orderedWorkspaceIds,
  switchWorkspace,
  renderNotifPanel,
}) {
  function serializePaneTree(el) {
    if (!el) return null;
    if (el.classList.contains('browser-pane-leaf')) {
      const browser = browserPanes.get(el.dataset.browserLabel);
      return browser ? {
        kind: 'browser',
        url: browser.currentUrl,
        history: [...browser.history],
        historyIndex: browser.historyIndex,
      } : null;
    }
    if (el.classList.contains('markdown-pane-leaf')) {
      const markdown = markdownPanes.get(el.dataset.markdownLabel);
      return markdown ? {
        kind: 'markdown',
        path: markdown.path,
        title: markdown.title,
        source: markdown.path ? null : markdown.source,
      } : null;
    }
    if (el.classList.contains('pane-leaf')) {
      const pane = panes.get(el.dataset.sessionId);
      return pane ? {
        kind: 'terminal',
        target: pane.target,
        labelOverride: pane.labelOverride ?? null,
      } : null;
    }
    if (el.classList.contains('pane-split')) {
      const dir = el.classList.contains('pane-split-h') ? 'h' : 'v';
      const children = [...el.children].filter((child) => !child.classList.contains('pane-divider'));
      const [childA, sideBEl] = children;
      const flexA = parseFloat(childA.style.flex) || 1;
      const flexB = parseFloat(sideBEl.style.flex) || 1;
      const ratio = flexA / (flexA + flexB);
      return {
        kind: 'split', dir, ratio,
        a: serializePaneTree(childA),
        b: serializePaneTree(sideBEl.firstElementChild),
      };
    }
    return el.firstElementChild ? serializePaneTree(el.firstElementChild) : null;
  }

  function serializeLayout() {
    return buildSerializedLayout({
      version: 4,
      workspaces: [...workspaces.values()],
      tabs: [...tabs.values()],
      activeWorkspaceId: getActiveWorkspaceId(),
      notifPanelTabId: getNotifPanelTabId(),
      serializeTabState,
    });
  }

  async function restorePaneTree(tabId, node, mountEl) {
    if (!node) return;
    if (node.kind === 'leaf' || node.kind === 'terminal') {
      await createLeafPane(tabId, node.target, mountEl, {
        labelOverride: node.labelOverride ?? null,
      });
      return;
    }
    if (node.kind === 'browser') {
      await createBrowserLeaf(tabId, mountEl, {
        url: node.url ?? '',
        history: Array.isArray(node.history) ? node.history : [],
        historyIndex: Number.isInteger(node.historyIndex) ? node.historyIndex : -1,
      });
      return;
    }
    if (node.kind === 'markdown') {
      await createMarkdownLeaf(tabId, mountEl, {
        path: node.path ?? '',
        title: node.title ?? '',
        source: node.source ?? '',
      });
      return;
    }
    if (node.kind !== 'split') return;

    const splitEl = document.createElement('div');
    splitEl.className = `pane-split pane-split-${node.dir}`;
    mountEl.appendChild(splitEl);

    const tempA = document.createElement('div');
    splitEl.appendChild(tempA);
    await restorePaneTree(tabId, node.a, tempA);
    const childAEl = tempA.firstElementChild;
    if (childAEl) {
      childAEl.style.flex = `${node.ratio} 1 0`;
      splitEl.replaceChild(childAEl, tempA);
    } else {
      splitEl.removeChild(tempA);
    }

    const dividerEl = document.createElement('div');
    dividerEl.className = `pane-divider pane-divider-${node.dir}`;
    dividerEl.addEventListener('mousedown', makeDividerDrag(splitEl, node.dir));
    splitEl.appendChild(dividerEl);

    const sideBEl = document.createElement('div');
    sideBEl.style.flex = `${1 - node.ratio} 1 0`;
    sideBEl.style.minWidth = '0';
    sideBEl.style.minHeight = '0';
    sideBEl.style.display = 'flex';
    splitEl.appendChild(sideBEl);
    await restorePaneTree(tabId, node.b, sideBEl);
  }

  async function restoreLayout(layout) {
    if (!layout) return false;
    if ((layout.version === 4 || layout.version === 3 || layout.version === 2)
      && Array.isArray(layout.workspaces)
      && layout.workspaces.length > 0) {
      for (let wi = 0; wi < layout.workspaces.length; wi++) {
        const wsData = layout.workspaces[wi];
        const wsId = createWorkspaceMeta(wsData.name, !!wsData.pinned, wsData.themeId ?? 'violet');
        if (wi === 0) {
          setActiveWorkspaceId(wsId);
          applyWorkspaceTheme(wsId);
          renderWorkspaceBar();
        }
        const prevWs = getActiveWorkspaceId();
        setActiveWorkspaceId(wsId);
        const createdTabIds = [];
        for (const tabData of (wsData.tabs ?? [])) {
          const createdTabId = await createTab({ type: 'local' }, tabData);
          if (createdTabId) createdTabIds.push(createdTabId);
        }
        const workspace = workspaces.get(wsId);
        const activeTabIndex = Math.min(wsData.activeTabIndex ?? 0, createdTabIds.length - 1);
        if (workspace) {
          workspace.lastActiveTabId = activeTabIndex >= 0 ? createdTabIds[activeTabIndex] : null;
        }
        if (wi !== 0) {
          for (const [, tab] of tabs) {
            if (tab.workspaceId === wsId) tab.tabEl.style.display = 'none';
          }
        }
        setActiveWorkspaceId(prevWs);
      }
      const wsIds = orderedWorkspaceIds();
      const activeWi = Math.min(layout.activeWorkspaceIndex ?? 0, wsIds.length - 1);
      setActiveWorkspaceId(null);
      switchWorkspace(wsIds[activeWi]);
      const notifPanel = layout.ui?.notifPanel;
      if (notifPanel) {
        const targetWsId = wsIds[Math.min(notifPanel.workspaceIndex ?? 0, wsIds.length - 1)];
        const targetTabs = [...tabs.values()].filter((tab) => tab.workspaceId === targetWsId);
        const targetTab = targetTabs[Math.min(notifPanel.tabIndex ?? 0, Math.max(0, targetTabs.length - 1))];
        if (targetTab) {
          setNotifPanelTabId(targetTab.tabId);
          renderNotifPanel(targetTab.tabId);
        }
      }
      return true;
    }

    if (layout.version === 1 && Array.isArray(layout.tabs) && layout.tabs.length > 0) {
      const wsId = createWorkspaceMeta('Workspace 1');
      setActiveWorkspaceId(wsId);
      applyWorkspaceTheme(wsId);
      renderWorkspaceBar();
      for (const tabData of layout.tabs) {
        await createTab({ type: 'local' }, tabData);
      }
      const tabIds = [...tabs.keys()];
      const activeIdx = Math.min(layout.activeTabIndex ?? 0, tabIds.length - 1);
      if (tabIds[activeIdx]) activateTab(tabIds[activeIdx]);
      return true;
    }

    return false;
  }

  return {
    serializePaneTree,
    serializeLayout,
    restorePaneTree,
    restoreLayout,
  };
}