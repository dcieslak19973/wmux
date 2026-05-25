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
  getActivePaneId,
  fixAgents,
  showContextMenu,
  getTargetKind,
}) {
  const prReviewPanes = new Map();

  // ── Diff parsing ──────────────────────────────────────────────────────────

  function parseDiff(raw) {
    const hunks = [];
    let current = null;
    for (const line of raw.split(/\r?\n/)) {
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

  // ── Agent ask command builder ─────────────────────────────────────────────

  function buildAgentAskCmd(agent, body, shell) {
    if (shell === 'bash') {
      const escaped = body.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
      return agent.bash(escaped);
    } else {
      const escaped = body.replace(/`/g, '``').replace(/"/g, '`"').replace(/\n/g, '`n');
      return agent.ps(escaped);
    }
  }

  // ── Markdown renderer for AI responses ───────────────────────────────────

  function renderAiMarkdown(text) {
    const segments = text.split(/(```(?:[^\n]*)?\n[\s\S]*?```)/);
    return segments.map((seg, i) => {
      if (i % 2 === 1) {
        const inner = seg.replace(/^```[^\n]*\n/, '').replace(/```$/, '');
        return `<pre class="pr-ai-code">${escHtml(inner)}</pre>`;
      }
      let html = escHtml(seg);
      html = html.replace(/`([^`\n]+)`/g, '<code class="pr-ai-inline-code">$1</code>');
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      return html.split(/\n\n+/).map((p) => p.trim() ? `<p>${p.replace(/\n/g, '<br>')}</p>` : '').join('');
    }).join('');
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
        <button class="pr-review-btn" data-action="worktrees" title="Switch worktree">&#x2387;</button>
        <span class="pr-review-bar-sep">vs</span>
        <input class="pr-review-base-input" placeholder="auto" spellcheck="false" />
        <button class="pr-review-btn" data-action="refresh" title="Refresh diff">&#x21bb;</button>
        <button class="pr-review-btn" data-action="zoom" title="Toggle zoom">&#x2922;</button>
        <button class="pr-review-btn pane-tb-close" data-action="close" title="Close">&#x2715;</button>
      </div>
      <div class="pr-review-body">
        <div class="pr-review-files"></div>
        <div class="pr-review-right">
          <div class="pr-review-diff"><div class="pr-review-empty">Select a file to view its diff.</div></div>
          <div class="pr-review-ask-response" style="display:none"></div>
          <div class="pr-review-ask-bar">
            <span class="pr-review-sel-badge" style="display:none" title="Click to clear selection"></span>
            <textarea class="pr-review-ask-input" placeholder="Ask AI about this file… (Ctrl+Enter)" rows="2" spellcheck="false"></textarea>
            <button class="pr-review-agent-btn pr-review-btn" title="Select AI agent">Claude</button>
            <button class="pr-review-ask-btn pr-review-btn" title="Ask (Ctrl+Enter)">Ask</button>
          </div>
        </div>
      </div>
    `;

    mountEl.appendChild(prEl);

    const cwdInput = prEl.querySelector('.pr-review-cwd-input');
    const baseInput = prEl.querySelector('.pr-review-base-input');
    const filesEl = prEl.querySelector('.pr-review-files');
    const diffEl = prEl.querySelector('.pr-review-diff');
    const askResponseEl = prEl.querySelector('.pr-review-ask-response');
    const askInput = prEl.querySelector('.pr-review-ask-input');
    const askBtn = prEl.querySelector('.pr-review-ask-btn');
    const agentBtn = prEl.querySelector('.pr-review-agent-btn');
    const selBadge = prEl.querySelector('.pr-review-sel-badge');

    const state = {
      label,
      tabId,
      prEl,
      cwd: initialState.cwd ?? '',
      baseRef: '',
      files: [],
      selectedPath: null,
      rawDiff: '',
      selectedContext: null,
      askAgent: null, // null = Claude (API); key string = terminal agent
    };
    if (state.cwd) cwdInput.value = state.cwd;
    prReviewPanes.set(label, state);
    tabs.get(tabId)?.prReviewLabels?.add(label);

    // ── Selection tracking ────────────────────────────────────────────────
    diffEl.addEventListener('mouseup', () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (diffEl.contains(range.commonAncestorContainer)) {
          state.selectedContext = sel.toString();
          const lineCount = state.selectedContext.split('\n').filter(Boolean).length;
          selBadge.textContent = `${lineCount} line${lineCount !== 1 ? 's' : ''} selected ×`;
          selBadge.style.display = '';
          return;
        }
      }
    });
    selBadge.addEventListener('click', () => {
      state.selectedContext = null;
      selBadge.style.display = 'none';
    });

    // ── Agent picker ──────────────────────────────────────────────────────
    if (agentBtn && fixAgents && showContextMenu) {
      agentBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = agentBtn.getBoundingClientRect();
        const items = [
          {
            label: 'Claude (inline)',
            action: () => {
              state.askAgent = null;
              agentBtn.textContent = 'Claude';
              agentBtn.style.color = '';
            },
          },
          { type: 'separator' },
          ...fixAgents.map((agent) => ({
            label: `${agent.label} (terminal)`,
            action: () => {
              state.askAgent = agent.key;
              agentBtn.textContent = agent.label;
              agentBtn.style.color = agent.color ?? '';
            },
          })),
        ];
        showContextMenu(items, r.left, r.bottom + 4);
      });
    }

    // ── Ask AI ────────────────────────────────────────────────────────────
    const askAi = async () => {
      const question = askInput.value.trim();
      if (!question) return;
      const context = state.selectedContext || state.rawDiff;

      // Non-Claude agents: write command to active terminal pane
      if (state.askAgent && fixAgents) {
        const agent = fixAgents.find((a) => a.key === state.askAgent);
        if (!agent) return;
        const filePart = state.selectedPath ? ` [${state.selectedPath}]` : '';
        const body = `${question}${filePart}`;
        const activePaneId = getActivePaneId?.();
        const pane = activePaneId ? panes.get(activePaneId) : null;
        const kind = pane ? getTargetKind?.(pane.target) : null;
        const shell = (kind === 'wsl' || kind === 'ssh') ? 'bash' : 'powershell';
        const cmd = buildAgentAskCmd(agent, body, shell);
        const targetId = activePaneId ?? '';
        if (targetId) invoke('write_to_session', { id: targetId, data: cmd }).catch(() => {});
        return;
      }

      // Claude: use API
      if (!context) {
        askResponseEl.innerHTML = '<p class="pr-review-empty">Select a file first.</p>';
        askResponseEl.style.display = '';
        return;
      }
      const agentLabel = state.askAgent ? (fixAgents?.find((a) => a.key === state.askAgent)?.label ?? 'AI') : 'Claude';
      askResponseEl.innerHTML = `<p class="pr-review-empty">Asking ${escHtml(agentLabel)}…</p>`;
      askResponseEl.style.display = '';
      askBtn.disabled = true;
      try {
        const response = await invoke('ask_claude_about_diff', {
          question,
          diffContext: context,
          filePath: state.selectedPath ?? '',
        });
        askResponseEl.innerHTML = renderAiMarkdown(response);
      } catch (err) {
        askResponseEl.innerHTML = `<p class="pr-review-empty">Error: ${escHtml(String(err))}</p>`;
      } finally {
        askBtn.disabled = false;
      }
    };

    askBtn.addEventListener('click', askAi);
    askInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); askAi(); }
    });

    const loadFile = async (filePath) => {
      state.selectedPath = filePath;
      state.rawDiff = '';
      state.selectedContext = null;
      selBadge.style.display = 'none';
      renderFileList(filesEl, state.files, filePath, loadFile);
      diffEl.innerHTML = '<div class="pr-review-empty">Loading…</div>';
      try {
        const raw = await invoke('get_pr_file_diff', { cwd: state.cwd, base: state.baseRef, path: filePath });
        state.rawDiff = raw;
        const hunks = parseDiff(raw);
        diffEl.innerHTML = renderDiffHtml(hunks);
      } catch (err) {
        diffEl.innerHTML = `<div class="pr-review-empty">Error: ${escHtml(String(err))}</div>`;
      }
    };

    const loadSummary = async () => {
      let cwd = cwdInput.value.trim();
      if (!cwd) {
        filesEl.innerHTML = '<div class="pr-review-empty">Enter a repo path above and press Enter.</div>';
        diffEl.innerHTML = '';
        return;
      }
      state.cwd = cwd;
      filesEl.innerHTML = '<div class="pr-review-empty">Loading…</div>';
      diffEl.innerHTML = '<div class="pr-review-empty">Select a file to view its diff.</div>';
      state.selectedPath = null;
      state.rawDiff = '';
      state.selectedContext = null;
      selBadge.style.display = 'none';
      const explicitBase = baseInput.value.trim() || null;
      try {
        const summary = await invoke('get_pr_diff_summary', { cwd, base: explicitBase });
        state.baseRef = summary.base_ref;
        state.files = summary.files;
        cwdInput.value = summary.resolved_cwd || cwd;
        if (!explicitBase) baseInput.value = summary.base_ref;
        renderFileList(filesEl, summary.files, null, loadFile);
        if (!summary.files.length) {
          filesEl.innerHTML = `<div class="pr-review-empty">No changes vs <code>${escHtml(summary.base_ref)}</code>.</div>`;
        }
      } catch (err) {
        filesEl.innerHTML = `<div class="pr-review-empty">Error: ${escHtml(String(err))}</div>`;
      }
    };

    cwdInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await loadSummary(); }
    });
    baseInput.addEventListener('keydown', async (e) => {
      if (e.key === 'Enter') { e.preventDefault(); await loadSummary(); }
    });

    prEl.querySelector('[data-action="refresh"]').addEventListener('click', async () => {
      await loadSummary();
      if (state.selectedPath) await loadFile(state.selectedPath);
    });

    const worktreesBtn = prEl.querySelector('[data-action="worktrees"]');
    if (worktreesBtn && showContextMenu) {
      worktreesBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const r = worktreesBtn.getBoundingClientRect();
        const probeCwd = cwdInput.value.trim() || state.cwd;
        let entries = [];
        let errMsg = null;
        try {
          entries = await invoke('list_git_worktrees', { cwd: probeCwd });
        } catch (err) {
          errMsg = String(err);
        }
        const items = [];
        if (errMsg) {
          items.push({ type: 'label', text: errMsg.length > 60 ? errMsg.slice(0, 57) + '…' : errMsg });
        } else if (!entries.length) {
          items.push({ type: 'label', text: 'No worktrees found' });
        } else {
          items.push({ type: 'label', text: 'Worktrees' });
          for (const wt of entries) {
            const branchLabel = wt.is_bare ? '(bare)' : wt.is_detached ? '(detached)' : (wt.branch || (wt.head ? wt.head.slice(0, 7) : '?'));
            const dot = wt.is_current ? '• ' : '  ';
            const tail = wt.path.split(/[\\/]/).pop();
            items.push({
              label: `${dot}${branchLabel}  —  ${tail}`,
              disabled: wt.is_bare,
              action: () => {
                cwdInput.value = wt.path;
                baseInput.value = '';
                loadSummary();
              },
            });
          }
        }
        showContextMenu(items, r.left, r.bottom + 4);
      });
    }

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
