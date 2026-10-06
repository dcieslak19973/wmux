/**
 * Pure kitty graphics protocol helpers for Unicode-placeholder (virtual)
 * placements: control-key parsing, chunk assembly, command routing, and
 * placeholder-cell decoding/geometry. No DOM or Tauri APIs — the xterm.js
 * wiring lives in kitty_graphics_runtime.mjs.
 *
 * Spec: https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
 */

export const PLACEHOLDER_CODEPOINT = 0x10eeee;

/**
 * Combining marks that encode row / column / id-high-byte on placeholder
 * cells, in index order. Source: kitty's rowcolumn-diacritics.txt.
 */
export const ROW_COLUMN_DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a,
  0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365,
  0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f,
  0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
  0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9,
  0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611, 0x0612, 0x0613, 0x0614, 0x0615,
  0x0616, 0x0617, 0x0657, 0x0658, 0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6,
  0x06d7, 0x06d8, 0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2,
  0x06e4, 0x06e7, 0x06e8, 0x06eb, 0x06ec, 0x0730, 0x0732, 0x0733, 0x0735, 0x0736,
  0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743, 0x0745, 0x0747, 0x0749, 0x074a,
  0x07eb, 0x07ec, 0x07ed, 0x07ee, 0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817,
  0x0818, 0x0819, 0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822,
  0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a, 0x082b, 0x082c, 0x082d, 0x0951,
  0x0953, 0x0954, 0x0f82, 0x0f83, 0x0f86, 0x0f87, 0x135d, 0x135e, 0x135f, 0x17dd,
  0x193a, 0x1a17, 0x1a75, 0x1a76, 0x1a77, 0x1a78, 0x1a79, 0x1a7a, 0x1a7b, 0x1a7c,
  0x1b6b, 0x1b6d, 0x1b6e, 0x1b6f, 0x1b70, 0x1b71, 0x1b72, 0x1b73, 0x1cd0, 0x1cd1,
  0x1cd2, 0x1cda, 0x1cdb, 0x1ce0, 0x1dc0, 0x1dc1, 0x1dc3, 0x1dc4, 0x1dc5, 0x1dc6,
  0x1dc7, 0x1dc8, 0x1dc9, 0x1dcb, 0x1dcc, 0x1dd1, 0x1dd2, 0x1dd3, 0x1dd4, 0x1dd5,
  0x1dd6, 0x1dd7, 0x1dd8, 0x1dd9, 0x1dda, 0x1ddb, 0x1ddc, 0x1ddd, 0x1dde, 0x1ddf,
  0x1de0, 0x1de1, 0x1de2, 0x1de3, 0x1de4, 0x1de5, 0x1de6, 0x1dfe, 0x20d0, 0x20d1,
  0x20d4, 0x20d5, 0x20d6, 0x20d7, 0x20db, 0x20dc, 0x20e1, 0x20e7, 0x20e9, 0x20f0,
  0x2cef, 0x2cf0, 0x2cf1, 0x2de0, 0x2de1, 0x2de2, 0x2de3, 0x2de4, 0x2de5, 0x2de6,
  0x2de7, 0x2de8, 0x2de9, 0x2dea, 0x2deb, 0x2dec, 0x2ded, 0x2dee, 0x2def, 0x2df0,
  0x2df1, 0x2df2, 0x2df3, 0x2df4, 0x2df5, 0x2df6, 0x2df7, 0x2df8, 0x2df9, 0x2dfa,
  0x2dfb, 0x2dfc, 0x2dfd, 0x2dfe, 0x2dff, 0xa66f, 0xa67c, 0xa67d, 0xa6f0, 0xa6f1,
  0xa8e0, 0xa8e1, 0xa8e2, 0xa8e3, 0xa8e4, 0xa8e5, 0xa8e6, 0xa8e7, 0xa8e8, 0xa8e9,
  0xa8ea, 0xa8eb, 0xa8ec, 0xa8ed, 0xa8ee, 0xa8ef, 0xa8f0, 0xa8f1, 0xaab0, 0xaab2,
  0xaab3, 0xaab7, 0xaab8, 0xaabe, 0xaabf, 0xaac1, 0xfe20, 0xfe21, 0xfe22, 0xfe23,
  0xfe24, 0xfe25, 0xfe26, 0x10a0f, 0x10a38, 0x1d185, 0x1d186, 0x1d187, 0x1d188, 0x1d189,
  0x1d1aa, 0x1d1ab, 0x1d1ac, 0x1d1ad, 0x1d242, 0x1d243, 0x1d244,
];

const DIACRITIC_INDEX = new Map(ROW_COLUMN_DIACRITICS.map((cp, i) => [cp, i]));

// Keys whose values are single characters rather than integers.
const CHAR_KEYS = new Set(['a', 't', 'o', 'd']);

/**
 * Split an APC G body (identifier already stripped) into control keys and the
 * base64 payload. `"a=T,i=1;AAAA"` → `{ keys: { a: 'T', i: 1 }, payload: 'AAAA' }`.
 */
export function parseKittyCommand(data) {
  const sep = data.indexOf(';');
  const control = sep === -1 ? data : data.slice(0, sep);
  const payload = sep === -1 ? '' : data.slice(sep + 1);
  const keys = {};
  for (const pair of control.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (CHAR_KEYS.has(key)) {
      keys[key] = value;
    } else {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) keys[key] = n;
    }
  }
  return { keys, payload };
}

/**
 * Decide who handles a (first-chunk) command:
 * - `own`: virtual placements and edits of images we hold; the xterm image
 *   addon never sees these.
 * - `copy`: transmit-only and delete commands; we mirror them (a later
 *   `a=p,U=1` may reference the image) and let the addon handle them too.
 * - `pass`: everything else (direct placements, queries) goes to the addon.
 */
