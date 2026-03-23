use crate::session_manager::ShellTarget;
use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

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

#[cfg(test)]
mod tests {
    use super::{
        build_remote_process_age_script, build_remote_tmux_management_script,
        build_remote_tmux_state_from_outputs, parse_remote_git_probe_output,
        parse_remote_process_age_output, parse_remote_tmux_probe_output,
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