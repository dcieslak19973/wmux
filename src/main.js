/**
 * wmux frontend — main.js
 *
 * Architecture:
 *   - Each Tab contains a tree of split Panes; each Pane has one ConPTY session.
 *   - Splitting: Ctrl+Shift+\ (horizontal) / Ctrl+Shift+- (vertical)
 *   - Tab rename: double-click tab title -> inline edit
 *   - Keyboard input  : xterm onData -> Tauri invoke("write_to_session")
 *   - Terminal output : Tauri event "terminal-output-{id}" -> xterm.write()
 *   - URL detection   : Tauri event "terminal-url-{id}"    -> URL banner overlay
 *   - Resize          : ResizeObserver on each pane leaf    -> invoke("resize_session")
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { ImageAddon } from '@xterm/addon-image';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { marked } from 'marked';
import 'highlight.js/styles/github-dark.css';
import '@xterm/xterm/css/xterm.css';

marked.setOptions({ gfm: true, breaks: true });

// Global state

/** @type {Map<string, TabState>} */
const tabs  = new Map();

/** @type {Map<string, PaneState>} */
const panes = new Map();

let activeTabId  = null;
let activePaneId = null;
let activeBrowserLabel = null;
let activeMarkdownLabel = null;
let zoomedSurfaceEl = null;
let contextMenuCleanup = null;

/** Per-tab notification list.  tabId → Array<{id, title, body, time, read, paneId}> */
const notifications = new Map();
let notifPanelTabId = null;

/** Captured HTML artifacts extracted from pane output. */
const artifacts = [];
let artifactPanelVisible = false;

/** Map of markdown label -> markdown pane state. */
const markdownPanes = new Map();

// ── Workspace state ────────────────────────────────────────────────────────────────────

/** @type {Map<string, {id:string, name:string, pinned:boolean}>} */
const workspaces = new Map();
let activeWorkspaceId = null;

// ── Settings ──────────────────────────────────────────────────────────────────

const SETTINGS_DEFAULTS = {
  fontSize:   13,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  lineHeight: 1.2,
  scrollback:  5000,
  cursorStyle: 'bar',
  cursorBlink: true,
};

function loadSettings() {
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem('wmux-settings') ?? '{}') }; }
  catch { return { ...SETTINGS_DEFAULTS }; }
}

function saveSettings(s) {
  localStorage.setItem('wmux-settings', JSON.stringify(s));
}

function applySettingsToAllPanes(s) {
  for (const [id, p] of panes) {
    p.terminal.options.fontSize   = s.fontSize;
    p.terminal.options.fontFamily = s.fontFamily;
    p.terminal.options.lineHeight = s.lineHeight;
    p.terminal.options.cursorStyle = s.cursorStyle;
    p.terminal.options.cursorBlink = s.cursorBlink;
    fitAndResizePane(id);
  }
}

function orderedWorkspaceIds() {
  return [...workspaces.values()]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned))
    .map(ws => ws.id);
}

function orderedWorkspaceEntries() {
  return orderedWorkspaceIds().map(id => workspaces.get(id)).filter(Boolean);
}

function _createWorkspaceMeta(name, pinned = false) {
  const wsId = crypto.randomUUID();
  const wsName = name ?? `Workspace ${workspaces.size + 1}`;
  workspaces.set(wsId, { id: wsId, name: wsName, pinned });
  return wsId;
}

function switchWorkspace(wsId) {
  if (wsId === activeWorkspaceId) return;
  // Hide tabs of current workspace
  for (const [, t] of tabs) {
    if (t.workspaceId === activeWorkspaceId) {
      t.tabEl.style.display = 'none';
      t.contentEl.classList.remove('visible');
    }
  }
  activeWorkspaceId = wsId;
  // Show tabs of new workspace
  let firstTab = null;
  for (const [, t] of tabs) {
    if (t.workspaceId === wsId) {
      t.tabEl.style.display = '';
      if (!firstTab) firstTab = t;
    }
  }
  renderWorkspaceBar();
  if (firstTab) {
    activeTabId = null;
    activePaneId = null;
    activateTab(firstTab.tabId);
  } else {
    activeTabId = null;
    activePaneId = null;
    document.body.classList.remove('has-tabs');
  }
}

function renderWorkspaceBar() {
  const nameEl = document.getElementById('ws-name-label');
  if (!nameEl) return;
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
}

function setWorkspacePinned(wsId, pinned) {
  const ws = workspaces.get(wsId);
  if (!ws) return;
  ws.pinned = !!pinned;
  renderWorkspaceBar();
}

function startWorkspaceRename() {
  const ws = workspaces.get(activeWorkspaceId);
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
    const v = input.value.trim() || ws.name;
    ws.name = v;
    const span = document.createElement('span');
    span.id = 'ws-name-label';
    span.title = 'Double-click to rename workspace';
    span.textContent = v;
    span.addEventListener('dblclick', startWorkspaceRename);
    input.replaceWith(span);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = ws.name; input.blur(); }
  });
}

async function createWorkspace(name) {
  const wsId = _createWorkspaceMeta(name);
  const prevWsId = activeWorkspaceId;
  if (prevWsId !== null) {
    // Hide current workspace tabs
    for (const [, t] of tabs) {
      if (t.workspaceId === prevWsId) t.tabEl.style.display = 'none';
    }
    if (activeTabId) {
      const prev = tabs.get(activeTabId);
      if (prev) prev.contentEl.classList.remove('visible');
    }
    activeTabId = null;
    activePaneId = null;
  }
  activeWorkspaceId = wsId;
  renderWorkspaceBar();
  await createTab(getDefaultTarget());
}

async function closeWorkspace(wsId) {
  const wsTabIds = [...tabs.values()].filter(t => t.workspaceId === wsId).map(t => t.tabId);
  for (const tid of wsTabIds) await closeTab(tid, true);
  workspaces.delete(wsId);
  if (workspaces.size === 0) {
    const newId = _createWorkspaceMeta('Workspace 1');
    activeWorkspaceId = newId;
    renderWorkspaceBar();
    await createTab(getDefaultTarget());
  } else if (wsId === activeWorkspaceId) {
    activeWorkspaceId = null;
    switchWorkspace(orderedWorkspaceIds()[0]);
  } else {
    renderWorkspaceBar();
  }
}

// ── Default session target ────────────────────────────────────────────────────

function getDefaultTarget() {
  try {
    const raw = localStorage.getItem('wmux-default-target');
    if (raw) return JSON.parse(raw);
  } catch {}
  return { type: 'local' };
}

function setDefaultTarget(target) {
  localStorage.setItem('wmux-default-target', JSON.stringify(target));
  updateNewTabTooltip();
}

function defaultTargetLabel(t) {
  if (!t || t.type === 'local') return 'Local';
  if (t.type === 'wsl')  return t.distro ?? 'WSL';
  if (t.type === 'ssh')  return `${t.user ? t.user + '@' : ''}${t.host}`;
  return 'Local';
}

function parsePortFromUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.port || '';
  } catch {
    return '';
  }
}

function unreadNotificationCount(tabId) {
  return (notifications.get(tabId) ?? []).filter(n => !n.read).length;
}

function closeContextMenu() {
  if (contextMenuCleanup) contextMenuCleanup();
  contextMenuCleanup = null;
}

