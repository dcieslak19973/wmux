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
attachRenderer(term);
fitAddon.fit();

// Use the 2D-canvas renderer to kill the DOM renderer's glyph artifacts and
// repaint flicker (both composite each frame to a single surface, so there's
// nothing to tear). We deliberately do NOT use the WebGL renderer here: in
// embedded webviews it can create a WebGL2 context successfully yet paint
// nothing — a silent blank that no try/catch or onContextLoss can catch. The
// canvas renderer has no GPU-context dependency, so it works wherever a share
// link is opened. If even canvas init fails we fall back to xterm's default
// DOM renderer (flickery but functional).
function attachRenderer(t) {
  try {
    t.loadAddon(new window.CanvasAddon.CanvasAddon());
  } catch {
    // Leave the default DOM renderer in place.
  }
}

// iOS Safari fires both 'resize' and 'orientationchange' on rotate;
// belt-and-suspenders. Also fits when the visual viewport changes
// (e.g. when the virtual keyboard appears, which shouldn't happen here
// because input is disabled, but mobile browsers sometimes nudge it).
// Coalesce bursts of resize events into a single fit per animation frame —
// iOS fires resize+orientationchange+visualViewport together on rotate, and
// each synchronous fit() reflows the terminal, which flickers.
let refitScheduled = false;
function refit() {
  // Host-driven sizing wins once the host announces its grid: we mirror it
  // and letterbox, so window resizes must NOT re-fit (that's what left
  // uncleared cells before). Until the first Resize frame, fit() gives a
  // sensible default.
  if (hostSized || refitScheduled) return;
  refitScheduled = true;
  requestAnimationFrame(() => {
    refitScheduled = false;
    // A Resize frame may have arrived while this frame was queued — if so,
    // the host now drives sizing and we must not fit() over it (that's the
    // "slipping out of letterbox" symptom).
    if (hostSized) return;
    try { fitAddon.fit(); } catch {}
  });
}
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
// Once the host announces its grid size (Resize frame), we mirror it exactly
// and stop fit()ing to our own viewport — the host's clears/redraws only span
// the host grid, so any extra rows/cols we'd add would never get cleared.
let hostSized = false;

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
    if (msg.kind === 'resize') {
      const cols = msg.cols | 0;
      const rows = msg.rows | 0;
      if (cols > 0 && rows > 0) {
        hostSized = true;
        try { term.resize(cols, rows); } catch {}
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
