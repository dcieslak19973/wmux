import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROW_COLUMN_DIACRITICS,
  KittyChunkAssembler,
  decodePlaceholderChars,
  parseKittyCommand,
  placeholderRunRect,
  placementGrid,
  resolvePlaceholderCell,
  routeKittyCommand,
} from '../src/kitty_graphics_state.mjs';

const PH = String.fromCodePoint(0x10eeee);
const mark = (i) => String.fromCodePoint(ROW_COLUMN_DIACRITICS[i]);
const none = () => false;

// ── parseKittyCommand ────────────────────────────────────────────────────────

test('parseKittyCommand splits control keys from payload and types values', () => {
  const { keys, payload } = parseKittyCommand('a=T,f=32,o=z,t=d,i=7,U=1,c=80,r=24,q=2,m=1;QUJD');
  assert.deepEqual(keys, { a: 'T', f: 32, o: 'z', t: 'd', i: 7, U: 1, c: 80, r: 24, q: 2, m: 1 });
  assert.equal(payload, 'QUJD');
});

test('parseKittyCommand handles commands without a payload', () => {
  assert.deepEqual(parseKittyCommand('a=d,d=I,i=3,q=2'), { keys: { a: 'd', d: 'I', i: 3, q: 2 }, payload: '' });
});

// ── routeKittyCommand ────────────────────────────────────────────────────────

test('virtual placements are owned; direct placements and queries pass to the addon', () => {
  assert.equal(routeKittyCommand({ a: 'T', i: 1, U: 1 }, none), 'own');
  assert.equal(routeKittyCommand({ a: 'p', i: 1, U: 1 }, none), 'own');
  assert.equal(routeKittyCommand({ a: 'T', i: 1 }, none), 'pass');
  assert.equal(routeKittyCommand({ a: 'p', i: 1 }, none), 'pass');
  assert.equal(routeKittyCommand({ a: 'q', i: 1 }, none), 'pass');
});

test('transmit-only and delete are mirrored; default action is transmit', () => {
  assert.equal(routeKittyCommand({ a: 't', i: 1 }, none), 'copy');
  assert.equal(routeKittyCommand({ i: 1 }, none), 'copy');
  assert.equal(routeKittyCommand({ a: 'd', d: 'A' }, none), 'copy');
});

test('frame edits are owned only for images we hold', () => {
  assert.equal(routeKittyCommand({ a: 'f', i: 5 }, (id) => id === 5), 'own');
  assert.equal(routeKittyCommand({ a: 'f', i: 6 }, (id) => id === 5), 'pass');
});

// ── KittyChunkAssembler ──────────────────────────────────────────────────────

test('chunked transmission keeps the first chunk keys and route, joining payloads', () => {
  const asm = new KittyChunkAssembler();
  const first = parseKittyCommand('a=T,i=9,U=1,m=1;AAA');
  assert.deepEqual(asm.feed(first.keys, first.payload, none), { route: 'own', complete: false });
  assert.deepEqual(asm.feed({ m: 1 }, 'BBB', none), { route: 'own', complete: false });
  const done = asm.feed({ m: 0 }, 'CC', none);
  assert.equal(done.complete, true);
  assert.equal(done.route, 'own');
  assert.equal(done.keys.i, 9);
  assert.equal(done.payload, 'AAABBBCC');
});

test('continuation chunks of a passed transmission stay passed without buffering', () => {
  const asm = new KittyChunkAssembler();
  assert.equal(asm.feed({ a: 'T', i: 2, m: 1 }, 'AAA', none).route, 'pass');
  // A continuation carries no U=1 yet must not be re-routed.
  const done = asm.feed({ m: 0 }, 'BBB', none);
  assert.equal(done.route, 'pass');
  assert.equal(done.payload, '');
  // The next command starts fresh.
  assert.equal(asm.feed({ a: 'p', i: 2, U: 1 }, '', none).route, 'own');
});

// ── decodePlaceholderChars / resolvePlaceholderCell ──────────────────────────

