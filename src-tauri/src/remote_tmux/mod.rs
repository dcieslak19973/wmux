pub(crate) mod commands;
mod model;
mod parser;
mod scripts;
mod service;

#[cfg(test)]
mod tests {
    use super::parser::{
        parse_remote_git_probe_output, parse_remote_process_age_output,
        parse_remote_tmux_probe_output,
    };
    use super::scripts::{
        build_remote_process_age_script, build_remote_tmux_management_script,
    };
    use super::service::build_remote_tmux_state_from_outputs;

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
        let script =
            build_remote_tmux_management_script("window", "create", Some("team-shell"), Some("editor"))
                .unwrap_or_default();
        assert!(script.contains("tmux new-window -P -F '#{window_id}' -t 'team-shell' -n 'editor'"));
    }
}