/// Tauri IPC command handlers — the bridge between the WebView frontend
/// and the Rust ConPTY session manager.
use crate::{osc_parser::{self, OscEvent}, session_manager::{ShellTarget, WslDistro}, url_detector, FrontendControlBridge, SessionManager};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
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

#[derive(Debug, Clone, Serialize)]
pub struct GitContextResult {
    pub repo_root: String,
    pub repo_name: String,
    pub branch: Option<String>,
    pub worktree_name: Option<String>,
    pub is_worktree: bool,
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

