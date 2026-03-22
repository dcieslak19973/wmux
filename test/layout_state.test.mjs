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