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
import { createPaneAuxRuntime } from './pane_aux_runtime.mjs';
import { createUiPanelsRuntime } from './ui_panels_runtime.mjs';
import { createSurfaceRuntime } from './surfaces_runtime.mjs';
import { createPrReviewRuntime } from './pr_review_runtime.mjs';
import { createAgentSidebarRuntime } from './agent_sidebar_runtime.mjs';
import { createCollabRuntime } from './collab_runtime.mjs';
import { createActivityLogRuntime } from './activity_log_runtime.mjs';
import { createKeybindingsRuntime } from './keybindings_runtime.mjs';
import { createCefEmbeddedSurface } from './cef_embedded.mjs';
import { createPaneRegistry } from './pane_registry.mjs';
import {
  createWorkspaceManager,
  DEFAULT_WORKSPACE_THEME_ID,
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
let activePrReviewLabel = null;
let zoomedSurfaceEl = null;
let contextMenuCleanup = null;
let remoteTmuxInspectorCleanup = null;
let remoteTmuxInspectorState = null;

const notifications = new Map();
let notifPanelTabId = null;

const artifacts = [];
let artifactPanelVisible = false;

const markdownPanes = new Map();
let browserPanes = new Map();
let surfaceRuntime = null;
let panelsRuntime = null;
let prReviewRuntime = null;
let agentSidebarRuntime = null;
let collabRuntime = null;
let activityLogRuntime = null;
let paneAuxRuntime = null;

const workspaces = new Map();
let activeWorkspaceId = null;

const {
  activatePane,
  activateTab,
  closePane,
  closeTab,
  collapsePaneBranch,
} = createPaneRegistry({
  tabs,
  panes,
  workspaces,
  invoke,
  document,
  getActivePaneId:              () => activePaneId,
  setActivePaneId:              (id) => { activePaneId = id; },
  getActiveTabId:               () => activeTabId,
  setActiveTabId:               (id) => { activeTabId = id; },
  getActiveWorkspaceId:         () => activeWorkspaceId,
  getZoomedSurface:             () => zoomedSurfaceEl,
  setZoomedSurface:             (el) => { zoomedSurfaceEl = el; },
  getNotifPanelTabId:           () => notifPanelTabId,
  setNotifPanelTabId:           (id) => { notifPanelTabId = id; },
  getRemoteTmuxInspectorState:  () => remoteTmuxInspectorState,
  clearActiveSurface,
  setPaneRing,
  markPaneNotificationsRead,
  fitAndResizePane,
  setTabRing,
  markTabNotificationsRead,
  updateTabMeta,
  syncBrowserVisibility,
  markLayoutDirty,
  getTabSurfaceElementByPath,
  activateSurfaceElement,
  refreshRemoteTmuxTabHealth,
  saveSessionVaultEntryForPane,
  closeRemoteTmuxInspector,
  closeBrowserSurface,
  closeMarkdownSurface,
  updateTabNumbers,
});

const DEFAULT_UPDATE_MANIFEST_URL = 'https://github.com/dcieslak19973/wmux/releases/latest/download/latest.json';
const DEFAULT_UPDATE_PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU3QzBGQzkzRTAyQUI5RkIKUldUN3VTcmdrL3pBVjVjcmE1dDRqNFFQbkZERFJ3MXk2bjhvN0FYNFJmZzZLaitkdFc5NlRCMXAK';
const AUTO_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_UPDATE_LAST_CHECK_KEY = 'wmux-auto-update-last-check-at';
const AUTO_UPDATE_DISMISSED_VERSION_KEY = 'wmux-auto-update-dismissed-version';

const SETTINGS_DEFAULTS = {
  fontSize: 13,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
  lineHeight: 1.2,
  scrollback: 5000,
  cursorStyle: 'bar',
  cursorBlink: true,
  updateManifestUrl: DEFAULT_UPDATE_MANIFEST_URL,
  updatePubkey: DEFAULT_UPDATE_PUBKEY,
  autoCheckUpdates: true,
};

const SAVED_SSH_TARGETS_KEY = 'wmux-saved-ssh-targets';

const FIX_AGENTS = [
  { key: 'claude',   label: 'Claude',   color: '#d97706', bash: (b) => `claude $'${b}'`,           ps: (b) => `claude "${b}"` },
  { key: 'codex',    label: 'Codex',    color: '#10b981', bash: (b) => `codex $'${b}'`,            ps: (b) => `codex "${b}"` },
  { key: 'gemini',   label: 'Gemini',   color: '#4285f4', bash: (b) => `gemini $'${b}'`,           ps: (b) => `gemini "${b}"` },
  { key: 'opencode', label: 'OpenCode', color: '#a78bfa', bash: (b) => `opencode $'${b}'`,         ps: (b) => `opencode "${b}"` },
  { key: 'aider',    label: 'Aider',    color: '#ec4899', bash: (b) => `aider --message $'${b}'`,  ps: (b) => `aider --message "${b}"` },
  { key: 'amp',      label: 'Amp',      color: '#f59e0b', bash: (b) => `amp $'${b}'`,              ps: (b) => `amp "${b}"` },
];

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

function basenameFromAnyPath(path) {
  return String(path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

function backfillPaneCwdFromTranscript(pane) {
  if (!pane) return '';
  const [currentCwd = '', previousCwd = ''] = inferRecentCwdsFromTerminalTranscript(pane.outputSnapshot)
    .map((value) => sanitizeCwdForTarget(pane.target, value));
  const inferredCwd = currentCwd || sanitizeCwdForTarget(pane.target, inferCwdFromTerminalTranscript(pane.outputSnapshot));
  if (!inferredCwd) return '';
  if (previousCwd && previousCwd !== inferredCwd) pane.previousCwd = previousCwd;
  pane.cwd = inferredCwd;
  const tab = tabs.get(pane.tabId);
  if (tab && (tab.paneIds.size === 1 || tab.lastActiveSurfaceEl === pane.domEl || activePaneId === pane.sessionId)) {
    tab.cwd = inferredCwd;
  }
  return inferredCwd;
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

  const git = pane.gitContext;
  if (!git?.repo_root) {
    return {
      primary: basenameFromAnyPath(pane.cwd) || defaultTargetLabel(pane.target),
      secondary: '',
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
    if (item.type === 'label') {
      const lbl = document.createElement('div');
      lbl.className = 'context-menu-label';
      lbl.textContent = item.text;
      menu.appendChild(lbl);
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
  if (activePrReviewLabel) return prReviewRuntime?.prReviewPanes.get(activePrReviewLabel)?.prEl ?? null;
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
  if (activePrReviewLabel) prReviewRuntime?.prReviewPanes.get(activePrReviewLabel)?.prEl.classList.remove('active-pane');
  activePaneId = null;
  activeBrowserLabel = null;
  activeMarkdownLabel = null;
  activePrReviewLabel = null;
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

  // Build the terminal DOM and measure actual dimensions BEFORE spawning the
  // session so ConPTY is created at the correct size from the start. This
  // prevents PSReadLine from initialising at 120×30 and then receiving a resize
  // that causes it to clear the screen and redraw.
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
  term.loadAddon(new WebLinksAddon(async (_event, uri) => {
    if (/^https?:\/\/(localhost|127\.0\.0\.1):/.test(uri)) {
      try {
        const resolved = await invoke('resolve_localhost_url', { paneId: sessionId, url: uri });
        await openBrowserSplitForTab(tabId, resolved);
      } catch (err) {
        console.warn('[wmux] tunnel resolve failed, falling back to OS browser:', err);
        window.open(uri, '_blank');
      }
    } else {
      window.open(uri, '_blank');
    }
  }, {
    hover(event) {
      const tip = document.createElement('div');
      tip.id = 'wmux-link-tip';
      tip.className = 'wmux-link-tip';
      tip.textContent = 'Ctrl+click to open';
      tip.style.left = `${event.clientX + 12}px`;
      tip.style.top  = `${event.clientY + 16}px`;
      document.body.appendChild(tip);
    },
    leave() {
      document.getElementById('wmux-link-tip')?.remove();
    },
  }));
  term.attachCustomKeyEventHandler((event) => {
    const key = event.key?.toLowerCase();
    const wantsPaste = (event.ctrlKey && !event.altKey && !event.shiftKey && key === 'v')
      || (!event.ctrlKey && !event.altKey && event.shiftKey && event.key === 'Insert');
    // Return false so xterm doesn't process Ctrl+V as a key sequence.
    // Do NOT preventDefault — let the browser fire the paste event, which
    // the document-level capture handler below will intercept exclusively.
    if (!wantsPaste) return true;
    return false;
  });

  // sessionId is declared here so closures below capture the variable by
  // reference; it is assigned after create_session resolves.
  let sessionId;
  let sessionLabel;

  const leafEl = document.createElement('div');
  leafEl.className = 'pane-leaf';
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

  // Document-level capture handler — fires before xterm's own paste listeners.
  // Intercepts all paste events while this terminal is focused, handles them
  // via our path, and stops the event so xterm never sees it.
  const handleTerminalPaste = async (event) => {
    if (!terminalHostEl.contains(document.activeElement)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    try {
      await pasteTextIntoPane(sessionId, text);
    } catch (err) {
      showError(`Could not paste into terminal: ${err}`);
    }
  };
  document.addEventListener('paste', handleTerminalPaste, { capture: true });

  // Per-pane command input buffer and history for Ctrl+Alt+H picker.
  let cmdLineBuf = '';
  let escapeSequenceState = 0;

  term.open(terminalHostEl);
  fitAddon.fit();
  // Log focus changes on the xterm textarea to diagnose keyboard-focus theft.
  const initialCols = term.cols || DEFAULT_COLS;
  const initialRows = term.rows || DEFAULT_ROWS;

  let result;
  try {
    result = await invoke('create_session', {
      cols: initialCols,
      rows: initialRows,
      target,
      cwd: restoredCwd || null,
      previousCwd: restoredPreviousCwd || null,
    });
  } catch (err) {
    showError(`Could not start terminal: ${err}`);
    term.dispose();
    leafEl.remove();
    return null;
  }

  sessionId    = result.id;
  sessionLabel = result.label;
  leafEl.dataset.sessionId = sessionId;

  const pendingRestoreSnapshot = screenSnapshot || outputSnapshot;
  const restoreSnapshotIsSerialized = !!screenSnapshot;
  const isWslTarget = getTargetKind(target) === 'wsl';
  const restoreReplaySanitizeUntil = pendingRestoreSnapshot ? Date.now() + 2200 : 0;
  const wslStartupSanitizeUntil = isWslTarget ? Date.now() + 2200 : 0;
  let restoreReplayFrame = null;
  let restoreReplayConfirmFrame = null;
  let restoreReplayApplied = false;

  const cancelRestoreReplay = () => {
    if (restoreReplayFrame) {
      cancelAnimationFrame(restoreReplayFrame);
      restoreReplayFrame = null;
    }
    if (restoreReplayConfirmFrame) {
      cancelAnimationFrame(restoreReplayConfirmFrame);
      restoreReplayConfirmFrame = null;
    }
    restoreReplayApplied = true;
  };

  const flushRestoreReplay = () => {
    if (!pendingRestoreSnapshot || restoreReplayApplied || !panes.has(sessionId)) return;
    cancelRestoreReplay();
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
    cancelRestoreReplay();
    try { await invoke('write_to_session', { id: sessionId, data }); }
    catch (err) { console.warn('[wmux terminal] write_to_session error:', err); }
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
    cancelRestoreReplay();
    const bytes = base64Decode(event.payload);
    const decoded = transcriptDecoder.decode(bytes, { stream: true });
    if (restoreReplaySanitizeUntil > Date.now() || wslStartupSanitizeUntil > Date.now()) {
      term.write(stripTerminalStartupResetSequences(decoded));
    } else if (isWslTarget) {
      term.write(decoded);
    } else {
      term.write(bytes);
    }
    const _pane = panes.get(sessionId);
    if (_pane) _pane.lastOutputTime = Date.now();
    appendTranscriptChunk(decoded);
    if (sessionId !== activePaneId) {
      const tab = tabs.get(tabId);
      if (tab) setTabRing(tab, true);
    }
  });

  const unlistenUrl = await listen(`terminal-url-${sessionId}`, (event) => {
    const { url, is_oauth } = event.payload;
    registerTabUrl(tabId, url);
    showUrlBanner(sessionId, tabId, url, is_oauth);
  });

  const unlistenClipboard = await listen(`terminal-clipboard-${sessionId}`, async (event) => {
    const text = String(event.payload?.text ?? '').trim();
    if (!text) return;
    try {
      await copyTextToClipboard(text);
    } catch (err) {
      console.warn('clipboard write error:', err);
      showError(`Could not copy terminal text: ${err}`);
    }
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
      pane.fbFlash?.();
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

  // ── Block tracking (OSC 133 shell integration) ─────────────────────────────
  let activeBlock = null;
  let pendingBlockCmd = null;

  function renderBlockDecoration(el, block) {
    const done = block.exitCode !== null;
    const failed = done && block.exitCode !== 0;
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c6af7';
    const borderColor = failed ? '#f87171' : done ? '#4ade80' : accent;
    // Use individual assignments — cssText would wipe the top/height xterm.js sets
    // before calling onRender, making the element 0px tall and the border invisible.
    el.style.left = '-8px';
    el.style.width = 'calc(100% + 8px)';
    el.style.borderLeft = `3px solid ${borderColor}`;
    el.style.background = failed ? 'rgba(248,113,113,0.04)' : '';
    el.style.pointerEvents = 'none';
    el.style.boxSizing = 'border-box';
    if (failed) {
      let badge = el.querySelector('.block-exit-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'block-exit-badge';
        el.appendChild(badge);
      }
      badge.textContent = `exit ${block.exitCode}`;

      // Fix button — only once block output is available from block-done event.
      if (block.rustBlock && !el.querySelector('.block-fix-btn')) {
        const btn = document.createElement('button');
        btn.className = 'block-fix-btn';
        btn.textContent = 'Fix';
        btn.title = 'Ask an agent to fix this (pastes command, press Enter to run)';
        // Keep container pointer-events:none; only the button itself is clickable.
        btn.style.pointerEvents = 'auto';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const shell = isWsl || isSsh ? 'bash' : 'powershell';
          const body = buildFixBody(block.rustBlock);
          const preferred = panes.get(sessionId)?.preferredAgent;
          const fixAgent = preferred ? FIX_AGENTS.find((a) => a.key === preferred) : null;
          if (fixAgent) {
            invoke('write_to_session', { id: sessionId, data: buildFixCmd(fixAgent, body, shell) }).catch(() => {});
            return;
          }
          const r = btn.getBoundingClientRect();
          showContextMenu(
            FIX_AGENTS.map((agent) => ({
              label: agent.label,
              action: () => {
                const cmd = buildFixCmd(agent, body, shell);
                invoke('write_to_session', { id: sessionId, data: cmd }).catch(() => {});
              },
            })),
            r.left, r.bottom + 4,
          );
        });
        el.appendChild(btn);
      }
    }
  }

  function buildFixBody(rustBlock) {
    const cmd = (rustBlock.command || '(unknown)').trim();
    const code = rustBlock.exit_code ?? 1;
    const rawOutput = (rustBlock.output ?? '').trim();
    const output = rawOutput.length > 600
      ? rawOutput.slice(0, 600) + '\n... (truncated)'
      : rawOutput || '(no output)';
    return [
      'Fix this failed command:',
      `$ ${cmd}`,
      `Exit code: ${code}`,
      '',
      'Output:',
      output,
      '',
      'What went wrong and how do I fix it?',
    ].join('\n');
  }

  function buildFixCmd(agent, body, shell) {
    if (shell === 'bash') {
      // $'...' ANSI-C quoting: handles \n, \', \\ inside single quotes.
      const escaped = body
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n');
      return agent.bash(escaped);
    } else {
      // PowerShell double-quoted string: backtick is the escape character.
      const escaped = body
        .replace(/`/g, '``')
        .replace(/"/g, '`"')
        .replace(/\n/g, '`n');
      return agent.ps(escaped);
    }
  }

  const unlistenBlockCmd = await listen(`terminal-block-cmd-${sessionId}`, (event) => {
    pendingBlockCmd = event.payload?.command ?? null;
  });

  const unlistenBlockStart = await listen(`terminal-block-start-${sessionId}`, () => {
    const pane = panes.get(sessionId);
    if (!pane) return;
    const marker = term.registerMarker(0);
    if (!marker) return;
    const buf = term.buffer.active;
    const block = {
      id: crypto.randomUUID(),
      command: pendingBlockCmd ?? '',
      marker,
      startRow: buf.viewportY + buf.cursorY,
      startTime: Date.now(),
      exitCode: null,
      _decorationEl: null,
      decoration: null,
    };
    pendingBlockCmd = null;
    activeBlock = block;
    pane.blocks.push(block);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#7c6af7';
    const decoration = term.registerDecoration({
      marker,
      overviewRulerOptions: { color: accent, position: 'left' },
    });
    decoration?.onRender((el) => {
      block._decorationEl = el;
      renderBlockDecoration(el, block);
    });
    block.decoration = decoration ?? null;
  });

  const unlistenBlockEnd = await listen(`terminal-block-end-${sessionId}`, (event) => {
    const block = activeBlock;
    if (!block) return;
    block.exitCode = event.payload?.exit_code ?? 0;
    block.endTime = Date.now();
    activeBlock = null;

    // Defer span calculation until xterm.js has flushed pending writes.
    // term.write() is async (flushes before the next paint), so the cursor
    // position isn't reliable until rAF fires.
    requestAnimationFrame(() => {
      const buf = term.buffer.active;
      const endRow = buf.viewportY + buf.cursorY;
      const spanHeight = Math.max(1, endRow - block.startRow);
      const color = block.exitCode !== 0 ? '#f87171' : '#4ade80';
      block.decoration?.dispose();
      const dec = term.registerDecoration({
        marker: block.marker,
        height: spanHeight,
        overviewRulerOptions: { color, position: 'left' },
      });
      dec?.onRender((el) => {
        block._decorationEl = el;
        renderBlockDecoration(el, block);
      });
      block.decoration = dec ?? null;

      // Fetch the full TermBlock output for: the Fix button (failed blocks) and
      // the activity log (agent panes). One call serves both.
      if (block.exitCode !== 0 || panes.get(sessionId)?.preferredAgent) {
        invoke('get_blocks', { sessionId, limit: 1 }).then((blocks) => {
          const rustBlock = blocks?.[blocks.length - 1];
          if (!rustBlock) return;
          if (block.exitCode !== 0) {
            block.rustBlock = rustBlock;
            // _decorationEl is set by onRender; re-render if it's already available,
            // otherwise onRender will fire later and pick up rustBlock itself.
            if (block._decorationEl) renderBlockDecoration(block._decorationEl, block);
          }
          activityLogRuntime?.onRustBlock(sessionId, rustBlock);
        }).catch(() => {});
      }
    });
  });
  // ── End block tracking ─────────────────────────────────────────────────────

  const unlistenAll = () => {
    document.removeEventListener('paste', handleTerminalPaste, { capture: true });
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
    unlistenClipboard();
    unlistenNotify();
    unlistenCwd();
    unlistenBlockCmd();
    unlistenBlockStart();
    unlistenBlockEnd();
    unlistenExit();
  };

  try {
    await invoke('start_session_stream', { id: sessionId });
  } catch (err) { console.error('[wmux] start_session_stream failed', err); }
  if (isWslTarget) {
    setTimeout(() => {
      void invoke('write_to_session', { id: sessionId, data: '\r' }).catch(() => {});
    }, 80);
  }

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
  const targetKind = getTargetKind(target);
  const isBlocksCapable = targetKind === 'local' || targetKind === 'wsl' || targetKind === 'ssh';
  const isWsl = targetKind === 'wsl';
  const isSsh = targetKind === 'ssh';
  const toolbarEl = document.createElement('div');
  toolbarEl.className = 'pane-toolbar';
  toolbarEl.innerHTML = `
    <button class="pane-tb-btn" data-action="split-h" title="Split right (Ctrl+Shift+\\)">&#x2502;</button>
    <button class="pane-tb-btn" data-action="split-v" title="Split down (Ctrl+Shift+-)">&#x2500;</button>
    <button class="pane-tb-btn" data-action="browser" title="Open browser pane">&#x25a6;</button>
    <button class="pane-tb-btn" data-action="markdown" title="Open markdown pane">MD</button>
    <button class="pane-tb-btn" data-action="artifact" title="Preview HTML artifact from output">HTML</button>
    <button class="pane-tb-btn" data-action="workbook" title="Open interactive workbook app">WKB</button>
    ${isBlocksCapable ? '<button class="pane-tb-btn pane-tb-blocks" data-action="blocks" title="Set up shell integration">&#x26a1;</button>' : ''}
    ${isBlocksCapable ? '<button class="pane-tb-btn pane-tb-mcp" data-action="mcp" title="Paste Claude Code setup command for wmux MCP">MCP</button>' : ''}
    ${isBlocksCapable ? '<button class="pane-tb-btn pane-tb-hooks" data-action="hooks" title="Install Claude Code hooks for live agent state">HK</button>' : ''}
    <button class="pane-tb-btn pane-tb-agent" data-action="agent" title="Set preferred AI agent for this pane">AI</button>
    <button class="pane-tb-btn pane-tb-pr" data-action="pr-review" title="Open PR diff view">PR</button>
    <button class="pane-tb-btn pane-tb-share" data-action="share" title="Share this pane (read-only)">SH</button>
    <button class="pane-tb-btn pane-tb-close" data-action="close" title="Close pane (Ctrl+Shift+W)">&#x2715;</button>
  `;
  toolbarEl.querySelector('[data-action="split-h"]').addEventListener('click', (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); showSplitTypePicker(sessionId, 'h', r.left, r.bottom + 4); });
  toolbarEl.querySelector('[data-action="split-v"]').addEventListener('click', (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); showSplitTypePicker(sessionId, 'v', r.left, r.bottom + 4); });
  toolbarEl.querySelector('[data-action="browser"]').addEventListener('click', (e) => { e.stopPropagation(); splitPaneWithBrowser(sessionId, 'h'); });
  toolbarEl.querySelector('[data-action="markdown"]').addEventListener('click', (e) => { e.stopPropagation(); splitPaneWithMarkdown(sessionId, 'h'); });
  toolbarEl.querySelector('[data-action="artifact"]').addEventListener('click', (e) => { e.stopPropagation(); previewArtifactFromPane(sessionId); });
  toolbarEl.querySelector('[data-action="workbook"]').addEventListener('click', (e) => { e.stopPropagation(); panelsRuntime?.openWorkbookDemo?.().catch((err) => showError(`Could not open workbook: ${err}`)); });
  toolbarEl.querySelector('[data-action="share"]').addEventListener('click',   (e) => { e.stopPropagation(); collabRuntime?.startShareForPane(sessionId); });
  toolbarEl.querySelector('[data-action="close"]').addEventListener('click',   (e) => { e.stopPropagation(); closePane(sessionId); });
  if (isBlocksCapable) {
    const blocksBtn = toolbarEl.querySelector('[data-action="blocks"]');
    const checkCmd = isWsl ? 'check_shell_integration_wsl'
                   : isSsh ? 'check_shell_integration_ssh'
                   : 'check_shell_integration';
    const installCmd = isWsl ? 'install_shell_integration_wsl'
                     : isSsh ? 'install_shell_integration_ssh'
                     : 'install_shell_integration';
    const shellArgs = isWsl ? { distro: target.distro ?? null }
                    : isSsh ? { host: target.host, user: target.user ?? null, port: target.port ?? null, identityFile: target.identity_file ?? null }
                    : {};

    invoke(checkCmd, shellArgs).then((installed) => {
      if (installed) {
        blocksBtn.classList.add('is-installed');
        blocksBtn.title = 'Shell integration installed (click to reinstall)';
      }
    }).catch(() => {});

    blocksBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      blocksBtn.disabled = true;
      try {
        await invoke(installCmd, shellArgs);
        blocksBtn.classList.add('is-installed');
        blocksBtn.title = 'Shell integration installed (click to reinstall)';
      } catch (err) {
        blocksBtn.title = `Setup failed: ${err}`;
      }
      blocksBtn.disabled = false;
    });

    const mcpBtn = toolbarEl.querySelector('[data-action="mcp"]');
    // Local panes use PowerShell where $env:WMUX_API_BASE syntax differs — hardcode the port.
    // WSL and SSH panes use bash, so $WMUX_API_BASE expands to the right IP/port automatically.
    const mcpUrl = isWsl || isSsh ? '$WMUX_API_BASE/mcp' : 'http://localhost:7766/mcp';
    const mcpCmd = `claude mcp add --transport http wmux ${mcpUrl}`;
    mcpBtn.title = `Paste: ${mcpCmd}`;
    mcpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      invoke('write_to_session', { id: sessionId, data: mcpCmd }).catch(() => {});
    });

    const hooksBtn = toolbarEl.querySelector('[data-action="hooks"]');
    const installHooksCmd = isWsl ? 'install_claude_hooks_wsl' : 'install_claude_hooks';
    const installHooksArgs = isWsl ? { distro: target.distro ?? null } : {};
    const checkHooksCmd = isWsl ? 'check_claude_hooks_wsl' : 'check_claude_hooks';
    const checkHooksArgs = isWsl ? { distro: target.distro ?? null } : {};

    invoke(checkHooksCmd, checkHooksArgs).then((installed) => {
      if (installed) {
        hooksBtn.classList.add('is-installed');
        hooksBtn.title = 'Claude Code hooks installed (click to reinstall)';
      }
    }).catch(() => {});

    hooksBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      hooksBtn.disabled = true;
      try {
        await invoke(installHooksCmd, installHooksArgs);
        hooksBtn.classList.add('is-installed');
        hooksBtn.title = 'Claude Code hooks installed (click to reinstall)';
      } catch (err) {
        hooksBtn.title = `Hook install failed: ${err}`;
      }
      hooksBtn.disabled = false;
    });

  }

  const agentBtn = toolbarEl.querySelector('[data-action="agent"]');
  agentBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = agentBtn.getBoundingClientRect();
    const pane = panes.get(sessionId);
    const items = [
      { label: 'Auto-detect', action: () => { pane.preferredAgent = null; agentBtn.textContent = 'AI'; agentBtn.style.color = ''; } },
      { type: 'separator' },
      ...FIX_AGENTS.map((agent) => ({
        label: agent.label,
        action: () => { pane.preferredAgent = agent.key; agentBtn.textContent = agent.label; agentBtn.style.color = agent.color ?? ''; },
      })),
    ];
    showContextMenu(items, r.left, r.bottom + 4);
  });

  const prBtn = toolbarEl.querySelector('[data-action="pr-review"]');
  prBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const pane = panes.get(sessionId);
    const cwd = pane?.cwd || tabs.get(pane?.tabId)?.cwd || '';
    splitPaneWithPrReview(sessionId, 'h', { cwd });
  });

  leafEl.appendChild(toolbarEl);

  // ── Toolbar auto-hide ─────────────────────────────────────────────────────
  const hotspotEl = document.createElement('div');
  hotspotEl.className = 'toolbar-hotspot';
  leafEl.appendChild(hotspotEl);

  let tbHideTimer = null;
  let tbDwellTimer = null;

  function tbShow() {
    clearTimeout(tbHideTimer);
    tbHideTimer = null;
    toolbarEl.classList.add('toolbar-visible');
  }
  function tbHide() {
    toolbarEl.classList.remove('toolbar-visible');
    tbHideTimer = null;
  }
  function tbScheduleHide(delay) {
    clearTimeout(tbHideTimer);
    tbHideTimer = setTimeout(tbHide, delay);
  }

  function tbFlash() {
    tbShow();
    tbScheduleHide(2000);
  }

  // Show briefly on creation
  tbFlash();

  hotspotEl.addEventListener('mouseenter', () => {
    clearTimeout(tbHideTimer);
    tbHideTimer = null;
    tbDwellTimer = setTimeout(tbShow, 320);
  });
  hotspotEl.addEventListener('mouseleave', () => {
    clearTimeout(tbDwellTimer);
    tbDwellTimer = null;
    if (!toolbarEl.matches(':hover')) tbScheduleHide(500);
  });

  toolbarEl.addEventListener('mouseenter', () => {
    clearTimeout(tbHideTimer);
    tbHideTimer = null;
  });
  toolbarEl.addEventListener('mouseleave', () => {
    tbScheduleHide(700);
  });
  // ─────────────────────────────────────────────────────────────────────────

  // ── Footer badge auto-hide ────────────────────────────────────────────────
  const footerHotspotEl = document.createElement('div');
  footerHotspotEl.className = 'footer-hotspot';
  leafEl.appendChild(footerHotspotEl);

  let fbHideTimer = null;
  let fbDwellTimer = null;

  function fbShow() {
    clearTimeout(fbHideTimer);
    fbHideTimer = null;
    footerEl.classList.add('footer-visible');
  }
  function fbHide() {
    footerEl.classList.remove('footer-visible');
    fbHideTimer = null;
  }
  function fbScheduleHide(delay) {
    clearTimeout(fbHideTimer);
    fbHideTimer = setTimeout(fbHide, delay);
  }
  function fbFlash() {
    fbShow();
    fbScheduleHide(2000);
  }

  // Show briefly on creation
  fbFlash();

  footerHotspotEl.addEventListener('mouseenter', () => {
    clearTimeout(fbHideTimer);
    fbHideTimer = null;
    fbDwellTimer = setTimeout(fbShow, 200);
  });
  footerHotspotEl.addEventListener('mouseleave', () => {
    clearTimeout(fbDwellTimer);
    fbDwellTimer = null;
    if (!footerEl.matches(':hover')) fbScheduleHide(500);
  });
  footerEl.addEventListener('mouseenter', () => {
    clearTimeout(fbHideTimer);
    fbHideTimer = null;
  });
  footerEl.addEventListener('mouseleave', () => {
    fbScheduleHide(700);
  });
  // ─────────────────────────────────────────────────────────────────────────

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
    preferredAgent: null,
    tbFlash,
    fbFlash,
    lastSessionVaultEntryId: typeof initialState?.vaultEntryId === 'string' ? initialState.vaultEntryId : null,
    lastSessionVaultSignature: null,
    contextBadgeEl,
    imageAddon,
    serializeAddon,
    // Seed with the initial ConPTY dimensions so fitAndResizePane skips a
    // same-size resize_session call that would trigger a PSReadLine redraw.
    lastSentCols: initialCols,
    lastSentRows: initialRows,
    blocks: [],
    lastOutputTime: null,
  };
  panes.set(sessionId, paneState);
  renderPaneContextBadge(sessionId);
  // Eagerly fetch git context for the initial cwd so the badge shows
  // repo/worktree info without waiting for the first OSC 7 event.
  // For fresh panes without a restoredCwd, fall back to the tab's current cwd.
  const initialGitCwd = restoredCwd || (!isRemoteTmuxTarget(target) ? (tabs.get(tabId)?.cwd ?? null) : null);
  if (initialGitCwd && !isRemoteTmuxTarget(target)) {
    updateTabCwd(tabId, initialGitCwd).then((metadata) => {
      const pane = panes.get(sessionId);
      if (pane) {
        pane.gitContext = metadata?.gitContext ?? null;
        renderPaneContextBadge(sessionId);
      }
    }).catch(() => {});
  }
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

