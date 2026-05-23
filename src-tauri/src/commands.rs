/// Tauri IPC command handlers — the bridge between the WebView frontend
/// and the Rust ConPTY session manager.
use crate::{osc_parser::{self, OscEvent}, session_manager::{BlockStore, ShellTarget, TermBlock, WslDistro}, tunnel_manager::TunnelManager, url_detector, FrontendControlBridge, SessionManager};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

#[derive(Debug, Clone, Serialize)]
pub struct OscNotificationPayload {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UrlDetectedPayload {
    pub url: String,
    pub is_oauth: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClipboardPayload {
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockStartPayload {}

#[derive(Debug, Clone, Serialize)]
pub struct BlockEndPayload {
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BlockCommandLinePayload {
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateSessionResult {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct BrowserGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct CreateBrowserWindowRequest {
    pub window_label: String,
    pub label: String,
    pub url: String,
    pub geometry: BrowserGeometry,
}

#[derive(Debug, Clone, Serialize)]
pub struct GitContextResult {
    pub repo_root: String,
    pub repo_name: String,
    pub branch: Option<String>,
    pub worktree_name: Option<String>,
    pub is_worktree: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrDiffFile {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrDiffSummary {
    pub base_ref: String,
    pub resolved_cwd: String,
    pub files: Vec<PrDiffFile>,
    pub total_additions: usize,
    pub total_deletions: usize,
}

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

#[derive(Debug, Clone, Serialize)]
pub struct SessionExitPayload {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfigRequest {
    pub endpoint: String,
    pub pubkey: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub current_version: String,
    pub available: bool,
    pub version: Option<String>,
    pub date: Option<String>,
    pub body: Option<String>,
    pub download_url: Option<String>,
    pub target: Option<String>,
}

/// Create a new terminal session for the given `target`.
/// Returns the session ID and a human-readable tab label.
#[tauri::command]
#[allow(non_snake_case)]
pub async fn create_session(
    _app: AppHandle,
    manager: State<'_, SessionManager>,
    cols: u16,
    rows: u16,
    target: Option<ShellTarget>,
    cwd: Option<String>,
    previousCwd: Option<String>,
) -> Result<CreateSessionResult, String> {
    let target = target.unwrap_or(ShellTarget::Local);
    let (id, label) = manager
        .create(target, cols, rows, cwd.as_deref(), previousCwd.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    // The frontend will call start_session_stream() after registering its
    // event listener.  Doing it this way eliminates the race where Rust emits
    // events before the frontend's listen() has resolved.

    Ok(CreateSessionResult { id, label })
}

#[tauri::command]
pub async fn probe_remote_tmux_metadata(
    target: ShellTarget,
) -> Result<RemoteTmuxMetadataResult, String> {
    let ShellTarget::RemoteTmux {
        host,
        user,
        port,
        identity_file,
        session_name,
        ..
    } = target else {
        return Err("target is not remote_tmux".to_string());
    };

    let format_str = "#{session_name}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{pane_current_path}";
    let metadata_stdout = run_remote_ssh_script(
        &host,
        user.as_deref(),
        port,
        identity_file.as_deref(),
        &format!(
            "tmux display-message -p -t {} {}",
            crate::session_manager::quote_remote_shell_arg(&session_name),
            crate::session_manager::quote_remote_shell_arg(format_str),
        ),
    )?;

    let (session_name, window_id, window_name, pane_id, cwd) =
        parse_remote_tmux_probe_output(&metadata_stdout, &session_name);

    let (repo_root, repo_name, git_branch, worktree_name, is_worktree) = if let Some(cwd) = cwd.as_deref() {
        let git_stdout = run_remote_ssh_script(
            &host,
            user.as_deref(),
            port,
            identity_file.as_deref(),
            &build_remote_git_probe_script(cwd),
        )
        .unwrap_or_default();
        parse_remote_git_probe_output(&git_stdout)
    } else {
        (String::new(), String::new(), String::new(), String::new(), false)
    };

    Ok(RemoteTmuxMetadataResult {
        session_name,
        window_id,
        window_name,
        pane_id,
        cwd,
        repo_root,
        repo_name,
        git_branch,
        worktree_name,
        is_worktree,
    })
}

#[tauri::command]
pub async fn inspect_remote_tmux_state(
    target: ShellTarget,
) -> Result<RemoteTmuxStateResult, String> {
    let metadata = probe_remote_tmux_metadata(target.clone()).await?;
    let ShellTarget::RemoteTmux {
        host,
        user,
        port,
        identity_file,
        ..
    } = target else {
        return Err("target is not remote_tmux".to_string());
    };

    let sessions_stdout = run_remote_ssh_script(
        &host,
        user.as_deref(),
        port,
        identity_file.as_deref(),
        "tmux list-sessions -F '#{session_name}\t#{session_attached}\t#{session_windows}'",
    )?;
    let windows_stdout = run_remote_ssh_script(
        &host,
        user.as_deref(),
        port,
        identity_file.as_deref(),
        "tmux list-windows -a -F '#{session_name}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}'",
    )?;
    let panes_stdout = run_remote_ssh_script(
        &host,
        user.as_deref(),
        port,
        identity_file.as_deref(),
        "tmux list-panes -a -F '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_index}\t#{pane_pid}\t#{pane_active}\t#{pane_last}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_title}'",
    )?;
    let ages_stdout = build_remote_process_age_script(&panes_stdout)
        .map(|script| run_remote_ssh_script(&host, user.as_deref(), port, identity_file.as_deref(), &script).unwrap_or_default())
        .unwrap_or_default();

    Ok(build_remote_tmux_state_from_outputs(
        &metadata.session_name,
        &metadata.window_id,
        &metadata.pane_id,
        &sessions_stdout,
        &windows_stdout,
        &panes_stdout,
        &ages_stdout,
    ))
}

#[tauri::command]
pub async fn manage_remote_tmux(
    target: ShellTarget,
    scope: String,
    action: String,
    tmux_target: Option<String>,
    name: Option<String>,
) -> Result<RemoteTmuxActionResult, String> {
    let ShellTarget::RemoteTmux {
        host,
        user,
        port,
        identity_file,
        ..
    } = target else {
        return Err("target is not remote_tmux".to_string());
    };

    let script = build_remote_tmux_management_script(
        scope.as_str(),
        action.as_str(),
        tmux_target.as_deref(),
        name.as_deref(),
    )?;
    let stdout = run_remote_ssh_script(
        &host,
        user.as_deref(),
        port,
        identity_file.as_deref(),
        &script,
    )?;
    Ok(RemoteTmuxActionResult {
        resolved_target: stdout.trim().to_string(),
    })
}

fn run_remote_ssh_script(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
    identity_file: Option<&str>,
    script: &str,
) -> Result<String, String> {
    let ssh = crate::session_manager::find_exe("ssh.exe")
        .unwrap_or_else(|| "ssh.exe".to_string());
    let mut cmd = Command::new(ssh);
    if let Some(port) = port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(identity_file) = identity_file {
        cmd.arg("-i").arg(crate::session_manager::ssh_identity_path(identity_file));
    }
    cmd.args(["-o", "BatchMode=yes"]);
    cmd.args(["-o", "ConnectTimeout=5"]);
    match user {
        Some(user) => cmd.arg(format!("{user}@{host}")),
        None => cmd.arg(host),
    };
    cmd.arg("sh").arg("-lc").arg(script);

    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!("remote command exited with status {}", output.status)
        } else {
            stderr
        };
        return Err(message);
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn build_remote_git_probe_script(cwd: &str) -> String {
    let quoted_cwd = crate::session_manager::quote_remote_shell_arg(cwd);
    format!(
        "if git -C {cwd} rev-parse --show-toplevel >/dev/null 2>&1; then \
root=$(git -C {cwd} rev-parse --show-toplevel 2>/dev/null || true); \
branch=$(git -C {cwd} branch --show-current 2>/dev/null || true); \
gitdir=$(git -C {cwd} rev-parse --git-dir 2>/dev/null || true); \
common=$(git -C {cwd} rev-parse --git-common-dir 2>/dev/null || true); \
repo=$(basename \"$root\"); \
worktree=''; is_worktree=0; \
if [ -n \"$gitdir\" ] && [ -n \"$common\" ] && [ \"$gitdir\" != \"$common\" ]; then \
  is_worktree=1; worktree=$(basename \"$(dirname \"$gitdir\")\"); \
fi; \
printf '%s\t%s\t%s\t%s\t%s\n' \"$root\" \"$repo\" \"$branch\" \"$worktree\" \"$is_worktree\"; \
fi",
        cwd = quoted_cwd,
    )
}

fn parse_remote_tmux_probe_output(
    stdout: &str,
    fallback_session_name: &str,
) -> (String, String, String, String, Option<String>) {
    let mut parts = stdout.trim_end_matches(['\r', '\n']).splitn(5, '\t');
    let session_name = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_session_name)
        .to_string();
    let window_id = parts.next().map(str::trim).unwrap_or_default().to_string();
    let window_name = parts.next().map(str::trim).unwrap_or_default().to_string();
    let pane_id = parts.next().map(str::trim).unwrap_or_default().to_string();
    let cwd = parts
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    (session_name, window_id, window_name, pane_id, cwd)
}

fn parse_remote_git_probe_output(stdout: &str) -> (String, String, String, String, bool) {
    let mut git_parts = stdout.trim().splitn(5, '\t');
    let repo_root = git_parts.next().map(str::trim).unwrap_or_default().to_string();
    let repo_name = git_parts.next().map(str::trim).unwrap_or_default().to_string();
    let git_branch = git_parts.next().map(str::trim).unwrap_or_default().to_string();
    let worktree_name = git_parts.next().map(str::trim).unwrap_or_default().to_string();
    let is_worktree = git_parts.next().map(str::trim) == Some("1");
    (repo_root, repo_name, git_branch, worktree_name, is_worktree)
}

fn parse_remote_tmux_session_lines(stdout: &str) -> Vec<(String, usize, usize)> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let session_name = parts.next()?.trim();
            if session_name.is_empty() {
                return None;
            }
            let attached_clients = parts
                .next()
                .map(str::trim)
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            let window_count = parts
                .next()
                .map(str::trim)
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            Some((session_name.to_string(), attached_clients, window_count))
        })
        .collect()
}

fn parse_remote_tmux_window_lines(stdout: &str) -> Vec<(String, String, String, String, bool)> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(5, '\t');
            let session_name = parts.next()?.trim();
            let window_id = parts.next()?.trim();
            if session_name.is_empty() || window_id.is_empty() {
                return None;
            }
            let window_index = parts.next().map(str::trim).unwrap_or_default().to_string();
            let window_name = parts.next().map(str::trim).unwrap_or_default().to_string();
            let is_active = parts.next().map(str::trim) == Some("1");
            Some((
                session_name.to_string(),
                window_id.to_string(),
                window_index,
                window_name,
                is_active,
            ))
        })
        .collect()
}

fn parse_remote_tmux_pane_lines(stdout: &str) -> Vec<(String, String, RemoteTmuxPaneResult)> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(10, '\t');
            let session_name = parts.next()?.trim();
            let window_id = parts.next()?.trim();
            let pane_id = parts.next()?.trim();
            if session_name.is_empty() || window_id.is_empty() || pane_id.is_empty() {
                return None;
            }
            Some((
                session_name.to_string(),
                window_id.to_string(),
                RemoteTmuxPaneResult {
                    pane_id: pane_id.to_string(),
                    pane_index: parts.next().map(str::trim).unwrap_or_default().to_string(),
                    pane_pid: parts.next().map(str::trim).unwrap_or_default().to_string(),
                    is_active: parts.next().map(str::trim) == Some("1"),
                    was_last_active: parts.next().map(str::trim) == Some("1"),
                    current_command: parts.next().map(str::trim).unwrap_or_default().to_string(),
                    cwd: parts.next().map(str::trim).unwrap_or_default().to_string(),
                    title: parts.next().map(str::trim).unwrap_or_default().to_string(),
                    command_age: String::new(),
                },
            ))
        })
        .collect()
}

