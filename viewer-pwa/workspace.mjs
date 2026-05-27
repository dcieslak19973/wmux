// wmux PWA workspace viewer.
//
// Fetches the workspace manifest (label + panes + layout) via the
// workspace secret in the URL fragment, then renders the host's split
// layout as nested flex divs. Each leaf is its own xterm.js instance
// connected by its own WebSocket — same wire protocol as the
// single-pane viewer (Auth → Hello → Capabilities → Output/Input
// frames).
//
// Falls back to the card grid when the manifest doesn't carry a
// layout (older workspace shares, or share_workspace without a
// successful provide_workspace_layout follow-up).

const PROTOCOL_VERSION = 1;

const statusEl = document.getElementById('status');
const titleEl = document.getElementById('workspace-title');
const rootEl = document.getElementById('workspace-root');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status${cls ? ' ' + cls : ''}`;
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const pathParts = window.location.pathname.split('/').filter(Boolean);
const code = pathParts[1] || '';
const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
const params = new URLSearchParams(hash);
const secret = params.get('t') || '';

if (!code || !secret) {
  setStatus('bad share URL — missing code or secret', 'err');
  throw new Error('missing code/secret');
}

(async () => {
  setStatus('fetching manifest…');
  let manifest;
  try {
    const resp = await fetch(`manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      setStatus(`manifest ${resp.status}: ${text}`, 'err');
      return;
    }
    manifest = await resp.json();
  } catch (err) {
    setStatus(`manifest fetch failed: ${err}`, 'err');
    return;
  }

  titleEl.textContent = manifest.label || 'workspace';

  if (manifest.layout) {
    setStatus(`${manifest.panes.length} pane${manifest.panes.length === 1 ? '' : 's'} — live splits`, 'ok');
    renderSplitLayout(manifest);
  } else {
    setStatus(`${manifest.panes.length} pane${manifest.panes.length === 1 ? '' : 's'} shared`, 'ok');
    renderCards(manifest);
  }

  // Subscribe to live layout updates — when the host splits / closes /
  // resizes panes, the server broadcasts the new layout JSON here, and
  // we re-fetch the manifest (for any newly-minted pane shares) and
  // re-render.
  subscribeToLayoutUpdates();
})();

function subscribeToLayoutUpdates() {
  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${window.location.host}/ws/w/${encodeURIComponent(code)}`;
  let attempt = 0;
  let closed = false;

  function connect() {
    const ws = new WebSocket(wsUrl);
    ws.addEventListener('open', () => {
      attempt = 0;
      ws.send(JSON.stringify({ kind: 'auth', secret }));
    });
    ws.addEventListener('message', async (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.kind !== 'layout') return;
      // Layout changed on the host. Re-fetch manifest (in case new pane
      // shares were minted for newly-split panes) and re-render.
      try {
        const resp = await fetch('manifest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret }),
        });
        if (!resp.ok) return;
        const fresh = await resp.json();
        if (fresh.layout) {
          setStatus(`${fresh.panes.length} pane${fresh.panes.length === 1 ? '' : 's'} — layout updated`, 'ok');
          renderSplitLayout(fresh);
        } else {
          renderCards(fresh);
        }
      } catch (err) {
        console.warn('[workspace] manifest refresh failed:', err);
      }
    });
    ws.addEventListener('close', () => {
      if (closed) return;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      attempt += 1;
      setTimeout(connect, delay);
    });
    ws.addEventListener('error', () => {});
  }
  window.addEventListener('beforeunload', () => { closed = true; });
  connect();
}

// ── Card-grid fallback (previous behaviour) ─────────────────────────────

function renderCards(manifest) {
  rootEl.innerHTML = '';
  if (!manifest.panes.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    empty.textContent = 'No panes in this workspace share.';
    rootEl.appendChild(empty);
    return;
  }
  const cards = document.createElement('div');
  cards.id = 'pane-cards';
  for (const pane of manifest.panes) {
    const url = `/s/${encodeURIComponent(pane.code)}#t=${encodeURIComponent(pane.secret)}`;
    const card = document.createElement('a');
    card.className = 'workspace-card';
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener';
    card.innerHTML = `
      <span class="workspace-card-label">${escHtml(pane.label || pane.code)}</span>
      <span class="workspace-card-code mono">${escHtml(pane.code)}</span>
    `;
    cards.appendChild(card);
  }
  rootEl.appendChild(cards);
}

