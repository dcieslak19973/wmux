/**
 * Pure agent-state helpers — no DOM, no Tauri, no closure state.
 * Extracted from createAgentSidebarRuntime so the state-machine logic
 * can be tested independently of the sidebar's Map state and timers.
 *
 * The sidebar wires these by passing explicit hookState, prevState, and
 * now-timestamp rather than reading from closures.
 */

export const HOOK_STALE_MS   = 5 * 60 * 1000;
export const BLOCKED_MIN_MS  = 8_000;
export const BLOCKED_MAX_MS  = 30 * 60 * 1000;

// Shell prompt suffixes — deliberately narrow: bash ($), zsh (%), root (#).
// ❯ and > are intentionally excluded because Claude Code's interactive menus
// end lines with those characters, which would produce false 'ready' readings.
const SHELL_PROMPT_RE = /[$%#]\s*$/;

/**
 * Return true when the terminal's bottom-rows snapshot ends with a shell prompt.
 * @param {string|null|undefined} snapshot
 */
export function looksLikeShellPrompt(snapshot) {
  if (!snapshot) return false;
  const plain = snapshot.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const lines = plain.split(/\r?\n/).filter((l) => l.trim());
  const last = lines[lines.length - 1] ?? '';
  return SHELL_PROMPT_RE.test(last);
}

/**
 * Compute the display state for one agent pane.
 *
 * @param {object}      pane       — pane state object (blocks, _screenSnapshot, etc.)
 * @param {object|null} hookState  — entry from hookStates Map, or null/undefined
 * @param {string|null} prevState  — previous computed state for this pane, or null
 * @param {number}      now        — current timestamp (ms); pass Date.now() in production
 * @returns {'working'|'completed'|'ready'|'idle'|'blocked'}
 */
export function computeAgentState(pane, hookState, prevState, now) {
  // Prefer authoritative hook state when it's fresh.
  if (hookState && now - hookState.event_ms < HOOK_STALE_MS) {
    switch (hookState.hook_event) {
      case 'PreToolUse':
      case 'PostToolUse':
      case 'UserPromptSubmit':
        return 'working';
      case 'Stop':
        return 'completed';
      case 'Notification':
        // Notification is supplemental; keep the previous state so a transient
        // notification mid-task doesn't flip the badge from working to something else.
        return prevState ?? 'working';
    }
  }

  // Fall back to screen-scraping heuristics.

  // OSC 133 panes: if the last block finished, the agent process exited.
  if (pane.blocks?.length > 0 && pane.blocks[pane.blocks.length - 1].ended_ms) {
    return 'ready';
  }

  // Require a minimum number of screen changes before trusting state detection,
  // to avoid false positives on panes that just opened.
  const changes = pane._screenChangeCount ?? 0;
  if (!pane._screenSnapshotTime || changes < 3) return 'idle';

  const sinceLastChange = now - pane._screenSnapshotTime;
  if (sinceLastChange < BLOCKED_MIN_MS) return 'working';

  // Screen has been stable for BLOCKED_MIN_MS+. Decide what that means:
  //   - Shell prompt visible → agent exited, pane ready for a new task.
  //   - No shell prompt      → some TUI is waiting for input → blocked.
  if (looksLikeShellPrompt(pane._screenSnapshot)) return 'ready';
  if (sinceLastChange < BLOCKED_MAX_MS) return 'blocked';
  return 'idle';
}

/**
 * Return true when hookState is present and fresh enough to be authoritative.
 * @param {object|null} hookState
 * @param {number}      now
 */
export function hasLiveHookState(hookState, now) {
  return !!(hookState && now - hookState.event_ms < HOOK_STALE_MS);
}