test('decodePlaceholderChars reads row, column and id-high diacritics', () => {
  assert.deepEqual(decodePlaceholderChars(PH + mark(3) + mark(296) + mark(1)), { row: 3, col: 296, idHigh: 1 });
  assert.deepEqual(decodePlaceholderChars(PH + mark(0)), { row: 0, col: -1, idHigh: -1 });
  assert.deepEqual(decodePlaceholderChars(PH + 'x'), { row: -1, col: -1, idHigh: -1 });
  assert.equal(decodePlaceholderChars('a'), null);
});

test('cells without diacritics continue the cell to their left', () => {
  const left = { imageId: 42, row: 2, col: 5 };
  assert.deepEqual(resolvePlaceholderCell({ row: -1, col: -1, idHigh: -1 }, 42, left), { imageId: 42, row: 2, col: 6 });
  // Different image id on the left: start a new run at the origin.
  assert.deepEqual(resolvePlaceholderCell({ row: -1, col: -1, idHigh: -1 }, 43, left), { imageId: 43, row: 0, col: 0 });
});

test('row-only cells take the next column only when the left cell shares the row', () => {
  const left = { imageId: 42, row: 2, col: 5 };
  assert.deepEqual(resolvePlaceholderCell({ row: 2, col: -1, idHigh: -1 }, 42, left), { imageId: 42, row: 2, col: 6 });
  assert.deepEqual(resolvePlaceholderCell({ row: 3, col: -1, idHigh: -1 }, 42, left), { imageId: 42, row: 3, col: 0 });
});

test('id-high diacritic supplies bits 24-31 and is inherited along a run', () => {
  const first = resolvePlaceholderCell({ row: 0, col: 0, idHigh: 2 }, 7, null);
  assert.equal(first.imageId, (2 << 24) + 7);
  assert.equal(resolvePlaceholderCell({ row: 0, col: 1, idHigh: -1 }, 7, first).imageId, (2 << 24) + 7);
});

// ── geometry ─────────────────────────────────────────────────────────────────

test('placementGrid prefers explicit c/r and otherwise covers the image', () => {
  assert.deepEqual(placementGrid({ c: 10, r: 4 }, 999, 999, 8, 16), { cols: 10, rows: 4 });
  assert.deepEqual(placementGrid({}, 81, 33, 8, 16), { cols: 11, rows: 3 });
});

test('placeholderRunRect maps cells onto an exactly-fitting image', () => {
  // 80x32 image in a 10x2 box of 8x16 cells: scale 1, no letterbox.
  const rect = placeholderRunRect({ imageWidth: 80, imageHeight: 32, cols: 10, rows: 2, cellWidth: 8, cellHeight: 16, row: 1, col: 2, count: 3 });
  assert.deepEqual(rect, { sx: 16, sy: 16, sw: 24, sh: 16, dx: 0, dy: 0, dw: 24, dh: 16 });
});

test('placeholderRunRect centres a narrower image and skips letterbox cells', () => {
  // 40x32 image in an 80x32 box: scale 1, 20px bars left and right.
  const geom = { imageWidth: 40, imageHeight: 32, cols: 10, rows: 2, cellWidth: 8, cellHeight: 16, row: 0 };
  assert.equal(placeholderRunRect({ ...geom, col: 0, count: 2 }), null);
  assert.deepEqual(placeholderRunRect({ ...geom, col: 2, count: 1 }), { sx: 0, sy: 0, sw: 4, sh: 16, dx: 4, dy: 0, dw: 4, dh: 16 });
});

test('placeholderRunRect scales source pixels to the box', () => {
  // 160x64 image in an 80x32 box: scale 0.5.
  const rect = placeholderRunRect({ imageWidth: 160, imageHeight: 64, cols: 10, rows: 2, cellWidth: 8, cellHeight: 16, row: 1, col: 9, count: 1 });
  assert.deepEqual(rect, { sx: 144, sy: 32, sw: 16, sh: 32, dx: 0, dy: 0, dw: 8, dh: 16 });
});
