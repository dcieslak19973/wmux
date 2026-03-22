export const WORKSPACE_THEMES = [
  {
    id: 'violet',
    label: 'Violet',
    css: {
      '--bg-base': '#1a1b1e',
      '--bg-sidebar': '#13141a',
      '--bg-tab': '#1e1f26',
      '--bg-tab-active': '#272830',
      '--bg-tab-hover': '#23242c',
      '--accent': '#7c6af7',
      '--text-primary': '#e4e4e7',
      '--text-muted': '#71717a',
      '--border': '#2e2f3a',
      '--ring-color': '#f59e0b',
    },
    xterm: {
      background: '#1a1b1e',
      foreground: '#e4e4e7',
      cursor: '#7c6af7',
      cursorAccent: '#1a1b1e',
      selectionBackground: 'rgba(124,106,247,0.3)',
      black: '#1a1b1e', red: '#f87171', green: '#4ade80',
      yellow: '#fbbf24', blue: '#60a5fa', magenta: '#c084fc',
      cyan: '#22d3ee', white: '#e4e4e7',
      brightBlack: '#3f3f46', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
      brightCyan: '#67e8f9', brightWhite: '#f4f4f5',
    },
  },
  {
    id: 'forest',
    label: 'Forest',
    css: {
      '--bg-base': '#111714',
      '--bg-sidebar': '#0d1210',
      '--bg-tab': '#17201b',
      '--bg-tab-active': '#203028',
      '--bg-tab-hover': '#1b261f',
      '--accent': '#4cb782',
      '--text-primary': '#e6f3eb',
      '--text-muted': '#7f988a',
      '--border': '#294236',
      '--ring-color': '#eab308',
    },
    xterm: {
      background: '#111714',
      foreground: '#e6f3eb',
      cursor: '#4cb782',
      cursorAccent: '#111714',
      selectionBackground: 'rgba(76,183,130,0.28)',
      black: '#111714', red: '#f87171', green: '#4cb782',
      yellow: '#facc15', blue: '#60a5fa', magenta: '#a78bfa',
      cyan: '#2dd4bf', white: '#e6f3eb',
      brightBlack: '#385045', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#c4b5fd',
      brightCyan: '#5eead4', brightWhite: '#f5fff8',
    },
  },
  {
    id: 'ember',
    label: 'Ember',
    css: {
      '--bg-base': '#1b1412',
      '--bg-sidebar': '#15100f',
      '--bg-tab': '#241916',
      '--bg-tab-active': '#30211d',
      '--bg-tab-hover': '#2a1d19',
      '--accent': '#f97316',
      '--text-primary': '#f5ebe6',
      '--text-muted': '#a58a7c',
      '--border': '#4a3028',
      '--ring-color': '#fb7185',
    },
    xterm: {
      background: '#1b1412',
      foreground: '#f5ebe6',
      cursor: '#f97316',
      cursorAccent: '#1b1412',
      selectionBackground: 'rgba(249,115,22,0.25)',
      black: '#1b1412', red: '#fb7185', green: '#34d399',
      yellow: '#fbbf24', blue: '#7dd3fc', magenta: '#f0abfc',
      cyan: '#22d3ee', white: '#f5ebe6',
      brightBlack: '#594038', brightRed: '#fda4af', brightGreen: '#6ee7b7',
      brightYellow: '#fcd34d', brightBlue: '#bae6fd', brightMagenta: '#f5d0fe',
      brightCyan: '#67e8f9', brightWhite: '#fff7f3',
    },
  },
  {
    id: 'cobalt',
    label: 'Cobalt',
    css: {
      '--bg-base': '#101722',
      '--bg-sidebar': '#0b1119',
      '--bg-tab': '#162031',
      '--bg-tab-active': '#1c2940',
      '--bg-tab-hover': '#1a2538',
      '--accent': '#38bdf8',
      '--text-primary': '#e5f0ff',
      '--text-muted': '#7f93b0',
      '--border': '#2a3c58',
      '--ring-color': '#f59e0b',
    },
    xterm: {
      background: '#101722',
      foreground: '#e5f0ff',
      cursor: '#38bdf8',
      cursorAccent: '#101722',
      selectionBackground: 'rgba(56,189,248,0.25)',
      black: '#101722', red: '#f87171', green: '#22c55e',
      yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc',
      cyan: '#38bdf8', white: '#e5f0ff',
      brightBlack: '#334155', brightRed: '#fca5a5', brightGreen: '#86efac',
      brightYellow: '#fde047', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
      brightCyan: '#7dd3fc', brightWhite: '#f8fbff',
    },
  },
];

