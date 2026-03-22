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
import {
  basenameFromPath,
  dirnameFromPath,
  resolveMarkdownPath,
} from './layout_state.mjs';
import { createLayoutPersistence } from './layout_runtime.mjs';
import { createAutomationBridge } from './automation_bridge.mjs';
import { createPaneAuxRuntime } from './pane_aux_runtime.mjs';
import { createUiPanelsRuntime } from './ui_panels_runtime.mjs';
import { createSurfaceRuntime } from './surfaces_runtime.mjs';
import {
  createWorkspaceManager,
  DEFAULT_WORKSPACE_THEME_ID,
  WORKSPACE_THEMES,
} from './workspace_state.mjs';
import 'highlight.js/styles/github-dark.css';
import '@xterm/xterm/css/xterm.css';

marked.setOptions({ gfm: true, breaks: true });

const tabs = new Map();
const panes = new Map();

let activeTabId = null;
let activePaneId = null;
let activeBrowserLabel = null;
let activeMarkdownLabel = null;
let zoomedSurfaceEl = null;
let contextMenuCleanup = null;

const notifications = new Map();
let notifPanelTabId = null;

const artifacts = [];
let artifactPanelVisible = false;

const markdownPanes = new Map();
let browserPanes = new Map();
let surfaceRuntime = null;
let panelsRuntime = null;
let paneAuxRuntime = null;

const workspaces = new Map();
let activeWorkspaceId = null;

const SETTINGS_DEFAULTS = {
  fontSize: 13,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  lineHeight: 1.2,
  scrollback: 5000,
  cursorStyle: 'bar',
  cursorBlink: true,
};

const SAVED_SSH_TARGETS_KEY = 'wmux-saved-ssh-targets';

function loadSettings() {
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem('wmux-settings') ?? '{}') }; }
  catch { return { ...SETTINGS_DEFAULTS }; }
}

function saveSettings(settings) {
  localStorage.setItem('wmux-settings', JSON.stringify(settings));
}

function applySettingsToAllPanes(settings) {
  for (const [id, pane] of panes) {
    pane.terminal.options.fontSize = settings.fontSize;
    pane.terminal.options.fontFamily = settings.fontFamily;
    pane.terminal.options.lineHeight = settings.lineHeight;
    pane.terminal.options.cursorStyle = settings.cursorStyle;
    pane.terminal.options.cursorBlink = settings.cursorBlink;
    fitAndResizePane(id);
  }
}

const workspaceManager = createWorkspaceManager({
  document,
  workspaces,
  tabs,
  panes,
  getActiveWorkspaceId: () => activeWorkspaceId,
  setActiveWorkspaceId: (wsId) => { activeWorkspaceId = wsId; },
  getActiveTabId: () => activeTabId,
  setActiveTabId: (tabId) => { activeTabId = tabId; },
  setActivePaneId: (paneId) => { activePaneId = paneId; },
  activateTab,
  syncBrowserVisibility,
  getDefaultTarget,
  createTab,
  closeTab,
  onLayoutChanged: () => markLayoutDirty(),
});

const {
  orderedWorkspaceIds,
  orderedWorkspaceEntries,
  getWorkspaceTheme,
  getWorkspaceThemeById,
  applyWorkspaceTheme,
  setWorkspaceTheme,
  cycleWorkspaceTheme,
  createWorkspaceMeta: _createWorkspaceMeta,
  switchWorkspace,
  renderWorkspaceBar,
  setWorkspacePinned,
  startWorkspaceRename,
  createWorkspace,
  closeWorkspace,
  requireWorkspace,
} = workspaceManager;

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

function normalizeSshTarget(target) {
  if (!target || target.type !== 'ssh') return null;
  const host = String(target.host ?? '').trim();
  if (!host) return null;
  const user = String(target.user ?? '').trim() || null;
  const name = String(target.name ?? '').trim() || null;
  const identityFile = String(target.identity_file ?? '').trim() || null;
  const parsedPort = Number(target.port);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : null;
  return {
    type: 'ssh',
    name,
    host,
    user,
    port,
    identity_file: identityFile,
  };
}

function sshTargetsEqual(left, right) {
  const a = normalizeSshTarget(left);
  const b = normalizeSshTarget(right);
  if (!a || !b) return false;
  return a.host === b.host
    && a.user === b.user
    && a.port === b.port
    && a.identity_file === b.identity_file;
}

function sshTargetConnectionLabel(target) {
  const normalized = normalizeSshTarget(target);
  if (!normalized) return 'SSH';
  const hostPart = normalized.user ? `${normalized.user}@${normalized.host}` : normalized.host;
  return normalized.port ? `${hostPart}:${normalized.port}` : hostPart;
}

function sshTargetDisplayName(target) {
  const normalized = normalizeSshTarget(target);
  if (!normalized) return 'SSH';
  return normalized.name ?? sshTargetConnectionLabel(normalized);
}