fn parse_remote_process_age_output(stdout: &str) -> HashMap<String, String> {
    stdout
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            let mut parts = trimmed.split_whitespace();
            let pid = parts.next()?;
            let age = parts.next()?;
            Some((pid.to_string(), age.to_string()))
        })
        .collect()
}

fn build_remote_process_age_script(panes_stdout: &str) -> Option<String> {
    let mut pids: Vec<String> = parse_remote_tmux_pane_lines(panes_stdout)
        .into_iter()
        .map(|(_, _, pane)| pane.pane_pid)
        .filter(|pid| !pid.is_empty() && pid.chars().all(|ch| ch.is_ascii_digit()))
        .collect();
    pids.sort();
    pids.dedup();
    if pids.is_empty() {
        return None;
    }
    Some(format!(
        "ps -o pid=,etime= -p {} 2>/dev/null || true",
        pids.join(",")
    ))
}

fn build_remote_tmux_management_script(
    scope: &str,
    action: &str,
    tmux_target: Option<&str>,
    name: Option<&str>,
) -> Result<String, String> {
    match (scope, action) {
        ("session", "create") => {
            let name = name.map(str::trim).filter(|value| !value.is_empty()).ok_or("session name is required")?;
            Ok(format!(
                "tmux new-session -d -P -F '#{{session_name}}' -s {}",
                crate::session_manager::quote_remote_shell_arg(name),
            ))
        }
        ("session", "rename") => {
            let target = tmux_target.map(str::trim).filter(|value| !value.is_empty()).ok_or("session target is required")?;
            let name = name.map(str::trim).filter(|value| !value.is_empty()).ok_or("new session name is required")?;
            Ok(format!(
                "tmux rename-session -t {} {}; printf '%s\\n' {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(name),
                crate::session_manager::quote_remote_shell_arg(name),
            ))
        }
        ("session", "kill") => {
            let target = tmux_target.map(str::trim).filter(|value| !value.is_empty()).ok_or("session target is required")?;
            Ok(format!(
                "tmux kill-session -t {}; printf '%s\\n' {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(target),
            ))
        }
        ("window", "create") => {
            let target = tmux_target.map(str::trim).filter(|value| !value.is_empty()).ok_or("window session target is required")?;
            let name = name.map(str::trim).filter(|value| !value.is_empty()).ok_or("window name is required")?;
            Ok(format!(
                "tmux new-window -P -F '#{{window_id}}' -t {} -n {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(name),
            ))
        }
        ("window", "rename") => {
            let target = tmux_target.map(str::trim).filter(|value| !value.is_empty()).ok_or("window target is required")?;
            let name = name.map(str::trim).filter(|value| !value.is_empty()).ok_or("new window name is required")?;
            Ok(format!(
                "tmux rename-window -t {} {}; printf '%s\\n' {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(name),
                crate::session_manager::quote_remote_shell_arg(target),
            ))
        }
        ("window", "kill") => {
            let target = tmux_target.map(str::trim).filter(|value| !value.is_empty()).ok_or("window target is required")?;
            Ok(format!(
                "tmux kill-window -t {}; printf '%s\\n' {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(target),
            ))
        }
        _ => Err(format!("unsupported remote tmux action: {scope}/{action}")),
    }
}

