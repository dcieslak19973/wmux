import test from 'node:test';
import assert from 'node:assert/strict';

import {
  inferCwdFromTerminalTranscript,
  inferRecentCwdsFromTerminalTranscript,
  normalizeTerminalTranscript,
  sanitizeCwdForTarget,
  stripTerminalStartupResetSequences,
} from '../src/terminal_restore.mjs';

test('normalizeTerminalTranscript applies backspaces for restored plain text', () => {
  assert.equal(normalizeTerminalTranscript('o\bls\n'), 'ls\n');
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