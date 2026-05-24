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
use std::process::Child;
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

/// Two maps to keep `HelperInfo` (which is `Clone + Serialize`) decoupled from
/// `Child` (which is neither). `infos` is the public registry queried via
/// `get` / `snapshot`; `children` owns the Child handles so we can kill them
/// on `kill(label)`.
#[derive(Default, Clone)]
pub struct BrowserHelpers {
    infos: Arc<Mutex<HashMap<String, HelperInfo>>>,
    children: Arc<Mutex<HashMap<String, Child>>>,
}

impl BrowserHelpers {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, label: String, info: HelperInfo, child: Child) {
        self.infos.lock().unwrap().insert(label.clone(), info);
        self.children.lock().unwrap().insert(label, child);
    }

    pub fn get(&self, label: &str) -> Option<HelperInfo> {
        self.infos.lock().unwrap().get(label).cloned()
    }

    /// Kill the helper process and remove its registry entry. Returns true if
    /// a helper was registered under this label, false otherwise. Safe to call
    /// when the helper has already exited (e.g. user closed the window) — we
    /// best-effort kill and then `wait()` to reap.
    pub fn kill(&self, label: &str) -> bool {
        let child = self.children.lock().unwrap().remove(label);
        let removed = self.infos.lock().unwrap().remove(label).is_some();
        if let Some(mut c) = child {
            let _ = c.kill();
            let _ = c.wait();
        }
        removed
    }

    /// Flat list of all registered helpers, JSON-serializable.
    pub fn snapshot(&self) -> Vec<HelperEntry> {
        self.infos
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
