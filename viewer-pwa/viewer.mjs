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
const ws = new WebSocket(`${wsProto}://${window.location.host}/ws/${encodeURIComponent(code)}`);
let helloDone = false;

ws.addEventListener('open', () => {
  setStatus('authenticating…');
  ws.send(JSON.stringify({ kind: 'auth', secret }));
  ws.send(JSON.stringify({
    kind: 'hello',
    protocol_version: PROTOCOL_VERSION,
    participant: `viewer-${Math.random().toString(36).slice(2, 8)}`,
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
    // bytes is JSON-encoded Vec<u8> from the host — an array of numbers.
    const bytes = Array.isArray(msg.bytes) ? msg.bytes : [];
    // Convert to Uint8Array → Latin-1 string (xterm.js handles UTF-8 via write()).
    const buf = new Uint8Array(bytes);
    // xterm.js accepts Uint8Array directly in write().
    term.write(buf);
  }
  // input_chunk / layout_delta: host doesn't send these to the viewer.
});

ws.addEventListener('close', (evt) => {
  setStatus(`disconnected${evt.code ? ` (${evt.code})` : ''}`, 'err');
});

ws.addEventListener('error', () => {
  setStatus('connection error', 'err');
});

// Register the service worker so the page is installable as a PWA. Service
// worker registration is best-effort — if it fails (e.g. served over plain
// http where SW is restricted to localhost), the viewer still works.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
