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
import { createLayoutPersistence } from './layout_runtime.mjs';
import { createAutomationBridge } from './automation_bridge.mjs';
import { createNewTabPopoverRuntime } from './new_tab_popover_runtime.mjs';
import { createPaneAuxRuntime } from './pane_aux_runtime.mjs';
import { createPaneContextRuntime } from './pane_context_runtime.mjs';
import { createSessionVaultRuntime } from './session_vault_runtime.mjs';
import { createUiPanelsRuntime } from './ui_panels_runtime.mjs';
import { createSurfaceRuntime } from './surfaces_runtime.mjs';
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
let remoteTmuxInspectorCleanup = null;
let remoteTmuxInspectorState = null;

const notifications = new Map();
let notifPanelTabId = null;

const markdownPanes = new Map();
let browserPanes = new Map();
let surfaceRuntime = null;
let panelsRuntime = null;
let paneAuxRuntime = null;
let sessionVaultRuntime = null;

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

function isRemoteTmuxTarget(target) {
  return normalizeSshTarget(target)?.type === 'remote_tmux';
}

function tabHasRemoteTmux(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return false;
  return [...tab.paneIds].some((paneId) => isRemoteTmuxTarget(panes.get(paneId)?.target));
}

function workspaceRemoteTmuxTabIds(workspaceId = activeWorkspaceId) {
  return [...tabs.values()]
    .filter((tab) => tab.workspaceId === workspaceId && tabHasRemoteTmux(tab.tabId))
    .map((tab) => tab.tabId);
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

function trimTrailingPromptFromSerializedSnapshot(snapshot) {
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

function captureVisibleTerminalScreen(terminal, serializeAddon) {
  const buffer = terminal?.buffer?.active;
  const rows = Number(terminal?.rows) || 0;
  if (!buffer || rows <= 0 || !serializeAddon?.serialize) return '';

  const viewportStart = Number.isInteger(buffer.viewportY) ? buffer.viewportY : Math.max(0, buffer.baseY);
  const viewportEnd = Math.min(buffer.length - 1, viewportStart + rows - 1);
  if (viewportEnd < viewportStart) return '';

  const serialized = serializeAddon.serialize({
    range: { start: viewportStart, end: viewportEnd },
    excludeAltBuffer: true,
    excludeModes: true,
  });
  return trimTrailingPromptFromSerializedSnapshot(serialized);
}

function writeTerminalSnapshot(term, snapshot, { serialized = false } = {}) {
  if (serialized) {
    if (snapshot) term.write(String(snapshot));
    return;
  }
  const normalized = normalizeTerminalTranscript(snapshot);
  if (!normalized) return;
  term.write(normalized.replace(/\n/g, '\r\n'));
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
  remoteTmuxInspectorCleanup?.();
  remoteTmuxInspectorCleanup = null;
  remoteTmuxInspectorState = null;
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
  openRemoteTmuxWorkspaceFromProfile,
  getAnchorElement: () => btnNewTabMore,
});

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
    const reconnectItems = tabHasRemoteTmux(tabId)
      ? [
          { label: 'Browse remote tmux', action: () => openRemoteTmuxInspector(tabId) },
          { label: 'Refresh remote tmux state', action: () => openRemoteTmuxInspector(tabId, { forceRefresh: true }) },
          { type: 'separator' },
          { label: 'Reconnect remote tmux tab', action: () => reconnectRemoteTmuxTab(tabId) },
          { type: 'separator' },
        ]
      : [];
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
    if (!tabHasRemoteTmux(tabId)) return;
    event.stopPropagation();
    activateTab(tabId);
    void openRemoteTmuxInspector(tabId);
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
    targetLabel: restoreData?.meta?.targetLabel ?? defaultTargetLabel(target),
    targetKind: restoreData?.meta?.targetKind ?? getTargetKind(target),
    remoteTmuxSessionName: restoreData?.meta?.remoteTmuxSessionName ?? (target?.type === 'remote_tmux' ? target.session_name : ''),
    remoteTmuxWindowName: restoreData?.meta?.remoteTmuxWindowName ?? '',
    connectionStatus: restoreData?.meta?.targetKind === 'remote_tmux' || target?.type === 'remote_tmux' ? 'connecting' : 'connected',
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
    ? normalizeTerminalTranscript(initialState.outputSnapshot)
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
  const restoreReplayDeadline = pendingRestoreSnapshot ? Date.now() + 3200 : 0;
  let restoreReplayTimer = null;
  let restoreReplayApplied = false;

  const scheduleRestoreReplay = (delay = 180) => {
    if (!pendingRestoreSnapshot || restoreReplayApplied) return;
    if (restoreReplayTimer) clearTimeout(restoreReplayTimer);
    restoreReplayTimer = setTimeout(() => {
      restoreReplayTimer = null;
      if (restoreReplayApplied || !panes.has(sessionId)) return;
      restoreReplayApplied = true;
      term.reset();
      writeTerminalSnapshot(term, pendingRestoreSnapshot, { serialized: restoreSnapshotIsSerialized });
    }, delay);
  };

  const transcriptDecoder = new TextDecoder();
  const appendTranscriptChunk = (chunk) => {
    if (!chunk) return;
    outputSnapshot = trimTranscript(outputSnapshot + normalizeTerminalTranscript(chunk));
    const pane = panes.get(sessionId);
    if (pane) pane.outputSnapshot = outputSnapshot;
  };

  term.onData(async (data) => {
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
    const bytes = base64Decode(event.payload);
    const decoded = transcriptDecoder.decode(bytes, { stream: true });
    if (restoreReplaySanitizeUntil > Date.now()) {
      term.write(stripTerminalStartupResetSequences(decoded));
    } else {
      term.write(bytes);
    }
    appendTranscriptChunk(decoded);
    if (!restoreReplayApplied && pendingRestoreSnapshot && Date.now() <= restoreReplayDeadline) {
      scheduleRestoreReplay(260);
    }
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
    const pane = panes.get(sessionId);
    const tab = tabs.get(tabId);
    if (!pane || !tab || !isRemoteTmuxTarget(pane.target)) return;
    tab.connectionStatus = 'disconnected';
    tab.remoteProbeError = 'Remote tmux session disconnected.';
    tab.lastRemoteProbeAt = Date.now();
    updateTabMeta(tabId);
  });

  const unlistenAll = () => {
    if (restoreReplayTimer) {
      clearTimeout(restoreReplayTimer);
      restoreReplayTimer = null;
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
  if (pendingRestoreSnapshot) scheduleRestoreReplay(520);

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
    for (const selector of ['[data-action="split-h"]', '[data-action="split-v"]']) {
      const btn = toolbarEl.querySelector(selector);
      if (btn) {
        btn.disabled = true;
        btn.title = 'Remote tmux tabs keep one terminal session per tab. Use tmux splits inside the remote session.';
      }
    }
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
    showError('Remote tmux tabs keep one terminal session per tab. Use tmux splits inside the remote session; wmux browser and markdown splits still work here.');
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
    void refreshRemoteTmuxTabHealth(tabId);
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

  await saveSessionVaultEntryForPane(paneId, { reason: 'pane-close' });
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

async function closeTab(tabId, _skipWorkspaceCheck = false) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (remoteTmuxInspectorState?.tabId === tabId) closeRemoteTmuxInspector();
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
    await saveSessionVaultEntryForPane(paneId, { reason: 'tab-close' });
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
    const tab = tabs.get(tabId);
    if (!pane || !tab || !isRemoteTmuxTarget(pane.target) || !sshTargetsEqual(pane.target, normalized)) {
      return;
    }

    if (pane.target.session_mode === REMOTE_TMUX_SESSION_MODES.CREATE) {
      pane.target = {
        ...pane.target,
        session_mode: REMOTE_TMUX_SESSION_MODES.ATTACH,
      };
      tab.targetLabel = defaultTargetLabel(pane.target);
    }

    tab.remoteTmuxSessionName = metadata.session_name ?? normalized.session_name;
    tab.remoteTmuxWindowName = metadata.window_name ?? '';
    tab.connectionStatus = 'connected';
    tab.remoteProbeError = '';
    tab.lastRemoteProbeAt = Date.now();

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

    if (!tab.userRenamed && metadata.window_name) {
      tab.title = `${tab.remoteTmuxSessionName}:${metadata.window_name}`;
      const titleEl = tab.tabEl.querySelector('.tab-title');
      if (titleEl) titleEl.textContent = tab.title;
    }

    updateTabMeta(tabId);
    markLayoutDirty();
    if (remoteTmuxInspectorState?.tabId === tabId) renderRemoteTmuxInspector();
  } catch (err) {
    const tab = tabs.get(tabId);
    if (tab) {
      tab.connectionStatus = 'disconnected';
      tab.remoteProbeError = String(err);
      tab.lastRemoteProbeAt = Date.now();
      updateTabMeta(tabId);
    }
    if (remoteTmuxInspectorState?.tabId === tabId) renderRemoteTmuxInspector();
    console.warn('probe_remote_tmux_metadata error:', err);
  }
}

function getRemoteTmuxPaneForTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return null;
  return [...tab.paneIds]
    .map((paneId) => panes.get(paneId))
    .find((pane) => isRemoteTmuxTarget(pane?.target)) ?? null;
}

function quotePosixShellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function remoteTmuxEndpointLabel(target) {
  const normalized = normalizeSshTarget(target);
  if (!normalized) return 'remote tmux';
  const host = normalized.user ? `${normalized.user}@${normalized.host}` : normalized.host;
  return normalized.port ? `${host}:${normalized.port}` : host;
}

async function sendRemoteTmuxCommand(tabId, command, { nextSessionName = null } = {}) {
  const pane = getRemoteTmuxPaneForTab(tabId);
  const tab = tabs.get(tabId);
  if (!pane || !tab) return false;

  await invoke('write_to_session', { id: pane.sessionId, data: `${command}\r` });

  if (nextSessionName && isRemoteTmuxTarget(pane.target)) {
    pane.target = {
      ...pane.target,
      session_name: nextSessionName,
      session_mode: REMOTE_TMUX_SESSION_MODES.ATTACH,
    };
    tab.remoteTmuxSessionName = nextSessionName;
    tab.targetLabel = defaultTargetLabel(pane.target);
    tab.connectionStatus = 'connecting';
    updateTabMeta(tabId);
  }

  await new Promise((resolve) => window.setTimeout(resolve, 180));
  await probeRemoteTmuxMetadata(tabId, pane.sessionId, pane.target);
  if (remoteTmuxInspectorState?.tabId === tabId) {
    await refreshRemoteTmuxInspector({ force: true, preserveSelection: true });
  }
  return true;
}

