// CEF embedded surface (Path B / OSR-via-screencast).
//
// Hosts a CEF helper's rendered output inside a wmux pane via a <canvas>.
// The helper itself runs as a top-level Chromium window positioned far
// off-screen (Win32 SetWindowPos at -30000,-30000) so the user doesn't see
// it. We capture its rendered viewport with CDP `Page.startScreencast`
// (JPEG over WebSocket) and paint each frame into the canvas.
//
// v0 scope: read-only embed. No input forwarding, no URL bar, no popups.
// Just prove the pixel pipeline works visibly.

import { invoke } from '@tauri-apps/api/core';

const CDP_FETCH_RETRY_MS = 200;
const CDP_FETCH_MAX_ATTEMPTS = 30;

/**
 * Create a CEF-embedded surface in `mountEl` showing `url`.
 *
 * Returns an object with `dispose()` to tear down (kill helper, close WS).
 */
export async function createCefEmbeddedSurface(mountEl, url, { quality = 80 } = {}) {
  // --- 1. Spawn helper offscreen --------------------------------------------
  // `spawn_browser_helper` is the same Tauri command the existing CEF button
  // uses; we just pass offscreen=true so the window goes off-screen instead
  // of floating.
  const spawned = await invoke('spawn_browser_helper', {
    windowLabel: '',
    url,
    offscreen: true,
  });
  const port = spawned.cdp_port;

  // --- 2. Build the canvas mount --------------------------------------------
  // Wrap in a container so we can show loading state + future overlays
  // (URL bar, cursor, etc.) without nesting concerns into the canvas itself.
  const container = document.createElement('div');
  container.className = 'cef-embedded';
  container.style.cssText =
    'position:relative;width:100%;height:100%;background:#0c0c0f;overflow:hidden;';
  const status = document.createElement('div');
  status.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;'
    + 'color:#9ca3af;font-size:12px;pointer-events:none;';
  status.textContent = 'Starting CEF helper…';
  const canvas = document.createElement('canvas');
  // CSS sizing: fill the pane. We'll set the internal pixel buffer when we
  // know the actual size (after mount).
  canvas.style.cssText = 'display:block;width:100%;height:100%;background:#0c0c0f;';
  container.appendChild(canvas);
  container.appendChild(status);
  mountEl.appendChild(container);

  const ctx = canvas.getContext('2d');
  // Match the canvas pixel buffer to its rendered CSS size so the screencast
  // frames map 1:1. We'll re-sync on resize.
  function syncCanvasSize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  }
  syncCanvasSize();

  // --- 3. Find the page target and open a WebSocket -------------------------
  // CDP exposes /json with the list of targets; we want the first `type=page`.
  // CEF may take a moment after spawn before /json responds with a page —
  // poll with short retries.
  const target = await fetchCdpPageTarget(port);
  if (!target) {
    status.textContent = 'CDP target not found — helper may have failed to start';
    return makeDisposable(spawned.label, null, container);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let nextRequestId = 1;
  let frameCount = 0;
  let lastFrameAt = 0;

  ws.addEventListener('open', () => {
    status.textContent = 'Connected — waiting for first frame…';
    // Send the screencast start with our current canvas dimensions. CEF will
    // re-render at maxWidth/maxHeight, so this keeps JPEG size bounded.
    sendCdp('Page.startScreencast', {
      format: 'jpeg',
      quality,
      maxWidth: canvas.width,
      maxHeight: canvas.height,
      everyNthFrame: 1,
    });
  });

  ws.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.method === 'Page.screencastFrame') {
      onFrame(msg.params);
    }
  });

  ws.addEventListener('error', () => {
    status.textContent = 'WebSocket error — CDP connection lost';
    status.style.color = '#ef4444';
  });

  ws.addEventListener('close', () => {
    if (!container.isConnected) return; // dispose path
    status.textContent = 'CDP disconnected';
    status.style.color = '#9ca3af';
  });

  function sendCdp(method, params) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ id: nextRequestId++, method, params: params ?? {} }));
  }

  function onFrame({ data, sessionId, metadata }) {
    frameCount += 1;
    lastFrameAt = performance.now();
    if (status.parentElement) status.remove();
    // Each frame is base64 JPEG. Decode via Image() — modern browsers
    // pipeline this efficiently, and drawImage handles JPEG natively.
    const img = new Image();
    img.onload = () => {
      // Draw at the canvas's pixel size; the frame may be smaller if CEF
      // rendered to a tighter buffer.
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // ack so CEF sends the next one; without this, screencast stalls.
      sendCdp('Page.screencastFrameAck', { sessionId });
    };
    img.onerror = () => {
      // Still ack on decode failure so we don't deadlock the stream.
      sendCdp('Page.screencastFrameAck', { sessionId });
    };
    img.src = 'data:image/jpeg;base64,' + data;
    // Reserved for future: metadata has scrollOffsetX/Y, pageScaleFactor,
    // deviceWidth/Height — useful when we wire input forwarding so click
    // coordinates correctly translate.
    void metadata;
  }

  // --- 4. Handle resize -----------------------------------------------------
  // When the pane resizes, we need to tell CEF to render to the new size.
  // ResizeObserver gives us the canvas's new dimensions; we re-issue
  // startScreencast with updated maxWidth/maxHeight (CDP doesn't have a
  // "resize" call — restart is the documented pattern).
  const resizeObserver = new ResizeObserver(() => {
    syncCanvasSize();
    if (ws.readyState === WebSocket.OPEN) {
      sendCdp('Page.stopScreencast');
      sendCdp('Page.startScreencast', {
        format: 'jpeg',
        quality,
        maxWidth: canvas.width,
        maxHeight: canvas.height,
        everyNthFrame: 1,
      });
    }
  });
  resizeObserver.observe(canvas);

  return {
    label: spawned.label,
    cdpPort: port,
    canvas,
    container,
    stats: () => ({ frameCount, lastFrameAt }),
    dispose: () => {
      resizeObserver.disconnect();
      try { if (ws.readyState === WebSocket.OPEN) sendCdp('Page.stopScreencast'); } catch {}
      try { ws.close(); } catch {}
      invoke('kill_browser_helper', { label: spawned.label }).catch(() => {});
      if (container.parentElement) container.remove();
    },
  };
}

async function fetchCdpPageTarget(port) {
  for (let attempt = 0; attempt < CDP_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json`);
      if (resp.ok) {
        const targets = await resp.json();
        const page = Array.isArray(targets) && targets.find((t) => t.type === 'page');
        if (page && page.webSocketDebuggerUrl) return page;
      }
    } catch {
      // Helper may not have CDP up yet — retry below.
    }
    await new Promise((r) => setTimeout(r, CDP_FETCH_RETRY_MS));
  }
  return null;
}

function makeDisposable(label, ws, container) {
  return {
    label,
    canvas: null,
    container,
    stats: () => ({ frameCount: 0, lastFrameAt: 0 }),
    dispose: () => {
      try { ws?.close(); } catch {}
      invoke('kill_browser_helper', { label }).catch(() => {});
      if (container?.parentElement) container.remove();
    },
  };
}