function loadSavedSshTargets() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_SSH_TARGETS_KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw
      .map((entry) => {
        const normalized = normalizeSshTarget(entry);
        if (!normalized) return null;
        return {
          id: String(entry.id ?? crypto.randomUUID()),
          ...normalized,
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function saveSavedSshTargets(entries) {
  localStorage.setItem(SAVED_SSH_TARGETS_KEY, JSON.stringify(entries));
}

function defaultTargetLabel(target) {
  if (!target || target.type === 'local') return 'Local';
  if (target.type === 'wsl') return target.distro ?? 'WSL';
  if (target.type === 'ssh') return sshTargetDisplayName(target);
  return 'Local';
}

function basenameFromAnyPath(path) {
  return String(path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function relativePathWithin(root, fullPath) {
  const normalizedRoot = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedFull = String(fullPath ?? '').replace(/\\/g, '/');
  if (!normalizedRoot || !normalizedFull.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return '';
  return normalizedFull.slice(normalizedRoot.length).replace(/^\/+/, '');
}

function shortPathLabel(path) {
  const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return '';
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
}

function getPaneAutoLabel(pane) {
  if (!pane) return { primary: 'Terminal', secondary: '' };

  const cwdShort = shortPathLabel(pane.cwd);
  const git = pane.gitContext;
  if (!git?.repo_root) {
    return {
      primary: basenameFromAnyPath(pane.cwd) || defaultTargetLabel(pane.target),
      secondary: cwdShort,
    };
  }

  const repoName = git.repo_name || basenameFromAnyPath(git.repo_root) || 'repo';
  const worktreeName = git.is_worktree ? (git.worktree_name || basenameFromAnyPath(git.repo_root) || repoName) : null;
  const relativePath = relativePathWithin(git.repo_root, pane.cwd);
  const shortRelative = shortPathLabel(relativePath);

  const primary = worktreeName || repoName;
  const secondaryBits = [];
  if (worktreeName && worktreeName !== repoName) secondaryBits.push(repoName);
  if (git.branch) secondaryBits.push(git.branch);
  if (shortRelative) secondaryBits.push(shortRelative);

  return {
    primary,
    secondary: secondaryBits.join(' · '),
  };
}

function renderPaneContextBadge(paneId) {
  const pane = panes.get(paneId);
  const badgeEl = pane?.contextBadgeEl;
  if (!pane || !badgeEl) return;

  const auto = getPaneAutoLabel(pane);
  const primary = pane.labelOverride?.trim() || auto.primary || 'Terminal';
  const secondary = auto.secondary || '';
  badgeEl.classList.toggle('is-override', !!pane.labelOverride?.trim());
  badgeEl.innerHTML = `
    <span class="pane-context-primary">${escHtml(primary)}</span>
    ${secondary ? `<span class="pane-context-secondary">${escHtml(secondary)}</span>` : ''}
  `;
  badgeEl.title = pane.labelOverride?.trim()
    ? `${pane.labelOverride.trim()}${secondary ? `\n${secondary}` : ''}`
    : `${auto.primary}${secondary ? `\n${secondary}` : ''}`;
}

function startPaneContextRename(paneId) {
  const pane = panes.get(paneId);
  if (!pane?.contextBadgeEl || pane.contextBadgeEl.querySelector('input')) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pane-context-input';
  input.value = pane.labelOverride ?? '';
  input.placeholder = getPaneAutoLabel(pane).primary;

  const commit = () => {
    const value = input.value.trim();
    pane.labelOverride = value || null;
    renderPaneContextBadge(paneId);
    markLayoutDirty();
  };

  const cancel = () => {
    renderPaneContextBadge(paneId);
  };

  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('mousedown', (event) => event.stopPropagation());
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      input.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });

  pane.contextBadgeEl.innerHTML = '';
  pane.contextBadgeEl.appendChild(input);
  input.focus();
  input.select();
}

function parsePortFromUrl(url) {
  const match = String(url ?? '').match(/^https?:\/\/[\w.-]+:(\d+)(?:\/|$)/i);
  return match ? Number(match[1]) : null;
}

function unreadNotificationCount(tabId) {
  return panelsRuntime?.unreadNotificationCount(tabId) ?? (notifications.get(tabId) ?? []).filter((n) => !n.read).length;
}

function closeContextMenu() {
  contextMenuCleanup?.();
  contextMenuCleanup = null;
}

function showContextMenu(items, x, y) {
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  for (const item of items) {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = `context-menu-item${item.danger ? ' danger' : ''}`;
    btn.textContent = item.label;
    btn.disabled = !!item.disabled;
    btn.addEventListener('click', () => {
      closeContextMenu();
      item.action?.();
    });
    menu.appendChild(btn);
  }
  document.body.appendChild(menu);
  const onOutside = (event) => {
    if (!menu.contains(event.target)) closeContextMenu();
  };
  const onEscape = (event) => {
    if (event.key === 'Escape') closeContextMenu();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEscape);
  }, 0);
  contextMenuCleanup = () => {
    menu.remove();
    document.removeEventListener('mousedown', onOutside);
    document.removeEventListener('keydown', onEscape);
  };
}

function getCurrentSurfaceElement() {
  if (activePaneId) return panes.get(activePaneId)?.domEl ?? null;
  if (activeBrowserLabel) return browserPanes.get(activeBrowserLabel)?.browserEl ?? null;
  if (activeMarkdownLabel) return markdownPanes.get(activeMarkdownLabel)?.markdownEl ?? null;
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

function childElementIndex(node) {
  if (!node?.parentElement) return -1;
  return [...node.parentElement.children].indexOf(node);
}

function elementPathFromAncestor(ancestor, node) {
  if (!ancestor || !node) return null;
  const path = [];
  let current = node;
  while (current && current !== ancestor) {
    const index = childElementIndex(current);
    if (index < 0) return null;
    path.unshift(index);
    current = current.parentElement;
  }
  return current === ancestor ? path : null;
}

function elementFromPath(ancestor, path) {
  if (!ancestor || !Array.isArray(path)) return null;
  let current = ancestor;
  for (const index of path) {
    if (!current?.children?.[index]) return null;
    current = current.children[index];
  }
  return current;
}

function getTabSurfaceElementByPath(tab, path) {
  if (!tab) return null;
  return elementFromPath(tab.contentEl, path);
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

function syncBrowserVisibility() {
  return surfaceRuntime?.syncBrowserVisibility();
}

function serializeTabState(tab) {
  const currentNotifications = (notifications.get(tab.tabId) ?? []).map((notif) => ({
    title: notif.title,
    body: notif.body,
    time: notif.time,
    read: !!notif.read,
    panePath: notif.paneId ? elementPathFromAncestor(tab.contentEl, panes.get(notif.paneId)?.domEl ?? null) : null,
  }));

  return {
    title: tab.title,
    userRenamed: tab.userRenamed,
    tree: serializePaneTree(tab.contentEl.firstElementChild) ?? null,
    meta: {
      cwd: tab.cwd,
      gitBranch: tab.gitBranch,
      ports: [...tab.ports],
      targetLabel: tab.targetLabel,
    },
    notifications: currentNotifications,
    ui: {
      activeSurfacePath: elementPathFromAncestor(tab.contentEl, tab.lastActiveSurfaceEl),
      zoomedSurfacePath: elementPathFromAncestor(tab.contentEl, tab.zoomedSurfaceEl),
    },
  };
}

function listTabSummaries(workspaceId = null) {
  return [...tabs.values()]
    .filter((tab) => workspaceId === null || tab.workspaceId === workspaceId)
    .map((tab) => ({
      tabId: tab.tabId,
      workspaceId: tab.workspaceId,
      title: tab.title,
      cwd: tab.cwd,
      gitBranch: tab.gitBranch,
      ports: [...tab.ports],
      unreadNotifications: unreadNotificationCount(tab.tabId),
      notificationCount: (notifications.get(tab.tabId) ?? []).length,
      browserCount: tab.browserLabels.size,
      markdownCount: tab.markdownLabels.size,
      active: tab.tabId === activeTabId,
    }));
}

function listPaneSummaries(tabId = null) {
  return [...panes.values()]
    .filter((pane) => tabId === null || pane.tabId === tabId)
    .map((pane) => {
      const tab = tabs.get(pane.tabId);
      const workspace = tab ? workspaces.get(tab.workspaceId) : null;
      const paneLabel = getPaneAutoLabel(pane);
      const git = pane.gitContext ?? null;
      return {
        paneId: pane.sessionId,
        tabId: pane.tabId,
        workspaceId: tab?.workspaceId ?? null,
        workspaceName: workspace?.name ?? '',
        title: tab?.title ?? 'Terminal',
        paneTitle: pane.labelOverride?.trim() || paneLabel.primary,
        paneLabel: pane.labelOverride?.trim() || paneLabel.primary,
        paneDetail: paneLabel.secondary,
        cwd: pane.cwd ?? '',
        repoName: git?.repo_name ?? '',
        worktreeName: git?.worktree_name ?? '',
        gitBranch: git?.branch ?? '',
        isWorktree: !!git?.is_worktree,
        targetLabel: defaultTargetLabel(pane.target),
        active: pane.sessionId === activePaneId,
      };
    });
}

function clearActiveSurface() {
  if (activePaneId) panes.get(activePaneId)?.domEl.classList.remove('active-pane');
  if (activeBrowserLabel) browserPanes.get(activeBrowserLabel)?.browserEl.classList.remove('active-pane');
  if (activeMarkdownLabel) markdownPanes.get(activeMarkdownLabel)?.markdownEl.classList.remove('active-pane');
  activePaneId = null;
  activeBrowserLabel = null;
  activeMarkdownLabel = null;
}

function requirePane(paneId = activePaneId) {
  const pane = panes.get(paneId);
  if (!pane) throw new Error(`Pane '${paneId}' not found`);
  return pane;
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

const tabList = document.getElementById('tab-list');
const terminalContainer = document.getElementById('terminal-container');
const btnNewTab = document.getElementById('btn-new-tab');
const btnNewTabMore = document.getElementById('btn-new-tab-more');

// Create a new tab

async function createTab(target = { type: 'local' }, restoreData = null) {
  const tabId = crypto.randomUUID();
  const wsId  = activeWorkspaceId;
  const workspace = workspaces.get(wsId);

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
    cwd: restoreData?.meta?.cwd ?? '',
    gitBranch: restoreData?.meta?.gitBranch ?? '',
    ports: new Set(restoreData?.meta?.ports ?? []),
    targetLabel: restoreData?.meta?.targetLabel ?? defaultTargetLabel(target),
    browserLabels: new Set(),
    markdownLabels: new Set(),
    lastActiveSurfaceEl: null,
    zoomedSurfaceEl: null,
    pendingRestoreUi: restoreData?.ui ?? null,
  };
  tabs.set(tabId, tabState);
  if (workspace && !workspace.lastActiveTabId) workspace.lastActiveTabId = tabId;

  document.body.classList.add('has-tabs');
  contentEl.classList.add('visible');

  if (restoreData?.tree) {
    await restorePaneTree(tabId, restoreData.tree, contentEl);
  } else {
    await createLeafPane(tabId, target, contentEl);
  }

  if (Array.isArray(restoreData?.notifications)) {
    notifications.set(tabId, restoreData.notifications.map((notif) => ({
      id: crypto.randomUUID(),
      title: notif.title ?? '',
      body: notif.body ?? '',
      time: notif.time ?? Date.now(),
      read: !!notif.read,
      paneId: (() => {
        const paneEl = elementFromPath(contentEl, notif.panePath);
        return paneEl?.dataset?.sessionId ?? null;
      })(),
    })));
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
  markLayoutDirty();
  return tabId;
}

async function moveTabToWorkspace(tabId, wsId) {
  const tab = tabs.get(tabId);
  if (!tab || !workspaces.has(wsId)) return;
  const prevWorkspaceId = tab.workspaceId;
  const prevWorkspace = workspaces.get(prevWorkspaceId);
  const nextWorkspace = workspaces.get(wsId);
  tab.workspaceId = wsId;
  tab.tabEl.style.display = wsId === activeWorkspaceId ? '' : 'none';
  tab.contentEl.classList.toggle('visible', wsId === activeWorkspaceId && activeTabId === tabId);
  if (prevWorkspace?.lastActiveTabId === tabId) {
    const replacement = [...tabs.values()].find(t => t.workspaceId === prevWorkspaceId && t.tabId !== tabId);
    prevWorkspace.lastActiveTabId = replacement?.tabId ?? null;
  }
  if (nextWorkspace) nextWorkspace.lastActiveTabId = tabId;
  if (wsId === activeWorkspaceId || prevWorkspaceId === activeWorkspaceId) {
    applyWorkspaceTheme(activeWorkspaceId);
  }
  if (activeTabId === tabId && wsId !== activeWorkspaceId) {
    const replacement = [...tabs.values()].find(t => t.workspaceId === activeWorkspaceId && t.tabId !== tabId);
    if (replacement) activateTab(replacement.tabId);
    else document.body.classList.remove('has-tabs');
  }
  syncBrowserVisibility();
  markLayoutDirty();
}

async function openBrowserSplitForTab(tabId, url = '') {
  return surfaceRuntime?.openBrowserSplitForTab(tabId, url);
}

// Create a leaf pane (session + xterm)

async function createLeafPane(tabId, target, mountEl, initialState = {}) {
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
    theme: getWorkspaceThemeById(activeWorkspaceId).xterm,
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

  const contextBadgeEl = document.createElement('button');
  contextBadgeEl.type = 'button';
  contextBadgeEl.className = 'pane-context-badge';
  contextBadgeEl.title = 'Double-click to override pane label';
  contextBadgeEl.addEventListener('click', (event) => {
    event.stopPropagation();
    activatePane(sessionId);
  });
  contextBadgeEl.addEventListener('dblclick', (event) => {
    event.stopPropagation();
    startPaneContextRename(sessionId);
  });
  leafEl.appendChild(contextBadgeEl);

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
    const metadata = await updateTabCwd(tabId, cwd);
    if (pane) {
      pane.gitContext = metadata?.gitContext ?? null;
      renderPaneContextBadge(sessionId);
    }
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
    gitContext: null,
    labelOverride: initialState?.labelOverride ?? null,
    contextBadgeEl,
    imageAddon,
  };
  panes.set(sessionId, paneState);
  renderPaneContextBadge(sessionId);

  const tabState = tabs.get(tabId);
  if (tabState) tabState.paneIds.add(sessionId);

  if (tabState && !tabState.userRenamed && tabState.paneIds.size === 1) {
    tabState.title = sessionLabel;
    const el = tabState.tabEl.querySelector('.tab-title');
    if (el) el.textContent = sessionLabel;
  }

  updateTabMeta(tabId);
  markLayoutDirty();

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
  markLayoutDirty();
}

// Divider drag handler

function makeDividerDrag(splitEl, dir) {
  return (e) => {
    e.preventDefault();
    const nonDividers = [...splitEl.children].filter(
      c => !c.classList.contains('pane-divider'),
    );
    const [childA, childB] = nonDividers;
    let ratioChanged = false;

    const onMove = (ev) => {
      const rect = splitEl.getBoundingClientRect();
      let ratio = dir === 'h'
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top)  / rect.height;
      ratio = Math.max(0.15, Math.min(0.85, ratio));
      childA.style.flex = `${ratio} 1 0`;
      childB.style.flex = `${1 - ratio} 1 0`;
      ratioChanged = true;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      splitEl.querySelectorAll('.pane-leaf').forEach(el => {
        const sid = el.dataset.sessionId;
        if (sid) fitAndResizePane(sid);
      });
      if (ratioChanged) markLayoutDirty();
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
  const tab = tabs.get(pane.tabId);
  if (tab) tab.lastActiveSurfaceEl = pane.domEl;
  setPaneRing(paneId, false);
  markPaneNotificationsRead(pane.tabId, paneId);
  markLayoutDirty();

  if (pane.tabId !== activeTabId) {
    activateTab(pane.tabId);
    return;
  }

  requestAnimationFrame(() => {
    fitAndResizePane(paneId);
    pane.terminal.focus();
    if (tab) setTabRing(tab, false);
  });
}

function activateBrowser(label) {
  return surfaceRuntime?.activateBrowser(label);
}

function activateMarkdown(label) {
  return surfaceRuntime?.activateMarkdown(label);
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
    const target = (activePaneId && tab.paneIds.has(activePaneId))
      ? activePaneId
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
        zoomedSurfaceEl = zoomEl;
      }
    }
    syncBrowserVisibility();
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
  markLayoutDirty();
}

// Close an entire tab

async function closeTab(tabId, skipWorkspaceCheck = false) {
  const tab = tabs.get(tabId);
  if (!tab) return;
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
    await _destroyPane(paneId);
  }

  tab.contentEl.remove();
  tab.tabEl.remove();
  tabs.delete(tabId);
  if (notifPanelTabId === tabId) notifPanelTabId = null;
  if (workspace?.lastActiveTabId === tabId) {
    const replacement = [...tabs.values()].find(t => t.workspaceId === tab.workspaceId);
    workspace.lastActiveTabId = replacement?.tabId ?? null;
  }

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
  syncBrowserVisibility();
  markLayoutDirty();
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
  if (zoomedSurfaceEl === pane.domEl) zoomedSurfaceEl = null;
  panes.delete(paneId);
  try { await invoke('close_session', { id: paneId }); } catch { /* already dead */ }
}

async function closeBrowserSurface(label, { collapse = true } = {}) {
  return surfaceRuntime?.closeBrowserSurface(label, { collapse });
}

function closeMarkdownSurface(label, { collapse = true } = {}) {
  return surfaceRuntime?.closeMarkdownSurface(label, { collapse });
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
    markLayoutDirty();
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = tab.title; input.blur(); }
  });
}

