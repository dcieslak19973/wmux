use serde::Deserialize;

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