async function manageRemoteTmux(tabId, scope, action, { tmuxTarget = null, name = null } = {}) {
  const pane = getRemoteTmuxPaneForTab(tabId);
  const target = normalizeSshTarget(pane?.target);
  if (!pane || !target || target.type !== 'remote_tmux') return null;

  const result = await invoke('manage_remote_tmux', {
    target,
    scope,
    action,
    tmuxTarget,
    name,
  });

  if (remoteTmuxInspectorState?.tabId === tabId) {
    await refreshRemoteTmuxInspector({ force: true, preserveSelection: true });
  }
  return result;
}

function promptRemoteTmuxName(message, defaultValue = '') {
  const value = window.prompt(message, defaultValue);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function createRemoteTmuxSession(tabId) {
  const state = remoteTmuxInspectorState;
  const sessionName = promptRemoteTmuxName('New remote tmux session name', state?.selectedSessionName ? `${state.selectedSessionName}-2` : 'team-shell');
  if (!sessionName) return false;
  await manageRemoteTmux(tabId, 'session', 'create', { name: sessionName });
  await switchRemoteTmuxSession(tabId, sessionName);
  return true;
}

async function renameRemoteTmuxSession(tabId, sessionName) {
  const nextName = promptRemoteTmuxName(`Rename remote tmux session ${sessionName}`, sessionName);
  if (!nextName || nextName === sessionName) return false;
  await manageRemoteTmux(tabId, 'session', 'rename', { tmuxTarget: sessionName, name: nextName });
  const pane = getRemoteTmuxPaneForTab(tabId);
  const tab = tabs.get(tabId);
  if (pane && tab && isRemoteTmuxTarget(pane.target) && tab.remoteTmuxSessionName === sessionName) {
    pane.target = { ...pane.target, session_name: nextName };
    tab.remoteTmuxSessionName = nextName;
    tab.targetLabel = defaultTargetLabel(pane.target);
  }
  await refreshRemoteTmuxTabHealth(tabId, { force: true });
  await refreshRemoteTmuxInspector({ force: true, preserveSelection: false });
  return true;
}

async function killRemoteTmuxSession(tabId, sessionName, isCurrent) {
  const confirmed = window.confirm(`Kill remote tmux session ${sessionName}?${isCurrent ? ' This is the current session for this wmux tab.' : ''}`);
  if (!confirmed) return false;
  await manageRemoteTmux(tabId, 'session', 'kill', { tmuxTarget: sessionName });
  if (isCurrent) {
    await refreshRemoteTmuxTabHealth(tabId, { force: true });
  }
  await refreshRemoteTmuxInspector({ force: true, preserveSelection: false });
  return true;
}

async function createRemoteTmuxWindow(tabId, sessionName) {
  const windowName = promptRemoteTmuxName(`New window name for session ${sessionName}`, 'editor');
  if (!windowName) return false;
  const result = await manageRemoteTmux(tabId, 'window', 'create', { tmuxTarget: sessionName, name: windowName });
  if (result?.resolved_target) {
    await switchRemoteTmuxWindow(tabId, result.resolved_target);
  }
  return true;
}

async function renameRemoteTmuxWindow(tabId, windowId, windowName) {
  const nextName = promptRemoteTmuxName(`Rename remote tmux window ${windowName || windowId}`, windowName || 'window');
  if (!nextName || nextName === windowName) return false;
  await manageRemoteTmux(tabId, 'window', 'rename', { tmuxTarget: windowId, name: nextName });
  await refreshRemoteTmuxTabHealth(tabId, { force: true });
  await refreshRemoteTmuxInspector({ force: true, preserveSelection: true });
  return true;
}

async function killRemoteTmuxWindow(tabId, windowId, windowName, isCurrent) {
  const confirmed = window.confirm(`Kill remote tmux window ${windowName || windowId}?${isCurrent ? ' This is the current window for this wmux tab.' : ''}`);
  if (!confirmed) return false;
  await manageRemoteTmux(tabId, 'window', 'kill', { tmuxTarget: windowId });
  await refreshRemoteTmuxTabHealth(tabId, { force: true });
  await refreshRemoteTmuxInspector({ force: true, preserveSelection: false });
  return true;
}

async function switchRemoteTmuxSession(tabId, sessionName) {
  return sendRemoteTmuxCommand(
    tabId,
    `tmux switch-client -t ${quotePosixShellArg(sessionName)}`,
    { nextSessionName: sessionName },
  );
}

async function switchRemoteTmuxWindow(tabId, windowId) {
  return sendRemoteTmuxCommand(tabId, `tmux select-window -t ${quotePosixShellArg(windowId)}`);
}

async function switchRemoteTmuxPane(tabId, paneId) {
  return sendRemoteTmuxCommand(tabId, `tmux select-pane -t ${quotePosixShellArg(paneId)}`);
}

function renderRemoteTmuxInspector() {
  const panel = document.getElementById('remote-tmux-inspector');
  const state = remoteTmuxInspectorState;
  if (!panel || !state) return;

  const body = panel.querySelector('.rti-body');
  const titleEl = panel.querySelector('.rti-title');
  const subtitleEl = panel.querySelector('.rti-subtitle');
  const refreshBtn = panel.querySelector('[data-action="refresh"]');
  const closeBtn = panel.querySelector('[data-action="close"]');

  const tab = tabs.get(state.tabId);
  const remotePane = getRemoteTmuxPaneForTab(state.tabId);
  titleEl.textContent = tab ? `Remote tmux - ${tab.title}` : 'Remote tmux';
  subtitleEl.textContent = remotePane ? remoteTmuxEndpointLabel(remotePane.target) : 'Remote tmux tab not available';

  refreshBtn.onclick = () => { void refreshRemoteTmuxInspector({ force: true, preserveSelection: true }); };
  closeBtn.onclick = () => closeRemoteTmuxInspector();

  if (!tab || !remotePane) {
    body.innerHTML = '<div class="rti-empty">This remote tmux tab is no longer available.</div>';
    return;
  }

  if (state.loading) {
    body.innerHTML = '<div class="rti-loading">Loading remote tmux sessions, windows, and panes...</div>';
    return;
  }

  if (state.error) {
    body.innerHTML = `
      <div class="rti-error">${escHtml(state.error)}</div>
      <button class="rti-inline-action" data-action="retry">Retry</button>
    `;
    body.querySelector('[data-action="retry"]')?.addEventListener('click', () => {
      void refreshRemoteTmuxInspector({ force: true, preserveSelection: true });
    });
    return;
  }

  const data = state.data;
  if (!data?.sessions?.length) {
    body.innerHTML = '<div class="rti-empty">No remote tmux sessions were found.</div>';
    return;
  }

  const selectedSession = data.sessions.find((session) => session.session_name === state.selectedSessionName)
    ?? data.sessions.find((session) => session.session_name === data.current_session_name)
    ?? data.sessions[0];
  state.selectedSessionName = selectedSession?.session_name ?? '';

  const selectedWindow = selectedSession?.windows.find((windowState) => windowState.window_id === state.selectedWindowId)
    ?? selectedSession?.windows.find((windowState) => windowState.window_id === data.current_window_id)
    ?? selectedSession?.windows[0]
    ?? null;
  state.selectedWindowId = selectedWindow?.window_id ?? '';

  body.innerHTML = `
    <div class="rti-grid">
      <section class="rti-column">
        <div class="rti-column-head">
          <div class="rti-column-title">Sessions</div>
          <button class="rti-mini-action" data-action="new-session">New</button>
        </div>
        <div class="rti-list rti-sessions"></div>
      </section>
      <section class="rti-column">
        <div class="rti-column-head">
          <div class="rti-column-title">Windows</div>
          <button class="rti-mini-action" data-action="new-window" ${selectedSession ? '' : 'disabled'}>New</button>
        </div>
        <div class="rti-list rti-windows"></div>
      </section>
      <section class="rti-column">
        <div class="rti-column-title">Panes</div>
        <div class="rti-list rti-panes"></div>
      </section>
    </div>
  `;

  const sessionsEl = body.querySelector('.rti-sessions');
  const windowsEl = body.querySelector('.rti-windows');
  const panesEl = body.querySelector('.rti-panes');

  for (const session of data.sessions) {
    const row = document.createElement('div');
    row.className = `rti-row${session.session_name === state.selectedSessionName ? ' is-selected' : ''}${session.is_current ? ' is-current' : ''}`;
    row.innerHTML = `
      <button class="rti-main" data-session-name="${escHtml(session.session_name)}">
        <span class="rti-primary">${escHtml(session.session_name)}</span>
        <span class="rti-secondary">${session.window_count} windows · ${session.attached_clients} clients</span>
      </button>
      <button class="rti-action" data-switch-session="${escHtml(session.session_name)}" ${session.is_current ? 'disabled' : ''}>Switch</button>
      <button class="rti-action" data-rename-session="${escHtml(session.session_name)}">Rename</button>
      <button class="rti-action danger" data-kill-session="${escHtml(session.session_name)}">Kill</button>
    `;
    sessionsEl.appendChild(row);
  }

  if (!selectedSession?.windows?.length) {
    windowsEl.innerHTML = '<div class="rti-empty">No windows in this session.</div>';
  } else {
    for (const windowState of selectedSession.windows) {
      const row = document.createElement('div');
      row.className = `rti-row${windowState.window_id === state.selectedWindowId ? ' is-selected' : ''}${windowState.window_id === data.current_window_id ? ' is-current' : ''}`;
      row.innerHTML = `
        <button class="rti-main" data-window-id="${escHtml(windowState.window_id)}">
          <span class="rti-primary">${escHtml(`${windowState.window_index}: ${windowState.window_name || 'window'}`)}</span>
          <span class="rti-secondary">${windowState.panes.length} panes · ${escHtml(windowState.window_id)}</span>
        </button>
        <button class="rti-action" data-switch-window="${escHtml(windowState.window_id)}" ${windowState.window_id === data.current_window_id ? 'disabled' : ''}>Switch</button>
        <button class="rti-action" data-rename-window="${escHtml(windowState.window_id)}">Rename</button>
        <button class="rti-action danger" data-kill-window="${escHtml(windowState.window_id)}">Kill</button>
      `;
      windowsEl.appendChild(row);
    }
  }

  if (!selectedWindow?.panes?.length) {
    panesEl.innerHTML = '<div class="rti-empty">No panes in this window.</div>';
  } else {
    for (const paneState of selectedWindow.panes) {
      const row = document.createElement('div');
      row.className = `rti-row${paneState.pane_id === data.current_pane_id ? ' is-current' : ''}`;
      row.innerHTML = `
        <div class="rti-main rti-pane-main">
          <span class="rti-primary">${escHtml(`${paneState.pane_index}: ${paneState.current_command || paneState.title || paneState.pane_id}`)}</span>
          <span class="rti-secondary">${escHtml([
            paneState.cwd || paneState.title || paneState.pane_id,
            paneState.command_age ? `age ${paneState.command_age}` : '',
            paneState.was_last_active ? 'last-active' : '',
          ].filter(Boolean).join(' · '))}</span>
        </div>
        <button class="rti-action" data-switch-pane="${escHtml(paneState.pane_id)}" ${paneState.pane_id === data.current_pane_id ? 'disabled' : ''}>Select</button>
      `;
      panesEl.appendChild(row);
    }
  }

  sessionsEl.querySelectorAll('[data-session-name]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedSessionName = btn.dataset.sessionName ?? '';
      state.selectedWindowId = '';
      renderRemoteTmuxInspector();
    });
  });
  sessionsEl.querySelectorAll('[data-switch-session]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void switchRemoteTmuxSession(state.tabId, btn.dataset.switchSession ?? '');
    });
  });
  sessionsEl.querySelectorAll('[data-rename-session]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void renameRemoteTmuxSession(state.tabId, btn.dataset.renameSession ?? '');
    });
  });
  sessionsEl.querySelectorAll('[data-kill-session]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sessionName = btn.dataset.killSession ?? '';
      void killRemoteTmuxSession(state.tabId, sessionName, sessionName === data.current_session_name);
    });
  });
  windowsEl.querySelectorAll('[data-window-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.selectedWindowId = btn.dataset.windowId ?? '';
      renderRemoteTmuxInspector();
    });
  });
  windowsEl.querySelectorAll('[data-switch-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void switchRemoteTmuxWindow(state.tabId, btn.dataset.switchWindow ?? '');
    });
  });
  windowsEl.querySelectorAll('[data-rename-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const windowId = btn.dataset.renameWindow ?? '';
      const windowState = selectedSession?.windows.find((candidate) => candidate.window_id === windowId);
      void renameRemoteTmuxWindow(state.tabId, windowId, windowState?.window_name ?? '');
    });
  });
  windowsEl.querySelectorAll('[data-kill-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const windowId = btn.dataset.killWindow ?? '';
      const windowState = selectedSession?.windows.find((candidate) => candidate.window_id === windowId);
      void killRemoteTmuxWindow(state.tabId, windowId, windowState?.window_name ?? '', windowId === data.current_window_id);
    });
  });
  panesEl.querySelectorAll('[data-switch-pane]').forEach((btn) => {
    btn.addEventListener('click', () => {
      void switchRemoteTmuxPane(state.tabId, btn.dataset.switchPane ?? '');
    });
  });
  body.querySelector('[data-action="new-session"]')?.addEventListener('click', () => {
    void createRemoteTmuxSession(state.tabId);
  });
  body.querySelector('[data-action="new-window"]')?.addEventListener('click', () => {
    if (selectedSession?.session_name) {
      void createRemoteTmuxWindow(state.tabId, selectedSession.session_name);
    }
  });
}

