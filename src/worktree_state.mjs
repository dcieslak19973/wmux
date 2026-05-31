/**
 * Pure worktree-state helpers — no DOM, no Tauri.
 * Kept separate so they can be imported by the test suite.
 */

/**
 * Returns the branch label to display on the WT toolbar button when a worktree
 * is active, or null when no worktree is engaged.
 *
 * Prefers the git-detected branch from gitContext, falls back to the last
 * segment of the worktree path (the branch name used when the worktree was
 * created), and finally falls back to 'worktree'.
 *
 * @param {string|null|undefined} worktreePath
 * @param {{branch?: string}|null|undefined} gitContext
 * @returns {string|null}
 */
export function worktreeBranchLabel(worktreePath, gitContext) {
  if (!worktreePath) return null;
  if (gitContext?.branch) return gitContext.branch;
  const segment = worktreePath.replace(/\\/g, '/').split('/').filter(s => s && !/^[a-zA-Z]:$/.test(s)).pop();
  return segment || 'worktree';
}

/**
 * Returns the CWD to pre-seed into a new pane created by splitting a given
 * pane. When the parent has an active worktree the new pane should start
 * inside it, keeping both panes in the same isolated checkout.
 *
 * @param {{worktreePath?: string|null}|null|undefined} pane
 * @returns {string|null}
 */
export function inheritedCwdForSplit(pane) {
  return pane?.worktreePath ?? null;
}