// ── Live split-tree renderer ────────────────────────────────────────────

// Track every per-leaf WebSocket so we can close them cleanly before
// re-rendering on a layout update — otherwise each re-render leaks N
// zombie connections, and the host's presence counter creeps upward.
const activeLeafSessions = new Set();

function disposeAllLeafSessions() {
  for (const dispose of activeLeafSessions) {
    try { dispose(); } catch {}
  }
  activeLeafSessions.clear();
}

function renderSplitLayout(manifest) {
  // First, tear down anything from a prior render so its WS connections
  // close and the host's presence counter drops back.
  disposeAllLeafSessions();
  rootEl.classList.add('workspace-split-mode');
  rootEl.innerHTML = '';

  const paneInfo = new Map();
  for (const pane of manifest.panes) {
    paneInfo.set(pane.code, pane);
  }

  // Normalise to the multi-tab shape so the renderer is single-path.
  // Pre-Phase-4-polish shares stored a bare split-tree at layout; wrap.
  const wsLayout = (manifest.layout && manifest.layout.kind === 'workspace')
    ? manifest.layout
    : { kind: 'workspace', tabs: [{ id: '__legacy', title: 'Workspace', layout: manifest.layout }], active_tab_id: '__legacy' };

  if (!wsLayout.tabs?.length) {
    const empty = document.createElement('div');
    empty.className = 'workspace-empty';
    empty.textContent = 'No shareable panes in this workspace.';
    rootEl.appendChild(empty);
    return;
  }

  // Tab strip — only render if there's more than one tab.
  let activeId = wsLayout.active_tab_id ?? wsLayout.tabs[0].id;
  if (!wsLayout.tabs.find((t) => t.id === activeId)) activeId = wsLayout.tabs[0].id;

  if (wsLayout.tabs.length > 1) {
    const strip = document.createElement('div');
    strip.className = 'workspace-tab-strip';
    for (const tab of wsLayout.tabs) {
      const chip = document.createElement('button');
      chip.className = 'workspace-tab-chip' + (tab.id === activeId ? ' is-active' : '');
      chip.textContent = tab.title;
      chip.dataset.tabId = tab.id;
      chip.addEventListener('click', () => switchTab(tab.id));
      strip.appendChild(chip);
    }
    rootEl.appendChild(strip);
  }

  // Body: render every tab once, hide all but the active one. Keeps
  // xterm instances alive so output keeps streaming in the background.
  const body = document.createElement('div');
  body.className = 'workspace-tab-body';
  rootEl.appendChild(body);

  for (const tab of wsLayout.tabs) {
    const tabPanel = document.createElement('div');
    tabPanel.className = 'workspace-tab-panel' + (tab.id === activeId ? ' is-active' : '');
    tabPanel.dataset.tabId = tab.id;
    const treeRoot = renderNode(tab.layout, paneInfo);
    treeRoot.classList.add('workspace-split-root');
    tabPanel.appendChild(treeRoot);
    body.appendChild(tabPanel);
  }

  function switchTab(id) {
    for (const chip of rootEl.querySelectorAll('.workspace-tab-chip')) {
      chip.classList.toggle('is-active', chip.dataset.tabId === id);
    }
    for (const panel of body.querySelectorAll('.workspace-tab-panel')) {
      panel.classList.toggle('is-active', panel.dataset.tabId === id);
    }
    // Re-fit the newly-active tab's xterms; they may have been laid out
    // at zero height while hidden.
    const active = body.querySelector('.workspace-tab-panel.is-active');
    if (active) requestAnimationFrame(() => fitAllInTree(active));
  }

  requestAnimationFrame(() => {
    const active = body.querySelector('.workspace-tab-panel.is-active');
    if (active) fitAllInTree(active);
  });
  window.addEventListener('resize', () => {
    const active = body.querySelector('.workspace-tab-panel.is-active');
    if (active) fitAllInTree(active);
  });
}