export function routeKittyCommand(keys, ownsImage) {
  const action = keys.a ?? 't';
  if ((action === 'T' || action === 't' || action === 'p') && keys.U === 1) return 'own';
  if (action === 'f' && keys.i !== undefined && ownsImage(keys.i)) return 'own';
  if (action === 't' || action === 'd') return 'copy';
  return 'pass';
}

/**
 * Reassemble chunked (`m=1`) transmissions. Per spec, once a chunked
 * transmission starts every following G command is a continuation carrying
 * only `m` (and optionally `q`) until a chunk with `m=0` ends it; the route
 * decided on the first chunk applies to all of them. Payloads of `pass`
 * transmissions are not buffered (the addon keeps its own copy).
 */
export class KittyChunkAssembler {
  constructor() {
    this._pending = null;
  }

  /**
   * Feed one parsed command. Returns `{ route, keys, payload, complete }`;
   * `keys`/`payload` describe the whole transmission once `complete`.
   */
  feed(keys, payload, ownsImage) {
    if (this._pending) {
      const pending = this._pending;
      pending.parts?.push(payload);
      if (keys.m === 1) return { route: pending.route, complete: false };
      this._pending = null;
      return { route: pending.route, keys: pending.keys, payload: pending.parts?.join('') ?? '', complete: true };
    }
    const route = routeKittyCommand(keys, ownsImage);
    if (keys.m === 1) {
      this._pending = { route, keys, parts: route === 'pass' ? null : [payload] };
      return { route, complete: false };
    }
    return { route, keys, payload, complete: true };
  }

  reset() {
    this._pending = null;
  }
}

/**
 * Decode the combining marks of a placeholder cell's text. Returns `null` for
 * non-placeholder cells; otherwise `{ row, col, idHigh }` where a missing or
 * unknown diacritic is `-1`.
 */
export function decodePlaceholderChars(chars) {
  if (!chars || chars.codePointAt(0) !== PLACEHOLDER_CODEPOINT) return null;
  const marks = [];
  // U+10EEEE is a surrogate pair: marks start at index 2.
  for (let i = 2; i < chars.length && marks.length < 3;) {
    const cp = chars.codePointAt(i);
    marks.push(DIACRITIC_INDEX.get(cp) ?? -1);
    i += cp > 0xffff ? 2 : 1;
  }
  return { row: marks[0] ?? -1, col: marks[1] ?? -1, idHigh: marks[2] ?? -1 };
}

/**
 * Apply kitty's inheritance rules to a decoded cell given the resolved cell
 * immediately to its left on the same line (or `null`). `imageId` is the low
 * 24 bits from the foreground colour. Returns `{ imageId, row, col }`.
 *
 * - No diacritics: continue the left cell (same row, next column, same id).
 * - Row only: next column if the left cell has the same row and id, else 0.
 * - Missing id-high byte: inherited from the left cell when it continues it.
 */
export function resolvePlaceholderCell(decoded, imageId, left) {
  const continues = (row) => left && (left.imageId & 0xffffff) === imageId && (row === -1 || left.row === row);
  let { row, col, idHigh } = decoded;
  if (row === -1) {
    if (continues(-1)) return { imageId: left.imageId, row: left.row, col: left.col + 1 };
    return { imageId, row: 0, col: 0 };
  }
  if (col === -1) col = continues(row) ? left.col + 1 : 0;
  if (idHigh === -1) idHigh = continues(row) ? left.imageId >>> 24 : 0;
  return { imageId: ((idHigh << 24) >>> 0) + imageId, row, col };
}

/** Grid size of a virtual placement: explicit `c`/`r`, else the image's natural cell extent. */
export function placementGrid(keys, imageWidth, imageHeight, cellWidth, cellHeight) {
  return {
    cols: keys.c > 0 ? keys.c : Math.max(1, Math.ceil(imageWidth / cellWidth)),
    rows: keys.r > 0 ? keys.r : Math.max(1, Math.ceil(imageHeight / cellHeight)),
  };
}

/**
 * Source/destination rectangles for drawing a horizontal run of placeholder
 * cells (`row`, columns `col`..`col + count - 1`) of a placement whose image
 * is scaled to fit the `cols`×`rows` cell box, preserving aspect ratio and
 * centred (kitty semantics). Destination is relative to the run's first
 * cell's top-left. Returns `null` when the run lies entirely in letterbox.
 */
export function placeholderRunRect({ imageWidth, imageHeight, cols, rows, cellWidth, cellHeight, row, col, count }) {
  const boxW = cols * cellWidth;
  const boxH = rows * cellHeight;
  const scale = Math.min(boxW / imageWidth, boxH / imageHeight);
  const imgX = (boxW - imageWidth * scale) / 2;
  const imgY = (boxH - imageHeight * scale) / 2;
  const runX = col * cellWidth;
  const runY = row * cellHeight;
  const x0 = Math.max(runX, imgX);
  const y0 = Math.max(runY, imgY);
  const x1 = Math.min(runX + count * cellWidth, imgX + imageWidth * scale);
  const y1 = Math.min(runY + cellHeight, imgY + imageHeight * scale);
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    sx: (x0 - imgX) / scale,
    sy: (y0 - imgY) / scale,
    sw: (x1 - x0) / scale,
    sh: (y1 - y0) / scale,
    dx: x0 - runX,
    dy: y0 - runY,
    dw: x1 - x0,
    dh: y1 - y0,
  };
}
