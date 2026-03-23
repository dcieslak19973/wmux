use crate::remote_tmux::model::{
    RemoteTmuxActionResult, RemoteTmuxMetadataResult, RemoteTmuxStateResult,
};
use crate::remote_tmux::parser::{
    parse_remote_git_probe_output, parse_remote_tmux_probe_output,
};
use crate::remote_tmux::scripts::{
    build_remote_git_probe_script, build_remote_process_age_script,
    build_remote_tmux_management_script,
};
use crate::remote_tmux::service::{
    build_remote_tmux_state_from_outputs, run_remote_ssh_script,
};
use crate::session_manager::ShellTarget;

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

    let (repo_root, repo_name, git_branch, worktree_name, is_worktree) =
        if let Some(cwd) = cwd.as_deref() {
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
        .map(|script| {
            run_remote_ssh_script(&host, user.as_deref(), port, identity_file.as_deref(), &script)
                .unwrap_or_default()
        })
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