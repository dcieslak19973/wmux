import { makeDockable } from './panel_dock.mjs';

export function createActivityLogRuntime({
  panes,
  listPaneSummaries,
  activatePane,
  escHtml,
}) {
  const LOG_MAX = 500;
  const entries = []; // LogEntry[], oldest first; displayed newest-first
  let panelEl = null;
  let filterText = '';

  const AGENTS = {
    claude:   { label: 'Claude',   color: '#d97706', bg: 'rgba(217,119,6,0.15)',   border: 'rgba(217,119,6,0.35)' },
    codex:    { label: 'Codex',    color: '#10b981', bg: 'rgba(16,185,129,0.15)',  border: 'rgba(16,185,129,0.35)' },
    gemini:   { label: 'Gemini',   color: '#4285f4', bg: 'rgba(66,133,244,0.15)',  border: 'rgba(66,133,244,0.35)' },
    opencode: { label: 'OpenCode', color: '#a78bfa', bg: 'rgba(167,139,250,0.15)', border: 'rgba(167,139,250,0.35)' },
    aider:    { label: 'Aider',    color: '#ec4899', bg: 'rgba(236,72,153,0.15)',  border: 'rgba(236,72,153,0.35)' },
    amp:      { label: 'Amp',      color: '#f59e0b', bg: 'rgba(245,158,11,0.15)',  border: 'rgba(245,158,11,0.35)' },
  };

  function fmtTimestamp(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fmtDuration(startMs, endMs) {
    const d = endMs - startMs;
    if (d < 1000) return `${d}ms`;
    return `${(d / 1000).toFixed(1)}s`;
  }

  function shortPath(p) {
    if (!p) return '';
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/') || p;
  }

  function pushEntry(entry) {
    entries.push(entry);
    if (entries.length > LOG_MAX) entries.shift();
    if (panelEl) prependEntryEl(entries[entries.length - 1]);
  }

  function buildBaseEntry(sessionId, pane, agentHint = 'claude') {
    const summaries = listPaneSummaries();
    const summary = summaries.find(s => s.paneId === sessionId);
    const agentKey = pane.preferredAgent ?? agentHint;
    const agent = AGENTS[agentKey] ?? null;
    return {
      id: crypto.randomUUID(),
      sessionId,
      paneName: pane.labelOverride ?? summary?.paneLabel ?? sessionId.slice(0, 8),
      agent: agent?.label ?? agentKey,
      agentColor: agent?.color ?? '#888',
      agentBg: agent?.bg ?? 'rgba(128,128,128,0.15)',
      agentBorder: agent?.border ?? 'rgba(128,128,128,0.35)',
      workspace: summary?.workspaceName ?? '',
      cwd: pane.cwd ?? '',
    };
  }

  // Extracts a plain-text output string from Claude Code's tool result payload,
  // which can be a content-block array, a plain object, or a bare string.
  function extractToolOutput(raw, fallback) {
    if (!raw && !fallback) return '';
    if (!raw) return String(fallback);
    if (typeof raw === 'string') return raw;
    // Content-block array: [{type:'text', text:'...'}] or [{type:'tool_result', content:[...]}]
    if (Array.isArray(raw)) {
      return raw.map(block => {
        if (typeof block === 'string') return block;
        if (block.text) return block.text;
        if (block.content) return extractToolOutput(block.content, '');
        return '';
      }).join('').trim() || String(fallback ?? '');
    }
    // Plain object — try common field names
    const val = raw.output ?? raw.content ?? raw.result ?? raw.stdout ?? raw.text ?? raw.error;
    if (val != null) return extractToolOutput(val, fallback);
    return String(fallback ?? '');
  }

  // Tracks in-flight user prompts so we can pair them with the Stop event.
  // Key: pane_id, Value: { prompt, startedMs }
  const pendingPrompts = new Map();

  // Called from main.js's existing agent-hook-event listener — no new listener needed.
  // Hook events only arrive from real agents, so we log regardless of preferredAgent.
  function onHookEvent(payload) {
    const { pane_id, hook_event, tool, message, event_ms, tool_input, tool_response, tool_result, prompt } = payload ?? {};
    if (!pane_id) return;
    const pane = panes.get(pane_id);
    if (!pane) return;
    if (hook_event === 'PreToolUse') return; // PostToolUse covers this

    let command = '';
    let output = '';

    switch (hook_event) {
      case 'PostToolUse': {
        const inp = tool_input ?? {};
        if (tool === 'Bash' || tool === 'mcp__terminal__run_command')
          command = inp.command ?? inp.cmd ?? tool ?? 'bash';
        else if (tool === 'Read' || tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit')
          command = `${tool}: ${inp.file_path ?? inp.path ?? ''}`;
        else if (tool === 'Glob' || tool === 'Grep')
          command = `${tool}: ${inp.pattern ?? inp.query ?? ''}`;
        else if (tool === 'WebSearch' || tool === 'WebFetch')
          command = `${tool}: ${inp.query ?? inp.url ?? ''}`;
        else
          command = tool ?? 'tool';

        output = extractToolOutput(tool_result ?? tool_response, message);
        break;
      }
      case 'UserPromptSubmit':
        // Store prompt; push the entry when Stop fires so we have the response duration.
        pendingPrompts.set(pane_id, { prompt: String(prompt ?? message ?? '(prompt)'), startedMs: event_ms });
        return;
      case 'Stop': {
        const pending = pendingPrompts.get(pane_id);
        if (!pending) return;
        pendingPrompts.delete(pane_id);
        pushEntry({
          ...buildBaseEntry(pane_id, pane, 'claude'),
          command: pending.prompt,
          output: String(payload.last_assistant_message ?? ''),
          exitCode: null,
          startedMs: pending.startedMs,
          endedMs: event_ms,
        });
        return;
      }
      case 'Notification':
        command = `notify: ${message ?? ''}`;
        break;
      default: return;
    }

    pushEntry({
      ...buildBaseEntry(pane_id, pane, 'claude'),
      command,
      output,
      exitCode: null,
      startedMs: event_ms,
      endedMs: event_ms,
    });
  }

  // Called from main.js after get_blocks resolves in the block-end handler.
  // Logs the shell-level block (e.g. the `claude` process exiting).
  function onRustBlock(sessionId, block) {
    const pane = panes.get(sessionId);
    if (!pane) return;

    pushEntry({
      ...buildBaseEntry(sessionId, pane),
      command: block.command ?? '',
      output: block.output ?? '',
      exitCode: block.exit_code ?? null,
      startedMs: block.started_ms,
      endedMs: block.ended_ms,
    });
  }

  function matchesFilter(entry) {
    const q = filterText.toLowerCase().trim();
    if (!q) return true;
    return (
      entry.command.toLowerCase().includes(q) ||
      entry.paneName.toLowerCase().includes(q) ||
      entry.agent.toLowerCase().includes(q) ||
      entry.workspace.toLowerCase().includes(q) ||
      entry.cwd.toLowerCase().includes(q)
    );
  }

  function buildEntryEl(entry) {
    const el = document.createElement('div');
    el.className = 'al-entry';
    el.dataset.entryId = entry.id;

    const exitBadge = entry.exitCode !== null
      ? `<span class="al-badge-exit${entry.exitCode !== 0 ? ' fail' : ''}">${entry.exitCode === 0 ? '✓' : `exit ${entry.exitCode}`}</span>`
      : '';
    const dur = (entry.startedMs && entry.endedMs)
      ? `<span class="al-duration">${fmtDuration(entry.startedMs, entry.endedMs)}</span>`
      : '';
    el.innerHTML = `
      <div class="al-entry-top">
        <span class="al-agent-badge" style="color:${entry.agentColor};background:${entry.agentBg};border:1px solid ${entry.agentBorder}">${escHtml(entry.agent)}</span>
        <span class="al-pane-name">${escHtml(entry.paneName)}</span>
        <span class="al-spacer"></span>
        <span class="al-time">${fmtTimestamp(entry.endedMs || entry.startedMs)}</span>
        ${exitBadge}${dur}
      </div>
      <div class="al-entry-cmd">${escHtml(entry.command || '(no command)')}</div>
      <div class="al-entry-meta">${escHtml((entry.workspace ? entry.workspace + ' · ' : '') + shortPath(entry.cwd))}</div>
      <div class="al-output"><pre>${escHtml(entry.output.slice(0, 30_000) || '(no output)')}</pre></div>
    `;

    el.addEventListener('click', (e) => {
      if (e.detail >= 2) return;
      el.classList.toggle('expanded');
    });
    el.addEventListener('dblclick', () => {
      activatePane(entry.sessionId);
    });
    return el;
  }

  function prependEntryEl(entry) {
    const list = panelEl?.querySelector('.al-list');
    if (!list) return;
    if (!matchesFilter(entry)) return;
    list.querySelector('.al-empty')?.remove();
    list.insertBefore(buildEntryEl(entry), list.firstChild);
  }

  function renderList() {
    const list = panelEl?.querySelector('.al-list');
    if (!list) return;
    list.innerHTML = '';
    const shown = [...entries].reverse().filter(matchesFilter);
    if (!shown.length) {
      list.innerHTML = '<div class="al-empty">No activity yet</div>';
      return;
    }
    for (const entry of shown) list.appendChild(buildEntryEl(entry));
  }

  function open() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = 'activity-log-panel';
    panelEl.className = 'activity-log-panel';
    panelEl.innerHTML = `
      <div class="al-header">
        <span class="al-title">Activity Log</span>
        <div class="al-header-actions">
          <button class="al-clear-btn" title="Clear log">Clear</button>
          <button class="al-close-btn" title="Close">✕</button>
        </div>
      </div>
      <div class="al-search-row">
        <input class="al-search" type="text" placeholder="Filter by command, pane, agent…" />
      </div>
      <div class="al-list"></div>
    `;

    const searchEl = panelEl.querySelector('.al-search');
    searchEl.value = filterText;
    searchEl.addEventListener('input', (e) => { filterText = e.target.value; renderList(); });
    panelEl.querySelector('.al-close-btn').addEventListener('click', close);
    panelEl.querySelector('.al-clear-btn').addEventListener('click', () => {
      entries.length = 0;
      renderList();
    });

    makeDockable(panelEl, panelEl.querySelector('.al-header'), 'activity-log');
    renderList();
    searchEl.focus();
  }

  function close() {
    panelEl?.remove();
    panelEl = null;
  }

  function toggle() { if (panelEl) close(); else open(); }

  return { toggle, open, close, isOpen: () => !!panelEl, onHookEvent, onRustBlock };
}
