/// Minimal localhost HTTP server for agent-facing block queries + MCP server.
///
/// Binds to 0.0.0.0:7766 (not 127.0.0.1 — WSL2 needs 0.0.0.0 to reach via gateway IP).
/// WSL2 processes reach this via the Windows host IP stored in $WMUX_API_BASE.
/// SSH sessions get a per-session reverse-tunnel port; $WMUX_API_BASE is set accordingly.
///
/// Endpoints:
///   GET  /info                                  — capabilities document
///   GET  /sessions                              — list active session IDs
///   GET  /blocks?session_id=<id>&limit=<n>      — recent completed blocks for a pane
///   GET  /agent-states                          — latest hook-pushed state per pane
///   POST /agent-event?pane_id=<id>              — receive a Claude Code hook event
///   POST /mcp                                   — MCP JSON-RPC 2.0 (Streamable HTTP transport)
use crate::session_manager::AgentHookState;
use crate::workbook::{render_workbook_html, WorkbookChart, WorkbookSpec, WorkbookStore};
use crate::{FrontendControlBridge, SessionManager};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, Mutex};

// ---------------------------------------------------------------------------
// Browser content read-back state
// ---------------------------------------------------------------------------

/// Tracks in-flight `browser_read_content` MCP requests. The JS eval'd into
/// the browser webview posts the page text to `POST /browser-content`, which
/// completes the waiting oneshot channel.
#[derive(Clone, Default)]
pub struct BrowserContentPending {
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
}

impl BrowserContentPending {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg_attr(target_os = "windows", allow(dead_code))]
    async fn register(&self, request_id: String) -> oneshot::Receiver<String> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(request_id, tx);
        rx
    }

    async fn deliver(&self, request_id: &str, content: String) {
        if let Some(tx) = self.pending.lock().await.remove(request_id) {
            let _ = tx.send(content);
        }
    }

    #[cfg_attr(target_os = "windows", allow(dead_code))]
    async fn cancel(&self, request_id: &str) {
        self.pending.lock().await.remove(request_id);
    }
}

// ---------------------------------------------------------------------------

const INFO_JSON: &str = r#"{
  "name": "wmux",
  "description": "wmux terminal multiplexer agent API. Provides structured access to terminal session state including completed command blocks with their output.",
  "env": {
    "WMUX": "Set to '1' in every wmux pane. Use to detect you are running inside wmux.",
    "WMUX_PANE_ID": "Unique ID of the current pane/session. Pass as session_id to /blocks or the get_blocks MCP tool.",
    "WMUX_API_BASE": "Base URL for this API (e.g. http://localhost:7766). Always set — use this instead of hardcoding the port."
  },
  "endpoints": [
    {
      "method": "GET",
      "path": "/info",
      "description": "Returns this capabilities document."
    },
    {
      "method": "GET",
      "path": "/sessions",
      "description": "Returns a JSON array of all active pane/session IDs."
    },
    {
      "method": "GET",
      "path": "/blocks",
      "params": {
        "session_id": "required — the pane ID to query (use $WMUX_PANE_ID for the current pane)",
        "limit": "optional — number of most-recent blocks to return (default 20, max 200)"
      },
      "description": "Returns a JSON array of completed command blocks for a session, oldest first. Each block contains: id (sequence number), command (the command that was run), output (plain text, ANSI escape codes stripped), exit_code (integer or null), started_ms (unix epoch ms), ended_ms (unix epoch ms). Blocks are produced by OSC 133 shell integration — install it with the lightning bolt button in the pane toolbar."
    },
    {
      "method": "GET",
      "path": "/agent-states",
      "description": "Returns the latest hook-pushed agent state for every pane that has reported one. Each entry: pane_id, hook_event (PreToolUse/PostToolUse/Stop/Notification/UserPromptSubmit), tool, message, event_ms."
    },
    {
      "method": "POST",
      "path": "/agent-event",
      "params": {
        "pane_id": "required — the pane ID to attribute this event to (use $WMUX_PANE_ID)"
      },
      "description": "Receive a Claude Code lifecycle hook event. POST the raw stdin JSON from a Claude Code hook here. Pane ID is passed as a query param. Used by the HK (hooks) toolbar button to give wmux authoritative agent state."
    },
    {
      "method": "POST",
      "path": "/mcp",
    "description": "MCP (Model Context Protocol) server — Streamable HTTP transport, JSON-RPC 2.0. Tools: get_blocks, list_sessions, list_agents, ask_agent, broadcast, list_workspaces, switch_workspace, new_workspace, close_workspace, list_tabs, create_tab, focus_tab, close_tab, move_tab, list_panes, split_pane, focus_pane, close_pane, get_layout, pane_send_text, pane_send_keys, pane_read_screen, wmux_eval, workbook_create, workbook_update, workbook_delete, workbook_open, workbook_list, workbook_get, workbook_add_chart, workbook_update_chart, workbook_remove_chart, workbook_reorder_charts, browser_list, browser_open, browser_navigate, browser_back, browser_forward, browser_close, browser_read_content. Configure in Claude Code with: claude mcp add --transport http wmux $WMUX_API_BASE/mcp"
    }
  ],
  "usage_example": "curl \"$WMUX_API_BASE/blocks?session_id=$WMUX_PANE_ID&limit=5\""
}"#;

pub const PORT: u16 = 7766;

pub fn start(manager: SessionManager, app: tauri::AppHandle) {
    tauri::async_runtime::spawn(serve(manager, app));
}

async fn serve(manager: SessionManager, app: tauri::AppHandle) {
    // Bind on all interfaces so WSL2 can reach the server via the Windows host IP.
    // WSL2's localhost-forwarding proxy is unreliable for 127.0.0.1 binds;
    // 0.0.0.0 lets WSL2 connect through the virtual Ethernet adapter instead.
    // Windows Firewall blocks inbound traffic from outside the machine by default.
    let listener = match TcpListener::bind(("0.0.0.0", PORT)).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("wmux HTTP server failed to bind on 0.0.0.0:{PORT}: {e}");
            return;
        }
    };
    log::info!("wmux HTTP server listening on 0.0.0.0:{PORT}");

    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(handle(stream, manager.clone(), app.clone()));
            }
            Err(e) => {
                log::warn!("HTTP accept error: {e}");
            }
        }
    }
}

