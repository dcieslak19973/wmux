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

  function unreadNotificationCount(tabId) {
    return (notifications.get(tabId) ?? []).filter((item) => !item.read).length;
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
      <button class="url-banner-open" data-url="${url}">Open in browser</button>
      <button class="url-banner-close" title="Dismiss">x</button>
    `;
    banner.querySelector('.url-banner-open').addEventListener('click', async () => {
      try { await invoke('open_url', { url }); } catch (err) { showError(`Could not open URL: ${err}`); }
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
          <button class="artifact-btn" data-action="clear">Clear</button>
          <button class="artifact-close" title="Close">✕</button>
        </div>
      </div>
      <div class="artifact-list">
        ${artifacts.length === 0 ? '<div class="artifact-empty">No captured artifacts</div>' : artifacts.map((item) => `
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
    panel.querySelectorAll('.artifact-item, .artifact-open').forEach((el) => {
      el.addEventListener('click', async (event) => {
        const itemEl = event.currentTarget.closest('.artifact-item');
        if (!itemEl) return;
        await openArtifactPreview(itemEl.dataset.id);
      });
    });
    document.getElementById('content').appendChild(panel);
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
        showError('No HTML artifact found in recent pane output');
        return;
      }
      const tab = tabs.get(pane.tabId);
      for (const match of matches) {
        const existing = artifacts.find((item) => item.paneId === paneId && item.html === match.html);
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
    document.getElementById('content').appendChild(panel);
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
    document.getElementById('session-vault-panel')?.remove();
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

    document.getElementById('content').appendChild(panel);
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
      <div class="settings-header"><span>Settings</span><button class="settings-close" title="Close">&#x2715;</button></div>
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
        <div class="settings-group"><div class="settings-group-label">Window</div><div class="settings-row"><span class="settings-label">New window</span><button class="settings-btn-sm" id="sp-new-window">Open</button></div></div>
        <div class="settings-footer"><button class="settings-btn-apply" id="sp-apply">Apply</button><button class="settings-btn-reset" id="sp-reset">Reset to defaults</button></div>
      </div>
    `;
    document.body.appendChild(panel);
    const draft = { ...s };
    const fontValEl = panel.querySelector('#sp-font-val');
    panel.querySelector('#sp-font-dec').addEventListener('click', () => { draft.fontSize = Math.max(8, (draft.fontSize ?? 13) - 1); fontValEl.textContent = draft.fontSize; });
    panel.querySelector('#sp-font-inc').addEventListener('click', () => { draft.fontSize = Math.min(32, (draft.fontSize ?? 13) + 1); fontValEl.textContent = draft.fontSize; });
    panel.querySelector('#sp-apply').addEventListener('click', () => {
      draft.fontFamily = panel.querySelector('#sp-font-family').value.trim() || s.fontFamily;
      draft.lineHeight = parseFloat(panel.querySelector('#sp-line-height').value) || s.lineHeight;
      draft.scrollback = parseInt(panel.querySelector('#sp-scrollback').value, 10) || s.scrollback;
      draft.cursorStyle = panel.querySelector('#sp-cursor-style').value;
      draft.cursorBlink = panel.querySelector('#sp-cursor-blink').checked;
      saveSettings(draft);
      applySettingsToAllPanes(draft);
      panel.remove();
    });
    panel.querySelector('#sp-reset').addEventListener('click', () => { saveSettings({ ...SETTINGS_DEFAULTS }); applySettingsToAllPanes(SETTINGS_DEFAULTS); panel.remove(); });
    panel.querySelector('#sp-new-window').addEventListener('click', async () => {
      panel.remove();
      try { await invoke('create_app_window'); } catch (err) { showError(`Could not open window: ${err}`); }
    });
    panel.querySelector('.settings-close').addEventListener('click', () => panel.remove());
    panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') panel.remove(); });
    setTimeout(() => {
      const onOut = (event) => {
        if (!panel.contains(event.target)) {
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
    showUrlBanner,
    base64Decode,
    escHtml,
    extractHtmlArtifacts,
    openArtifactPreview,
    toggleArtifactPanel,
    renderArtifactPanel,
    previewArtifactFromPane,
    toggleSessionVaultPanel,
    renderSessionVaultPanel,
    markTabNotificationsRead,
    markPaneNotificationsRead,
    clearTabNotifications,
    getTabPortSummary,
    updateTabMeta,
    registerTabUrl,
    addNotification,
    toggleNotifPanel,
    renderNotifPanel,
    showHistoryPicker,
    showFindBar,
    showSettingsPanel,
  };
}