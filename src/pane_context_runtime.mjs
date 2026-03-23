export function createPaneContextRuntime({
  document,
  tabs,
  panes,
  defaultTargetLabel,
  inferCwdFromTerminalTranscript,
  inferRecentCwdsFromTerminalTranscript,
  sanitizeCwdForTarget,
  getActivePaneId,
  escHtml,
  markLayoutDirty,
}) {
  function basenameFromAnyPath(path) {
    return String(path ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
  }

  function relativePathWithin(root, fullPath) {
    const normalizedRoot = String(root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedFull = String(fullPath ?? '').replace(/\\/g, '/');
    if (!normalizedRoot || !normalizedFull.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return '';
    return normalizedFull.slice(normalizedRoot.length).replace(/^\/+/, '');
  }

  function shortPathLabel(path) {
    const parts = String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length === 0) return '';
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
  }

  function getPaneAutoLabel(pane) {
    if (!pane) return { primary: 'Terminal', secondary: '' };

    const cwdShort = shortPathLabel(pane.cwd);
    const git = pane.gitContext;
    if (!git?.repo_root) {
      return {
        primary: basenameFromAnyPath(pane.cwd) || defaultTargetLabel(pane.target),
        secondary: cwdShort,
      };
    }

    const repoName = git.repo_name || basenameFromAnyPath(git.repo_root) || 'repo';
    const worktreeName = git.is_worktree ? (git.worktree_name || basenameFromAnyPath(git.repo_root) || repoName) : null;
    const relativePath = relativePathWithin(git.repo_root, pane.cwd);
    const shortRelative = shortPathLabel(relativePath);

    const primary = worktreeName || repoName;
    const secondaryBits = [];
    if (worktreeName && worktreeName !== repoName) secondaryBits.push(repoName);
    if (git.branch) secondaryBits.push(git.branch);
    if (shortRelative) secondaryBits.push(shortRelative);

    return {
      primary,
      secondary: secondaryBits.join(' · '),
    };
  }

  function backfillPaneCwdFromTranscript(pane) {
    if (!pane) return '';
    const [currentCwd = '', previousCwd = ''] = inferRecentCwdsFromTerminalTranscript(pane.outputSnapshot)
      .map((value) => sanitizeCwdForTarget(pane.target, value));
    const inferredCwd = currentCwd || sanitizeCwdForTarget(pane.target, inferCwdFromTerminalTranscript(pane.outputSnapshot));
    if (!inferredCwd) return '';
    if (previousCwd && previousCwd !== inferredCwd) pane.previousCwd = previousCwd;
    pane.cwd = inferredCwd;
    const tab = tabs.get(pane.tabId);
    if (tab && (tab.paneIds.size === 1 || tab.lastActiveSurfaceEl === pane.domEl || getActivePaneId() === pane.sessionId)) {
      tab.cwd = inferredCwd;
    }
    return inferredCwd;
  }

  function renderPaneContextBadge(paneId) {
    const pane = panes.get(paneId);
    const badgeEl = pane?.contextBadgeEl;
    if (!pane || !badgeEl) return;

    const auto = getPaneAutoLabel(pane);
    const primary = pane.labelOverride?.trim() || auto.primary || 'Terminal';
    const secondary = auto.secondary || '';
    badgeEl.classList.toggle('is-override', !!pane.labelOverride?.trim());
    badgeEl.innerHTML = `
      <span class="pane-context-primary">${escHtml(primary)}</span>
      ${secondary ? `<span class="pane-context-secondary">${escHtml(secondary)}</span>` : ''}
    `;
    badgeEl.title = pane.labelOverride?.trim()
      ? `${pane.labelOverride.trim()}${secondary ? `\n${secondary}` : ''}`
      : `${auto.primary}${secondary ? `\n${secondary}` : ''}`;
  }

  function startPaneContextRename(paneId) {
    const pane = panes.get(paneId);
    if (!pane?.contextBadgeEl || pane.contextBadgeEl.querySelector('input')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'pane-context-input';
    input.value = pane.labelOverride ?? '';
    input.placeholder = getPaneAutoLabel(pane).primary;

    const commit = () => {
      const value = input.value.trim();
      pane.labelOverride = value || null;
      renderPaneContextBadge(paneId);
      markLayoutDirty();
    };

    const cancel = () => {
      renderPaneContextBadge(paneId);
    };

    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('mousedown', (event) => event.stopPropagation());
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancel();
      }
    });

    pane.contextBadgeEl.innerHTML = '';
    pane.contextBadgeEl.appendChild(input);
    input.focus();
    input.select();
  }

  return {
    backfillPaneCwdFromTranscript,
    getPaneAutoLabel,
    renderPaneContextBadge,
    startPaneContextRename,
  };
}