// Split type picker

async function showSplitTypePicker(paneId, dir, x, y) {
  const pane = panes.get(paneId);
  if (!pane) return;
  const cwd = pane.cwd || tabs.get(pane.tabId)?.cwd || '';

  const items = [{ type: 'label', text: 'Terminal' }];

  items.push({ label: 'Local', action: () => splitPane(paneId, dir, { type: 'local' }) });

  try {
    const distros = await invoke('list_wsl_distros');
    for (const d of distros) {
      items.push({
        label: `WSL: ${d.name}${d.is_default ? ' (default)' : ''}`,
        action: () => splitPane(paneId, dir, { type: 'wsl', distro: d.name }),
      });
    }
  } catch { /* WSL unavailable */ }

  const savedSsh = loadSavedSshTargets();
  for (const conn of savedSsh) {
    items.push({
      label: `SSH: ${sshTargetDisplayName(conn)}`,
      action: () => splitPane(paneId, dir, conn),
    });
  }

  items.push(
    { type: 'separator' },
    { type: 'label', text: 'Pane' },
    { label: 'Browser', action: () => splitPaneWithBrowser(paneId, dir) },
    { label: 'Markdown', action: () => splitPaneWithMarkdown(paneId, dir) },
    { label: 'PR Review', action: () => splitPaneWithPrReview(paneId, dir, { cwd }) },
  );

  showContextMenu(items, x, y);
}