function renderNode(node, paneInfo) {
  if (!node) {
    const placeholder = document.createElement('div');
    placeholder.className = 'workspace-empty';
    placeholder.textContent = 'no shareable panes in this workspace';
    return placeholder;
  }
  if (node.kind === 'leaf') {
    return renderLeaf(node.code, paneInfo.get(node.code));
  }
  if (node.kind === 'split') {
    return renderSplit(node, paneInfo);
  }
  if (node.kind === 'placeholder') {
    const el = document.createElement('div');
    el.className = 'workspace-leaf workspace-leaf-missing workspace-leaf-placeholder';
    el.textContent = `${node.label ?? 'Pane'} — not available in shared view`;
    return el;
  }
  const errEl = document.createElement('div');
  errEl.className = 'workspace-empty';
  errEl.textContent = `unknown layout node: ${node.kind ?? '?'}`;
  return errEl;
}

function renderSplit(node, paneInfo) {
  const splitEl = document.createElement('div');
  splitEl.className = `workspace-split workspace-split-${node.dir}`;

  const aWrap = document.createElement('div');
  aWrap.className = 'workspace-split-side';
  aWrap.style.flex = `${Math.max(0.05, node.ratio)} 1 0`;
  aWrap.appendChild(renderNode(node.a, paneInfo));
  splitEl.appendChild(aWrap);

  const divider = document.createElement('div');
  divider.className = `workspace-split-divider workspace-split-divider-${node.dir}`;
  splitEl.appendChild(divider);

  const bWrap = document.createElement('div');
  bWrap.className = 'workspace-split-side';
  bWrap.style.flex = `${Math.max(0.05, 1 - node.ratio)} 1 0`;
  bWrap.appendChild(renderNode(node.b, paneInfo));
  splitEl.appendChild(bWrap);

  wireDividerDrag(splitEl, divider, aWrap, bWrap, node.dir);
  return splitEl;
}

