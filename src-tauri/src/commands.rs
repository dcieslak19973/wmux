/// Tauri IPC command handlers — the bridge between the WebView frontend
/// and the Rust ConPTY session manager.
use crate::{osc_parser::{self, OscEvent}, session_manager::{ShellTarget, WslDistro}, url_detector, FrontendControlBridge, SessionManager};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

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

    // Take the initial receiver — created at spawn time, so it has all output
    // buffered since the session started.
    let mut rx = session
        .initial_rx
        .lock()
        .await
        .take()
        .ok_or("session stream already started")?;

    let event_id = format!("terminal-output-{id}");
    let id_clone = id.clone();

    tokio::spawn(async move {
        let mut seen_urls: HashSet<String> = HashSet::new();
        let url_event_id = format!("terminal-url-{id_clone}");
        let exit_event_id = format!("terminal-exit-{id_clone}");

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

                    // OSC 7 cwd + OSC 9/99/777 notifications.
                    let notify_ev = format!("terminal-notify-{id_clone}");
                    let cwd_ev    = format!("terminal-cwd-{id_clone}");
                    for event in osc_parser::extract_osc_events(&chunk) {
                        match event {
                            OscEvent::Notification(n) => {
                                let _ = app.emit(&notify_ev,
                                    OscNotificationPayload { title: n.title, body: n.body });
                            }
                            OscEvent::Cwd(path) => {
                                let _ = app.emit(&cwd_ev, path);
                            }
                        }
                    }

                    if app.webview_windows().is_empty() {
                        break;
                    }
                }
                // Lagged: some messages were dropped (channel full); keep going.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
        let _ = app.emit(
            &exit_event_id,
            SessionExitPayload {
                id: id_clone.clone(),
            },
        );
        log::debug!("Output forwarder for session {id_clone} terminated.");
    });

    Ok(())
}

/// Close a terminal session.
#[tauri::command]
pub async fn close_session(
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
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
    let path = artifacts_dir.join(file_name);
    std::fs::write(&path, html).map_err(|e| e.to_string())?;

    url::Url::from_file_path(&path)
        .map(|url| url.to_string())
        .map_err(|_| format!("Could not create file URL for {}", path.display()))
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
    );
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(request.geometry.x as f64, request.geometry.y as f64),
            tauri::LogicalSize::new(request.geometry.width as f64, request.geometry.height as f64),
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
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
    win.set_position(tauri::LogicalPosition::new(x as f64, y as f64))
        .map_err(|e| e.to_string())?;
    win.set_size(tauri::LogicalSize::new(width as f64, height as f64))
        .map_err(|e| e.to_string())
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
