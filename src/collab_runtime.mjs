// Collab runtime — share-pane UX + Collab panel (active shares + audit).
//
// Pairs with `src-tauri/src/collab_server.rs` and the Tauri commands
// `share_pane`, `revoke_share`, `list_active_shares`, `provide_share_snapshot`,
// `list_audit_entries`, `list_local_addresses`. Backend is Phase 1a (PR #38);
// this is Phase 1b — the UI consumers.

import { makeDockable } from './panel_dock.mjs';

const DEFAULT_TTL_SECONDS = 4 * 60 * 60; // 4 hours, matches design-doc default
const REFRESH_INTERVAL_MS = 2000;

export function createCollabRuntime({
  document,
  invoke,
  panes,
  escHtml,
  showError,
  showToast,
}) {
  // shareCode → ShareInfo (last-known)
  const shares = new Map();
  // shareCode → ttl_seconds (used to render expiry countdown)
  const ttlByCode = new Map();
  // paneId → Set<shareCode>
  const sharesByPane = new Map();
  let cachedAddresses = [];
  let cachedPort = null;
  let panelEl = null;
  let refreshTimer = null;

  async function loadAddresses() {
    try {
      cachedAddresses = await invoke('list_local_addresses');
    } catch {
      cachedAddresses = [];
    }
  }

  function indexShares(list) {
    shares.clear();
    sharesByPane.clear();
    for (const info of list) {
      shares.set(info.code, info);
      if (!sharesByPane.has(info.target_pane_id)) sharesByPane.set(info.target_pane_id, new Set());
      sharesByPane.get(info.target_pane_id).add(info.code);
    }
  }

  function presenceForPane(paneId) {
    const codes = sharesByPane.get(paneId);
    if (!codes) return { count: 0, viewers: 0 };
    let viewers = 0;
    for (const code of codes) {
      const info = shares.get(code);
      if (info) viewers += info.presence | 0;
    }
    return { count: codes.size, viewers };
  }

  function updatePaneBadges() {
    // Walk every pane element; toggle / update the badge.
    for (const [paneId, pane] of panes) {
      const toolbar = pane.domEl?.querySelector?.('.pane-toolbar');
      if (!toolbar) continue;
      const existing = toolbar.querySelector('.pane-share-badge');
      const { count, viewers } = presenceForPane(paneId);
      if (count === 0) {
        existing?.remove();
        continue;
      }
      const text = `\u{1F441} ${viewers}`;
      if (existing) {
        existing.textContent = text;
        existing.title = `${count} active share${count === 1 ? '' : 's'} · ${viewers} viewer${viewers === 1 ? '' : 's'}`;
      } else {
        const badge = document.createElement('span');
        badge.className = 'pane-share-badge';
        badge.textContent = text;
        badge.title = `${count} active share${count === 1 ? '' : 's'} · ${viewers} viewer${viewers === 1 ? '' : 's'}`;
        // Insert before the close button if present, else at the end.
        const closeBtn = toolbar.querySelector('[data-action="close"]');
        if (closeBtn) toolbar.insertBefore(badge, closeBtn);
        else toolbar.appendChild(badge);
      }
    }
  }

  async function refresh() {
    try {
      const list = await invoke('list_active_shares');
      indexShares(list);
      updatePaneBadges();
      if (panelEl) renderPanelBody();
    } catch (err) {
      console.warn('[collab] list_active_shares failed:', err);
    }
  }

  function ensureRefreshing() {
    if (refreshTimer) return;
    refreshTimer = setInterval(refresh, REFRESH_INTERVAL_MS);
  }

  function stopRefreshing() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  // ── Snapshot capture ────────────────────────────────────────────────────

  function captureSnapshot(paneId) {
    const pane = panes.get(paneId);
    if (!pane?.serializeAddon) return null;
    try {
      const text = pane.serializeAddon.serialize();
      return Array.from(new TextEncoder().encode(text));
    } catch {
      return null;
    }
  }

  // ── Share dialog ────────────────────────────────────────────────────────

  function urlsForShare(info, secret) {
    const port = cachedPort;
    if (!port) return [];
    const hostList = cachedAddresses.length ? cachedAddresses : ['localhost'];
    const frag = `#t=${encodeURIComponent(secret)}`;
    return hostList.map((host) => `http://${host}:${port}${info.path}${frag}`);
  }

  function showShareDialog(paneId, mint) {
    closeShareDialog();
    const info = mint.share_info;
    const urls = urlsForShare(info, mint.secret);
    const dialog = document.createElement('div');
    dialog.id = 'collab-share-dialog';
    dialog.className = 'collab-share-dialog';
    dialog.innerHTML = `
      <div class="collab-share-dialog-header">
        <span>Share pane</span>
        <button class="collab-share-dialog-close" title="Close">&#x2715;</button>
      </div>
      <div class="collab-share-dialog-body">
        <div class="collab-share-row">
          <span class="collab-share-label">Pane</span>
          <span class="collab-share-value">${escHtml(info.target_pane_id)}</span>
        </div>
        <div class="collab-share-row">
          <span class="collab-share-label">Code</span>
          <span class="collab-share-value mono">${escHtml(info.code)}</span>
        </div>
        <div class="collab-share-row collab-share-row-stack">
          <span class="collab-share-label">URLs (pick one your viewer can reach)</span>
          <div class="collab-share-urls"></div>
        </div>
        <div class="collab-share-row">
          <span class="collab-share-label">Permission</span>
          <span class="collab-share-value">${info.permission === 'read_write' ? 'Read-write' : 'Read-only'}</span>
        </div>
        <div class="collab-share-help">
          The secret in the URL fragment is what authorizes the viewer. It never appears in server access logs.
          Anyone you send this URL to can view this pane until the share expires or you revoke it.
        </div>
        <div class="collab-share-actions">
          <button class="collab-share-btn" data-action="revoke">Revoke</button>
          <button class="collab-share-btn collab-share-btn-primary" data-action="done">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    const urlsContainer = dialog.querySelector('.collab-share-urls');
    if (urls.length === 0) {
      urlsContainer.innerHTML = '<div class="collab-share-empty">No reachable IP detected. Try the loopback URL or check that the collab server bound to a network interface.</div>';
    } else {
      for (const url of urls) {
        const row = document.createElement('div');
        row.className = 'collab-share-url-row';
        row.innerHTML = `
          <code class="collab-share-url">${escHtml(url)}</code>
          <button class="collab-share-copy" title="Copy URL">Copy</button>
        `;
        row.querySelector('.collab-share-copy').addEventListener('click', () => {
          navigator.clipboard?.writeText(url).then(() => {
            showToast?.('URL copied to clipboard', 'success');
          }).catch(() => {
            showError?.('Copy failed');
          });
        });
        urlsContainer.appendChild(row);
      }
    }
    dialog.querySelector('.collab-share-dialog-close').addEventListener('click', closeShareDialog);
    dialog.querySelector('[data-action="done"]').addEventListener('click', closeShareDialog);
    dialog.querySelector('[data-action="revoke"]').addEventListener('click', async () => {
      try {
        await invoke('revoke_share', { code: info.code });
        showToast?.('Share revoked', 'info');
        refresh();
        closeShareDialog();
      } catch (err) {
        showError?.(`Revoke failed: ${err}`);
      }
    });
  }

  function closeShareDialog() {
    document.getElementById('collab-share-dialog')?.remove();
  }

  async function startShareForPane(paneId) {
    closeShareDialog();
    await loadAddresses(); // refresh interface list every share
    try {
      const mint = await invoke('share_pane', {
        targetPaneId: paneId,
        ttlSeconds: DEFAULT_TTL_SECONDS,
      });
      cachedPort = mint.server_port;
      ttlByCode.set(mint.code, DEFAULT_TTL_SECONDS);

      // Send a snapshot so a join-later viewer sees the current screen.
      const snap = captureSnapshot(paneId);
      if (snap) {
        invoke('provide_share_snapshot', { code: mint.code, snapshot: snap }).catch(() => {});
      }

      await refresh();
      showShareDialog(paneId, mint);
      ensureRefreshing();
    } catch (err) {
      showError?.(`Share failed: ${err}`);
    }
  }

  // ── Collab panel (dockable, Active Shares + Audit) ──────────────────────

  function buildPanel() {
    if (panelEl) return panelEl;
    panelEl = document.createElement('div');
    panelEl.id = 'collab-panel';
    panelEl.className = 'collab-panel';
    panelEl.innerHTML = `
      <div class="collab-panel-header">
        <span class="collab-panel-title">Collab</span>
        <div class="collab-panel-header-actions">
          <button class="collab-panel-refresh" title="Refresh">&#x21bb;</button>
          <button class="collab-panel-close" title="Close">&#x2715;</button>
        </div>
      </div>
      <div class="collab-panel-tabs">
        <button class="collab-panel-tab is-active" data-tab="shares">Active shares</button>
        <button class="collab-panel-tab" data-tab="audit">Audit log</button>
      </div>
      <div class="collab-panel-body">
        <div class="collab-panel-section is-active" data-section="shares"></div>
        <div class="collab-panel-section" data-section="audit"></div>
      </div>
    `;
    document.body.appendChild(panelEl);
    makeDockable(panelEl, panelEl.querySelector('.collab-panel-header'), 'collab-panel');

    panelEl.querySelector('.collab-panel-close').addEventListener('click', hidePanel);
    panelEl.querySelector('.collab-panel-refresh').addEventListener('click', refresh);
    for (const tabBtn of panelEl.querySelectorAll('.collab-panel-tab')) {
      tabBtn.addEventListener('click', () => {
        for (const t of panelEl.querySelectorAll('.collab-panel-tab')) t.classList.toggle('is-active', t === tabBtn);
        const which = tabBtn.dataset.tab;
        for (const s of panelEl.querySelectorAll('.collab-panel-section')) {
          s.classList.toggle('is-active', s.dataset.section === which);
        }
        renderPanelBody();
      });
    }
    return panelEl;
  }

  function fmtTime(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function fmtRemaining(expiresAtMs) {
    const now = Date.now();
    const ms = expiresAtMs - now;
    if (ms <= 0) return 'expired';
    const m = Math.floor(ms / 60000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`;
  }

  function renderSharesSection() {
    const el = panelEl.querySelector('[data-section="shares"]');
    if (!el) return;
    const list = Array.from(shares.values()).sort((a, b) => b.created_at_ms - a.created_at_ms);
    if (list.length === 0) {
      el.innerHTML = '<div class="collab-empty">No active shares. Click the SH button on a pane toolbar to share it.</div>';
      return;
    }
    el.innerHTML = '';
    for (const info of list) {
      const row = document.createElement('div');
      row.className = 'collab-share-list-row';
      row.innerHTML = `
        <div class="collab-share-list-main">
          <span class="collab-share-list-code mono">${escHtml(info.code)}</span>
          <span class="collab-share-list-pane" title="${escHtml(info.target_pane_id)}">${escHtml(info.target_pane_id.slice(0, 8))}…</span>
        </div>
        <div class="collab-share-list-meta">
          <span class="collab-share-list-presence" title="Active viewers">\u{1F441} ${info.presence}</span>
          <span class="collab-share-list-expires">${escHtml(fmtRemaining(info.expires_at_ms))}</span>
          <span class="collab-share-list-perm">${info.permission === 'read_write' ? 'RW' : 'RO'}</span>
          <button class="collab-share-list-revoke" title="Revoke">&#x2715;</button>
        </div>
      `;
      row.querySelector('.collab-share-list-revoke').addEventListener('click', async () => {
        try {
          await invoke('revoke_share', { code: info.code });
          showToast?.('Share revoked', 'info');
          refresh();
        } catch (err) {
          showError?.(`Revoke failed: ${err}`);
        }
      });
      el.appendChild(row);
    }
  }

  async function renderAuditSection() {
    const el = panelEl.querySelector('[data-section="audit"]');
    if (!el) return;
    let entries = [];
    try {
      entries = await invoke('list_audit_entries');
    } catch (err) {
      el.innerHTML = `<div class="collab-empty">Failed to load audit: ${escHtml(String(err))}</div>`;
      return;
    }
    if (entries.length === 0) {
      el.innerHTML = '<div class="collab-empty">No audit entries yet.</div>';
      return;
    }
    el.innerHTML = '';
    // Show newest first.
    for (const entry of entries.slice().reverse()) {
      const row = document.createElement('div');
      row.className = `collab-audit-row collab-audit-${entry.event}`;
      const participant = entry.participant ? ` · ${escHtml(entry.participant)}` : '';
      row.innerHTML = `
        <span class="collab-audit-time">${escHtml(fmtTime(entry.at_ms))}</span>
        <span class="collab-audit-event">${escHtml(entry.event)}</span>
        <span class="collab-audit-code mono">${escHtml(entry.code)}</span>
        <span class="collab-audit-participant">${participant}</span>
      `;
      el.appendChild(row);
    }
  }

  function renderPanelBody() {
    if (!panelEl) return;
    const activeTab = panelEl.querySelector('.collab-panel-tab.is-active')?.dataset.tab;
    if (activeTab === 'shares') renderSharesSection();
    else renderAuditSection();
  }

  function showPanel() {
    buildPanel();
    panelEl.classList.add('is-visible');
    ensureRefreshing();
    refresh();
  }

  function hidePanel() {
    if (!panelEl) return;
    panelEl.classList.remove('is-visible');
  }

  function togglePanel() {
    if (panelEl && panelEl.classList.contains('is-visible')) {
      hidePanel();
    } else {
      showPanel();
    }
  }

  // Fire an initial refresh on instantiation so badges work even when the
  // panel is never opened.
  refresh();
  // Boot the polling so badges stay current.
  ensureRefreshing();

  return {
    startShareForPane,
    togglePanel,
    refresh,
    presenceForPane,
    stopRefreshing,
  };
}
