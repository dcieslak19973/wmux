use crate::{url_detector, SessionManager};
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !url_detector::is_safe_to_open(&url) {
        return Err(format!("Refused to open non-localhost or malformed URL: {url}"));
    }
    opener::open_browser(&url).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_layout(app: AppHandle, layout_json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&layout_json)
        .map_err(|e| format!("Invalid layout JSON: {e}"))?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let path = data_dir.join("layout.json");
    std::fs::write(path, layout_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_layout(app: AppHandle) -> Result<Option<String>, String> {
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let path = data_dir.join("layout.json");
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn capture_session_output(
    manager: State<'_, SessionManager>,
    name: String,
) -> Result<Option<String>, String> {
    Ok(manager.capture_output(&name).await)
}

#[tauri::command]
pub async fn capture_session_output_by_id(
    manager: State<'_, SessionManager>,
    id: String,
) -> Result<Option<String>, String> {
    Ok(manager.capture_output_by_id(&id).await)
}

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

fn uuid_short() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{:08x}", n)
}