fn build_remote_tmux_state_from_outputs(
    current_session_name: &str,
    current_window_id: &str,
    current_pane_id: &str,
    sessions_stdout: &str,
    windows_stdout: &str,
    panes_stdout: &str,
    ages_stdout: &str,
) -> RemoteTmuxStateResult {
    let process_ages = parse_remote_process_age_output(ages_stdout);
    let mut sessions: Vec<RemoteTmuxSessionResult> = Vec::new();
    let mut session_indexes: HashMap<String, usize> = HashMap::new();
    let mut window_indexes: HashMap<String, (usize, usize)> = HashMap::new();

    for (session_name, attached_clients, window_count) in parse_remote_tmux_session_lines(sessions_stdout) {
        let session_index = sessions.len();
        session_indexes.insert(session_name.clone(), session_index);
        sessions.push(RemoteTmuxSessionResult {
            session_name: session_name.clone(),
            attached_clients,
            window_count,
            is_current: session_name == current_session_name,
            windows: Vec::new(),
        });
    }

    if !current_session_name.is_empty() && !session_indexes.contains_key(current_session_name) {
        let session_index = sessions.len();
        session_indexes.insert(current_session_name.to_string(), session_index);
        sessions.push(RemoteTmuxSessionResult {
            session_name: current_session_name.to_string(),
            attached_clients: 0,
            window_count: 0,
            is_current: true,
            windows: Vec::new(),
        });
    }

    for (session_name, window_id, window_index, window_name, is_active) in parse_remote_tmux_window_lines(windows_stdout) {
        let Some(&session_index) = session_indexes.get(&session_name) else {
            continue;
        };
        let window_position = sessions[session_index].windows.len();
        sessions[session_index].windows.push(RemoteTmuxWindowResult {
            window_id: window_id.clone(),
            window_index,
            window_name,
            is_active: is_active || window_id == current_window_id,
            panes: Vec::new(),
        });
        window_indexes.insert(window_id, (session_index, window_position));
    }

    for (_, window_id, mut pane) in parse_remote_tmux_pane_lines(panes_stdout) {
        let Some((session_index, window_position)) = window_indexes.get(&window_id).copied() else {
            continue;
        };
        if pane.pane_id == current_pane_id {
            pane.is_active = true;
        }
        if let Some(age) = process_ages.get(&pane.pane_pid) {
            pane.command_age = age.clone();
        }
        sessions[session_index].windows[window_position].panes.push(pane);
    }

    RemoteTmuxStateResult {
        current_session_name: current_session_name.to_string(),
        current_window_id: current_window_id.to_string(),
        current_pane_id: current_pane_id.to_string(),
        sessions,
    }
}

/// Must be called by the frontend immediately after `listen("terminal-output-{id}")`.
/// Drains any output that arrived before the listener was ready, then streams live.
#[tauri::command]
pub async fn start_session_stream(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    let session = manager.get(&id).await.ok_or("session not found")?;
    let block_store = manager.get_block_store(&id).await.ok_or("session not found")?;

    // Take the initial receiver — created at spawn time, so it has all output
    // buffered since the session started.
    let mut rx = session
        .initial_rx
        .lock()
        .await
        .take()
        .ok_or("session stream already started")?;

    let event_id         = format!("terminal-output-{id}");
    let url_event_id     = format!("terminal-url-{id}");
    let exit_event_id    = format!("terminal-exit-{id}");
    let clipboard_ev     = format!("terminal-clipboard-{id}");
    let notify_ev        = format!("terminal-notify-{id}");
    let cwd_ev           = format!("terminal-cwd-{id}");
    let block_start_ev   = format!("terminal-block-start-{id}");
    let block_end_ev     = format!("terminal-block-end-{id}");
    let block_cmd_ev     = format!("terminal-block-cmd-{id}");
    let block_done_ev    = format!("terminal-block-done-{id}");
    let id_clone = id.clone();

    tokio::spawn(async move {
        let mut seen_urls: HashSet<String> = HashSet::new();

        loop {
            match rx.recv().await {
                Ok(chunk) => {
                    let b64 = base64_encode(&chunk);
                    if app.emit(&event_id, b64).is_err() {
                        break;
                    }

                    for (url, is_oauth) in url_detector::extract_notable_urls(&chunk) {
                        if seen_urls.insert(url.clone()) {
                            let payload = UrlDetectedPayload { url, is_oauth };
                            let _ = app.emit(&url_event_id, payload);
                        }
                    }

                    // Feed raw bytes into the block accumulator while a command is running.
                    block_store.lock().await.feed(&chunk);

                    // OSC 7 cwd + OSC 9/99/777 notifications + OSC 133 blocks.
                    for event in osc_parser::extract_osc_events(&chunk) {
                        match event {
                            OscEvent::Notification(n) => {
                                let _ = app.emit(&notify_ev,
                                    OscNotificationPayload { title: n.title, body: n.body });
                            }
                            OscEvent::Cwd(path) => {
                                let _ = app.emit(&cwd_ev, path);
                            }
                            OscEvent::Clipboard(text) => {
                                let _ = app.emit(&clipboard_ev, ClipboardPayload { text });
                            }
                            OscEvent::BlockPromptStart => {}
                            OscEvent::BlockCommandStart => {
                                block_store.lock().await.on_command_start();
                                let _ = app.emit(&block_start_ev, BlockStartPayload {});
                            }
                            OscEvent::BlockCommandFinished { exit_code } => {
                                let _ = app.emit(&block_end_ev, BlockEndPayload { exit_code });
                                if let Some(block) = block_store.lock().await.on_command_finished(exit_code) {
                                    let _ = app.emit(&block_done_ev, block);
                                }
                            }
                            OscEvent::BlockCommandLine(command) => {
                                block_store.lock().await.on_command_line(&command);
                                let _ = app.emit(&block_cmd_ev, BlockCommandLinePayload { command });
                            }
                        }
                    }

                    if app.webview_windows().is_empty() {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
        let _ = app.emit(&exit_event_id, SessionExitPayload { id: id_clone.clone() });
        log::debug!("Output forwarder for session {id_clone} terminated.");
    });

    Ok(())
}

/// Return the most-recent completed command blocks for a session.
///
/// Each block contains the command text, plain-text output (ANSI stripped),
/// exit code, and timestamps — ready for agent consumption.
///
/// `limit` defaults to 20; maximum is 200.
#[tauri::command]
pub async fn get_blocks(
    manager: State<'_, SessionManager>,
    session_id: String,
    limit: Option<usize>,
) -> Result<Vec<TermBlock>, String> {
    let limit = limit.unwrap_or(20).min(BlockStore::MAX_BLOCKS);
    let store = manager
        .get_block_store(&session_id)
        .await
        .ok_or("session not found")?;
    let blocks = store.lock().await.recent(limit);
    Ok(blocks)
}

/// Close a terminal session.
#[tauri::command]
pub async fn close_session(
    manager: State<'_, SessionManager>,
    tunnels: State<'_, TunnelManager>,
    id: String,
) -> Result<(), String> {
    tunnels.kill_for_pane(&id).await;
    manager.close(&id).await;
    Ok(())
}

/// Send keyboard input to a session.
#[tauri::command]
pub async fn write_to_session(
    manager: State<'_, SessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let session = manager.get(&id).await.ok_or("session not found")?;
    session.write(data.as_bytes()).await.map_err(|e| e.to_string())
}

/// Resize a session's pseudoconsole.
#[tauri::command]
pub async fn resize_session(
    manager: State<'_, SessionManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = manager.get(&id).await.ok_or("session not found")?;
    session.resize(cols, rows).map_err(|e| e.to_string())
}

/// List active session IDs.
#[tauri::command]
pub async fn list_sessions(manager: State<'_, SessionManager>) -> Result<Vec<String>, String> {
    Ok(manager.list().await)
}

/// Return all installed WSL distros. Returns an empty list if WSL is not
/// installed or the `wsl.exe` binary cannot be found.
#[tauri::command]
pub async fn list_wsl_distros() -> Result<Vec<WslDistro>, String> {
    Ok(crate::session_manager::list_wsl_distros())
}

/// Open a localhost URL in the system default browser.
/// Strictly validates that the URL is localhost-only before opening.
#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !url_detector::is_safe_to_open(&url) {
        return Err(format!("Refused to open non-localhost or malformed URL: {url}"));
    }
    opener::open_browser(&url).map_err(|e| e.to_string())
}

/// Open an arbitrary URL in the system default browser.
///
/// Unlike `open_url`, this accepts any http(s) URL — intended for the browser
/// pane's "open externally" button, where the user explicitly drives the
/// action. NOT safe to call from terminal-URL-detection paths (use `open_url`
/// for that — it restricts to localhost as a phishing/malware guard).
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("Refused to open non-http(s) URL: {url}"));
    }
    opener::open_browser(&url).map_err(|e| e.to_string())
}