async fn handle(mut stream: tokio::net::TcpStream, manager: SessionManager, app: tauri::AppHandle) {
    // 64 KB — plenty for any MCP JSON-RPC payload.
    let mut buf = vec![0u8; 65536];
    let n = match stream.read(&mut buf).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };

    let req_bytes = &buf[..n];

    // Split headers from body at \r\n\r\n.
    let header_end = req_bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .unwrap_or(n);

    let headers = String::from_utf8_lossy(&req_bytes[..header_end]);
    let first_line = headers.lines().next().unwrap_or("");

    let mut parts = first_line.split_ascii_whitespace();
    let method = parts.next().unwrap_or("");
    let path_and_query = parts.next().unwrap_or("/");

    let (path, query) = path_and_query
        .split_once('?')
        .unwrap_or((path_and_query, ""));

    match (method, path) {
        ("GET", "/" | "/info") => {
            write_response(&mut stream, 200, INFO_JSON).await;
        }
        ("GET", "/blocks") => {
            let params = parse_query(query);
            let Some(session_id) = params.get("session_id") else {
                write_response(&mut stream, 400, r#"{"error":"session_id required"}"#).await;
                return;
            };
            let limit = params
                .get("limit")
                .and_then(|v| v.parse::<usize>().ok())
                .unwrap_or(20)
                .min(200);

            match manager.get_block_store(session_id).await {
                None => {
                    write_response(&mut stream, 404, r#"{"error":"session not found"}"#).await;
                }
                Some(store) => {
                    let blocks = store.lock().await.recent(limit);
                    let body = serde_json::to_string(&blocks).unwrap_or_default();
                    write_response(&mut stream, 200, &body).await;
                }
            }
        }
        ("GET", "/workbook") => {
            let params = parse_query(query);
            let Some(workbook_id) = params.get("id") else {
                write_response(&mut stream, 400, r#"{"error":"id required"}"#).await;
                return;
            };
            match WorkbookStore::from_app(&app).and_then(|store| store.get(workbook_id)) {
                Ok(spec) => {
                    let html = render_workbook_html(&spec);
                    write_response_html(&mut stream, 200, &html).await;
                }
                Err(err) => {
                    let status = if err.contains("not found") { 404 } else { 500 };
                    write_response(&mut stream, status, &serde_json::json!({"error": err}).to_string()).await;
                }
            }
        }
        ("GET", "/workbook-data") => {
            let params = parse_query(query);
            let Some(workbook_id) = params.get("id") else {
                write_response(&mut stream, 400, r#"{"error":"id required"}"#).await;
                return;
            };
            match WorkbookStore::from_app(&app).and_then(|store| store.get(workbook_id)) {
                Ok(spec) => {
                    let body = serde_json::to_string_pretty(&spec).unwrap_or_default();
                    write_response(&mut stream, 200, &body).await;
                }
                Err(err) => {
                    let status = if err.contains("not found") { 404 } else { 500 };
                    write_response(&mut stream, status, &serde_json::json!({"error": err}).to_string()).await;
                }
            }
        }
        ("GET", "/sessions") => {
            let ids = manager.list().await;
            let body = serde_json::to_string(&ids).unwrap_or_default();
            write_response(&mut stream, 200, &body).await;
        }
        ("GET", "/agent-states") => {
            let states = manager.get_all_agent_hook_states().await;
            let body = serde_json::to_string(&states).unwrap_or_default();
            write_response(&mut stream, 200, &body).await;
        }
        ("POST", "/agent-event") => {
            let params = parse_query(query);
            let pane_id = params.get("pane_id").cloned().unwrap_or_default();
            if pane_id.is_empty() {
                write_response(&mut stream, 400, r#"{"error":"pane_id required"}"#).await;
                return;
            }
            let body_start = (header_end + 4).min(n);
            let body = String::from_utf8_lossy(&req_bytes[body_start..n]);
            let data: serde_json::Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(_) => {
                    write_response(&mut stream, 400, r#"{"error":"invalid JSON"}"#).await;
                    return;
                }
            };
            let state = agent_hook_state_from_event(&data);
            manager.set_agent_hook_state(&pane_id, state.clone()).await;
            // Start with the full raw body so all Claude Code fields pass through,
            // then overwrite/add our server-side fields.
            let mut payload = data.clone();
            if let Some(obj) = payload.as_object_mut() {
                obj.insert("pane_id".into(), serde_json::json!(pane_id));
                obj.insert("hook_event".into(), serde_json::json!(state.hook_event));
                obj.insert("tool".into(), serde_json::json!(state.tool));
                obj.insert("message".into(), serde_json::json!(state.message));
                obj.insert("event_ms".into(), serde_json::json!(state.event_ms));
            }
            let _ = app.emit("agent-hook-event", payload);
            write_response(&mut stream, 200, r#"{"ok":true}"#).await;
        }
        ("POST", "/browser-content") => {
            // Callback endpoint: JS eval'd in a browser webview posts page text here.
            // Read the full body, honoring Content-Length for payloads > initial buffer.
            let params = parse_query(query);
            let request_id = params.get("request_id").cloned().unwrap_or_default();
            if request_id.is_empty() {
                write_response_no_body(&mut stream, 400).await;
                return;
            }
            let content_length: usize = headers
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
                .and_then(|l| l.split(':').nth(1)?.trim().parse().ok())
                .unwrap_or(0);
            let body_start = (header_end + 4).min(n);
            let mut body_bytes = req_bytes[body_start..n].to_vec();
            const MAX_CONTENT: usize = 512 * 1024;
            while body_bytes.len() < content_length.min(MAX_CONTENT) {
                let mut chunk = vec![0u8; 65536];
                match stream.read(&mut chunk).await {
                    Ok(0) => break,
                    Ok(k) => body_bytes.extend_from_slice(&chunk[..k]),
                    Err(_) => break,
                }
            }
            let body_str = String::from_utf8_lossy(&body_bytes).into_owned();
            let pending = app.state::<BrowserContentPending>();
            pending.deliver(&request_id, body_str).await;
            write_response_no_body(&mut stream, 204).await;
        }
        ("POST", "/mcp") => {
            // If \r\n\r\n was absent (truncated request), body_start clamps to n → empty body.
            let body_start = (header_end + 4).min(n);
            let body = String::from_utf8_lossy(&req_bytes[body_start..n]);
            let (status, resp_body) = handle_mcp(&body, &manager, &app).await;
            if status == 204 {
                write_response_no_body(&mut stream, 204).await;
            } else {
                write_response(&mut stream, status, &resp_body).await;
            }
        }
        ("GET", artifact_path) if artifact_path.starts_with("/artifact/") => {
            let filename = &artifact_path["/artifact/".len()..];
            // Reject any filename that attempts path traversal or contains separators.
            if filename.is_empty()
                || filename.contains('/')
                || filename.contains('\\')
                || filename.contains("..")
            {
                write_response(&mut stream, 400, r#"{"error":"invalid filename"}"#).await;
                return;
            }
            let artifacts_dir = match app.path().app_data_dir() {
                Ok(d) => d.join("artifacts"),
                Err(_) => {
                    write_response(&mut stream, 500, r#"{"error":"could not resolve app data dir"}"#).await;
                    return;
                }
            };
            let file_path = artifacts_dir.join(filename);
            match tokio::fs::read_to_string(&file_path).await {
                Ok(content) => write_response_html(&mut stream, 200, &content).await,
                Err(_) => write_response(&mut stream, 404, r#"{"error":"artifact not found"}"#).await,
            }
        }
        _ => {
            write_response(&mut stream, 404, r#"{"error":"not found"}"#).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Agent hook event helpers
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn agent_hook_state_from_event(data: &serde_json::Value) -> AgentHookState {
    let hook_event = data["hook_event_name"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();
    let tool = data["tool_name"].as_str().map(|s| s.to_string());
    let message = data["message"].as_str().map(|s| s.to_string());
    AgentHookState { hook_event, tool, message, event_ms: now_ms() }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 handler
// ---------------------------------------------------------------------------

async fn handle_mcp(body: &str, manager: &SessionManager, app: &tauri::AppHandle) -> (u16, String) {
    let req: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => {
            return (400, json_rpc_error(serde_json::Value::Null, -32700, "Parse error"));
        }
    };

    let method = match req["method"].as_str() {
        Some(m) => m,
        None => return (400, json_rpc_error(serde_json::Value::Null, -32600, "Invalid Request")),
    };

    // Notifications have no "id" field — return 204, no body.
    let id = match req.get("id") {
        Some(id) => id.clone(),
        None => return (204, String::new()),
    };

    let params = req.get("params").cloned().unwrap_or(serde_json::json!({}));

    let result = match method {
        "initialize" => {
            serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {
                    "name": "wmux",
                    "version": env!("CARGO_PKG_VERSION")
                }
            })
        }
        "tools/list" => {
            serde_json::json!({
                "tools": [
                    {
                        "name": "get_blocks",
                        "description": "Get recent completed command blocks for a wmux terminal pane. Returns each command that was run, its plain-text output (ANSI codes stripped), exit code, and timestamps. Use $WMUX_PANE_ID as session_id to query the pane you are running inside.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "session_id": {
                                    "type": "string",
                                    "description": "Pane/session ID to query. Use the value of $WMUX_PANE_ID for the current pane."
                                },
                                "limit": {
                                    "type": "integer",
                                    "description": "Number of most-recent blocks to return. Default 20, max 200.",
                                    "default": 20
                                }
                            },
                            "required": ["session_id"]
                        }
                    },
                    {
                        "name": "list_sessions",
                        "description": "List all active wmux pane/session IDs. Use get_blocks with one of these IDs to retrieve command history for that pane.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {}
                        }
                    },
                    {
                        "name": "list_agents",
                        "description": "List all active wmux panes with metadata for agent discovery. Returns session_id, label (e.g. 'Ubuntu', 'user@host'), last_command (the most recent command run in that pane — useful for detecting which agent is running), is_running (whether a command is currently executing), and block_count. Works across local, WSL, and SSH panes.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {}
                        }
                    },
                    {
                        "name": "ask_agent",
                        "description": "Send a message to another wmux pane and wait for its response. Writes the message to the pane's terminal (as if you typed it), then waits for the output to settle. Works with any agent running in any pane — local, WSL, or SSH. Use list_agents to discover available panes. For long-running agents, increase timeout_secs.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "pane_id": {
                                    "type": "string",
                                    "description": "Target pane/session ID (from list_agents or list_sessions)."
                                },
                                "message": {
                                    "type": "string",
                                    "description": "Message to send to the agent. Will be submitted with a trailing newline."
                                },
                                "timeout_secs": {
                                    "type": "integer",
                                    "description": "Maximum total wait time in seconds (5–600). Default 60.",
                                    "default": 60
                                },
                                "silence_secs": {
                                    "type": "integer",
                                    "description": "Seconds of output silence that signals the agent is done responding (2–30). Default 5.",
                                    "default": 5
                                }
                            },
                            "required": ["pane_id", "message"]
                        }
                    },
                    {
                        "name": "broadcast",
                        "description": "Send a message to all active wmux panes simultaneously. Useful for coordinating multiple agents (e.g. 'wrap up your current task'). Optionally exclude the calling pane.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "message": {
                                    "type": "string",
                                    "description": "Message to broadcast to all panes."
                                },
                                "exclude_pane_id": {
                                    "type": "string",
                                    "description": "Optional pane ID to exclude (typically $WMUX_PANE_ID to avoid sending to yourself)."
                                }
                            },
                            "required": ["message"]
                        }
                    },
                    {
                        "name": "list_workspaces",
                        "description": "List all workspaces in wmux. Each entry has id, name, pinned, themeId, themeLabel, active, tabCount. A workspace is a container of tabs; you can have multiple workspaces with separate sets of tabs/panes (e.g. project A vs project B).",
                        "inputSchema": { "type": "object", "properties": {} }
                    },
                    {
                        "name": "switch_workspace",
                        "description": "Switch wmux to a different workspace. The previously-active workspace's tabs become hidden; the target workspace's tabs become visible.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workspace_id": { "type": "string", "description": "Workspace id from list_workspaces." }
                            },
                            "required": ["workspace_id"]
                        }
                    },
                    {
                        "name": "new_workspace",
                        "description": "Create a new workspace. Returns the new workspace's record. The new workspace becomes active automatically.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "name": { "type": "string", "description": "Optional name (default: 'Workspace N')." }
                            }
                        }
                    },
                    {
                        "name": "close_workspace",
                        "description": "Close a workspace and all its tabs/panes. The user is not prompted — this is destructive. Prefer closing tabs individually if unsure.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workspace_id": { "type": "string", "description": "Workspace id to close." }
                            },
                            "required": ["workspace_id"]
                        }
                    },
                    {
                        "name": "list_tabs",
                        "description": "List tabs. Returns each tab's tabId, title, workspaceId, paneIds, and the active flag. By default lists tabs in every workspace; pass workspace_id to filter.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workspace_id": { "type": "string", "description": "Optional workspace id to filter. Omit for all workspaces." }
                            }
                        }
                    },
                    {
                        "name": "create_tab",
                        "description": "Create a new tab. Returns the new tab's record. If workspace_id is omitted, opens in the active workspace. Target controls what shell/agent runs in the tab's first pane.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workspace_id": { "type": "string", "description": "Optional workspace id. Defaults to active." },
                                "target": { "type": "object", "description": "Optional target spec describing what to run (e.g. {kind: 'local'} or {kind: 'wsl', distro: 'Ubuntu'}). Defaults to the wmux 'new tab' default." }
                            }
                        }
                    },
                    {
                        "name": "focus_tab",
                        "description": "Activate (focus) a tab. If the tab lives in a different workspace, wmux switches to that workspace first.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tab_id": { "type": "string", "description": "Tab id from list_tabs." }
                            },
                            "required": ["tab_id"]
                        }
                    },
                    {
                        "name": "close_tab",
                        "description": "Close a tab. All its panes are terminated. Not prompted.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tab_id": { "type": "string", "description": "Tab id to close." }
                            },
                            "required": ["tab_id"]
                        }
                    },
                    {
                        "name": "move_tab",
                        "description": "Move a tab to a different workspace. Useful for organizing experiments into their own workspace after they outgrow a shared one.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tab_id": { "type": "string", "description": "Tab id to move." },
                                "workspace_id": { "type": "string", "description": "Destination workspace id." }
                            },
                            "required": ["tab_id", "workspace_id"]
                        }
                    },
                    {
                        "name": "list_panes",
                        "description": "List panes. Returns each pane's paneId, tabId, sessionId, label, and active flag. Pass tab_id to filter to one tab. Note: pane sessionId is the same value as list_agents.pane_id — these are the IDs to use with ask_agent, get_blocks, etc.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tab_id": { "type": "string", "description": "Optional tab id to filter. Omit for all panes across all tabs." }
                            }
                        }
                    },
                    {
                        "name": "split_pane",
                        "description": "Split a pane horizontally or vertically, creating a new sibling pane with a default terminal target. Returns the new pane's record. To split with a browser pane instead, use browser_open with kind:\"iframe\".",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "pane_id": { "type": "string", "description": "Pane to split (the new pane appears beside it)." },
                                "direction": { "type": "string", "enum": ["h", "v"], "description": "h splits left/right; v splits top/bottom. Default v." }
                            },
                            "required": ["pane_id"]
                        }
                    },
                    {
                        "name": "focus_pane",
                        "description": "Activate (focus) a pane. Switches workspace + tab if needed.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "pane_id": { "type": "string", "description": "Pane id from list_panes." }
                            },
                            "required": ["pane_id"]
                        }
                    },
                    {
                        "name": "close_pane",
                        "description": "Close a pane. The PTY is terminated. If it's the last pane in its tab, the tab closes too.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "pane_id": { "type": "string", "description": "Pane id to close." }
                            },
                            "required": ["pane_id"]
                        }
                    },
                    {
                        "name": "get_layout",
                        "description": "Export the current wmux layout as JSON — every workspace, tab, and pane. Useful for an agent to understand the full structural state at a glance, or to save/restore layouts.",
                        "inputSchema": { "type": "object", "properties": {} }
                    },
                    {
                        "name": "pane_send_text",
                        "description": "Write text to a pane's PTY as if the user typed it. Fire-and-forget — returns immediately, does NOT wait for output (use ask_agent if you want request/response semantics). Useful for queueing input into a TUI, pasting a snippet, or pre-filling a prompt. Set append_enter to also press Enter after the text.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "pane_id": { "type": "string", "description": "Pane id (from list_panes or list_agents). Same value as $WMUX_PANE_ID inside that pane." },
                                "text": { "type": "string", "description": "UTF-8 text to write to the PTY." },
                                "append_enter": { "type": "boolean", "description": "If true, send a trailing carriage return after the text. Default false." }
                            },
                            "required": ["pane_id", "text"]
                        }
                    },
                    {
                        "name": "pane_send_keys",
                        "description": "Send structured key chords / special keys to a pane's PTY. Each entry is one keystroke, tmux-style: control modifiers `C-c` (Ctrl+C), `M-x` (Alt/Meta+X), named keys `Up` `Down` `Left` `Right` `Enter` `Tab` `Esc` `BSpace` `Space` `Home` `End` `PageUp` `PageDown` `Delete` `F1`..`F12`, or a single literal character (`a`, `9`). Multiple keys = multiple bytes written in sequence (use this to nav menus: [\"Up\", \"Up\", \"Enter\"]). Fire-and-forget.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "pane_id": { "type": "string", "description": "Pane id (from list_panes or list_agents)." },
                                "keys": {
                                    "type": "array",
                                    "items": { "type": "string" },
                                    "description": "Sequence of key names. Examples: [\"C-c\"], [\"Up\", \"Up\", \"Enter\"], [\"M-x\", \"f\", \"i\", \"n\", \"d\", \"Enter\"]."
                                }
                            },
                            "required": ["pane_id", "keys"]
                        }
                    },
                    {
                        "name": "wmux_eval",
                        "description": "**SPIKE — server-side script execution.** Run a JavaScript script in a sandboxed boa engine with selected wmux MCP tools bound as synchronous global functions. Lets you collapse multi-step workflows (e.g. 'new workspace + create tab + split twice + send commands') into a single MCP call. Bound tools (v0): list_workspaces, list_tabs, list_panes, get_layout, list_agents, list_sessions, ask_agent, pane_send_text, pane_send_keys, pane_read_screen, browser_list, browser_open, browser_navigate. Each is a synchronous JS function — call without `await`. Each takes a single optional object argument matching the tool's MCP input schema, and returns the tool's parsed JSON result. Throws on tool error. Script's final expression value is returned as JSON. Default 10s timeout, max 60s.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "script": { "type": "string", "description": "JS source. Example: `const ws = list_workspaces(); ws.length;` or `const tabs = list_tabs(); for (const t of tabs) { pane_send_text({pane_id: t.paneIds[0], text: 'date', append_enter: true}); } 'done';`. Sync API — no Promises, no await." },
                                "timeout_ms": { "type": "integer", "description": "Wall-clock limit in ms (default 10000, max 60000)." }
                            },
                            "required": ["script"]
                        }
                    },
                    {
                        "name": "pane_read_screen",
                        "description": "Return the current ANSI-stripped scrollback for a pane. Unlike get_blocks (which is OSC 133 prompt-bounded), this returns the raw terminal contents — useful when there's no prompt (TUIs, partial output, agents that don't emit OSC 133). Optionally limit to the last N lines.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "pane_id": { "type": "string", "description": "Pane id (from list_panes or list_agents)." },
                                "lines": { "type": "integer", "description": "If set, return only the last N lines. Omit for full available scrollback." }
                            },
                            "required": ["pane_id"]
                        }
                    },
                    {
                        "name": "workbook_list",
                        "description": "List saved workbooks in wmux. Returns each workbook's id, title, subtitle, chart count, row count, and last updated time.",
                        "inputSchema": { "type": "object", "properties": {} }
                    },
                    {
                        "name": "workbook_get",
                        "description": "Fetch a saved workbook spec by id, including rows, columns, filters, metrics, charts, and layout.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook_id": { "type": "string", "description": "Workbook id to fetch." }
                            },
                            "required": ["workbook_id"]
                        }
                    },
                    {
                        "name": "workbook_create",
                        "description": "Create and persist a workbook spec, then return its id and browser preview URL. After creating, call workbook_open to display it in wmux. Example workbook shape: {\"title\":\"My Dashboard\",\"rows\":[{\"city\":\"Austin\",\"tempF\":91,\"condition\":\"Sunny\"}],\"columns\":[\"city\",\"tempF\",\"condition\"],\"metrics\":[{\"label\":\"Cities\",\"value\":5,\"detail\":\"in dataset\"}],\"charts\":[{\"title\":\"Temp by City\",\"kind\":\"bar\",\"groupBy\":\"city\",\"valueField\":\"tempF\",\"aggregation\":\"avg\",\"sort\":\"desc\"}],\"filters\":[{\"label\":\"Condition\",\"field\":\"condition\",\"kind\":\"select\"}]}. columns may be plain strings or {key,label} objects.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook": {
                                    "type": "object",
                                    "description": "Workbook spec. Required: title. Optional: rows (array of objects), columns (array of strings or {key,label} objects), metrics ([{label,value,detail}]), charts ([{title,kind,groupBy,valueField,aggregation,sort,limit}]), filters ([{label,field,kind}])."
                                }
                            },
                            "required": ["workbook"]
                        }
                    },
                    {
                        "name": "workbook_update",
                        "description": "Replace an existing workbook spec by id and return the updated workbook.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook": {
                                    "type": "object",
                                    "description": "Full workbook spec, including workbook id."
                                }
                            },
                            "required": ["workbook"]
                        }
                    },
                    {
                        "name": "workbook_delete",
                        "description": "Delete a saved workbook.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook_id": { "type": "string" }
                            },
                            "required": ["workbook_id"]
                        }
                    },
                    {
                        "name": "workbook_open",
                        "description": "Open a workbook as a live browser pane inside wmux. If workbook_id is supplied, opens an existing workbook. If a workbook object is supplied, persists it first then opens it. Always call this after workbook_create to make the workbook visible.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook_id": { "type": "string" },
                                "workbook": { "type": "object" }
                            }
                        }
                    },
                    {
                        "name": "workbook_add_chart",
                        "description": "Append a chart to a workbook's charts array.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook_id": { "type": "string" },
                                "chart": { "type": "object", "description": "Chart spec with title, groupBy, valueField, aggregation, sort, limit, and filters." }
                            },
                            "required": ["workbook_id", "chart"]
                        }
                    },
                    {
                        "name": "workbook_update_chart",
                        "description": "Replace a chart inside a workbook by chart id.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook_id": { "type": "string" },
                                "chart": { "type": "object", "description": "Full chart spec including id." }
                            },
                            "required": ["workbook_id", "chart"]
                        }
                    },
                    {
                        "name": "workbook_remove_chart",
                        "description": "Remove a chart from a workbook by chart id.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook_id": { "type": "string" },
                                "chart_id": { "type": "string" }
                            },
                            "required": ["workbook_id", "chart_id"]
                        }
                    },
                    {
                        "name": "workbook_reorder_charts",
                        "description": "Reorder a workbook's charts with an ordered list of chart ids.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "workbook_id": { "type": "string" },
                                "chart_ids": {
                                    "type": "array",
                                    "items": { "type": "string" }
                                }
                            },
                            "required": ["workbook_id", "chart_ids"]
                        }
                    },
                    {
                        "name": "browser_list",
                        "description": "List every driveable browser in wmux — both iframe panes (embedded inside a pane) and CEF helper windows (out-of-process Chromium, driveable via Chrome DevTools Protocol). Each entry has a `kind: \"iframe\" | \"cef_helper\"` field; agents can pass any label from this list to navigate/back/forward/close. CEF helpers additionally support screenshot/click/evaluate.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tab_id": { "type": "string", "description": "Optional tab ID to filter iframe panes (CEF helpers are always included regardless)." }
                            }
                        }
                    },
                    {
                        "name": "cef_helper_list",
                        "description": "DEPRECATED — kept for backwards compatibility. Use browser_list instead; it now returns CEF helpers tagged with kind:\"cef_helper\" alongside iframe panes.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {}
                        }
                    },
                    {
                        "name": "browser_open",
                        "description": "Open a URL in a new browser. Default `kind` is \"iframe\" (embeds the page inside a wmux pane — fast, no extra process, but some sites block iframe embedding via X-Frame-Options/CSP). Pass `kind: \"cef_helper\"` to spawn a standalone Chromium window that bypasses those restrictions and unlocks screenshot/click/evaluate.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string", "description": "URL to open." },
                                "kind": { "type": "string", "enum": ["iframe", "cef_helper"], "description": "iframe (default) embeds in a wmux pane; cef_helper opens a standalone Chromium window driveable via CDP (screenshot, click, evaluate)." },
                                "tab_id": { "type": "string", "description": "Tab to open the iframe in (ignored for cef_helper). Defaults to the active tab." }
                            },
                            "required": ["url"]
                        }
                    },
                    {
                        "name": "browser_navigate",
                        "description": "Navigate any browser (iframe pane or CEF helper) to a new URL. The label kind is detected automatically — agents don't need to know which is which.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser label from browser_list or browser_open (either kind)." },
                                "url": { "type": "string", "description": "URL to navigate to." }
                            },
                            "required": ["label", "url"]
                        }
                    },
                    {
                        "name": "browser_back",
                        "description": "Navigate back in a browser's history. Works on both iframe panes and CEF helpers; kind detected automatically.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser label (either kind)." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_forward",
                        "description": "Navigate forward in a browser's history. Works on both iframe panes and CEF helpers; kind detected automatically.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser label (either kind)." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_close",
                        "description": "Close a browser. For iframe panes this removes the pane; for CEF helpers this kills the helper process. Kind detected automatically.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser label (either kind)." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_read_content",
                        "description": "**Requires kind: \"cef_helper\".** Read the visible text (or raw HTML) of the page currently loaded in a CEF helper. Returns { url, title, content }. If you only have an iframe label, call browser_open with kind:\"cef_helper\" to get a driveable target.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser pane label (from browser_list or browser_open)." },
                                "format": { "type": "string", "enum": ["text", "html"], "description": "Return innerText (default) or full outerHTML." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_get_url",
                        "description": "**Requires kind: \"cef_helper\".** Return the current URL + title of a CEF helper page. Cheap 'where am I' lookup that skips body-text extraction — useful for confirming where a navigate landed.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "CEF helper label from browser_list (entries where kind == \"cef_helper\")." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_evaluate",
                        "description": "**Requires kind: \"cef_helper\".** Run an arbitrary JS expression inside a CEF helper page via Chrome DevTools Protocol Runtime.evaluate. Returns the raw CDP result object — preserves type metadata (string vs number vs object) and exception details. Set await_promise=true for async expressions like `await fetch(...)`.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "CEF helper label from browser_list (entries where kind == \"cef_helper\")." },
                                "expression": { "type": "string", "description": "JS expression to evaluate. Last expression's value is returned." },
                                "await_promise": { "type": "boolean", "description": "If true, await a Promise returned by the expression. Default false." }
                            },
                            "required": ["label", "expression"]
                        }
                    },
                    {
                        "name": "browser_screenshot",
                        "description": "**Requires kind: \"cef_helper\".** Capture a PNG screenshot via CDP Page.captureScreenshot. Writes the file to <app data dir>/screenshots/<uuid>.png and returns { label, path, bytes, full_page }. Set full_page=true to capture beyond the viewport.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "CEF helper label from browser_list (entries where kind == \"cef_helper\")." },
                                "full_page": { "type": "boolean", "description": "Capture the full scrollable page (default: viewport only)." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_click",
                        "description": "**Requires kind: \"cef_helper\".** Dispatch a mouse click at (x, y) viewport coordinates via CDP Input.dispatchMouseEvent. Sends both mousePressed and mouseReleased so the page registers a real click (links, buttons, form controls all activate). Use browser_screenshot first to find coordinates.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "CEF helper label from browser_list (entries where kind == \"cef_helper\")." },
                                "x": { "type": "number", "description": "Viewport X coordinate (pixels, 0 = left edge)." },
                                "y": { "type": "number", "description": "Viewport Y coordinate (pixels, 0 = top edge)." },
                                "button": { "type": "string", "enum": ["left", "middle", "right"], "description": "Mouse button (default: left)." }
                            },
                            "required": ["label", "x", "y"]
                        }
                    }
                ]
            })
        }
        "tools/call" => {
            let tool_name = params["name"].as_str().unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(serde_json::json!({}));
            let bridge = app.state::<FrontendControlBridge>();
            match dispatch_tool(tool_name, &args, manager, app, &bridge).await {
                Ok(text) => serde_json::json!({
                    "content": [{"type": "text", "text": text}]
                }),
                Err(msg) => serde_json::json!({
                    "content": [{"type": "text", "text": msg}],
                    "isError": true
                }),
            }
        }
        _ => {
            return (200, json_rpc_error(id, -32601, "Method not found"));
        }
    };

    (200, json_rpc_ok(id, result))
}

