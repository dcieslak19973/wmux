use crate::{
    osc_parser::{self, OscEvent},
    session_manager::{ShellTarget, WslDistro},
    url_detector,
    SessionManager,
};
use serde::Serialize;
use std::collections::HashSet;
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
pub struct SessionExitPayload {
    pub id: String,
}

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

    Ok(CreateSessionResult { id, label })
}

#[tauri::command]
pub async fn start_session_stream(
    app: AppHandle,
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    let session = manager.get(&id).await.ok_or("session not found")?;

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

                    let notify_ev = format!("terminal-notify-{id_clone}");
                    let cwd_ev = format!("terminal-cwd-{id_clone}");
                    for event in osc_parser::extract_osc_events(&chunk) {
                        match event {
                            OscEvent::Notification(n) => {
                                let _ = app.emit(
                                    &notify_ev,
                                    OscNotificationPayload {
                                        title: n.title,
                                        body: n.body,
                                    },
                                );
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

#[tauri::command]
pub async fn close_session(
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<(), String> {
    manager.close(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn write_to_session(
    manager: State<'_, SessionManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    let session = manager.get(&id).await.ok_or("session not found")?;
    session.write(data.as_bytes()).await.map_err(|e| e.to_string())
}

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

#[tauri::command]
pub async fn list_sessions(manager: State<'_, SessionManager>) -> Result<Vec<String>, String> {
    Ok(manager.list().await)
}

#[tauri::command]
pub async fn list_wsl_distros() -> Result<Vec<WslDistro>, String> {
    Ok(crate::session_manager::list_wsl_distros())
}

fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as usize;
        let b1 = if chunk.len() > 1 { chunk[1] as usize } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as usize } else { 0 };
        out.push(CHARS[b0 >> 2] as char);
        out.push(CHARS[((b0 & 3) << 4) | (b1 >> 4)] as char);
        out.push(if chunk.len() > 1 {
            CHARS[((b1 & 0xf) << 2) | (b2 >> 6)] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            CHARS[b2 & 0x3f] as char
        } else {
            '='
        });
    }
    out
}