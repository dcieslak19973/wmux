use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendControlRequest {
    pub request_id: String,
    pub action: String,
    pub payload: Value,
}

#[derive(Clone, Default)]
pub struct FrontendControlBridge {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>,
}

impl FrontendControlBridge {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn request(
        &self,
        app: &AppHandle,
        action: &str,
        payload: Value,
    ) -> Result<Value, String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let request = FrontendControlRequest {
            request_id: request_id.clone(),
            action: action.to_string(),
            payload,
        };

        let window = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next())
            .ok_or_else(|| "no wmux window available".to_string())?;

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), tx);

        if let Err(err) = window.emit("wmux-control-request", request) {
            self.pending.lock().await.remove(&request_id);
            return Err(err.to_string());
        }

        match tokio::time::timeout(Duration::from_secs(10), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("frontend control request dropped".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err(format!("frontend control request '{action}' timed out"))
            }
        }
    }

    pub async fn complete(&self, request_id: String, result: Result<Value, String>) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .await
            .remove(&request_id)
            .ok_or_else(|| format!("control request '{request_id}' not found"))?;
        sender
            .send(result)
            .map_err(|_| format!("control request '{request_id}' receiver dropped"))
    }
}