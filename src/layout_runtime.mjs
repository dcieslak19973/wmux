import { buildSerializedLayout } from './layout_state.mjs';
import { normalizeTerminalTranscript } from './terminal_restore.mjs';

export function trimTrailingPromptFromSerializedSnapshot(snapshot) {
  const value = String(snapshot ?? '');
  if (!value) return '';
  const lines = value.split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0 && !lines[index].trim()) index -= 1;
  if (index < 0) return '';
  const lastLine = lines[index];
  if (/^(?:\([^)]*\)\s*)?[\w.@-]+@[\w.-]+:(?:~|\/[^#$%\r\n]*)\s*[#$%]\s*$/.test(lastLine)
    || /^PS\s+[A-Za-z]:\\.*>\s*$/i.test(lastLine)
    || /^[A-Za-z]:\\.*>\s*$/i.test(lastLine)) {
    lines.splice(index, 1);
    return lines.join('\n').replace(/[\r\n]+$/g, '');
  }
  return value;
}

export function getTrimmedViewportRange(terminal) {
  const buffer = terminal?.buffer?.active;
  const rows = Number(terminal?.rows) || 0;
  if (!buffer || rows <= 0 || typeof buffer.getLine !== 'function') return null;

  const viewportStart = Number.isInteger(buffer.viewportY) ? buffer.viewportY : Math.max(0, buffer.baseY);
  const viewportEnd = Math.min(buffer.length - 1, viewportStart + rows - 1);
  if (viewportEnd < viewportStart) return null;

  let contentStart = viewportStart;
  let contentEnd = viewportEnd;

  while (contentStart <= viewportEnd) {
    const line = buffer.getLine(contentStart)?.translateToString?.(true) ?? '';
    if (line.trim()) break;
    contentStart += 1;
  }

  while (contentEnd >= contentStart) {
    const line = buffer.getLine(contentEnd)?.translateToString?.(true) ?? '';
    if (line.trim()) break;
    contentEnd -= 1;
  }

  if (contentEnd < contentStart) return null;
  return { start: contentStart, end: contentEnd };
}

export function captureVisibleTerminalScreen(terminal, serializeAddon) {
  const range = getTrimmedViewportRange(terminal);
  if (!range || !serializeAddon?.serialize) return '';

  const serialized = serializeAddon.serialize({
    range,
    excludeAltBuffer: true,
    excludeModes: true,
  });
  return trimTrailingPromptFromSerializedSnapshot(serialized);
}

export function writeTerminalSnapshot(term, snapshot, { serialized = false } = {}) {
  if (serialized) {
    if (snapshot) term.write(String(snapshot));
    return;
  }
  const normalized = normalizeTerminalTranscript(snapshot);
  if (!normalized) return;
  term.write(normalized.replace(/\n/g, '\r\n'));
}