function showContextMenu(items, x, y) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.innerHTML = items.map((item, index) => {
    if (item.type === 'separator') return `<div class="context-sep"></div>`;
    return `
      <button class="context-item${item.danger ? ' danger' : ''}" data-index="${index}" ${item.disabled ? 'disabled' : ''}>
        <span>${escHtml(item.label)}</span>
      </button>
    `;
  }).join('');
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const margin = 8;
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - margin)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - margin)}px`;

  menu.querySelectorAll('.context-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item = items[Number(btn.dataset.index)];
      closeContextMenu();
      if (!item?.disabled) await item.action?.();
    });
  });

  const onDown = (event) => {
    if (!menu.contains(event.target)) closeContextMenu();
  };
  const onEscape = (event) => {
    if (event.key === 'Escape') closeContextMenu();
  };
  document.addEventListener('mousedown', onDown);
  document.addEventListener('keydown', onEscape);
  contextMenuCleanup = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onEscape);
  };
}

function getCurrentSurfaceElement() {
  if (activeMarkdownLabel) return markdownPanes.get(activeMarkdownLabel)?.markdownEl ?? null;
  if (activeBrowserLabel) return browserPanes.get(activeBrowserLabel)?.browserEl ?? null;
  if (activePaneId) return panes.get(activePaneId)?.domEl ?? null;
  return null;
}

function getActiveTabState() {
  return activeTabId ? tabs.get(activeTabId) : null;
}

function getActiveBrowserState() {
  return activeBrowserLabel ? browserPanes.get(activeBrowserLabel) : null;
}

function getActiveMarkdownState() {
  return activeMarkdownLabel ? markdownPanes.get(activeMarkdownLabel) : null;
}

function clearActiveSurface() {
  if (activePaneId) panes.get(activePaneId)?.domEl.classList.remove('active-pane');
  if (activeBrowserLabel) browserPanes.get(activeBrowserLabel)?.browserEl.classList.remove('active-pane');
  if (activeMarkdownLabel) markdownPanes.get(activeMarkdownLabel)?.markdownEl.classList.remove('active-pane');
  activePaneId = null;
  activeBrowserLabel = null;
  activeMarkdownLabel = null;
}

function basenameFromPath(path) {
  return String(path ?? '').split(/[\\/]/).pop() || '';
}

function dirnameFromPath(path) {
  const value = String(path ?? '').replace(/[\\/]+$/, '');
  const match = value.match(/^(.*)[\\/][^\\/]+$/);
  return match?.[1] ?? '';
}

function isAbsolutePath(path) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(path);
}

function resolveMarkdownPath(input, baseDir = '') {
  const trimmed = String(input ?? '').trim();
  if (!trimmed) return '';
  if (isAbsolutePath(trimmed) || !baseDir) return trimmed;
  const separator = baseDir.includes('\\') ? '\\' : '/';
  return `${baseDir.replace(/[\\/]+$/, '')}${separator}${trimmed.replace(/^[\\/]+/, '')}`;
}

function renderMarkdownHtml(source) {
  const rendered = marked.parse(source ?? '');
  return DOMPurify.sanitize(typeof rendered === 'string' ? rendered : '');
}

function highlightMarkdownCodeBlocks(container) {
  if (!container) return;
  container.querySelectorAll('pre code').forEach((codeEl) => {
    const rawText = codeEl.textContent ?? '';
    if (!rawText.trim()) return;

    const languageClass = [...codeEl.classList].find((name) => name.startsWith('language-'));
    const language = languageClass?.slice('language-'.length);

    if (language && hljs.getLanguage(language)) {
      codeEl.innerHTML = hljs.highlight(rawText, { language, ignoreIllegals: true }).value;
      codeEl.classList.add('hljs');
      return;
    }

    codeEl.innerHTML = hljs.highlightAuto(rawText).value;
    codeEl.classList.add('hljs');
  });
}

function updateNewTabTooltip() {
  const label = defaultTargetLabel(getDefaultTarget());
  btnNewTab.title = `New tab — ${label} (Ctrl+Shift+T)`;
}

// DOM refs
const tabList           = document.getElementById('tab-list');
const terminalContainer = document.getElementById('terminal-container');
const btnNewTab         = document.getElementById('btn-new-tab');
const btnNewTabMore     = document.getElementById('btn-new-tab-more');

// xterm theme
const XTERM_THEME = {
  background:   '#1a1b1e',
  foreground:   '#e4e4e7',
  cursor:       '#7c6af7',
  cursorAccent: '#1a1b1e',
  selectionBackground: 'rgba(124,106,247,0.3)',
  black:   '#1a1b1e', red:     '#f87171', green:   '#4ade80',
  yellow:  '#fbbf24', blue:    '#60a5fa', magenta: '#c084fc',
  cyan:    '#22d3ee', white:   '#e4e4e7',
  brightBlack:  '#3f3f46', brightRed:    '#fca5a5', brightGreen:  '#86efac',
  brightYellow: '#fde68a', brightBlue:   '#93c5fd', brightMagenta:'#d8b4fe',
  brightCyan:   '#67e8f9', brightWhite:  '#f4f4f5',
};

// Create a new tab

async function createTab(target = { type: 'local' }, restoreData = null) {
  const tabId = crypto.randomUUID();
  const wsId  = activeWorkspaceId;

  const contentEl = document.createElement('div');
  contentEl.className = 'terminal-pane';
  contentEl.dataset.tabId = tabId;
  terminalContainer.appendChild(contentEl);

  const tabEl = document.createElement('div');
  tabEl.className = 'tab-item';
  tabEl.dataset.tabId = tabId;
  tabEl.innerHTML = `
    <span class="tab-ring"></span>
    <div class="tab-body">
      <div class="tab-header">
        <span class="tab-title" title="Double-click to rename">Terminal</span>
        <button class="tab-close" title="Close tab">×</button>
      </div>
      <div class="tab-meta">
        <span class="tab-target"></span>
        <span class="tab-cwd"></span>
        <span class="tab-branch"></span>
        <span class="tab-ports"></span>
      </div>
      <div class="tab-foot">
        <span class="tab-notif"></span>
        <span class="tab-unread-count"></span>
      </div>
    </div>
  `;
  tabList.appendChild(tabEl);

  // Hide immediately if not in active workspace
  if (wsId !== activeWorkspaceId || wsId === null) {
    tabEl.style.display = 'none';
  }

  tabEl.addEventListener('click', (e) => {
    if (e.target.classList.contains('tab-close')) return;
    activateTab(tabId);
  });
  tabEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const workspaceActions = orderedWorkspaceEntries()
      .filter(ws => ws.id !== wsId)
      .map(ws => ({
        label: `Move to ${ws.name}`,
        action: () => moveTabToWorkspace(tabId, ws.id),
      }));
    showContextMenu([
      { label: 'Rename tab', action: () => startTabRename(tabId, tabEl.querySelector('.tab-title')) },
      { label: 'Open browser split', action: () => openBrowserSplitForTab(tabId) },
      { label: 'Open markdown split', action: () => openMarkdownSplitForTab(tabId) },
      { type: 'separator' },
      ...workspaceActions,
      { label: 'Move to new workspace', action: async () => {
        const newWsId = _createWorkspaceMeta(`Workspace ${workspaces.size + 1}`);
        renderWorkspaceBar();
        await moveTabToWorkspace(tabId, newWsId);
        switchWorkspace(newWsId);
      } },
      { type: 'separator' },
      { label: 'Mark all read', action: () => markTabNotificationsRead(tabId), disabled: unreadNotificationCount(tabId) === 0 },
      { label: 'Clear notifications', action: () => clearTabNotifications(tabId), disabled: (notifications.get(tabId) ?? []).length === 0 },
      { type: 'separator' },
      { label: 'Close tab', action: () => closeTab(tabId), danger: true },
    ], e.clientX, e.clientY);
  });
  tabEl.querySelector('.tab-close').addEventListener('click', () => closeTab(tabId));
  tabEl.querySelector('.tab-title').addEventListener('dblclick', (e) => startTabRename(tabId, e.target));

  const tabState = {
    tabId,
    workspaceId: wsId,
    title: 'Terminal',
    userRenamed: restoreData?.userRenamed ?? false,
    hasRing: false,
    tabEl,
    contentEl,
    paneIds: new Set(),
    cwd: '',
    gitBranch: '',
    ports: new Set(),
    targetLabel: defaultTargetLabel(target),
    browserLabels: new Set(),
    markdownLabels: new Set(),
  };
  tabs.set(tabId, tabState);

  document.body.classList.add('has-tabs');
  contentEl.classList.add('visible');

  if (restoreData?.tree) {
    await restorePaneTree(tabId, restoreData.tree, contentEl);
  } else {
    await createLeafPane(tabId, target, contentEl);
  }

  // Re-apply a user-assigned title after pane creation (createLeafPane may overwrite it)
  if (restoreData?.userRenamed && restoreData?.title) {
    tabState.title = restoreData.title;
    const titleEl = tabEl.querySelector('.tab-title');
    if (titleEl) titleEl.textContent = restoreData.title;
  }

  if (activeTabId && activeTabId !== tabId) {
    contentEl.classList.remove('visible');
  }
  activateTab(tabId);
  updateTabNumbers();
  updateTabMeta(tabId);
}

async function moveTabToWorkspace(tabId, wsId) {
  const tab = tabs.get(tabId);
  if (!tab || !workspaces.has(wsId)) return;
  tab.workspaceId = wsId;
  tab.tabEl.style.display = wsId === activeWorkspaceId ? '' : 'none';
  tab.contentEl.classList.toggle('visible', wsId === activeWorkspaceId && activeTabId === tabId);
  if (activeTabId === tabId && wsId !== activeWorkspaceId) {
    const replacement = [...tabs.values()].find(t => t.workspaceId === activeWorkspaceId && t.tabId !== tabId);
    if (replacement) activateTab(replacement.tabId);
    else document.body.classList.remove('has-tabs');
  }
}

async function openBrowserSplitForTab(tabId, url = '') {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const paneId = [...tab.paneIds][0];
  if (!paneId) return;
  await splitPaneWithBrowser(paneId, 'h', { url });
}

// Create a leaf pane (session + xterm)

async function createLeafPane(tabId, target, mountEl) {
  const DEFAULT_COLS = 120;
  const DEFAULT_ROWS = 30;

  let result;
  try {
    result = await invoke('create_session', { cols: DEFAULT_COLS, rows: DEFAULT_ROWS, target });
  } catch (err) {
    showError(`Could not start terminal: ${err}`);
    return null;
  }

  const sessionId    = result.id;
  const sessionLabel = result.label;

  const _s = loadSettings();
  const term = new Terminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    theme: XTERM_THEME,
    fontFamily: _s.fontFamily,
    fontSize: _s.fontSize,
    lineHeight: _s.lineHeight,
    cursorBlink: _s.cursorBlink,
    cursorStyle: _s.cursorStyle,
    allowProposedApi: true,
    scrollback: _s.scrollback,
  });

  const fitAddon    = new FitAddon();
  const imageAddon  = new ImageAddon({
    pixelLimit: 8_388_608,
    storageLimit: 48,
    sixelSupport: true,
    iipSupport: true,
    kittySupport: true,
    showPlaceholder: true,
  });
  const searchAddon = new SearchAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(imageAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(new WebLinksAddon());

  const leafEl = document.createElement('div');
  leafEl.className = 'pane-leaf';
  leafEl.dataset.sessionId = sessionId;
  mountEl.appendChild(leafEl);

  // Per-pane command input buffer and history for Ctrl+Alt+H picker.
  const history = [];
  let cmdLineBuf = '';

  term.open(leafEl);

  term.onData(async (data) => {
    try { await invoke('write_to_session', { id: sessionId, data }); }
    catch (err) { console.warn('write_to_session error:', err); }
    // Track commands typed for history picker.
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const cmd = cmdLineBuf.trim();
        if (cmd && (history.length === 0 || history[history.length - 1] !== cmd)) {
          history.push(cmd);
          if (history.length > 500) history.shift();
        }
        cmdLineBuf = '';
      } else if (ch === '\x03' || ch === '\x15') {
        cmdLineBuf = '';
      } else if (ch === '\x7f') {
        cmdLineBuf = cmdLineBuf.slice(0, -1);
      } else if (ch >= ' ') {
        cmdLineBuf += ch;
      }
    }
  });

  const unlisten = await listen(`terminal-output-${sessionId}`, (event) => {
    const bytes = base64Decode(event.payload);
    term.write(bytes);
    if (sessionId !== activePaneId) {
      const tab = tabs.get(tabId);
      if (tab) setTabRing(tab, true);
    }
  });

  const unlistenUrl = await listen(`terminal-url-${sessionId}`, (event) => {
    const { url, is_oauth } = event.payload;
    registerTabUrl(tabId, url);
    showUrlBanner(sessionId, url, is_oauth);
  });

  const unlistenNotify = await listen(`terminal-notify-${sessionId}`, (event) => {
    const { title, body } = event.payload;
    addNotification(tabId, { title, body, paneId: sessionId, time: Date.now() });
  });

  // OSC 7 cwd: update tab metadata and fetch git branch
  const unlistenCwd = await listen(`terminal-cwd-${sessionId}`, async (event) => {
    const cwd = event.payload;
    const pane = panes.get(sessionId);
    if (pane) pane.cwd = cwd;
    await updateTabCwd(tabId, cwd);
  });

  const unlistenAll = () => { unlisten(); unlistenUrl(); unlistenNotify(); unlistenCwd(); };

  try { await invoke('start_session_stream', { id: sessionId }); }
  catch (err) { console.warn('start_session_stream error:', err); }

  term.onTitleChange((title) => {
    const tab = tabs.get(tabId);
    if (tab && !tab.userRenamed) {
      tab.title = title;
      const el = tab.tabEl.querySelector('.tab-title');
      if (el) el.textContent = title;
    }
  });

  const ro = new ResizeObserver(() => fitAndResizePane(sessionId));
  ro.observe(leafEl);

  leafEl.addEventListener('mousedown', () => activatePane(sessionId));

  // Pane action toolbar (shown on hover)
  const toolbarEl = document.createElement('div');
  toolbarEl.className = 'pane-toolbar';
  toolbarEl.innerHTML = `
    <button class="pane-tb-btn" data-action="split-h" title="Split right (Ctrl+Shift+\\)">&#x2502;</button>
    <button class="pane-tb-btn" data-action="split-v" title="Split down (Ctrl+Shift+-)">&#x2500;</button>
    <button class="pane-tb-btn" data-action="browser" title="Open browser pane">&#x25a6;</button>
    <button class="pane-tb-btn" data-action="markdown" title="Open markdown pane">MD</button>
    <button class="pane-tb-btn" data-action="artifact" title="Preview HTML artifact from output">HTML</button>
    <button class="pane-tb-btn" data-action="zoom" title="Toggle zoom (Ctrl+Alt+Enter)">&#x2922;</button>
    <button class="pane-tb-btn pane-tb-close" data-action="close" title="Close pane (Ctrl+Shift+W)">&#x2715;</button>
  `;
  toolbarEl.querySelector('[data-action="split-h"]').addEventListener('click', (e) => { e.stopPropagation(); splitPane(sessionId, 'h'); });
  toolbarEl.querySelector('[data-action="split-v"]').addEventListener('click', (e) => { e.stopPropagation(); splitPane(sessionId, 'v'); });
  toolbarEl.querySelector('[data-action="browser"]').addEventListener('click', (e) => { e.stopPropagation(); splitPaneWithBrowser(sessionId, 'h'); });
  toolbarEl.querySelector('[data-action="markdown"]').addEventListener('click', (e) => { e.stopPropagation(); splitPaneWithMarkdown(sessionId, 'h'); });
  toolbarEl.querySelector('[data-action="artifact"]').addEventListener('click', (e) => { e.stopPropagation(); previewArtifactFromPane(sessionId); });
  toolbarEl.querySelector('[data-action="zoom"]').addEventListener('click', (e) => { e.stopPropagation(); toggleSurfaceZoom(leafEl); });
  toolbarEl.querySelector('[data-action="close"]').addEventListener('click',   (e) => { e.stopPropagation(); closePane(sessionId); });
  leafEl.appendChild(toolbarEl);

  const paneState = {
    sessionId,
    tabId,
    target,
    terminal: term,
    fitAddon,
    searchAddon,
    domEl: leafEl,
    unlisten: unlistenAll,
    resizeObserver: ro,
    hasRing: false,
    history,
    cwd: '',
    imageAddon,
  };
  panes.set(sessionId, paneState);

  const tabState = tabs.get(tabId);
  if (tabState) tabState.paneIds.add(sessionId);

  if (tabState && !tabState.userRenamed && tabState.paneIds.size === 1) {
    tabState.title = sessionLabel;
    const el = tabState.tabEl.querySelector('.tab-title');
    if (el) el.textContent = sessionLabel;
  }

  updateTabMeta(tabId);

  return sessionId;
}

// Split the active pane

async function splitPane(paneId, dir) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const tabState = tabs.get(pane.tabId);
  if (!tabState) return;

  const leafEl   = pane.domEl;
  const parentEl = leafEl.parentElement;

  const splitEl = document.createElement('div');
  splitEl.className = `pane-split pane-split-${dir}`;

  leafEl.style.flex = '1 1 0';
  parentEl.replaceChild(splitEl, leafEl);
  splitEl.appendChild(leafEl);

  const dividerEl = document.createElement('div');
  dividerEl.className = `pane-divider pane-divider-${dir}`;
  dividerEl.addEventListener('mousedown', makeDividerDrag(splitEl, dir));
  splitEl.appendChild(dividerEl);

  const sideBEl = document.createElement('div');
  sideBEl.style.flex = '1 1 0';
  sideBEl.style.minWidth = '0';
  sideBEl.style.minHeight = '0';
  sideBEl.style.display = 'flex';
  splitEl.appendChild(sideBEl);

  const newSessionId = await createLeafPane(pane.tabId, getDefaultTarget(), sideBEl);
  if (newSessionId) {
    activatePane(newSessionId);
  }
  fitAndResizePane(paneId);
}

// Divider drag handler

function makeDividerDrag(splitEl, dir) {
  return (e) => {
    e.preventDefault();
    const nonDividers = [...splitEl.children].filter(
      c => !c.classList.contains('pane-divider'),
    );
    const [childA, childB] = nonDividers;

    const onMove = (ev) => {
      const rect = splitEl.getBoundingClientRect();
      let ratio = dir === 'h'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top)  / rect.height;
      ratio = Math.max(0.15, Math.min(0.85, ratio));
      childA.style.flex = `${ratio} 1 0`;
      childB.style.flex = `${1 - ratio} 1 0`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      splitEl.querySelectorAll('.pane-leaf').forEach(el => {
        const sid = el.dataset.sessionId;
        if (sid) fitAndResizePane(sid);
      });
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
}

// Activate a pane

function activatePane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;

  clearActiveSurface();
  activePaneId = paneId;
  pane.domEl.classList.add('active-pane');
  setPaneRing(paneId, false);
  markPaneNotificationsRead(pane.tabId, paneId);

  if (pane.tabId !== activeTabId) {
    activateTab(pane.tabId);
    return;
  }

  requestAnimationFrame(() => {
    fitAndResizePane(paneId);
    pane.terminal.focus();
    const tab = tabs.get(pane.tabId);
    if (tab) setTabRing(tab, false);
  });
}

function activateBrowser(label) {
  const state = browserPanes.get(label);
  if (!state) return;

  clearActiveSurface();
  activeBrowserLabel = label;
  state.browserEl.classList.add('active-pane');

  if (state.tabId !== activeTabId) {
    activateTab(state.tabId);
  }
}

function activateMarkdown(label) {
  const state = markdownPanes.get(label);
  if (!state) return;

  clearActiveSurface();
  activeMarkdownLabel = label;
  state.markdownEl.classList.add('active-pane');

  if (state.tabId !== activeTabId) {
    activateTab(state.tabId);
    return;
  }

  requestAnimationFrame(() => {
    state.markdownEl.querySelector('.markdown-path')?.focus();
  });
}

// Activate a tab

function activateTab(tabId) {
  if (activeTabId && activeTabId !== tabId) {
    const prev = tabs.get(activeTabId);
    if (prev) {
      prev.contentEl.classList.remove('visible');
      prev.tabEl.classList.remove('active');
    }
  }

  activeTabId = tabId;
  const tab = tabs.get(tabId);
  if (!tab) return;

  tab.contentEl.classList.add('visible');
  tab.tabEl.classList.add('active');
  setTabRing(tab, false);
  markTabNotificationsRead(tabId);
  updateTabMeta(tabId);

  requestAnimationFrame(() => {
    const target = (activePaneId && tab.paneIds.has(activePaneId))
      ? activePaneId
      : [...tab.paneIds][0];
    if (target) activatePane(target);
  });
}

// Close a pane

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

async function closePane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;

  const tab = tabs.get(pane.tabId);
  if (!tab || tab.paneIds.size <= 1) {
    await closeTab(pane.tabId);
    return;
  }

  await _destroyPane(paneId);
  collapsePaneBranch(pane.domEl);

  if (activePaneId === paneId) {
    const remaining = [...tab.paneIds];
    if (remaining.length > 0) activatePane(remaining[remaining.length - 1]);
  }

  // Re-fit all remaining panes after the DOM has settled.
  requestAnimationFrame(() => {
    for (const pid of [...tab.paneIds]) fitAndResizePane(pid);
  });
}

// Close an entire tab

async function closeTab(tabId, skipWorkspaceCheck = false) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  for (const browserEl of [...tab.contentEl.querySelectorAll('.browser-pane-leaf')]) {
    const label = browserEl.dataset.browserLabel;
    if (label) await closeBrowserSurface(label, { collapse: false });
  }

  for (const markdownEl of [...tab.contentEl.querySelectorAll('.markdown-pane-leaf')]) {
    const label = markdownEl.dataset.markdownLabel;
    if (label) closeMarkdownSurface(label, { collapse: false });
  }

  for (const paneId of [...tab.paneIds]) {
    await _destroyPane(paneId);
  }

  tab.contentEl.remove();
  tab.tabEl.remove();
  tabs.delete(tabId);

  if (activeTabId === tabId) {
    activeTabId  = null;
    activePaneId = null;
    // Find another tab in same workspace
    const remaining = [...tabs.values()].filter(
      t => t.workspaceId === activeWorkspaceId,
    );
    if (remaining.length > 0) {
      activateTab(remaining[remaining.length - 1].tabId);
    } else {
      document.body.classList.remove('has-tabs');
    }
  }

  updateTabNumbers();
}

async function _destroyPane(paneId) {
  const pane = panes.get(paneId);
  if (!pane) return;
  pane.unlisten();
  pane.resizeObserver.disconnect();
  pane.terminal.dispose();
  const tab = tabs.get(pane.tabId);
  if (tab) tab.paneIds.delete(paneId);
  panes.delete(paneId);
  try { await invoke('close_session', { id: paneId }); } catch { /* already dead */ }
}

async function closeBrowserSurface(label, { collapse = true } = {}) {
  const state = browserPanes.get(label);
  if (!state) return;

  state.resizeObserver?.disconnect();
  browserPanes.delete(label);
  tabs.get(state.tabId)?.browserLabels?.delete(label);
  if (activeBrowserLabel === label) activeBrowserLabel = null;
  await invoke('close_browser_window', { label }).catch(() => {});

  if (collapse) {
    collapsePaneBranch(state.browserEl);
    requestAnimationFrame(() => {
      for (const [pid] of panes) fitAndResizePane(pid);
    });
    updateTabMeta(state.tabId);
  }
}

function closeMarkdownSurface(label, { collapse = true } = {}) {
  const state = markdownPanes.get(label);
  if (!state) return;

  markdownPanes.delete(label);
  tabs.get(state.tabId)?.markdownLabels?.delete(label);
  if (activeMarkdownLabel === label) activeMarkdownLabel = null;

  if (collapse) {
    collapsePaneBranch(state.markdownEl);
    requestAnimationFrame(() => {
      for (const [pid] of panes) fitAndResizePane(pid);
    });
    updateTabMeta(state.tabId);
  }
}

// Tab rename (double-click title)

function startTabRename(tabId, titleEl) {
  const tab = tabs.get(tabId);
  if (!tab) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-title-input';
  input.value = tab.title;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const newTitle  = input.value.trim() || tab.title;
    tab.title       = newTitle;
    tab.userRenamed = !!input.value.trim();
    const span = document.createElement('span');
    span.className = 'tab-title';
    span.title = 'Double-click to rename';
    span.textContent = newTitle;
    span.addEventListener('dblclick', (e) => startTabRename(tabId, e.target));
    input.replaceWith(span);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = tab.title; input.blur(); }
  });
}

// ── Tab metadata (cwd + git branch + notification text) ─────────────────────────

async function updateTabCwd(tabId, cwd) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  tab.cwd = cwd;
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const short = parts.length > 2 ? '…/' + parts.slice(-2).join('/') : (parts.join('/') || cwd);
  const el = tab.tabEl.querySelector('.tab-cwd');
  if (el) el.textContent = short;
  try {
    const branch = await invoke('get_git_branch', { cwd });
    tab.gitBranch = branch ?? '';
    const bEl = tab.tabEl.querySelector('.tab-branch');
    if (bEl) bEl.textContent = branch ? `⎋ ${branch}` : '';
  } catch { /* git not available */ }
}

async function fitAndResizePane(sessionId) {
  const pane = panes.get(sessionId);
  if (!pane) return;
  const tab = tabs.get(pane.tabId);
  if (!tab || !tab.contentEl.classList.contains('visible')) return;
  pane.fitAddon.fit();
  const { cols, rows } = pane.terminal;
  try { await invoke('resize_session', { id: sessionId, cols, rows }); }
  catch { /* session may have exited */ }
}

function setTabRing(tab, active) {
  tab.hasRing = active;
  tab.tabEl.querySelector('.tab-ring').classList.toggle('ring-active', active);
}

function toggleSurfaceZoom(surfaceEl) {
  const tab = getActiveTabState();
  if (!tab || !surfaceEl) return;

  if (zoomedSurfaceEl === surfaceEl) {
    tab.contentEl.classList.remove('zoom-mode');
    surfaceEl.classList.remove('zoomed-pane');
    zoomedSurfaceEl = null;
  } else {
    tab.contentEl.querySelectorAll('.zoomed-pane').forEach(el => el.classList.remove('zoomed-pane'));
    tab.contentEl.classList.add('zoom-mode');
    surfaceEl.classList.add('zoomed-pane');
    zoomedSurfaceEl = surfaceEl;
  }

  requestAnimationFrame(() => {
    for (const pid of tab.paneIds) fitAndResizePane(pid);
  });
}

function updateTabNumbers() {
  const termTabs = [...tabs.values()].filter(
    t => t.workspaceId === activeWorkspaceId &&
         !t.userRenamed && (t.title === 'Terminal' || /^Terminal \d+$/.test(t.title)),
  );
  let n = 1;
  for (const t of termTabs) {
    t.title = termTabs.length === 1 ? 'Terminal' : `Terminal ${n}`;
    const el = t.tabEl.querySelector('.tab-title');
    if (el) el.textContent = t.title;
    n++;
  }
}

function showError(msg) {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#7f1d1d;color:#fecaca;padding:10px 14px;border-radius:8px;font-size:12px;z-index:9999;max-width:340px;';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

function showUrlBanner(sessionId, url, isOauth) {
  const pane = panes.get(sessionId);
  if (!pane) return;

  const banner = document.createElement('div');
  banner.className = 'url-banner' + (isOauth ? ' url-banner-oauth' : '');

  const icon  = isOauth ? '🔑' : '🔗';
  const label = isOauth ? 'OAuth redirect detected' : 'Local server';
  const short = url.length > 50 ? url.slice(0, 47) + '...' : url;

  banner.innerHTML = `
    <span class="url-banner-icon">${icon}</span>
    <span class="url-banner-text">
      <strong>${label}</strong>
      <span class="url-banner-url" title="${url}">${short}</span>
    </span>
    <button class="url-banner-open" data-url="${url}">Open in browser</button>
    <button class="url-banner-close" title="Dismiss">x</button>
  `;

  banner.querySelector('.url-banner-open').addEventListener('click', async () => {
    try { await invoke('open_url', { url }); }
    catch (err) { showError(`Could not open URL: ${err}`); }
  });
  banner.querySelector('.url-banner-close').addEventListener('click', () => banner.remove());

  pane.domEl.appendChild(banner);
  setTimeout(() => banner.remove(), 30_000);
}

function base64Decode(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function looksLikeHtmlArtifact(snippet) {
  return /<(?:!doctype\s+html|html|body|head|svg|div|section|article|main|aside|header|footer|nav|canvas|form|table|style|script)\b/i.test(snippet);
}

function normalizeArtifactHtml(raw, kind) {
  const trimmed = raw.trim();
  const baseHead = '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';

  if (/^<!doctype html/i.test(trimmed) || /^<html\b/i.test(trimmed)) return trimmed;
  if (/^<head\b/i.test(trimmed)) return `<!doctype html><html>${trimmed}<body></body></html>`;
  if (/^<body\b/i.test(trimmed)) return `<!doctype html><html><head>${baseHead}</head>${trimmed}</html>`;
  if (kind === 'svg' || /^<svg\b/i.test(trimmed)) {
    return `<!doctype html><html><head>${baseHead}<title>SVG Artifact</title><style>html,body{margin:0;padding:0;background:#111827;color:#e5e7eb}body{display:flex;align-items:center;justify-content:center;min-height:100vh}svg{max-width:100vw;max-height:100vh}</style></head><body>${trimmed}</body></html>`;
  }
  return `<!doctype html><html><head>${baseHead}</head><body>${trimmed}</body></html>`;
}

