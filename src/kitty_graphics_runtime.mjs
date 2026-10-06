/**
 * Kitty graphics Unicode-placeholder support for an xterm.js Terminal.
 *
 * @xterm/addon-image handles direct kitty placements but not virtual ones
 * (`U=1`), which Claude Code UI plugins such as terminal-browser rely on.
 * This module takes over virtual placements and frame edits (`a=f`) of the
 * images it holds, and paints those images over U+10EEEE placeholder cells on
 * an overlay canvas. Everything else falls through to the addon's handler.
 *
 * Must be installed after `term.loadAddon(imageAddon)`: xterm.js tries the
 * most recently registered APC handler first.
 */
import {
  PLACEHOLDER_CODEPOINT,
  KittyChunkAssembler,
  decodePlaceholderChars,
  parseKittyCommand,
  placeholderRunRect,
  placementGrid,
  resolvePlaceholderCell,
} from './kitty_graphics_state.mjs';

function base64ToBytes(b64) {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decode a transmission payload into a canvas holding its pixels. */
async function decodePixels(keys, payload) {
  let bytes = base64ToBytes(payload);
  if (keys.o === 'z') bytes = await inflate(bytes);
  const format = keys.f ?? 32;
  if (format === 100) {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }
  const width = keys.s;
  const height = keys.v;
  const stride = format === 24 ? 3 : 4;
  if (!(width > 0 && height > 0) || (format !== 24 && format !== 32) || bytes.length < width * height * stride) {
    throw new Error('EINVAL:bad image dimensions or data');
  }
  let rgba = bytes;
  if (format === 24) {
    rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) {
      rgba[j] = bytes[i];
      rgba[j + 1] = bytes[i + 1];
      rgba[j + 2] = bytes[i + 2];
      rgba[j + 3] = 255;
    }
  }
  const data = new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, width * height * 4), width, height);
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').putImageData(data, 0, 0);
  return canvas;
}

let installCount = 0;