export function sanitizeFallbackOutputSnapshot(snapshot) {
  const normalized = normalizeTerminalTranscript(snapshot);
  if (!normalized) return '';

  const trimmedEdges = normalized
    .replace(/^(?:\s*\n){3,}/, '')
    .replace(/(?:\n\s*){3,}$/g, '')
    .replace(/\n{4,}/g, '\n\n');

  return trimmedEdges
    .replace(/((?:\([^)]*\)\s*)?[\w.@-]+@[\w.-]+:(?:~|\/[^#$%\r\n]*)\s*[#$%])\s+\1$/gm, '$1')
    .replace(/(PS\s+[A-Za-z]:\\[^>\r\n]*>?)\s+\1$/gmi, '$1')
    .trimEnd();
}

export function sanitizeLayoutTreeSnapshots(node) {
  if (!node || typeof node !== 'object') return node;
  if (node.kind === 'terminal' || node.kind === 'leaf') {
    node.outputSnapshot = '';
    node.screenSnapshot = '';
    return node;
  }
  if (node.kind === 'split') {
    sanitizeLayoutTreeSnapshots(node.a);
    sanitizeLayoutTreeSnapshots(node.b);
  }
  return node;
}

export function sanitizeRestoredLayout(layout) {
  if (!layout || typeof layout !== 'object') return layout;
  if (Array.isArray(layout.workspaces)) {
    for (const workspace of layout.workspaces) {
      for (const tab of workspace?.tabs ?? []) {
        sanitizeLayoutTreeSnapshots(tab?.tree);
      }
    }
    return layout;
  }
  if (Array.isArray(layout.tabs)) {
    for (const tab of layout.tabs) {
      sanitizeLayoutTreeSnapshots(tab?.tree);
    }
  }
  return layout;
}

export function buildTerminalPaneSnapshot(pane) {
  if (!pane) return null;
  return {
    kind: 'terminal',
    target: pane.target,
    cwd: pane.cwd ?? '',
    previousCwd: pane.previousCwd ?? '',
    history: Array.isArray(pane.history) ? [...pane.history] : [],
    screenSnapshot: '',
    outputSnapshot: '',
    labelOverride: pane.labelOverride ?? null,
    vaultEntryId: pane.lastSessionVaultEntryId ?? null,
  };
}

export function buildRestoredTerminalState(node) {
  return {
    cwd: typeof node?.cwd === 'string' ? node.cwd : '',
    previousCwd: typeof node?.previousCwd === 'string' ? node.previousCwd : '',
    history: Array.isArray(node?.history) ? [...node.history] : [],
    screenSnapshot: '',
    outputSnapshot: '',
    labelOverride: node?.labelOverride ?? null,
    vaultEntryId: typeof node?.vaultEntryId === 'string' ? node.vaultEntryId : null,
  };
}

export function createLayoutLifecycleRuntime({
  document,
  windowObject,
  currentWindow,
  invoke,
  panes,
  serializeLayout,
  restoreLayout,
  backfillPaneCwdFromTranscript,
  closeBrowserSurfacesForShutdown,
  flushSessionVaultEntries,
  createDefaultLayout,
}) {
  let layoutSaveTimer = null;
  let layoutSaveInFlight = Promise.resolve(false);
  let lastSavedLayoutJson = null;
  let windowCloseInProgress = false;
  let lifecycleBound = false;

  function buildLayoutSnapshot() {
    return JSON.stringify(serializeLayout());
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  }

  function persistLayoutNow({ force = false, reason = 'manual' } = {}) {
    let layoutJson;
    try {
      for (const pane of panes.values()) {
        backfillPaneCwdFromTranscript(pane);
      }
      layoutJson = buildLayoutSnapshot();
    } catch (err) {
      console.warn(`Failed to serialize layout during ${reason}:`, err);
      return Promise.resolve(false);
    }

    if (!force && layoutJson === lastSavedLayoutJson) return Promise.resolve(false);

    layoutSaveInFlight = layoutSaveInFlight
      .catch(() => false)
      .then(async () => {
        if (!force && layoutJson === lastSavedLayoutJson) return false;
        await invoke('save_layout', { layoutJson });
        lastSavedLayoutJson = layoutJson;
        return true;
      })
      .catch((err) => {
        console.warn(`Failed to save layout during ${reason}:`, err);
        return false;
      });

    return layoutSaveInFlight;
  }

  function scheduleLayoutSave(delay = 300) {
    if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = setTimeout(() => {
      layoutSaveTimer = null;
      void persistLayoutNow({ reason: 'scheduled' });
    }, delay);
  }

  function markLayoutDirty({ immediate = false } = {}) {
    lastSavedLayoutJson = null;
    if (immediate) return persistLayoutNow({ reason: 'immediate' });
    scheduleLayoutSave();
    return Promise.resolve(false);
  }

  async function handleCloseRequested(event) {
    if (windowCloseInProgress) return;

    windowCloseInProgress = true;
    event.preventDefault();
    try {
      if (layoutSaveTimer) {
        clearTimeout(layoutSaveTimer);
        layoutSaveTimer = null;
      }
      await withTimeout(flushSessionVaultEntries({ reason: 'shutdown' }), 2500, 'session vault flush');
      await withTimeout(closeBrowserSurfacesForShutdown(), 1500, 'browser cleanup');
      await withTimeout(persistLayoutNow({ force: true, reason: 'close-requested' }), 1500, 'layout save');
    } catch (err) {
      console.warn('Close preparation failed, forcing window destruction:', err);
    }

    try {
      await invoke('exit_app');
    } catch (err) {
      console.warn('Backend app exit failed, falling back to window destruction:', err);
      try {
        await currentWindow.destroy();
      } catch (destroyErr) {
        console.warn('Failed to destroy window during shutdown:', destroyErr);
        windowCloseInProgress = false;
      }
    }
  }

  function bindLifecycleEvents() {
    if (lifecycleBound) return;
    lifecycleBound = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        void persistLayoutNow({ force: true, reason: 'visibilitychange' });
      }
    });
    windowObject.addEventListener('pagehide', () => {
      void persistLayoutNow({ force: true, reason: 'pagehide' });
    });
    currentWindow.onCloseRequested(handleCloseRequested);
  }

  async function restoreInitialLayout() {
    let restored = false;
    try {
      const raw = await invoke('load_layout');
      if (raw) restored = await restoreLayout(sanitizeRestoredLayout(JSON.parse(raw)));
    } catch (err) {
      console.warn('Could not restore layout:', err);
    }
    if (!restored) {
      await createDefaultLayout();
    }
    try {
      lastSavedLayoutJson = buildLayoutSnapshot();
    } catch (err) {
      console.warn('Could not snapshot initial layout:', err);
    }
  }

  async function initializeLifecycle() {
    bindLifecycleEvents();
    await restoreInitialLayout();
  }

  return {
    persistLayoutNow,
    scheduleLayoutSave,
    markLayoutDirty,
    initializeLifecycle,
  };
}

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
      return buildTerminalPaneSnapshot(pane);
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
      await createLeafPane(tabId, node.target, mountEl, buildRestoredTerminalState(node));
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