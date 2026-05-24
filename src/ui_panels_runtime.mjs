import { buildWorkbookHtml } from './workbook_runtime.mjs';
import { makeDockable } from './panel_dock.mjs';

export function createUiPanelsRuntime({
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
  getActiveTabId,
  getActivePaneId,
  getActiveWorkspaceId,
  getNotifPanelTabId,
  setNotifPanelTabId,
  switchWorkspace,
  activateTab,
  activatePane,
  setTabRing,
  setPaneRing,
  openBrowserSplitForTab,
  splitPaneWithBrowser,
  listSessionVaultEntries,
  readSessionVaultEntry,
  captureSessionVaultEntry,
  openSessionVaultEntry,
  checkForAppUpdate,
  installAppUpdate,
  getAppVersion,
  getKeybindingsApi,
}) {
  const artifacts = [];
  let artifactPanelVisible = false;
  let sessionVaultPanelVisible = false;
  let sessionVaultEntries = [];
  let sessionVaultSelectedId = null;
  let sessionVaultSelectedEntry = null;
  let sessionVaultFilter = '';
  let sessionVaultLoading = false;
  let sessionVaultDetailLoading = false;
  let updatePromptVisible = false;

  function unreadNotificationCount(tabId) {
    return (notifications.get(tabId) ?? []).filter((item) => !item.read).length;
  }

  function showError(msg) {
    showToast(msg, 'error');
  }

  // App-level transient toast. Use for app-scoped status / error messages
  // that aren't tied to a tab or pane (use addNotification for those).
  function showToast(msg, severity = 'info') {
    const el = document.createElement('div');
    const palette = {
      error:   { bg: '#7f1d1d', fg: '#fecaca' },
      warning: { bg: '#78350f', fg: '#fed7aa' },
      info:    { bg: '#1e3a8a', fg: '#bfdbfe' },
      success: { bg: '#14532d', fg: '#bbf7d0' },
    };
    const { bg, fg } = palette[severity] ?? palette.info;
    el.style.cssText = `position:fixed;bottom:16px;right:16px;background:${bg};color:${fg};padding:10px 14px;border-radius:8px;font-size:12px;z-index:9999;max-width:340px;box-shadow:0 8px 24px rgba(0,0,0,0.4);`;
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  function showUpdatePrompt(updateInfo, { onInstall, onDismiss, onOpenSettings } = {}) {
    document.getElementById('update-prompt')?.remove();
    updatePromptVisible = true;
    const prompt = document.createElement('div');
    prompt.id = 'update-prompt';
    prompt.className = 'update-prompt';
    const body = String(updateInfo?.body ?? '').trim();
    prompt.innerHTML = `
      <div class="update-prompt-head">
        <div>
          <div class="update-prompt-kicker">Update available</div>
          <div class="update-prompt-title">wmux ${escHtml(updateInfo?.version ?? 'unknown')}</div>
        </div>
        <button class="update-prompt-close" title="Dismiss">✕</button>
      </div>
      <div class="update-prompt-body">${body ? escHtml(body) : 'A newer signed wmux release is available.'}</div>
      <div class="update-prompt-actions">
        <button class="settings-btn-sm" data-action="settings">Settings</button>
        <button class="settings-btn-sm" data-action="later">Later</button>
        <button class="settings-btn-sm update-prompt-install" data-action="install">Install update</button>
      </div>
    `;
    const cleanup = () => {
      prompt.remove();
      updatePromptVisible = false;
    };
    prompt.querySelector('[data-action="settings"]').addEventListener('click', () => {
      cleanup();
      onOpenSettings?.();
    });
    prompt.querySelector('[data-action="later"]').addEventListener('click', () => {
      cleanup();
      onDismiss?.();
    });
    prompt.querySelector('.update-prompt-close').addEventListener('click', () => {
      cleanup();
      onDismiss?.();
    });
    prompt.querySelector('[data-action="install"]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = 'Installing…';
      try {
        await onInstall?.();
      } catch {
        button.disabled = false;
        button.textContent = 'Install update';
        return;
      }
    });
    document.body.appendChild(prompt);
  }

  async function copyTextToClipboard(text) {
    const value = String(text ?? '');
    if (!value) return;
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('clipboard write not available');
  }

  function showUrlBanner(sessionId, tabId, url, isOauth) {
    const pane = panes.get(sessionId);
    if (!pane) return;
    const banner = document.createElement('div');
    banner.className = `url-banner${isOauth ? ' url-banner-oauth' : ''}`;
    const icon = isOauth ? '🔑' : '🔗';
    const label = isOauth ? 'OAuth redirect detected' : 'Local server';
    const short = url.length > 50 ? `${url.slice(0, 47)}...` : url;
    banner.innerHTML = `
      <span class="url-banner-icon">${icon}</span>
      <span class="url-banner-text">
        <strong>${label}</strong>
        <span class="url-banner-url" title="${url}">${short}</span>
      </span>
      <button class="url-banner-copy" data-url="${url}">Copy URL</button>
      <button class="url-banner-open" data-url="${url}">Open in browser</button>
      <button class="url-banner-close" title="Dismiss">x</button>
    `;
    banner.querySelector('.url-banner-copy').addEventListener('click', async () => {
      try { await copyTextToClipboard(url); } catch (err) { showError(`Could not copy URL: ${err}`); }
    });
    banner.querySelector('.url-banner-open').addEventListener('click', async () => {
      const btn = banner.querySelector('.url-banner-open');
      btn.disabled = true;
      btn.textContent = 'Opening…';
      try {
        const resolved = await invoke('resolve_localhost_url', { paneId: sessionId, url });
        await openBrowserSplitForTab(tabId, resolved);
        banner.remove();
      } catch (err) {
        showError(`Could not open URL: ${err}`);
        btn.disabled = false;
        btn.textContent = 'Open in browser';
      }
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
    const found = [];
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
      found.push({ html, kind, title: artifactTitleFromHtml(html, kind) });
    };
    for (const match of output.matchAll(/```(?:\s*(html|svg|xml|xhtml))?\s*([\s\S]*?)```/gi)) pushCandidate(match[2], (match[1] ?? 'html').toLowerCase());
    for (const match of output.matchAll(/<!doctype html[\s\S]*?<\/html>/gi)) pushCandidate(match[0], 'document');
    for (const match of output.matchAll(/<html[\s\S]*?<\/html>/gi)) pushCandidate(match[0], 'document');
    for (const match of output.matchAll(/<body[\s\S]*?<\/body>/gi)) pushCandidate(match[0], 'body');
    for (const match of output.matchAll(/<svg[\s\S]*?<\/svg>/gi)) pushCandidate(match[0], 'svg');
    return found;
  }

  async function openArtifactPreview(artifactId) {
    const artifact = artifacts.find((item) => item.id === artifactId);
    if (!artifact) return;
    const sourcePane = artifact.paneId ? panes.get(artifact.paneId) : null;
    const targetTabId = tabs.has(artifact.tabId) ? artifact.tabId : getActiveTabId();
    if (sourcePane?.tabId && tabs.get(sourcePane.tabId)?.workspaceId !== getActiveWorkspaceId()) {
      switchWorkspace(tabs.get(sourcePane.tabId).workspaceId);
    } else if (targetTabId && tabs.get(targetTabId)?.workspaceId !== getActiveWorkspaceId()) {
      switchWorkspace(tabs.get(targetTabId).workspaceId);
    }
    toggleArtifactPanel(false);
    if (sourcePane) {
      activateTab(sourcePane.tabId);
      activatePane(sourcePane.sessionId);
      await splitPaneWithBrowser(sourcePane.sessionId, 'h', { url: artifact.previewUrl });
      setTimeout(() => activatePane(sourcePane.sessionId), 100);
      return;
    }
    if (targetTabId && tabs.has(targetTabId)) {
      activateTab(targetTabId);
      await openBrowserSplitForTab(targetTabId, artifact.previewUrl);
      return;
    }
    await createTab(getDefaultTarget());
    if (getActiveTabId()) await openBrowserSplitForTab(getActiveTabId(), artifact.previewUrl);
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
          <button class="artifact-btn" data-action="workbook-demo">Workbook demo</button>
          <button class="artifact-btn" data-action="clear">Clear</button>
          <button class="artifact-close" title="Close">✕</button>
        </div>
      </div>
      <div class="artifact-list">
        ${artifacts.length === 0 ? '<div class="artifact-empty">No captured artifacts</div>' : artifacts.map((item) => `
          <div class="artifact-item" data-id="${item.id}">
            <div class="artifact-top">
              <div class="artifact-title">${escHtml(item.title)}</div>
              <span class="artifact-kind" data-kind="${escHtml(item.kind)}">${escHtml(item.kind)}</span>
            </div>
            <div class="artifact-meta">${escHtml(item.sourceLabel)} · ${new Date(item.time).toLocaleTimeString()}</div>
            <button class="artifact-open">Open</button>
          </div>`).join('')}
      </div>
    `;
    panel.querySelector('[data-action="capture"]').addEventListener('click', () => previewArtifactFromPane());
    panel.querySelector('[data-action="workbook-demo"]').addEventListener('click', () => openWorkbookDemo().catch((err) => showError(`Could not open workbook: ${err}`)));
    panel.querySelector('[data-action="clear"]').addEventListener('click', () => {
      artifacts.length = 0;
      renderArtifactPanel();
    });
    panel.querySelector('.artifact-close').addEventListener('click', () => toggleArtifactPanel(false));
    panel.querySelectorAll('.artifact-item, .artifact-open').forEach((el) => {
      el.addEventListener('click', async (event) => {
        const itemEl = event.currentTarget.closest('.artifact-item');
        if (!itemEl) return;
        await openArtifactPreview(itemEl.dataset.id);
      });
    });
    makeDockable(panel, panel.querySelector('.artifact-header'), 'artifacts');
  }

  async function previewArtifactFromPane(paneId = getActivePaneId()) {
    const pane = panes.get(paneId);
    if (!pane) {
      showError('No active terminal pane to preview');
      return;
    }
    try {
      const output = await invoke('capture_session_output_by_id', { id: paneId });
      const matches = extractHtmlArtifacts(output ?? '');
      if (matches.length === 0) {
        showError('No artifact found in recent pane output');
        return;
      }
      const tab = tabs.get(pane.tabId);
      let firstId = null;
      for (const match of matches) {
        const existing = artifacts.find((item) => item.paneId === paneId && item.html === match.html);
        const previewUrl = await invoke('save_artifact_preview', { html: match.html });
        if (existing) {
          existing.previewUrl = previewUrl;
          existing.time = Date.now();
          existing.title = match.title;
          existing.kind = match.kind;
          if (!firstId) firstId = existing.id;
          continue;
        }
        const id = crypto.randomUUID();
        if (!firstId) firstId = id;
        artifacts.unshift({
          id,
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
      if (firstId) await openArtifactPreview(firstId);
    } catch (err) {
      showError(`Could not preview artifact: ${err}`);
    }
  }

  async function openWorkbookPreview(spec = {}, { openInBrowser = true } = {}) {
    const previewHtml = buildWorkbookHtml(spec);
    const previewUrl = await invoke('save_artifact_preview', { html: previewHtml });
    const artifactId = crypto.randomUUID();
    const artifact = {
      id: artifactId,
      paneId: spec.paneId ?? null,
      tabId: tabs.has(getActiveTabId()) ? getActiveTabId() : null,
      tabTitle: spec.tabTitle ?? tabs.get(getActiveTabId())?.title ?? 'Tab',
      sourceLabel: spec.sourceLabel ?? 'Workbook',
      title: String(spec.title ?? 'Workbook'),
      kind: 'workbook',
      html: previewHtml,
      previewUrl,
      time: Date.now(),
    };
    artifacts.unshift(artifact);
    if (artifacts.length > 50) artifacts.length = 50;
    if (openInBrowser) await openArtifactPreview(artifactId);
    return {
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      previewUrl: artifact.previewUrl,
      tabId: artifact.tabId,
    };
  }

  async function openWorkbookDemo(options = {}) {
    return openWorkbookPreview({ title: 'New Workbook' }, options);
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
    if (getNotifPanelTabId() === tabId) renderNotifPanel(tabId);
  }

  function getTabPortSummary(tab) {
    if (!tab?.ports?.size) return '';
    const ports = [...tab.ports].slice(0, 3);
    const summary = ports.map((port) => `:${port}`).join(' ');
    return tab.ports.size > 3 ? `${summary} +${tab.ports.size - 3}` : summary;
  }

  function tabTargetBadgeText(tab) {
    switch (tab?.targetKind) {
      case 'remote_tmux':
        return 'TMUX';
      case 'ssh':
        return 'SSH';
      case 'wsl':
        return 'WSL';
      default:
        return 'LOCAL';
    }
  }

  function updateTabMeta(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const targetEl = tab.tabEl.querySelector('.tab-target');
    if (targetEl) {
      targetEl.textContent = tabTargetBadgeText(tab);
      targetEl.dataset.kind = tab.targetKind ?? 'local';
      targetEl.dataset.status = tab.connectionStatus ?? 'unknown';
      if (tab.targetKind === 'remote_tmux') {
        const details = [tab.targetLabel];
        details.push(`status: ${tab.connectionStatus ?? 'unknown'}`);
        if (tab.remoteTmuxSessionName) details.push(`session: ${tab.remoteTmuxSessionName}`);
        if (tab.remoteTmuxWindowName) details.push(`window: ${tab.remoteTmuxWindowName}`);
        if (tab.cwd) details.push(tab.cwd);
        if (tab.gitBranch) details.push(`branch: ${tab.gitBranch}`);
        if (tab.remoteProbeError) details.push(`error: ${tab.remoteProbeError}`);
        targetEl.title = details.filter(Boolean).join('\n');
      } else {
        targetEl.title = tab.targetLabel ?? '';
      }
    }
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
    const port = (() => { const m = String(url ?? '').match(/^https?:\/\/[\w.-]+:(\d+)(?:\/|$)/i); return m ? Number(m[1]) : null; })();
    if (!port) return;
    tab.ports.add(port);
    updateTabMeta(tabId);
  }

  function clearPaneNotifications(tabId, paneId) {
    const list = notifications.get(tabId);
    if (!list) return;
    const before = list.length;
    notifications.set(tabId, list.filter((n) => n.paneId !== paneId));
    const after = notifications.get(tabId).length;
    if (after !== before) {
      if (after === 0) {
        const tab = tabs.get(tabId);
        if (tab) setTabRing(tab, false);
      }
      updateTabMeta(tabId);
      if (getNotifPanelTabId() === tabId) renderNotifPanel(tabId);
    }
  }

  function addNotification(tabId, notif) {
    if (!notifications.has(tabId)) notifications.set(tabId, []);
    const list = notifications.get(tabId);
    const isActive = getActiveTabId() === tabId && getActivePaneId() === notif.paneId;
    list.unshift({ id: crypto.randomUUID(), title: notif.title, body: notif.body, time: notif.time, paneId: notif.paneId, read: isActive });
    if (list.length > 100) list.pop();
    const tab = tabs.get(tabId);
    if (tab && !isActive) setTabRing(tab, true);
    if (!isActive && notif.paneId) setPaneRing(notif.paneId, true);
    updateTabMeta(tabId);
    if (getNotifPanelTabId() === tabId) renderNotifPanel(tabId);
  }

  function toggleNotifPanel() {
    if (document.getElementById('notif-panel')) {
      document.getElementById('notif-panel').remove();
      setNotifPanelTabId(null);
      return;
    }
    if (!getActiveTabId()) return;
    setNotifPanelTabId(getActiveTabId());
    renderNotifPanel(getActiveTabId());
  }

  function renderNotifPanel(tabId) {
    document.getElementById('notif-panel')?.remove();
    const list = notifications.get(tabId) ?? [];
    const tab = tabs.get(tabId);
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
        ${list.length === 0 ? '<div class="notif-empty">No notifications</div>' : list.map((n) => `
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
      setNotifPanelTabId(null);
    });
    panel.querySelectorAll('.notif-item').forEach((el) => {
      el.addEventListener('click', () => {
        const item = list.find((n) => n.id === el.dataset.id);
        if (!item) return;
        item.read = true;
        if (tab) {
          if (getActiveWorkspaceId() !== tab.workspaceId) switchWorkspace(tab.workspaceId);
          activateTab(tabId);
        }
        if (item.paneId && panes.has(item.paneId)) activatePane(item.paneId);
        renderNotifPanel(tabId);
      });
    });
    tab?.tabEl.classList.remove('has-notif');
    updateTabMeta(tabId);
    makeDockable(panel, panel.querySelector('.notif-header'), 'notif');
  }

  function showHistoryPicker() {
    document.getElementById('history-picker')?.remove();
    const pane = panes.get(getActivePaneId());
    if (!pane || pane.history.length === 0) return;
    const picker = document.createElement('div');
    picker.id = 'history-picker';
    picker.className = 'history-picker';
    const buildItems = (filter = '') => {
      const items = [...pane.history].reverse().filter((h) => !filter || h.toLowerCase().includes(filter.toLowerCase()));
      return items.length ? items.map((cmd) => `<div class="hist-item" data-cmd="${escHtml(cmd)}">${escHtml(cmd)}</div>`).join('') : '<div class="hist-empty">No matches</div>';
    };
    picker.innerHTML = `
      <input class="hist-search" placeholder="Filter history…" />
      <div class="hist-list">${buildItems()}</div>
      <div class="hist-hint">Click to insert · Double-click to run</div>
    `;
    const listEl = picker.querySelector('.hist-list');
    const searchEl = picker.querySelector('.hist-search');
    const attach = () => {
      listEl.querySelectorAll('.hist-item').forEach((el) => {
        el.addEventListener('click', () => {
          invoke('write_to_session', { id: getActivePaneId(), data: el.dataset.cmd });
          picker.remove();
          pane.terminal.focus();
        });
        el.addEventListener('dblclick', () => {
          invoke('write_to_session', { id: getActivePaneId(), data: `${el.dataset.cmd}\r` });
          picker.remove();
          pane.terminal.focus();
        });
      });
    };
    searchEl.addEventListener('input', () => {
      listEl.innerHTML = buildItems(searchEl.value);
      attach();
    });
    picker.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        picker.remove();
        pane.terminal.focus();
      }
    });
    attach();
    pane.domEl.appendChild(picker);
    searchEl.focus();
  }

  function showFindBar() {
    document.getElementById('find-bar')?.remove();
    const pane = panes.get(getActivePaneId());
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
      const options = { decorations: { matchBackground: '#7c6af740', matchBorder: '#7c6af7', matchOverviewRuler: '#7c6af7' } };
      if (fwd) pane.searchAddon.findNext(q, options);
      else pane.searchAddon.findPrevious(q, options);
    };
    input.addEventListener('input', () => doFind(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); doFind(!event.shiftKey); }
      if (event.key === 'Escape') { bar.remove(); pane.terminal.focus(); }
    });
    bar.querySelector('#find-prev').addEventListener('click', () => doFind(false));
    bar.querySelector('#find-next').addEventListener('click', () => doFind(true));
    bar.querySelector('.find-close').addEventListener('click', () => { bar.remove(); pane.terminal.focus(); });
    document.getElementById('content').appendChild(bar);
    input.focus();
  }

  function filteredSessionVaultEntries() {
    const needle = sessionVaultFilter.trim().toLowerCase();
    if (!needle) return sessionVaultEntries;
    return sessionVaultEntries.filter((entry) => [
      entry.workspace_name,
      entry.tab_title,
      entry.pane_title,
      entry.pane_detail,
      entry.target_label,
      entry.cwd,
      entry.reason,
    ].some((value) => String(value ?? '').toLowerCase().includes(needle)));
  }

  function sessionVaultPreviewText(entry) {
    const transcript = String(entry?.transcript ?? '');
    return transcript.length > 20_000
      ? `[preview clipped to last 20,000 chars]\n\n${transcript.slice(transcript.length - 20_000)}`
      : transcript;
  }

  function renderSessionVaultPanel() {
    const existing = document.getElementById('session-vault-panel');
    if (existing) {
      existing.remove();
    }
    if (!sessionVaultPanelVisible) return;

    const visibleEntries = filteredSessionVaultEntries();
    const selectedEntry = sessionVaultSelectedEntry && sessionVaultSelectedEntry.id === sessionVaultSelectedId
      ? sessionVaultSelectedEntry
      : null;
    const panel = document.createElement('div');
    panel.id = 'session-vault-panel';
    panel.className = 'session-vault-panel';
    panel.innerHTML = `
      <div class="session-vault-header">
        <div>
          <div class="session-vault-title">Session Vault</div>
          <div class="session-vault-subtitle">Saved terminal transcripts outside the layout snapshot</div>
        </div>
        <div class="session-vault-actions">
          <button class="session-vault-btn" data-action="capture">Capture current</button>
          <button class="session-vault-btn" data-action="refresh">Refresh</button>
          <button class="session-vault-close" data-action="close" title="Close">x</button>
        </div>
      </div>
      <div class="session-vault-toolbar">
        <input class="session-vault-filter" placeholder="Filter by workspace, pane, path..." value="${escHtml(sessionVaultFilter)}" />
      </div>
      <div class="session-vault-body">
        <div class="session-vault-list">
          ${sessionVaultLoading
            ? '<div class="session-vault-empty">Loading transcripts...</div>'
            : visibleEntries.length === 0
              ? '<div class="session-vault-empty">No saved transcripts</div>'
              : visibleEntries.map((entry) => `
                <button class="session-vault-item${entry.id === sessionVaultSelectedId ? ' is-selected' : ''}" data-id="${entry.id}">
                  <div class="session-vault-item-top">
                    <span class="session-vault-item-title">${escHtml(entry.pane_title || entry.tab_title || 'Terminal')}</span>
                    <span class="session-vault-item-time">${new Date(entry.saved_at).toLocaleString()}</span>
                  </div>
                  <div class="session-vault-item-meta">${escHtml(entry.workspace_name || 'Workspace')} · ${escHtml(entry.target_label || entry.target_kind || 'terminal')}</div>
                  <div class="session-vault-item-meta">${escHtml(entry.cwd || entry.reason || '')}</div>
                </button>`).join('')}
        </div>
        <div class="session-vault-preview">
          ${sessionVaultDetailLoading
            ? '<div class="session-vault-empty">Loading preview...</div>'
            : selectedEntry
              ? `
                <div class="session-vault-preview-head">
                  <div>
                    <div class="session-vault-preview-title">${escHtml(selectedEntry.pane_title || selectedEntry.tab_title || 'Terminal')}</div>
                    <div class="session-vault-preview-meta">${escHtml([selectedEntry.workspace_name, selectedEntry.tab_title, selectedEntry.target_label].filter(Boolean).join(' · '))}</div>
                    <div class="session-vault-preview-meta">${escHtml([selectedEntry.cwd, selectedEntry.pane_detail, `${selectedEntry.transcript_chars} chars`, selectedEntry.reason].filter(Boolean).join(' · '))}</div>
                  </div>
                  <button class="session-vault-open" data-action="open" ${sessionVaultSelectedId ? '' : 'disabled'}>Open</button>
                </div>
                <pre class="session-vault-transcript">${escHtml(sessionVaultPreviewText(selectedEntry))}</pre>
              `
              : '<div class="session-vault-empty">Select a transcript to preview it</div>'}
        </div>
      </div>
    `;

    panel.querySelector('[data-action="close"]').addEventListener('click', () => {
      sessionVaultPanelVisible = false;
      renderSessionVaultPanel();
    });
    panel.querySelector('[data-action="refresh"]').addEventListener('click', async () => {
      await refreshSessionVaultPanel();
    });
    panel.querySelector('[data-action="capture"]').addEventListener('click', async () => {
      const saved = await captureSessionVaultEntry(getActivePaneId(), { force: true, reason: 'manual' });
      await refreshSessionVaultPanel({ selectedId: saved?.id ?? sessionVaultSelectedId });
    });
    panel.querySelector('.session-vault-filter').addEventListener('input', (event) => {
      sessionVaultFilter = event.target.value;
      renderSessionVaultPanel();
    });
    panel.querySelectorAll('.session-vault-item').forEach((el) => {
      el.addEventListener('click', async () => {
        await loadSessionVaultEntry(el.dataset.id);
      });
    });
    panel.querySelector('[data-action="open"]')?.addEventListener('click', async () => {
      if (!sessionVaultSelectedId) return;
      await openSessionVaultEntry(sessionVaultSelectedId);
    });

    makeDockable(panel, panel.querySelector('.session-vault-header'), 'session-vault');
  }

  async function loadSessionVaultEntry(entryId) {
    if (!entryId) return null;
    sessionVaultSelectedId = entryId;
    sessionVaultDetailLoading = true;
    renderSessionVaultPanel();
    try {
      sessionVaultSelectedEntry = await readSessionVaultEntry(entryId);
      return sessionVaultSelectedEntry;
    } catch (err) {
      sessionVaultSelectedEntry = null;
      showError(`Could not load transcript: ${err}`);
      return null;
    } finally {
      sessionVaultDetailLoading = false;
      renderSessionVaultPanel();
    }
  }

  async function refreshSessionVaultPanel({ selectedId = sessionVaultSelectedId } = {}) {
    sessionVaultLoading = true;
    renderSessionVaultPanel();
    try {
      sessionVaultEntries = await listSessionVaultEntries();
      sessionVaultSelectedId = selectedId && sessionVaultEntries.some((entry) => entry.id === selectedId)
        ? selectedId
        : sessionVaultEntries[0]?.id ?? null;
      if (sessionVaultSelectedId) {
        await loadSessionVaultEntry(sessionVaultSelectedId);
        return sessionVaultEntries;
      }
      sessionVaultSelectedEntry = null;
      return sessionVaultEntries;
    } catch (err) {
      sessionVaultEntries = [];
      sessionVaultSelectedId = null;
      sessionVaultSelectedEntry = null;
      showError(`Could not load session vault: ${err}`);
      return [];
    } finally {
      sessionVaultLoading = false;
      renderSessionVaultPanel();
    }
  }

  async function toggleSessionVaultPanel(force) {
    sessionVaultPanelVisible = typeof force === 'boolean' ? force : !sessionVaultPanelVisible;
    if (!sessionVaultPanelVisible) {
      renderSessionVaultPanel();
      return false;
    }
    await refreshSessionVaultPanel();
    return true;
  }

  function showSettingsPanel() {
    document.getElementById('settings-panel')?.remove();
    const s = loadSettings();
    const panel = document.createElement('div');
    panel.id = 'settings-panel';
    panel.className = 'settings-panel';
    panel.innerHTML = `
      <div class="settings-header"><span>Settings</span><div class="settings-header-actions"><button class="settings-close" title="Close">&#x2715;</button></div></div>
      <div class="settings-body">
        <div class="settings-group">
          <div class="settings-group-label">Terminal</div>
          <label class="settings-row"><span class="settings-label">Font size</span><div class="settings-stepper"><button class="stepper-btn" id="sp-font-dec">-</button><span class="stepper-val" id="sp-font-val">${s.fontSize}</span><button class="stepper-btn" id="sp-font-inc">+</button></div></label>
          <label class="settings-row"><span class="settings-label">Font family</span><input class="settings-input" id="sp-font-family" type="text" value="${s.fontFamily.trim()}" spellcheck="false" /></label>
          <label class="settings-row"><span class="settings-label">Line height</span><input class="settings-input settings-input-sm" id="sp-line-height" type="number" min="1" max="3" step="0.05" value="${s.lineHeight}" /></label>
          <label class="settings-row"><span class="settings-label">Scrollback lines</span><input class="settings-input settings-input-sm" id="sp-scrollback" type="number" min="100" max="100000" step="100" value="${s.scrollback}" /></label>
          <label class="settings-row"><span class="settings-label">Cursor style</span><select class="settings-select" id="sp-cursor-style"><option value="bar" ${s.cursorStyle === 'bar' ? 'selected' : ''}>Bar</option><option value="block" ${s.cursorStyle === 'block' ? 'selected' : ''}>Block</option><option value="underline" ${s.cursorStyle === 'underline' ? 'selected' : ''}>Underline</option></select></label>
          <label class="settings-row"><span class="settings-label">Cursor blink</span><input class="settings-checkbox" id="sp-cursor-blink" type="checkbox" ${s.cursorBlink ? 'checked' : ''} /></label>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Updates</div>
          <label class="settings-row"><span class="settings-label">Current version</span><span class="settings-static" id="sp-update-current">Loading…</span></label>
          <label class="settings-row"><span class="settings-label">Automatic checks</span><input class="settings-checkbox" id="sp-update-auto" type="checkbox" ${s.autoCheckUpdates ? 'checked' : ''} /></label>
          <label class="settings-row settings-row-stack"><span class="settings-label">Manifest URL</span><input class="settings-input" id="sp-update-endpoint" type="text" value="${escHtml(s.updateManifestUrl ?? '')}" spellcheck="false" placeholder="https://github.com/OWNER/REPO/releases/latest/download/latest.json" /></label>
          <label class="settings-row settings-row-stack"><span class="settings-label">Public key</span><textarea class="settings-textarea" id="sp-update-pubkey" spellcheck="false" placeholder="Paste the Tauri updater public key here">${escHtml(s.updatePubkey ?? '')}</textarea></label>
          <div class="settings-help">wmux checks a signed Tauri release manifest. For GitHub Releases, point this at a published <code>latest.json</code> and paste the matching public key.</div>
          <div class="settings-update-actions">
            <button class="settings-btn-sm" id="sp-check-updates">Check now</button>
            <button class="settings-btn-sm" id="sp-install-update" disabled>Install available update</button>
          </div>
          <div class="settings-update-status" id="sp-update-status">No update check has been run in this session.</div>
          <div class="settings-update-notes" id="sp-update-notes"></div>
        </div>
        <div class="settings-group">
          <div class="settings-group-label">Keybindings</div>
          <div class="settings-keybindings-toolbar">
            <input class="settings-input settings-keybindings-filter" id="sp-kb-filter" type="search" placeholder="Filter commands…" spellcheck="false" />
            <button class="settings-btn-sm" id="sp-kb-edit-json">Edit JSON</button>
            <button class="settings-btn-sm" id="sp-kb-reset-all">Reset all</button>
          </div>
          <div class="settings-keybindings-list" id="sp-kb-list"></div>
          <div class="settings-help">Click a chord to rebind. Press <code>Esc</code> to cancel, <code>Backspace</code> to clear. Changes save to <code>keybindings.json</code> immediately.</div>
        </div>
        <div class="settings-group"><div class="settings-group-label">Window</div><div class="settings-row"><span class="settings-label">New window</span><button class="settings-btn-sm" id="sp-new-window">Open</button></div></div>
        <div class="settings-footer"><button class="settings-btn-apply" id="sp-apply">Apply</button><button class="settings-btn-reset" id="sp-reset">Reset to defaults</button></div>
      </div>
    `;
    const draft = { ...s };
    const fontValEl = panel.querySelector('#sp-font-val');
    const currentVersionEl = panel.querySelector('#sp-update-current');
    const endpointEl = panel.querySelector('#sp-update-endpoint');
    const pubkeyEl = panel.querySelector('#sp-update-pubkey');
    const autoUpdateEl = panel.querySelector('#sp-update-auto');
    const checkBtn = panel.querySelector('#sp-check-updates');
    const installBtn = panel.querySelector('#sp-install-update');
    const statusEl = panel.querySelector('#sp-update-status');
    const notesEl = panel.querySelector('#sp-update-notes');
    let latestUpdateResult = null;

    const setUpdateBusy = (busy) => {
      checkBtn.disabled = busy;
      installBtn.disabled = busy || !latestUpdateResult?.available;
    };

    const syncDraftFromPanel = () => {
      draft.fontFamily = panel.querySelector('#sp-font-family').value.trim() || s.fontFamily;
      draft.lineHeight = parseFloat(panel.querySelector('#sp-line-height').value) || s.lineHeight;
      draft.scrollback = parseInt(panel.querySelector('#sp-scrollback').value, 10) || s.scrollback;
      draft.cursorStyle = panel.querySelector('#sp-cursor-style').value;
      draft.cursorBlink = panel.querySelector('#sp-cursor-blink').checked;
      draft.updateManifestUrl = endpointEl.value.trim();
      draft.updatePubkey = pubkeyEl.value.trim();
      draft.autoCheckUpdates = autoUpdateEl.checked;
      return draft;
    };

    const renderUpdateResult = (result) => {
      latestUpdateResult = result;
      installBtn.disabled = !result?.available;
      if (!result) {
        statusEl.textContent = 'No update check has been run in this session.';
        notesEl.innerHTML = '';
        return;
      }
      if (!result.available) {
        statusEl.textContent = `wmux ${result.currentVersion} is already current.`;
        notesEl.innerHTML = '';
        return;
      }
      const dateBits = result.date ? ` · published ${escHtml(result.date)}` : '';
      statusEl.innerHTML = `Update available: <strong>${escHtml(result.version ?? 'unknown')}</strong>${dateBits}`;
      const body = String(result.body ?? '').trim();
      notesEl.innerHTML = body
        ? `<div class="settings-update-notes-title">Release notes</div><pre>${escHtml(body)}</pre>`
        : '';
    };

    getAppVersion()
      .then((version) => {
        currentVersionEl.textContent = version;
      })
      .catch(() => {
        currentVersionEl.textContent = 'Unavailable';
      });

    panel.querySelector('#sp-font-dec').addEventListener('click', () => { draft.fontSize = Math.max(8, (draft.fontSize ?? 13) - 1); fontValEl.textContent = draft.fontSize; });
    panel.querySelector('#sp-font-inc').addEventListener('click', () => { draft.fontSize = Math.min(32, (draft.fontSize ?? 13) + 1); fontValEl.textContent = draft.fontSize; });
    panel.querySelector('#sp-apply').addEventListener('click', () => {
      syncDraftFromPanel();
      saveSettings(draft);
      applySettingsToAllPanes(draft);
      panel.remove();
    });
    panel.querySelector('#sp-reset').addEventListener('click', () => { saveSettings({ ...SETTINGS_DEFAULTS }); applySettingsToAllPanes(SETTINGS_DEFAULTS); panel.remove(); });
    panel.querySelector('#sp-new-window').addEventListener('click', async () => {
      panel.remove();
      try { await invoke('create_app_window'); } catch (err) { showError(`Could not open window: ${err}`); }
    });
    checkBtn.addEventListener('click', async () => {
      syncDraftFromPanel();
      saveSettings(draft);
      renderUpdateResult(null);
      statusEl.textContent = 'Checking for updates…';
      setUpdateBusy(true);
      try {
        const result = await checkForAppUpdate({
          endpoint: draft.updateManifestUrl,
          pubkey: draft.updatePubkey,
        });
        renderUpdateResult(result);
      } catch (err) {
        latestUpdateResult = null;
        installBtn.disabled = true;
        notesEl.innerHTML = '';
        statusEl.textContent = `Update check failed: ${err}`;
      } finally {
        setUpdateBusy(false);
      }
    });
    installBtn.addEventListener('click', async () => {
      syncDraftFromPanel();
      saveSettings(draft);
      statusEl.textContent = 'Installing update… wmux will exit on Windows when the installer takes over.';
      setUpdateBusy(true);
      try {
        await installAppUpdate({
          endpoint: draft.updateManifestUrl,
          pubkey: draft.updatePubkey,
        });
        statusEl.textContent = 'Update installed. Restart wmux if it does not relaunch automatically.';
      } catch (err) {
        statusEl.textContent = `Update install failed: ${err}`;
        setUpdateBusy(false);
      }
    });
    // ── Keybindings list ────────────────────────────────────────────────
    const kbApi = getKeybindingsApi?.();
    const kbListEl = panel.querySelector('#sp-kb-list');
    const kbFilterEl = panel.querySelector('#sp-kb-filter');
    let kbCaptureRow = null; // currently-capturing row (only one at a time)

    function renderKbList() {
      if (!kbApi || !kbListEl) return;
      const filter = (kbFilterEl?.value ?? '').toLowerCase();
      const rows = kbApi.snapshot()
        .filter((cmd) => {
          if (!filter) return true;
          return cmd.id.toLowerCase().includes(filter) || cmd.label.toLowerCase().includes(filter);
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      kbListEl.innerHTML = rows.map((cmd) => {
        const isOverridden = !arrayShallowEqual(cmd.bindings, cmd.defaults);
        const chordHtml = cmd.bindings.length
          ? cmd.bindings.map((c) => `<kbd class="settings-kbd">${escHtml(c)}</kbd>`).join(' ')
          : '<span class="settings-kb-empty">(unbound)</span>';
        return `
          <div class="settings-kb-row${isOverridden ? ' settings-kb-row-overridden' : ''}" data-cmd-id="${escHtml(cmd.id)}">
            <div class="settings-kb-info">
              <div class="settings-kb-label">${escHtml(cmd.label)}</div>
              <div class="settings-kb-id">${escHtml(cmd.id)}</div>
            </div>
            <button class="settings-kb-chord" data-action="capture" title="Click to rebind">${chordHtml}</button>
            <button class="settings-kb-btn" data-action="reset" title="Restore default">↺</button>
          </div>
        `;
      }).join('');
    }

    function arrayShallowEqual(a, b) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      return a.every((v, i) => v === b[i]);
    }

    function exitCapture() {
      if (!kbCaptureRow) return;
      kbCaptureRow = null;
      document.removeEventListener('keydown', onCaptureKeyDown, true);
      renderKbList();
    }

    async function onCaptureKeyDown(event) {
      if (!kbCaptureRow) return;
      // Modifier-only presses while waiting are ignored (e.g. user holding
      // Ctrl before pressing the second key).
      const key = event.key;
      if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') return;
      event.preventDefault();
      event.stopPropagation();
      const commandId = kbCaptureRow.dataset.cmdId;
      if (key === 'Escape') { exitCapture(); return; }
      if (key === 'Backspace') {
        await kbApi.clearOverride(commandId);
        exitCapture();
        return;
      }
      const chord = kbApi.chordFromEvent(event);
      if (!chord) { exitCapture(); return; }
      // Conflict check: if another command currently owns this chord, refuse
      // and tell the user where it's bound. They can clear that command's
      // chord first and try again. (Auto-stealing would be too magical.)
      const snap = kbApi.snapshot();
      const owner = snap.find((c) => c.id !== commandId && c.bindings.includes(chord));
      if (owner) {
        showToast(`"${chord}" is already bound to "${owner.label}". Clear that binding first.`, 'warning');
        exitCapture();
        return;
      }
      try {
        await kbApi.setOverride(commandId, [chord]);
        showToast(`Bound "${chord}" → ${kbCaptureRow ? kbCaptureRow.querySelector('.settings-kb-label')?.textContent : commandId}`, 'success');
      } catch (err) {
        showError(`Could not save keybinding: ${err}`);
      }
      exitCapture();
    }

    if (kbApi && kbListEl) {
      renderKbList();
      kbFilterEl?.addEventListener('input', renderKbList);
      kbListEl.addEventListener('click', async (event) => {
        const btn = event.target.closest('[data-action]');
        if (!btn) return;
        const row = btn.closest('.settings-kb-row');
        const commandId = row?.dataset.cmdId;
        if (!commandId) return;
        const action = btn.dataset.action;
        if (action === 'capture') {
          if (kbCaptureRow === row) { exitCapture(); return; }
          if (kbCaptureRow) exitCapture();
          kbCaptureRow = row;
          row.classList.add('settings-kb-row-capturing');
          btn.innerHTML = '<span class="settings-kb-capturing">Press key combo… (Esc cancel, Backspace clear)</span>';
          document.addEventListener('keydown', onCaptureKeyDown, true);
        } else if (action === 'reset') {
          try {
            await kbApi.resetOverride(commandId);
            renderKbList();
          } catch (err) {
            showError(`Could not reset keybinding: ${err}`);
          }
        }
      });
      panel.querySelector('#sp-kb-reset-all')?.addEventListener('click', async () => {
        if (!confirm('Reset every keybinding to its default? This clears keybindings.json.')) return;
        try {
          await kbApi.resetAll();
          renderKbList();
        } catch (err) {
          showError(`Could not reset keybindings: ${err}`);
        }
      });
      panel.querySelector('#sp-kb-edit-json')?.addEventListener('click', async () => {
        try {
          await kbApi.initFile();
          await kbApi.reveal();
        } catch (err) {
          showError(`Could not open keybindings.json: ${err}`);
        }
      });
      // Re-render when the runtime reports an external file change.
      const onExternalChange = () => renderKbList();
      document.addEventListener('wmux-keybindings-changed', onExternalChange);
      // Make sure document listeners + capture mode are torn down when the
      // panel goes away (close button, click-outside, reset, escape, etc).
      const origRemove = panel.remove.bind(panel);
      panel.remove = () => {
        exitCapture();
        document.removeEventListener('wmux-keybindings-changed', onExternalChange);
        origRemove();
      };
    }

    panel.querySelector('.settings-close').addEventListener('click', () => panel.remove());
    panel.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !kbCaptureRow) panel.remove(); });
    // Settings is a transient modal — no dock, no drag. Docking made the
    // keybindings list unusable at 340px sidebar width (cramped layout +
    // nested-scroll trap from the kb list's own max-height inside the
    // body's overflow). Other panels are content surfaces and dock cleanly;
    // settings isn't, and didn't actually need it.
    document.getElementById('app').appendChild(panel);
    setTimeout(() => {
      const onOut = (event) => {
        if (!panel.contains(event.target) && panel.parentElement?.id !== 'right-dock') {
          panel.remove();
          document.removeEventListener('click', onOut);
        }
      };
      document.addEventListener('click', onOut);
    }, 0);
  }

  return {
    artifacts,
    unreadNotificationCount,
    showError,
    showToast,
    copyTextToClipboard,
    showUrlBanner,
    base64Decode,
    escHtml,
    extractHtmlArtifacts,
    openArtifactPreview,
    openWorkbookPreview,
    openWorkbookDemo,
    toggleArtifactPanel,
    renderArtifactPanel,
    previewArtifactFromPane,
    toggleSessionVaultPanel,
    renderSessionVaultPanel,
    markTabNotificationsRead,
    markPaneNotificationsRead,
    clearTabNotifications,
    clearPaneNotifications,
    getTabPortSummary,
    updateTabMeta,
    registerTabUrl,
    addNotification,
    toggleNotifPanel,
    renderNotifPanel,
    showHistoryPicker,
    showFindBar,
    showSettingsPanel,
    showUpdatePrompt,
  };
}