use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RemoteTmuxMetadataResult {
    pub session_name: String,
    pub window_id: String,
    pub window_name: String,
    pub pane_id: String,
    pub cwd: Option<String>,
    pub repo_root: String,
    pub repo_name: String,
    pub git_branch: String,
    pub worktree_name: String,
    pub is_worktree: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteTmuxPaneResult {
    pub pane_id: String,
    pub pane_index: String,
    pub pane_pid: String,
    pub title: String,
    pub current_command: String,
    pub command_age: String,
    pub cwd: String,
    pub is_active: bool,
    pub was_last_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteTmuxWindowResult {
    pub window_id: String,
    pub window_index: String,
    pub window_name: String,
    pub is_active: bool,
    pub panes: Vec<RemoteTmuxPaneResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteTmuxSessionResult {
    pub session_name: String,
    pub attached_clients: usize,
    pub window_count: usize,
    pub is_current: bool,
    pub windows: Vec<RemoteTmuxWindowResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteTmuxStateResult {
    pub current_session_name: String,
    pub current_window_id: String,
    pub current_pane_id: String,
    pub sessions: Vec<RemoteTmuxSessionResult>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteTmuxActionResult {
    pub resolved_target: String,
}