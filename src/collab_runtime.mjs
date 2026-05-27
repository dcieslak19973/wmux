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
  listen,
  panes,
  tabs,
  workspaces,
  getActiveWorkspaceId,
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
  // Live workspace shares we own as host, keyed by wmux's workspaceId so
  // we can re-publish layout when panes split / close.
  // value: { code, paneIdToCode: Map<paneId, code>, permission, requireMutualConfirm }
  const activeWorkspaceSharesByHostWs = new Map();
  let cachedAddresses = [];
  let cachedTailscale = null; // { state, dns_name, tailscale_ips, error }
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

  async function loadTailscaleStatus() {
    try {
      cachedTailscale = await invoke('detect_tailscale_status');
    } catch {
      cachedTailscale = { state: 'error', dns_name: null, tailscale_ips: [], error: 'detect failed' };
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

  // Returns [{ kind, host, url }] grouped by reach: 'tailnet-dns' (preferred
  // MagicDNS name), 'tailnet-ip' (raw 100.x), 'lan' (non-loopback IPv4 on
  // a local interface), 'loopback' (fallback).
  function urlsForShare(info, secret) {
    const port = cachedPort;
    if (!port) return [];
    const frag = `#t=${encodeURIComponent(secret)}`;
    const out = [];
    const make = (kind, host) => ({ kind, host, url: `http://${host}:${port}${info.path}${frag}` });

    if (cachedTailscale?.state === 'running') {
      if (cachedTailscale.dns_name) out.push(make('tailnet-dns', cachedTailscale.dns_name));
      for (const ip of cachedTailscale.tailscale_ips || []) {
        if (ip.includes(':')) continue; // skip IPv6 for clarity; user usually wants v4
        out.push(make('tailnet-ip', ip));
      }
    }
    for (const addr of cachedAddresses) out.push(make('lan', addr));
    if (out.length === 0) out.push(make('loopback', 'localhost'));
    return out;
  }

  const URL_KIND_LABELS = {
    'tailnet-dns': 'Tailnet (DNS)',
    'tailnet-ip': 'Tailnet',
    'lan': 'LAN',
    'loopback': 'Loopback',
  };

  function tailscaleHintHtml() {
    const ts = cachedTailscale;
    if (!ts) return '';
    if (ts.state === 'running') {
      return `<span class="collab-share-tailscale-ok">Tailscale running &mdash; viewers anywhere on your tailnet can reach the Tailnet URLs above.</span>`;
    }
    if (ts.state === 'needs_login') {
      return `<span class="collab-share-tailscale-warn">Tailscale installed but not logged in. Run <code>tailscale login</code> for cross-network access.</span>`;
    }
    if (ts.state === 'stopped') {
      return `<span class="collab-share-tailscale-warn">Tailscale is stopped. Start it for cross-network access.</span>`;
    }
    if (ts.state === 'not_installed') {
      return `<span class="collab-share-tailscale-warn">Tailscale not installed &mdash; LAN-only. Install from <a href="https://tailscale.com/download" target="_blank" rel="noopener">tailscale.com/download</a> for cross-network sharing.</span>`;
    }
    return `<span class="collab-share-tailscale-warn">Tailscale detection error${ts.error ? `: ${escHtml(ts.error)}` : ''}.</span>`;
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
          <div class="collab-share-tailscale-hint"></div>
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
      for (const entry of urls) {
        const row = document.createElement('div');
        row.className = `collab-share-url-row collab-share-url-row-${entry.kind}`;
        row.innerHTML = `
          <span class="collab-share-url-pill collab-share-url-pill-${entry.kind}">${escHtml(URL_KIND_LABELS[entry.kind] ?? entry.kind)}</span>
          <code class="collab-share-url">${escHtml(entry.url)}</code>
          <button class="collab-share-copy" title="Copy URL">Copy</button>
        `;
        row.querySelector('.collab-share-copy').addEventListener('click', () => {
          navigator.clipboard?.writeText(entry.url).then(() => {
            showToast?.('URL copied to clipboard', 'success');
          }).catch(() => {
            showError?.('Copy failed');
          });
        });
        urlsContainer.appendChild(row);
      }
    }

    // Tailscale hint line — informative, never blocking.
    const hintEl = dialog.querySelector('.collab-share-tailscale-hint');
    if (hintEl) hintEl.innerHTML = tailscaleHintHtml();
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

  function enumerateShareablePanes() {
    // Walk every pane in the active workspace's tabs; keep terminal panes
    // (those with a sessionId). Returns [{ pane_id, label }, ...].
    if (!tabs || !workspaces || !getActiveWorkspaceId) return [];
    const wsId = getActiveWorkspaceId();
    if (!wsId) return [];
    const out = [];
    for (const [tabId, tab] of tabs) {
      if (tab.workspaceId !== wsId) continue;
      const tabTitle = tab.title || `Tab ${tabId.slice(0, 4)}`;
      const paneIds = tab.paneIds || [];
      for (const paneId of paneIds) {
        const pane = panes.get(paneId);
        if (!pane?.sessionId) continue;
        const detail = pane.cwd || pane.title || '';
        const label = detail ? `${tabTitle} · ${detail}` : tabTitle;
        out.push({ pane_id: pane.sessionId, label });
      }
    }
    return out;
  }

  // Walk a tab's contentEl building a viewer-shaped layout:
  //   { kind: 'leaf', code: 'abc' }                       — terminal pane
  //   { kind: 'split', dir: 'h'|'v', ratio: 0.5, a, b }   — split node
  // `paneIdToCode` is a Map from host session id → minted pane share code.
  // Returns null for an entirely-ephemeral subtree (none of its leaves are
  // shareable terminal panes), in which case callers collapse it out.
  function buildViewerLayout(el, paneIdToCode) {
    if (!el) return null;
    // Non-terminal panes share the pane-leaf class but have no session stream.
    // Check these BEFORE the generic pane-leaf branch or they return null.
    if (el.classList?.contains('browser-pane-leaf'))   return { kind: 'placeholder', label: 'Browser' };
    if (el.classList?.contains('markdown-pane-leaf'))  return { kind: 'placeholder', label: 'Markdown' };
    if (el.classList?.contains('pr-review-pane-leaf')) return { kind: 'placeholder', label: 'PR Review' };
    if (el.classList?.contains('pane-leaf')) {
      const code = paneIdToCode.get(el.dataset.sessionId);
      return code ? { kind: 'leaf', code } : null;
    }
    if (el.classList?.contains('pane-split')) {
      const dir = el.classList.contains('pane-split-h') ? 'h' : 'v';
      const kids = [...el.children].filter((c) => !c.classList.contains('pane-divider'));
      const [aSide, bSide] = kids;
      // Terminal splits wrap the right side: <split><leaf/><wrapper><leaf/></wrapper></split>
      // Browser/markdown/pr-review splits do NOT wrap: <split><leaf/><browser-leaf/></split>
      // Use bSide directly if it's already a recognised leaf or split; otherwise unwrap.
      const bContent = (bSide?.classList?.contains('pane-leaf') || bSide?.classList?.contains('pane-split'))
        ? bSide
        : (bSide?.firstElementChild ?? bSide);
      const a = buildViewerLayout(aSide, paneIdToCode);
      const b = buildViewerLayout(bContent, paneIdToCode);
      if (!a && !b) return null;
      if (!b) return a;
      if (!a) return b;
      const flexA = parseFloat(aSide.style.flex) || 1;
      const flexB = parseFloat(bSide.style.flex) || 1;
      const ratio = flexA / (flexA + flexB);
      return { kind: 'split', dir, ratio, a, b };
    }
    // Recurse into wrapper divs (the right-side wrapper of pane-split).
    if (el.firstElementChild) {
      return buildViewerLayout(el.firstElementChild, paneIdToCode);
    }
    return null;
  }

  // Re-enumerate the workspace's terminal panes, mint new pane shares
  // for any that aren't already in the workspace bundle, rebuild the
  // layout JSON, and ship it to the backend (which broadcasts to any
  // subscribed viewer WebSockets so they re-render live).
  async function publishLayoutForWorkspace(wsId) {
    if (!wsId) return;
    const wsShare = activeWorkspaceSharesByHostWs.get(wsId);
    if (!wsShare) return;
    if (!tabs) return;

    // Collect every tab belonging to this workspace, preserving order.
    const orderedTabs = [];
    let activeTabId = null;
    for (const tab of tabs.values()) {
      if (tab.workspaceId !== wsId) continue;
      orderedTabs.push(tab);
      if (tab.contentEl?.classList?.contains('visible')) {
        activeTabId = tab.id;
      }
    }
    if (orderedTabs.length === 0) return;
    if (!activeTabId) activeTabId = orderedTabs[0].id;

    // Walk every tab; collect pane IDs that need a fresh share share-mint.
    const newPaneIds = [];
    const tabRoots = []; // [{ tab, rootEl }]
    const visited = new Set();
    function walkForNewPanes(el) {
      if (!el || visited.has(el)) return;
      visited.add(el);
      if (el.classList?.contains('pane-leaf')) {
        const sid = el.dataset.sessionId;
        if (sid && panes.get(sid)?.sessionId && !wsShare.paneIdToCode.has(sid)) {
          newPaneIds.push(sid);
        }
        return;
      }
      if (el.classList?.contains('pane-split')) {
        for (const child of el.children) walkForNewPanes(child);
        return;
      }
      if (el.firstElementChild) walkForNewPanes(el.firstElementChild);
    }
    for (const tab of orderedTabs) {
      const root = tab.contentEl?.querySelector?.('.pane-leaf, .pane-split');
      if (!root) continue;
      tabRoots.push({ tab, rootEl: root });
      walkForNewPanes(root);
    }
    if (tabRoots.length === 0) return;

    // Mint pane shares for every pane that doesn't already have one.
    for (const sid of newPaneIds) {
      try {
        const pane = panes.get(sid);
        const owningTab = orderedTabs.find((t) => (t.paneIds || []).includes(sid));
        const tabTitle = owningTab?.title || 'Tab';
        const detail = pane?.cwd || pane?.title || '';
        const label = detail ? `${tabTitle} · ${detail}` : tabTitle;
        const res = await invoke('add_pane_to_workspace_share', {
          workspaceCode: wsShare.code,
          targetPaneId: sid,
          label,
          permission: wsShare.permission,
          ttlSeconds: DEFAULT_TTL_SECONDS,
          requireMutualConfirm: getRequireApproval(),
        });
        wsShare.paneIdToCode.set(sid, res.code);
        const snap = captureSnapshot(sid);
        if (snap) {
          invoke('provide_share_snapshot', { code: res.code, snapshot: snap }).catch(() => {});
        }
      } catch (err) {
        console.warn('[collab] mint pane share for split failed:', err);
      }
    }

    // Build the multi-tab layout shape:
    //   { kind: 'workspace', tabs: [{ id, title, layout }], active_tab_id }
    const tabPayloads = [];
    for (const { tab, rootEl } of tabRoots) {
      const layout = buildViewerLayout(rootEl, wsShare.paneIdToCode);
      if (!layout) continue;
      tabPayloads.push({ id: tab.id, title: tab.title || 'Tab', layout });
    }
    if (tabPayloads.length === 0) return;
    const payload = {
      kind: 'workspace',
      tabs: tabPayloads,
      active_tab_id: activeTabId,
    };
    invoke('provide_workspace_layout', { code: wsShare.code, layout: payload }).catch((err) => {
      console.warn('[collab] provide_workspace_layout failed:', err);
    });
  }

  // Hook called by main.js whenever the layout dirties — splits, closes,
  // resizes. Cheap: no-op when no active workspace share for the affected
  // workspace.
  function onHostLayoutChanged() {
    const wsId = getActiveWorkspaceId?.();
    if (!wsId) return;
    if (!activeWorkspaceSharesByHostWs.has(wsId)) return;
    // Debounce so a flurry of splits / divider drags only produces one
    // publish per ~150 ms.
    if (onHostLayoutChanged._timer) clearTimeout(onHostLayoutChanged._timer);
    onHostLayoutChanged._timer = setTimeout(() => {
      onHostLayoutChanged._timer = null;
      publishLayoutForWorkspace(wsId).catch((err) => console.warn('[collab] publish failed:', err));
    }, 150);
  }

  function findActiveTab() {
    if (!tabs || !getActiveWorkspaceId) return null;
    const wsId = getActiveWorkspaceId();
    // Active tab = the one whose contentEl is currently visible.
    for (const tab of tabs.values()) {
      if (tab.workspaceId !== wsId) continue;
      if (tab.contentEl?.classList?.contains('visible')) return tab;
    }
    // Fallback: first tab in this workspace.
    for (const tab of tabs.values()) {
      if (tab.workspaceId === wsId) return tab;
    }
    return null;
  }

  async function startShareForWorkspace(permission = 'read') {
    closeShareDialog();
    await Promise.all([loadAddresses(), loadTailscaleStatus()]);
    const wsId = getActiveWorkspaceId?.();
    const ws = wsId ? workspaces?.get(wsId) : null;
    const paneSpecs = enumerateShareablePanes();
    if (paneSpecs.length === 0) {
      showError?.('No shareable panes in this workspace.');
      return;
    }
    try {
      const mint = await invoke('share_workspace', {
        workspaceLabel: ws?.name || 'Workspace',
        panes: paneSpecs,
        ttlSeconds: DEFAULT_TTL_SECONDS,
        requireMutualConfirm: getRequireApproval(),
        permission,
      });
      cachedPort = mint.server_port;

      // Push snapshots for each pane so a join-later viewer sees current
      // state, not the screen at share-creation time.
      for (const spec of paneSpecs) {
        const snap = captureSnapshot(spec.pane_id);
        // The Tauri command response carries pane_codes in info but not
        // a (pane_id → code) map. We rely on the order matching the panes
        // we sent — which it does (backend mints in iteration order).
      }
      const codesByOrder = mint.info.pane_codes;
      const paneIdToCode = new Map();
      for (let i = 0; i < paneSpecs.length; i++) {
        const snap = captureSnapshot(paneSpecs[i].pane_id);
        if (snap && codesByOrder[i]) {
          invoke('provide_share_snapshot', { code: codesByOrder[i], snapshot: snap }).catch(() => {});
        }
        if (codesByOrder[i]) paneIdToCode.set(paneSpecs[i].pane_id, codesByOrder[i]);
      }

      // Remember this active workspace share so onLayoutChanged can
      // re-publish the layout (and mint new pane shares as splits add
      // panes mid-share).
      const wsId = getActiveWorkspaceId?.();
      if (wsId) {
        activeWorkspaceSharesByHostWs.set(wsId, {
          code: mint.code,
          paneIdToCode,
          permission,
        });
      }

      // Capture the active tab's split layout and ship it to the backend
      // so the workspace viewer can render real splits instead of cards.
      await publishLayoutForWorkspace(wsId);

      await refresh();
      showWorkspaceShareDialog(mint, paneSpecs.length);
      ensureRefreshing();
    } catch (err) {
      showError?.(`Workspace share failed: ${err}`);
    }
  }

  function showWorkspaceShareDialog(mint, paneCount) {
    closeShareDialog();
    const urls = urlsForShareWorkspace(mint);
    const dialog = document.createElement('div');
    dialog.id = 'collab-share-dialog';
    dialog.className = 'collab-share-dialog';
    dialog.innerHTML = `
      <div class="collab-share-dialog-header">
        <span>Share workspace</span>
        <button class="collab-share-dialog-close" title="Close">&#x2715;</button>
      </div>
      <div class="collab-share-dialog-body">
        <div class="collab-share-row">
          <span class="collab-share-label">Workspace</span>
          <span class="collab-share-value">${escHtml(mint.info.label)}</span>
        </div>
        <div class="collab-share-row">
          <span class="collab-share-label">Panes</span>
          <span class="collab-share-value">${paneCount} shared</span>
        </div>
        <div class="collab-share-row">
          <span class="collab-share-label">Code</span>
          <span class="collab-share-value mono">${escHtml(mint.code)}</span>
        </div>
        <div class="collab-share-row collab-share-row-stack">
          <span class="collab-share-label">URLs (pick one your viewer can reach)</span>
          <div class="collab-share-urls"></div>
          <div class="collab-share-tailscale-hint"></div>
        </div>
        <div class="collab-share-help">
          The URL opens a workspace landing page that lists each shared pane. Anyone with this URL can view (and, if you chose read-write, type into) every pane in the workspace until you revoke it.
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
      urlsContainer.innerHTML = '<div class="collab-share-empty">No reachable IP detected.</div>';
    } else {
      for (const entry of urls) {
        const row = document.createElement('div');
        row.className = `collab-share-url-row collab-share-url-row-${entry.kind}`;
        row.innerHTML = `
          <span class="collab-share-url-pill collab-share-url-pill-${entry.kind}">${escHtml(URL_KIND_LABELS[entry.kind] ?? entry.kind)}</span>
          <code class="collab-share-url">${escHtml(entry.url)}</code>
          <button class="collab-share-copy" title="Copy URL">Copy</button>
        `;
        row.querySelector('.collab-share-copy').addEventListener('click', () => {
          navigator.clipboard?.writeText(entry.url).then(() => {
            showToast?.('URL copied to clipboard', 'success');
          }).catch(() => {
            showError?.('Copy failed');
          });
        });
        urlsContainer.appendChild(row);
      }
    }
    const hintEl = dialog.querySelector('.collab-share-tailscale-hint');
    if (hintEl) hintEl.innerHTML = tailscaleHintHtml();
    dialog.querySelector('.collab-share-dialog-close').addEventListener('click', closeShareDialog);
    dialog.querySelector('[data-action="done"]').addEventListener('click', closeShareDialog);
    dialog.querySelector('[data-action="revoke"]').addEventListener('click', async () => {
      try {
        await invoke('revoke_workspace_share', { code: mint.code });
        showToast?.('Workspace share revoked', 'info');
        refresh();
        closeShareDialog();
      } catch (err) {
        showError?.(`Revoke failed: ${err}`);
      }
    });
  }

  function urlsForShareWorkspace(mint) {
    const port = mint.server_port;
    if (!port) return [];
    const frag = `#t=${encodeURIComponent(mint.secret)}`;
    const out = [];
    const make = (kind, host) => ({ kind, host, url: `http://${host}:${port}${mint.path}${frag}` });
    if (cachedTailscale?.state === 'running') {
      if (cachedTailscale.dns_name) out.push(make('tailnet-dns', cachedTailscale.dns_name));
      for (const ip of cachedTailscale.tailscale_ips || []) {
        if (ip.includes(':')) continue;
        out.push(make('tailnet-ip', ip));
      }
    }
    for (const addr of cachedAddresses) out.push(make('lan', addr));
    if (out.length === 0) out.push(make('loopback', 'localhost'));
    return out;
  }

  async function startShareForPane(paneId, permission = 'read') {
    closeShareDialog();
    // Refresh interface + Tailscale state every share so the dialog shows
    // current URLs (laptop may have moved networks, daemon may have logged
    // out, etc.).
    await Promise.all([loadAddresses(), loadTailscaleStatus()]);
    try {
      const mint = await invoke('share_pane', {
        targetPaneId: paneId,
        ttlSeconds: DEFAULT_TTL_SECONDS,
        requireMutualConfirm: getRequireApproval(),
        permission,
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
          <button class="collab-panel-share-workspace" title="Share current workspace">Share workspace</button>
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
      <div class="collab-panel-footer">
        <label class="collab-panel-pref" title="When on, every new device viewing a new share triggers an Allow/Deny dialog.">
          <input type="checkbox" class="collab-panel-require-approval" />
          <span>Require approval for new devices on new shares</span>
        </label>
      </div>
    `;
    document.body.appendChild(panelEl);
    makeDockable(panelEl, panelEl.querySelector('.collab-panel-header'), 'collab-panel');

    panelEl.querySelector('.collab-panel-close').addEventListener('click', hidePanel);
    panelEl.querySelector('.collab-panel-refresh').addEventListener('click', refresh);
    const shareWsBtn = panelEl.querySelector('.collab-panel-share-workspace');
    if (shareWsBtn) {
      shareWsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Permission picker — same shape as the SH pane button.
        const r = shareWsBtn.getBoundingClientRect();
        const items = [
          { type: 'label', text: 'Share current workspace' },
          { label: 'Read-only', action: () => startShareForWorkspace('read') },
          { label: 'Read-write (viewers can type)', danger: true, action: () => startShareForWorkspace('read_write') },
        ];
        // Reuse the global showContextMenu via dispatching a custom event
        // would couple us to main.js. Simpler: render a tiny inline menu.
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = `${Math.max(8, r.right - 220)}px`;
        menu.style.top = `${r.bottom + 4}px`;
        for (const item of items) {
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
          btn.addEventListener('click', () => {
            menu.remove();
            item.action?.();
          });
          menu.appendChild(btn);
        }
        document.body.appendChild(menu);
        // Clamp to viewport (same as showContextMenu in main.js).
        const rect = menu.getBoundingClientRect();
        const pad = 8;
        if (rect.right > window.innerWidth - pad) {
          menu.style.left = `${Math.max(pad, window.innerWidth - rect.width - pad)}px`;
        }
        if (rect.bottom > window.innerHeight - pad) {
          menu.style.top = `${Math.max(pad, window.innerHeight - rect.height - pad)}px`;
        }
        setTimeout(() => {
          const onOutside = (ev) => {
            if (!menu.contains(ev.target)) {
              menu.remove();
              document.removeEventListener('mousedown', onOutside);
            }
          };
          document.addEventListener('mousedown', onOutside);
        }, 0);
      });
    }
    const approvalChk = panelEl.querySelector('.collab-panel-require-approval');
    approvalChk.checked = getRequireApproval();
    approvalChk.addEventListener('change', () => setRequireApproval(approvalChk.checked));
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

  // ── Mutual-confirm (2.6) ─────────────────────────────────────────────

  const APPROVAL_PREF_KEY = 'wmux.collab.requireApproval';
  function getRequireApproval() {
    try { return localStorage.getItem(APPROVAL_PREF_KEY) === '1'; } catch { return false; }
  }
  function setRequireApproval(on) {
    try { localStorage.setItem(APPROVAL_PREF_KEY, on ? '1' : '0'); } catch {}
  }

  function showApprovalDialog(req) {
    // req: { code, fingerprint, peer_ip, ua_hint, ua_full }
    const dialog = document.createElement('div');
    dialog.className = 'collab-approval-dialog';
    dialog.innerHTML = `
      <div class="collab-approval-header">New device wants to view this share</div>
      <div class="collab-approval-body">
        <div class="collab-approval-row"><span class="collab-approval-label">Share</span><span class="mono">${escHtml(req.code)}</span></div>
        <div class="collab-approval-row"><span class="collab-approval-label">Device</span><span>${escHtml(req.ua_hint)}</span></div>
        <div class="collab-approval-row"><span class="collab-approval-label">From</span><span class="mono">${escHtml(req.peer_ip)}</span></div>
        <div class="collab-approval-help">If you didn't expect this, click Deny. Approving adds this device's fingerprint to the allow-list for this share until it expires.</div>
        <div class="collab-approval-actions">
          <button class="collab-share-btn" data-allow="false">Deny</button>
          <button class="collab-share-btn collab-share-btn-primary" data-allow="true">Allow</button>
        </div>
      </div>
    `;
    document.body.appendChild(dialog);
    const respond = async (allow) => {
      dialog.remove();
      try {
        await invoke('respond_to_collab_approval', {
          code: req.code,
          fingerprint: req.fingerprint,
          allow,
        });
      } catch (err) {
        showError?.(`Approval response failed: ${err}`);
      }
    };
    dialog.querySelector('[data-allow="true"]').addEventListener('click', () => respond(true));
    dialog.querySelector('[data-allow="false"]').addEventListener('click', () => respond(false));
    // Auto-deny after 25s so the user-facing dialog doesn't outlive the
    // backend's 30s wait. Better to deny than leave it hanging.
    setTimeout(() => {
      if (document.body.contains(dialog)) {
        respond(false).catch(() => {});
      }
    }, 25_000);
  }

  // Subscribe to backend approval requests as soon as the runtime boots.
  // Best-effort: if `listen` isn't available (e.g. testing in plain browser)
  // we just don't hook anything; mutual-confirm becomes a no-op visually
  // and the backend times out.
  if (listen) {
    listen('collab-approval-needed', (event) => {
      const req = event?.payload;
      if (req && typeof req === 'object' && req.code && req.fingerprint) {
        showApprovalDialog(req);
      }
    }).catch(() => {});

    // Phase 5: when a Claude Code hook event fires, fan it out to any
    // shares targeting that pane so the viewer's agent timeline updates
    // live. OSC 133 block events ride a separate path (the backend
    // pushes those directly from start_session_stream).
    listen('agent-hook-event', (event) => {
      const p = event?.payload;
      if (!p?.pane_id) return;
      const ts = typeof p.event_ms === 'number' ? p.event_ms : Date.now();
      const payload = {
        kind: 'agent_hook',
        hook_event: p.hook_event ?? null,
        tool: p.tool ?? null,
        message: p.message ?? null,
        ts,
      };
      invoke('broadcast_agent_event', { paneId: p.pane_id, payload }).catch(() => {});
    }).catch(() => {});
  }

  // Fire an initial refresh on instantiation so badges work even when the
  // panel is never opened.
  refresh();
  // Boot the polling so badges stay current.
  ensureRefreshing();

  return {
    startShareForPane,
    startShareForWorkspace,
    togglePanel,
    refresh,
    presenceForPane,
    stopRefreshing,
    getRequireApproval,
    setRequireApproval,
    onHostLayoutChanged,
  };
}
