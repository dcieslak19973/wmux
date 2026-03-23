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
import { SerializeAddon } from '@xterm/addon-serialize';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { marked } from 'marked';
import {
  basenameFromPath,
  dirnameFromPath,
  resolveMarkdownPath,
} from './layout_state.mjs';
import {
  createLayoutLifecycleRuntime,
  createLayoutPersistence,
  sanitizeFallbackOutputSnapshot,
  writeTerminalSnapshot,
} from './layout_runtime.mjs';
import { createAutomationBridge } from './automation_bridge.mjs';
import { createBrowserPaneRuntime } from './browser_pane_runtime.mjs';
import { createKeyboardRuntime } from './keyboard_runtime.mjs';
import { createNewTabPopoverRuntime } from './new_tab_popover_runtime.mjs';
import { createPaneAuxRuntime } from './pane_aux_runtime.mjs';
import { createPaneContextRuntime } from './pane_context_runtime.mjs';
import { createRemoteTmuxInspectorRuntime } from './remote_tmux_inspector_runtime.mjs';
import { createRemoteTmuxRuntime } from './remote_tmux_runtime.mjs';
import { createRemoteTmuxUiRuntime } from './remote_tmux_ui_runtime.mjs';
import { createSessionVaultRuntime } from './session_vault_runtime.mjs';
import { createTabSurfaceRuntime } from './tab_surface_runtime.mjs';
import { createUiPanelsRuntime } from './ui_panels_runtime.mjs';
import {
  createWorkspaceManager,
  WORKSPACE_THEMES,
} from './workspace_state.mjs';
import {
  buildConnectionTargetFromFields,
  defaultTargetLabel,
  getTargetKind,
  normalizeSshTarget,
  REMOTE_TMUX_SESSION_MODES,
  sshTargetDetailLabel,
  sshTargetDisplayName,
  sshTargetsEqual,
} from './connection_targets.mjs';
import {
  inferCwdFromTerminalTranscript,
  inferRecentCwdsFromTerminalTranscript,
  normalizeHistoryEntry,
  normalizeTerminalTranscript,
  sanitizeCwdForTarget,
  stripTerminalStartupResetSequences,
} from './terminal_restore.mjs';
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
let remoteTmuxRuntime = null;
let remoteTmuxInspectorRuntime = null;
let remoteTmuxUiRuntime = null;

const notifications = new Map();
let notifPanelTabId = null;

const markdownPanes = new Map();
let browserPanes;
let browserPaneRuntime = null;
let surfaceRuntime = null;
let panelsRuntime = null;
let paneAuxRuntime = null;
let sessionVaultRuntime = null;
let layoutLifecycle = null;
let tabSurfaceRuntime = null;

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

const paneContextRuntime = createPaneContextRuntime({
  document,
  tabs,
  panes,
  defaultTargetLabel,
  inferCwdFromTerminalTranscript,
  inferRecentCwdsFromTerminalTranscript,
  sanitizeCwdForTarget,
  getActivePaneId: () => activePaneId,
  escHtml: (value) => escHtml(value),
  markLayoutDirty: () => markLayoutDirty(),
});

remoteTmuxRuntime = createRemoteTmuxRuntime({
  tabs,
  panes,
  invoke,
  normalizeSshTarget,
  sshTargetsEqual,
  REMOTE_TMUX_SESSION_MODES,
  defaultTargetLabel,
  updateTabMeta,
  markLayoutDirty: () => markLayoutDirty(),
  updateTabCwd,
  renderPaneContextBadge,
  createWorkspaceMeta: (...args) => _createWorkspaceMeta(...args),
  renderWorkspaceBar: (...args) => renderWorkspaceBar(...args),
  switchWorkspace: (...args) => switchWorkspace(...args),
  getActiveWorkspaceId: () => activeWorkspaceId,
  serializeTabState,
  closeTab,
  createTab,
  getNotifPanelTabId: () => notifPanelTabId,
  setNotifPanelTabId: (tabId) => { notifPanelTabId = tabId; },
  renderNotifPanel,
  isInspectorOpen: (tabId) => remoteTmuxInspectorRuntime?.isOpenForTab(tabId) ?? false,
  renderInspector: () => remoteTmuxInspectorRuntime?.renderInspector(),
});

