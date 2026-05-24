//! Registry of out-of-process CEF browser helpers spawned by wmux.
//!
//! Each helper instance:
//! - Has a unique label (UUID-ish short string, also used by MCP / JS to refer
//!   to it).
//! - Was launched with `--remote-debugging-port=<port>` so its content can be
//!   driven via the Chromium DevTools Protocol (CDP) over HTTP+WebSocket.
//! - Is owned by the helper process; wmux only tracks PID + CDP port for the
//!   lifetime of that process. No clean-shutdown plumbing yet — that's part
//!   of Phase 3+.
//!
//! Used by:
//! - `commands::spawn_browser_helper` (the producer)
//! - `http_server::browser_read_content` (the MCP consumer that calls into
//!   the helper via CDP to read DOM/text)

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, serde::Serialize)]
pub struct HelperInfo {
    pub pid: u32,
    pub cdp_port: u16,
}

/// Snapshot row returned by `BrowserHelpers::snapshot()`. Carries the label
/// alongside the info so callers (notably the `cef_helper_list` MCP tool)
/// get a flat JSON-friendly shape.
#[derive(Debug, serde::Serialize)]
pub struct HelperEntry {
    pub label: String,
    pub pid: u32,
    pub cdp_port: u16,
    pub cdp_url: String,
}

#[derive(Default, Clone)]
pub struct BrowserHelpers {
    inner: Arc<Mutex<HashMap<String, HelperInfo>>>,
}

impl BrowserHelpers {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, label: String, info: HelperInfo) {
        self.inner.lock().unwrap().insert(label, info);
    }

    pub fn get(&self, label: &str) -> Option<HelperInfo> {
        self.inner.lock().unwrap().get(label).cloned()
    }

    /// Flat list of all registered helpers, JSON-serializable.
    pub fn snapshot(&self) -> Vec<HelperEntry> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .map(|(label, info)| HelperEntry {
                label: label.clone(),
                pid: info.pid,
                cdp_port: info.cdp_port,
                cdp_url: format!("http://127.0.0.1:{}/json", info.cdp_port),
            })
            .collect()
    }
}
