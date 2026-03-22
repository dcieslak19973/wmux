import test from 'node:test';
import assert from 'node:assert/strict';

import {
  basenameFromPath,
  buildSerializedLayout,
  dirnameFromPath,
  resolveMarkdownPath,
} from '../src/layout_state.mjs';

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