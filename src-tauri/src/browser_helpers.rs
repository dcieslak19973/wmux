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

#[derive(Clone, Debug)]
pub struct HelperInfo {
    pub pid: u32,
    pub cdp_port: u16,
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
}