function artifactTitleFromHtml(html, kind) {
  const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch?.[1]?.trim()) return titleMatch[1].trim();
  if (kind === 'svg') return 'SVG Artifact';
  if (kind === 'body') return 'Body Fragment';
  if (kind === 'head') return 'Head Fragment';
  if (kind === 'fragment') return 'HTML Fragment';
  return 'HTML Artifact';
}

function extractHtmlArtifacts(output) {
  if (!output) return [];

  const artifactsFound = [];
  const seen = new Set();
  const pushCandidate = (candidate, hintedKind = 'html') => {
    const trimmed = candidate?.trim();
    if (!trimmed || !looksLikeHtmlArtifact(trimmed)) return;

    let kind = hintedKind;
    if (/^<!doctype html/i.test(trimmed) || /^<html\b/i.test(trimmed)) kind = 'document';
    else if (/^<svg\b/i.test(trimmed)) kind = 'svg';
    else if (/^<body\b/i.test(trimmed)) kind = 'body';
    else if (/^<head\b/i.test(trimmed)) kind = 'head';
    else if (kind === 'html') kind = 'fragment';

    const html = normalizeArtifactHtml(trimmed, kind);
    if (seen.has(html)) return;
    seen.add(html);
    artifactsFound.push({ html, kind, title: artifactTitleFromHtml(html, kind) });
  };

  for (const match of output.matchAll(/```(?:\s*(html|svg|xml|xhtml))?\s*([\s\S]*?)```/gi)) {
    pushCandidate(match[2], (match[1] ?? 'html').toLowerCase());
  }
  for (const match of output.matchAll(/<!doctype html[\s\S]*?<\/html>/gi)) pushCandidate(match[0], 'document');
  for (const match of output.matchAll(/<html[\s\S]*?<\/html>/gi)) pushCandidate(match[0], 'document');
  for (const match of output.matchAll(/<body[\s\S]*?<\/body>/gi)) pushCandidate(match[0], 'body');
  for (const match of output.matchAll(/<svg[\s\S]*?<\/svg>/gi)) pushCandidate(match[0], 'svg');

  return artifactsFound;
}

