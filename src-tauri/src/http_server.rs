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
    "description": "MCP (Model Context Protocol) server — Streamable HTTP transport, JSON-RPC 2.0. Tools: get_blocks, list_sessions, list_agents, ask_agent, broadcast, workbook_create, workbook_update, workbook_delete, workbook_open, workbook_list, workbook_get, workbook_add_chart, workbook_update_chart, workbook_remove_chart, workbook_reorder_charts, browser_list, browser_open, browser_navigate, browser_back, browser_forward, browser_close, browser_read_content. Configure in Claude Code with: claude mcp add --transport http wmux $WMUX_API_BASE/mcp"
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
                        "description": "List all open browser panes in wmux. Optionally filter by tab. Returns label, tabId, url, history, historyIndex, and active flag for each pane. NOTE: This lists iframe-based browser panes only. For out-of-process CEF helper windows (driveable via Chrome DevTools Protocol), use cef_helper_list instead.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "tab_id": { "type": "string", "description": "Optional tab ID to filter browser panes. Omit to list all." }
                            }
                        }
                    },
                    {
                        "name": "cef_helper_list",
                        "description": "List the out-of-process CEF browser helpers currently registered. Each helper is a standalone Chromium window launched by the wmux frontend (via the 'CEF' button on a browser pane) or by the spike spawn path. Helpers are driveable via Chrome DevTools Protocol on their advertised cdp_port; use the label with browser_read_content to extract page text/HTML. Helpers do NOT appear in browser_list output (that tool lists iframe panes).",
                        "inputSchema": {
                            "type": "object",
                            "properties": {}
                        }
                    },
                    {
                        "name": "browser_open",
                        "description": "Open a URL in a new browser split pane in wmux. Returns the new pane's label and state.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "url": { "type": "string", "description": "URL to open." },
                                "tab_id": { "type": "string", "description": "Tab to open the browser pane in. Defaults to the active tab." }
                            },
                            "required": ["url"]
                        }
                    },
                    {
                        "name": "browser_navigate",
                        "description": "Navigate an existing browser pane to a new URL. Returns the updated pane state.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser pane label (from browser_list or browser_open)." },
                                "url": { "type": "string", "description": "URL to navigate to." }
                            },
                            "required": ["label", "url"]
                        }
                    },
                    {
                        "name": "browser_back",
                        "description": "Navigate back in a browser pane's history.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser pane label." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_forward",
                        "description": "Navigate forward in a browser pane's history.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser pane label." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_close",
                        "description": "Close a browser pane in wmux.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "Browser pane label to close." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_read_content",
                        "description": "Read the visible text (or raw HTML) of the page currently loaded in a browser pane. Returns { url, title, content }. On Windows, uses WebView2's ExecuteScript channel — CSP-immune, works on any page including HTTPS sites.",
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
                        "description": "Return the current URL + title of a CEF helper page. Cheap 'where am I' lookup that skips body-text extraction. Useful for confirming where a navigate landed.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "CEF helper label (from cef_helper_list)." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_evaluate",
                        "description": "Run an arbitrary JS expression inside a CEF helper page via Chrome DevTools Protocol Runtime.evaluate. Returns the raw CDP result object — preserves type metadata (string vs number vs object) and exception details. Set await_promise=true for async expressions like `await fetch(...)`.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "CEF helper label (from cef_helper_list)." },
                                "expression": { "type": "string", "description": "JS expression to evaluate. Last expression's value is returned." },
                                "await_promise": { "type": "boolean", "description": "If true, await a Promise returned by the expression. Default false." }
                            },
                            "required": ["label", "expression"]
                        }
                    },
                    {
                        "name": "browser_screenshot",
                        "description": "Capture a PNG screenshot of the current CEF helper page via CDP Page.captureScreenshot. Writes the file to <app data dir>/screenshots/<uuid>.png and returns { label, path, bytes, full_page }. Set full_page=true to capture beyond the viewport.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "CEF helper label (from cef_helper_list)." },
                                "full_page": { "type": "boolean", "description": "Capture the full scrollable page (default: viewport only)." }
                            },
                            "required": ["label"]
                        }
                    },
                    {
                        "name": "browser_click",
                        "description": "Dispatch a mouse click at (x, y) viewport coordinates in a CEF helper page via CDP Input.dispatchMouseEvent. Sends both mousePressed and mouseReleased so the page registers a real click (links, buttons, form controls all activate). Use browser_screenshot first to find coordinates.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string", "description": "CEF helper label (from cef_helper_list)." },
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

async fn dispatch_tool(
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
            let tab_id = args.get("tab_id").and_then(|v| v.as_str());
            let payload = match tab_id {
                Some(id) => serde_json::json!({ "tabId": id }),
                None => serde_json::Value::Null,
            };
            let result = bridge.request(app, "list-browsers", payload).await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "cef_helper_list" => {
            // Read straight from BrowserHelpers state — no IPC to JS needed.
            let helpers = app.state::<crate::BrowserHelpers>();
            let entries = helpers.snapshot();
            serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())
        }
        "browser_open" => {
            let url = args["url"]
                .as_str()
                .ok_or_else(|| "url is required".to_string())?;
            let mut payload = serde_json::json!({ "url": url });
            if let Some(tab_id) = args.get("tab_id").and_then(|v| v.as_str()) {
                payload["tabId"] = serde_json::json!(tab_id);
            }
            let result = bridge.request(app, "open-browser", payload).await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
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
            let result = bridge
                .request(app, "browser-back", serde_json::json!({ "label": label }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "browser_forward" => {
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let result = bridge
                .request(app, "browser-forward", serde_json::json!({ "label": label }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
        }
        "browser_close" => {
            let label = args["label"]
                .as_str()
                .ok_or_else(|| "label is required".to_string())?;
            let result = bridge
                .request(app, "close-browser", serde_json::json!({ "label": label }))
                .await?;
            serde_json::to_string_pretty(&result).map_err(|e| e.to_string())
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

/// Resolve a CEF-helper label to its CDP port, or a clear error.
fn resolve_helper_port(app: &tauri::AppHandle, label: &str) -> Result<u16, String> {
    let helpers = app.state::<crate::BrowserHelpers>();
    helpers
        .get(label)
        .map(|h| h.cdp_port)
        .ok_or_else(|| format!("CEF helper '{}' not found — call cef_helper_list to see available helpers", label))
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
