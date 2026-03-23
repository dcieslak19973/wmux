mod browser_windows;
mod control_bridge;
mod commands;
mod conpty;
mod ipc_server;
mod osc_parser;
mod remote_tmux;
mod session_vault;
mod session_manager;
mod url_detector;

pub use control_bridge::FrontendControlBridge;
pub use session_manager::{SessionManager, ShellTarget};

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let session_manager = SessionManager::new();
    let control_bridge = FrontendControlBridge::new();

    tauri::Builder::default()
        .manage(session_manager)
        .manage(control_bridge)
        .invoke_handler(tauri::generate_handler![
            commands::sessions::create_session,
            remote_tmux::commands::probe_remote_tmux_metadata,
            remote_tmux::commands::inspect_remote_tmux_state,
            remote_tmux::commands::manage_remote_tmux,
            commands::sessions::close_session,
            commands::sessions::write_to_session,
            commands::sessions::list_sessions,
            commands::sessions::resize_session,
            commands::io::open_url,
            commands::sessions::list_wsl_distros,
            commands::sessions::start_session_stream,
            commands::io::save_layout,
            commands::io::load_layout,
            commands::io::capture_session_output,
            commands::io::capture_session_output_by_id,
            commands::git::get_git_branch,
            commands::git::get_git_context,
            commands::io::save_artifact_preview,
            commands::io::read_text_file,
            commands::app::create_app_window,
            browser_windows::commands::create_browser_window,
            browser_windows::commands::navigate_browser,
            browser_windows::commands::set_browser_visible,
            browser_windows::commands::set_browser_geometry,
            browser_windows::commands::close_browser_window,
            commands::app::complete_control_request,
            commands::app::exit_app,
                session_vault::commands::save_session_vault_entry,
                session_vault::commands::list_session_vault_entries,
                session_vault::commands::read_session_vault_entry,
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