async function openArtifactPreview(artifactId) {
  const artifact = artifacts.find(item => item.id === artifactId);
  if (!artifact) return;

  const sourcePane = artifact.paneId ? panes.get(artifact.paneId) : null;
  const targetTabId = tabs.has(artifact.tabId) ? artifact.tabId : activeTabId;

  if (sourcePane?.tabId && tabs.get(sourcePane.tabId)?.workspaceId !== activeWorkspaceId) {
    switchWorkspace(tabs.get(sourcePane.tabId).workspaceId);
  } else if (targetTabId && tabs.get(targetTabId)?.workspaceId !== activeWorkspaceId) {
    switchWorkspace(tabs.get(targetTabId).workspaceId);
  }

  if (sourcePane) {
    activateTab(sourcePane.tabId);
    activatePane(sourcePane.sessionId);
    await splitPaneWithBrowser(sourcePane.sessionId, 'h', { url: artifact.previewUrl });
    return;
  }

  if (targetTabId && tabs.has(targetTabId)) {
    activateTab(targetTabId);
    await openBrowserSplitForTab(targetTabId, artifact.previewUrl);
    return;
  }

  await createTab(getDefaultTarget());
  if (activeTabId) await openBrowserSplitForTab(activeTabId, artifact.previewUrl);
}

async function openMarkdownSplitForTab(tabId, initialState = {}) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const paneId = [...tab.paneIds][0] ?? null;
  if (paneId) {
    await splitPaneWithMarkdown(paneId, 'h', initialState);
    return;
  }
  await createMarkdownLeaf(tabId, tab.contentEl, initialState);
}

function toggleArtifactPanel(force) {
  artifactPanelVisible = typeof force === 'boolean' ? force : !artifactPanelVisible;
  renderArtifactPanel();
}

function renderArtifactPanel() {
  document.getElementById('artifact-panel')?.remove();
  if (!artifactPanelVisible) return;

  const panel = document.createElement('div');
  panel.id = 'artifact-panel';
  panel.className = 'artifact-panel';
  panel.innerHTML = `
    <div class="artifact-header">
      <span>Artifacts</span>
      <div class="artifact-actions">
        <button class="artifact-btn" data-action="capture">Capture current</button>
        <button class="artifact-btn" data-action="clear">Clear</button>
        <button class="artifact-close" title="Close">✕</button>
      </div>
    </div>
    <div class="artifact-list">
      ${artifacts.length === 0
        ? '<div class="artifact-empty">No captured artifacts</div>'
        : artifacts.map(item => `
            <div class="artifact-item" data-id="${item.id}">
              <div class="artifact-top">
                <div class="artifact-title">${escHtml(item.title)}</div>
                <span class="artifact-kind">${escHtml(item.kind)}</span>
              </div>
              <div class="artifact-meta">${escHtml(item.sourceLabel)} · ${new Date(item.time).toLocaleTimeString()}</div>
              <button class="artifact-open">Open</button>
            </div>`).join('')}
    </div>
  `;

  panel.querySelector('[data-action="capture"]').addEventListener('click', () => previewArtifactFromPane());
  panel.querySelector('[data-action="clear"]').addEventListener('click', () => {
    artifacts.length = 0;
    renderArtifactPanel();
  });
  panel.querySelector('.artifact-close').addEventListener('click', () => toggleArtifactPanel(false));
  panel.querySelectorAll('.artifact-item, .artifact-open').forEach(el => {
    el.addEventListener('click', async (event) => {
      const itemEl = event.currentTarget.closest('.artifact-item');
      if (!itemEl) return;
      await openArtifactPreview(itemEl.dataset.id);
    });
  });

  document.getElementById('content').appendChild(panel);
}

async function previewArtifactFromPane(paneId = activePaneId) {
  const pane = panes.get(paneId);
  if (!pane) {
    showError('No active terminal pane to preview');
    return;
  }

  try {
    const output = await invoke('capture_session_output_by_id', { id: paneId });
    const matches = extractHtmlArtifacts(output ?? '');
    if (matches.length === 0) {
      showError('No HTML artifact found in recent pane output');
      return;
    }

    const tab = tabs.get(pane.tabId);
    for (const match of matches) {
      const existing = artifacts.find(item => item.paneId === paneId && item.html === match.html);
      const previewUrl = await invoke('save_artifact_preview', { html: match.html });
      if (existing) {
        existing.previewUrl = previewUrl;
        existing.time = Date.now();
        existing.title = match.title;
        existing.kind = match.kind;
        continue;
      }
      artifacts.unshift({
        id: crypto.randomUUID(),
        paneId,
        tabId: pane.tabId,
        tabTitle: tab?.title ?? 'Tab',
        sourceLabel: `${tab?.title ?? 'Tab'} · ${defaultTargetLabel(pane.target)}`,
        title: match.title,
        kind: match.kind,
        html: match.html,
        previewUrl,
        time: Date.now(),
      });
    }
    if (artifacts.length > 50) artifacts.length = 50;
    artifactPanelVisible = true;
    renderArtifactPanel();
  } catch (err) {
    showError(`Could not preview artifact: ${err}`);
  }
}

function markTabNotificationsRead(tabId) {
  const list = notifications.get(tabId) ?? [];
  let changed = false;
  for (const notif of list) {
    if (!notif.read) {
      notif.read = true;
      changed = true;
    }
  }
  if (changed) updateTabMeta(tabId);
  const tab = tabs.get(tabId);
  if (tab) setTabRing(tab, false);
}

function markPaneNotificationsRead(tabId, paneId) {
  const list = notifications.get(tabId) ?? [];
  let changed = false;
  for (const notif of list) {
    if (notif.paneId === paneId && !notif.read) {
      notif.read = true;
      changed = true;
    }
  }
  if (changed) updateTabMeta(tabId);
}

function clearTabNotifications(tabId) {
  notifications.set(tabId, []);
  const tab = tabs.get(tabId);
  if (tab) setTabRing(tab, false);
  updateTabMeta(tabId);
  if (notifPanelTabId === tabId) renderNotifPanel(tabId);
}

function getTabPortSummary(tab) {
  if (!tab?.ports?.size) return '';
  const ports = [...tab.ports].slice(0, 3);
  const summary = ports.map(port => `:${port}`).join(' ');
  return tab.ports.size > 3 ? `${summary} +${tab.ports.size - 3}` : summary;
}

function updateTabMeta(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const targetEl = tab.tabEl.querySelector('.tab-target');
  if (targetEl) targetEl.textContent = tab.targetLabel ?? '';
  const portsEl = tab.tabEl.querySelector('.tab-ports');
  if (portsEl) portsEl.textContent = getTabPortSummary(tab);
  const notifEl = tab.tabEl.querySelector('.tab-notif');
  const latest = (notifications.get(tabId) ?? [])[0];
  if (notifEl) notifEl.textContent = latest?.title ?? '';
  const unreadEl = tab.tabEl.querySelector('.tab-unread-count');
  const unread = unreadNotificationCount(tabId);
  if (unreadEl) {
    unreadEl.textContent = unread > 0 ? String(unread) : '';
    unreadEl.classList.toggle('visible', unread > 0);
  }
  tab.tabEl.classList.toggle('has-notif', unread > 0);
}

function registerTabUrl(tabId, url) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const port = parsePortFromUrl(url);
  if (!port) return;
  tab.ports.add(port);
  updateTabMeta(tabId);
}

function setPaneRing(paneId, active) {
  const pane = panes.get(paneId);
  if (!pane) return;
  pane.hasRing = active;
  pane.domEl.classList.toggle('pane-attention', active);
}

// Notification system