remoteTmuxInspectorRuntime = createRemoteTmuxInspectorRuntime({
  document,
  windowObject: window,
  invoke,
  tabs,
  panes,
  defaultTargetLabel,
  normalizeSshTarget,
  REMOTE_TMUX_SESSION_MODES,
  hasRemoteTmuxTab: tabHasRemoteTmux,
  isRemoteTmuxTarget,
  escHtml: (value) => escHtml(value),
  updateTabMeta,
  probeRemoteTmuxMetadata,
  refreshRemoteTmuxTabHealth,
});

remoteTmuxUiRuntime = createRemoteTmuxUiRuntime({
  hasRemoteTmuxTab: tabHasRemoteTmux,
  activateTab,
  openRemoteTmuxInspector,
  reconnectRemoteTmuxTab,
  workspaceRemoteTmuxTabIds,
  reconnectRemoteTmuxWorkspace,
  openRemoteTmuxWorkspaceFromProfile: (target) => remoteTmuxRuntime?.openRemoteTmuxWorkspaceFromProfile(target) ?? null,
});

function loadSettings() {
  try { return { ...SETTINGS_DEFAULTS, ...JSON.parse(localStorage.getItem('wmux-settings') ?? '{}') }; }
  catch { return { ...SETTINGS_DEFAULTS }; }
}

function saveSettings(settings) {
  localStorage.setItem('wmux-settings', JSON.stringify(settings));
}

function markLayoutDirty({ immediate = false } = {}) {
  return layoutLifecycle?.markLayoutDirty({ immediate }) ?? Promise.resolve(false);
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
    if (raw) return normalizeLaunchTarget(JSON.parse(raw));
  } catch {}
  return { type: 'local' };
}

function setDefaultTarget(target) {
  localStorage.setItem('wmux-default-target', JSON.stringify(normalizeLaunchTarget(target)));
  updateNewTabTooltip();
}

function normalizeLaunchTarget(target) {
  if (!target || target.type === 'local') return { type: 'local' };
  if (target.type === 'wsl') {
    const distro = String(target.distro ?? '').trim();
    return distro ? { type: 'wsl', distro } : { type: 'local' };
  }
  return normalizeSshTarget(target) ?? { type: 'local' };
}

function isRemoteTmuxTarget(target) {
  return remoteTmuxRuntime?.isRemoteTmuxTarget(target) ?? false;
}

function tabHasRemoteTmux(tabId) {
  return remoteTmuxRuntime?.tabHasRemoteTmux(tabId) ?? false;
}

