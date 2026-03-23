use crate::remote_tmux::parser::parse_remote_tmux_pane_lines;

pub(super) fn build_remote_git_probe_script(cwd: &str) -> String {
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

pub(super) fn build_remote_process_age_script(panes_stdout: &str) -> Option<String> {
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

pub(super) fn build_remote_tmux_management_script(
    scope: &str,
    action: &str,
    tmux_target: Option<&str>,
    name: Option<&str>,
) -> Result<String, String> {
    match (scope, action) {
        ("session", "create") => {
            let name = name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("session name is required")?;
            Ok(format!(
                "tmux new-session -d -P -F '#{{session_name}}' -s {}",
                crate::session_manager::quote_remote_shell_arg(name),
            ))
        }
        ("session", "rename") => {
            let target = tmux_target
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("session target is required")?;
            let name = name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("new session name is required")?;
            Ok(format!(
                "tmux rename-session -t {} {}; printf '%s\\n' {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(name),
                crate::session_manager::quote_remote_shell_arg(name),
            ))
        }
        ("session", "kill") => {
            let target = tmux_target
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("session target is required")?;
            Ok(format!(
                "tmux kill-session -t {}; printf '%s\\n' {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(target),
            ))
        }
        ("window", "create") => {
            let target = tmux_target
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("window session target is required")?;
            let name = name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("window name is required")?;
            Ok(format!(
                "tmux new-window -P -F '#{{window_id}}' -t {} -n {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(name),
            ))
        }
        ("window", "rename") => {
            let target = tmux_target
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("window target is required")?;
            let name = name
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("new window name is required")?;
            Ok(format!(
                "tmux rename-window -t {} {}; printf '%s\\n' {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(name),
                crate::session_manager::quote_remote_shell_arg(target),
            ))
        }
        ("window", "kill") => {
            let target = tmux_target
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("window target is required")?;
            Ok(format!(
                "tmux kill-window -t {}; printf '%s\\n' {}",
                crate::session_manager::quote_remote_shell_arg(target),
                crate::session_manager::quote_remote_shell_arg(target),
            ))
        }
        _ => Err(format!("unsupported remote tmux action: {scope}/{action}")),
    }
}