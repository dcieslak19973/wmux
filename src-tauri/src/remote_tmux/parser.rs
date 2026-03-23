use crate::remote_tmux::model::RemoteTmuxPaneResult;
use std::collections::HashMap;

pub(super) fn parse_remote_tmux_probe_output(
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

pub(super) fn parse_remote_git_probe_output(stdout: &str) -> (String, String, String, String, bool) {
    let mut git_parts = stdout.trim().splitn(5, '\t');
    let repo_root = git_parts.next().map(str::trim).unwrap_or_default().to_string();
    let repo_name = git_parts.next().map(str::trim).unwrap_or_default().to_string();
    let git_branch = git_parts.next().map(str::trim).unwrap_or_default().to_string();
    let worktree_name = git_parts.next().map(str::trim).unwrap_or_default().to_string();
    let is_worktree = git_parts.next().map(str::trim) == Some("1");
    (repo_root, repo_name, git_branch, worktree_name, is_worktree)
}

pub(super) fn parse_remote_tmux_session_lines(stdout: &str) -> Vec<(String, usize, usize)> {
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

pub(super) fn parse_remote_tmux_window_lines(stdout: &str) -> Vec<(String, String, String, String, bool)> {
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

pub(super) fn parse_remote_tmux_pane_lines(stdout: &str) -> Vec<(String, String, RemoteTmuxPaneResult)> {
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

pub(super) fn parse_remote_process_age_output(stdout: &str) -> HashMap<String, String> {
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