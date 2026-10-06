import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferCwdFromTerminalTranscript,
  inferRecentCwdsFromTerminalTranscript,
  normalizeTerminalTranscript,
  sanitizeCwdForTarget,
  splitTrailingControlString,
  stripTerminalStartupResetSequences,
} from '../src/terminal_restore.mjs';

test('normalizeTerminalTranscript applies backspaces for restored plain text', () => {
  assert.equal(normalizeTerminalTranscript('o\bls\n'), 'ls\n');
});

test('normalizeTerminalTranscript drops kitty graphics and Sixel payloads', () => {
  assert.equal(normalizeTerminalTranscript('a\x1b_Ga=T,i=1;QUJD\x1b\\b\x1bPq#0~~\x1b\\c\n'), 'abc\n');
});

test('splitTrailingControlString holds back a graphics payload split across chunks', () => {
  const [complete, pending] = splitTrailingControlString('text\x1b_Ga=T,i=1,m=1;QUJD');
  assert.equal(complete, 'text');
  // Joined with the next chunk the whole sequence is stripped, not its base64 tail.
  assert.equal(normalizeTerminalTranscript(pending + 'RUZH\x1b\\after\n'), 'after\n');
  // Terminated sequences (ST or BEL for OSC) are complete.
  assert.deepEqual(splitTrailingControlString('a\x1b]0;title\x07b'), ['a\x1b]0;title\x07b', '']);
  assert.deepEqual(splitTrailingControlString('a\x1b_Gi=1;OK\x1b\\'), ['a\x1b_Gi=1;OK\x1b\\', '']);
});

test('inferCwdFromTerminalTranscript prefers the latest valid WSL prompt', () => {
  const transcript = [
    '<3>WSL (282 - Relay) ERROR: CreateProcessCommon:727: chdir(/home/dcieslak$ (base) dcieslak@DESKTOP-0A5V324:~) failed 2',
    '(base) dcieslak@DESKTOP-0A5V324:/$ pwd',
    '/',
    '(base) dcieslak@DESKTOP-0A5V324:/mnt/d/git/wmux/wmux/target/release$ ls',
  ].join('\n');

  assert.equal(inferCwdFromTerminalTranscript(transcript), '/mnt/d/git/wmux/wmux/target/release');
});

test('inferRecentCwdsFromTerminalTranscript returns current and previous dirs', () => {
  const transcript = [
    '(base) dcieslak@DESKTOP-0A5V324:/mnt/d/git/wmux/wmux/target/release$ ls',
    '(base) dcieslak@DESKTOP-0A5V324:~$ pwd',
  ].join('\n');

  assert.deepEqual(inferRecentCwdsFromTerminalTranscript(transcript), ['~', '/mnt/d/git/wmux/wmux/target/release']);
});

test('sanitizeCwdForTarget rejects noisy prompt fragments for WSL restore', () => {
  assert.equal(
    sanitizeCwdForTarget(
      { type: 'wsl', distro: 'Ubuntu-24.04' },
      '/home/dcieslak$ (base) dcieslak@DESKTOP-0A5V324:~',
    ),
    '/home/dcieslak',
  );
});

test('stripTerminalStartupResetSequences removes startup clear screen controls', () => {
  const startup = '\x1bc\x1b[2J\x1b[H(base) prompt$ ';
  assert.equal(stripTerminalStartupResetSequences(startup), '(base) prompt$ ');
});