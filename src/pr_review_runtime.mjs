export function createPrReviewRuntime({
  invoke,
  document,
  panes,
  tabs,
  collapsePaneBranch,
  makeDividerDrag,
  fitAndResizePane,
  toggleSurfaceZoom,
  onLayoutChanged,
  getActiveTabId,
  getActivePrReviewLabel,
  setActivePrReviewLabel,
  clearActiveSurface,
  escHtml,
}) {
  const prReviewPanes = new Map();

  // ── Diff parsing ──────────────────────────────────────────────────────────

  function parseDiff(raw) {
    const hunks = [];
    let current = null;
    for (const line of raw.split('\n')) {
      if (line.startsWith('@@')) {
        if (current) hunks.push(current);
        current = { header: line, lines: [] };
      } else if (current) {
        if (line.startsWith('+')) current.lines.push({ type: 'add', text: line.slice(1) });
        else if (line.startsWith('-')) current.lines.push({ type: 'del', text: line.slice(1) });
        else if (line.startsWith(' ')) current.lines.push({ type: 'ctx', text: line.slice(1) });
        // skip diff --git / index / --- / +++ header lines
      }
    }
    if (current) hunks.push(current);
    return hunks;
  }

  function renderDiffHtml(hunks) {
    if (!hunks.length) return '<div class="pr-review-empty">No changes in this file.</div>';
    let html = '';
    for (const hunk of hunks) {
      html += `<div class="diff-hunk-header">${escHtml(hunk.header)}</div>`;
      for (const { type, text } of hunk.lines) {
        const prefix = type === 'add' ? '+' : type === 'del' ? '-' : ' ';
        html += `<div class="diff-line diff-${type}">${escHtml(prefix + text)}</div>`;
      }
    }
    return html;
  }

  // ── File tree rendering ───────────────────────────────────────────────────

  function renderFileList(filesEl, files, selectedPath, onSelect) {
    filesEl.innerHTML = '';
    if (!files.length) {
      filesEl.innerHTML = '<div class="pr-review-empty">No changes vs base.</div>';
      return;
    }
    for (const file of files) {
      const item = document.createElement('div');
      item.className = 'pr-review-file-item' + (file.path === selectedPath ? ' selected' : '');
      item.title = file.path;
      const name = file.path.split('/').pop();
      const statusDot = file.status === 'added' ? '＋' : file.status === 'deleted' ? '－' : file.status === 'renamed' ? '⟶' : '·';
      item.innerHTML =
        `<span class="pr-review-file-name">${escHtml(statusDot)} ${escHtml(name)}</span>` +
        `<span class="pr-review-file-stats"><span class="adds">+${file.additions}</span> <span class="dels">-${file.deletions}</span></span>`;
      item.addEventListener('click', () => onSelect(file.path));
      filesEl.appendChild(item);
    }
  }

  // ── Leaf creation ─────────────────────────────────────────────────────────

  async function createPrReviewLeaf(tabId, mountEl, initialState = {}) {
    const label = `pr-review-${crypto.randomUUID().slice(0, 8)}`;

    const prEl = document.createElement('div');
    prEl.className = 'pane-leaf pr-review-pane-leaf';
    prEl.style.flex = '1 1 0';
    prEl.style.minWidth = '0';
    prEl.style.minHeight = '0';
    prEl.dataset.prReviewLabel = label;

    prEl.innerHTML = `
      <div class="pr-review-bar">
        <span class="pr-review-title">PR</span>
        <input class="pr-review-cwd-input" placeholder="Repo path…" spellcheck="false" />
        <span class="pr-review-base-badge"></span>
        <button class="pr-review-btn" data-action="refresh" title="Refresh diff">&#x21bb;</button>
        <button class="pr-review-btn" data-action="zoom" title="Toggle zoom">&#x2922;</button>
        <button class="pr-review-btn pane-tb-close" data-action="close" title="Close">&#x2715;</button>
      </div>
      <div class="pr-review-body">
        <div class="pr-review-files"></div>
        <div class="pr-review-diff"><div class="pr-review-empty">Select a file to view its diff.</div></div>
      </div>
    `;

    mountEl.appendChild(prEl);

    const cwdInput = prEl.querySelector('.pr-review-cwd-input');
    const baseBadge = prEl.querySelector('.pr-review-base-badge');
    const filesEl = prEl.querySelector('.pr-review-files');
    const diffEl = prEl.querySelector('.pr-review-diff');

    const state = {
      label,
      tabId,
      prEl,
      cwd: initialState.cwd ?? '',
      baseRef: '',
      files: [],
      selectedPath: null,
    };
    if (state.cwd) cwdInput.value = state.cwd;
    prReviewPanes.set(label, state);
    tabs.get(tabId)?.prReviewLabels?.add(label);

    const loadFile = async (filePath) => {
      state.selectedPath = filePath;
      renderFileList(filesEl, state.files, filePath, loadFile);
      diffEl.innerHTML = '<div class="pr-review-empty">Loading…</div>';
      try {
        const raw = await invoke('get_pr_file_diff', { cwd: state.cwd, base: state.baseRef, path: filePath });
        diffEl.innerHTML = renderDiffHtml(parseDiff(raw));
      } catch (err) {
        diffEl.innerHTML = `<div class="pr-review-empty">Error: ${escHtml(String(err))}</div>`;
      }
    };

    const loadSummary = async () => {
      const cwd = cwdInput.value.trim();
      if (!cwd) {
        filesEl.innerHTML = '<div class="pr-review-empty">Enter a repo path above and press Enter.</div>';
        diffEl.innerHTML = '';
        baseBadge.textContent = '';
        return;
      }
      state.cwd = cwd;
      filesEl.innerHTML = '<div class="pr-review-empty">Loading…</div>';
      diffEl.innerHTML = '<div class="pr-review-empty">Select a file to view its diff.</div>';
      state.selectedPath = null;
      try {
        const summary = await invoke('get_pr_diff_summary', { cwd, base: null });
        state.baseRef = summary.base_ref;
        state.files = summary.files;
        baseBadge.textContent = `vs ${summary.base_ref}  +${summary.total_additions} -${summary.total_deletions}`;
        renderFileList(filesEl, summary.files, null, loadFile);
        if (!summary.files.length) {
          filesEl.innerHTML = '<div class="pr-review-empty">No changes vs base.</div>';
        }
      } catch (err) {
        filesEl.innerHTML = `<div class="pr-review-empty">Error: ${escHtml(String(err))}</div>`;
      }
    };

    cwdInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await loadSummary(); }
    });

    prEl.querySelector('[data-action="refresh"]').addEventListener('click', async () => {
      await loadSummary();
      if (state.selectedPath) await loadFile(state.selectedPath);
    });
    prEl.querySelector('[data-action="zoom"]').addEventListener('click', () => toggleSurfaceZoom(prEl));
    prEl.querySelector('[data-action="close"]').addEventListener('click', () => closePrReviewSurface(label));

    prEl.addEventListener('mousedown', () => activatePrReview(label));

    await loadSummary();
    return state;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  function activatePrReview(label) {
    const state = prReviewPanes.get(label);
    if (!state) return;
    clearActiveSurface();
    setActivePrReviewLabel(label);
    state.prEl.classList.add('active-pane');
    const tab = tabs.get(state.tabId);
    if (tab) tab.lastActiveSurfaceEl = state.prEl;
    onLayoutChanged?.();
    if (state.tabId !== getActiveTabId()) return;
  }

  function closePrReviewSurface(label, { collapse = true } = {}) {
    const state = prReviewPanes.get(label);
    if (!state) return;
    prReviewPanes.delete(label);
    const tab = tabs.get(state.tabId);
    tab?.prReviewLabels?.delete(label);
    if (tab?.lastActiveSurfaceEl === state.prEl) tab.lastActiveSurfaceEl = null;
    if (getActivePrReviewLabel() === label) setActivePrReviewLabel(null);
    if (collapse) {
      collapsePaneBranch(state.prEl);
      requestAnimationFrame(() => {
        for (const [paneId] of panes) fitAndResizePane(paneId);
      });
    }
    onLayoutChanged?.();
  }

  // ── Split helper ──────────────────────────────────────────────────────────

  async function splitPaneWithPrReview(paneId, dir = 'h', initialState = {}) {
    const pane = panes.get(paneId);
    if (!pane) return;
    const leafEl = pane.domEl;
    const parentEl = leafEl.parentElement;
    const splitEl = document.createElement('div');
    splitEl.className = `pane-split pane-split-${dir}`;
    leafEl.style.flex = '1 1 0';
    parentEl.replaceChild(splitEl, leafEl);
    splitEl.appendChild(leafEl);
    const dividerEl = document.createElement('div');
    dividerEl.className = `pane-divider pane-divider-${dir}`;
    dividerEl.addEventListener('mousedown', makeDividerDrag(splitEl, dir));
    splitEl.appendChild(dividerEl);
    await createPrReviewLeaf(pane.tabId, splitEl, initialState);
    fitAndResizePane(paneId);
    onLayoutChanged?.();
  }

  return {
    prReviewPanes,
    createPrReviewLeaf,
    splitPaneWithPrReview,
    closePrReviewSurface,
    activatePrReview,
  };
}