export function installKittyPlaceholders(term) {
  /** id → { canvas, placement: {c, r} | null } — placement set once virtually placed. */
  const images = new Map();
  const assembler = new KittyChunkAssembler();
  const ownsImage = (id) => images.has(id);
  let overlay = null;
  let frame = 0;
  let painted = false;

  const respond = (keys, message) => {
    if (keys.i === undefined) return;
    const quiet = keys.q ?? 0;
    if (quiet >= 2 || (quiet === 1 && message === 'OK')) return;
    const placement = keys.p ? `,p=${keys.p}` : '';
    term.input(`\x1b_Gi=${keys.i}${placement};${message}\x1b\\`, false);
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };

  const deleteImages = (keys) => {
    const what = keys.d ?? 'a';
    if (what === 'a' || what === 'A') images.clear();
    else if ((what === 'i' || what === 'I') && keys.i !== undefined) images.delete(keys.i);
    schedule();
  };

  const editFrame = async (keys, payload) => {
    const image = images.get(keys.i);
    if (!image) throw new Error('ENOENT:image not found');
    if (keys.r !== undefined && keys.r !== 1) throw new Error('ENOTSUP:only root frame edits are supported');
    const region = await decodePixels(keys, payload);
    const ctx = image.canvas.getContext('2d');
    const x = keys.x ?? 0;
    const y = keys.y ?? 0;
    // X=1: replace pixels; otherwise alpha-blend onto the frame.
    if (keys.X === 1) ctx.clearRect(x, y, region.width, region.height);
    ctx.drawImage(region, x, y);
  };

  /** Run a complete own/copy command. Resolves once the image state is updated. */
  const apply = async (route, keys, payload) => {
    const action = keys.a ?? 't';
    if (action === 'd') return deleteImages(keys);
    if (keys.i === undefined) return; // image numbers (I=) are not supported for virtual placements
    try {
      if (action === 'T' || action === 't') {
        if ((keys.t ?? 'd') !== 'd') throw new Error('EINVAL:only direct transmission is supported');
        const canvas = await decodePixels(keys, payload);
        const placement = action === 'T' && keys.U === 1 ? { c: keys.c, r: keys.r } : null;
        images.set(keys.i, { canvas, placement });
      } else if (action === 'p') {
        const image = images.get(keys.i);
        if (!image) throw new Error('ENOENT:image not found');
        image.placement = { c: keys.c, r: keys.r };
      } else if (action === 'f') {
        await editFrame(keys, payload);
      }
      if (route === 'own') respond(keys, 'OK');
    } catch (err) {
      const message = String(err?.message ?? err);
      if (route === 'own') respond(keys, message.includes(':') ? message : `EINVAL:${message}`);
    }
    schedule();
  };

  const apcHandler = term.parser.registerApcHandler({ final: 'G' }, (data) => {
    const { keys, payload } = parseKittyCommand(data);
    const step = assembler.feed(keys, payload, ownsImage);
    if (step.route === 'pass') {
      // A direct re-transmit reuses the id: our virtual copy is now stale.
      if (step.complete && step.keys.a === 'T' && images.delete(step.keys.i)) schedule();
      return false;
    }
    if (!step.complete) return step.route === 'own';
    return apply(step.route, step.keys, step.payload).then(() => step.route === 'own');
  });

  const ensureOverlay = () => {
    const screen = term.element?.querySelector('.xterm-screen');
    if (!screen) return null;
    if (!overlay || overlay.parentElement !== screen) {
      overlay = document.createElement('canvas');
      overlay.className = 'wmux-kitty-placeholder-layer';
      overlay.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
      screen.appendChild(overlay);
    }
    return overlay;
  };

  // The DOM renderer draws a run of same-coloured cells as one text span, so
  // placeholder glyphs (tofu + unsupported combining marks) can overflow past
  // the overlay. Make text in a placed image's id colour transparent. The
  // renderer sets RGB foregrounds as an inline style, which the browser
  // re-serialises as `color: rgb(r, g, b)` once letter-spacing is added.
  const scope = `wmux-kitty-${++installCount}`;
  let glyphStyle = null;
  let hiddenSelectors = '';
  const hidePlaceholderGlyphs = () => {
    const selectors = [...images]
      .filter(([, image]) => image.placement)
      .map(([id]) => {
        const rgb = id & 0xffffff;
        const prefix = `[data-wmux-kitty="${scope}"] .xterm-rows span`;
        return `${prefix}[style*="color: rgb(${rgb >> 16}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff})"],`
          + `${prefix}[style*="color:#${rgb.toString(16).padStart(6, '0')};"]`;
      })
      .sort()
      .join(',');
    if (selectors === hiddenSelectors || !term.element) return;
    hiddenSelectors = selectors;
    term.element.dataset.wmuxKitty = scope;
    glyphStyle ??= term.element.appendChild(document.createElement('style'));
    glyphStyle.textContent = selectors ? `${selectors} { color: transparent !important; }` : '';
  };

  /**
   * Cell size in CSS and device pixels (device may be fractional). Images are
   * laid out in device pixels (kitty semantics: one image pixel per screen
   * pixel) on an overlay backed at device resolution.
   */
  const metrics = () => {
    const css = term._core?._renderService?.dimensions?.css?.cell;
    if (!(css?.width > 0)) return null;
    const dpr = window.devicePixelRatio || 1;
    return {
      css: { width: css.width, height: css.height },
      device: { width: css.width * dpr, height: css.height * dpr },
    };
  };

  /** Cell background as a CSS colour, so placeholder glyphs never show through. */
  const backgroundOf = (cell) => {
    if (cell.isBgRGB()) return `#${cell.getBgColor().toString(16).padStart(6, '0')}`;
    return term.options.theme?.background ?? '#000000';
  };

  function paint() {
    frame = 0;
    hidePlaceholderGlyphs();
    let anyPlaced = false;
    for (const image of images.values()) if (image.placement) { anyPlaced = true; break; }
    if (!anyPlaced && !painted) return;
    const canvas = ensureOverlay();
    const m = metrics();
    if (!canvas || !m) return;
    const cell = m.device;
    const pxW = Math.round(cell.width * term.cols);
    const pxH = Math.round(cell.height * term.rows);
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
      canvas.style.width = `${m.css.width * term.cols}px`;
      canvas.style.height = `${m.css.height * term.rows}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, pxW, pxH);
    ctx.imageSmoothingQuality = 'high';
    painted = anyPlaced;
    if (!anyPlaced) return;

    const buffer = term.buffer.active;
    const scratch = buffer.getNullCell();
    // Fractional device cell sizes: snap every edge to whole pixels so rows
    // drawn separately tile without anti-aliased seams between them.
    const fillSnapped = (x0, y0, x1, y1) => {
      const left = Math.round(x0);
      const top = Math.round(y0);
      ctx.fillRect(left, top, Math.round(x1) - left, Math.round(y1) - top);
    };
    const drawRun = (run) => {
      const image = images.get(run.imageId);
      if (!image?.placement) return;
      const runX = run.x * cell.width;
      const runY = run.y * cell.height;
      ctx.fillStyle = run.background;
      fillSnapped(runX, runY, runX + run.count * cell.width, runY + cell.height);
      const { width, height } = image.canvas;
      const grid = placementGrid(image.placement, width, height, cell.width, cell.height);
      const rect = placeholderRunRect({
        imageWidth: width, imageHeight: height, cols: grid.cols, rows: grid.rows,
        cellWidth: cell.width, cellHeight: cell.height, row: run.row, col: run.col, count: run.count,
      });
      if (!rect) return;
      const left = Math.round(runX + rect.dx);
      const top = Math.round(runY + rect.dy);
      const right = Math.round(runX + rect.dx + rect.dw);
      const bottom = Math.round(runY + rect.dy + rect.dh);
      ctx.drawImage(image.canvas, rect.sx, rect.sy, rect.sw, rect.sh, left, top, right - left, bottom - top);
    };

    for (let y = 0; y < term.rows; y++) {
      const line = buffer.getLine(buffer.viewportY + y);
      if (!line) continue;
      let left = null;
      let run = null;
      for (let x = 0; x < term.cols; x++) {
        line.getCell(x, scratch);
        const chars = scratch.getChars();
        const decoded = chars.length >= 2 && chars.codePointAt(0) === PLACEHOLDER_CODEPOINT
          ? decodePlaceholderChars(chars)
          : null;
        // Image id lives in the foreground colour: 24-bit RGB or a 256-colour index.
        const low = decoded && (scratch.isFgRGB() || scratch.isFgPalette()) ? scratch.getFgColor() : 0;
        if (!low) {
          if (run) drawRun(run);
          run = null;
          left = null;
          continue;
        }
        const resolved = resolvePlaceholderCell(decoded, low, left);
        left = resolved;
        if (run && run.imageId === resolved.imageId && run.row === resolved.row && run.col + run.count === resolved.col) {
          run.count++;
        } else {
          if (run) drawRun(run);
          run = { x, y, imageId: resolved.imageId, row: resolved.row, col: resolved.col, count: 1, background: backgroundOf(scratch) };
        }
      }
      if (run) drawRun(run);
    }
  }

  // Pixel-size reports in device pixels (as kitty/ghostty do) so graphics apps
  // render images at screen resolution; xterm.js would answer in CSS pixels,
  // which get upscaled (blurry) on HiDPI displays.
  const sizeReportHandler = term.parser.registerCsiHandler({ final: 't' }, (params) => {
    const m = metrics();
    if (!m || params.length !== 1) return false;
    if (params[0] === 14) {
      term.input(`\x1b[4;${Math.round(m.device.height * term.rows)};${Math.round(m.device.width * term.cols)}t`, false);
      return true;
    }
    if (params[0] === 16) {
      term.input(`\x1b[6;${Math.round(m.device.height)};${Math.round(m.device.width)}t`, false);
      return true;
    }
    return false;
  });

  const renderSub = term.onRender(schedule);
  const resizeSub = term.onResize(schedule);

  return {
    dispose() {
      apcHandler.dispose();
      sizeReportHandler.dispose();
      renderSub.dispose();
      resizeSub.dispose();
      if (frame) cancelAnimationFrame(frame);
      overlay?.remove();
      glyphStyle?.remove();
      images.clear();
    },
  };
}