function addNotification(tabId, notif) {
  if (!notifications.has(tabId)) notifications.set(tabId, []);
  const list = notifications.get(tabId);
  const isActive = activeTabId === tabId && activePaneId === notif.paneId;
  list.unshift({
    id: crypto.randomUUID(),
    title: notif.title,
    body: notif.body,
    time: notif.time,
    paneId: notif.paneId,
    read: isActive,
  });
  if (list.length > 100) list.pop();
  const tab = tabs.get(tabId);
  if (tab && !isActive) setTabRing(tab, true);
  if (!isActive && notif.paneId) setPaneRing(notif.paneId, true);
  updateTabMeta(tabId);
  if (notifPanelTabId === tabId) renderNotifPanel(tabId);
}

function toggleNotifPanel() {
  if (document.getElementById('notif-panel')) {
    document.getElementById('notif-panel').remove();
    notifPanelTabId = null;
    return;
  }
  if (!activeTabId) return;
  notifPanelTabId = activeTabId;
  renderNotifPanel(activeTabId);
}

function renderNotifPanel(tabId) {
  document.getElementById('notif-panel')?.remove();
  const list = notifications.get(tabId) ?? [];
  const tab  = tabs.get(tabId);

  const panel = document.createElement('div');
  panel.id = 'notif-panel';
  panel.className = 'notif-panel';
  panel.innerHTML = `
    <div class="notif-header">
      <span>Notifications — ${escHtml(tab?.title ?? 'Tab')}</span>
      <div class="notif-actions">
        <button class="notif-btn" data-action="read">Read all</button>
        <button class="notif-btn" data-action="clear">Clear</button>
        <button class="notif-close" title="Close (Ctrl+I)">✕</button>
      </div>
    </div>
    <div class="notif-list">
      ${list.length === 0
        ? '<div class="notif-empty">No notifications</div>'
        : list.map(n => `
            <div class="notif-item${n.read ? '' : ' unread'}" data-id="${n.id}">
              <div class="notif-title">${escHtml(n.title)}</div>
              ${n.body ? `<div class="notif-body">${escHtml(n.body)}</div>` : ''}
              <div class="notif-time">${new Date(n.time).toLocaleTimeString()}</div>
            </div>`).join('')}
    </div>
  `;
  panel.querySelector('[data-action="read"]').addEventListener('click', () => {
    markTabNotificationsRead(tabId);
    renderNotifPanel(tabId);
  });
  panel.querySelector('[data-action="clear"]').addEventListener('click', () => clearTabNotifications(tabId));
  panel.querySelector('.notif-close').addEventListener('click', () => {
    panel.remove();
    notifPanelTabId = null;
  });
  panel.querySelectorAll('.notif-item').forEach(el => {
    el.addEventListener('click', () => {
      const item = list.find(n => n.id === el.dataset.id);
      if (!item) return;
      item.read = true;
      if (tab) {
        if (activeWorkspaceId !== tab.workspaceId) switchWorkspace(tab.workspaceId);
        activateTab(tabId);
      }
      if (item.paneId && panes.has(item.paneId)) activatePane(item.paneId);
      renderNotifPanel(tabId);
    });
  });
  tab?.tabEl.classList.remove('has-notif');
  updateTabMeta(tabId);
  document.getElementById('content').appendChild(panel);
}

// Command history picker

function showHistoryPicker() {
  document.getElementById('history-picker')?.remove();
  const pane = panes.get(activePaneId);
  if (!pane || pane.history.length === 0) return;

  const picker = document.createElement('div');
  picker.id = 'history-picker';
  picker.className = 'history-picker';

  const buildItems = (filter = '') => {
    const items = [...pane.history].reverse()
      .filter(h => !filter || h.toLowerCase().includes(filter.toLowerCase()));
    return items.length
      ? items.map(cmd => `<div class="hist-item" data-cmd="${escHtml(cmd)}">${escHtml(cmd)}</div>`).join('')
      : '<div class="hist-empty">No matches</div>';
  };

  picker.innerHTML = `
    <input class="hist-search" placeholder="Filter history…" />
    <div class="hist-list">${buildItems()}</div>
    <div class="hist-hint">Click to insert · Double-click to run</div>
  `;

  const listEl   = picker.querySelector('.hist-list');
  const searchEl = picker.querySelector('.hist-search');

  const attachListeners = () => {
    listEl.querySelectorAll('.hist-item').forEach(el => {
      el.addEventListener('click', () => {
        invoke('write_to_session', { id: activePaneId, data: el.dataset.cmd });
        picker.remove();
        pane.terminal.focus();
      });
      el.addEventListener('dblclick', () => {
        invoke('write_to_session', { id: activePaneId, data: el.dataset.cmd + '\r' });
        picker.remove();
        pane.terminal.focus();
      });
    });
  };

  searchEl.addEventListener('input', () => {
    listEl.innerHTML = buildItems(searchEl.value);
    attachListeners();
  });
  picker.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { picker.remove(); pane.terminal.focus(); }
  });

  attachListeners();
  pane.domEl.appendChild(picker);
  searchEl.focus();
}

// ── In-pane terminal find ────────────────────────────────────────────────────

function showFindBar() {
  document.getElementById('find-bar')?.remove();
  const pane = panes.get(activePaneId);
  if (!pane) return;

  const bar = document.createElement('div');
  bar.id = 'find-bar';
  bar.className = 'find-bar';
  bar.innerHTML = `
    <input class="find-input" placeholder="Find in terminal…" />
    <span class="find-count"></span>
    <button class="find-btn" id="find-prev" title="Previous (Shift+Enter)">&#x2191;</button>
    <button class="find-btn" id="find-next" title="Next (Enter)">&#x2193;</button>
    <button class="find-btn find-close" title="Close (Esc)">&#x2715;</button>
  `;

  const input = bar.querySelector('.find-input');
  const doFind = (fwd = true) => {
    const q = input.value;
    if (!q) return;
    if (fwd) {
      pane.searchAddon.findNext(q, { decorations: { matchBackground: '#7c6af740', matchBorder: '#7c6af7', matchOverviewRuler: '#7c6af7' } });
    } else {
      pane.searchAddon.findPrevious(q, { decorations: { matchBackground: '#7c6af740', matchBorder: '#7c6af7', matchOverviewRuler: '#7c6af7' } });
    }
  };

  input.addEventListener('input', () => doFind(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); doFind(!e.shiftKey); }
    if (e.key === 'Escape') { bar.remove(); pane.terminal.focus(); }
  });
  bar.querySelector('#find-prev').addEventListener('click', () => doFind(false));
  bar.querySelector('#find-next').addEventListener('click', () => doFind(true));
  bar.querySelector('.find-close').addEventListener('click', () => { bar.remove(); pane.terminal.focus(); });

  document.getElementById('content').appendChild(bar);
  input.focus();
}

// ── Settings panel ─────────────────────────────────────────────────────────────

function showSettingsPanel() {
  document.getElementById('settings-panel')?.remove();
  const s = loadSettings();

  const panel = document.createElement('div');
  panel.id = 'settings-panel';
  panel.className = 'settings-panel';
  panel.innerHTML = `
    <div class="settings-header">
      <span>Settings</span>
      <button class="settings-close" title="Close">&#x2715;</button>
    </div>
    <div class="settings-body">
      <div class="settings-group">
        <div class="settings-group-label">Terminal</div>

        <label class="settings-row">
          <span class="settings-label">Font size</span>
          <div class="settings-stepper">
            <button class="stepper-btn" id="sp-font-dec">-</button>
            <span class="stepper-val" id="sp-font-val">${s.fontSize}</span>
            <button class="stepper-btn" id="sp-font-inc">+</button>
          </div>
        </label>

        <label class="settings-row">
          <span class="settings-label">Font family</span>
          <input class="settings-input" id="sp-font-family" type="text" value="${s.fontFamily.trim()}" spellcheck="false" />
        </label>

        <label class="settings-row">
          <span class="settings-label">Line height</span>
          <input class="settings-input settings-input-sm" id="sp-line-height" type="number"
            min="1" max="3" step="0.05" value="${s.lineHeight}" />
        </label>

        <label class="settings-row">
          <span class="settings-label">Scrollback lines</span>
          <input class="settings-input settings-input-sm" id="sp-scrollback" type="number"
            min="100" max="100000" step="100" value="${s.scrollback}" />
        </label>

        <label class="settings-row">
          <span class="settings-label">Cursor style</span>
          <select class="settings-select" id="sp-cursor-style">
            <option value="bar"    ${s.cursorStyle === 'bar'    ? 'selected' : ''}>Bar</option>
            <option value="block"  ${s.cursorStyle === 'block'  ? 'selected' : ''}>Block</option>
            <option value="underline" ${s.cursorStyle === 'underline' ? 'selected' : ''}>Underline</option>
          </select>
        </label>

        <label class="settings-row">
          <span class="settings-label">Cursor blink</span>
          <input class="settings-checkbox" id="sp-cursor-blink" type="checkbox" ${s.cursorBlink ? 'checked' : ''} />
        </label>
      </div>

      <div class="settings-group">
        <div class="settings-group-label">Window</div>

        <div class="settings-row">
          <span class="settings-label">New window</span>
          <button class="settings-btn-sm" id="sp-new-window">Open</button>
        </div>
      </div>

      <div class="settings-footer">
        <button class="settings-btn-apply" id="sp-apply">Apply</button>
        <button class="settings-btn-reset" id="sp-reset">Reset to defaults</button>
      </div>
    </div>
  `;

  document.body.appendChild(panel);

  let draft = { ...s };

  const fontValEl = panel.querySelector('#sp-font-val');
  panel.querySelector('#sp-font-dec').addEventListener('click', () => {
    draft.fontSize = Math.max(8, (draft.fontSize ?? 13) - 1);
    fontValEl.textContent = draft.fontSize;
  });
  panel.querySelector('#sp-font-inc').addEventListener('click', () => {
    draft.fontSize = Math.min(32, (draft.fontSize ?? 13) + 1);
    fontValEl.textContent = draft.fontSize;
  });

  panel.querySelector('#sp-apply').addEventListener('click', () => {
    draft.fontFamily  = panel.querySelector('#sp-font-family').value.trim() || s.fontFamily;
    draft.lineHeight  = parseFloat(panel.querySelector('#sp-line-height').value) || s.lineHeight;
    draft.scrollback  = parseInt(panel.querySelector('#sp-scrollback').value, 10) || s.scrollback;
    draft.cursorStyle = panel.querySelector('#sp-cursor-style').value;
    draft.cursorBlink = panel.querySelector('#sp-cursor-blink').checked;
    saveSettings(draft);
    applySettingsToAllPanes(draft);
    panel.remove();
  });

  panel.querySelector('#sp-reset').addEventListener('click', () => {
    saveSettings({ ...SETTINGS_DEFAULTS });
    applySettingsToAllPanes(SETTINGS_DEFAULTS);
    panel.remove();
  });

  panel.querySelector('#sp-new-window').addEventListener('click', async () => {
    panel.remove();
    try { await invoke('create_app_window'); }
    catch (err) { showError(`Could not open window: ${err}`); }
  });

  panel.querySelector('.settings-close').addEventListener('click', () => panel.remove());

  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') panel.remove(); });

  // Close on outside click
  setTimeout(() => {
    const onOut = (e) => { if (!panel.contains(e.target)) { panel.remove(); document.removeEventListener('click', onOut); } };
    document.addEventListener('click', onOut);
  }, 0);
}

// ── Browser pane (embedded child webview alongside a terminal) ─────────────────

/** Map of browser label -> browser state */
const browserPanes = new Map();