// ── Tab metadata (cwd + git branch + notification text) ─────────────────────────

async function updateTabCwd(tabId, cwd) {
  const result = await paneAuxRuntime?.updateTabCwd(tabId, cwd);
  markLayoutDirty();
  return result;
}

async function fitAndResizePane(sessionId) {
  return paneAuxRuntime?.fitAndResizePane(sessionId);
}

function setTabRing(tab, active) {
  return paneAuxRuntime?.setTabRing(tab, active);
}

function toggleSurfaceZoom(surfaceEl) {
  const result = paneAuxRuntime?.toggleSurfaceZoom(surfaceEl);
  if (surfaceEl) markLayoutDirty();
  return result;
}

function updateTabNumbers() {
  return paneAuxRuntime?.updateTabNumbers();
}

function showError(msg) {
  return panelsRuntime?.showError(msg);
}

function showUrlBanner(sessionId, url, isOauth) {
  return panelsRuntime?.showUrlBanner(sessionId, url, isOauth);
}

function base64Decode(b64) {
  return panelsRuntime?.base64Decode(b64);
}

function escHtml(s) {
  return panelsRuntime?.escHtml(s) ?? String(s);
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
  return panelsRuntime?.extractHtmlArtifacts(output) ?? [];
}

async function openArtifactPreview(artifactId) {
  return panelsRuntime?.openArtifactPreview(artifactId);
}

