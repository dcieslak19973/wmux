// CEF embedded surface (Path B / OSR-via-screencast).
//
// Hosts a CEF helper's rendered output inside a wmux pane via a <canvas>.
// The helper itself runs as a top-level Chromium window positioned far
// off-screen (Win32 SetWindowPos at -30000,-30000) so the user doesn't see
// it. We capture its rendered viewport with CDP `Page.startScreencast`
// (JPEG over WebSocket) and paint each frame into the canvas.
//
// v1 scope: read+write embed. Mouse, keyboard, wheel forwarded via
// CDP Input.dispatchMouseEvent / Input.dispatchKeyEvent. No URL bar
// or popups yet.

import { invoke } from '@tauri-apps/api/core';

/**
 * Create a CEF-embedded surface in `mountEl` showing `url`.
 *
 * Returns an object with `dispose()` to tear down (kill helper, close WS).
 */
export async function createCefEmbeddedSurface(mountEl, url) {
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
  // Match the canvas pixel buffer to device pixels (CSS pixels × DPR) so
  // that on high-DPI displays the canvas doesn't internally upscale a
  // smaller buffer. We'll also tell CEF to render at this size via
  // Emulation.setDeviceMetricsOverride so screencast frames arrive at
  // matching resolution — drawImage then does no upscaling and text
  // stays crisp.
  function getCanvasDims() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const wCss = Math.max(1, Math.round(rect.width));
    const hCss = Math.max(1, Math.round(rect.height));
    return {
      wCss,
      hCss,
      dpr,
      wDev: Math.round(wCss * dpr),
      hDev: Math.round(hCss * dpr),
    };
  }
  function syncCanvasSize() {
    const { wDev, hDev } = getCanvasDims();
    if (canvas.width !== wDev) canvas.width = wDev;
    if (canvas.height !== hDev) canvas.height = hDev;
  }
  syncCanvasSize();

  // Make the canvas focusable so it receives keyboard events.
  canvas.tabIndex = 0;
  canvas.style.outline = 'none';
  canvas.style.cursor = 'default';

  // --- 3. Find the page target and open a WebSocket -------------------------
  // Discover the page target's WebSocket URL via a Tauri command rather than
  // a JS fetch. CDP's HTTP /json endpoint doesn't return CORS headers, so
  // the cross-origin fetch from http://localhost:1420 (vite dev) → 127.0.0.1
  // is blocked by the browser. The WebSocket connection itself works
  // cross-origin because the helper is spawned with --remote-allow-origins=*.
  let wsUrl;
  try {
    wsUrl = await invoke('find_cdp_page_ws_url', { port });
  } catch (err) {
    status.textContent = `CDP discovery failed: ${err}`;
    console.warn('[cef-embed] find_cdp_page_ws_url failed', { port, err });
    return makeDisposable(spawned.label, null, container);
  }

  const ws = new WebSocket(wsUrl);
  let nextRequestId = 1;
  let frameCount = 0;
  let lastFrameAt = 0;

  ws.addEventListener('open', () => {
    status.textContent = 'Connected — waiting for first frame…';
    sendCdp('Page.enable');
    // Force the page to the foreground in Chromium's eyes. With the helper
    // window moved off-screen, the renderer can otherwise decide the page
    // is hidden and pause the compositor — see the matching --disable
    // flags on the helper spawn path. bringToFront is the belt to those
    // flags' suspenders.
    sendCdp('Page.bringToFront');
    // Tell CEF to render the page at the canvas's actual device-pixel
    // dimensions. Without this, the helper renders at its native window
    // size (~800×600 default popup) and screencast hands us a small JPEG
    // that we then scale up — blurry text. With it, the rendered viewport
    // matches the screencast capture matches the canvas buffer, 1:1.
    const dims = getCanvasDims();
    sendCdp('Emulation.setDeviceMetricsOverride', {
      width: dims.wCss,
      height: dims.hCss,
      deviceScaleFactor: dims.dpr,
      mobile: false,
    });
    // JPEG q=95 trades a tiny bit of text fidelity (vs PNG) for much
    // lower per-frame bytes — at q=95 the artifacts are essentially
    // invisible in normal use, and the wire savings keep frame rate up.
    sendCdp('Page.startScreencast', {
      format: 'jpeg',
      quality: 95,
      maxWidth: dims.wDev,
      maxHeight: dims.hDev,
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
    } else if (msg.id && msg.error) {
      // Surface CDP request errors — silent killers otherwise.
      console.warn('[cef-embed] CDP error', msg);
    }
  });
  ws.addEventListener('error', (e) => {
    console.warn('[cef-embed] WebSocket error', e);
    status.textContent = 'WebSocket error — CDP connection lost';
    status.style.color = '#ef4444';
  });

  ws.addEventListener('close', (e) => {
    if (!container.isConnected) return; // legitimate dispose — silent
    console.warn('[cef-embed] WebSocket closed unexpectedly', {
      code: e.code, reason: e.reason, wasClean: e.wasClean,
    });
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

  // --- 4. Input forwarding --------------------------------------------------
  // Canvas events → CDP Input.dispatchMouseEvent / Input.dispatchKeyEvent.
  // Coordinates: the canvas has both an internal pixel buffer size
  // (canvas.width/height) and a CSS rendered size (getBoundingClientRect).
  // We told CEF to render at the pixel-buffer size, so events captured in
  // CSS pixels need scaling. In v1 we assume the two match because we
  // sync them in syncCanvasSize() — but use a helper anyway in case a
  // device pixel ratio difference creeps in later.
  function eventToPagePoint(e) {
    // CDP Input.dispatchMouseEvent x/y are CSS-pixel coordinates against
    // the viewport set via Emulation.setDeviceMetricsOverride. Don't apply
    // the canvas-to-device-pixel scaling here — clientX/Y minus the rect
    // origin is already in CSS pixels.
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(e.clientX - rect.left),
      y: Math.round(e.clientY - rect.top),
    };
  }
  function mouseEventModifiers(e) {
    // CDP modifiers bitmask: 1=Alt, 2=Ctrl, 4=Meta, 8=Shift.
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }
  function mouseButton(e) {
    // CDP wants the *name* of the button (not the JS numeric code):
    //   0 = left, 1 = middle, 2 = right.
    return ['left', 'middle', 'right'][e.button] ?? 'left';
  }

  let lastMouseButton = 'none';
  let clickCount = 0;
  let lastClickAt = 0;
  let lastClickPos = { x: 0, y: 0 };

  canvas.addEventListener('mousedown', (e) => {
    e.preventDefault();
    canvas.focus();
    const pt = eventToPagePoint(e);
    const button = mouseButton(e);
    lastMouseButton = button;
    // Track click count for double/triple click — CEF uses this to
    // decide on word/line selection.
    const now = performance.now();
    if (now - lastClickAt < 500 && Math.hypot(pt.x - lastClickPos.x, pt.y - lastClickPos.y) < 4) {
      clickCount += 1;
    } else {
      clickCount = 1;
    }
    lastClickAt = now;
    lastClickPos = pt;
    sendCdp('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: pt.x,
      y: pt.y,
      button,
      buttons: e.buttons,
      clickCount,
      modifiers: mouseEventModifiers(e),
    });
  });
  canvas.addEventListener('mouseup', (e) => {
    e.preventDefault();
    const pt = eventToPagePoint(e);
    sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: pt.x,
      y: pt.y,
      button: mouseButton(e),
      buttons: e.buttons,
      clickCount,
      modifiers: mouseEventModifiers(e),
    });
    lastMouseButton = 'none';
  });
  canvas.addEventListener('mousemove', (e) => {
    const pt = eventToPagePoint(e);
    sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: pt.x,
      y: pt.y,
      button: e.buttons ? lastMouseButton : 'none',
      buttons: e.buttons,
      modifiers: mouseEventModifiers(e),
    });
  });
  canvas.addEventListener('contextmenu', (e) => {
    // Don't show wmux's right-click menu over the embedded page.
    e.preventDefault();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pt = eventToPagePoint(e);
    // CDP and JS WheelEvent use the same sign convention: positive deltaY
    // means "scroll content down" (= reveal content below). Browser wheel
    // events are in pixels by default (deltaMode=0); for line-mode (1) and
    // page-mode (2) we apply rough multipliers — enough for the v1 spike.
    let dx = e.deltaX;
    let dy = e.deltaY;
    if (e.deltaMode === 1) { dx *= 16; dy *= 16; }
    if (e.deltaMode === 2) { dx *= canvas.width; dy *= canvas.height; }
    sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: pt.x,
      y: pt.y,
      deltaX: dx,
      deltaY: dy,
      modifiers: mouseEventModifiers(e),
    });
  }, { passive: false });

  // Keyboard. CDP Input.dispatchKeyEvent takes:
  //   type: keyDown / keyUp / char / rawKeyDown
  //   key: KeyboardEvent.key
  //   code: KeyboardEvent.code
  //   windowsVirtualKeyCode: legacy keyCode (good enough on Windows)
  //   text: for printable chars, the actual character (sent on keydown)
  //   modifiers: same bitmask as mouse
  function keyEventModifiers(e) {
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }
  canvas.addEventListener('keydown', (e) => {
    // Don't preventDefault for browser shortcuts that we WANT to forward
    // (Ctrl-C, Ctrl-V, etc.) — CDP handles them inside the page. Do
    // preventDefault on common navigation keys so the wmux UI doesn't
    // also scroll / page-down behind the canvas.
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Space', 'Tab'].includes(e.key) || e.key === ' ') {
      e.preventDefault();
    }
    const isChar = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    sendCdp('Input.dispatchKeyEvent', {
      type: isChar ? 'keyDown' : 'rawKeyDown',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      modifiers: keyEventModifiers(e),
      text: isChar ? e.key : undefined,
      unmodifiedText: isChar ? e.key : undefined,
    });
  });
  canvas.addEventListener('keyup', (e) => {
    sendCdp('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      modifiers: keyEventModifiers(e),
    });
  });

  // --- 5. Handle resize -----------------------------------------------------
  // When the pane resizes, we need to tell CEF to render to the new size.
  // ResizeObserver gives us the canvas's new dimensions; we re-issue
  // startScreencast with updated maxWidth/maxHeight (CDP doesn't have a
  // "resize" call — restart is the documented pattern).
  const resizeObserver = new ResizeObserver(() => {
    syncCanvasSize();
    if (ws.readyState === WebSocket.OPEN) {
      const dims = getCanvasDims();
      sendCdp('Page.stopScreencast');
      sendCdp('Emulation.setDeviceMetricsOverride', {
        width: dims.wCss,
        height: dims.hCss,
        deviceScaleFactor: dims.dpr,
        mobile: false,
      });
      sendCdp('Page.startScreencast', {
        format: 'jpeg',
        quality: 95,
        maxWidth: dims.wDev,
        maxHeight: dims.hDev,
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
