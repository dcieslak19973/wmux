use crate::remote_tmux::model::{
    RemoteTmuxSessionResult, RemoteTmuxStateResult, RemoteTmuxWindowResult,
};
use crate::remote_tmux::parser::{
    parse_remote_process_age_output, parse_remote_tmux_pane_lines,
    parse_remote_tmux_session_lines, parse_remote_tmux_window_lines,
};
use std::collections::HashMap;
use std::process::Command;

pub(super) fn run_remote_ssh_script(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
    identity_file: Option<&str>,
    script: &str,
) -> Result<String, String> {
    let ssh = crate::session_manager::find_exe("ssh.exe").unwrap_or_else(|| "ssh.exe".to_string());
    let mut cmd = Command::new(ssh);
    if let Some(port) = port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(identity_file) = identity_file {
        cmd.arg("-i")
            .arg(crate::session_manager::ssh_identity_path(identity_file));
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

pub(super) fn build_remote_tmux_state_from_outputs(
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

    for (session_name, attached_clients, window_count) in
        parse_remote_tmux_session_lines(sessions_stdout)
    {
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

    for (session_name, window_id, window_index, window_name, is_active) in
        parse_remote_tmux_window_lines(windows_stdout)
    {
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
        sessions[session_index].windows[window_position]
            .panes
            .push(pane);
    }

    RemoteTmuxStateResult {
        current_session_name: current_session_name.to_string(),
        current_window_id: current_window_id.to_string(),
        current_pane_id: current_pane_id.to_string(),
        sessions,
    }
}