async function openMarkdownSplitForTab(tabId, initialState = {}) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const paneId = [...tab.paneIds][0] ?? null;
  if (paneId) return splitPaneWithMarkdown(paneId, 'h', initialState);
  return createMarkdownLeaf(tabId, tab.contentEl, initialState);
}

function toggleArtifactPanel(force) {
  return panelsRuntime?.toggleArtifactPanel(force);
}

function renderArtifactPanel() {
  return panelsRuntime?.renderArtifactPanel();
}

async function previewArtifactFromPane(paneId = activePaneId) {
  return panelsRuntime?.previewArtifactFromPane(paneId);
}

function markTabNotificationsRead(tabId) {
  const result = panelsRuntime?.markTabNotificationsRead(tabId);
  markLayoutDirty();
  return result;
}

function markPaneNotificationsRead(tabId, paneId) {
  const result = panelsRuntime?.markPaneNotificationsRead(tabId, paneId);
  markLayoutDirty();
  return result;
}

function clearTabNotifications(tabId) {
  const result = panelsRuntime?.clearTabNotifications(tabId);
  markLayoutDirty();
  return result;
}

function getTabPortSummary(tab) {
  return panelsRuntime?.getTabPortSummary(tab) ?? '';
}

function updateTabMeta(tabId) {
  return panelsRuntime?.updateTabMeta(tabId);
}