// Split the active pane

async function splitPane(paneId, dir, target = null) {
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

  const newSessionId = await createLeafPane(pane.tabId, target ?? getDefaultTarget(), sideBEl);
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

function activateBrowser(label) {
  return surfaceRuntime?.activateBrowser(label);
}

function activateMarkdown(label) {
  return surfaceRuntime?.activateMarkdown(label);
}

function activatePrReview(label) {
  return prReviewRuntime?.activatePrReview(label);
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

async function openRemoteTmuxInspector(tabId, { forceRefresh = false } = {}) {
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

async function closeBrowserSurface(label, { collapse = true } = {}) {
  return surfaceRuntime?.closeBrowserSurface(label, { collapse });
}

function closeMarkdownSurface(label, { collapse = true } = {}) {
  return surfaceRuntime?.closeMarkdownSurface(label, { collapse });
}

function closePrReviewSurface(label, { collapse = true } = {}) {
  return prReviewRuntime?.closePrReviewSurface(label, { collapse });
}

async function splitPaneWithPrReview(paneId, dir = 'h', initialState = {}) {
  return prReviewRuntime?.splitPaneWithPrReview(paneId, dir, initialState);
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

function showToast(msg, severity) {
  return panelsRuntime?.showToast(msg, severity);
}

function showUrlBanner(sessionId, tabId, url, isOauth) {
  return panelsRuntime?.showUrlBanner(sessionId, tabId, url, isOauth);
}


async function copyTextToClipboard(text) {
  return panelsRuntime?.copyTextToClipboard(text);
}

function showUpdatePrompt(updateInfo, actions) {
  return panelsRuntime?.showUpdatePrompt(updateInfo, actions);
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.classList?.contains('xterm-helper-textarea') || target.closest('.xterm-helper-textarea')) {
    return false;
  }
  if (target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="textbox"]')) {
    return true;
  }
  const tagName = target.tagName?.toUpperCase();
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || target.isContentEditable;
}

async function pasteTextIntoPane(paneId, text) {
  const value = String(text ?? '');
  if (!value) return false;
  const pane = panes.get(paneId);
  if (!pane) return false;
  await invoke('write_to_session', { id: pane.sessionId, data: value });
  return true;
}

async function readClipboardText() {
  try {
    return await invoke('read_clipboard_text');
  } catch {
    // Fall through to browser clipboard access when native read is unavailable.
  }
  try {
    if (navigator.clipboard?.readText) {
      return await navigator.clipboard.readText();
    }
  } catch {
    // Surface the original clipboard failure below if neither path works.
  }
  throw new Error('clipboard read unavailable');
}

async function pasteClipboardIntoActivePane() {
  const pane = panes.get(activePaneId);
  if (!pane) return false;
  const text = await readClipboardText();
  return pasteTextIntoPane(pane.sessionId, text);
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

function getUpdaterConfigFromSettings(settings = loadSettings()) {
  return {
    endpoint: String(settings?.updateManifestUrl ?? '').trim(),
    pubkey: String(settings?.updatePubkey ?? '').trim(),
  };
}

function shouldAutoCheckForUpdates(settings = loadSettings()) {
  if (!settings?.autoCheckUpdates) return false;
  const { endpoint, pubkey } = getUpdaterConfigFromSettings(settings);
  return Boolean(endpoint && pubkey);
}

async function installAvailableUpdate(config = getUpdaterConfigFromSettings()) {
  await invoke('install_app_update', { config });
}

async function maybeAutoCheckForUpdates({ force = false } = {}) {
  const settings = loadSettings();
  if (!shouldAutoCheckForUpdates(settings)) return null;

  const { endpoint, pubkey } = getUpdaterConfigFromSettings(settings);
  const lastCheckedAt = Number(localStorage.getItem(AUTO_UPDATE_LAST_CHECK_KEY) ?? '0');
  const now = Date.now();
  if (!force && Number.isFinite(lastCheckedAt) && now - lastCheckedAt < AUTO_UPDATE_CHECK_INTERVAL_MS) {
    return null;
  }

  localStorage.setItem(AUTO_UPDATE_LAST_CHECK_KEY, String(now));

  let result = null;
  try {
    result = await invoke('check_for_app_update', {
      config: { endpoint, pubkey },
    });
  } catch (err) {
    console.warn('Automatic update check failed:', err);
    return null;
  }

  if (!result?.available || !result.version) return result;
  const dismissedVersion = localStorage.getItem(AUTO_UPDATE_DISMISSED_VERSION_KEY);
  if (!force && dismissedVersion === result.version) return result;

  showUpdatePrompt(result, {
    onInstall: async () => {
      try {
        await installAvailableUpdate({ endpoint, pubkey });
      } catch (err) {
        showError(`Could not install update: ${err}`);
        throw err;
      }
    },
    onDismiss: () => {
      localStorage.setItem(AUTO_UPDATE_DISMISSED_VERSION_KEY, result.version);
    },
    onOpenSettings: () => {
      localStorage.removeItem(AUTO_UPDATE_DISMISSED_VERSION_KEY);
      panelsRuntime?.showSettingsPanel();
    },
  });
  return result;
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

function clearPaneNotifications(tabId, paneId) {
  panelsRuntime?.clearPaneNotifications(tabId, paneId);
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

function toggleSessionVaultPanel(force) {
  return panelsRuntime?.toggleSessionVaultPanel(force);
}

function buildSessionVaultTranscriptHtml(entry) {
  const title = entry.pane_title || entry.tab_title || 'Terminal transcript';
  const metaBits = [
    new Date(entry.saved_at).toLocaleString(),
    entry.workspace_name,
    entry.tab_title,
    entry.target_label,
    entry.cwd,
    entry.pane_detail,
    entry.reason,
  ].filter(Boolean);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title)}</title><style>html,body{margin:0;padding:0;background:#0f1115;color:#e4e4e7;font-family:'Cascadia Code','Fira Code','Consolas',monospace}body{padding:24px}header{margin-bottom:18px}h1{margin:0 0 8px;font-size:18px;font-family:system-ui,-apple-system,sans-serif}p{margin:0;color:#a1a1aa;font-size:12px;font-family:system-ui,-apple-system,sans-serif}pre{margin:0;padding:16px;border-radius:12px;background:#151821;border:1px solid rgba(255,255,255,0.08);white-space:pre-wrap;word-break:break-word;line-height:1.45;font-size:12px}</style></head><body><header><h1>${escHtml(title)}</h1><p>${escHtml(metaBits.join(' · '))}</p></header><pre>${escHtml(entry.transcript ?? '')}</pre></body></html>`;
}

async function openSessionVaultEntryInBrowser(entryId) {
  const entry = await invoke('read_session_vault_entry', { id: entryId });
  const previewUrl = await invoke('save_artifact_preview', { html: buildSessionVaultTranscriptHtml(entry) });
  if (!activeTabId) await createTab(getDefaultTarget());
  if (activeTabId) await openBrowserSplitForTab(activeTabId, previewUrl);
}

async function saveSessionVaultEntryForPane(paneId = activePaneId, { force = false, reason = 'manual' } = {}) {
  const pane = panes.get(paneId);
  if (!pane) {
    if (force) showError('No active terminal pane to archive');
    return null;
  }

  backfillPaneCwdFromTranscript(pane);

  const tab = tabs.get(pane.tabId);
  const workspace = tab ? workspaces.get(tab.workspaceId) : null;
  let transcript = '';
  try {
    transcript = await invoke('capture_session_output_by_id', { id: paneId }) ?? '';
  } catch (err) {
    console.warn(`Could not capture transcript for pane ${paneId}:`, err);
  }
  transcript = String(transcript || pane.outputSnapshot || '').replace(/\0/g, '').trimEnd();
  if (!transcript.trim()) return null;

  const signature = `${transcript.length}:${transcript.slice(-512)}`;
  if (!force && pane.lastSessionVaultSignature === signature) {
    return pane.lastSessionVaultEntryId ? { id: pane.lastSessionVaultEntryId } : null;
  }

  const paneLabel = getPaneAutoLabel(pane);
  try {
    const saved = await invoke('save_session_vault_entry', {
      request: {
        paneId,
        workspaceName: workspace?.name ?? '',
        tabTitle: tab?.title ?? 'Terminal',
        paneTitle: pane.labelOverride?.trim() || paneLabel.primary || 'Terminal',
        paneDetail: paneLabel.secondary || null,
        targetKind: getTargetKind(pane.target),
        targetLabel: defaultTargetLabel(pane.target),
        cwd: pane.cwd || null,
        transcript,
        reason,
      },
    });
    pane.lastSessionVaultSignature = signature;
    pane.lastSessionVaultEntryId = saved.id;
    return saved;
  } catch (err) {
    console.warn(`Could not persist transcript for pane ${paneId}:`, err);
    return null;
  }
}

async function flushSessionVaultEntries({ force = false, reason = 'shutdown', paneIds = null } = {}) {
  const ids = Array.isArray(paneIds) ? paneIds : [...panes.keys()];
  await Promise.allSettled(ids.map((paneId) => saveSessionVaultEntryForPane(paneId, { force, reason })));
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
    if (t.type === 'ssh' || t.type === 'remote_tmux') return sshTargetsEqual(t, defaultTarget);
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

    <div class="nt-section-label">Saved connections</div>
    <div id="nt-ssh-saved-list" class="nt-ssh-saved-list"></div>

    <div class="nt-section-label">SSH</div>
    <form id="nt-ssh-form" class="nt-ssh-form" autocomplete="off">
      <input id="nt-ssh-name" type="text" placeholder="Connection name (optional)" spellcheck="false" />
      <div class="nt-ssh-row">
        <input id="nt-ssh-host" type="text" placeholder="user@host or host" spellcheck="false" />
        <input id="nt-ssh-port" type="number" placeholder="Port (22)" min="1" max="65535" />
      </div>
      <input id="nt-ssh-key" type="text" placeholder="SSH key path, e.g. ~/.ssh/id_rsa (optional)" spellcheck="false" />
      <label class="nt-ssh-default-label nt-ssh-toggle-row">
        <input type="checkbox" id="nt-ssh-use-tmux"> Use tmux
      </label>
      <div id="nt-ssh-tmux-fields" hidden>
        <div class="nt-ssh-row">
          <select id="nt-ssh-tmux-mode">
            <option value="attach">Restore existing session</option>
            <option value="create">Create new session</option>
            <option value="attach_or_create">Restore or create session</option>
          </select>
          <input id="nt-ssh-session" type="text" placeholder="tmux session name" spellcheck="false" />
        </div>
      </div>
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
  const sshUseTmuxInput = popover.querySelector('#nt-ssh-use-tmux');
  const sshTmuxFields = popover.querySelector('#nt-ssh-tmux-fields');
  const sshTmuxModeInput = popover.querySelector('#nt-ssh-tmux-mode');
  const sshSessionInput = popover.querySelector('#nt-ssh-session');
  const sshDefaultInput = popover.querySelector('#nt-ssh-set-default');
  const sshSaveBtn = popover.querySelector('#nt-ssh-save');
  const sshFormState = popover.querySelector('#nt-ssh-form-state');
  const formRefs = {
    nameInput: sshNameInput,
    hostInput: sshHostInput,
    portInput: sshPortInput,
    keyInput: sshKeyInput,
    useTmuxInput: sshUseTmuxInput,
    tmuxFields: sshTmuxFields,
    sessionModeInput: sshTmuxModeInput,
    sessionInput: sshSessionInput,
    defaultInput: sshDefaultInput,
    saveBtn: sshSaveBtn,
    formState: sshFormState,
  };

  const parseConnectionTarget = () => {
    return buildConnectionTargetFromFields({
      name: formRefs.nameInput.value,
      host: formRefs.hostInput.value,
      port: formRefs.portInput.value,
      identityFile: formRefs.keyInput.value,
      useTmux: formRefs.useTmuxInput.checked,
      sessionMode: formRefs.sessionModeInput.value,
      sessionName: formRefs.sessionInput.value,
    });
  };

  const updateTmuxFieldVisibility = () => {
    formRefs.tmuxFields.hidden = !formRefs.useTmuxInput.checked;
    formRefs.sessionInput.placeholder = formRefs.sessionModeInput.value === REMOTE_TMUX_SESSION_MODES.CREATE
      ? 'tmux session name for the new session'
      : 'tmux session name';
  };

  const clearConnectionForm = () => {
    formRefs.nameInput.value = '';
    formRefs.hostInput.value = '';
    formRefs.portInput.value = '';
    formRefs.keyInput.value = '';
    formRefs.useTmuxInput.checked = false;
    formRefs.sessionModeInput.value = REMOTE_TMUX_SESSION_MODES.ATTACH;
    formRefs.sessionInput.value = '';
    formRefs.defaultInput.checked = false;
    updateTmuxFieldVisibility();
  };

  const updateConnectionFormState = () => {
    if (editingSavedSshId) {
      const existing = savedSshTargets.find((entry) => entry.id === editingSavedSshId);
      formRefs.formState.textContent = existing ? `Editing ${sshTargetDisplayName(existing)}` : 'Editing saved connection';
      formRefs.formState.classList.add('is-editing');
      formRefs.saveBtn.textContent = 'Update';
      return;
    }

    const tmuxMode = formRefs.sessionModeInput.value;
    formRefs.formState.textContent = formRefs.useTmuxInput.checked
      ? (tmuxMode === REMOTE_TMUX_SESSION_MODES.CREATE
        ? 'Connect over SSH and create a named tmux session on the remote host.'
        : tmuxMode === REMOTE_TMUX_SESSION_MODES.ATTACH
          ? 'Connect over SSH and restore a named tmux session on the remote host.'
          : 'Connect over SSH and restore or create a named tmux session on the remote host.')
      : 'Save a plain SSH shell connection to keep it in the picker.';
    formRefs.formState.classList.remove('is-editing');
    formRefs.saveBtn.textContent = 'Save';
  };

  const fillConnectionForm = (target, { editingId = null, preserveDefault = false } = {}) => {
    const normalized = normalizeSshTarget(target);
    if (!normalized) return;
    editingSavedSshId = editingId;
    clearConnectionForm();
    formRefs.nameInput.value = normalized.name ?? '';
    formRefs.hostInput.value = normalized.user ? `${normalized.user}@${normalized.host}` : normalized.host;
    formRefs.portInput.value = normalized.port ?? '';
    formRefs.keyInput.value = normalized.identity_file ?? '';
    formRefs.useTmuxInput.checked = normalized.type === 'remote_tmux';
    formRefs.sessionModeInput.value = normalized.type === 'remote_tmux'
      ? normalized.session_mode ?? REMOTE_TMUX_SESSION_MODES.ATTACH_OR_CREATE
      : REMOTE_TMUX_SESSION_MODES.ATTACH;
    formRefs.sessionInput.value = normalized.type === 'remote_tmux' ? normalized.session_name : '';
    formRefs.defaultInput.checked = preserveDefault ? formRefs.defaultInput.checked : isDefaultTarget(normalized);
    updateTmuxFieldVisibility();
    updateConnectionFormState();
  };

  const validateConnectionTarget = (target) => {
    if (target) return null;
    if (!formRefs.hostInput.value.trim()) return 'SSH host is required. Use host or user@host.';
    if (formRefs.useTmuxInput.checked && !formRefs.sessionInput.value.trim()) {
      return 'tmux session name is required when Use tmux is enabled.';
    }
    return 'SSH host is required. Use host or user@host.';
  };

  const renderSavedSshTargets = () => {
    sshSavedList.innerHTML = '';
    if (savedSshTargets.length === 0) {
      sshSavedList.innerHTML = '<span class="nt-empty">Saved SSH and remote tmux connections will show up here.</span>';
      updateConnectionFormState();
      return;
    }

    for (const entry of savedSshTargets) {
      const row = document.createElement('div');
      row.className = 'nt-saved-ssh-row';

      const connectBtn = document.createElement('button');
      connectBtn.className = 'nt-saved-ssh-main';
      connectBtn.innerHTML = `
        <span class="nt-saved-ssh-title">${escHtml(sshTargetDisplayName(entry))}</span>
        <span class="nt-saved-ssh-detail">${escHtml(sshTargetDetailLabel(entry))}</span>
      `;
      connectBtn.addEventListener('click', () => {
        closePopover();
        createTab(entry);
      });

      const actions = document.createElement('div');
      actions.className = 'nt-saved-ssh-actions';

      if (entry.type === 'remote_tmux') {
        const workspaceBtn = document.createElement('button');
        workspaceBtn.className = 'nt-saved-ssh-action';
        workspaceBtn.title = 'Open saved remote tmux profile in a dedicated workspace';
        workspaceBtn.textContent = 'Workspace';
        workspaceBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          closePopover();
          void openRemoteTmuxWorkspaceFromProfile(entry);
        });
        actions.appendChild(workspaceBtn);
      }

      const editBtn = document.createElement('button');
      editBtn.className = 'nt-saved-ssh-action';
      editBtn.title = 'Edit saved connection';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        fillConnectionForm(entry, { editingId: entry.id });
        formRefs.hostInput.focus();
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'nt-saved-ssh-action danger';
      deleteBtn.title = 'Delete saved connection';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        savedSshTargets = savedSshTargets.filter((candidate) => candidate.id !== entry.id);
        saveSavedSshTargets(savedSshTargets);
        if (editingSavedSshId === entry.id) {
          editingSavedSshId = null;
          clearConnectionForm();
        }
        renderSavedSshTargets();
      });

      actions.appendChild(editBtn);
      actions.appendChild(deleteBtn);
      actions.appendChild(makeStarBtn(entry));
      row.appendChild(connectBtn);
      row.appendChild(actions);
      sshSavedList.appendChild(row);
    }

    updateConnectionFormState();
  };

  const saveConnectionProfile = () => {
    const target = parseConnectionTarget();
    const validationError = validateConnectionTarget(target);
    if (validationError) {
      showError(validationError);
      (formRefs.useTmuxInput.checked && !formRefs.sessionInput.value.trim() ? formRefs.sessionInput : formRefs.hostInput)?.focus();
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
    if (formRefs.defaultInput.checked) {
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
  if (defaultTarget.type === 'ssh' || defaultTarget.type === 'remote_tmux') {
    fillConnectionForm(defaultTarget, { preserveDefault: true });
    formRefs.defaultInput.checked = true;
  }

  renderSavedSshTargets();
  updateTmuxFieldVisibility();
  updateConnectionFormState();

  sshSaveBtn.addEventListener('click', () => { saveConnectionProfile(); });
  sshUseTmuxInput.addEventListener('change', () => {
    updateTmuxFieldVisibility();
    updateConnectionFormState();
  });
  sshTmuxModeInput.addEventListener('change', () => {
    updateTmuxFieldVisibility();
    updateConnectionFormState();
  });

  popover.querySelector('#nt-ssh-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const target = parseConnectionTarget();
    const validationError = validateConnectionTarget(target);
    if (validationError) {
      showError(validationError);
      (sshUseTmuxInput.checked && !sshSessionInput.value.trim() ? sshSessionInput : sshHostInput).focus();
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
  listSessionVaultEntries: () => invoke('list_session_vault_entries'),
  readSessionVaultEntry: (id) => invoke('read_session_vault_entry', { id }),
  captureSessionVaultEntry: (paneId, options) => saveSessionVaultEntryForPane(paneId, options),
  openSessionVaultEntry: (entryId) => openSessionVaultEntryInBrowser(entryId),
  checkForAppUpdate: (config) => invoke('check_for_app_update', { config }),
  installAppUpdate: (config) => invoke('install_app_update', { config }),
  getAppVersion: () => invoke('get_app_version'),
  getKeybindingsApi: () => keybindingsApi,
});

prReviewRuntime = createPrReviewRuntime({
  invoke,
  document,
  panes,
  tabs,
  collapsePaneBranch,
  makeDividerDrag,
  fitAndResizePane,
  toggleSurfaceZoom,
  onLayoutChanged: () => markLayoutDirty(),
  getActiveTabId: () => activeTabId,
  getActivePrReviewLabel: () => activePrReviewLabel,
  setActivePrReviewLabel: (label) => { activePrReviewLabel = label; },
  clearActiveSurface,
  escHtml,
  getActivePaneId: () => activePaneId,
  fixAgents: FIX_AGENTS,
  showContextMenu,
  getTargetKind,
});

agentSidebarRuntime = createAgentSidebarRuntime({
  document,
  panes,
  listPaneSummaries,
  activateTab,
  activatePane,
  closePane,
  createTab,
  getDefaultTarget,
  escHtml,
  addNotification,
  clearPaneNotifications,
});

collabRuntime = createCollabRuntime({
  document,
  invoke,
  listen,
  panes,
  escHtml,
  showError,
  showToast,
});

void listen('agent-hook-event', (event) => {
  agentSidebarRuntime?.handleHookEvent(event.payload);
  activityLogRuntime?.onHookEvent(event.payload);
  // When Claude calls workbook_open via MCP, auto-open the returned preview URL in a browser pane.
  const { hook_event, tool, tool_response, tool_result, pane_id } = event.payload ?? {};
  if (hook_event === 'PostToolUse' && tool?.endsWith('workbook_open')) {
    try {
      const raw = tool_response ?? tool_result;
      // Claude Code may send tool_response as:
      //   {content: [{type:'text', text:'{"preview_url":"..."}'}]}  — MCP standard
      //   [{type:'text', text:'...'}]                               — bare array
      //   '{"preview_url":"..."}'                                   — plain string
      //   {output: '...'}  /  {text: '...'}                        — legacy shapes
      let text = null;
      if (typeof raw === 'string') {
        text = raw;
      } else if (Array.isArray(raw)) {
        text = raw[0]?.text ?? raw[0]?.output ?? null;
      } else if (raw && typeof raw === 'object') {
        const content = raw.content ?? raw.output ?? raw.result ?? raw.text;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) text = content[0]?.text ?? content[0]?.output ?? null;
        else if (content == null) text = null;
      }
      const parsed = JSON.parse(text ?? '{}');
      const preview_url = parsed.preview_url;
      if (preview_url) {
        const tabId = panes.get(pane_id)?.tabId ?? activeTabId;
        openBrowserSplitForTab(tabId, preview_url).catch(() => {});
      }
    } catch (_) { /* malformed response — ignore */ }
  }
});

activityLogRuntime = createActivityLogRuntime({
  panes,
  listPaneSummaries,
  activatePane,
  escHtml,
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
  agentSidebarRuntime?.refresh();
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

// ─────────────────────────────────────────────────────────────────────────────
// Global keybindings
//
// All app-level keyboard shortcuts go through `keybindingsRuntime`. Phase A:
// pure refactor — every binding here was previously a hardcoded `if (ctrl &&
// shift && ...)` branch in this file's keydown handler. Defaults preserved
// exactly. Phase B will add user overrides from a JSON config; Phase C adds
// a settings UI. See docs / project_roadmap.md "Customizable keybindings".
//
// Conventions:
//   * Chord format: `[ctrl+][alt+][shift+][meta+]<key>` (modifiers
//     alphabetical, key lowercased). e.g. `ctrl+shift+l`, `ctrl+alt+arrowleft`.
//   * Multiple chords per command are supported (paste = ctrl+v AND
//     shift+insert; h-split picker = ctrl+shift+\ AND ctrl+shift+| because of
//     keyboard-layout shift-modify behavior).
//   * Commands that need context gating (e.g. "Ctrl+L focuses the browser URL
//     only when there's a browser pane to focus") return `false` from their
//     handler when they don't actually consume the event, so the event falls
//     through to OS / browser defaults.
// ─────────────────────────────────────────────────────────────────────────────

const keybindingsRuntime = createKeybindingsRuntime();

keybindingsRuntime.register({
  id: 'pane.paste',
  label: 'Paste clipboard into active pane',
  defaultBindings: ['ctrl+v', 'shift+insert'],
  shouldRun: (e) => !isEditableTarget(e.target) && !!activePaneId,
  handler: () => {
    void pasteClipboardIntoActivePane().catch((err) => {
      showError(`Could not paste clipboard: ${err}`);
    });
  },
});

keybindingsRuntime.register({
  id: 'tab.new',
  label: 'New tab',
  defaultBindings: ['ctrl+shift+t'],
  handler: () => createTab(getDefaultTarget()),
});

keybindingsRuntime.register({
  id: 'sidebar.agent.toggle',
  label: 'Toggle agent sidebar',
  defaultBindings: ['ctrl+shift+a'],
  handler: () => agentSidebarRuntime?.toggle(),
});

keybindingsRuntime.register({
  id: 'surface.close',
  label: 'Close current surface',
  defaultBindings: ['ctrl+shift+w'],
  handler: () => closeCurrentSurface(),
});

keybindingsRuntime.register({
  // Without shift: close active pane/surface. Intercepted so WebView2's built-in
  // "close window" shortcut doesn't fire and take down the whole app.
  id: 'pane.close',
  label: 'Close active pane',
  defaultBindings: ['ctrl+w'],
  handler: () => { if (!closeCurrentSurface() && activePaneId) closePane(activePaneId); },
});

const showHSplitPicker = () => {
  if (!activePaneId) return;
  const r = panes.get(activePaneId)?.domEl?.getBoundingClientRect();
  if (r) showSplitTypePicker(activePaneId, 'h', r.left + r.width / 2 - 70, r.top + r.height / 2 - 40);
};
keybindingsRuntime.register({
  id: 'pane.split.horizontal',
  label: 'Split pane horizontally',
  // Both \ and | so the binding fires regardless of whether the layout's
  // Shift+\ produces \ or |.
  defaultBindings: ['ctrl+shift+\\', 'ctrl+shift+|'],
  handler: showHSplitPicker,
});

const showVSplitPicker = () => {
  if (!activePaneId) return;
  const r = panes.get(activePaneId)?.domEl?.getBoundingClientRect();
  if (r) showSplitTypePicker(activePaneId, 'v', r.left + r.width / 2 - 70, r.top + r.height / 2 - 40);
};
keybindingsRuntime.register({
  id: 'pane.split.vertical',
  label: 'Split pane vertically',
  defaultBindings: ['ctrl+shift+-', 'ctrl+shift+_'],
  handler: showVSplitPicker,
});

const cycleTab = (direction) => {
  const wsTabIds = [...tabs.values()]
    .filter((t) => t.workspaceId === activeWorkspaceId)
    .map((t) => t.tabId);
  if (wsTabIds.length < 2) return;
  const idx = wsTabIds.indexOf(activeTabId);
  const next = direction === 'prev'
    ? wsTabIds[(idx - 1 + wsTabIds.length) % wsTabIds.length]
    : wsTabIds[(idx + 1) % wsTabIds.length];
  activateTab(next);
};
keybindingsRuntime.register({
  id: 'tab.next',
  label: 'Next tab',
  defaultBindings: ['ctrl+tab'],
  handler: () => cycleTab('next'),
});
keybindingsRuntime.register({
  id: 'tab.prev',
  label: 'Previous tab',
  defaultBindings: ['ctrl+shift+tab'],
  handler: () => cycleTab('prev'),
});

keybindingsRuntime.register({
  id: 'panel.notifications.toggle',
  label: 'Toggle notifications panel',
  defaultBindings: ['ctrl+i'],
  handler: () => toggleNotifPanel(),
});

// NB: the legacy code had TWO Ctrl+Shift+L bindings; the activity-log one
// ran first and `return`ed, so the "open browser pane" binding at the same
// chord was dead. Preserving that behavior: activity log keeps Ctrl+Shift+L,
// browser-split has no default binding for now (TODO: pick a different chord).
keybindingsRuntime.register({
  id: 'panel.activity-log.toggle',
  label: 'Toggle activity log',
  defaultBindings: ['ctrl+shift+l'],
  handler: () => activityLogRuntime?.toggle(),
});
keybindingsRuntime.register({
  id: 'pane.browser.split',
  label: 'Split with browser pane',
  defaultBindings: [], // Was Ctrl+Shift+L in legacy code but shadowed by activity-log; left unbound.
  handler: () => {
    if (activePaneId) splitPaneWithBrowser(activePaneId, 'h');
    else if (activeTabId) openBrowserSplitForTab(activeTabId);
  },
});

keybindingsRuntime.register({
  id: 'pane.artifact.preview',
  label: 'Preview HTML artifact from active pane',
  defaultBindings: ['ctrl+shift+o'],
  handler: () => previewArtifactFromPane(),
});

keybindingsRuntime.register({
  id: 'panel.session-vault.toggle',
  label: 'Toggle session vault panel',
  defaultBindings: ['ctrl+shift+j'],
  handler: () => { void toggleSessionVaultPanel(); },
});

keybindingsRuntime.register({
  id: 'notifications.jump-to-unread',
  label: 'Jump to latest unread notification',
  defaultBindings: ['ctrl+shift+u'],
  handler: () => {
    const unread = [...tabs.values()]
      .filter((t) => t.workspaceId === activeWorkspaceId && unreadNotificationCount(t.tabId) > 0);
    if (unread.length > 0) activateTab(unread[unread.length - 1].tabId);
    else {
      const allNotif = [...tabs.values()].filter((t) => unreadNotificationCount(t.tabId) > 0);
      if (allNotif.length > 0) {
        const t = allNotif[allNotif.length - 1];
        switchWorkspace(t.workspaceId);
        activateTab(t.tabId);
      }
    }
  },
});

keybindingsRuntime.register({
  id: 'pane.history.picker',
  label: 'Show command-history picker',
  defaultBindings: ['ctrl+alt+h'],
  handler: () => showHistoryPicker(),
});

keybindingsRuntime.register({
  id: 'pane.find',
  label: 'Find in active pane',
  defaultBindings: ['ctrl+f'],
  handler: () => showFindBar(),
});

keybindingsRuntime.register({
  id: 'pane.markdown.split',
  label: 'Split with markdown pane',
  defaultBindings: ['ctrl+shift+m'],
  handler: () => {
    if (activePaneId) splitPaneWithMarkdown(activePaneId, 'h');
    else if (activeTabId) openMarkdownSplitForTab(activeTabId);
  },
});

keybindingsRuntime.register({
  id: 'browser.url.focus',
  label: 'Focus browser-pane URL bar',
  defaultBindings: ['ctrl+l'],
  // focusBrowserUrl returns truthy when there was a browser pane to focus;
  // falsy means no browser pane => let the event fall through.
  handler: () => focusBrowserUrl() || false,
});

keybindingsRuntime.register({
  id: 'browser.back',
  label: 'Browser back',
  defaultBindings: ['ctrl+['],
  handler: () => browserNavigateRelative('back') || false,
});

keybindingsRuntime.register({
  id: 'browser.forward',
  label: 'Browser forward',
  defaultBindings: ['ctrl+]'],
  handler: () => browserNavigateRelative('forward') || false,
});

keybindingsRuntime.register({
  id: 'browser.reload',
  label: 'Reload browser pane',
  defaultBindings: ['ctrl+r'],
  handler: () => reloadActiveBrowser() || false,
});

keybindingsRuntime.register({
  id: 'pane.terminal.clear',
  label: 'Clear active terminal pane',
  defaultBindings: ['ctrl+k'],
  shouldRun: () => !!panes.get(activePaneId),
  handler: () => { panes.get(activePaneId)?.terminal?.clear(); },
});

keybindingsRuntime.register({
  id: 'settings.open',
  label: 'Open settings',
  defaultBindings: ['ctrl+,'],
  handler: () => showSettingsPanel(),
});

const adjustFontSize = (delta) => {
  const pane = panes.get(activePaneId);
  if (!pane) return false;
  const current = pane.terminal.options.fontSize ?? 13;
  const ns = delta === 'reset'
    ? SETTINGS_DEFAULTS.fontSize
    : Math.max(8, Math.min(32, current + delta));
  for (const [id, p] of panes) { p.terminal.options.fontSize = ns; fitAndResizePane(id); }
  const sv = loadSettings(); sv.fontSize = ns; saveSettings(sv);
};
keybindingsRuntime.register({
  id: 'pane.font.increase',
  label: 'Increase terminal font size',
  // Legacy code required no-shift; user pressing Ctrl+= alone with no shift
  // is the only case that fires. Some layouts produce '+' unmodified — kept
  // as a defensive alias.
  defaultBindings: ['ctrl+=', 'ctrl++'],
  shouldRun: () => !!panes.get(activePaneId),
  handler: () => adjustFontSize(1),
});
keybindingsRuntime.register({
  id: 'pane.font.decrease',
  label: 'Decrease terminal font size',
  defaultBindings: ['ctrl+-', 'ctrl+_'],
  shouldRun: () => !!panes.get(activePaneId),
  handler: () => adjustFontSize(-1),
});
keybindingsRuntime.register({
  id: 'pane.font.reset',
  label: 'Reset terminal font size',
  defaultBindings: ['ctrl+0'],
  shouldRun: () => !!panes.get(activePaneId),
  handler: () => adjustFontSize('reset'),
});

keybindingsRuntime.register({
  id: 'workspace.new',
  label: 'New workspace',
  defaultBindings: ['ctrl+alt+n'],
  handler: () => createWorkspace(),
});

keybindingsRuntime.register({
  id: 'surface.focus.left',
  label: 'Focus pane to the left',
  defaultBindings: ['ctrl+alt+arrowleft'],
  handler: () => focusAdjacentSurface('left'),
});
keybindingsRuntime.register({
  id: 'surface.focus.right',
  label: 'Focus pane to the right',
  defaultBindings: ['ctrl+alt+arrowright'],
  handler: () => focusAdjacentSurface('right'),
});
keybindingsRuntime.register({
  id: 'surface.focus.up',
  label: 'Focus pane above',
  defaultBindings: ['ctrl+alt+arrowup'],
  handler: () => focusAdjacentSurface('up'),
});
keybindingsRuntime.register({
  id: 'surface.focus.down',
  label: 'Focus pane below',
  defaultBindings: ['ctrl+alt+arrowdown'],
  handler: () => focusAdjacentSurface('down'),
});

const switchWorkspaceBy = (delta) => {
  const ids = orderedWorkspaceIds();
  const i = ids.indexOf(activeWorkspaceId);
  const next = i + delta;
  if (next >= 0 && next < ids.length) switchWorkspace(ids[next]);
};
keybindingsRuntime.register({
  id: 'workspace.prev',
  label: 'Previous workspace',
  defaultBindings: ['ctrl+alt+[', 'ctrl+alt+{'],
  handler: () => switchWorkspaceBy(-1),
});
keybindingsRuntime.register({
  id: 'workspace.next',
  label: 'Next workspace',
  defaultBindings: ['ctrl+alt+]', 'ctrl+alt+}'],
  handler: () => switchWorkspaceBy(1),
});

// Workspace 1-9 by number — registered as individual commands so each is
// independently rebindable.
for (let n = 1; n <= 9; n += 1) {
  const idx = n - 1;
  keybindingsRuntime.register({
    id: `workspace.switch.${n}`,
    label: `Switch to workspace ${n}`,
    defaultBindings: [`ctrl+alt+${n}`],
    handler: () => {
      const ids = orderedWorkspaceIds();
      if (ids[idx]) switchWorkspace(ids[idx]);
    },
  });
}

document.addEventListener('keydown', (e) => keybindingsRuntime.dispatch(e));

// ── Keybindings persistence + hot-reload ────────────────────────────────
//
// `currentOverrides` is the live in-memory mirror of `keybindings.json`'s
// `bindings` map: { commandId -> chord[] }. The settings UI mutates it via
// setOverride/clearOverride/resetOverride; each mutation persists the full
// map back to disk and re-applies it to the runtime. The mtime poller below
// hot-reloads the file when an external editor changes it.
let currentOverrides = {};
let lastKnownKeybindingsMtime = null;
let _suppressNextMtimeReload = false;

async function loadAndApplyKeybindingOverrides({ silent = false } = {}) {
  try {
    const raw = await invoke('load_keybindings');
    if (!raw) {
      currentOverrides = {};
      keybindingsRuntime.restoreAllDefaults();
      return { applied: [], unknown: [], conflicts: [], empty: true };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn('[keybindings] keybindings.json is not valid JSON:', err);
      if (!silent) {
        showToast(`keybindings.json parse error: ${err?.message ?? err}`, 'warning');
      }
      return { error: 'parse', message: String(err?.message ?? err) };
    }
    const overrides = parsed && typeof parsed === 'object' ? parsed.bindings : null;
    if (!overrides || typeof overrides !== 'object') {
      console.warn('[keybindings] keybindings.json missing top-level "bindings" object');
      if (!silent) {
        showToast('keybindings.json missing "bindings" object — falling back to defaults', 'warning');
      }
      currentOverrides = {};
      keybindingsRuntime.restoreAllDefaults();
      return { error: 'shape' };
    }
    currentOverrides = { ...overrides };
    keybindingsRuntime.restoreAllDefaults();
    const result = keybindingsRuntime.applyOverrides(currentOverrides);
    if (result.unknown.length) console.warn('[keybindings] unknown command ids:', result.unknown);
    if (result.conflicts.length) console.warn('[keybindings] chord conflicts:', result.conflicts);
    if (result.applied.length) console.info(`[keybindings] applied ${result.applied.length} override(s):`, result.applied);
    document.dispatchEvent(new CustomEvent('wmux-keybindings-changed'));
    return result;
  } catch (err) {
    console.warn('[keybindings] failed to load keybindings.json:', err);
    return { error: 'io', message: String(err) };
  }
}

async function persistOverrides() {
  // Drop empty arrays that match a command being unbound? No — empty array
  // is a meaningful "unbind" directive. We DO drop keys whose value equals
  // the command's default chord set, to keep the file minimal.
  const minimal = {};
  for (const cmd of keybindingsRuntime.snapshot()) {
    if (!(cmd.id in currentOverrides)) continue;
    const overrideList = currentOverrides[cmd.id];
    const defaultsList = cmd.defaults;
    const sameAsDefault =
      Array.isArray(overrideList) &&
      overrideList.length === defaultsList.length &&
      overrideList.every((c, i) => c === defaultsList[i]);
    if (sameAsDefault) continue;
    minimal[cmd.id] = overrideList;
  }
  currentOverrides = minimal;
  const json = JSON.stringify({ version: 1, bindings: minimal }, null, 2) + '\n';
  _suppressNextMtimeReload = true;
  await invoke('save_keybindings', { bindingsJson: json });
  try {
    lastKnownKeybindingsMtime = await invoke('get_keybindings_mtime');
  } catch {
    /* ignore */
  }
}

async function setKeybindingOverride(commandId, chords) {
  const list = (Array.isArray(chords) ? chords : [chords])
    .map((c) => keybindingsRuntime.normalizeChord(c))
    .filter(Boolean);
  currentOverrides[commandId] = list;
  keybindingsRuntime.restoreAllDefaults();
  const result = keybindingsRuntime.applyOverrides(currentOverrides);
  await persistOverrides();
  return result;
}

async function resetKeybindingOverride(commandId) {
  delete currentOverrides[commandId];
  keybindingsRuntime.restoreAllDefaults();
  const result = keybindingsRuntime.applyOverrides(currentOverrides);
  await persistOverrides();
  return result;
}

async function resetAllKeybindings() {
  currentOverrides = {};
  keybindingsRuntime.restoreAllDefaults();
  await persistOverrides();
}

async function pollKeybindingsForChanges() {
  try {
    const mtime = await invoke('get_keybindings_mtime');
    if (mtime === lastKnownKeybindingsMtime) return;
    if (_suppressNextMtimeReload) {
      _suppressNextMtimeReload = false;
      lastKnownKeybindingsMtime = mtime;
      return;
    }
    lastKnownKeybindingsMtime = mtime;
    if (mtime != null) {
      console.info('[keybindings] external edit detected, reloading');
      const result = await loadAndApplyKeybindingOverrides();
      if (result && !result.error) {
        showToast('Keybindings reloaded from keybindings.json', 'info');
      }
    }
  } catch (err) {
    console.warn('[keybindings] mtime poll failed:', err);
  }
}

(async () => {
  try {
    const path = await invoke('get_keybindings_path');
    console.info(`[keybindings] config path: ${path}`);
  } catch (err) {
    console.warn('[keybindings] could not resolve config path:', err);
  }
  await loadAndApplyKeybindingOverrides({ silent: true });
  try {
    lastKnownKeybindingsMtime = await invoke('get_keybindings_mtime');
  } catch {
    /* ignore */
  }
  setInterval(pollKeybindingsForChanges, 2000);
})();

const keybindingsApi = {
  snapshot: () => keybindingsRuntime.snapshot(),
  normalizeChord: (s) => keybindingsRuntime.normalizeChord(s),
  chordFromEvent: (e) => keybindingsRuntime.chordFromEvent(e),
  getOverrides: () => ({ ...currentOverrides }),
  setOverride: setKeybindingOverride,
  clearOverride: (id) => setKeybindingOverride(id, []),
  resetOverride: resetKeybindingOverride,
  resetAll: resetAllKeybindings,
  reload: loadAndApplyKeybindingOverrides,
  reveal: () => invoke('reveal_keybindings_in_explorer'),
  initFile: () => invoke('init_keybindings_file_if_missing'),
  getPath: () => invoke('get_keybindings_path'),
};

window.__wmux = window.__wmux ?? {};
window.__wmux.reloadKeybindings = loadAndApplyKeybindingOverrides;
window.__wmux.snapshotKeybindings = () => keybindingsRuntime.snapshot();
window.__wmux.keybindings = keybindingsApi;

// Path B / OSR-via-screencast spike. Call from devtools:
//   const s = await window.__wmux.cefEmbed(document.body, 'https://example.com');
//   // s.canvas now shows the page; s.dispose() to kill the helper.
// A proper UI affordance (button next to the existing CEF button) comes
// once the pixel pipeline is proven to work visibly. This devtools handle
// is just for the v0 spike test.
window.__wmux.cefEmbed = createCefEmbeddedSurface;

// Boot

btnNewTab.addEventListener('click', () => createTab(getDefaultTarget()));
btnNewTabMore.addEventListener('click', showNewTabPopover);
updateNewTabTooltip();
document.getElementById('btn-agent-sidebar')?.addEventListener('click', () => agentSidebarRuntime?.toggle());
document.getElementById('btn-collab')?.addEventListener('click', () => collabRuntime?.togglePanel());
document.getElementById('btn-activity-log')?.addEventListener('click', () => activityLogRuntime?.toggle());
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
  void maybeAutoCheckForUpdates();
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
  openWorkbookPreview: (...args) => panelsRuntime?.openWorkbookPreview(...args),
  openWorkbookDemo: (...args) => panelsRuntime?.openWorkbookDemo(...args),
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
