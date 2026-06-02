import test from 'node:test';
import assert from 'node:assert/strict';

import {
  basenameFromPath,
  buildSerializedLayout,
  dirnameFromPath,
  resolveMarkdownPath,
} from '../src/layout_state.mjs';
import {
  buildRestoredTerminalState,
  buildTerminalPaneSnapshot,
} from '../src/layout_runtime.mjs';

test('resolveMarkdownPath preserves absolute paths and joins relative paths', () => {
  assert.equal(resolveMarkdownPath('README.md', 'C:\\repo\\docs'), 'C:\\repo\\docs\\README.md');
  assert.equal(resolveMarkdownPath('/tmp/file.md', 'C:\\repo\\docs'), '/tmp/file.md');
  assert.equal(resolveMarkdownPath('notes.md', '/repo/docs'), '/repo/docs/notes.md');
  assert.equal(resolveMarkdownPath('  ', '/repo/docs'), '');
});

test('path helpers return expected basename and dirname', () => {
  assert.equal(basenameFromPath('C:\\repo\\docs\\README.md'), 'README.md');
  assert.equal(dirnameFromPath('C:\\repo\\docs\\README.md'), 'C:\\repo\\docs');
  assert.equal(dirnameFromPath('README.md'), '');
});

test('buildSerializedLayout preserves pinned workspaces and active tab selections', () => {
  const workspaces = [
    { id: 'ws-1', name: 'Pinned', pinned: true, themeId: 'forest', lastActiveTabId: 'tab-2' },
    { id: 'ws-2', name: 'Loose', pinned: false, themeId: 'ember', lastActiveTabId: 'missing' },
  ];
  const tabs = [
    { tabId: 'tab-1', workspaceId: 'ws-1', title: 'one' },
    { tabId: 'tab-2', workspaceId: 'ws-1', title: 'two' },
    { tabId: 'tab-3', workspaceId: 'ws-2', title: 'three' },
  ];

  const layout = buildSerializedLayout({
    workspaces,
    tabs,
    activeWorkspaceId: 'ws-2',
    notifPanelTabId: 'tab-2',
    serializeTabState: (tab) => ({ title: tab.title }),
  });

  assert.equal(layout.version, 4);
  assert.equal(layout.activeWorkspaceIndex, 1);
  assert.deepEqual(layout.workspaces.map((ws) => ws.pinned), [true, false]);
  assert.deepEqual(layout.workspaces.map((ws) => ws.themeId), ['forest', 'ember']);
  assert.deepEqual(layout.workspaces[0].tabs, [{ title: 'one' }, { title: 'two' }]);
  assert.equal(layout.workspaces[0].activeTabIndex, 1);
  assert.equal(layout.workspaces[1].activeTabIndex, 0);
  assert.deepEqual(layout.ui.notifPanel, { workspaceIndex: 0, tabIndex: 1 });
});

test('buildSerializedLayout omits notif panel state when no tab is targeted', () => {
  const layout = buildSerializedLayout({
    workspaces: [{ id: 'ws-1', name: 'Main', pinned: false, lastActiveTabId: null }],
    tabs: [],
    activeWorkspaceId: 'ws-1',
    notifPanelTabId: null,
    serializeTabState: () => {
      throw new Error('serializeTabState should not be called without tabs');
    },
  });

  assert.equal(layout.ui.notifPanel, null);
  assert.deepEqual(layout.workspaces[0].tabs, []);
});

test('buildTerminalPaneSnapshot preserves terminal restore payload fields', () => {
  const pane = {
    target: { type: 'wsl', distro: 'Ubuntu' },
    cwd: 'C:\\repo\\docs',
    previousCwd: 'C:\\repo',
    history: ['git status', 'npm test'],
    screenSnapshot: 'visible screen buffer',
    outputSnapshot: 'plain text transcript',
    labelOverride: 'Docs shell',
    lastSessionVaultEntryId: 'vault-123',
  };

  const snapshot = buildTerminalPaneSnapshot(pane);

  assert.deepEqual(snapshot, {
    kind: 'terminal',
    target: { type: 'wsl', distro: 'Ubuntu' },
    cwd: 'C:\\repo\\docs',
    previousCwd: 'C:\\repo',
    history: ['git status', 'npm test'],
    screenSnapshot: 'visible screen buffer',
    outputSnapshot: 'plain text transcript',
    labelOverride: 'Docs shell',
    vaultEntryId: 'vault-123',
  });
  assert.notEqual(snapshot.history, pane.history);
});