function registerTabUrl(tabId, url) {
  return panelsRuntime?.registerTabUrl(tabId, url);
}

function setPaneRing(paneId, active) {
  const pane = panes.get(paneId);
  if (!pane) return;
  pane.hasRing = active;
  pane.domEl.classList.toggle('pane-attention', active);
}

// Notification system

function addNotification(tabId, notif) {
  const result = panelsRuntime?.addNotification(tabId, notif);
  markLayoutDirty();
  return result;
}

function toggleNotifPanel() {
  return panelsRuntime?.toggleNotifPanel();
}

function renderNotifPanel(tabId) {
  return panelsRuntime?.renderNotifPanel(tabId);
}

// Command history picker

function showHistoryPicker() {
  return panelsRuntime?.showHistoryPicker();
}

// ── In-pane terminal find ────────────────────────────────────────────────────

function showFindBar() {
  return panelsRuntime?.showFindBar();
}

// ── Settings panel ─────────────────────────────────────────────────────────────

function showSettingsPanel() {
  return panelsRuntime?.showSettingsPanel();
}

// ── Browser pane (embedded child webview alongside a terminal) ─────────────────

async function createMarkdownLeaf(tabId, mountEl, initialState = {}) {
  return surfaceRuntime?.createMarkdownLeaf(tabId, mountEl, initialState);
}

