use crate::FrontendControlBridge;
use tauri::{AppHandle, State};

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

    builder.build().map(|_| ()).map_err(|e| e.to_string())
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