async function refreshRemoteTmuxInspector({ force = false, preserveSelection = false } = {}) {
  const state = remoteTmuxInspectorState;
  if (!state) return;
  const pane = getRemoteTmuxPaneForTab(state.tabId);
  const target = normalizeSshTarget(pane?.target);
  if (!pane || !target || target.type !== 'remote_tmux') {
    state.error = 'Remote tmux pane is not available.';
    state.data = null;
    state.loading = false;
    renderRemoteTmuxInspector();
    return;
  }

  if (!force && state.loading) return;

  const previousSessionName = preserveSelection ? state.selectedSessionName : '';
  const previousWindowId = preserveSelection ? state.selectedWindowId : '';
  state.loading = true;
  state.error = '';
  renderRemoteTmuxInspector();

  try {
    state.data = await invoke('inspect_remote_tmux_state', { target });
    state.selectedSessionName = previousSessionName || state.data.current_session_name || state.data.sessions[0]?.session_name || '';
    const currentSession = state.data.sessions.find((session) => session.session_name === state.selectedSessionName);
    state.selectedWindowId = previousWindowId || state.data.current_window_id || currentSession?.windows[0]?.window_id || '';
  } catch (err) {
    state.data = null;
    state.error = String(err);
  } finally {
    state.loading = false;
    renderRemoteTmuxInspector();
  }
}

