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

/**
 * Generate 1-2 suggested branch names for a new worktree, avoiding names
 * already in use by existing worktrees.
 *
 * Primary suggestion is `<currentBranch>-wt`; if taken, tries `-wt-2`, `-wt-3`.
 * Falls back to a base-36 timestamp slug when no branch context is available.
 *
 * @param {{branch?: string}|null|undefined} gitContext
 * @param {Array<{branch?: string|null}>} existingWorktrees — from list_git_worktrees
 * @returns {string[]}  1-2 suggestions (never empty)
 */
export function suggestBranchNames(gitContext, existingWorktrees = []) {
  const taken = new Set(existingWorktrees.map(w => w.branch).filter(Boolean));
  const base = gitContext?.branch;
  if (base) {
    const suggestions = [];
    for (let i = 1; i <= 5 && suggestions.length < 2; i++) {
      const name = i === 1 ? `${base}-wt` : `${base}-wt-${i}`;
      if (!taken.has(name)) suggestions.push(name);
    }
    if (suggestions.length > 0) return suggestions;
  }
  return [`wt-${Date.now().toString(36)}`];
}
