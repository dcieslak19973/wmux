/// Windows named-pipe IPC server for wmux.
///
/// Listens on `\\.\pipe\wmux-ipc` and accepts one JSON command per connection,
/// returning a JSON response.  This is the backend that the `tmux` shim binary
/// (and any other automation client) talks to.
///
/// Protocol — each message is one JSON line terminated by `\n`:
///
/// Requests:
///   {"cmd":"new-session",   "name":"main", "cols":220, "rows":50}
///   {"cmd":"send-keys",     "name":"main", "keys":"ls -la\r"}
///   {"cmd":"capture-pane",  "name":"main"}
///   {"cmd":"list-sessions"}
///   {"cmd":"kill-session",  "name":"main"}
///   {"cmd":"has-session",   "name":"main"}
///
/// Responses:
///   {"ok":true}
///   {"ok":true, "id":"uuid"}
///   {"ok":true, "output":"..."}
///   {"ok":true, "sessions":["main","other"]}
///   {"ok":false, "error":"session not found"}
use crate::SessionManager;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ServerOptions;

pub const PIPE_NAME: &str = r"\\.\pipe\wmux-ipc";

#[derive(Deserialize)]
#[serde(tag = "cmd")]
enum IpcCmd {
    #[serde(rename = "new-session")]
    NewSession {
        name: String,
        #[serde(default = "default_cols")]
        cols: u16,
        #[serde(default = "default_rows")]
        rows: u16,
    },
    #[serde(rename = "send-keys")]
    SendKeys { name: String, keys: String },
    #[serde(rename = "capture-pane")]
    CapturePane { name: String },
    #[serde(rename = "list-sessions")]
    ListSessions,
    #[serde(rename = "kill-session")]
    KillSession { name: String },
    #[serde(rename = "has-session")]
    HasSession { name: String },
}

fn default_cols() -> u16 { 220 }
fn default_rows() -> u16 { 50 }

#[derive(Serialize)]
struct IpcResp {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sessions: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl IpcResp {
    fn ok() -> Self {
        Self { ok: true, id: None, output: None, sessions: None, error: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, id: None, output: None, sessions: None, error: Some(msg.into()) }
    }
}

/// Start the named-pipe server in a background Tokio task.
pub fn start(manager: SessionManager) {
    tauri::async_runtime::spawn(serve(manager));
}

async fn serve(manager: SessionManager) {
    let mut first = true;
    loop {
        let pipe = if first {
            first = false;
            ServerOptions::new().first_pipe_instance(true).create(PIPE_NAME)
        } else {
            ServerOptions::new().first_pipe_instance(false).create(PIPE_NAME)
        };

        match pipe {
            Ok(server) => {
                if server.connect().await.is_ok() {
                    let mgr = manager.clone();
                    tokio::spawn(handle_client(server, mgr));
                }
            }
            Err(e) => {
                log::warn!("wmux IPC pipe create error: {e}");
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }
    }
}

async fn handle_client(
    pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    manager: SessionManager,
) {
    let (read_half, mut write_half) = tokio::io::split(pipe);
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
        return;
    }

    let resp = match serde_json::from_str::<IpcCmd>(line.trim()) {
        Err(e) => IpcResp::err(format!("parse error: {e}")),
        Ok(cmd) => dispatch(cmd, &manager).await,
    };

    let mut out = serde_json::to_string(&resp).unwrap_or_default();
    out.push('\n');
    let _ = write_half.write_all(out.as_bytes()).await;
}

async fn dispatch(cmd: IpcCmd, manager: &SessionManager) -> IpcResp {
    match cmd {
        IpcCmd::NewSession { name, cols, rows } => {
            match manager
                .create_named(name, crate::ShellTarget::Local, cols, rows)
                .await
            {
                Ok(id) => IpcResp { id: Some(id), ..IpcResp::ok() },
                Err(e) => IpcResp::err(e.to_string()),
            }
        }
        IpcCmd::SendKeys { name, keys } => match manager.find_by_name(&name).await {
            None => IpcResp::err("session not found"),
            Some(session) => match session.write(keys.as_bytes()).await {
                Ok(_) => IpcResp::ok(),
                Err(e) => IpcResp::err(e.to_string()),
            },
        },
        IpcCmd::CapturePane { name } => match manager.capture_output(&name).await {
            None => IpcResp::err("session not found"),
            Some(output) => IpcResp { output: Some(output), ..IpcResp::ok() },
        },
        IpcCmd::ListSessions => IpcResp {
            sessions: Some(manager.list_named().await),
            ..IpcResp::ok()
        },
        IpcCmd::KillSession { name } => {
            manager.close_named(&name).await;
            IpcResp::ok()
        }
        IpcCmd::HasSession { name } => {
            if manager.find_by_name(&name).await.is_some() {
                IpcResp::ok()
            } else {
                IpcResp::err("not found")
            }
        }
    }
}