/// Resolve a localhost URL for a given pane, creating an SSH or WSL port-forward
/// tunnel if needed.  Returns the URL to open in the wmux browser (remapped to
/// the forwarded local port for SSH/WSL, unchanged for local sessions).
#[tauri::command]
pub async fn resolve_localhost_url(
    pane_id: String,
    url: String,
    manager: State<'_, SessionManager>,
    tunnels: State<'_, TunnelManager>,
) -> Result<String, String> {
    if !url_detector::is_safe_to_open(&url) {
        return Err(format!("not a localhost URL: {url}"));
    }
    let target = manager.get_target(&pane_id).await
        .ok_or_else(|| format!("session not found: {pane_id}"))?;
    tunnels.resolve(&pane_id, &target, &url).await
}

/// Read plain text from the system clipboard.
#[tauri::command]
pub async fn read_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        clipboard_win::get_clipboard_string().map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("clipboard read is only implemented on Windows".to_string())
    }
}

/// Save the serialised tab/pane layout JSON to the app data directory.
/// The JSON is validated before writing to avoid persisting corrupt data.
#[tauri::command]
pub async fn save_layout(app: AppHandle, layout_json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&layout_json)
        .map_err(|e| format!("Invalid layout JSON: {e}"))?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("layout.json");
    std::fs::write(path, layout_json).map_err(|e| e.to_string())
}

/// Load the previously saved layout JSON from the app data directory.
/// Returns `None` when no saved layout exists yet.
#[tauri::command]
pub async fn load_layout(app: AppHandle) -> Result<Option<String>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("layout.json");
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
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

    entries.sort_by_key(|entry| std::cmp::Reverse(entry.saved_at));
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

/// Return the VT-stripped scrollback buffer for a named IPC session.
/// Useful for debugging; primarily consumed by the `tmux capture-pane` path.
#[tauri::command]
pub async fn capture_session_output(
    manager: State<'_, SessionManager>,
    name: String,
) -> Result<Option<String>, String> {
    Ok(manager.capture_output(&name).await)
}

/// Return the VT-stripped scrollback buffer for a live session id.
/// Used by the frontend to extract renderable HTML artifacts from terminal output.
#[tauri::command]
pub async fn capture_session_output_by_id(
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<Option<String>, String> {
    Ok(manager.capture_output_by_id(&id).await)
}

/// Persist an extracted HTML artifact locally and return a file URL that the
/// embedded browser webview can navigate to.
#[tauri::command]
pub async fn save_artifact_preview(app: AppHandle, html: String) -> Result<String, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let artifacts_dir = data_dir.join("artifacts");
    std::fs::create_dir_all(&artifacts_dir).map_err(|e| e.to_string())?;

    let file_name = format!("artifact-{}.html", uuid_short());
    let path = artifacts_dir.join(&file_name);
    std::fs::write(&path, html).map_err(|e| e.to_string())?;

    // Return an HTTP URL via the local API server so the in-app iframe can
    // load it without hitting cross-origin file:// restrictions.
    Ok(format!(
        "http://localhost:{}/artifact/{}",
        crate::http_server::PORT,
        file_name
    ))
}

/// Read a UTF-8 text file from the local filesystem for the markdown viewer.
#[tauri::command]
pub async fn read_text_file(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err(format!("File not found: {}", path.display()));
    }

    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > 1_048_576 {
        return Err(format!("Refusing to open files larger than 1 MiB: {}", path.display()));
    }

    std::fs::read_to_string(&path).map_err(|e| format!("Could not read {}: {e}", path.display()))
}

/// Return the current git branch for the given directory, or None.
#[tauri::command]
pub async fn get_git_branch(cwd: String) -> Result<Option<String>, String> {
    git_stdout(&cwd, &["branch", "--show-current"])
}

/// Return repo/worktree context for the given directory, or None when `cwd`
/// is not inside a git repository.
#[tauri::command]
pub async fn get_git_context(cwd: String) -> Result<Option<GitContextResult>, String> {
    let repo_root = match git_stdout(&cwd, &["rev-parse", "--show-toplevel"])? {
        Some(value) => value,
        None => return Ok(None),
    };

    let branch = git_stdout(&cwd, &["branch", "--show-current"])?;
    let git_dir_raw = match git_stdout(&cwd, &["rev-parse", "--git-dir"])? {
        Some(value) => value,
        None => return Ok(None),
    };
    let common_dir_raw = match git_stdout(&cwd, &["rev-parse", "--git-common-dir"])? {
        Some(value) => value,
        None => return Ok(None),
    };

    let cwd_path = Path::new(&cwd);
    let repo_root_path = PathBuf::from(&repo_root);
    let git_dir = resolve_git_path(cwd_path, &git_dir_raw);
    let common_dir = resolve_git_path(cwd_path, &common_dir_raw);
    let is_worktree = git_dir != common_dir;

    let repo_name = common_dir
        .parent()
        .and_then(|path| path.file_name())
        .or_else(|| repo_root_path.file_name())
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "repo".to_string());

    let worktree_name = if is_worktree {
        repo_root_path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .or_else(|| {
                git_dir
                    .parent()
                    .and_then(|path| path.file_name())
                    .map(|value| value.to_string_lossy().into_owned())
            })
    } else {
        None
    };

    Ok(Some(GitContextResult {
        repo_root,
        repo_name,
        branch,
        worktree_name,
        is_worktree,
    }))
}

fn git_stdout(cwd: &str, args: &[&str]) -> Result<Option<String>, String> {
    #[cfg(windows)]
    use std::os::windows::process::CommandExt as _;

    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(None);
    }

    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(if value.is_empty() { None } else { Some(value) })
}

fn detect_base_ref(cwd: &str) -> String {
    // For PR review we want the main branch, NOT the upstream tracking branch
    // (@{upstream} points to origin/<current-branch> which is at HEAD — empty diff).
    let candidates = ["origin/main", "origin/master", "main", "master"];
    for candidate in &candidates {
        if git_stdout(cwd, &["rev-parse", "--verify", candidate])
            .unwrap_or(None)
            .is_some()
        {
            return candidate.to_string();
        }
    }
    "HEAD~1".to_string()
}

/// Return the list of files changed between base and HEAD, with +/- stats.
#[tauri::command]
pub async fn get_pr_diff_summary(cwd: String, base: Option<String>) -> Result<PrDiffSummary, String> {
    let cwd = if cwd.is_empty() {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        cwd
    };
    let base_ref = base.filter(|s| !s.is_empty()).unwrap_or_else(|| detect_base_ref(&cwd));

    let numstat = git_stdout(&cwd, &["diff", "--numstat", &base_ref])?
        .unwrap_or_default();

    let mut files = Vec::new();
    let mut total_additions = 0usize;
    let mut total_deletions = 0usize;

    for line in numstat.lines() {
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let additions: usize = parts[0].parse().unwrap_or(0);
        let deletions: usize = parts[1].parse().unwrap_or(0);
        let raw_path = parts[2];

        // Detect rename: "old/path => new/path" or "{old => new}/tail"
        let (path, status) = if raw_path.contains(" => ") {
            // Extract the destination path.
            let dest = if let (Some(open), Some(close)) = (raw_path.find('{'), raw_path.find('}')) {
                let prefix = &raw_path[..open];
                let suffix = &raw_path[close + 1..];
                let alternatives = &raw_path[open + 1..close];
                let new_part = alternatives.split(" => ").nth(1).unwrap_or("").trim();
                format!("{prefix}{new_part}{suffix}")
            } else {
                raw_path.split(" => ").nth(1).unwrap_or(raw_path).trim().to_string()
            };
            (dest, "renamed".to_string())
        } else {
            (raw_path.to_string(), "modified".to_string())
        };

        // Refine status from additions/deletions: all adds = new file, all dels = deleted.
        let status = if additions > 0 && deletions == 0 { "added".to_string() }
                     else if additions == 0 && deletions > 0 { "deleted".to_string() }
                     else { status };

        total_additions += additions;
        total_deletions += deletions;
        files.push(PrDiffFile { path, additions, deletions, status });
    }

    Ok(PrDiffSummary { base_ref, resolved_cwd: cwd, files, total_additions, total_deletions })
}

/// Return the raw unified diff for a single file between base and HEAD.
#[tauri::command]
pub async fn get_pr_file_diff(cwd: String, base: String, path: String) -> Result<String, String> {
    let cwd = if cwd.is_empty() {
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    } else {
        cwd
    };
    git_stdout(&cwd, &["diff", &base, "--", &path])
        .map(|opt| opt.unwrap_or_default())
}