async function openRemoteTmuxInspector(tabId, { forceRefresh: _forceRefresh = false } = {}) {
  if (!tabHasRemoteTmux(tabId)) return;
  const previousState = remoteTmuxInspectorState;
  closeRemoteTmuxInspector();

  const panel = document.createElement('div');
  panel.id = 'remote-tmux-inspector';
  panel.className = 'remote-tmux-inspector';
  panel.innerHTML = `
    <div class="rti-header">
      <div>
        <div class="rti-title">Remote tmux</div>
        <div class="rti-subtitle"></div>
      </div>
      <div class="rti-header-actions">
        <button class="rti-header-btn" data-action="refresh">Refresh</button>
        <button class="rti-header-btn" data-action="close">Close</button>
      </div>
    </div>
    <div class="rti-body"></div>
  `;
  document.body.appendChild(panel);

  const onEscape = (event) => {
    if (event.key === 'Escape') closeRemoteTmuxInspector();
  };
  remoteTmuxInspectorCleanup = () => {
    panel.remove();
    document.removeEventListener('keydown', onEscape);
  };
  document.addEventListener('keydown', onEscape);

  remoteTmuxInspectorState = {
    tabId,
    loading: false,
    error: '',
    data: null,
    selectedSessionName: previousState?.tabId === tabId ? previousState.selectedSessionName : '',
    selectedWindowId: previousState?.tabId === tabId ? previousState.selectedWindowId : '',
  };
  renderRemoteTmuxInspector();
  await refreshRemoteTmuxInspector({ force: true, preserveSelection: true });
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
  if (tab.workspaceId !== activeWorkspaceId) switchWorkspace(tab.workspaceId);
  const remotePane = getRemoteTmuxPaneForTab(tabId);
  if (!remotePane) return false;

  const restoreData = serializeTabState(tab);
  const reopenTarget = remotePane.target;
  const showNotifPanel = notifPanelTabId === tabId;

  await closeTab(tabId);
  const newTabId = await createTab(reopenTarget, restoreData);
  if (showNotifPanel) {
    notifPanelTabId = newTabId;
    renderNotifPanel(newTabId);
  }
  return true;
}