async function createBrowserLeaf(tabId, mountEl, initialState = {}) {
  return surfaceRuntime?.createBrowserLeaf(tabId, mountEl, initialState);
}

async function splitPaneWithBrowser(paneId, dir, initialState = {}) {
  return surfaceRuntime?.splitPaneWithBrowser(paneId, dir, initialState);
}

async function splitPaneWithMarkdown(paneId, dir, initialState = {}) {
  return surfaceRuntime?.splitPaneWithMarkdown(paneId, dir, initialState);
}

// New-tab popover

async function showNewTabPopover() {
  document.getElementById('new-tab-popover')?.remove();

  let defaultTarget = getDefaultTarget();
  let savedSshTargets = loadSavedSshTargets();
  let editingSavedSshId = null;

  const isDefaultTarget = (t) => {
    if (t.type !== defaultTarget.type) return false;
    if (t.type === 'local') return true;
    if (t.type === 'wsl')   return t.distro === defaultTarget.distro;
    if (t.type === 'ssh')   return sshTargetsEqual(t, defaultTarget);
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
      defaultTarget = target;
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

    <div class="nt-section-label">Saved SSH</div>
    <div id="nt-ssh-saved-list" class="nt-ssh-saved-list"></div>

    <div class="nt-section-label">SSH</div>
    <form id="nt-ssh-form" class="nt-ssh-form" autocomplete="off">
      <input id="nt-ssh-name" type="text" placeholder="Connection name (optional)" spellcheck="false" />
      <div class="nt-ssh-row">
        <input id="nt-ssh-host" type="text" placeholder="user@host or host" spellcheck="false" />
        <input id="nt-ssh-port" type="number" placeholder="Port (22)" min="1" max="65535" />
      </div>
      <input id="nt-ssh-key" type="text" placeholder="SSH key path, e.g. ~/.ssh/id_rsa (optional)" spellcheck="false" />
      <div class="nt-ssh-actions">
        <label class="nt-ssh-default-label">
          <input type="checkbox" id="nt-ssh-set-default"> Set as default
        </label>
        <div class="nt-ssh-action-buttons">
          <button type="button" id="nt-ssh-save">Save</button>
          <button type="submit" id="nt-ssh-connect">Connect</button>
        </div>
      </div>
      <div id="nt-ssh-form-state" class="nt-ssh-form-state"></div>
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

  const sshSavedList = popover.querySelector('#nt-ssh-saved-list');
  const sshNameInput = popover.querySelector('#nt-ssh-name');
  const sshHostInput = popover.querySelector('#nt-ssh-host');
  const sshPortInput = popover.querySelector('#nt-ssh-port');
  const sshKeyInput = popover.querySelector('#nt-ssh-key');
  const sshDefaultInput = popover.querySelector('#nt-ssh-set-default');
  const sshSaveBtn = popover.querySelector('#nt-ssh-save');
  const sshConnectBtn = popover.querySelector('#nt-ssh-connect');
  const sshFormState = popover.querySelector('#nt-ssh-form-state');

  const parseSshFormTarget = () => {
    const raw = sshHostInput.value.trim();
    const parsedPort = parseInt(sshPortInput.value, 10);
    const port = Number.isInteger(parsedPort) ? parsedPort : null;
    if (!raw) return null;

    let user = null;
    let host = raw;
    if (raw.includes('@')) [user, host] = raw.split('@', 2);

    return normalizeSshTarget({
      type: 'ssh',
      name: sshNameInput.value.trim() || null,
      host,
      user,
      port,
      identity_file: sshKeyInput.value.trim() || null,
    });
  };

  const updateSshFormState = () => {
    if (editingSavedSshId) {
      const existing = savedSshTargets.find((entry) => entry.id === editingSavedSshId);
      sshFormState.textContent = existing ? `Editing ${sshTargetDisplayName(existing)}` : 'Editing saved SSH connection';
      sshFormState.classList.add('is-editing');
      sshSaveBtn.textContent = 'Update';
      return;
    }
    sshFormState.textContent = 'Save a connection to keep it in the picker.';
    sshFormState.classList.remove('is-editing');
    sshSaveBtn.textContent = 'Save';
  };

  const fillSshForm = (target, { editingId = null, preserveDefault = false } = {}) => {
    const normalized = normalizeSshTarget(target);
    if (!normalized) return;
    editingSavedSshId = editingId;
    sshNameInput.value = normalized.name ?? '';
    sshHostInput.value = normalized.user ? `${normalized.user}@${normalized.host}` : normalized.host;
    sshPortInput.value = normalized.port ?? '';
    sshKeyInput.value = normalized.identity_file ?? '';
    sshDefaultInput.checked = preserveDefault ? sshDefaultInput.checked : isDefaultTarget(normalized);
    updateSshFormState();
  };

  const renderSavedSshTargets = () => {
    sshSavedList.innerHTML = '';
    if (savedSshTargets.length === 0) {
      sshSavedList.innerHTML = '<span class="nt-empty">Saved SSH connections will show up here.</span>';
      updateSshFormState();
      return;
    }

    for (const entry of savedSshTargets) {
      const row = document.createElement('div');
      row.className = 'nt-saved-ssh-row';

      const connectBtn = document.createElement('button');
      connectBtn.className = 'nt-saved-ssh-main';
      connectBtn.innerHTML = `
        <span class="nt-saved-ssh-title">${escHtml(sshTargetDisplayName(entry))}</span>
        <span class="nt-saved-ssh-detail">${escHtml(sshTargetConnectionLabel(entry))}</span>
      `;
      connectBtn.addEventListener('click', () => {
        closePopover();
        createTab(entry);
      });

      const actions = document.createElement('div');
      actions.className = 'nt-saved-ssh-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'nt-saved-ssh-action';
      editBtn.title = 'Edit saved connection';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        fillSshForm(entry, { editingId: entry.id });
        sshHostInput.focus();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'nt-saved-ssh-action danger';
      deleteBtn.title = 'Delete saved connection';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        savedSshTargets = savedSshTargets.filter((candidate) => candidate.id !== entry.id);
        saveSavedSshTargets(savedSshTargets);
        if (editingSavedSshId === entry.id) editingSavedSshId = null;
        renderSavedSshTargets();
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      actions.appendChild(makeStarBtn(entry));
      row.appendChild(connectBtn);
      row.appendChild(actions);
      sshSavedList.appendChild(row);
    }

    updateSshFormState();
  };

  const saveSshProfile = () => {
    const target = parseSshFormTarget();
    if (!target) {
      showError('SSH host is required. Use host or user@host.');
      sshHostInput.focus();
      return null;
    }

    const nextEntry = {
      id: editingSavedSshId ?? crypto.randomUUID(),
      ...target,
    };
    const existingIndex = savedSshTargets.findIndex((entry) => entry.id === nextEntry.id);
    if (existingIndex >= 0) savedSshTargets.splice(existingIndex, 1, nextEntry);
    else savedSshTargets.unshift(nextEntry);
    saveSavedSshTargets(savedSshTargets);
    editingSavedSshId = nextEntry.id;
    if (sshDefaultInput.checked) {
      setDefaultTarget(nextEntry);
      defaultTarget = nextEntry;
    }
    renderSavedSshTargets();
    return nextEntry;
  };

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
  if (defaultTarget.type === 'ssh') {
    fillSshForm(defaultTarget, { preserveDefault: true });
    sshDefaultInput.checked = true;
  }

  renderSavedSshTargets();

  sshSaveBtn.addEventListener('click', () => {
    saveSshProfile();
  });

  popover.querySelector('#nt-ssh-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const target = parseSshFormTarget();
    if (!target) {
      showError('SSH host is required. Use host or user@host.');
      sshHostInput.focus();
      return;
    }
    if (sshDefaultInput.checked) {
      setDefaultTarget(target);
      defaultTarget = target;
    }
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

paneAuxRuntime = createPaneAuxRuntime({
  invoke,
  document,
  tabs,
  panes,
  SETTINGS_DEFAULTS,
  getActiveTabId: () => activeTabId,
  setActiveTabId: (tabId) => { activeTabId = tabId; },
  getActivePaneId: () => activePaneId,
  setActivePaneId: (paneId) => { activePaneId = paneId; },
  getZoomedSurfaceEl: () => zoomedSurfaceEl,
  setZoomedSurfaceEl: (surfaceEl) => { zoomedSurfaceEl = surfaceEl; },
  getActiveWorkspaceId: () => activeWorkspaceId,
  getCurrentSurfaceElement,
  getActiveTabState,
  activatePane,
  activateBrowser: (label) => activateBrowser(label),
  activateMarkdown: (label) => activateMarkdown(label),
  closeMarkdownSurface: (label) => closeMarkdownSurface(label),
  closeBrowserSurface: (label) => closeBrowserSurface(label),
  closePane,
  loadSettings,
  saveSettings,
});

surfaceRuntime = createSurfaceRuntime({
  invoke,
  document,
  getWindowLabel: () => getCurrentWindow().label,
  tabs,
  panes,
  markdownPanes,
  getActiveWorkspaceId: () => activeWorkspaceId,
  getActiveTabId: () => activeTabId,
  getActivePaneId: () => activePaneId,
  getActiveBrowserLabel: () => activeBrowserLabel,
  setActiveBrowserLabel: (label) => { activeBrowserLabel = label; },
  getActiveMarkdownLabel: () => activeMarkdownLabel,
  setActiveMarkdownLabel: (label) => { activeMarkdownLabel = label; },
  getZoomedSurfaceEl: () => zoomedSurfaceEl,
  setZoomedSurfaceEl: (surfaceEl) => { zoomedSurfaceEl = surfaceEl; },
  clearActiveSurface,
  activatePane,
  activateTab,
  toggleSurfaceZoom,
  collapsePaneBranch,
  fitAndResizePane,
  makeDividerDrag,
  basenameFromPath,
  dirnameFromPath,
  resolveMarkdownPath,
  renderMarkdownHtml,
  highlightMarkdownCodeBlocks,
  escHtml,
  showError,
  updateTabMeta,
  onLayoutChanged: () => markLayoutDirty(),
});
browserPanes = surfaceRuntime.browserPanes;

panelsRuntime = createUiPanelsRuntime({
  document,
  invoke,
  notifications,
  tabs,
  panes,
  defaultTargetLabel,
  getDefaultTarget,
  createTab,
  loadSettings,
  saveSettings,
  applySettingsToAllPanes,
  SETTINGS_DEFAULTS,
  getActiveTabId: () => activeTabId,
  getActivePaneId: () => activePaneId,
  getActiveWorkspaceId: () => activeWorkspaceId,
  getNotifPanelTabId: () => notifPanelTabId,
  setNotifPanelTabId: (tabId) => { notifPanelTabId = tabId; },
  switchWorkspace,
  activateTab,
  activatePane,
  setTabRing,
  setPaneRing,
  openBrowserSplitForTab,
  splitPaneWithBrowser,
});

// Layout persistence

const layoutPersistence = createLayoutPersistence({
  browserPanes,
  markdownPanes,
  panes,
  tabs,
  workspaces,
  getActiveWorkspaceId: () => activeWorkspaceId,
  setActiveWorkspaceId: (wsId) => { activeWorkspaceId = wsId; },
  getNotifPanelTabId: () => notifPanelTabId,
  setNotifPanelTabId: (tabId) => { notifPanelTabId = tabId; },
  serializeTabState,
  createLeafPane,
  createBrowserLeaf,
  createMarkdownLeaf,
  makeDividerDrag,
  createWorkspaceMeta: _createWorkspaceMeta,
  renderWorkspaceBar,
  applyWorkspaceTheme,
  createTab,
  activateTab,
  orderedWorkspaceIds,
  switchWorkspace,
  renderNotifPanel,
});

const {
  serializePaneTree,
  serializeLayout,
  restorePaneTree,
  restoreLayout,
} = layoutPersistence;

let layoutSaveTimer = null;
let layoutSaveInFlight = Promise.resolve(false);
let lastSavedLayoutJson = null;
let windowCloseInProgress = false;

async function closeBrowserSurfacesForShutdown() {
  const browserLabels = [...browserPanes.keys()];
  if (browserLabels.length === 0) return;

  await Promise.allSettled(
    browserLabels.map((label) => closeBrowserSurface(label, { collapse: false })),
  );
}

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

function focusBrowserUrl() {
  return surfaceRuntime?.focusBrowserUrl() ?? false;
}

function browserNavigateRelative(direction) {
  return surfaceRuntime?.browserNavigateRelative(direction) ?? false;
}

function reloadActiveBrowser() {
  return surfaceRuntime?.reloadActiveBrowser() ?? false;
}

function getFocusableSurfaces(tabId) {
  return paneAuxRuntime?.getFocusableSurfaces(tabId) ?? [];
}

function focusAdjacentSurface(direction) {
  return paneAuxRuntime?.focusAdjacentSurface(direction) ?? false;
}

function closeCurrentSurface() {
  return paneAuxRuntime?.closeCurrentSurface() ?? false;
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
  const themeItems = WORKSPACE_THEMES.map((theme) => ({
    label: `${ws.themeId === theme.id ? '●' : '○'} Theme: ${theme.label}`,
    action: () => setWorkspaceTheme(ws.id, theme.id),
  }));
  showContextMenu([
    { label: 'Rename workspace', action: () => startWorkspaceRename() },
    { label: ws.pinned ? 'Unpin workspace' : 'Pin workspace', action: () => setWorkspacePinned(ws.id, !ws.pinned) },
    { type: 'separator' },
    ...themeItems,
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
document.getElementById('btn-theme-ws')?.addEventListener('click', () => cycleWorkspaceTheme());
document.getElementById('btn-pin-ws')?.addEventListener('click', () => {
  const ws = workspaces.get(activeWorkspaceId);
  if (ws) setWorkspacePinned(ws.id, !ws.pinned);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void persistLayoutNow({ force: true, reason: 'visibilitychange' });
});
window.addEventListener('pagehide', () => {
  void persistLayoutNow({ force: true, reason: 'pagehide' });
});

getCurrentWindow().onCloseRequested(async (event) => {
  if (windowCloseInProgress) {
    return;
  }

  windowCloseInProgress = true;
  event.preventDefault();
  const currentWindow = getCurrentWindow();
  try {
    if (layoutSaveTimer) {
      clearTimeout(layoutSaveTimer);
      layoutSaveTimer = null;
    }
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
});

(async () => {
  let restored = false;
  try {
    const raw = await invoke('load_layout');
    if (raw) restored = await restoreLayout(JSON.parse(raw));
  } catch (err) {
    console.warn('Could not restore layout:', err);
  }
  if (!restored) {
    const wsId = _createWorkspaceMeta('Workspace 1');
    activeWorkspaceId = wsId;
    applyWorkspaceTheme(wsId);
    renderWorkspaceBar();
    await createTab(getDefaultTarget());
  }
  try {
    lastSavedLayoutJson = buildLayoutSnapshot();
  } catch (err) {
    console.warn('Could not snapshot initial layout:', err);
  }
})();

function requireTab(tabId = activeTabId) {
  const tab = tabs.get(tabId);
  if (!tab) throw new Error(`Tab '${tabId}' not found`);
  return tab;
}

async function focusTabById(tabId) {
  const tab = requireTab(tabId);
  if (tab.workspaceId !== activeWorkspaceId) switchWorkspace(tab.workspaceId);
  activateTab(tabId);
  return tab;
}

const automationBridge = createAutomationBridge({
  invoke,
  windowObject: window,
  orderedWorkspaceEntries,
  getWorkspaceTheme,
  getActiveWorkspaceId: () => activeWorkspaceId,
  getActiveTabId: () => activeTabId,
  getActivePaneId: () => activePaneId,
  getActiveBrowserLabel: () => activeBrowserLabel,
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
});

window.wmux = automationBridge.api;
listen('wmux-control-request', automationBridge.handleControlRequest);
