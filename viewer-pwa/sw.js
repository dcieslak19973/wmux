// Minimal service worker — caches the viewer shell so the PWA installs.
// Live output is always over the WebSocket; we never cache /ws/ or /s/<code>
// because those have per-session state.

const CACHE = 'wmux-viewer-v9';
const SHELL = [
  './',
  './viewer.mjs',
  './viewer.css',
  './xterm.js',
  './xterm.css',
  './addon-fit.js',
  './addon-canvas.js',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  // Take over as soon as the new shell is cached, rather than waiting for
  // every open tab to close — otherwise a viewer.mjs change won't reach an
  // already-installed client until they fully quit the browser.
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Don't intercept the WS handshake or the per-session viewer entry.
  if (url.pathname.startsWith('/ws/')) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