// Drag a divider to rebalance the flex on the two sides. Local-only —
// doesn't push back to the host; viewer can choose to view a different
// ratio than the host has. Re-fits xterms as the drag progresses so
// they reflow to the new pane widths/heights.
function wireDividerDrag(splitEl, dividerEl, aWrap, bWrap, dir) {
  dividerEl.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const rect = splitEl.getBoundingClientRect();
    const total = dir === 'h' ? rect.width : rect.height;
    if (total <= 0) return;
    document.body.style.cursor = dir === 'h' ? 'col-resize' : 'row-resize';

    const onMove = (mv) => {
      const at = dir === 'h' ? mv.clientX - rect.left : mv.clientY - rect.top;
      const ratio = Math.max(0.05, Math.min(0.95, at / total));
      aWrap.style.flex = `${ratio} 1 0`;
      bWrap.style.flex = `${1 - ratio} 1 0`;
      // Refit xterms inside both sides as their dimensions change.
      for (const leaf of splitEl.querySelectorAll('.workspace-leaf')) {
        try { leaf._fit?.(); } catch {}
      }
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function renderLeaf(paneCode, pane) {
  const wrap = document.createElement('div');
  wrap.className = 'workspace-leaf';
  if (!pane) {
    wrap.classList.add('workspace-leaf-missing');
    wrap.innerHTML = `<div class="workspace-leaf-label">${escHtml(paneCode)} (missing from manifest)</div>`;
    return wrap;
  }
  const header = document.createElement('div');
  header.className = 'workspace-leaf-header';
  header.innerHTML = `
    <span class="workspace-leaf-label" title="${escHtml(pane.label || pane.code)}">${escHtml(pane.label || pane.code)}</span>
    <span class="workspace-leaf-status">connecting…</span>
  `;
  const termHost = document.createElement('div');
  termHost.className = 'workspace-leaf-term';
  wrap.appendChild(header);
  wrap.appendChild(termHost);

  const statusEl = header.querySelector('.workspace-leaf-status');
  startPaneSession({
    paneCode: pane.code,
    paneSecret: pane.secret,
    container: termHost,
    setStatus: (text, cls) => {
      statusEl.textContent = text;
      statusEl.className = `workspace-leaf-status${cls ? ' ' + cls : ''}`;
    },
    onFitNeeded: (fit) => wrap._fit = fit,
  });
  return wrap;
}

function fitAllInTree(treeEl) {
  for (const wrap of treeEl.querySelectorAll('.workspace-leaf')) {
    try { wrap._fit?.(); } catch {}
  }
}

// ── Per-leaf xterm + WS (parallel to viewer.mjs) ────────────────────────

const isCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const PARTICIPANT_ID = `wsviewer-${Math.random().toString(36).slice(2, 8)}`;

function startPaneSession({ paneCode, paneSecret, container, setStatus, onFitNeeded }) {
  const term = new window.Terminal({
    fontSize: isCoarsePointer ? 14 : 12,
    fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
    cursorBlink: true,
    disableStdin: true,
    convertEol: false,
    scrollback: 5000,
    rightClickSelectsWord: true,
    theme: { background: '#1e1e1e' },
  });
  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  const refit = () => { try { fitAddon.fit(); } catch {} };
  refit();
  onFitNeeded?.(refit);

  let ws = null;
  let helloDone = false;
  let permission = 'read';
  let inputDisposer = null;
  let attempt = 0;
  let userClosed = false;
  let reconnectTimer = null;

  const detachInput = () => {
    if (inputDisposer) { try { inputDisposer.dispose(); } catch {} inputDisposer = null; }
    term.options.disableStdin = true;
  };
  const attachInput = () => {
    if (inputDisposer) return;
    term.options.disableStdin = false;
    inputDisposer = term.onData((data) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const bytes = Array.from(new TextEncoder().encode(data));
      ws.send(JSON.stringify({ kind: 'input_chunk', from: PARTICIPANT_ID, bytes }));
    });
  };

  const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const WS_URL = `${wsProto}://${window.location.host}/ws/${encodeURIComponent(paneCode)}`;

  function connect({ isReconnect } = { isReconnect: false }) {
    if (isReconnect) term.reset();
    helloDone = false;
    detachInput();
    setStatus(isReconnect ? 'reconnecting…' : 'connecting…');
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
      attempt = 0;
      setStatus('authenticating…');
      ws.send(JSON.stringify({ kind: 'auth', secret: paneSecret }));
      ws.send(JSON.stringify({
        kind: 'hello',
        protocol_version: PROTOCOL_VERSION,
        participant: PARTICIPANT_ID,
      }));
    });

    ws.addEventListener('message', (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.kind === 'hello') {
        helloDone = true;
        setStatus(`connected (proto v${msg.protocol_version})`, 'ok');
        return;
      }
      if (msg.kind === 'capabilities') {
        permission = msg.permission ?? 'read';
        if (permission === 'read_write') {
          attachInput();
          setStatus('connected (rw)', 'ok');
        } else {
          detachInput();
          setStatus('connected (ro)', 'ok');
        }
        return;
      }
      if (msg.kind === 'output_chunk') {
        if (!helloDone) return;
        const bytes = Array.isArray(msg.bytes) ? msg.bytes : [];
        term.write(new Uint8Array(bytes));
      }
      if (msg.kind === 'agent_event') {
        appendWorkspaceAgentEvent(paneCode, msg.payload);
      }
    });

    ws.addEventListener('close', (evt) => {
      if (userClosed) { setStatus('closed', 'err'); return; }
      scheduleReconnect(evt.code);
    });
    ws.addEventListener('error', () => {
      if (!userClosed) setStatus('error — retrying', 'err');
    });
  }

  function scheduleReconnect(code) {
    if (reconnectTimer) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    setStatus(`disconnected${code ? ` (${code})` : ''} — retrying ${Math.round(delay / 1000)}s`, 'err');
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect({ isReconnect: true });
    }, delay);
  }

  window.addEventListener('beforeunload', () => { userClosed = true; ws?.close(); });
  connect();

  // Dispose hook so a layout-driven re-render closes the WS instead of
  // leaving it dangling on the server side.
  const dispose = () => {
    userClosed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
    try { term.dispose?.(); } catch {}
    activeLeafSessions.delete(dispose);
  };
  activeLeafSessions.add(dispose);
}