async function reconnectRemoteTmuxWorkspace(workspaceId = activeWorkspaceId) {
  if (workspaceId !== activeWorkspaceId) switchWorkspace(workspaceId);
  const tabIds = workspaceRemoteTmuxTabIds(workspaceId);
  for (const tabId of tabIds) {
    await reconnectRemoteTmuxTab(tabId);
  }
}

async function openRemoteTmuxWorkspaceFromProfile(target) {
  const normalized = normalizeSshTarget(target);
  if (!normalized || normalized.type !== 'remote_tmux') return null;
  const workspaceName = normalized.name || `tmux ${normalized.session_name}`;
  const workspaceId = _createWorkspaceMeta(workspaceName);
  renderWorkspaceBar();
  switchWorkspace(workspaceId);
  return createTab(normalized);
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
    for (const pane of panes.values()) {
      backfillPaneCwdFromTranscript(pane);
      pane.screenSnapshot = captureVisibleTerminalScreen(pane.terminal, pane.serializeAddon);
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

function focusBrowserUrl() {
  return surfaceRuntime?.focusBrowserUrl() ?? false;
}

function browserNavigateRelative(direction) {
  return surfaceRuntime?.browserNavigateRelative(direction) ?? false;
}

function reloadActiveBrowser() {
  return surfaceRuntime?.reloadActiveBrowser() ?? false;
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

  if (ctrl && shift && !alt && key.toUpperCase() === 'J') {
    e.preventDefault();
    void toggleSessionVaultPanel();
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
document.getElementById('btn-session-vault')?.addEventListener('click', () => { void toggleSessionVaultPanel(); });
document.getElementById('btn-settings')?.addEventListener('click', showSettingsPanel);

const wsNameEl = document.getElementById('ws-name-label');
if (wsNameEl) wsNameEl.addEventListener('dblclick', startWorkspaceRename);
document.getElementById('workspace-bar')?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  const ws = workspaces.get(activeWorkspaceId);
  if (!ws) return;
  const remoteTmuxTabIds = workspaceRemoteTmuxTabIds(ws.id);
  const themeItems = WORKSPACE_THEMES.map((theme) => ({
    label: `${ws.themeId === theme.id ? '●' : '○'} Theme: ${theme.label}`,
    action: () => setWorkspaceTheme(ws.id, theme.id),
  }));
  showContextMenu([
    { label: 'Rename workspace', action: () => startWorkspaceRename() },
    { label: ws.pinned ? 'Unpin workspace' : 'Pin workspace', action: () => setWorkspacePinned(ws.id, !ws.pinned) },
    { label: 'Reconnect remote tmux tabs', action: () => reconnectRemoteTmuxWorkspace(ws.id), disabled: remoteTmuxTabIds.length === 0 },
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