/// Ask Claude about a diff context from the PR review panel.
#[tauri::command]
pub async fn ask_claude_about_diff(
    question: String,
    diff_context: String,
    file_path: String,
) -> Result<String, String> {
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .map_err(|_| "ANTHROPIC_API_KEY environment variable is not set".to_string())?;

    let context = if diff_context.len() > 8000 {
        format!("{}\n… (truncated)", &diff_context[..8000])
    } else {
        diff_context
    };

    let user_content = if file_path.is_empty() {
        format!("Diff:\n```diff\n{context}\n```\n\nQuestion: {question}")
    } else {
        format!("File: {file_path}\n\nDiff:\n```diff\n{context}\n```\n\nQuestion: {question}")
    };

    let body = serde_json::json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 1024,
        "system": "You are a code reviewer. The user will show you a git diff and ask questions about it. Be concise and precise.",
        "messages": [{"role": "user", "content": user_content}]
    });

    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {e}"))?;

    let status = resp.status();
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {e}"))?;

    if !status.is_success() {
        let msg = json["error"]["message"].as_str().unwrap_or("Unknown API error");
        return Err(format!("API error {status}: {msg}"));
    }

    json["content"][0]["text"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| format!("Unexpected response format: {json}"))
}

fn resolve_git_path(cwd: &Path, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
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

/// Open a new independent wmux application window.
#[tauri::command]
pub async fn create_app_window(app: AppHandle) -> Result<(), String> {
    let label = format!("wmux-{}", &uuid_short());
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("wmux")
    .inner_size(1280.0, 800.0)
    .min_inner_size(800.0, 500.0)
    .resizable(true)
    .decorations(true);

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon).map_err(|e| e.to_string())?;
    }

    builder.build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn uuid_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:08x}", n)
}

/// Spawn the out-of-process CEF browser helper, parented to the given wmux
/// window. The helper appears as a Win32 child of the main webview's HWND so
/// its focus events stay inside the helper's own message pump and can't wedge
/// our ConPTY sessions the way an in-process child WebView2 did.
///
/// Spike-phase contract: caller supplies a starting URL; the helper renders it
/// at a fixed initial position inside the parent window. Future work (separate
/// PR) adds named-pipe IPC for runtime navigate / geometry / close, replacing
/// "kill and respawn" with proper control.
///
/// Returns the helper's PID so the caller can track it for cleanup.
#[tauri::command]
pub async fn spawn_browser_helper(
    app: AppHandle,
    window_label: String,
    url: String,
) -> Result<u32, String> {
    let window = app
        .get_window(&window_label)
        .ok_or_else(|| format!("window '{}' not found", window_label))?;

    // The helper expects a Win32 HWND value for --parent-hwnd. We use the
    // wmux native window HWND (Tauri main window) as the parent. The CEF
    // child window will appear inside that HWND at a fixed default position;
    // real geometry sync waits for the IPC layer.
    #[cfg(target_os = "windows")]
    let parent_hwnd: usize = {
        let hwnd = window
            .hwnd()
            .map_err(|e| format!("could not get parent HWND: {e}"))?;
        // tauri's HWND wraps a *mut c_void; cast to usize for command-line.
        hwnd.0 as usize
    };

    #[cfg(not(target_os = "windows"))]
    let parent_hwnd: usize = 0; // Stub: helper only useful on Windows currently.

    // Per-helper isolated user data dir so multiple panes / restarts don't
    // collide on Chromium's lock file.
    let user_data_dir = std::env::temp_dir()
        .join(format!("wmux-browser-helper-{}", uuid_short()))
        .to_string_lossy()
        .into_owned();

    // Locate the helper binary. In dev (`cargo run` from src-tauri or
    // workspace root) it sits at `target/debug/wmux-browser-helper.exe`
    // beside the wmux binary. In a packaged build it'll be bundled
    // adjacent to wmux.exe via the MSI installer (TODO once Phase 5 lands).
    let helper_path = std::env::current_exe()
        .map_err(|e| format!("could not locate current exe: {e}"))?
        .parent()
        .ok_or_else(|| "current exe has no parent dir".to_string())?
        .join(if cfg!(windows) { "wmux-browser-helper.exe" } else { "wmux-browser-helper" });

    if !helper_path.exists() {
        return Err(format!(
            "wmux-browser-helper binary not found at {}. \
             Build with `cargo build --package wmux-browser-helper` first.",
            helper_path.display()
        ));
    }

    let child = std::process::Command::new(&helper_path)
        .arg(format!("--parent-hwnd={parent_hwnd}"))
        .arg(format!("--url={url}"))
        .arg(format!("--user-data-dir={user_data_dir}"))
        .spawn()
        .map_err(|e| format!("failed to spawn browser helper: {e}"))?;

    let pid = child.id();
    // std::process::Child does NOT kill the process on drop — the helper
    // keeps running independently after we return. Proper tracking (so
    // callers can kill helpers on pane close) is a Phase 3/4 follow-up.
    drop(child);

    Ok(pid)
}

/// Create a borderless browser WebviewWindow positioned at the given screen coords.
#[tauri::command]
pub async fn create_browser_window(app: AppHandle, request: CreateBrowserWindowRequest) -> Result<(), String> {
    let window = app
        .get_window(&request.window_label)
        .ok_or_else(|| format!("window '{}' not found", request.window_label))?;
    let parsed = url::Url::parse(&request.url).map_err(|e| e.to_string())?;
    let builder = tauri::webview::WebviewBuilder::new(
        &request.label,
        tauri::WebviewUrl::External(parsed),
    )
    .focused(false)
    .accept_first_mouse(false);
    let webview = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(request.geometry.x as f64, request.geometry.y as f64),
            tauri::LogicalSize::new(request.geometry.width as f64, request.geometry.height as f64),
        )
        .map_err(|e| e.to_string())?;

    // Immediately disable the browser container HWND so that WebView2's async
    // initialisation cannot steal OS keyboard focus from the main WebView2.
    //
    // EnableWindow(FALSE) is stronger than WS_EX_NOACTIVATE:
    //   • WS_EX_NOACTIVATE – prevents window *activation* (SetForegroundWindow),
    //     but SetFocus() on a non-active child still succeeds.
    //   • EnableWindow(FALSE) – a disabled HWND cannot receive focus from any
    //     source; SetFocus() calls targeting it (or any of its children) are
    //     silently ignored by the OS.
    //
    // set_browser_focusable(true) will re-enable the HWND when the user
    // explicitly activates the browser pane.
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE, WS_EX_NOACTIVATE,
        };
        let _ = webview.with_webview(|wv| unsafe {
            use windows::Win32::Foundation::HWND;
            let mut hwnd = HWND::default();
            let _ = wv.controller().ParentWindow(&mut hwnd);
            // WS_DISABLED: Windows will not deliver SetFocus() to a disabled
            // window or any of its children — this is the only reliable way to
            // block the Chromium-internal focus steal that happens during
            // WebView2 navigation (the steal occurs at the Chrome_WidgetWin
            // child HWND level, which never surfaces as a controller GotFocus
            // event).  set_browser_focusable(true) removes this bit when the
            // user explicitly activates the browser pane.
            const WS_DISABLED_BIT: isize = 0x0800_0000;
            let ws = GetWindowLongPtrW(hwnd, GWL_STYLE);
            SetWindowLongPtrW(hwnd, GWL_STYLE, ws | WS_DISABLED_BIT);
            // WS_EX_NOACTIVATE: belt-and-suspenders for click-activation.
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize);
        });
    }

    Ok(())
}

/// Bring a wmux window to the foreground so keyboard input returns to it.
#[tauri::command]
pub async fn focus_app_window(app: AppHandle, window_label: String) -> Result<(), String> {
    let window = app
        .get_window(&window_label)
        .ok_or_else(|| format!("window '{}' not found", window_label))?;
    window.set_focus().map_err(|e| e.to_string())
}