test('buildRestoredTerminalState normalizes terminal restore payload fields', () => {
  const node = {
    cwd: '/repo',
    previousCwd: '/repo/prev',
    history: ['ls'],
    screenSnapshot: 'visible restore',
    outputSnapshot: 'restored output',
    labelOverride: 'Main shell',
    vaultEntryId: 'vault-abc',
  };

  const restored = buildRestoredTerminalState(node);

  assert.deepEqual(restored, {
    cwd: '/repo',
    previousCwd: '/repo/prev',
    history: ['ls'],
    screenSnapshot: 'visible restore',
    outputSnapshot: 'restored output',
    labelOverride: 'Main shell',
    vaultEntryId: 'vault-abc',
  });
  assert.notEqual(restored.history, node.history);
  assert.deepEqual(buildRestoredTerminalState({}), {
    cwd: '',
    previousCwd: '',
    history: [],
    screenSnapshot: '',
    outputSnapshot: '',
    labelOverride: null,
    vaultEntryId: null,
  });
});
// ── Round-trip: buildTerminalPaneSnapshot → buildRestoredTerminalState ────────
//
// The critical contract: every data field that buildTerminalPaneSnapshot writes
// must be readable by buildRestoredTerminalState — and vice versa. Key parity
// catches the common bug of adding a field to one side and forgetting the other,
// or silently renaming across the boundary.
//
// Intentional non-identity in the round-trip:
//   • `kind` and `target` are dropped by restore (createLeafPane receives target
//     as a separate arg — not via initialState).
//   • `lastSessionVaultEntryId` (pane) → `vaultEntryId` (snapshot/restore) is a
//     deliberate rename; both sides must agree on that name.

const SNAPSHOT_RESTORABLE_KEYS = [
  'cwd', 'previousCwd', 'history', 'screenSnapshot', 'outputSnapshot',
  'labelOverride', 'vaultEntryId',
];

test('snapshot restorable keys match the keys buildRestoredTerminalState reads', () => {
  const pane = {
    target: { type: 'local' },
    cwd: '/home/user/repo',
    previousCwd: '/home/user',
    history: ['npm test'],
    screenSnapshot: 'screen',
    outputSnapshot: 'output',
    labelOverride: 'shell',
    lastSessionVaultEntryId: 'v-1',
  };
  const snapshot = buildTerminalPaneSnapshot(pane);
  const snapshotRestorableKeys = Object.keys(snapshot)
    .filter((k) => k !== 'kind' && k !== 'target')
    .sort();
  assert.deepEqual(
    snapshotRestorableKeys,
    [...SNAPSHOT_RESTORABLE_KEYS].sort(),
    'snapshot has unexpected or missing restorable keys — did you add a field to one side only?',
  );
});

test('round-trip preserves all restorable string and array fields', () => {
  const pane = {
    target: { type: 'local' },
    cwd: '/home/user/wmux',
    previousCwd: '/home/user',
    history: ['git log', 'npm test', 'cargo clippy'],
    screenSnapshot: '\x1b[32m$\x1b[0m visible buffer',
    outputSnapshot: 'prior output',
    labelOverride: 'Main',
    lastSessionVaultEntryId: 'vault-xyz',
  };

  const snapshot = buildTerminalPaneSnapshot(pane);
  const restored = buildRestoredTerminalState(snapshot);

  assert.equal(restored.cwd,            pane.cwd);
  assert.equal(restored.previousCwd,    pane.previousCwd);
  assert.deepEqual(restored.history,    pane.history);
  assert.equal(restored.screenSnapshot, pane.screenSnapshot);
  assert.equal(restored.outputSnapshot, pane.outputSnapshot);
  assert.equal(restored.labelOverride,  pane.labelOverride);
  // The rename: pane.lastSessionVaultEntryId → snapshot.vaultEntryId → restored.vaultEntryId
  assert.equal(
    restored.vaultEntryId,
    pane.lastSessionVaultEntryId,
    'vaultEntryId rename: pane.lastSessionVaultEntryId must survive as restored.vaultEntryId',
  );
  // Each boundary makes a fresh copy of the history array.
  assert.notEqual(restored.history, pane.history);
  assert.notEqual(restored.history, snapshot.history);
});

test('round-trip with null/missing pane fields produces safe defaults', () => {
  const pane = { target: { type: 'local' } };
  const restored = buildRestoredTerminalState(buildTerminalPaneSnapshot(pane));

  assert.equal(restored.cwd,            '');
  assert.equal(restored.previousCwd,    '');
  assert.deepEqual(restored.history,    []);
  assert.equal(restored.screenSnapshot, '');
  assert.equal(restored.outputSnapshot, '');
  assert.equal(restored.labelOverride,  null);
  assert.equal(restored.vaultEntryId,   null);
});

test('round-trip through normalizePaneInitialState preserves CWD and history', async () => {
  // Close the loop to what actually lands in the pane — confirm no field is
  // silently dropped between the serialization boundaries. Does not re-test
  // normalization logic itself (covered in pane_init.test.mjs).
  const { normalizePaneInitialState } = await import('../src/pane_init.mjs');
  // Use a WSL target so the Linux paths pass sanitizeCwdForTarget validation.
  const pane = {
    target: { type: 'wsl', distro: 'Ubuntu' },
    cwd: '/home/user/project',
    previousCwd: '/home/user',
    history: ['npm test'],
    screenSnapshot: '',
    outputSnapshot: '',
    labelOverride: null,
    lastSessionVaultEntryId: null,
  };

  const restored = buildRestoredTerminalState(buildTerminalPaneSnapshot(pane));
  const { restoredCwd, restoredPreviousCwd, history } =
    normalizePaneInitialState({ type: 'wsl', distro: 'Ubuntu' }, restored);

  assert.equal(restoredCwd,         pane.cwd);
  assert.equal(restoredPreviousCwd, pane.previousCwd);
  assert.deepEqual(history,         pane.history);
});
