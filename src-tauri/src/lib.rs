mod browser_helpers;
mod control_bridge;
mod commands;
mod conpty;
mod http_server;
mod ipc_server;
mod osc_parser;
mod tunnel_manager;
mod workbook;
mod session_manager;
mod url_detector;

pub use browser_helpers::{BrowserHelpers, HelperInfo};
pub use control_bridge::FrontendControlBridge;
pub use http_server::BrowserContentPending;
pub use session_manager::{SessionManager, ShellTarget};
pub use tunnel_manager::TunnelManager;

use tauri::Manager;
use tauri_plugin_updater::Builder as UpdaterPluginBuilder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("warn")).init();

    let session_manager = SessionManager::new();
    let control_bridge = FrontendControlBridge::new();
    let tunnel_manager = TunnelManager::new();
    let browser_content_pending = BrowserContentPending::new();
    let browser_helpers = BrowserHelpers::new();

    tauri::Builder::default()
        .plugin(UpdaterPluginBuilder::new().build())
        .manage(session_manager)
        .manage(control_bridge)
        .manage(tunnel_manager)
        .manage(browser_content_pending)
        .manage(browser_helpers)
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::probe_remote_tmux_metadata,
            commands::inspect_remote_tmux_state,
            commands::manage_remote_tmux,
            commands::close_session,
            commands::write_to_session,
            commands::list_sessions,
            commands::resize_session,
            commands::open_url,
            commands::check_iframe_compatible,
            commands::spawn_browser_helper,
            commands::kill_browser_helper,
            commands::navigate_browser_helper,
            commands::resolve_localhost_url,
            commands::read_clipboard_text,
            commands::list_wsl_distros,
            commands::start_session_stream,
            commands::save_layout,
            commands::load_layout,
            commands::save_session_vault_entry,
            commands::list_session_vault_entries,
            commands::read_session_vault_entry,
            commands::capture_session_output,
            commands::capture_session_output_by_id,
            commands::get_git_branch,
            commands::get_git_context,
            commands::save_artifact_preview,
            commands::read_text_file,
            commands::create_app_window,
            commands::create_browser_window,
            commands::focus_app_window,
            commands::focus_main_webview,
            commands::set_browser_focusable,
            commands::navigate_browser,
            commands::set_browser_visible,
            commands::set_browser_geometry,
            commands::close_browser_window,
            commands::get_app_version,
            commands::check_for_app_update,
            commands::install_app_update,
            commands::complete_control_request,
            commands::exit_app,
            commands::install_shell_integration,
            commands::check_shell_integration,
            commands::install_shell_integration_wsl,
            commands::check_shell_integration_wsl,
            commands::check_shell_integration_ssh,
            commands::install_shell_integration_ssh,
            commands::get_blocks,
            commands::get_pr_diff_summary,
            commands::get_pr_file_diff,
            commands::ask_claude_about_diff,
            commands::install_claude_hooks,
            commands::check_claude_hooks,
            commands::install_claude_hooks_wsl,
            commands::check_claude_hooks_wsl,
        ])
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_title("wmux").unwrap();
            if let Some(icon) = app.handle().default_window_icon().cloned() {
                let _ = window.set_icon(icon);
            }

            // Start the named-pipe IPC server inside setup() so Tauri's
            // async runtime is already live when we call tauri::async_runtime::spawn.
            let mgr: tauri::State<SessionManager> = app.state();
            let bridge: tauri::State<FrontendControlBridge> = app.state();
            ipc_server::start(app.handle().clone(), mgr.inner().clone(), bridge.inner().clone());
            http_server::start(mgr.inner().clone(), app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            // Exit when the last window closes.  Background tasks (ConPTY loops,
            // IPC pipe server) keep the process alive otherwise.
            if let tauri::WindowEvent::Destroyed = event {
                let current_label = window.label().to_string();
                let remaining = window
                    .app_handle()
                    .webview_windows()
                    .into_iter()
                    .filter(|(label, _)| label != &current_label)
                    .count();
                if remaining == 0 {
                    std::process::exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running wmux");
}
