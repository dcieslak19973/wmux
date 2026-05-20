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
///   POST /mcp                                   — MCP JSON-RPC 2.0 (Streamable HTTP transport)
use crate::SessionManager;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

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
      "method": "POST",
      "path": "/mcp",
      "description": "MCP (Model Context Protocol) server — Streamable HTTP transport, JSON-RPC 2.0. Tools: get_blocks, list_sessions, list_agents, ask_agent, broadcast. Configure in Claude Code with: claude mcp add wmux --transport http --url $WMUX_API_BASE/mcp"
    }
  ],
  "usage_example": "curl \"$WMUX_API_BASE/blocks?session_id=$WMUX_PANE_ID&limit=5\""
}"#;

pub const PORT: u16 = 7766;

pub fn start(manager: SessionManager) {
    tauri::async_runtime::spawn(serve(manager));
}

async fn serve(manager: SessionManager) {
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
                tokio::spawn(handle(stream, manager.clone()));
            }
            Err(e) => {
                log::warn!("HTTP accept error: {e}");
            }
        }
    }
}

async fn handle(mut stream: tokio::net::TcpStream, manager: SessionManager) {
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
        ("GET", "/sessions") => {
            let ids = manager.list().await;
            let body = serde_json::to_string(&ids).unwrap_or_default();
            write_response(&mut stream, 200, &body).await;
        }
        ("POST", "/mcp") => {
            // If \r\n\r\n was absent (truncated request), body_start clamps to n → empty body.
            let body_start = (header_end + 4).min(n);
            let body = String::from_utf8_lossy(&req_bytes[body_start..n]);
            let (status, resp_body) = handle_mcp(&body, &manager).await;
            if status == 204 {
                write_response_no_body(&mut stream, 204).await;
            } else {
                write_response(&mut stream, status, &resp_body).await;
            }
        }
        _ => {
            write_response(&mut stream, 404, r#"{"error":"not found"}"#).await;
        }
    }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC 2.0 handler
// ---------------------------------------------------------------------------

async fn handle_mcp(body: &str, manager: &SessionManager) -> (u16, String) {
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
                    }
                ]
            })
        }
        "tools/call" => {
            let tool_name = params["name"].as_str().unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(serde_json::json!({}));
            match dispatch_tool(tool_name, &args, manager).await {
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
        _ => Err(format!("unknown tool: {}", name)),
    }
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
