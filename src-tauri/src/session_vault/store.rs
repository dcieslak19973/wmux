use crate::session_vault::model::{SessionVaultEntryRecord, SessionVaultEntrySummary};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

pub(super) fn session_vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("session-vault"))
        .map_err(|e| e.to_string())
}

pub(super) fn session_vault_metadata_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

pub(super) fn session_vault_summary_from_record(
    record: SessionVaultEntryRecord,
) -> SessionVaultEntrySummary {
    SessionVaultEntrySummary {
        id: record.id,
        saved_at: record.saved_at,
        pane_id: record.pane_id,
        workspace_name: record.workspace_name,
        tab_title: record.tab_title,
        pane_title: record.pane_title,
        pane_detail: record.pane_detail,
        target_kind: record.target_kind,
        target_label: record.target_label,
        cwd: record.cwd,
        reason: record.reason,
        transcript_chars: record.transcript_chars,
    }
}

pub(super) fn is_safe_session_vault_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(super) fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}