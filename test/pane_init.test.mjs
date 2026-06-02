import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePaneInitialState,
  defaultPaneShellFlavor,
  MAX_TRANSCRIPT_CHARS,
  MAX_HISTORY_ENTRIES,
} from '../src/pane_init.mjs';

const LOCAL = { type: 'local' };
const WSL   = { type: 'wsl', distro: 'Ubuntu' };
const SSH   = { type: 'ssh', host: 'dev@example.com' };

// ── normalizePaneInitialState — CWD ──────────────────────────────────────────

test('restoredCwd is null for a fresh pane with no initialState', () => {
  const { restoredCwd, restoredPreviousCwd } = normalizePaneInitialState(LOCAL, {});
  assert.equal(restoredCwd, '');
  assert.equal(restoredPreviousCwd, '');
});

test('restoredCwd is sanitized for local target (windows path preserved)', () => {
  const { restoredCwd } = normalizePaneInitialState(LOCAL, { cwd: 'D:\\git\\wmux' });
  assert.equal(restoredCwd, 'D:\\git\\wmux');
});

test('restoredCwd is sanitized for WSL target (linux path preserved)', () => {
  const { restoredCwd } = normalizePaneInitialState(WSL, { cwd: '/home/dan/project' });
  assert.equal(restoredCwd, '/home/dan/project');
});

test('restoredCwd rejects a Windows path for WSL target (wrong OS path)', () => {
  const { restoredCwd } = normalizePaneInitialState(WSL, { cwd: 'C:\\Users\\dan' });
  assert.equal(restoredCwd, '');
});

test('restoredCwd extracts leading linux path from noisy WSL prompt string', () => {
  const { restoredCwd } = normalizePaneInitialState(WSL, {
    cwd: '/home/dan$ (base) dan@DESKTOP:~',
  });
  assert.equal(restoredCwd, '/home/dan');
});

test('undefined initialState treated as empty (no crash)', () => {
  assert.doesNotThrow(() => normalizePaneInitialState(LOCAL, undefined));
  const { restoredCwd, history, screenSnapshot, outputSnapshot } =
    normalizePaneInitialState(LOCAL, undefined);
  assert.equal(restoredCwd, '');
  assert.deepEqual(history, []);
  assert.equal(screenSnapshot, '');
  assert.equal(outputSnapshot, '');
});

// ── normalizePaneInitialState — history ──────────────────────────────────────

test('history is empty array when not provided', () => {
  const { history } = normalizePaneInitialState(LOCAL, {});
  assert.deepEqual(history, []);
});

test('history is empty array when initialState.history is not an array', () => {
  assert.deepEqual(normalizePaneInitialState(LOCAL, { history: null }).history, []);
  assert.deepEqual(normalizePaneInitialState(LOCAL, { history: 'oops' }).history, []);
});

test('history entries are normalized and blank/null entries filtered out', () => {
  const { history } = normalizePaneInitialState(LOCAL, {
    // null/undefined → '' → filtered; numbers coerced to string and kept
    history: ['git status', '  ', null, undefined, 'npm test'],
  });
  assert.deepEqual(history, ['git status', 'npm test']);
});

test('numeric history entries are coerced to strings (String() coercion in normalizeHistoryEntry)', () => {
  const { history } = normalizePaneInitialState(LOCAL, { history: [42] });
  assert.deepEqual(history, ['42']);
});

test(`history is capped at ${MAX_HISTORY_ENTRIES} entries (keeps newest)`, () => {
  const entries = Array.from({ length: MAX_HISTORY_ENTRIES + 10 }, (_, i) => `cmd-${i}`);
  const { history } = normalizePaneInitialState(LOCAL, { history: entries });
  assert.equal(history.length, MAX_HISTORY_ENTRIES);
  assert.equal(history[0], `cmd-10`); // oldest kept
  assert.equal(history[history.length - 1], `cmd-${MAX_HISTORY_ENTRIES + 9}`); // newest
});

// ── normalizePaneInitialState — snapshots ────────────────────────────────────

test('screenSnapshot defaults to empty string when not a string', () => {
  assert.equal(normalizePaneInitialState(LOCAL, { screenSnapshot: null }).screenSnapshot, '');
  assert.equal(normalizePaneInitialState(LOCAL, { screenSnapshot: 42 }).screenSnapshot, '');
});

test('screenSnapshot is preserved verbatim when a string', () => {
  const snap = '\x1b[2J\x1b[H$ hello';
  assert.equal(normalizePaneInitialState(LOCAL, { screenSnapshot: snap }).screenSnapshot, snap);
});

test('outputSnapshot defaults to empty string when not a string', () => {
  assert.equal(normalizePaneInitialState(LOCAL, { outputSnapshot: null }).outputSnapshot, '');
});

test(`outputSnapshot is trimmed to last ${MAX_TRANSCRIPT_CHARS} chars`, () => {
  const long = 'x'.repeat(MAX_TRANSCRIPT_CHARS + 500);
  const { outputSnapshot } = normalizePaneInitialState(LOCAL, { outputSnapshot: long });
  assert.equal(outputSnapshot.length, MAX_TRANSCRIPT_CHARS);
  // kept the tail, not the head
  assert.equal(outputSnapshot, 'x'.repeat(MAX_TRANSCRIPT_CHARS));
});

test('outputSnapshot has terminal control sequences normalized', () => {
  // normalizeTerminalTranscript applies backspaces; verify it runs
  const { outputSnapshot } = normalizePaneInitialState(LOCAL, { outputSnapshot: 'ab\x08c' });
  assert.equal(outputSnapshot, 'ac');
});

// ── defaultPaneShellFlavor ────────────────────────────────────────────────────

test('local target gets powershell flavor', () => {
  assert.equal(defaultPaneShellFlavor(LOCAL), 'powershell');
  assert.equal(defaultPaneShellFlavor(null), 'powershell');
  assert.equal(defaultPaneShellFlavor(undefined), 'powershell');
});

test('WSL target gets bash flavor', () => {
  assert.equal(defaultPaneShellFlavor(WSL), 'bash');
});

test('SSH target gets bash flavor', () => {
  assert.equal(defaultPaneShellFlavor(SSH), 'bash');
});

test('remote_tmux target gets powershell flavor (not a shell-managed pane)', () => {
  assert.equal(defaultPaneShellFlavor({ type: 'remote_tmux' }), 'powershell');
});