function workspaceRemoteTmuxTabIds(workspaceId = activeWorkspaceId) {
  return remoteTmuxRuntime?.workspaceRemoteTmuxTabIds(workspaceId) ?? [];
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

function backfillPaneCwdFromTranscript(pane) {
  return paneContextRuntime.backfillPaneCwdFromTranscript(pane);
}

function getPaneAutoLabel(pane) {
  return paneContextRuntime.getPaneAutoLabel(pane);
}

function renderPaneContextBadge(paneId) {
  return paneContextRuntime.renderPaneContextBadge(paneId);
}

function startPaneContextRename(paneId) {
  return paneContextRuntime.startPaneContextRename(paneId);
}

function unreadNotificationCount(tabId) {
  return panelsRuntime?.unreadNotificationCount(tabId) ?? (notifications.get(tabId) ?? []).filter((n) => !n.read).length;
}

function closeContextMenu() {
  contextMenuCleanup?.();
  contextMenuCleanup = null;
}

function closeRemoteTmuxInspector() {
  remoteTmuxInspectorRuntime?.closeInspector();
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
  return tabSurfaceRuntime?.getCurrentSurfaceElement() ?? null;
}

function getActiveTabState() {
  return tabSurfaceRuntime?.getActiveTabState() ?? null;
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

function syncBrowserVisibility() {
  return browserPaneRuntime?.syncBrowserVisibility();
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
      targetKind: tab.targetKind,
      remoteTmuxSessionName: tab.remoteTmuxSessionName,
      remoteTmuxWindowName: tab.remoteTmuxWindowName,
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
  return tabSurfaceRuntime?.clearActiveSurface();
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

const newTabPopoverRuntime = createNewTabPopoverRuntime({
  document,
  invoke,
  createTab: (target) => createTab(target),
  getDefaultTarget,
  setDefaultTarget,
  loadSavedSshTargets,
  saveSavedSshTargets,
  buildConnectionTargetFromFields,
  normalizeSshTarget,
  REMOTE_TMUX_SESSION_MODES,
  sshTargetDisplayName,
  sshTargetDetailLabel,
  sshTargetsEqual,
  escHtml: (value) => escHtml(value),
  showError,
  openRemoteTmuxWorkspaceFromProfile: (target) => remoteTmuxUiRuntime?.openWorkspaceFromProfile(target) ?? null,
  getAnchorElement: () => btnNewTabMore,
});

// Create a new tab

async function createTab(target = { type: 'local' }, restoreData = null) {
  const normalizedTarget = normalizeLaunchTarget(target);
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
    const reconnectItems = remoteTmuxUiRuntime?.buildTabContextMenuItems(tabId) ?? [];
    const workspaceActions = orderedWorkspaceEntries()
      .filter(ws => ws.id !== wsId)
      .map(ws => ({
        label: `Move to ${ws.name}`,
        action: () => moveTabToWorkspace(tabId, ws.id),
      }));
    showContextMenu([
      { label: 'Rename tab', action: () => startTabRename(tabId, tabEl.querySelector('.tab-title')) },
      ...reconnectItems,
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
  tabEl.querySelector('.tab-target').addEventListener('click', (event) => {
    remoteTmuxUiRuntime?.handleTabTargetClick(tabId, event);
  });

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
    targetLabel: restoreData?.meta?.targetLabel ?? defaultTargetLabel(normalizedTarget),
    targetKind: restoreData?.meta?.targetKind ?? getTargetKind(normalizedTarget),
    remoteTmuxSessionName: restoreData?.meta?.remoteTmuxSessionName ?? (normalizedTarget?.type === 'remote_tmux' ? normalizedTarget.session_name : ''),
    remoteTmuxWindowName: restoreData?.meta?.remoteTmuxWindowName ?? '',
    connectionStatus: restoreData?.meta?.targetKind === 'remote_tmux' || normalizedTarget?.type === 'remote_tmux' ? 'connecting' : 'connected',
    remoteProbeError: '',
    lastRemoteProbeAt: 0,
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
    await createLeafPane(tabId, normalizedTarget, contentEl);
  }

  if (tabState.paneIds.size === 0 && tabState.browserLabels.size === 0 && tabState.markdownLabels.size === 0) {
    tabs.delete(tabId);
    contentEl.remove();
    tabEl.remove();
    if (workspace?.lastActiveTabId === tabId) workspace.lastActiveTabId = null;
    if (tabs.size === 0) document.body.classList.remove('has-tabs');
    return null;
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
  return browserPaneRuntime?.openBrowserSplitForTab(tabId, url);
}

// Create a leaf pane (session + xterm)

async function createLeafPane(tabId, target, mountEl, initialState = {}) {
  const DEFAULT_COLS = 120;
  const DEFAULT_ROWS = 30;
  const MAX_TRANSCRIPT_CHARS = 100_000;
  const restoredCwd = sanitizeCwdForTarget(target, initialState?.cwd);
  const restoredPreviousCwd = sanitizeCwdForTarget(target, initialState?.previousCwd);
  const history = Array.isArray(initialState?.history)
    ? initialState.history.map((entry) => normalizeHistoryEntry(entry)).filter(Boolean).slice(-500)
    : [];
  const screenSnapshot = typeof initialState?.screenSnapshot === 'string'
    ? String(initialState.screenSnapshot)
    : '';
  let outputSnapshot = typeof initialState?.outputSnapshot === 'string'
    ? sanitizeFallbackOutputSnapshot(initialState.outputSnapshot)
    : '';

  const trimTranscript = (value) => value.length > MAX_TRANSCRIPT_CHARS
    ? value.slice(value.length - MAX_TRANSCRIPT_CHARS)
    : value;
  outputSnapshot = trimTranscript(outputSnapshot);

  let result;
  try {
    result = await invoke('create_session', {
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      target,
      cwd: restoredCwd || null,
      previousCwd: restoredPreviousCwd || null,
    });
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
    fontWeight: '400',
    fontWeightBold: '500',
    cursorBlink: _s.cursorBlink,
    cursorStyle: _s.cursorStyle,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
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
  const serializeAddon = new SerializeAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(imageAddon);
  term.loadAddon(searchAddon);
  term.loadAddon(serializeAddon);
  term.loadAddon(new WebLinksAddon());

  const leafEl = document.createElement('div');
  leafEl.className = 'pane-leaf';
  leafEl.dataset.sessionId = sessionId;
  mountEl.appendChild(leafEl);

  const terminalHostEl = document.createElement('div');
  terminalHostEl.className = 'pane-terminal-host';
  leafEl.appendChild(terminalHostEl);

  const footerEl = document.createElement('div');
  footerEl.className = 'pane-footer';
  leafEl.appendChild(footerEl);

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
  footerEl.appendChild(contextBadgeEl);

  // Per-pane command input buffer and history for Ctrl+Alt+H picker.
  let cmdLineBuf = '';
  let escapeSequenceState = 0;

  term.open(terminalHostEl);

  const pendingRestoreSnapshot = screenSnapshot || outputSnapshot;
  const restoreSnapshotIsSerialized = !!screenSnapshot;
  const restoreReplaySanitizeUntil = pendingRestoreSnapshot ? Date.now() + 2200 : 0;
  let restoreReplayFrame = null;
  let restoreReplayConfirmFrame = null;
  let restoreReplayApplied = false;

  const flushRestoreReplay = () => {
    if (!pendingRestoreSnapshot || restoreReplayApplied || !panes.has(sessionId)) return;
    if (restoreReplayFrame) {
      cancelAnimationFrame(restoreReplayFrame);
      restoreReplayFrame = null;
    }
    if (restoreReplayConfirmFrame) {
      cancelAnimationFrame(restoreReplayConfirmFrame);
      restoreReplayConfirmFrame = null;
    }
    restoreReplayApplied = true;
    term.reset();
    writeTerminalSnapshot(term, pendingRestoreSnapshot, { serialized: restoreSnapshotIsSerialized });
    if (restoreSnapshotIsSerialized && typeof term.scrollToTop === 'function') {
      term.scrollToTop();
    }
  };

  const scheduleRestoreReplay = () => {
    if (!pendingRestoreSnapshot || restoreReplayApplied) return;
    if (restoreReplayFrame || restoreReplayConfirmFrame) return;
    restoreReplayFrame = requestAnimationFrame(() => {
      restoreReplayFrame = null;
      restoreReplayConfirmFrame = requestAnimationFrame(() => {
        restoreReplayConfirmFrame = null;
        flushRestoreReplay();
      });
    });
  };

  const transcriptDecoder = new TextDecoder();
  const appendTranscriptChunk = (chunk) => {
    if (!chunk) return;
    outputSnapshot = trimTranscript(outputSnapshot + normalizeTerminalTranscript(chunk));
    const pane = panes.get(sessionId);
    if (pane) pane.outputSnapshot = outputSnapshot;
  };

  term.onData(async (data) => {
    flushRestoreReplay();
    try { await invoke('write_to_session', { id: sessionId, data }); }
    catch (err) { console.warn('write_to_session error:', err); }
    // Track commands typed for history picker.
    for (const ch of data) {
      if (escapeSequenceState === 1) {
        if (ch === '[' || ch === 'O' || ch === ']') {
          escapeSequenceState = 2;
        } else {
          escapeSequenceState = 0;
        }
        continue;
      }
      if (escapeSequenceState === 2) {
        if ((ch >= '@' && ch <= '~') || ch === '\x07') escapeSequenceState = 0;
        continue;
      }
      if (ch === '\x1b') {
        escapeSequenceState = 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        const cmd = normalizeHistoryEntry(cmdLineBuf);
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
    flushRestoreReplay();
    const bytes = base64Decode(event.payload);
    const decoded = transcriptDecoder.decode(bytes, { stream: true });
    if (restoreReplaySanitizeUntil > Date.now()) {
      term.write(stripTerminalStartupResetSequences(decoded));
    } else {
      term.write(bytes);
    }
    appendTranscriptChunk(decoded);
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

  const unlistenExit = await listen(`terminal-exit-${sessionId}`, () => {
    remoteTmuxRuntime?.handleRemoteTmuxSessionExit(tabId, sessionId);
  });

  const unlistenAll = () => {
    if (restoreReplayFrame) {
      cancelAnimationFrame(restoreReplayFrame);
      restoreReplayFrame = null;
    }
    if (restoreReplayConfirmFrame) {
      cancelAnimationFrame(restoreReplayConfirmFrame);
      restoreReplayConfirmFrame = null;
    }
    appendTranscriptChunk(transcriptDecoder.decode());
    unlisten();
    unlistenUrl();
    unlistenNotify();
    unlistenCwd();
    unlistenExit();
  };

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

  if (isRemoteTmuxTarget(target)) {
    leafEl.classList.add('pane-remote-tmux');
    remoteTmuxRuntime?.applyRemoteTmuxPanePolicy(target, toolbarEl);
  }

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
    cwd: restoredCwd,
    previousCwd: restoredPreviousCwd,
    screenSnapshot,
    outputSnapshot,
    gitContext: null,
    labelOverride: initialState?.labelOverride ?? null,
    lastSessionVaultEntryId: typeof initialState?.vaultEntryId === 'string' ? initialState.vaultEntryId : null,
    lastSessionVaultSignature: null,
    contextBadgeEl,
    imageAddon,
    serializeAddon,
  };
  panes.set(sessionId, paneState);
  renderPaneContextBadge(sessionId);
  if (pendingRestoreSnapshot) scheduleRestoreReplay();

  const tabState = tabs.get(tabId);
  if (tabState) tabState.paneIds.add(sessionId);

  if (tabState && !tabState.userRenamed && tabState.paneIds.size === 1) {
    tabState.title = sessionLabel;
    const el = tabState.tabEl.querySelector('.tab-title');
    if (el) el.textContent = sessionLabel;
  }

  updateTabMeta(tabId);
  markLayoutDirty();

  if (isRemoteTmuxTarget(target)) {
    void probeRemoteTmuxMetadata(tabId, sessionId, target);
  }

  return sessionId;
}

// Split the active pane

async function splitPane(paneId, dir) {
  const pane = panes.get(paneId);
  if (!pane) return;
  if (isRemoteTmuxTarget(pane.target)) {
    showError(remoteTmuxRuntime?.getRemoteTmuxSplitBlockedMessage() ?? 'Remote tmux tabs keep one terminal session per tab.');
    return;
  }
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
  return tabSurfaceRuntime?.activatePane(paneId);
}

function activateBrowser(label) {
  return browserPaneRuntime?.activateBrowser(label);
}

function activateMarkdown(label) {
  return surfaceRuntime?.activateMarkdown(label);
}

// Activate a tab

function activateTab(tabId) {
  return tabSurfaceRuntime?.activateTab(tabId);
}

// Close a pane

function collapsePaneBranch(leafEl) {
  return tabSurfaceRuntime?.collapsePaneBranch(leafEl);
}

async function closePane(paneId) {
  return tabSurfaceRuntime?.closePane(paneId);
}

async function closeTab(tabId, _skipWorkspaceCheck = false) {
  return tabSurfaceRuntime?.closeTab(tabId, _skipWorkspaceCheck);
}

async function probeRemoteTmuxMetadata(tabId, sessionId, target) {
  return remoteTmuxRuntime?.probeRemoteTmuxMetadata(tabId, sessionId, target);
}

async function openRemoteTmuxInspector(tabId, options = {}) {
  return remoteTmuxInspectorRuntime?.openInspector(tabId, options);
}

async function refreshRemoteTmuxTabHealth(tabId, { force = false } = {}) {
  return remoteTmuxRuntime?.refreshRemoteTmuxTabHealth(tabId, { force });
}

async function reconnectRemoteTmuxTab(tabId) {
  return remoteTmuxRuntime?.reconnectRemoteTmuxTab(tabId) ?? false;
}

async function reconnectRemoteTmuxWorkspace(workspaceId = activeWorkspaceId) {
  return remoteTmuxRuntime?.reconnectRemoteTmuxWorkspace(workspaceId);
}

async function _destroyPane(paneId) {
  return tabSurfaceRuntime?.destroyPaneSession(paneId);
}

async function closeBrowserSurface(label, { collapse = true } = {}) {
  return browserPaneRuntime?.closeBrowserSurface(label, { collapse });
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

async function openMarkdownSplitForTab(tabId, initialState = {}) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  const paneId = [...tab.paneIds][0] ?? null;
  if (paneId) return splitPaneWithMarkdown(paneId, 'h', initialState);
  return createMarkdownLeaf(tabId, tab.contentEl, initialState);
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

function toggleSessionVaultPanel(force) {
  return panelsRuntime?.toggleSessionVaultPanel(force);
}

async function openSessionVaultEntryInBrowser(entryId) {
  return sessionVaultRuntime.openSessionVaultEntryInBrowser(entryId);
}

async function saveSessionVaultEntryForPane(paneId = activePaneId, { force = false, reason = 'manual' } = {}) {
  return sessionVaultRuntime.saveSessionVaultEntryForPane(paneId, { force, reason });
}

async function flushSessionVaultEntries({ force = false, reason = 'shutdown', paneIds = null } = {}) {
  return sessionVaultRuntime.flushSessionVaultEntries({ force, reason, paneIds });
}

// ── Browser pane (embedded child webview alongside a terminal) ─────────────────

async function createMarkdownLeaf(tabId, mountEl, initialState = {}) {
  return surfaceRuntime?.createMarkdownLeaf(tabId, mountEl, initialState);
}

async function createBrowserLeaf(tabId, mountEl, initialState = {}) {
  return browserPaneRuntime?.createBrowserLeaf(tabId, mountEl, initialState);
}

async function splitPaneWithBrowser(paneId, dir, initialState = {}) {
  return browserPaneRuntime?.splitPaneWithBrowser(paneId, dir, initialState);
}

async function splitPaneWithMarkdown(paneId, dir, initialState = {}) {
  return surfaceRuntime?.splitPaneWithMarkdown(paneId, dir, initialState);
}

// New-tab popover

async function showNewTabPopover() {
  return newTabPopoverRuntime.showNewTabPopover();
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

browserPaneRuntime = createBrowserPaneRuntime({
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
surfaceRuntime = browserPaneRuntime.surfaceRuntime;
browserPanes = browserPaneRuntime.browserPanes;

tabSurfaceRuntime = createTabSurfaceRuntime({
  document,
  tabs,
  panes,
  browserPanes,
  markdownPanes,
  workspaces,
  getActiveTabId: () => activeTabId,
  setActiveTabId: (tabId) => { activeTabId = tabId; },
  getActivePaneId: () => activePaneId,
  setActivePaneId: (paneId) => { activePaneId = paneId; },
  getActiveBrowserLabel: () => activeBrowserLabel,
  setActiveBrowserLabel: (label) => { activeBrowserLabel = label; },
  getActiveMarkdownLabel: () => activeMarkdownLabel,
  setActiveMarkdownLabel: (label) => { activeMarkdownLabel = label; },
  getZoomedSurfaceEl: () => zoomedSurfaceEl,
  setZoomedSurfaceEl: (surfaceEl) => { zoomedSurfaceEl = surfaceEl; },
  getNotifPanelTabId: () => notifPanelTabId,
  setNotifPanelTabId: (tabId) => { notifPanelTabId = tabId; },
  syncBrowserVisibility,
  fitAndResizePane,
  setPaneRing,
  markPaneNotificationsRead,
  markTabNotificationsRead,
  updateTabMeta,
  setTabRing,
  markLayoutDirty,
  activateBrowser,
  activateMarkdown,
  closeBrowserSurface,
  closeMarkdownSurface,
  saveSessionVaultEntryForPane,
  destroyPane: async (paneId) => {
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
  },
  updateTabNumbers,
  closeRemoteTmuxInspector,
  isRemoteTmuxInspectorOpen: (tabId) => remoteTmuxInspectorRuntime?.isOpenForTab(tabId) ?? false,
  refreshRemoteTmuxTabHealth,
});

sessionVaultRuntime = createSessionVaultRuntime({
  invoke,
  panes,
  tabs,
  workspaces,
  getActivePaneId: () => activePaneId,
  getActiveTabId: () => activeTabId,
  getDefaultTarget,
  createTab,
  openBrowserSplitForTab,
  backfillPaneCwdFromTranscript,
  getPaneAutoLabel,
  getTargetKind,
  defaultTargetLabel,
  escHtml: (value) => escHtml(value),
});

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
  listSessionVaultEntries: () => invoke('list_session_vault_entries'),
  readSessionVaultEntry: (id) => invoke('read_session_vault_entry', { id }),
  captureSessionVaultEntry: (paneId, options) => saveSessionVaultEntryForPane(paneId, options),
  openSessionVaultEntry: (entryId) => openSessionVaultEntryInBrowser(entryId),
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

layoutLifecycle = createLayoutLifecycleRuntime({
  document,
  windowObject: window,
  currentWindow: getCurrentWindow(),
  invoke,
  panes,
  serializeLayout,
  restoreLayout,
  backfillPaneCwdFromTranscript,
  closeBrowserSurfacesForShutdown: () => browserPaneRuntime?.closeBrowserSurfacesForShutdown(),
  flushSessionVaultEntries: (options) => flushSessionVaultEntries(options),
  createDefaultLayout: async () => {
    const wsId = _createWorkspaceMeta('Workspace 1');
    activeWorkspaceId = wsId;
    applyWorkspaceTheme(wsId);
    renderWorkspaceBar();
    await createTab(getDefaultTarget());
  },
});

function focusBrowserUrl() {
  return browserPaneRuntime?.focusBrowserUrl() ?? false;
}

function browserNavigateRelative(direction) {
  return browserPaneRuntime?.browserNavigateRelative(direction) ?? false;
}

function reloadActiveBrowser() {
  return browserPaneRuntime?.reloadActiveBrowser() ?? false;
}

function focusAdjacentSurface(direction) {
  return paneAuxRuntime?.focusAdjacentSurface(direction) ?? false;
}

function closeCurrentSurface() {
  return paneAuxRuntime?.closeCurrentSurface() ?? false;
}

function handlePaneFontShortcut(key) {
  return paneAuxRuntime?.handlePaneFontShortcut(key) ?? false;
}

createKeyboardRuntime({
  document,
  tabs,
  panes,
  getActiveWorkspaceId: () => activeWorkspaceId,
  getActiveTabId: () => activeTabId,
  getActivePaneId: () => activePaneId,
  createTab,
  getDefaultTarget,
  closeCurrentSurface,
  splitPane,
  activateTab,
  toggleNotifPanel,
  previewArtifactFromPane,
  toggleSessionVaultPanel,
  unreadNotificationCount,
  switchWorkspace,
  showHistoryPicker,
  showFindBar,
  splitPaneWithBrowser,
  openBrowserSplitForTab,
  splitPaneWithMarkdown,
  openMarkdownSplitForTab,
  focusBrowserUrl,
  browserNavigateRelative,
  reloadActiveBrowser,
  showSettingsPanel,
  handlePaneFontShortcut,
  createWorkspace,
  toggleSurfaceZoom,
  getCurrentSurfaceElement,
  focusAdjacentSurface,
  orderedWorkspaceIds,
}).bindKeyboardShortcuts();

// Boot

btnNewTab.addEventListener('click', () => createTab(getDefaultTarget()));
btnNewTabMore.addEventListener('click', showNewTabPopover);
updateNewTabTooltip();
document.getElementById('btn-session-vault')?.addEventListener('click', () => { void toggleSessionVaultPanel(); });
document.getElementById('btn-settings')?.addEventListener('click', showSettingsPanel);

const wsNameEl = document.getElementById('ws-name-label');
if (wsNameEl) wsNameEl.addEventListener('dblclick', startWorkspaceRename);
document.getElementById('workspace-bar')?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const ws = workspaces.get(activeWorkspaceId);
  if (!ws) return;
  const remoteTmuxItems = remoteTmuxUiRuntime?.buildWorkspaceContextMenuItems(ws.id) ?? [];
  const themeItems = WORKSPACE_THEMES.map((theme) => ({
    label: `${ws.themeId === theme.id ? '●' : '○'} Theme: ${theme.label}`,
    action: () => setWorkspaceTheme(ws.id, theme.id),
  }));
  showContextMenu([
    { label: 'Rename workspace', action: () => startWorkspaceRename() },
    { label: ws.pinned ? 'Unpin workspace' : 'Pin workspace', action: () => setWorkspacePinned(ws.id, !ws.pinned) },
    ...remoteTmuxItems,
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

void layoutLifecycle.initializeLifecycle();

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

window.wmux = {
  ...automationBridge.api,
};
listen('wmux-control-request', automationBridge.handleControlRequest);
