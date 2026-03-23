use serde::{Deserialize, Serialize};

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
pub struct SessionVaultEntryRecord {
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