/// Restore OS keyboard focus to the main webview (the one running the app UI).
///
/// Call this when a browser child-webview's WebView2 async initialisation has
/// stolen HWND focus from the main WebView2.  `window.set_focus()` only calls
/// `SetForegroundWindow()` which is a no-op if the main window is already the
/// foreground window.  The correct API is
/// `ICoreWebView2Controller::MoveFocus(PROGRAMMATIC)`.
#[tauri::command]
pub async fn focus_main_webview(app: AppHandle, window_label: String) -> Result<(), String> {
    let webview = app
        .get_webview(&window_label)
        .ok_or_else(|| format!("main webview '{}' not found", window_label))?;

    #[cfg(target_os = "windows")]
    {
        webview
            .with_webview(|wv| unsafe {
                // COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC = 0
                // Transmute avoids adding webview2-com as a direct dependency;
                // COREWEBVIEW2_MOVE_FOCUS_REASON is repr(transparent) over i32.
                #[allow(clippy::missing_transmute_annotations)]
                let _ = wv.controller().MoveFocus(std::mem::transmute(0i32));
            })
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Allow or prevent a browser webview from taking keyboard focus.
///
/// `focusable=false`: called when a terminal or other surface becomes active.
///   Reclaims OS keyboard focus to the main webview first, then sets
///   WS_DISABLED + WS_EX_NOACTIVATE on the browser HWND so neither WebView2
///   navigation nor the Chromium render HWND can steal focus until the user
///   explicitly activates the browser again.
///
/// `focusable=true`: called when the user activates the browser pane.
///   Removes WS_DISABLED + WS_EX_NOACTIVATE so clicks and keyboard events
///   reach the browser content.
#[tauri::command]
pub async fn set_browser_focusable(
    app: AppHandle,
    label: String,
    focusable: bool,
    window_label: String,
) -> Result<(), String> {
    // When disabling, reclaim focus to the main webview BEFORE setting
    // WS_DISABLED.  If the browser currently has OS focus, setting WS_DISABLED
    // while it holds focus would leave the keyboard in a dead state.
    #[cfg(target_os = "windows")]
    if !focusable {
        if let Some(main_wv) = app.get_webview(&window_label) {
            let _ = main_wv.with_webview(|mv| unsafe {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::Input::KeyboardAndMouse::SetFocus;
                let mut h = HWND::default();
                let _ = mv.controller().ParentWindow(&mut h);
                let _ = SetFocus(Some(h));
                #[allow(clippy::missing_transmute_annotations)]
                let _ = mv.controller().MoveFocus(std::mem::transmute(0i32));
            });
        }
    }

    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, GWL_STYLE, WS_EX_NOACTIVATE,
        };
        webview
            .with_webview(move |wv| unsafe {
                let mut hwnd = HWND::default();
                let _ = wv.controller().ParentWindow(&mut hwnd);
                const WS_DISABLED_BIT: isize = 0x0800_0000;
                let ws = GetWindowLongPtrW(hwnd, GWL_STYLE);
                let new_ws = if focusable { ws & !WS_DISABLED_BIT } else { ws | WS_DISABLED_BIT };
                SetWindowLongPtrW(hwnd, GWL_STYLE, new_ws);
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                let flag = WS_EX_NOACTIVATE.0 as isize;
                let new_ex = if focusable { ex & !flag } else { ex | flag };
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new_ex);
            })
            .map_err(|e| e.to_string())?;
    }

    #[cfg(not(target_os = "windows"))]
    if let Some(ww) = app.get_webview_window(&label) {
        ww.set_focusable(focusable).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Navigate an existing browser WebviewWindow to a URL.
#[tauri::command]
pub async fn navigate_browser(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let win = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    win.navigate(parsed).map_err(|e| e.to_string())
}

/// Show or hide a browser WebviewWindow.
#[tauri::command]
pub async fn set_browser_visible(
    app: AppHandle,
    label: String,
    visible: bool,
) -> Result<(), String> {
    let win = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    if visible { win.show() } else { win.hide() }.map_err(|e| e.to_string())
}

/// Reposition and resize a browser WebviewWindow (logical coords).
///
/// Primary prevention: bracket every resize with `SetIsVisible(false/true)` so
/// that `put_Bounds` fires while the WebView2 controller is hidden and cannot
/// grab OS keyboard focus.  Reactive fallback: arm the per-pane GotFocus guard
/// when `restore_focus=true`; if WebView2 still steals, the handler bounces
/// focus back to the main webview immediately.
#[tauri::command]
pub async fn set_browser_geometry(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let win = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;

    // Primary prevention: hide the controller so put_Bounds fires while
    // WebView2 is invisible and cannot grab OS keyboard focus.
    // WS_DISABLED (set by set_browser_focusable) is the backstop when the
    // browser is inactive; this bracket handles the case when it is active.
    #[cfg(target_os = "windows")]
    let _ = win.with_webview(|wv| unsafe {
        let _ = wv.controller().SetIsVisible(false);
    });

    win.set_position(tauri::LogicalPosition::new(x as f64, y as f64))
        .map_err(|e| e.to_string())?;
    win.set_size(tauri::LogicalSize::new(width as f64, height as f64))
        .map_err(|e| e.to_string())?;

    // Restore visibility before the next frame renders.
    #[cfg(target_os = "windows")]
    let _ = win.with_webview(|wv| unsafe {
        let _ = wv.controller().SetIsVisible(true);
    });

    Ok(())
}

/// Destroy a browser WebviewWindow.
#[tauri::command]
pub async fn close_browser_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_app_version(app: AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

#[tauri::command]
pub async fn check_for_app_update(
    app: AppHandle,
    config: UpdateConfigRequest,
) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    let update = build_runtime_updater(&app, &config)?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    Ok(match update {
        Some(update) => UpdateCheckResult {
            current_version,
            available: true,
            version: Some(update.version.clone()),
            date: update.date.map(|value| value.to_string()),
            body: update.body.clone(),
            download_url: Some(update.download_url.to_string()),
            target: Some(update.target.clone()),
        },
        None => UpdateCheckResult {
            current_version,
            available: false,
            version: None,
            date: None,
            body: None,
            download_url: None,
            target: None,
        },
    })
}

#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    config: UpdateConfigRequest,
) -> Result<(), String> {
    let update = build_runtime_updater(&app, &config)?
        .on_before_exit(|| {
            log::info!("wmux updater is handing off to the installer");
        })
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update is currently available".to_string())?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn complete_control_request(
    bridge: State<'_, FrontendControlBridge>,
    request_id: String,
    ok: bool,
    payload: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    let result = if ok {
        Ok(payload.unwrap_or(serde_json::Value::Null))
    } else {
        Err(error.unwrap_or_else(|| "frontend control failed".to_string()))
    };
    bridge.complete(request_id, result).await
}

#[tauri::command]
pub async fn exit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

fn build_runtime_updater(
    app: &AppHandle,
    config: &UpdateConfigRequest,
) -> Result<tauri_plugin_updater::UpdaterBuilder, String> {
    let endpoint = config.endpoint.trim();
    let pubkey = config.pubkey.trim();
    if endpoint.is_empty() {
        return Err("Update manifest URL is required".to_string());
    }
    if pubkey.is_empty() {
        return Err("Updater public key is required".to_string());
    }

    let endpoint = Url::parse(endpoint).map_err(|err| format!("Invalid update manifest URL: {err}"))?;

    app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())
        .map(|builder| builder.pubkey(pubkey.to_string()))
}

