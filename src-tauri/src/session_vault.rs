use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionVaultEntrySummary {
    pub id: String,
    pub saved_at: u64,
    pub pane_id: String,
    pub workspace_name: String,
    pub tab_title: String,
    pub pane_title: String,
    pub pane_detail: Option<String>,
    pub target_kind: String,
    pub target_label: String,
    pub cwd: Option<String>,
    pub reason: String,
    pub transcript_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionVaultEntryDetail {
    pub id: String,
    pub saved_at: u64,
    pub pane_id: String,
    pub workspace_name: String,
    pub tab_title: String,
    pub pane_title: String,
    pub pane_detail: Option<String>,
    pub target_kind: String,
    pub target_label: String,
    pub cwd: Option<String>,
    pub reason: String,
    pub transcript_chars: usize,
    pub transcript: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSessionVaultEntryRequest {
    pub pane_id: String,
    pub workspace_name: String,
    pub tab_title: String,
    pub pane_title: String,
    pub pane_detail: Option<String>,
    pub target_kind: String,
    pub target_label: String,
    pub cwd: Option<String>,
    pub transcript: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionVaultEntryRecord {
    pub id: String,
    pub saved_at: u64,
    pub pane_id: String,
    pub workspace_name: String,
    pub tab_title: String,
    pub pane_title: String,
    pub pane_detail: Option<String>,
    pub target_kind: String,
    pub target_label: String,
    pub cwd: Option<String>,
    pub reason: String,
    pub transcript_chars: usize,
    pub transcript_file: String,
}

#[tauri::command]
pub async fn save_session_vault_entry(
    app: AppHandle,
    request: SaveSessionVaultEntryRequest,
) -> Result<SessionVaultEntrySummary, String> {
    let transcript = request.transcript.replace('\0', "");
    if transcript.trim().is_empty() {
        return Err("Refusing to save an empty transcript".to_string());
    }

    let dir = session_vault_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let id = format!("vault-{}", uuid::Uuid::new_v4());
    let transcript_file = format!("{id}.txt");
    let record = SessionVaultEntryRecord {
        id: id.clone(),
        saved_at: now_unix_millis(),
        pane_id: request.pane_id,
        workspace_name: request.workspace_name,
        tab_title: request.tab_title,
        pane_title: request.pane_title,
        pane_detail: request.pane_detail.filter(|value| !value.trim().is_empty()),
        target_kind: request.target_kind,
        target_label: request.target_label,
        cwd: request.cwd.filter(|value| !value.trim().is_empty()),
        reason: request.reason.unwrap_or_else(|| "manual".to_string()),
        transcript_chars: transcript.chars().count(),
        transcript_file: transcript_file.clone(),
    };

    std::fs::write(dir.join(&transcript_file), transcript).map_err(|e| e.to_string())?;
    let metadata_path = session_vault_metadata_path(&dir, &id);
    let metadata_json = serde_json::to_vec_pretty(&record).map_err(|e| e.to_string())?;
    std::fs::write(metadata_path, metadata_json).map_err(|e| e.to_string())?;

    Ok(session_vault_summary_from_record(record))
}

#[tauri::command]
pub async fn list_session_vault_entries(app: AppHandle) -> Result<Vec<SessionVaultEntrySummary>, String> {
    let dir = session_vault_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in read_dir {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let raw = match std::fs::read_to_string(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let record = match serde_json::from_str::<SessionVaultEntryRecord>(&raw) {
            Ok(value) => value,
            Err(_) => continue,
        };
        entries.push(session_vault_summary_from_record(record));
    }

    entries.sort_by(|left, right| right.saved_at.cmp(&left.saved_at));
    Ok(entries)
}

#[tauri::command]
pub async fn read_session_vault_entry(
    app: AppHandle,
    id: String,
) -> Result<SessionVaultEntryDetail, String> {
    if !is_safe_session_vault_id(&id) {
        return Err(format!("Invalid session vault id: {id}"));
    }

    let dir = session_vault_dir(&app)?;
    let metadata_path = session_vault_metadata_path(&dir, &id);
    let raw = std::fs::read_to_string(&metadata_path)
        .map_err(|e| format!("Could not read {}: {e}", metadata_path.display()))?;
    let record = serde_json::from_str::<SessionVaultEntryRecord>(&raw).map_err(|e| e.to_string())?;
    let transcript_path = dir.join(&record.transcript_file);
    let transcript = std::fs::read_to_string(&transcript_path)
        .map_err(|e| format!("Could not read {}: {e}", transcript_path.display()))?;

    Ok(SessionVaultEntryDetail {
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
        transcript,
    })
}

fn session_vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("session-vault"))
        .map_err(|e| e.to_string())
}

fn session_vault_metadata_path(dir: &Path, id: &str) -> PathBuf {
    dir.join(format!("{id}.json"))
}

fn session_vault_summary_from_record(record: SessionVaultEntryRecord) -> SessionVaultEntrySummary {
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

fn is_safe_session_vault_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}