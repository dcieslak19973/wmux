/**
 * Pure helpers for createLeafPane initialization — no DOM, no Tauri.
 * Extracted so the normalization logic can be regression-tested independently
 * of the browser/xterm lifecycle. The blank-terminal bug was caused by init
 * order issues in this layer; keeping it pure makes regressions catchable.
 */

import { getTargetKind } from './connection_targets.mjs';
import {
  sanitizeCwdForTarget,
  normalizeHistoryEntry,
  normalizeTerminalTranscript,
} from './terminal_restore.mjs';

const MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_HISTORY_ENTRIES  = 500;

/**
 * Normalize the `initialState` bag passed to `createLeafPane`.
 * Returns the sanitized values that get forwarded to `create_session`
 * and stored on the pane object.
 *
 * @param {object} target  — ShellTarget (local / wsl / ssh / remote_tmux)
 * @param {object} initialState — raw restore/split payload; may be undefined
 * @returns {{ restoredCwd, restoredPreviousCwd, history, screenSnapshot, outputSnapshot }}
 */
export function normalizePaneInitialState(target, initialState = {}) {
  const restoredCwd         = sanitizeCwdForTarget(target, initialState?.cwd);
  const restoredPreviousCwd = sanitizeCwdForTarget(target, initialState?.previousCwd);

  const history = Array.isArray(initialState?.history)
    ? initialState.history
        .map((entry) => normalizeHistoryEntry(entry))
        .filter(Boolean)
        .slice(-MAX_HISTORY_ENTRIES)
    : [];

  const screenSnapshot = typeof initialState?.screenSnapshot === 'string'
    ? initialState.screenSnapshot
    : '';

  let outputSnapshot = typeof initialState?.outputSnapshot === 'string'
    ? normalizeTerminalTranscript(initialState.outputSnapshot)
    : '';
  if (outputSnapshot.length > MAX_TRANSCRIPT_CHARS) {
    outputSnapshot = outputSnapshot.slice(outputSnapshot.length - MAX_TRANSCRIPT_CHARS);
  }

  return { restoredCwd, restoredPreviousCwd, history, screenSnapshot, outputSnapshot };
}

/**
 * Return the default shell-quoting flavor for a target.
 * WSL and SSH panes default to bash quoting; local panes to PowerShell.
 * This governs how fix-agent / ask-agent commands are escaped.
 *
 * @param {object|null} target
 * @returns {'bash' | 'powershell'}
 */
export function defaultPaneShellFlavor(target) {
  const kind = getTargetKind(target);
  return (kind === 'wsl' || kind === 'ssh') ? 'bash' : 'powershell';
}

export { MAX_TRANSCRIPT_CHARS, MAX_HISTORY_ENTRIES };