async function createMarkdownLeaf(tabId, mountEl, initialState = {}) {
  const label = `markdown-${crypto.randomUUID().slice(0, 8)}`;
  const markdownEl = document.createElement('div');
  markdownEl.className = 'pane-leaf markdown-pane-leaf';
  markdownEl.style.flex = '1 1 0';
  markdownEl.style.minWidth = '0';
  markdownEl.style.minHeight = '0';
  markdownEl.dataset.markdownLabel = label;
  markdownEl.innerHTML = `
    <div class="markdown-bar">
      <input class="markdown-path" placeholder="Enter a markdown file path..." spellcheck="false" />
      <button class="markdown-btn" data-action="reload" title="Reload markdown">&#x21bb;</button>
      <button class="markdown-btn" data-action="zoom" title="Toggle zoom (Ctrl+Alt+Enter)">&#x2922;</button>
      <button class="markdown-btn pane-tb-close" data-action="close" title="Close markdown">&#x2715;</button>
    </div>
    <div class="markdown-body">
      <div class="markdown-empty">Enter a markdown file path and press Enter.</div>
    </div>
  `;
  mountEl.appendChild(markdownEl);

  const pathInput = markdownEl.querySelector('.markdown-path');
  const bodyEl = markdownEl.querySelector('.markdown-body');
  const state = {
    label,
    tabId,
    markdownEl,
    bodyEl,
    pathInput,
    path: initialState.path ?? '',
    baseDir: dirnameFromPath(initialState.path ?? ''),
    source: initialState.source ?? initialState.content ?? '',
    title: initialState.title ?? '',
  };
  markdownPanes.set(label, state);
  tabs.get(tabId)?.markdownLabels?.add(label);

  const renderSource = (source, title = state.title) => {
    state.source = source ?? '';
    state.title = title || basenameFromPath(state.path) || 'Markdown';
    bodyEl.innerHTML = `<article class="markdown-content">${renderMarkdownHtml(state.source)}</article>`;
    highlightMarkdownCodeBlocks(bodyEl);
  };

  const renderError = (message) => {
    bodyEl.innerHTML = `<div class="markdown-error">${escHtml(message)}</div>`;
  };

  const loadPath = async (requestedPath, options = {}) => {
    const resolved = resolveMarkdownPath(requestedPath, options.baseDir ?? state.baseDir);
    if (!resolved) {
      renderError('Enter a markdown file path to load content.');
      return;
    }

    try {
      const source = await invoke('read_text_file', { path: resolved });
      state.path = resolved;
      state.baseDir = dirnameFromPath(resolved);
      pathInput.value = resolved;
      renderSource(source, basenameFromPath(resolved));
    } catch (err) {
      renderError(String(err));
      showError(`Could not open markdown: ${err}`);
    }
  };

  markdownEl.addEventListener('mousedown', () => activateMarkdown(label));
  pathInput.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    await loadPath(pathInput.value);
  });
  markdownEl.querySelector('[data-action="reload"]').addEventListener('click', async () => {
    if (state.path) await loadPath(state.path, { baseDir: '' });
  });
  markdownEl.querySelector('[data-action="zoom"]').addEventListener('click', () => toggleSurfaceZoom(markdownEl));
  markdownEl.querySelector('[data-action="close"]').addEventListener('click', () => closeMarkdownSurface(label));
  bodyEl.addEventListener('click', async (event) => {
    const link = event.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href')?.trim() ?? '';
    if (!href || href.startsWith('#')) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(href)) {
      await openBrowserSplitForTab(tabId, href);
      return;
    }
    await loadPath(href, { baseDir: state.baseDir });
  });

  if (state.path) {
    await loadPath(state.path, { baseDir: '' });
  } else if (state.source) {
    renderSource(state.source, state.title);
  }

  activateMarkdown(label);
  return label;
}

async function createBrowserLeaf(tabId, mountEl, initialState = {}) {
  const label = `browser-${crypto.randomUUID().slice(0, 8)}`;
  const browserEl = document.createElement('div');
  browserEl.className = 'pane-leaf browser-pane-leaf';
  browserEl.style.flex = '1 1 0';
  browserEl.style.minWidth = '0';
  browserEl.style.minHeight = '0';
  browserEl.dataset.browserLabel = label;
  browserEl.innerHTML = `
    <div class="browser-bar">
      <button class="browser-btn" id="bb-back-${label}" title="Back (Ctrl+[)" disabled>&#x2190;</button>
      <button class="browser-btn" id="bb-fwd-${label}" title="Forward (Ctrl+])" disabled>&#x2192;</button>
      <button class="browser-btn" id="bb-reload-${label}" title="Reload (Ctrl+R)">&#x21bb;</button>
      <button class="browser-btn" id="bb-zoom-${label}" title="Toggle zoom (Ctrl+Alt+Enter)">&#x2922;</button>
      <input class="browser-url" id="bu-${label}" placeholder="Enter URL…" spellcheck="false" />
      <button class="browser-btn browser-go" id="bg-${label}">Go</button>
      <button class="browser-btn pane-tb-close" id="bc-${label}" title="Close browser">&#x2715;</button>
    </div>
    <div class="browser-placeholder">Enter a URL and press Go</div>
  `;
  mountEl.appendChild(browserEl);

  const urlInput = document.getElementById(`bu-${label}`);
  const backBtn = document.getElementById(`bb-back-${label}`);
  const fwdBtn = document.getElementById(`bb-fwd-${label}`);
  const reloadBtn = document.getElementById(`bb-reload-${label}`);
  const zoomBtn = document.getElementById(`bb-zoom-${label}`);
  const placeholderEl = browserEl.querySelector('.browser-placeholder');

  const browserState = {
    label,
    tabId,
    browserEl,
    history: [],
    historyIndex: -1,
    created: false,
    resizeObserver: null,
    currentUrl: '',
  };
  browserPanes.set(label, browserState);
  tabs.get(tabId)?.browserLabels?.add(label);
  updateTabMeta(tabId);

  const updateNavButtons = () => {
    backBtn.disabled = browserState.historyIndex <= 0;
    fwdBtn.disabled = browserState.historyIndex < 0 || browserState.historyIndex >= browserState.history.length - 1;
  };

  const navigateTo = (url, { pushHistory = true } = {}) => {
    let full = url.trim();
    if (!full) return;
    if (!full.startsWith('http://') && !full.startsWith('https://')) full = 'https://' + full;
    urlInput.value = full;

    const run = async () => {
      if (!browserState.created) {
        const rect = browserEl.getBoundingClientRect();
        const barH = 36;
        await invoke('create_browser_window', {
          windowLabel: getCurrentWindow().label,
          label,
          url: full,
          x: Math.round(rect.left),
          y: Math.round(rect.top + barH),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height - barH)),
        });
        browserState.created = true;
        placeholderEl?.remove();
      } else {
        await invoke('navigate_browser', { label, url: full });
      }

      browserState.currentUrl = full;
      if (pushHistory) {
        const nextHistory = browserState.history.slice(0, browserState.historyIndex + 1);
        if (nextHistory[nextHistory.length - 1] !== full) nextHistory.push(full);
        browserState.history = nextHistory;
        browserState.historyIndex = browserState.history.length - 1;
      }
      updateNavButtons();
    };

    run().catch((err) => showError(`Could not open browser: ${err}`));
  };

  document.getElementById(`bg-${label}`).addEventListener('click', () => navigateTo(urlInput.value));
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') navigateTo(e.target.value);
  });
  backBtn.addEventListener('click', () => {
    if (browserState.historyIndex <= 0) return;
    browserState.historyIndex -= 1;
    navigateTo(browserState.history[browserState.historyIndex], { pushHistory: false });
  });
  fwdBtn.addEventListener('click', () => {
    if (browserState.historyIndex >= browserState.history.length - 1) return;
    browserState.historyIndex += 1;
    navigateTo(browserState.history[browserState.historyIndex], { pushHistory: false });
  });
  reloadBtn.addEventListener('click', () => {
    const currentUrl = browserState.history[browserState.historyIndex];
    if (currentUrl) navigateTo(currentUrl, { pushHistory: false });
  });
  zoomBtn.addEventListener('click', () => toggleSurfaceZoom(browserEl));
  document.getElementById(`bc-${label}`).addEventListener('click', async () => closeBrowserSurface(label));

  const browserRO = new ResizeObserver(() => {
    if (!browserState.created) return;
    const r = browserEl.getBoundingClientRect();
    if (r.width < 10 || r.height < 40) return;
    invoke('set_browser_geometry', {
      label,
      x: Math.round(r.left),
      y: Math.round(r.top + 36),
      width: Math.max(1, Math.round(r.width)),
      height: Math.max(1, Math.round(r.height - 36)),
    }).catch(() => {});
  });
  browserState.resizeObserver = browserRO;
  browserRO.observe(browserEl);
  browserEl.addEventListener('mousedown', () => activateBrowser(label));

  if (initialState.url) {
    requestAnimationFrame(() => navigateTo(initialState.url, { pushHistory: true }));
  }

  return browserState;
}

async function splitPaneWithBrowser(paneId, dir, initialState = {}) {
  const pane = panes.get(paneId);
  if (!pane) return;

  const leafEl   = pane.domEl;
  const parentEl = leafEl.parentElement;

  const splitEl = document.createElement('div');
  splitEl.className = `pane-split pane-split-${dir}`;
  leafEl.style.flex = '1 1 0';
  parentEl.replaceChild(splitEl, leafEl);
  splitEl.appendChild(leafEl);

  const dividerEl = document.createElement('div');
  dividerEl.className = `pane-divider pane-divider-${dir}`;
  dividerEl.addEventListener('mousedown', makeDividerDrag(splitEl, dir));
  splitEl.appendChild(dividerEl);

  await createBrowserLeaf(pane.tabId, splitEl, initialState);
  fitAndResizePane(paneId);
}

async function splitPaneWithMarkdown(paneId, dir, initialState = {}) {
  const pane = panes.get(paneId);
  if (!pane) return;

  const leafEl   = pane.domEl;
  const parentEl = leafEl.parentElement;

  const splitEl = document.createElement('div');
  splitEl.className = `pane-split pane-split-${dir}`;
  leafEl.style.flex = '1 1 0';
  parentEl.replaceChild(splitEl, leafEl);
  splitEl.appendChild(leafEl);

  const dividerEl = document.createElement('div');
  dividerEl.className = `pane-divider pane-divider-${dir}`;
  dividerEl.addEventListener('mousedown', makeDividerDrag(splitEl, dir));
  splitEl.appendChild(dividerEl);

  await createMarkdownLeaf(pane.tabId, splitEl, initialState);
  fitAndResizePane(paneId);
}

// New-tab popover