// ── Workspace timeline ─────────────────────────────────────────────────

const TIMELINE_MAX_ENTRIES = 200;
const TIMELINE_PREF = 'wmux.workspace.showTimeline';
const timelineListEl = document.getElementById('agent-timeline-list');
const timelineToggleEl = document.getElementById('timeline-toggle');

function fmtTime(ms) {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function shortPaneLabel(paneCode) {
  // The manifest fetch happens once per render; just show the first 4
  // chars of the pane code as a stable identifier.
  return String(paneCode).slice(0, 4);
}

function appendWorkspaceAgentEvent(paneCode, payload) {
  if (!timelineListEl || !payload || typeof payload !== 'object') return;
  const row = document.createElement('div');
  row.className = `agent-timeline-row agent-timeline-${payload.kind || 'unknown'}`;
  const time = fmtTime(payload.ts);
  let body = '';
  if (payload.kind === 'block_start') body = '▶ command started';
  else if (payload.kind === 'block_command') body = `▶ ${escHtml(payload.command ?? '').slice(0, 240)}`;
  else if (payload.kind === 'block_end') {
    const code = payload.exit_code;
    body = (code == null || code === 0) ? '✓ exit 0' : `✗ exit ${code}`;
  } else if (payload.kind === 'agent_hook') {
    const tool = payload.tool ? ` · ${escHtml(payload.tool)}` : '';
    const msg = payload.message ? ` — ${escHtml(payload.message).slice(0, 200)}` : '';
    body = `${escHtml(payload.hook_event ?? 'hook')}${tool}${msg}`;
  } else {
    body = escHtml(JSON.stringify(payload)).slice(0, 240);
  }
  row.innerHTML = `
    <span class="agent-timeline-time">${escHtml(time)}</span>
    <span class="agent-timeline-pane mono">${escHtml(shortPaneLabel(paneCode))}</span>
    <span class="agent-timeline-body">${body}</span>
  `;
  timelineListEl.appendChild(row);
  while (timelineListEl.childElementCount > TIMELINE_MAX_ENTRIES) {
    timelineListEl.firstElementChild?.remove();
  }
  const nearBottom = timelineListEl.scrollHeight - timelineListEl.scrollTop - timelineListEl.clientHeight < 40;
  if (nearBottom) timelineListEl.scrollTop = timelineListEl.scrollHeight;
}

function loadTimelinePref() {
  try { return localStorage.getItem(TIMELINE_PREF) !== '0'; } catch { return true; }
}
function saveTimelinePref(visible) {
  try { localStorage.setItem(TIMELINE_PREF, visible ? '1' : '0'); } catch {}
}
function applyTimelineVisibility(visible) {
  document.body.classList.toggle('timeline-hidden', !visible);
}
if (timelineToggleEl) {
  let visible = loadTimelinePref();
  applyTimelineVisibility(visible);
  timelineToggleEl.addEventListener('click', () => {
    visible = !visible;
    saveTimelinePref(visible);
    applyTimelineVisibility(visible);
  });
}
