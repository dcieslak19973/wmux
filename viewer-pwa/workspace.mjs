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
})();

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

function renderSplitLayout(manifest) {
  rootEl.classList.add('workspace-split-mode');
  // Re-anchor: title bar stays in the topbar; main becomes the tree.
  rootEl.innerHTML = '';

  const paneInfo = new Map();
  for (const pane of manifest.panes) {
    paneInfo.set(pane.code, pane);
  }

  const treeRoot = renderNode(manifest.layout, paneInfo);
  treeRoot.classList.add('workspace-split-root');
  rootEl.appendChild(treeRoot);
  // Defer fits so xterm sees real dimensions.
  requestAnimationFrame(() => fitAllInTree(treeRoot));
  window.addEventListener('resize', () => fitAllInTree(treeRoot));
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

  return splitEl;
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
}