pub async fn dispatch_tool(
    name: &str,
    args: &serde_json::Value,
    manager: &SessionManager,
    app: &tauri::AppHandle,
    bridge: &FrontendControlBridge,
) -> Result<String, String> {
    match name {
        "get_blocks" => {
            let session_id = args["session_id"]
                .as_str()
                .ok_or_else(|| "session_id is required".to_string())?;
            let limit = args["limit"].as_u64().unwrap_or(20).min(200) as usize;
            match manager.get_block_store(session_id).await {
                None => Err(format!("session '{}' not found", session_id)),
                Some(store) => {
                    let blocks = store.lock().await.recent(limit);
                    serde_json::to_string_pretty(&blocks).map_err(|e| e.to_string())
                }
            }
        }
        "list_sessions" => {
            let ids = manager.list().await;
            serde_json::to_string_pretty(&ids).map_err(|e| e.to_string())
        }
        "list_agents" => {
            let meta = manager.list_with_meta().await;
            serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())
        }
        "ask_agent" => {
            let pane_id = args["pane_id"]
                .as_str()
                .ok_or_else(|| "pane_id is required".to_string())?;
            let message = args["message"]
                .as_str()
                .ok_or_else(|| "message is required".to_string())?;
            let timeout_secs = args["timeout_secs"].as_u64().unwrap_or(60);
            let silence_secs = args["silence_secs"].as_u64().unwrap_or(5);
            manager.ask_and_wait(pane_id, message, timeout_secs, silence_secs).await
        }
        "broadcast" => {
            let message = args["message"]
                .as_str()
                .ok_or_else(|| "message is required".to_string())?;
            let exclude = args["exclude_pane_id"].as_str();
            let sent = manager.broadcast(message, exclude).await;
            serde_json::to_string_pretty(&serde_json::json!({ "sent_to": sent }))
                .map_err(|e| e.to_string())
        }
        // ── Structural tools (workspaces, tabs, panes) ─────────────────
        // Each is a thin bridge wrapper. The JS-side automation bridge in
        // automation_bridge.mjs already implements every action; we just
        // expose them as MCP tools with explicit input schemas.
        "list_workspaces" => {
            let result = bridge.request(app, "list-workspaces", serde_json::Value::Null).await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "switch_workspace" => {
            let workspace_id = args["workspace_id"]
                .as_str()
                .ok_or_else(|| "workspace_id is required".to_string())?;
            let result = bridge
                .request(app, "switch-workspace", serde_json::json!({ "workspaceId": workspace_id }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "new_workspace" => {
            let mut payload = serde_json::json!({});
            if let Some(name) = args.get("name").and_then(|v| v.as_str()) {
                payload["name"] = serde_json::json!(name);
            }
            let result = bridge.request(app, "create-workspace", payload).await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "close_workspace" => {
            let workspace_id = args["workspace_id"]
                .as_str()
                .ok_or_else(|| "workspace_id is required".to_string())?;
            let result = bridge
                .request(app, "close-workspace", serde_json::json!({ "workspaceId": workspace_id }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "list_tabs" => {
            let mut payload = serde_json::json!({});
            if let Some(ws) = args.get("workspace_id").and_then(|v| v.as_str()) {
                payload["workspaceId"] = serde_json::json!(ws);
            }
            let result = bridge.request(app, "list-tabs", payload).await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "create_tab" => {
            let mut payload = serde_json::json!({});
            if let Some(ws) = args.get("workspace_id").and_then(|v| v.as_str()) {
                payload["workspaceId"] = serde_json::json!(ws);
            }
            if let Some(target) = args.get("target") {
                payload["target"] = target.clone();
            }
            let result = bridge.request(app, "create-tab", payload).await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "focus_tab" => {
            let tab_id = args["tab_id"]
                .as_str()
                .ok_or_else(|| "tab_id is required".to_string())?;
            let result = bridge
                .request(app, "focus-tab", serde_json::json!({ "tabId": tab_id }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "close_tab" => {
            let tab_id = args["tab_id"]
                .as_str()
                .ok_or_else(|| "tab_id is required".to_string())?;
            let result = bridge
                .request(app, "close-tab", serde_json::json!({ "tabId": tab_id }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "move_tab" => {
            let tab_id = args["tab_id"]
                .as_str()
                .ok_or_else(|| "tab_id is required".to_string())?;
            let workspace_id = args["workspace_id"]
                .as_str()
                .ok_or_else(|| "workspace_id is required".to_string())?;
            let result = bridge
                .request(app, "move-tab", serde_json::json!({ "tabId": tab_id, "workspaceId": workspace_id }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "list_panes" => {
            let mut payload = serde_json::json!({});
            if let Some(tab_id) = args.get("tab_id").and_then(|v| v.as_str()) {
                payload["tabId"] = serde_json::json!(tab_id);
            }
            let result = bridge.request(app, "list-panes", payload).await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "split_pane" => {
            let pane_id = args["pane_id"]
                .as_str()
                .ok_or_else(|| "pane_id is required".to_string())?;
            let direction = args.get("direction").and_then(|v| v.as_str()).unwrap_or("v");
            let result = bridge
                .request(app, "split-pane", serde_json::json!({ "paneId": pane_id, "direction": direction }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "focus_pane" => {
            let pane_id = args["pane_id"]
                .as_str()
                .ok_or_else(|| "pane_id is required".to_string())?;
            let result = bridge
                .request(app, "focus-pane", serde_json::json!({ "paneId": pane_id }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "close_pane" => {
            let pane_id = args["pane_id"]
                .as_str()
                .ok_or_else(|| "pane_id is required".to_string())?;
            let result = bridge
                .request(app, "close-pane", serde_json::json!({ "paneId": pane_id }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "get_layout" => {
            let result = bridge.request(app, "get-layout", serde_json::Value::Null).await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        // ── Code Mode (spike) ──────────────────────────────────────────
        // Runs an agent-supplied JS script with hand-picked MCP tools bound
        // as global functions. See code_mode.rs for the bindings list.
        "wmux_eval" => {
            let script = args["script"]
                .as_str()
                .ok_or_else(|| "script is required".to_string())?;
            let timeout_ms = args
                .get("timeout_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(10_000);
            crate::code_mode::eval_script(
                script.to_string(),
                timeout_ms,
                manager.clone(),
                app.clone(),
                bridge.clone(),
            )
            .await
        }
        // ── Pane input/output tools ─────────────────────────────────────
        // Direct PTY access. write_to() bypasses the JS bridge — these are
        // bytes-to-pseudoterminal calls. Trust model is the same as
        // ask_agent: any MCP client with API access can write any keystrokes
        // to any pane (local trust assumed).
        "pane_send_text" => {
            let pane_id = args["pane_id"]
                .as_str()
                .ok_or_else(|| "pane_id is required".to_string())?;
            let text = args["text"]
                .as_str()
                .ok_or_else(|| "text is required".to_string())?;
            let append_enter = args
                .get("append_enter")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mut bytes = text.as_bytes().to_vec();
            if append_enter {
                bytes.push(b'\r');
            }
            let written = bytes.len();
            if !manager.write_to(pane_id, &bytes).await {
                return Err(format!("pane '{}' not found", pane_id));
            }
            serde_json::to_string_pretty(&serde_json::json!({
                "pane_id": pane_id,
                "bytes_written": written,
            }))
            .map_err(|e| e.to_string())
        }
        "pane_send_keys" => {
            let pane_id = args["pane_id"]
                .as_str()
                .ok_or_else(|| "pane_id is required".to_string())?;
            let keys = args["keys"]
                .as_array()
                .ok_or_else(|| "keys must be an array of strings".to_string())?;
            let mut bytes: Vec<u8> = Vec::new();
            for (idx, key) in keys.iter().enumerate() {
                let name = key
                    .as_str()
                    .ok_or_else(|| format!("keys[{idx}] is not a string"))?;
                bytes.extend(
                    parse_key(name)
                        .map_err(|e| format!("keys[{idx}] ('{name}'): {e}"))?,
                );
            }
            let written = bytes.len();
            if !manager.write_to(pane_id, &bytes).await {
                return Err(format!("pane '{}' not found", pane_id));
            }
            serde_json::to_string_pretty(&serde_json::json!({
                "pane_id": pane_id,
                "keys_sent": keys.len(),
                "bytes_written": written,
            }))
            .map_err(|e| e.to_string())
        }
        "pane_read_screen" => {
            let pane_id = args["pane_id"]
                .as_str()
                .ok_or_else(|| "pane_id is required".to_string())?;
            let content = manager
                .capture_output_by_id(pane_id)
                .await
                .ok_or_else(|| format!("pane '{}' not found", pane_id))?;
            let trimmed = if let Some(n) = args.get("lines").and_then(|v| v.as_u64()) {
                let n = n.max(1) as usize;
                let line_count = content.lines().count();
                if line_count > n {
                    content
                        .lines()
                        .skip(line_count - n)
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    content.clone()
                }
            } else {
                content.clone()
            };
            serde_json::to_string_pretty(&serde_json::json!({
                "pane_id": pane_id,
                "content": trimmed,
                "total_lines": content.lines().count(),
            }))
            .map_err(|e| e.to_string())
        }
        "workbook_list" => {
            let store = WorkbookStore::from_app(app)?;
            serde_json::to_string_pretty(&store.list()?).map_err(|e| e.to_string())
        }
        "workbook_get" => {
            let workbook_id = args["workbook_id"]
                .as_str()
                .ok_or_else(|| "workbook_id is required".to_string())?;
            let store = WorkbookStore::from_app(app)?;
            serde_json::to_string_pretty(&store.get(workbook_id)?).map_err(|e| e.to_string())
        }
        "workbook_create" => {
            let workbook: WorkbookSpec = serde_json::from_value(args["workbook"].clone())
                .map_err(|e| e.to_string())?;
            let store = WorkbookStore::from_app(app)?;
            let saved = store.upsert(workbook)?;
            serde_json::to_string_pretty(&serde_json::json!({
                "workbook": saved,
                "preview_url": WorkbookStore::preview_url(&saved.id)
            }))
            .map_err(|e| e.to_string())
        }
        "workbook_update" => {
            let workbook: WorkbookSpec = serde_json::from_value(args["workbook"].clone())
                .map_err(|e| e.to_string())?;
            let store = WorkbookStore::from_app(app)?;
            let saved = store.upsert(workbook)?;
            serde_json::to_string_pretty(&serde_json::json!({
                "workbook": saved,
                "preview_url": WorkbookStore::preview_url(&saved.id)
            }))
            .map_err(|e| e.to_string())
        }
        "workbook_delete" => {
            let workbook_id = args["workbook_id"]
                .as_str()
                .ok_or_else(|| "workbook_id is required".to_string())?;
            let store = WorkbookStore::from_app(app)?;
            store.delete(workbook_id)?;
            serde_json::to_string_pretty(&serde_json::json!({"deleted": workbook_id}))
                .map_err(|e| e.to_string())
        }
        "workbook_open" => {
            let store = WorkbookStore::from_app(app)?;
            let workbook = if let Some(workbook_value) = args.get("workbook") {
                let workbook: WorkbookSpec = serde_json::from_value(workbook_value.clone())
                    .map_err(|e| e.to_string())?;
                store.upsert(workbook)?
            } else {
                let workbook_id = args["workbook_id"]
                    .as_str()
                    .ok_or_else(|| "workbook_id or workbook is required".to_string())?;
                store.get(workbook_id)?
            };
            serde_json::to_string_pretty(&serde_json::json!({
                "workbook": workbook,
                "preview_url": WorkbookStore::preview_url(&workbook.id)
            }))
            .map_err(|e| e.to_string())
        }
        "workbook_add_chart" => {
            let workbook_id = args["workbook_id"]
                .as_str()
                .ok_or_else(|| "workbook_id is required".to_string())?;
            let chart: WorkbookChart = serde_json::from_value(args["chart"].clone())
                .map_err(|e| e.to_string())?;
            let store = WorkbookStore::from_app(app)?;
            let saved = store.add_chart(workbook_id, chart)?;
            serde_json::to_string_pretty(&serde_json::json!({
                "workbook": saved,
                "preview_url": WorkbookStore::preview_url(&saved.id)
            }))
            .map_err(|e| e.to_string())
        }
        "workbook_update_chart" => {
            let workbook_id = args["workbook_id"]
                .as_str()
                .ok_or_else(|| "workbook_id is required".to_string())?;
            let chart: WorkbookChart = serde_json::from_value(args["chart"].clone())
                .map_err(|e| e.to_string())?;
            let store = WorkbookStore::from_app(app)?;
            let saved = store.update_chart(workbook_id, chart)?;
            serde_json::to_string_pretty(&serde_json::json!({
                "workbook": saved,
                "preview_url": WorkbookStore::preview_url(&saved.id)
            }))
            .map_err(|e| e.to_string())
        }
        "workbook_remove_chart" => {
            let workbook_id = args["workbook_id"]
                .as_str()
                .ok_or_else(|| "workbook_id is required".to_string())?;
            let chart_id = args["chart_id"]
                .as_str()
                .ok_or_else(|| "chart_id is required".to_string())?;
            let store = WorkbookStore::from_app(app)?;
            let saved = store.remove_chart(workbook_id, chart_id)?;
            serde_json::to_string_pretty(&serde_json::json!({
                "workbook": saved,
                "preview_url": WorkbookStore::preview_url(&saved.id)
            }))
            .map_err(|e| e.to_string())
        }
        "workbook_reorder_charts" => {
            let workbook_id = args["workbook_id"]
                .as_str()
                .ok_or_else(|| "workbook_id is required".to_string())?;
            let chart_ids = args["chart_ids"]
                .as_array()
                .ok_or_else(|| "chart_ids is required".to_string())?
                .iter()
                .filter_map(|value| value.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>();
            let store = WorkbookStore::from_app(app)?;
            let saved = store.reorder_charts(workbook_id, &chart_ids)?;
            serde_json::to_string_pretty(&serde_json::json!({
                "workbook": saved,
                "preview_url": WorkbookStore::preview_url(&saved.id)
            }))
            .map_err(|e| e.to_string())
        }
        "browser_list" => {
            // Unified listing. Returns both iframe panes and CEF helpers in
            // one array, each tagged with `kind`. Agents call this single
            // tool to discover everything driveable.
            let tab_id = args.get("tab_id").and_then(|v| v.as_str());
            let payload = match tab_id {
                Some(id) => serde_json::json!({ "tabId": id }),
                None => serde_json::Value::Null,
            };
            let iframes = bridge.request(app, "list-browsers", payload).await?;
            let mut combined: Vec<serde_json::Value> = match iframes {
                serde_json::Value::Array(items) => items
                    .into_iter()
                    .map(|mut v| {
                        if let serde_json::Value::Object(ref mut map) = v {
                            map.insert("kind".to_string(), serde_json::json!("iframe"));
                        }
                        v
                    })
                    .collect(),
                _ => Vec::new(),
            };
            for entry in app.state::<crate::BrowserHelpers>().snapshot() {
                combined.push(serde_json::json!({
                    "kind": "cef_helper",
                    "label": entry.label,
                    "pid": entry.pid,
                    "cdp_port": entry.cdp_port,
                    "cdp_url": entry.cdp_url,
                }));
            }
            serde_json::to_string_pretty(&combined).map_err(|e| e.to_string())
        }
        "cef_helper_list" => {
            // Compat alias for the pre-unification surface. New agents should
            // call `browser_list` (which now includes CEF helpers tagged with
            // kind:"cef_helper"). Kept so existing MCP clients don't break.
            let helpers = app.state::<crate::BrowserHelpers>();
            let entries = helpers.snapshot();
            serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())
        }
        "browser_open" => {
            let url = args["url"]
                .as_str()
                .ok_or_else(|| "url is required".to_string())?;
            let kind = args
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("iframe");
            match kind {
                "iframe" => {
                    let mut payload = serde_json::json!({ "url": url });
                    if let Some(tab_id) = args.get("tab_id").and_then(|v| v.as_str()) {
                        payload["tabId"] = serde_json::json!(tab_id);
                    }
                    let result = bridge.request(app, "open-browser", payload).await?;
                    // Tag with kind so the response shape matches browser_list.
                    let tagged = match result {
                        serde_json::Value::Object(mut map) => {
                            map.insert("kind".to_string(), serde_json::json!("iframe"));
                            serde_json::Value::Object(map)
                        }
                        other => other,
                    };
                    serde_json::to_string_pretty(&tagged).map_err(|e| e.to_string())
                }
                "cef_helper" => {
                    // Spawn a fresh CEF helper window. Reuses commands::
                    // spawn_browser_helper so the spawn path stays single-source.
                    let helpers = app.state::<crate::BrowserHelpers>();
                    let spawned = crate::commands::spawn_browser_helper(
                        app.clone(),
                        helpers,
                        String::new(),
                        url.to_string(),
                    )
                    .await?;
                    serde_json::to_string_pretty(&serde_json::json!({
                        "kind": "cef_helper",
                        "label": spawned.label,
                        "pid": spawned.pid,
                        "cdp_port": spawned.cdp_port,
                        "url": url,
                    }))
                    .map_err(|e| e.to_string())
                }
                other => Err(format!(
                    "unknown browser kind '{other}'. Expected 'iframe' or 'cef_helper'."
                )),
            }
        }
        "browser_navigate" => {
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let url = args["url"]
                .as_str()
                .ok_or_else(|| "url is required".to_string())?;
            // Dispatch by label type: a CEF helper goes via CDP (own process,
            // can't be reached through the JS bridge); an iframe pane goes
            // through the existing bridge path. The two label namespaces don't
            // overlap (helpers don't appear in browser_list, iframes don't
            // appear in cef_helper_list), so registry lookup is unambiguous.
            let helpers = app.state::<crate::BrowserHelpers>();
            if let Some(helper) = helpers.get(label) {
                cdp_navigate(helper.cdp_port, url).await?;
                serde_json::to_string_pretty(&serde_json::json!({
                    "label": label,
                    "kind": "cef_helper",
                    "url": url,
                }))
                .map_err(|e| e.to_string())
            } else {
                let result = bridge
                    .request(app, "navigate-browser", serde_json::json!({ "label": label, "url": url }))
                    .await?;
                serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
            }
        }
        "browser_back" => {
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let helpers = app.state::<crate::BrowserHelpers>();
            if let Some(helper) = helpers.get(label) {
                cdp_evaluate(helper.cdp_port, "history.back()", false).await?;
                serde_json::to_string_pretty(&serde_json::json!({
                    "label": label, "kind": "cef_helper", "action": "back"
                }))
                .map_err(|e| e.to_string())
            } else {
                let result = bridge
                    .request(app, "browser-back", serde_json::json!({ "label": label }))
                    .await?;
                serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
            }
        }
        "browser_forward" => {
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let helpers = app.state::<crate::BrowserHelpers>();
            if let Some(helper) = helpers.get(label) {
                cdp_evaluate(helper.cdp_port, "history.forward()", false).await?;
                serde_json::to_string_pretty(&serde_json::json!({
                    "label": label, "kind": "cef_helper", "action": "forward"
                }))
                .map_err(|e| e.to_string())
            } else {
                let result = bridge
                    .request(app, "browser-forward", serde_json::json!({ "label": label }))
                    .await?;
                serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
            }
        }
        "browser_close" => {
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let helpers = app.state::<crate::BrowserHelpers>();
            if helpers.get(label).is_some() {
                let killed = helpers.kill(label);
                serde_json::to_string_pretty(&serde_json::json!({
                    "label": label, "kind": "cef_helper", "killed": killed
                }))
                .map_err(|e| e.to_string())
            } else {
                let result = bridge
                    .request(app, "close-browser", serde_json::json!({ "label": label }))
                    .await?;
                serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
            }
        }
        "browser_read_content" => {
            // Drives the out-of-process CEF helper window via Chrome DevTools
            // Protocol. The helper was launched by `spawn_browser_helper` with
            // `--remote-debugging-port=N`; the (label → port) mapping lives in
            // the `BrowserHelpers` Tauri-managed state.
            //
            // CDP flow:
            //   1. GET http://localhost:N/json to enumerate page targets.
            //   2. Pick the first `type == "page"` target's webSocketDebuggerUrl.
            //   3. Open a WebSocket to it and send a `Runtime.evaluate`
            //      JSON-RPC request that returns {url, title, content}.
            //   4. Wait for the matching response by id.
            //
            // This replaces the previous WebView2.ExecuteScript path (which
            // assumed an in-process child webview registered with Tauri's
            // runtime) and the iframe HTTP-callback fallback. Works on any
            // platform where CEF can run with --remote-debugging-port.
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let format = args.get("format").and_then(|v| v.as_str()).unwrap_or("text");

            let helpers = app.state::<crate::BrowserHelpers>();
            let helper = helpers
                .get(label)
                .ok_or_else(|| format!("browser helper '{}' not found — call spawn_browser_helper first", label))?;
            let port = helper.cdp_port;

            let js_extract = if format == "html" {
                "document.documentElement.outerHTML.slice(0, 400000)"
            } else {
                "(document.body ? document.body.innerText : document.documentElement.textContent || '').slice(0, 200000)"
            };

            cdp_read_content(port, js_extract).await
        }
        "browser_get_url" => {
            // Cheap "where are we" lookup. Same shape as browser_read_content
            // but skips the body-text extract — useful when an agent navigates
            // and just wants to confirm where it landed.
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let port = resolve_helper_port(app, label)?;
            cdp_read_content(port, "''").await
        }
        "browser_evaluate" => {
            // Runs an arbitrary JS expression in the CEF helper page. Useful
            // for "click that button I can see via screenshot", "scroll
            // halfway down", or scraping anything Runtime.evaluate can reach.
            // Returns the CDP `result` object so callers see type info (string
            // vs number vs object) and exceptions verbatim.
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let expression = args["expression"]
                .as_str()
                .ok_or_else(|| "expression is required".to_string())?;
            let await_promise = args
                .get("await_promise")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let port = resolve_helper_port(app, label)?;
            let value = cdp_evaluate(port, expression, await_promise).await?;
            serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
        }
        "browser_screenshot" => {
            // Capture a PNG. Saved to <app data dir>/screenshots/<uuid>.png
            // and the absolute path is returned to the caller. Agents that
            // need the bytes can read the file; we avoid blowing up MCP
            // responses with multi-MB base64 strings.
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let full_page = args
                .get("full_page")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let port = resolve_helper_port(app, label)?;
            let png = cdp_screenshot(port, full_page).await?;
            use tauri::Manager;
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| e.to_string())?
                .join("screenshots");
            std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            let filename = format!("{}.png", uuid::Uuid::new_v4());
            let path = data_dir.join(&filename);
            std::fs::write(&path, &png).map_err(|e| e.to_string())?;
            serde_json::to_string_pretty(&serde_json::json!({
                "label": label,
                "path": path.to_string_lossy(),
                "bytes": png.len(),
                "full_page": full_page,
            }))
            .map_err(|e| e.to_string())
        }
        "browser_click" => {
            // Single click at (x, y) in viewport coordinates. CDP requires
            // separate mousePressed + mouseReleased events to register as a
            // real click. clickCount=1 makes it a normal click (not double).
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let x = args["x"]
                .as_f64()
                .ok_or_else(|| "x is required (number)".to_string())?;
            let y = args["y"]
                .as_f64()
                .ok_or_else(|| "y is required (number)".to_string())?;
            let button = args.get("button").and_then(|v| v.as_str()).unwrap_or("left");
            let port = resolve_helper_port(app, label)?;
            let mut ws = cdp_open_page_ws(port).await?;
            for event_type in &["mousePressed", "mouseReleased"] {
                cdp_call(
                    &mut ws,
                    "Input.dispatchMouseEvent",
                    serde_json::json!({
                        "type": event_type,
                        "x": x,
                        "y": y,
                        "button": button,
                        "clickCount": 1,
                    }),
                    5,
                )
                .await?;
            }
            serde_json::to_string_pretty(&serde_json::json!({
                "label": label,
                "x": x,
                "y": y,
                "button": button,
            }))
            .map_err(|e| e.to_string())
        }
        _ => Err(format!("unknown tool: {}", name)),
    }
}

/// Discover a page target and open a WebSocket to it via the helper's CDP
/// endpoint. Retries the HTTP `/json` enumeration briefly so we tolerate
/// being called immediately after the helper spawned. Returns the live
/// WebSocket stream ready for JSON-RPC traffic.
async fn cdp_open_page_ws(
    port: u16,
) -> Result<
    tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    String,
> {
    let client = reqwest::Client::new();
    let json_url = format!("http://127.0.0.1:{port}/json");
    let mut targets: Vec<serde_json::Value> = Vec::new();
    for attempt in 0..20u32 {
        match client.get(&json_url).send().await {
            Ok(resp) => match resp.json::<Vec<serde_json::Value>>().await {
                Ok(list) => {
                    targets = list;
                    break;
                }
                Err(e) => {
                    if attempt == 19 {
                        return Err(format!("CDP /json returned invalid response: {e}"));
                    }
                }
            },
            Err(e) => {
                if attempt == 19 {
                    return Err(format!(
                        "CDP not reachable on port {port} after 5s ({e}). \
                         Helper may have failed to start."
                    ));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    let page = targets
        .iter()
        .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
        .ok_or_else(|| {
            "no page target available in CDP — helper window may not be loaded yet".to_string()
        })?;
    let ws_url = page
        .get("webSocketDebuggerUrl")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "CDP page target has no webSocketDebuggerUrl".to_string())?;
    let (ws_stream, _resp) = tokio_tungstenite::connect_async(ws_url)
        .await
        .map_err(|e| format!("CDP WebSocket connect failed: {e}"))?;
    Ok(ws_stream)
}

/// Send a JSON-RPC method to an open CDP WebSocket and wait for the matching
/// response. Returns the `result` value on success.
async fn cdp_call(
    ws_stream: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    method: &str,
    params: serde_json::Value,
    timeout_secs: u64,
) -> Result<serde_json::Value, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let request_id = 1u64;
    let request = serde_json::json!({
        "id": request_id,
        "method": method,
        "params": params,
    });
    ws_stream
        .send(Message::Text(request.to_string()))
        .await
        .map_err(|e| format!("CDP WebSocket send failed: {e}"))?;

    let read_fut = async {
        while let Some(msg) = ws_stream.next().await {
            let msg = msg.map_err(|e| format!("CDP WebSocket recv failed: {e}"))?;
            let text = match msg {
                Message::Text(t) => t.to_string(),
                Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
                Message::Close(_) => return Err("CDP WebSocket closed unexpectedly".to_string()),
                _ => continue,
            };
            let parsed: serde_json::Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if parsed.get("id").and_then(|v| v.as_u64()) != Some(request_id) {
                continue;
            }
            if let Some(err) = parsed.get("error") {
                return Err(format!("CDP {method} error: {err}"));
            }
            return Ok(parsed
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null));
        }
        Err(format!("CDP WebSocket stream ended without a response to {method}"))
    };

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), read_fut).await {
        Ok(res) => res,
        Err(_) => Err(format!("CDP {method} timed out after {timeout_secs}s")),
    }
}

/// Navigate an existing CEF helper to a new URL via CDP `Page.navigate`.
/// Public so `commands::navigate_browser_helper` can reuse the CDP plumbing.
pub async fn cdp_navigate(port: u16, url: &str) -> Result<(), String> {
    let mut ws = cdp_open_page_ws(port).await?;
    let _result = cdp_call(
        &mut ws,
        "Page.navigate",
        serde_json::json!({ "url": url }),
        10,
    )
    .await?;
    Ok(())
}

/// Read content from a CEF helper via Chrome DevTools Protocol.
///
/// `port` is the helper's `--remote-debugging-port` value. `js_extract` is a
/// JS expression (without a trailing semicolon) that produces the page-content
/// string we want — e.g. `document.body.innerText.slice(0, 200000)`.
///
/// Returns the helper's reply as a JSON string `{url, title, content}` suitable
/// for handing straight back to the MCP caller.
async fn cdp_read_content(port: u16, js_extract: &str) -> Result<String, String> {
    let mut ws = cdp_open_page_ws(port).await?;
    let expression = format!(
        "JSON.stringify({{url: location.href, title: document.title, content: ({js_extract})}})"
    );
    let result = cdp_call(
        &mut ws,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": false,
        }),
        15,
    )
    .await?;
    // Runtime.evaluate response shape: result.result.value (string due to
    // returnByValue + we wrapped in JSON.stringify).
    result
        .pointer("/result/value")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("CDP response missing /result/value: {}", result))
}

/// Evaluate an arbitrary JS expression in the CEF helper. `await_promise`
/// allows the caller to await async expressions (`fetch(...).then(...)`).
/// Returns the `result.result` object from `Runtime.evaluate` — exception
/// info or value, with type metadata preserved so the MCP caller can
/// distinguish e.g. number vs string.
async fn cdp_evaluate(
    port: u16,
    expression: &str,
    await_promise: bool,
) -> Result<serde_json::Value, String> {
    let mut ws = cdp_open_page_ws(port).await?;
    let result = cdp_call(
        &mut ws,
        "Runtime.evaluate",
        serde_json::json!({
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": await_promise,
        }),
        30,
    )
    .await?;
    Ok(result
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// Capture a PNG screenshot of the helper's current page. Returns the raw
/// PNG bytes (CDP returns base64; we decode for the caller).
async fn cdp_screenshot(port: u16, full_page: bool) -> Result<Vec<u8>, String> {
    let mut ws = cdp_open_page_ws(port).await?;
    let mut params = serde_json::json!({ "format": "png" });
    if full_page {
        params["captureBeyondViewport"] = serde_json::json!(true);
    }
    let result = cdp_call(&mut ws, "Page.captureScreenshot", params, 30).await?;
    let b64 = result
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("CDP screenshot missing /data: {}", result))?;
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("base64 decode of screenshot failed: {e}"))
}

/// Parse one tmux-style key token into the bytes a terminal expects to see.
///
/// Recognized forms (case-sensitive prefixes):
///   * `C-<key>` — Ctrl + key (Ctrl-letters map to 0x01..0x1A)
///   * `M-<key>` — Alt/Meta + key (prepends Esc, then encodes the rest)
///   * Named keys — Up/Down/Left/Right/Enter/Tab/Esc/BSpace/Space/Home/End/
///     PageUp/PageDown/Delete/Insert, F1..F12 (xterm escape sequences)
///   * Single char — sent as a UTF-8 byte sequence (e.g. "a", "9")
///
/// Modifiers compose: `C-M-a` = Esc + Ctrl-A. Returns an error if the token
/// is empty or names an unknown key.
fn parse_key(name: &str) -> Result<Vec<u8>, String> {
    if name.is_empty() {
        return Err("empty key name".to_string());
    }
    // Strip a single leading M- (Alt). Tmux supports nested C-M-x = Esc + C-x.
    if let Some(rest) = name.strip_prefix("M-") {
        let mut out = vec![0x1b];
        out.extend(parse_key(rest)?);
        return Ok(out);
    }
    // Strip a single leading C- (Ctrl).
    if let Some(rest) = name.strip_prefix("C-") {
        // C-Space → NUL (0x00). C-<letter> → 1..26. C-[ → Esc. C-\ → 0x1c. etc.
        if rest.eq_ignore_ascii_case("space") {
            return Ok(vec![0x00]);
        }
        if rest.len() == 1 {
            let ch = rest.chars().next().unwrap();
            let code = match ch {
                'a'..='z' => (ch as u8) - b'a' + 1,
                'A'..='Z' => (ch as u8) - b'A' + 1,
                '[' => 0x1b, // Esc
                '\\' => 0x1c,
                ']' => 0x1d,
                '^' => 0x1e,
                '_' => 0x1f,
                '?' => 0x7f, // sometimes mapped to DEL
                _ => return Err(format!("unsupported Ctrl key 'C-{ch}'")),
            };
            return Ok(vec![code]);
        }
        return Err(format!("Ctrl modifier expects a single character after C-, got 'C-{rest}'"));
    }
    // Named keys (xterm/ANSI sequences).
    let bytes: &[u8] = match name {
        "Up"        => b"\x1b[A",
        "Down"      => b"\x1b[B",
        "Right"     => b"\x1b[C",
        "Left"      => b"\x1b[D",
        "Home"      => b"\x1b[H",
        "End"       => b"\x1b[F",
        "PageUp"    => b"\x1b[5~",
        "PageDown"  => b"\x1b[6~",
        "Insert"    => b"\x1b[2~",
        "Delete"    => b"\x1b[3~",
        "Enter"     => b"\r",
        "Tab"       => b"\t",
        "BTab" | "S-Tab" => b"\x1b[Z",
        "Esc" | "Escape" => b"\x1b",
        "BSpace" | "Backspace" => b"\x7f",
        "Space"     => b" ",
        "F1"  => b"\x1bOP",
        "F2"  => b"\x1bOQ",
        "F3"  => b"\x1bOR",
        "F4"  => b"\x1bOS",
        "F5"  => b"\x1b[15~",
        "F6"  => b"\x1b[17~",
        "F7"  => b"\x1b[18~",
        "F8"  => b"\x1b[19~",
        "F9"  => b"\x1b[20~",
        "F10" => b"\x1b[21~",
        "F11" => b"\x1b[23~",
        "F12" => b"\x1b[24~",
        _ => {
            // Literal single character (e.g. "a", "9", "/"). UTF-8 multi-byte
            // chars also pass through here.
            return Ok(name.as_bytes().to_vec());
        }
    };
    Ok(bytes.to_vec())
}

/// Resolve a CEF-helper label to its CDP port, or a clear error. Used by
/// tools that *require* a CEF helper (screenshot, click, evaluate, etc.) —
/// iframe panes lack the CDP surface to drive these operations.
fn resolve_helper_port(app: &tauri::AppHandle, label: &str) -> Result<u16, String> {
    let helpers = app.state::<crate::BrowserHelpers>();
    helpers
        .get(label)
        .map(|h| h.cdp_port)
        .ok_or_else(|| {
            format!(
                "'{label}' is not a CEF helper. This tool needs a CEF helper \
                 (kind: \"cef_helper\" in browser_list). To get one, call \
                 browser_open with {{\"url\": \"...\", \"kind\": \"cef_helper\"}}, \
                 then retry with the returned label."
            )
        })
}

fn json_rpc_ok(id: serde_json::Value, result: serde_json::Value) -> String {
    serde_json::to_string(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    }))
    .unwrap_or_default()
}

fn json_rpc_error(id: serde_json::Value, code: i32, message: &str) -> String {
    serde_json::to_string(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {"code": code, "message": message}
    }))
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// HTTP response helpers
// ---------------------------------------------------------------------------

async fn write_response(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = status_reason(status);
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

async fn write_response_html(stream: &mut tokio::net::TcpStream, status: u16, body: &str) {
    let reason = status_reason(status);
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

async fn write_response_no_body(stream: &mut tokio::net::TcpStream, status: u16) {
    let reason = status_reason(status);
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Length: 0\r\n\
         Connection: close\r\n\
         \r\n"
    );
    let _ = stream.write_all(response.as_bytes()).await;
}

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    }
}

// ---------------------------------------------------------------------------
// Query string helpers
// ---------------------------------------------------------------------------

fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (url_decode(k), url_decode(v)))
        .collect()
}

fn url_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'+' {
            out.push(' ');
            i += 1;
        } else if b[i] == b'%' && i + 2 < b.len() {
            if let (Ok(hex), Ok(byte)) = (
                std::str::from_utf8(&b[i + 1..i + 3]),
                u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16),
            ) {
                let _ = hex;
                out.push(byte as char);
                i += 3;
                continue;
            }
            out.push(b[i] as char);
            i += 1;
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    out
}