async function showNewTabPopover() {
  document.getElementById('new-tab-popover')?.remove();

  const def = getDefaultTarget();

  const isDefaultTarget = (t) => {
    if (t.type !== def.type) return false;
    if (t.type === 'local') return true;
    if (t.type === 'wsl')   return t.distro === def.distro;
    if (t.type === 'ssh')   return t.host === def.host && t.user === def.user;
    return false;
  };

  const makeStarBtn = (target) => {
    const isDefault = isDefaultTarget(target);
    const btn = document.createElement('button');
    btn.className = 'nt-set-default' + (isDefault ? ' is-default' : '');
    btn.title = isDefault ? 'Current default' : 'Set as default';
    btn.textContent = isDefault ? '★' : '☆';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setDefaultTarget(target);
      closePopover();
    });
    return btn;
  };

  const makeItemRow = (target, itemBtn) => {
    const row = document.createElement('div');
    row.className = 'nt-item-row';
    row.appendChild(itemBtn);
    row.appendChild(makeStarBtn(target));
    return row;
  };

  const popover = document.createElement('div');
  popover.id = 'new-tab-popover';
  popover.className = 'nt-popover';
  popover.innerHTML = `
    <div class="nt-section-label">Shell</div>
    <div id="nt-local-row"></div>

    <div class="nt-section-label">WSL</div>
    <div id="nt-wsl-list" class="nt-wsl-list">
      <span class="nt-loading">Detecting distros...</span>
    </div>

    <div class="nt-section-label">Window</div>
    <div id="nt-window-row"></div>

    <div class="nt-section-label">SSH</div>
    <form id="nt-ssh-form" class="nt-ssh-form" autocomplete="off">
      <div class="nt-ssh-row">
        <input id="nt-ssh-host" type="text" placeholder="user@host or host" spellcheck="false" />
        <input id="nt-ssh-port" type="number" placeholder="Port (22)" min="1" max="65535" />
      </div>
      <input id="nt-ssh-key" type="text" placeholder="SSH key path, e.g. ~/.ssh/id_rsa (optional)" spellcheck="false" />
      <div class="nt-ssh-actions">
        <label class="nt-ssh-default-label">
          <input type="checkbox" id="nt-ssh-set-default"> Set as default
        </label>
        <button type="submit">Connect</button>
      </div>
    </form>
  `;

  document.body.appendChild(popover);

  // Local button
  const localTarget = { type: 'local' };
  const localBtn = document.createElement('button');
  localBtn.className = 'nt-item nt-item-local';
  localBtn.innerHTML = `<span class="nt-icon">+</span> Local (PowerShell / cmd)`;
  localBtn.addEventListener('click', () => { closePopover(); createTab(localTarget); });
  popover.querySelector('#nt-local-row').appendChild(makeItemRow(localTarget, localBtn));

  // New window button
  const newWinBtn = document.createElement('button');
  newWinBtn.className = 'nt-item';
  newWinBtn.innerHTML = `<span class="nt-icon">&#x2750;</span> New window`;
  newWinBtn.addEventListener('click', async () => {
    closePopover();
    try { await invoke('create_app_window'); }
    catch (err) { showError(`Could not open window: ${err}`); }
  });
  popover.querySelector('#nt-window-row')?.appendChild(newWinBtn);

  const anchor = document.getElementById('btn-new-tab-more');
  const rect   = anchor.getBoundingClientRect();
  popover.style.bottom    = `${window.innerHeight - rect.top + 6}px`;
  popover.style.left      = `${rect.left}px`;
  popover.style.maxHeight = `${rect.top - 12}px`;
  popover.style.overflowY = 'auto';

  // WSL list
  const wslList = popover.querySelector('#nt-wsl-list');
  try {
    const distros = await invoke('list_wsl_distros');
    if (distros.length === 0) {
      wslList.innerHTML = '<span class="nt-empty">WSL not installed</span>';
    } else {
      wslList.innerHTML = '';
      for (const d of distros) {
        const target = { type: 'wsl', distro: d.name };
        const btn = document.createElement('button');
        btn.className = 'nt-item';
        btn.innerHTML = `<span class="nt-icon">🐧</span> ${d.name}${d.is_default ? ' <em>(default wsl)</em>' : ''}`;
        btn.addEventListener('click', () => { closePopover(); createTab(target); });
        wslList.appendChild(makeItemRow(target, btn));
      }
    }
  } catch {
    wslList.innerHTML = '<span class="nt-empty">WSL unavailable</span>';
  }

  // Pre-fill SSH fields if SSH is the current default
  if (def.type === 'ssh') {
    popover.querySelector('#nt-ssh-host').value = (def.user ? def.user + '@' : '') + def.host;
    if (def.port) popover.querySelector('#nt-ssh-port').value = def.port;
    if (def.identity_file) popover.querySelector('#nt-ssh-key').value = def.identity_file;
    popover.querySelector('#nt-ssh-set-default').checked = true;
  }

  popover.querySelector('#nt-ssh-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw          = popover.querySelector('#nt-ssh-host').value.trim();
    const port         = parseInt(popover.querySelector('#nt-ssh-port').value, 10) || null;
    const identityFile = popover.querySelector('#nt-ssh-key').value.trim() || null;
    const makeDefault  = popover.querySelector('#nt-ssh-set-default').checked;
    if (!raw) return;

    let user = null;
    let host = raw;
    if (raw.includes('@')) [user, host] = raw.split('@', 2);

    const target = { type: 'ssh', host, user, port, identity_file: identityFile };
    if (makeDefault) setDefaultTarget(target);
    closePopover();
    createTab(target);
  });

  const onOutside = (e) => {
    if (!popover.contains(e.target) && e.target !== btnNewTabMore) closePopover();
  };
  setTimeout(() => document.addEventListener('click', onOutside), 0);

  function closePopover() {
    popover.remove();
    document.removeEventListener('click', onOutside);
  }
}

// Layout persistence

/**
 * Walk the pane DOM tree rooted at `el` and return a serialisable node.
 * Handles the asymmetric structure produced by splitPane:
 *   pane-split children: [childA (leaf/split direct), divider, sideBEl (wrapper)]
 */
function serializePaneTree(el) {
  if (!el) return null;
  if (el.classList.contains('browser-pane-leaf')) {
    const browser = browserPanes.get(el.dataset.browserLabel);
    return browser ? { kind: 'browser', url: browser.currentUrl } : null;
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
    return pane ? { kind: 'terminal', target: pane.target } : null;
  }
  if (el.classList.contains('pane-split')) {
    const dir = el.classList.contains('pane-split-h') ? 'h' : 'v';
    const children = [...el.children].filter(c => !c.classList.contains('pane-divider'));
    const [childA, sideBEl] = children;
    // flex shorthand is e.g. "0.6 1 0"; parseFloat grabs the flex-grow value.
    const flexA = parseFloat(childA.style.flex) || 1;
    const flexB = parseFloat(sideBEl.style.flex) || 1;
    const ratio = flexA / (flexA + flexB);
    return {
      kind: 'split', dir, ratio,
      a: serializePaneTree(childA),
      b: serializePaneTree(sideBEl.firstElementChild),
    };
  }
  // Plain wrapper div (e.g. a sideBEl promoted to root after a close) — look inside.
  return el.firstElementChild ? serializePaneTree(el.firstElementChild) : null;
}

function serializeLayout() {
  const wsEntries = [...workspaces.values()];
  const wsTabMap = {};
  for (const [, tab] of tabs) {
    if (!wsTabMap[tab.workspaceId]) wsTabMap[tab.workspaceId] = [];
    wsTabMap[tab.workspaceId].push({
      title: tab.title,
      userRenamed: tab.userRenamed,
      tree: serializePaneTree(tab.contentEl.firstElementChild) ?? null,
    });
  }
  return {
    version: 2,
    activeWorkspaceIndex: wsEntries.findIndex(ws => ws.id === activeWorkspaceId),
    workspaces: wsEntries.map(ws => ({
      name: ws.name,
      tabs: wsTabMap[ws.id] ?? [],
      activeTabIndex: (() => {
        const wsTabs = [...tabs.values()].filter(t => t.workspaceId === ws.id);
        return Math.max(0, wsTabs.findIndex(t => t.tabId === activeTabId));
      })(),
    })),
  };
}

/**
 * Reconstruct a pane tree from a serialised node, mirroring the exact DOM
 * structure that splitPane produces so that subsequent splits and closes work.
 */
