import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOOK_STALE_MS, BLOCKED_MIN_MS, BLOCKED_MAX_MS,
  looksLikeShellPrompt,
  computeAgentState,
  hasLiveHookState,
} from '../src/agent_state.mjs';

// ── looksLikeShellPrompt ─────────────────────────────────────────────────────

test('looksLikeShellPrompt returns true for bash/zsh/root prompts', () => {
  assert.equal(looksLikeShellPrompt('user@host:~/repo$ '), true);
  assert.equal(looksLikeShellPrompt('user@host:~/repo% '), true);
  assert.equal(looksLikeShellPrompt('root@host:/# '), true);
});

test('looksLikeShellPrompt returns false for agent interactive menus', () => {
  // ❯ and > are intentionally excluded — Claude Code menus end lines with these.
  assert.equal(looksLikeShellPrompt('  ❯ Accept all'), false);
  assert.equal(looksLikeShellPrompt('Continue? >'), false);
});

test('looksLikeShellPrompt strips ANSI sequences before checking', () => {
  assert.equal(looksLikeShellPrompt('\x1b[32muser@host\x1b[0m:~$ '), true);
});

test('looksLikeShellPrompt returns false for empty/null input', () => {
  assert.equal(looksLikeShellPrompt(''), false);
  assert.equal(looksLikeShellPrompt(null), false);
  assert.equal(looksLikeShellPrompt(undefined), false);
});

// ── hasLiveHookState ─────────────────────────────────────────────────────────

test('hasLiveHookState returns true for a fresh hook entry', () => {
  const now = Date.now();
  assert.equal(hasLiveHookState({ event_ms: now - 1000 }, now), true);
});

test('hasLiveHookState returns false for a stale hook entry', () => {
  const now = Date.now();
  assert.equal(hasLiveHookState({ event_ms: now - HOOK_STALE_MS - 1 }, now), false);
});

test('hasLiveHookState returns false when hookState is null', () => {
  assert.equal(hasLiveHookState(null, Date.now()), false);
  assert.equal(hasLiveHookState(undefined, Date.now()), false);
});

// ── computeAgentState — hook-authoritative paths ─────────────────────────────

const freshHook = (hook_event) => ({ hook_event, event_ms: Date.now() });

test('computeAgentState returns working for PreToolUse hook', () => {
  assert.equal(computeAgentState({}, freshHook('PreToolUse'), null, Date.now()), 'working');
});

test('computeAgentState returns working for PostToolUse hook', () => {
  assert.equal(computeAgentState({}, freshHook('PostToolUse'), null, Date.now()), 'working');
});

test('computeAgentState returns working for UserPromptSubmit hook', () => {
  assert.equal(computeAgentState({}, freshHook('UserPromptSubmit'), null, Date.now()), 'working');
});

test('computeAgentState returns completed for Stop hook', () => {
  assert.equal(computeAgentState({}, freshHook('Stop'), null, Date.now()), 'completed');
});

test('computeAgentState preserves prevState for Notification hook', () => {
  assert.equal(computeAgentState({}, freshHook('Notification'), 'working', Date.now()), 'working');
  assert.equal(computeAgentState({}, freshHook('Notification'), 'blocked', Date.now()), 'blocked');
});

test('computeAgentState defaults prevState to working when Notification but no prevState', () => {
  assert.equal(computeAgentState({}, freshHook('Notification'), null, Date.now()), 'working');
});

// ── computeAgentState — stale hook falls through to heuristics ───────────────

test('computeAgentState ignores stale hook and uses heuristics', () => {
  const now = Date.now();
  const staleHook = { hook_event: 'Stop', event_ms: now - HOOK_STALE_MS - 1 };
  // Pane with an ended OSC 133 block → heuristic should return 'ready'
  const pane = {
    blocks: [{ command: 'claude', ended_ms: now - 1000 }],
    _screenSnapshotTime: now,
    _screenChangeCount: 5,
  };
  assert.equal(computeAgentState(pane, staleHook, null, now), 'ready');
});

// ── computeAgentState — heuristic paths ──────────────────────────────────────

test('computeAgentState returns ready when last OSC 133 block has ended', () => {
  const now = Date.now();
  const pane = {
    blocks: [{ command: 'claude', ended_ms: now - 500 }],
  };
  assert.equal(computeAgentState(pane, null, null, now), 'ready');
});

test('computeAgentState returns idle when fewer than 3 screen changes', () => {
  const now = Date.now();
  const pane = { _screenSnapshotTime: now - 10_000, _screenChangeCount: 2 };
  assert.equal(computeAgentState(pane, null, null, now), 'idle');
});

test('computeAgentState returns idle when no screen snapshot time', () => {
  const pane = { _screenChangeCount: 10 };
  assert.equal(computeAgentState(pane, null, null, Date.now()), 'idle');
});

test('computeAgentState returns working when screen changed recently', () => {
  const now = Date.now();
  const pane = {
    _screenSnapshotTime: now - (BLOCKED_MIN_MS - 100),
    _screenChangeCount: 5,
    _screenSnapshot: 'claude working ...',
  };
  assert.equal(computeAgentState(pane, null, null, now), 'working');
});

test('computeAgentState returns ready when stable and shell prompt visible', () => {
  const now = Date.now();
  const pane = {
    _screenSnapshotTime: now - (BLOCKED_MIN_MS + 500),
    _screenChangeCount: 5,
    _screenSnapshot: 'user@host:~/repo$ ',
  };
  assert.equal(computeAgentState(pane, null, null, now), 'ready');
});

test('computeAgentState returns blocked when stable and no shell prompt', () => {
  const now = Date.now();
  const pane = {
    _screenSnapshotTime: now - (BLOCKED_MIN_MS + 500),
    _screenChangeCount: 5,
    _screenSnapshot: 'Do you want to proceed? [y/N]',
  };
  assert.equal(computeAgentState(pane, null, null, now), 'blocked');
});

test('computeAgentState returns idle when stable too long (past BLOCKED_MAX_MS)', () => {
  const now = Date.now();
  const pane = {
    _screenSnapshotTime: now - (BLOCKED_MAX_MS + 1000),
    _screenChangeCount: 5,
    _screenSnapshot: 'Do you want to proceed? [y/N]',
  };
  assert.equal(computeAgentState(pane, null, null, now), 'idle');
});
