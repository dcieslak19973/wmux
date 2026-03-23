use serde::Deserialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Deserialize)]
pub struct BrowserGeometry {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateBrowserWindowRequest {
    pub window_label: String,
    pub label: String,
    pub url: String,
    pub geometry: BrowserGeometry,
}

#[tauri::command]
pub async fn create_browser_window(app: AppHandle, request: CreateBrowserWindowRequest) -> Result<(), String> {
    let window = app
        .get_window(&request.window_label)
        .ok_or_else(|| format!("window '{}' not found", request.window_label))?;
    let parsed = url::Url::parse(&request.url).map_err(|e| e.to_string())?;
    let builder = tauri::webview::WebviewBuilder::new(
        &request.label,
        tauri::WebviewUrl::External(parsed),
    );
    window
        .add_child(
            builder,
            tauri::LogicalPosition::new(request.geometry.x as f64, request.geometry.y as f64),
            tauri::LogicalSize::new(request.geometry.width as f64, request.geometry.height as f64),
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn navigate_browser(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let win = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    win.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_browser_visible(
    app: AppHandle,
    label: String,
    visible: bool,
) -> Result<(), String> {
    let win = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    if visible { win.show() } else { win.hide() }.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_browser_geometry(
    app: AppHandle,
    label: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let win = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser webview '{label}' not found"))?;
    win.set_position(tauri::LogicalPosition::new(x as f64, y as f64))
        .map_err(|e| e.to_string())?;
    win.set_size(tauri::LogicalSize::new(width as f64, height as f64))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn close_browser_window(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview(&label) {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}