export const DEFAULT_WORKSPACE_THEME_ID = 'violet';

export function createWorkspaceManager({
  document,
  workspaces,
  tabs,
  panes,
  getActiveWorkspaceId,
  setActiveWorkspaceId,
  getActiveTabId,
  setActiveTabId,
  setActivePaneId,
  activateTab,
  syncBrowserVisibility,
  getDefaultTarget,
  createTab,
  closeTab,
  onLayoutChanged,
}) {
  function orderedWorkspaceIds() {
    return [...workspaces.values()]
      .sort((a, b) => Number(b.pinned) - Number(a.pinned))
      .map((ws) => ws.id);
  }

  function orderedWorkspaceEntries() {
    return orderedWorkspaceIds().map((id) => workspaces.get(id)).filter(Boolean);
  }

  function getWorkspaceTheme(themeId = DEFAULT_WORKSPACE_THEME_ID) {
    return WORKSPACE_THEMES.find((theme) => theme.id === themeId) ?? WORKSPACE_THEMES[0];
  }

  function getWorkspaceThemeById(wsId = getActiveWorkspaceId()) {
    const workspace = workspaces.get(wsId);
    return getWorkspaceTheme(workspace?.themeId ?? DEFAULT_WORKSPACE_THEME_ID);
  }

  function applyWorkspaceTheme(wsId = getActiveWorkspaceId()) {
    const theme = getWorkspaceThemeById(wsId);
    for (const [name, value] of Object.entries(theme.css)) {
      document.documentElement.style.setProperty(name, value);
    }
    document.documentElement.dataset.workspaceTheme = theme.id;
    for (const pane of panes.values()) {
      const tab = tabs.get(pane.tabId);
      if (tab?.workspaceId !== wsId) continue;
      pane.terminal.options.theme = theme.xterm;
      pane.terminal.refresh(0, Math.max(0, pane.terminal.rows - 1));
    }
  }

  function renderWorkspaceBar() {
    const nameEl = document.getElementById('ws-name-label');
    if (!nameEl) return;
    const activeWorkspaceId = getActiveWorkspaceId();
    const ws = workspaces.get(activeWorkspaceId);
    if (ws) nameEl.textContent = ws.name;
    const ids = orderedWorkspaceIds();
    const idx = ids.indexOf(activeWorkspaceId);
    document.getElementById('btn-prev-ws').disabled = idx <= 0;
    document.getElementById('btn-next-ws').disabled = idx >= ids.length - 1;
    const pinBtn = document.getElementById('btn-pin-ws');
    if (pinBtn) {
      pinBtn.textContent = ws?.pinned ? '★' : '☆';
      pinBtn.title = ws?.pinned ? 'Unpin workspace' : 'Pin workspace';
    }
    const themeBtn = document.getElementById('btn-theme-ws');
    if (themeBtn) {
      const theme = getWorkspaceTheme(ws?.themeId ?? DEFAULT_WORKSPACE_THEME_ID);
      themeBtn.title = `Workspace theme: ${theme.label}`;
      themeBtn.style.color = theme.css['--accent'];
    }
  }

  function setWorkspaceTheme(wsId, themeId) {
    const workspace = workspaces.get(wsId);
    if (!workspace) return;
    workspace.themeId = getWorkspaceTheme(themeId).id;
    if (workspace.id === getActiveWorkspaceId()) applyWorkspaceTheme(workspace.id);
    renderWorkspaceBar();
    onLayoutChanged?.();
  }

  function requireWorkspace(wsId = getActiveWorkspaceId()) {
    const workspace = workspaces.get(wsId);
    if (!workspace) throw new Error(`Workspace '${wsId}' not found`);
    return workspace;
  }

  function cycleWorkspaceTheme(wsId = getActiveWorkspaceId()) {
    const workspace = requireWorkspace(wsId);
    const currentIndex = WORKSPACE_THEMES.findIndex((theme) => theme.id === (workspace.themeId ?? DEFAULT_WORKSPACE_THEME_ID));
    const nextTheme = WORKSPACE_THEMES[(currentIndex + 1 + WORKSPACE_THEMES.length) % WORKSPACE_THEMES.length];
    setWorkspaceTheme(workspace.id, nextTheme.id);
  }

  function createWorkspaceMeta(name, pinned = false, themeId = DEFAULT_WORKSPACE_THEME_ID) {
    const wsId = crypto.randomUUID();
    const wsName = name ?? `Workspace ${workspaces.size + 1}`;
    workspaces.set(wsId, {
      id: wsId,
      name: wsName,
      pinned,
      themeId: getWorkspaceTheme(themeId).id,
      lastActiveTabId: null,
    });
    return wsId;
  }

  function switchWorkspace(wsId) {
    if (wsId === getActiveWorkspaceId()) return;
    for (const [, tab] of tabs) {
      if (tab.workspaceId === getActiveWorkspaceId()) {
        tab.tabEl.style.display = 'none';
        tab.contentEl.classList.remove('visible');
      }
    }
    setActiveWorkspaceId(wsId);
    applyWorkspaceTheme(wsId);

    let firstTab = null;
    let preferredTab = null;
    const workspace = workspaces.get(wsId);
    for (const [, tab] of tabs) {
      if (tab.workspaceId === wsId) {
        tab.tabEl.style.display = '';
        if (!firstTab) firstTab = tab;
        if (workspace?.lastActiveTabId === tab.tabId) preferredTab = tab;
      }
    }
    renderWorkspaceBar();
    if (preferredTab || firstTab) {
      setActiveTabId(null);
      setActivePaneId(null);
      activateTab((preferredTab ?? firstTab).tabId);
      onLayoutChanged?.();
      return;
    }
    setActiveTabId(null);
    setActivePaneId(null);
    document.body.classList.remove('has-tabs');
    syncBrowserVisibility();
    onLayoutChanged?.();
  }

  function setWorkspacePinned(wsId, pinned) {
    const ws = workspaces.get(wsId);
    if (!ws) return;
    ws.pinned = !!pinned;
    renderWorkspaceBar();
    onLayoutChanged?.();
  }

  function startWorkspaceRename() {
    const ws = workspaces.get(getActiveWorkspaceId());
    if (!ws) return;
    const nameEl = document.getElementById('ws-name-label');
    if (!nameEl) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ws-name-input';
    input.value = ws.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const value = input.value.trim() || ws.name;
      ws.name = value;
      const span = document.createElement('span');
      span.id = 'ws-name-label';
      span.title = 'Double-click to rename workspace';
      span.textContent = value;
      span.addEventListener('dblclick', startWorkspaceRename);
      input.replaceWith(span);
      onLayoutChanged?.();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        input.value = ws.name;
        input.blur();
      }
    });
  }

  async function createWorkspace(name) {
    const wsId = createWorkspaceMeta(name);
    const prevWsId = getActiveWorkspaceId();
    if (prevWsId !== null) {
      for (const [, tab] of tabs) {
        if (tab.workspaceId === prevWsId) tab.tabEl.style.display = 'none';
      }
      if (getActiveTabId()) {
        const prev = tabs.get(getActiveTabId());
        if (prev) prev.contentEl.classList.remove('visible');
      }
      setActiveTabId(null);
      setActivePaneId(null);
    }
    setActiveWorkspaceId(wsId);
    applyWorkspaceTheme(wsId);
    renderWorkspaceBar();
    await createTab(getDefaultTarget());
    onLayoutChanged?.();
  }

  async function closeWorkspace(wsId) {
    const wsTabIds = [...tabs.values()].filter((tab) => tab.workspaceId === wsId).map((tab) => tab.tabId);
    for (const tabId of wsTabIds) await closeTab(tabId, true);
    workspaces.delete(wsId);
    if (workspaces.size === 0) {
      const newId = createWorkspaceMeta('Workspace 1');
      setActiveWorkspaceId(newId);
      applyWorkspaceTheme(newId);
      renderWorkspaceBar();
      await createTab(getDefaultTarget());
      onLayoutChanged?.();
      return;
    }
    if (wsId === getActiveWorkspaceId()) {
      setActiveWorkspaceId(null);
      switchWorkspace(orderedWorkspaceIds()[0]);
      onLayoutChanged?.();
      return;
    }
    renderWorkspaceBar();
    onLayoutChanged?.();
  }

  return {
    orderedWorkspaceIds,
    orderedWorkspaceEntries,
    getWorkspaceTheme,
    getWorkspaceThemeById,
    applyWorkspaceTheme,
    setWorkspaceTheme,
    cycleWorkspaceTheme,
    createWorkspaceMeta,
    switchWorkspace,
    renderWorkspaceBar,
    setWorkspacePinned,
    startWorkspaceRename,
    createWorkspace,
    closeWorkspace,
    requireWorkspace,
  };
}