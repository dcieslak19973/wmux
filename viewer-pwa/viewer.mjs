// wmux PWA viewer.
// Connects to /ws/:code, authenticates with the secret from the URL
// fragment, exchanges Hello, then renders OutputChunks into an xterm.js
// terminal. Read-only for Phase 1.

const PROTOCOL_VERSION = 1;

const statusEl = document.getElementById('status');
const termEl = document.getElementById('term');

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = `status${cls ? ' ' + cls : ''}`;
}

// Bump the default font on touch-pointer devices so xterm.js renders at
// a thumb-friendly size on phones without forcing the page-zoom.
const isCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
// disableStdin starts true (read-only by default); the Capabilities frame
// from the server upgrades it to false when the share is Read-Write.
const term = new window.Terminal({
  fontSize: isCoarsePointer ? 15 : 13,
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
term.open(termEl);
fitAddon.fit();

// iOS Safari fires both 'resize' and 'orientationchange' on rotate;
// belt-and-suspenders. Also fits when the visual viewport changes
// (e.g. when the virtual keyboard appears, which shouldn't happen here
// because input is disabled, but mobile browsers sometimes nudge it).
function refit() { fitAddon.fit(); }
window.addEventListener('resize', refit);
window.addEventListener('orientationchange', refit);
window.visualViewport?.addEventListener('resize', refit);

// Prevent double-tap-to-zoom on the terminal (iOS Safari default).
// Pinch-zoom on the page still works via the viewport meta.
termEl.addEventListener('touchend', (e) => {
  if (e.touches.length === 0 && e.changedTouches.length === 1) {
    e.preventDefault();
  }
}, { passive: false });

// Parse the share URL: /s/<code> with secret in the fragment as #t=<secret>
const pathParts = window.location.pathname.split('/').filter(Boolean);
const code = pathParts[1] || '';
const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
const params = new URLSearchParams(hash);
const secret = params.get('t') || '';

if (!code || !secret) {
  setStatus('bad share URL — missing code or secret', 'err');
  throw new Error('missing code/secret');
}

const wsProto = window.location.protocol === 'https:' ? 'wss' : 'ws';
const WS_URL = `${wsProto}://${window.location.host}/ws/${encodeURIComponent(code)}`;
const PARTICIPANT_ID = `viewer-${Math.random().toString(36).slice(2, 8)}`;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];

let ws = null;
let helloDone = false;
let permission = 'read';
let inputDisposer = null; // term.onData disposer for the active session
let attempt = 0;
let userClosed = false;
let reconnectTimer = null;

function detachInput() {
  if (inputDisposer) {
    try { inputDisposer.dispose(); } catch {}
    inputDisposer = null;
  }
  term.options.disableStdin = true;
}

function attachInput() {
  if (inputDisposer) return;
  term.options.disableStdin = false;
  // term.onData fires with the raw string the user typed. Send it as
  // bytes (UTF-8) over the WS for the host PTY.
  inputDisposer = term.onData((data) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const bytes = Array.from(new TextEncoder().encode(data));
    ws.send(JSON.stringify({
      kind: 'input_chunk',
      from: PARTICIPANT_ID,
      bytes,
    }));
  });
}

function connect({ isReconnect } = { isReconnect: false }) {
  if (isReconnect) {
    // Avoid duplicate paint of the snapshot+replay the host re-sends.
    term.reset();
  }
  helloDone = false;
  detachInput();
  setStatus(isReconnect ? 'reconnecting…' : 'connecting…');
  ws = new WebSocket(WS_URL);

  ws.addEventListener('open', () => {
    attempt = 0;
    setStatus('authenticating…');
    ws.send(JSON.stringify({ kind: 'auth', secret }));
    ws.send(JSON.stringify({
      kind: 'hello',
      protocol_version: PROTOCOL_VERSION,
      participant: PARTICIPANT_ID,
    }));
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch {
      return;
    }
    if (msg.kind === 'hello') {
      helloDone = true;
      setStatus(`connected (proto v${msg.protocol_version})`, 'ok');
      return;
    }
    if (msg.kind === 'capabilities') {
      permission = msg.permission ?? 'read';
      if (permission === 'read_write') {
        attachInput();
        setStatus('connected (read-write)', 'ok');
      } else {
        detachInput();
        setStatus('connected (read-only)', 'ok');
      }
      return;
    }
    if (msg.kind === 'output_chunk') {
      if (!helloDone) return;
      const bytes = Array.isArray(msg.bytes) ? msg.bytes : [];
      term.write(new Uint8Array(bytes));
    }
    if (msg.kind === 'agent_event') {
      appendAgentEvent(msg.payload);
    }
  });

  ws.addEventListener('close', (evt) => {
    if (userClosed) {
      setStatus('closed', 'err');
      return;
    }
    scheduleReconnect(evt.code);
  });

  ws.addEventListener('error', () => {
    if (!userClosed) setStatus('connection error — retrying', 'err');
  });
}

function scheduleReconnect(code) {
  if (reconnectTimer) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
  attempt += 1;
  setStatus(`disconnected${code ? ` (${code})` : ''} — reconnecting in ${Math.round(delay / 1000)}s`, 'err');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect({ isReconnect: true });
  }, delay);
}

window.addEventListener('beforeunload', () => {
  userClosed = true;
  ws?.close();
});

connect();

// Register the service worker so the page is installable as a PWA. Service
// worker registration is best-effort — if it fails (e.g. served over plain
// http where SW is restricted to localhost), the viewer still works.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ── Agent timeline (Phase 5) ────────────────────────────────────────────

const TIMELINE_MAX_ENTRIES = 200;
const timelineEl = document.getElementById('agent-timeline');
const timelineListEl = document.getElementById('agent-timeline-list');
const timelineToggleEl = document.getElementById('timeline-toggle');
const TIMELINE_PREF = 'wmux.viewer.showTimeline';

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fmtTime(ms) {
  if (typeof ms !== 'number') return '';
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function appendAgentEvent(payload) {
  if (!payload || typeof payload !== 'object') return;
  const row = document.createElement('div');
  row.className = `agent-timeline-row agent-timeline-${payload.kind || 'unknown'}`;
  const time = fmtTime(payload.ts);
  let body = '';
  if (payload.kind === 'block_start') {
    body = '▶ command started';
  } else if (payload.kind === 'block_command') {
    body = `▶ ${escHtml(payload.command ?? '').slice(0, 240)}`;
  } else if (payload.kind === 'block_end') {
    const code = payload.exit_code;
    const ok = code == null || code === 0;
    body = ok ? '✓ exit 0' : `✗ exit ${code}`;
  } else if (payload.kind === 'agent_hook') {
    const tool = payload.tool ? ` · ${escHtml(payload.tool)}` : '';
    const msg = payload.message ? ` — ${escHtml(payload.message).slice(0, 200)}` : '';
    body = `${escHtml(payload.hook_event ?? 'hook')}${tool}${msg}`;
  } else {
    body = escHtml(JSON.stringify(payload)).slice(0, 240);
  }
  row.innerHTML = `<span class="agent-timeline-time">${escHtml(time)}</span><span class="agent-timeline-body">${body}</span>`;
  timelineListEl.appendChild(row);
  // Cap entries; drop oldest from the top.
  while (timelineListEl.childElementCount > TIMELINE_MAX_ENTRIES) {
    timelineListEl.firstElementChild?.remove();
  }
  // Auto-scroll to newest unless user has scrolled up to read history.
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
  // xterm reflows when its container width changes.
  setTimeout(() => fitAddon.fit(), 60);
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
