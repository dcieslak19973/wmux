import test from 'node:test';
import assert from 'node:assert/strict';

import { worktreeBranchLabel, inheritedCwdForSplit } from '../src/worktree_state.mjs';

// ── worktreeBranchLabel ───────────────────────────────────────────────────────

test('worktreeBranchLabel returns null when no worktree is active', () => {
  assert.equal(worktreeBranchLabel(null, null), null);
  assert.equal(worktreeBranchLabel(null, { branch: 'main' }), null);
  assert.equal(worktreeBranchLabel(undefined, null), null);
  assert.equal(worktreeBranchLabel('', null), null);
});

test('worktreeBranchLabel prefers the gitContext branch when available', () => {
  const wt = 'C:\\Users\\dan\\.wmux\\worktrees\\wmux\\feat-foo';
  assert.equal(worktreeBranchLabel(wt, { branch: 'feat/foo' }), 'feat/foo');
  assert.equal(worktreeBranchLabel(wt, { branch: 'main' }), 'main');
});

test('worktreeBranchLabel falls back to last path segment on Windows paths', () => {
  const wt = 'C:\\Users\\dan\\.wmux\\worktrees\\wmux\\my-branch';
  assert.equal(worktreeBranchLabel(wt, null), 'my-branch');
  assert.equal(worktreeBranchLabel(wt, {}), 'my-branch');
  assert.equal(worktreeBranchLabel(wt, { branch: '' }), 'my-branch');
});

test('worktreeBranchLabel falls back to last path segment on POSIX paths', () => {
  assert.equal(worktreeBranchLabel('/home/dan/.wmux/worktrees/wmux/feat-bar', null), 'feat-bar');
});

test('worktreeBranchLabel falls back to "worktree" for degenerate paths', () => {
  assert.equal(worktreeBranchLabel('/', null), 'worktree');
  assert.equal(worktreeBranchLabel('C:\\', null), 'worktree');
});

// ── inheritedCwdForSplit ──────────────────────────────────────────────────────

test('inheritedCwdForSplit returns the pane worktreePath', () => {
  const path = 'C:\\Users\\dan\\.wmux\\worktrees\\wmux\\feat';
  assert.equal(inheritedCwdForSplit({ worktreePath: path }), path);
});

test('inheritedCwdForSplit returns null when the pane has no worktree', () => {
  assert.equal(inheritedCwdForSplit({ worktreePath: null }), null);
  assert.equal(inheritedCwdForSplit({ worktreePath: undefined }), null);
  assert.equal(inheritedCwdForSplit({}), null);
});

test('inheritedCwdForSplit is safe on null/undefined pane', () => {
  assert.equal(inheritedCwdForSplit(null), null);
  assert.equal(inheritedCwdForSplit(undefined), null);
});
