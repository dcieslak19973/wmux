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

const term = new window.Terminal({
  fontSize: 13,
  fontFamily: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
  cursorBlink: true,
  disableStdin: true,
  convertEol: false,
  scrollback: 5000,
  theme: { background: '#1e1e1e' },
});
const fitAddon = new window.FitAddon.FitAddon();
term.loadAddon(fitAddon);
term.open(termEl);
fitAddon.fit();
window.addEventListener('resize', () => fitAddon.fit());

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
let attempt = 0;
let userClosed = false;
let reconnectTimer = null;

function connect({ isReconnect } = { isReconnect: false }) {
  if (isReconnect) {
    // Avoid duplicate paint of the snapshot+replay the host re-sends.
    term.reset();
  }
  helloDone = false;
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
