export function createSessionVaultRuntime({
  invoke,
  panes,
  tabs,
  workspaces,
  getActivePaneId,
  getActiveTabId,
  getDefaultTarget,
  createTab,
  openBrowserSplitForTab,
  backfillPaneCwdFromTranscript,
  getPaneAutoLabel,
  getTargetKind,
  defaultTargetLabel,
  escHtml,
}) {
  function buildSessionVaultTranscriptHtml(entry) {
    const title = entry.pane_title || entry.tab_title || 'Terminal transcript';
    const metaBits = [
      new Date(entry.saved_at).toLocaleString(),
      entry.workspace_name,
      entry.tab_title,
      entry.target_label,
      entry.cwd,
      entry.pane_detail,
      entry.reason,
    ].filter(Boolean);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(title)}</title><style>html,body{margin:0;padding:0;background:#0f1115;color:#e4e4e7;font-family:'Cascadia Code','Fira Code','Consolas',monospace}body{padding:24px}header{margin-bottom:18px}h1{margin:0 0 8px;font-size:18px;font-family:system-ui,-apple-system,sans-serif}p{margin:0;color:#a1a1aa;font-size:12px;font-family:system-ui,-apple-system,sans-serif}pre{margin:0;padding:16px;border-radius:12px;background:#151821;border:1px solid rgba(255,255,255,0.08);white-space:pre-wrap;word-break:break-word;line-height:1.45;font-size:12px}</style></head><body><header><h1>${escHtml(title)}</h1><p>${escHtml(metaBits.join(' · '))}</p></header><pre>${escHtml(entry.transcript ?? '')}</pre></body></html>`;
  }

  async function openSessionVaultEntryInBrowser(entryId) {
    const entry = await invoke('read_session_vault_entry', { id: entryId });
    const previewUrl = await invoke('save_artifact_preview', { html: buildSessionVaultTranscriptHtml(entry) });
    if (!getActiveTabId()) await createTab(getDefaultTarget());
    if (getActiveTabId()) await openBrowserSplitForTab(getActiveTabId(), previewUrl);
  }

  async function saveSessionVaultEntryForPane(
    paneId = getActivePaneId(),
    { force = false, reason = 'manual' } = {},
  ) {
    const pane = panes.get(paneId);
    if (!pane) return null;

    backfillPaneCwdFromTranscript(pane);

    const tab = tabs.get(pane.tabId);
    const workspace = tab ? workspaces.get(tab.workspaceId) : null;
    let transcript = '';
    try {
      transcript = await invoke('capture_session_output_by_id', { id: paneId }) ?? '';
    } catch (err) {
      console.warn(`Could not capture transcript for pane ${paneId}:`, err);
    }
    transcript = String(transcript || pane.outputSnapshot || '').replace(/\0/g, '').trimEnd();
    if (!transcript.trim()) return null;

    const signature = `${transcript.length}:${transcript.slice(-512)}`;
    if (!force && pane.lastSessionVaultSignature === signature) {
      return pane.lastSessionVaultEntryId ? { id: pane.lastSessionVaultEntryId } : null;
    }

    const paneLabel = getPaneAutoLabel(pane);
    try {
      const saved = await invoke('save_session_vault_entry', {
        request: {
          paneId,
          workspaceName: workspace?.name ?? '',
          tabTitle: tab?.title ?? 'Terminal',
          paneTitle: pane.labelOverride?.trim() || paneLabel.primary || 'Terminal',
          paneDetail: paneLabel.secondary || null,
          targetKind: getTargetKind(pane.target),
          targetLabel: defaultTargetLabel(pane.target),
          cwd: pane.cwd || null,
          transcript,
          reason,
        },
      });
      pane.lastSessionVaultSignature = signature;
      pane.lastSessionVaultEntryId = saved.id;
      return saved;
    } catch (err) {
      console.warn(`Could not persist transcript for pane ${paneId}:`, err);
      return null;
    }
  }

  async function flushSessionVaultEntries({ force = false, reason = 'shutdown', paneIds = null } = {}) {
    const ids = Array.isArray(paneIds) ? paneIds : [...panes.keys()];
    await Promise.allSettled(ids.map((paneId) => saveSessionVaultEntryForPane(paneId, { force, reason })));
  }

  return {
    openSessionVaultEntryInBrowser,
    saveSessionVaultEntryForPane,
    flushSessionVaultEntries,
  };
}