async function restorePaneTree(tabId, node, mountEl) {
  if (!node) return;
  if (node.kind === 'leaf' || node.kind === 'terminal') {
    await createLeafPane(tabId, node.target, mountEl);
    return;
  }
  if (node.kind === 'browser') {
    await createBrowserLeaf(tabId, mountEl, { url: node.url ?? '' });
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
  if (node.kind === 'split') {
    const splitEl = document.createElement('div');
    splitEl.className = `pane-split pane-split-${node.dir}`;
    mountEl.appendChild(splitEl);

    // Child A: the leaf/split sits DIRECTLY in splitEl (no wrapper), matching splitPane.
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

    // Divider
    const dividerEl = document.createElement('div');
    dividerEl.className = `pane-divider pane-divider-${node.dir}`;
    dividerEl.addEventListener('mousedown', makeDividerDrag(splitEl, node.dir));
    splitEl.appendChild(dividerEl);

    // Child B: wrapper div (sideBEl), matching splitPane's sideBEl.
    const sideBEl = document.createElement('div');
    sideBEl.style.flex = `${1 - node.ratio} 1 0`;
    sideBEl.style.minWidth = '0';
    sideBEl.style.minHeight = '0';
    sideBEl.style.display = 'flex';
    splitEl.appendChild(sideBEl);
    await restorePaneTree(tabId, node.b, sideBEl);
  }
}

function focusBrowserUrl() {
  const browser = getActiveBrowserState();
  if (!browser) return false;
  browser.browserEl.querySelector('.browser-url')?.focus();
  return true;
}

function browserNavigateRelative(direction) {
  const browser = getActiveBrowserState();
  if (!browser) return false;
  const delta = direction === 'back' ? -1 : 1;
  const nextIndex = browser.historyIndex + delta;
  if (nextIndex < 0 || nextIndex >= browser.history.length) return true;
  browser.historyIndex = nextIndex;
  const targetUrl = browser.history[nextIndex];
  if (targetUrl) {
    const urlInput = browser.browserEl.querySelector('.browser-url');
    if (urlInput) urlInput.value = targetUrl;
    invoke('navigate_browser', { label: browser.label, url: targetUrl }).catch((err) => showError(`Could not navigate browser: ${err}`));
    browser.currentUrl = targetUrl;
  }
  return true;
}

function reloadActiveBrowser() {
  const browser = getActiveBrowserState();
  if (!browser?.currentUrl) return false;
  invoke('navigate_browser', { label: browser.label, url: browser.currentUrl }).catch((err) => showError(`Could not reload browser: ${err}`));
  return true;
}

function getFocusableSurfaces(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return [];
  return [...tab.contentEl.querySelectorAll('.pane-leaf')]
    .map(el => ({
      el,
      rect: el.getBoundingClientRect(),
      paneId: el.dataset.sessionId || null,
      browserLabel: el.dataset.browserLabel || null,
      markdownLabel: el.dataset.markdownLabel || null,
    }))
    .filter(item => item.rect.width > 0 && item.rect.height > 0);
}

function focusAdjacentSurface(direction) {
  if (!activeTabId) return false;
  const currentEl = getCurrentSurfaceElement();
  if (!currentEl) return false;

  const surfaces = getFocusableSurfaces(activeTabId);
  const current = surfaces.find(item => item.el === currentEl);
  if (!current) return false;

  const currentCx = current.rect.left + current.rect.width / 2;
  const currentCy = current.rect.top + current.rect.height / 2;
  const candidates = surfaces.filter(item => item.el !== currentEl).map(item => {
    const cx = item.rect.left + item.rect.width / 2;
    const cy = item.rect.top + item.rect.height / 2;
    const dx = cx - currentCx;
    const dy = cy - currentCy;
    return { ...item, dx, dy, distance: Math.hypot(dx, dy) };
  }).filter(item => {
    if (direction === 'left') return item.dx < -8;
    if (direction === 'right') return item.dx > 8;
    if (direction === 'up') return item.dy < -8;
    return item.dy > 8;
  }).sort((a, b) => a.distance - b.distance);

  const target = candidates[0];
  if (!target) return false;
  if (target.paneId) activatePane(target.paneId);
  else if (target.browserLabel) activateBrowser(target.browserLabel);
  else if (target.markdownLabel) activateMarkdown(target.markdownLabel);
  return true;
}

function closeCurrentSurface() {
  if (activeMarkdownLabel) {
    closeMarkdownSurface(activeMarkdownLabel);
    return true;
  }
  if (activeBrowserLabel) {
    closeBrowserSurface(activeBrowserLabel);
    return true;
  }
  if (activePaneId) {
    closePane(activePaneId);
    return true;
  }
  return false;
}

// Keyboard shortcuts

document.addEventListener('keydown', (e) => {
  const ctrl  = e.ctrlKey;
  const shift = e.shiftKey;
  const alt   = e.altKey;
  const key   = e.key;

  if (ctrl && shift && key === 'T') { e.preventDefault(); createTab(getDefaultTarget()); return; }
  if (ctrl && shift && key === 'W') { e.preventDefault(); closeCurrentSurface(); return; }

  if (ctrl && shift && (key === '\\' || key === '|')) { e.preventDefault(); if (activePaneId) splitPane(activePaneId, 'h'); return; }
  if (ctrl && shift && (key === '_' || key === '-')) { e.preventDefault(); if (activePaneId) splitPane(activePaneId, 'v'); return; }

  if (ctrl && key === 'Tab') {
    e.preventDefault();
    const wsTabIds = [...tabs.values()]
      .filter(t => t.workspaceId === activeWorkspaceId)
      .map(t => t.tabId);
    if (wsTabIds.length < 2) return;
    const idx  = wsTabIds.indexOf(activeTabId);
    const next = shift
      ? wsTabIds[(idx - 1 + wsTabIds.length) % wsTabIds.length]
      : wsTabIds[(idx + 1) % wsTabIds.length];
    activateTab(next);
    return;
  }

  if (ctrl && !shift && !alt && key === 'i') { e.preventDefault(); toggleNotifPanel(); return; }

  if (ctrl && shift && !alt && key.toUpperCase() === 'O') {
    e.preventDefault();
    previewArtifactFromPane();
    return;
  }

  if (ctrl && shift && key === 'U') {
    e.preventDefault();
    const unread = [...tabs.values()]
      .filter(t => t.workspaceId === activeWorkspaceId && unreadNotificationCount(t.tabId) > 0);
    if (unread.length > 0) activateTab(unread[unread.length - 1].tabId);
    else {
      const allNotif = [...tabs.values()].filter(t => unreadNotificationCount(t.tabId) > 0);
      if (allNotif.length > 0) {
        const t = allNotif[allNotif.length - 1];
        switchWorkspace(t.workspaceId);
        activateTab(t.tabId);
      }
    }
    return;
  }

  if (ctrl && alt && key.toLowerCase() === 'h') { e.preventDefault(); showHistoryPicker(); return; }
  if (ctrl && !shift && !alt && key === 'f') { e.preventDefault(); showFindBar(); return; }

  if (ctrl && shift && !alt && key.toUpperCase() === 'L') {
    e.preventDefault();
    if (activePaneId) splitPaneWithBrowser(activePaneId, 'h');
    else if (activeTabId) openBrowserSplitForTab(activeTabId);
    return;
  }

  if (ctrl && shift && !alt && key.toUpperCase() === 'M') {
    e.preventDefault();
    if (activePaneId) splitPaneWithMarkdown(activePaneId, 'h');
    else if (activeTabId) openMarkdownSplitForTab(activeTabId);
    return;
  }

  if (ctrl && !shift && !alt && key.toLowerCase() === 'l' && focusBrowserUrl()) {
    e.preventDefault();
    return;
  }

  if (ctrl && !shift && !alt && key === '[' && browserNavigateRelative('back')) {
    e.preventDefault();
    return;
  }

  if (ctrl && !shift && !alt && key === ']' && browserNavigateRelative('forward')) {
    e.preventDefault();
    return;
  }

  if (ctrl && !shift && !alt && key.toLowerCase() === 'r' && reloadActiveBrowser()) {
    e.preventDefault();
    return;
  }

  if (ctrl && !shift && !alt && key === 'k') {
    const pane = panes.get(activePaneId);
    if (pane) { e.preventDefault(); pane.terminal.clear(); }
    return;
  }

  if (ctrl && !shift && !alt) {
    const pane = panes.get(activePaneId);
    if (key === ',' && !pane) { e.preventDefault(); showSettingsPanel(); return; }
    if (!pane) return;
    if (key === '=' || key === '+') {
      e.preventDefault();
      const ns = Math.min(32, (pane.terminal.options.fontSize ?? 13) + 1);
      for (const [id, p] of panes) { p.terminal.options.fontSize = ns; fitAndResizePane(id); }
      const sv = loadSettings(); sv.fontSize = ns; saveSettings(sv);
      return;
    }
    if (key === '-' || key === '_') {
      e.preventDefault();
      const ns = Math.max(8, (pane.terminal.options.fontSize ?? 13) - 1);
      for (const [id, p] of panes) { p.terminal.options.fontSize = ns; fitAndResizePane(id); }
      const sv = loadSettings(); sv.fontSize = ns; saveSettings(sv);
      return;
    }
    if (key === '0') {
      e.preventDefault();
      const ns = SETTINGS_DEFAULTS.fontSize;
      for (const [id, p] of panes) { p.terminal.options.fontSize = ns; fitAndResizePane(id); }
      const sv = loadSettings(); sv.fontSize = ns; saveSettings(sv);
      return;
    }
    if (key === ',') { e.preventDefault(); showSettingsPanel(); return; }
  }

  if (ctrl && alt && key.toLowerCase() === 'n') { e.preventDefault(); createWorkspace(); return; }
  if (ctrl && alt && key === 'Enter') { e.preventDefault(); toggleSurfaceZoom(getCurrentSurfaceElement()); return; }
  if (alt && ctrl && key === 'ArrowLeft') { e.preventDefault(); focusAdjacentSurface('left'); return; }
  if (alt && ctrl && key === 'ArrowRight') { e.preventDefault(); focusAdjacentSurface('right'); return; }
  if (alt && ctrl && key === 'ArrowUp') { e.preventDefault(); focusAdjacentSurface('up'); return; }
  if (alt && ctrl && key === 'ArrowDown') { e.preventDefault(); focusAdjacentSurface('down'); return; }
  if (ctrl && alt && (key === '[' || key === '{')) {
    e.preventDefault();
    const ids = orderedWorkspaceIds();
    const i = ids.indexOf(activeWorkspaceId);
    if (i > 0) switchWorkspace(ids[i - 1]);
    return;
  }
  if (ctrl && alt && (key === ']' || key === '}')) {
    e.preventDefault();
    const ids = orderedWorkspaceIds();
    const i = ids.indexOf(activeWorkspaceId);
    if (i < ids.length - 1) switchWorkspace(ids[i + 1]);
    return;
  }
  if (ctrl && alt && /^[1-9]$/.test(key)) {
    e.preventDefault();
    const n = parseInt(key, 10) - 1;
    const ids = orderedWorkspaceIds();
    if (ids[n]) switchWorkspace(ids[n]);
    return;
  }
});

// Boot

btnNewTab.addEventListener('click', () => createTab(getDefaultTarget()));
btnNewTabMore.addEventListener('click', showNewTabPopover);
updateNewTabTooltip();
document.getElementById('btn-settings')?.addEventListener('click', showSettingsPanel);

const wsNameEl = document.getElementById('ws-name-label');
if (wsNameEl) wsNameEl.addEventListener('dblclick', startWorkspaceRename);
document.getElementById('workspace-bar')?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const ws = workspaces.get(activeWorkspaceId);
  if (!ws) return;
  showContextMenu([
    { label: 'Rename workspace', action: () => startWorkspaceRename() },
    { label: ws.pinned ? 'Unpin workspace' : 'Pin workspace', action: () => setWorkspacePinned(ws.id, !ws.pinned) },
    { type: 'separator' },
    { label: 'New workspace', action: () => createWorkspace() },
    { label: 'Close workspace', action: () => closeWorkspace(ws.id), danger: true },
  ], event.clientX, event.clientY);
});
document.getElementById('btn-prev-ws').addEventListener('click', () => {
  const ids = orderedWorkspaceIds();
  const i = ids.indexOf(activeWorkspaceId);
  if (i > 0) switchWorkspace(ids[i - 1]);
});
document.getElementById('btn-next-ws').addEventListener('click', () => {
  const ids = orderedWorkspaceIds();
  const i = ids.indexOf(activeWorkspaceId);
  if (i < ids.length - 1) switchWorkspace(ids[i + 1]);
});
document.getElementById('btn-new-ws').addEventListener('click', () => createWorkspace());
document.getElementById('btn-pin-ws')?.addEventListener('click', () => {
  const ws = workspaces.get(activeWorkspaceId);
  if (ws) setWorkspacePinned(ws.id, !ws.pinned);
});

getCurrentWindow().onCloseRequested(async (event) => {
  event.preventDefault();
  try {
    await invoke('save_layout', { layoutJson: JSON.stringify(serializeLayout()) });
  } catch (err) {
    console.warn('Failed to save layout:', err);
  }
  await getCurrentWindow().destroy();
});

(async () => {
  let restored = false;
  try {
    const raw = await invoke('load_layout');
    if (raw) {
      const layout = JSON.parse(raw);
      if ((layout.version === 3 || layout.version === 2) && Array.isArray(layout.workspaces) && layout.workspaces.length > 0) {
        for (let wi = 0; wi < layout.workspaces.length; wi++) {
          const wsData = layout.workspaces[wi];
          const wsId = _createWorkspaceMeta(wsData.name, !!wsData.pinned);
          if (wi === 0) {
            activeWorkspaceId = wsId;
            renderWorkspaceBar();
          }
          const prevWs = activeWorkspaceId;
          activeWorkspaceId = wsId;
          for (const tabData of (wsData.tabs ?? [])) {
            await createTab({ type: 'local' }, tabData);
          }
          if (wi !== 0) {
            for (const [, t] of tabs) {
              if (t.workspaceId === wsId) t.tabEl.style.display = 'none';
            }
          }
          activeWorkspaceId = prevWs;
        }
        const wsIds = orderedWorkspaceIds();
        const activeWi = Math.min(layout.activeWorkspaceIndex ?? 0, wsIds.length - 1);
        activeWorkspaceId = null;
        switchWorkspace(wsIds[activeWi]);
        restored = true;
      } else if (layout.version === 1 && Array.isArray(layout.tabs) && layout.tabs.length > 0) {
        const wsId = _createWorkspaceMeta('Workspace 1');
        activeWorkspaceId = wsId;
        renderWorkspaceBar();
        for (const tabData of layout.tabs) {
          await createTab({ type: 'local' }, tabData);
        }
        const tabIds = [...tabs.keys()];
        const activeIdx = Math.min(layout.activeTabIndex ?? 0, tabIds.length - 1);
        if (tabIds[activeIdx]) activateTab(tabIds[activeIdx]);
        restored = true;
      }
    }
  } catch (err) {
    console.warn('Could not restore layout:', err);
  }
  if (!restored) {
    const wsId = _createWorkspaceMeta('Workspace 1');
    activeWorkspaceId = wsId;
    renderWorkspaceBar();
    await createTab(getDefaultTarget());
  }
})();

window.wmux = {
  browser: {
    list: () => [...browserPanes.values()].map(browser => ({
      label: browser.label,
      tabId: browser.tabId,
      url: browser.currentUrl,
      history: [...browser.history],
      historyIndex: browser.historyIndex,
    })),
    openSplit: async (url = '') => {
      if (activePaneId) {
        await splitPaneWithBrowser(activePaneId, 'h', { url });
        return;
      }
      if (activeTabId) await openBrowserSplitForTab(activeTabId, url);
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
      };
    },
  },
  workspace: {
    list: () => orderedWorkspaceEntries().map(ws => ({ id: ws.id, name: ws.name, pinned: ws.pinned })),
    switch: (wsId) => switchWorkspace(wsId),
    create: (name) => createWorkspace(name),
    rename: (wsId, name) => {
      const ws = workspaces.get(wsId);
      if (!ws) throw new Error(`Workspace '${wsId}' not found`);
      ws.name = name;
      renderWorkspaceBar();
    },
    pin: (wsId, pinned = true) => setWorkspacePinned(wsId, pinned),
    close: (wsId) => closeWorkspace(wsId),
  },
  notifications: {
    list: (tabId = activeTabId) => [...(notifications.get(tabId) ?? [])],
    markAllRead: (tabId = activeTabId) => markTabNotificationsRead(tabId),
    clear: (tabId = activeTabId) => clearTabNotifications(tabId),
  },
};