/// Minimal base64 encoder (avoids pulling in a full crate).
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[b0 >> 2] as char);
        out.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 { CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char } else { '=' });
        out.push(if chunk.len() > 2 { CHARS[b2 & 0x3f] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        build_remote_process_age_script, build_remote_tmux_management_script,
        build_remote_tmux_state_from_outputs, parse_remote_git_probe_output,
        parse_remote_process_age_output,
        parse_remote_tmux_probe_output,
    };

    #[test]
    fn parses_remote_tmux_probe_output_with_fallback_session() {
        let (session_name, window_id, window_name, pane_id, cwd) = parse_remote_tmux_probe_output(
            "\t@3\teditor\t%9\t/home/dev/project\n",
            "team-shell",
        );

        assert_eq!(session_name, "team-shell");
        assert_eq!(window_id, "@3");
        assert_eq!(window_name, "editor");
        assert_eq!(pane_id, "%9");
        assert_eq!(cwd.as_deref(), Some("/home/dev/project"));
    }

    #[test]
    fn parses_remote_git_probe_output_for_worktree_metadata() {
        let (repo_root, repo_name, git_branch, worktree_name, is_worktree) =
            parse_remote_git_probe_output("/repo\twmux\tfeature/hybrid\tworktrees/agent\t1\n");

        assert_eq!(repo_root, "/repo");
        assert_eq!(repo_name, "wmux");
        assert_eq!(git_branch, "feature/hybrid");
        assert_eq!(worktree_name, "worktrees/agent");
        assert!(is_worktree);
    }

    #[test]
    fn builds_remote_tmux_state_with_nested_sessions_windows_and_panes() {
        let state = build_remote_tmux_state_from_outputs(
            "team-shell",
            "@2",
            "%5",
            "team-shell\t1\t2\nops\t0\t1\n",
            "team-shell\t@1\t0\teditor\t0\nteam-shell\t@2\t1\tserver\t1\nops\t@7\t0\tlogs\t1\n",
            "team-shell\t@2\t%5\t0\t101\t1\t0\tbash\t/home/dev/server\tserver\nteam-shell\t@2\t%6\t1\t202\t0\t1\tnode\t/home/dev/server\tapi\nops\t@7\t%10\t0\t303\t1\t0\tjournalctl\t/var/log\tlogs\n",
            "101 00:10\n202 01:15\n303 10:00\n",
        );

        assert_eq!(state.current_session_name, "team-shell");
        assert_eq!(state.sessions.len(), 2);
        assert_eq!(state.sessions[0].session_name, "team-shell");
        assert!(state.sessions[0].is_current);
        assert_eq!(state.sessions[0].windows.len(), 2);
        assert_eq!(state.sessions[0].windows[1].window_id, "@2");
        assert!(state.sessions[0].windows[1].is_active);
        assert_eq!(state.sessions[0].windows[1].panes.len(), 2);
        assert_eq!(state.sessions[0].windows[1].panes[0].pane_id, "%5");
        assert!(state.sessions[0].windows[1].panes[0].is_active);
        assert_eq!(state.sessions[0].windows[1].panes[0].command_age, "00:10");
        assert!(state.sessions[0].windows[1].panes[1].was_last_active);
    }

    #[test]
    fn parses_remote_process_age_output_for_pid_map() {
        let ages = parse_remote_process_age_output("101 00:10\n202 01:15\n");
        assert_eq!(ages.get("101").map(String::as_str), Some("00:10"));
        assert_eq!(ages.get("202").map(String::as_str), Some("01:15"));
    }

    #[test]
    fn builds_process_age_script_from_pane_output() {
        let script = build_remote_process_age_script(
            "team-shell\t@2\t%5\t0\t101\t1\t0\tbash\t/home/dev/server\tserver\nteam-shell\t@2\t%6\t1\t202\t0\t1\tnode\t/home/dev/server\tapi\n",
        )
        .unwrap_or_default();
        assert_eq!(script, "ps -o pid=,etime= -p 101,202 2>/dev/null || true");
    }

    #[test]
    fn builds_remote_tmux_management_script_for_window_creation() {
        let script = build_remote_tmux_management_script("window", "create", Some("team-shell"), Some("editor"))
            .unwrap_or_default();
        assert!(script.contains("tmux new-window -P -F '#{window_id}' -t 'team-shell' -n 'editor'"));
    }
}

// ── Shell integration ─────────────────────────────────────────────────────────

/// Hex-encode bytes so the result contains only [0-9a-f] — safe to embed in any
/// shell argument without quoting concerns.
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const SHELL_INTEGRATION_PS1: &str = include_str!("shell-integration.ps1");
const SHELL_INTEGRATION_MARKER: &str = "# wmux shell integration";

const SHELL_INTEGRATION_SH: &str = include_str!("shell-integration.sh");
const SHELL_INTEGRATION_BASH_MARKER: &str = "# wmux shell integration for bash";
// A unique line from the current script version; used to detect stale installs.
// Must be absent from older/broken versions so the ⚡ button reappears for upgrades.
const SHELL_INTEGRATION_BASH_UNIQUE: &str =
    "# B marker: end of prompt text, beginning of user input";

/// Write the wmux shell integration snippet into the user's PowerShell
/// CurrentUserCurrentHost profile. Replaces any existing (possibly stale)
/// wmux block so the installed version always matches the current script.
#[tauri::command]
pub async fn install_shell_integration() -> Result<String, String> {
    let profile_path = get_powershell_profile_path().map_err(|e| e.to_string())?;

    if let Some(parent) = profile_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let existing = if profile_path.exists() {
        std::fs::read_to_string(&profile_path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };

    // Strip any previous wmux block so we always write the current version.
    let base = if let Some(idx) = existing.find(SHELL_INTEGRATION_MARKER) {
        existing[..idx].trim_end().to_string()
    } else {
        existing.trim_end().to_string()
    };

    let new_content = if base.is_empty() {
        format!("{SHELL_INTEGRATION_PS1}\n")
    } else {
        format!("{base}\n\n{SHELL_INTEGRATION_PS1}\n")
    };

    std::fs::write(&profile_path, new_content).map_err(|e| e.to_string())?;
    Ok("installed".to_string())
}

fn get_powershell_profile_path() -> std::io::Result<PathBuf> {
    let pwsh = crate::session_manager::find_exe("pwsh.exe")
        .or_else(|| crate::session_manager::find_exe("powershell.exe"))
        .unwrap_or_else(|| "pwsh.exe".to_string());

    let output = Command::new(&pwsh)
        .args(["-NoProfile", "-NonInteractive", "-Command", "$PROFILE.CurrentUserCurrentHost"])
        .output()?;

    let path_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path_str.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "could not determine PowerShell profile path",
        ));
    }
    Ok(PathBuf::from(path_str))
}

/// Return whether the *current version* of the wmux shell integration is
/// present in $PROFILE. Returns false if the marker exists but the script
/// content has changed, so the toolbar button reappears and triggers an update.
#[tauri::command]
pub async fn check_shell_integration() -> Result<bool, String> {
    let profile_path = match get_powershell_profile_path() {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };
    if !profile_path.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(&profile_path).map_err(|e| e.to_string())?;
    Ok(content.contains(SHELL_INTEGRATION_PS1.trim_end()))
}

/// Return whether the current wmux bash integration is present in ~/.bashrc inside WSL.
/// Checks for a unique line from the current script so stale installs still show the ⚡ button.
#[tauri::command]
pub async fn check_shell_integration_wsl(distro: Option<String>) -> Result<bool, String> {
    let check_cmd = format!(
        "grep -qF '{}' ~/.bashrc 2>/dev/null && echo yes || echo no",
        SHELL_INTEGRATION_BASH_UNIQUE
    );
    let mut cmd = Command::new("wsl.exe");
    if let Some(d) = &distro {
        cmd.args(["--distribution", d.as_str()]);
    }
    let output = cmd
        .args(["--", "bash", "-c", &check_cmd])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "yes")
}

/// Install (or replace) the wmux bash integration snippet in ~/.bashrc inside WSL.
/// Always strips any existing wmux block first so stale installs are updated.
#[tauri::command]
pub async fn install_shell_integration_wsl(distro: Option<String>) -> Result<String, String> {
    // Normalise to LF so bash on Linux doesn't see stray \r characters.
    let script = SHELL_INTEGRATION_SH.replace("\r\n", "\n").replace('\r', "\n");
    // Hex-encode the script so the Python argument contains no $ or quotes —
    // wsl.exe passes arguments through a shell that double-quote-expands everything,
    // so any $VAR or $? in a heredoc body gets clobbered. Hex is [0-9a-f] only.
    let script_hex = hex_encode(script.as_bytes());

    // Single Python invocation: strip old block + append new one.
    let install_cmd = format!(
        "python3 -c \"import os,binascii; \
         p=os.path.expanduser('~/.bashrc'); \
         c=open(p).read() if os.path.exists(p) else ''; \
         m='{}\\n'; \
         i=c.find(m); \
         s=max(c.rfind('\\n',0,i)+1,0) if i>=0 else len(c); \
         c2=c[:s].rstrip('\\n'); \
         script=binascii.unhexlify('{}').decode('utf-8'); \
         open(p,'w').write((c2+'\\n' if c2 else '')+'\\n'+script+'\\n')\"",
        SHELL_INTEGRATION_BASH_MARKER,
        script_hex
    );

    let mut cmd = Command::new("wsl.exe");
    if let Some(d) = &distro {
        cmd.args(["--distribution", d.as_str()]);
    }
    let output = cmd
        .args(["--", "bash", "-c", &install_cmd])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("bash error: {stderr}"));
    }

    Ok("installed".to_string())
}

/// Return whether the current wmux bash integration is present on a remote SSH host.
#[tauri::command]
pub async fn check_shell_integration_ssh(
    host: String,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
) -> Result<bool, String> {
    let check_cmd = format!(
        "grep -qF '{}' ~/.bashrc 2>/dev/null && echo yes || echo no",
        SHELL_INTEGRATION_BASH_UNIQUE
    );
    let result = tokio::task::spawn_blocking(move || {
        run_remote_ssh_script(&host, user.as_deref(), port, identity_file.as_deref(), &check_cmd)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result.trim() == "yes")
}

/// Install (or replace) the wmux bash integration snippet in ~/.bashrc on a remote SSH host.
#[tauri::command]
pub async fn install_shell_integration_ssh(
    host: String,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
) -> Result<String, String> {
    let script = SHELL_INTEGRATION_SH.replace("\r\n", "\n").replace('\r', "\n");
    let script_hex = hex_encode(script.as_bytes());

    let install_cmd = format!(
        "python3 -c \"import os,binascii; \
         p=os.path.expanduser('~/.bashrc'); \
         c=open(p).read() if os.path.exists(p) else ''; \
         m='{}\\n'; \
         i=c.find(m); \
         s=max(c.rfind('\\n',0,i)+1,0) if i>=0 else len(c); \
         c2=c[:s].rstrip('\\n'); \
         script=binascii.unhexlify('{}').decode('utf-8'); \
         open(p,'w').write((c2+'\\n' if c2 else '')+'\\n'+script+'\\n')\"",
        SHELL_INTEGRATION_BASH_MARKER,
        script_hex
    );

    let result = tokio::task::spawn_blocking(move || {
        run_remote_ssh_script(&host, user.as_deref(), port, identity_file.as_deref(), &install_cmd)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}

// ---------------------------------------------------------------------------
// Claude Code hook installation
// ---------------------------------------------------------------------------

/// Unique substring present in every wmux hook command — used to detect/replace existing installs.
const CLAUDE_HOOK_UNIQUE: &str = "agent-event?pane_id=";

/// PowerShell hook command — reads Claude Code's stdin JSON and posts it to wmux.
const CLAUDE_HOOK_CMD_PS1: &str = concat!(
    "$b=[Console]::In.ReadToEnd();",
    "try{$null=Invoke-RestMethod",
    " -Uri \"$env:WMUX_API_BASE/agent-event?pane_id=$env:WMUX_PANE_ID\"",
    " -Method Post -Body $b -ContentType 'application/json' -TimeoutSec 2}catch{}"
);

/// Bash hook command — reads Claude Code's stdin JSON and posts it to wmux.
const CLAUDE_HOOK_CMD_BASH: &str =
    "curl -sf --max-time 2 -X POST \"$WMUX_API_BASE/agent-event?pane_id=$WMUX_PANE_ID\" -H \"Content-Type: application/json\" -d @- 2>/dev/null || true";

fn get_claude_settings_path() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "cannot find home directory".to_string())?;
    Ok(PathBuf::from(home).join(".claude").join("settings.json"))
}

/// Merge the wmux hook entry into a hooks array for one event type, replacing
/// any existing wmux entry so re-installs always write the current command.
fn merge_hook_entry(
    existing: &serde_json::Value,
    new_cmd: &str,
) -> serde_json::Value {
    let filtered: Vec<serde_json::Value> = existing
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| {
            !entry["hooks"]
                .as_array()
                .is_some_and(|hooks| {
                    hooks.iter().any(|h| {
                        h["command"]
                            .as_str()
                            .is_some_and(|cmd| cmd.contains(CLAUDE_HOOK_UNIQUE))
                    })
                })
        })
        .collect();

    let mut entries = filtered;
    entries.push(serde_json::json!({
        "matcher": "",
        "hooks": [{"type": "command", "command": new_cmd}]
    }));
    serde_json::Value::Array(entries)
}

/// Install wmux lifecycle hooks into the Windows Claude Code settings.json.
/// Uses PowerShell syntax for the hook command since Claude runs in PowerShell on Windows.
#[tauri::command]
pub async fn install_claude_hooks() -> Result<String, String> {
    let settings_path = get_claude_settings_path()?;
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let existing = if settings_path.exists() {
        std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?
    } else {
        "{}".to_string()
    };

    let mut settings: serde_json::Value =
        serde_json::from_str(&existing).unwrap_or_else(|_| serde_json::json!({}));

    if !settings["hooks"].is_object() {
        settings["hooks"] = serde_json::json!({});
    }

    for event in ["PreToolUse", "PostToolUse", "Stop", "Notification", "UserPromptSubmit"] {
        let updated = merge_hook_entry(&settings["hooks"][event], CLAUDE_HOOK_CMD_PS1);
        settings["hooks"][event] = updated;
    }

    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&settings_path, content).map_err(|e| e.to_string())?;
    Ok("installed".to_string())
}

/// Return whether the current wmux hooks are present in the Windows Claude settings.json.
#[tauri::command]
pub async fn check_claude_hooks() -> Result<bool, String> {
    let settings_path = match get_claude_settings_path() {
        Ok(p) => p,
        Err(_) => return Ok(false),
    };
    if !settings_path.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
    Ok(content.contains(CLAUDE_HOOK_UNIQUE))
}

/// Install wmux lifecycle hooks into the WSL Claude Code settings.json (~/.claude/settings.json).
/// Uses bash/curl syntax for the hook command.
#[tauri::command]
pub async fn install_claude_hooks_wsl(distro: Option<String>) -> Result<String, String> {
    let hook_cmd_hex = hex_encode(CLAUDE_HOOK_CMD_BASH.as_bytes());

    // Python merges the hook into ~/.claude/settings.json, replacing any existing wmux entry.
    let install_cmd = format!(
        "python3 -c \"\
import json,os,binascii;\
p=os.path.expanduser('~/.claude/settings.json');\
s=json.loads(open(p).read()) if os.path.exists(p) else {{}};\
h=s.setdefault('hooks',{{}});\
cmd=binascii.unhexlify('{}').decode();\
marker='agent-event?pane_id=';\
entry={{'matcher':'','hooks':[{{'type':'command','command':cmd}}]}};\
[h.__setitem__(e,[x for x in h.get(e,[]) if not any(marker in hk.get('command','') for hk in x.get('hooks',[]))]+[entry]) for e in ['PreToolUse','PostToolUse','Stop','Notification','UserPromptSubmit']];\
os.makedirs(os.path.dirname(p),exist_ok=True);\
open(p,'w').write(json.dumps(s,indent=2));\
print('ok')\"",
        hook_cmd_hex
    );

    let mut cmd = Command::new("wsl.exe");
    if let Some(d) = &distro {
        cmd.args(["--distribution", d.as_str()]);
    }
    let output = cmd
        .args(["--", "bash", "-c", &install_cmd])
        .output()
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("error: {stderr}"));
    }
    Ok("installed".to_string())
}

/// Return whether the wmux hooks are present in the WSL Claude settings.json.
#[tauri::command]
pub async fn check_claude_hooks_wsl(distro: Option<String>) -> Result<bool, String> {
    let check_cmd = "python3 -c \"\
import json,os;\
p=os.path.expanduser('~/.claude/settings.json');\
s=json.loads(open(p).read()) if os.path.exists(p) else {};\
print('yes' if any('agent-event?pane_id=' in hk.get('command','') for v in s.get('hooks',{}).values() for e in v for hk in e.get('hooks',[])) else 'no')\
\" 2>/dev/null || echo no";

    let mut cmd = Command::new("wsl.exe");
    if let Some(d) = &distro {
        cmd.args(["--distribution", d.as_str()]);
    }
    let output = cmd
        .args(["--", "bash", "-c", check_cmd])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).trim() == "yes")
}
