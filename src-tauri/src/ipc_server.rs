/// Windows named-pipe IPC server for wmux.
///
/// Listens on `\\.\pipe\wmux-ipc` and accepts one JSON command per connection,
/// returning a JSON response. This is the backend that the `tmux` shim binary
/// and other automation clients talk to.
struct OptionUpdate {
    option: String,
    value: Option<String>,
    target: Option<String>,
    global: bool,
    append: bool,
    unset: bool,
}
use crate::{FrontendControlBridge, SessionManager, ShellTarget};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ServerOptions;
use tokio::sync::{Mutex, Notify};

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
    #[serde(rename = "new-window")]
    NewWindow { target: String },
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
    #[serde(rename = "switch-session")]
    SwitchSession { name: String },
    #[serde(rename = "wait-for")]
    WaitFor { channel: String, action: String },
    #[serde(rename = "set-option")]
    SetOption {
        option: String,
        #[serde(default)]
        value: Option<String>,
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        global: bool,
        #[serde(default)]
        append: bool,
        #[serde(default)]
        unset: bool,
    },
    #[serde(rename = "set-window-option")]
    SetWindowOption {
        option: String,
        #[serde(default)]
        value: Option<String>,
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        global: bool,
        #[serde(default)]
        append: bool,
        #[serde(default)]
        unset: bool,
    },
    #[serde(rename = "list-workspaces")]
    ListWorkspaces,
    #[serde(rename = "create-workspace")]
    CreateWorkspace {
        #[serde(default)]
        name: Option<String>,
    },
    #[serde(rename = "switch-workspace")]
    SwitchWorkspace { workspace_id: String },
    #[serde(rename = "pin-workspace")]
    PinWorkspace { workspace_id: String, pinned: bool },
    #[serde(rename = "rename-workspace")]
    RenameWorkspace { workspace_id: String, name: String },
    #[serde(rename = "close-workspace")]
    CloseWorkspace { workspace_id: String },
    #[serde(rename = "list-tabs")]
    ListTabs {
        #[serde(default)]
        workspace_id: Option<String>,
    },
    #[serde(rename = "create-tab")]
    CreateTab {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        target: Option<ShellTarget>,
    },
    #[serde(rename = "focus-tab")]
    FocusTab { tab_id: String },
    #[serde(rename = "move-tab")]
    MoveTab { tab_id: String, workspace_id: String },
    #[serde(rename = "close-tab")]
    CloseTab { tab_id: String },
    #[serde(rename = "list-panes")]
    ListPanes {
        #[serde(default)]
        tab_id: Option<String>,
    },
    #[serde(rename = "split-pane")]
    SplitPane {
        pane_id: String,
        #[serde(default)]
        direction: Option<String>,
    },
    #[serde(rename = "focus-pane")]
    FocusPane { pane_id: String },
    #[serde(rename = "close-pane")]
    ClosePane { pane_id: String },
    #[serde(rename = "list-windows")]
    ListWindows {
        #[serde(default)]
        workspace_id: Option<String>,
    },
    #[serde(rename = "focus-window")]
    FocusWindow { tab_id: String },
    #[serde(rename = "list-browsers")]
    ListBrowsers {
        #[serde(default)]
        tab_id: Option<String>,
    },
    #[serde(rename = "open-browser")]
    OpenBrowser {
        #[serde(default)]
        tab_id: Option<String>,
        #[serde(default)]
        url: String,
    },
    #[serde(rename = "navigate-browser")]
    NavigateBrowser { label: String, url: String },
    #[serde(rename = "close-browser")]
    CloseBrowser { label: String },
    #[serde(rename = "list-notifications")]
    ListNotifications {
        #[serde(default)]
        tab_id: Option<String>,
    },
    #[serde(rename = "notify")]
    Notify {
        #[serde(default)]
        tab_id: Option<String>,
        title: String,
        #[serde(default)]
        body: String,
    },
    #[serde(rename = "get-layout")]
    GetLayout,
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
    payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl IpcResp {
    fn ok() -> Self {
        Self { ok: true, id: None, output: None, sessions: None, payload: None, error: None }
    }

    fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, id: None, output: None, sessions: None, payload: None, error: Some(msg.into()) }
    }

    fn payload(payload: Value) -> Self {
        Self { payload: Some(payload), ..Self::ok() }
    }
}

#[derive(Clone, Default)]
struct CompatibilityState {
    wait_channels: Arc<Mutex<HashMap<String, Arc<WaitChannel>>>>,
    option_store: Arc<Mutex<OptionStore>>,
}

impl CompatibilityState {
    async fn wait_channel(&self, name: &str) -> Arc<WaitChannel> {
        let mut channels = self.wait_channels.lock().await;
        channels
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(WaitChannel::default()))
            .clone()
    }

    async fn apply_wait_action(&self, channel: &str, action: &str) -> IpcResp {
        let wait_channel = self.wait_channel(channel).await;
        match action {
            "wait" => {
                wait_channel.wait_signal().await;
                IpcResp::ok()
            }
            "signal" => {
                wait_channel.signal().await;
                IpcResp::ok()
            }
            "lock" => {
                wait_channel.lock().await;
                IpcResp::ok()
            }
            "unlock" => {
                wait_channel.unlock().await;
                IpcResp::ok()
            }
            _ => IpcResp::err("unsupported wait-for action"),
        }
    }

    async fn store_option(
        &self,
        scope: OptionScope,
        update: OptionUpdate,
    ) -> IpcResp {
        if !is_supported_option(scope, &update.option) {
            return IpcResp::ok();
        }

        let mut store = self.option_store.lock().await;
        store.set(OptionKey {
            scope,
            option: update.option,
            target: update.target,
            global: update.global,
        }, update.value, update.append, update.unset);
        IpcResp::ok()
    }
}

#[derive(Default)]
struct WaitChannel {
    state: Mutex<WaitChannelState>,
    notify: Notify,
}

#[derive(Default)]
struct WaitChannelState {
    pending_signals: usize,
    locked: bool,
}

impl WaitChannel {
    async fn wait_signal(&self) {
        loop {
            let notified = self.notify.notified();
            {
                let mut state = self.state.lock().await;
                if state.pending_signals > 0 {
                    state.pending_signals -= 1;
                    return;
                }
            }
            notified.await;
        }
    }

    async fn signal(&self) {
        let mut state = self.state.lock().await;
        state.pending_signals += 1;
        drop(state);
        self.notify.notify_waiters();
    }

    async fn lock(&self) {
        loop {
            let notified = self.notify.notified();
            {
                let mut state = self.state.lock().await;
                if !state.locked {
                    state.locked = true;
                    return;
                }
            }
            notified.await;
        }
    }

    async fn unlock(&self) {
        let mut state = self.state.lock().await;
        state.locked = false;
        drop(state);
        self.notify.notify_waiters();
    }
}

#[derive(Clone, Copy, Eq, Hash, PartialEq)]
enum OptionScope {
    Session,
    Window,
}

#[derive(Default)]
struct OptionStore {
    values: HashMap<OptionKey, String>,
}

impl OptionStore {
    fn set(&mut self, key: OptionKey, value: Option<String>, append: bool, unset: bool) {
        if unset {
            self.values.remove(&key);
            return;
        }

        let Some(value) = value else {
            return;
        };

        if append {
            self.values
                .entry(key)
                .and_modify(|current| current.push_str(&value))
                .or_insert(value);
        } else {
            self.values.insert(key, value);
        }
    }
}

#[derive(Clone, Eq, Hash, PartialEq)]
struct OptionKey {
    scope: OptionScope,
    option: String,
    target: Option<String>,
    global: bool,
}

fn is_supported_option(scope: OptionScope, option: &str) -> bool {
    matches!(
        (scope, option),
        (OptionScope::Session, "status")
            | (OptionScope::Session, "status-left")
            | (OptionScope::Session, "status-right")
            | (OptionScope::Session, "status-position")
            | (OptionScope::Session, "status-justify")
            | (OptionScope::Session, "status-style")
            | (OptionScope::Session, "message-style")
            | (OptionScope::Session, "default-terminal")
            | (OptionScope::Session, "terminal-overrides")
            | (OptionScope::Session, "mouse")
            | (OptionScope::Session, "focus-events")
            | (OptionScope::Session, "set-clipboard")
            | (OptionScope::Session, "detach-on-destroy")
            | (OptionScope::Session, "remain-on-exit")
            | (OptionScope::Session, "aggressive-resize")
            | (OptionScope::Session, "base-index")
            | (OptionScope::Session, "pane-base-index")
            | (OptionScope::Session, "renumber-windows")
            | (OptionScope::Window, "synchronize-panes")
            | (OptionScope::Window, "allow-rename")
            | (OptionScope::Window, "automatic-rename")
            | (OptionScope::Window, "pane-border-status")
            | (OptionScope::Window, "pane-border-format")
            | (OptionScope::Window, "pane-border-style")
            | (OptionScope::Window, "pane-active-border-style")
            | (OptionScope::Window, "window-status-format")
            | (OptionScope::Window, "window-status-current-format")
            | (OptionScope::Window, "window-status-separator")
    )
}

pub fn start(app: AppHandle, manager: SessionManager, control: FrontendControlBridge) {
    tauri::async_runtime::spawn(serve(app, manager, control, CompatibilityState::default()));
}

async fn serve(
    app: AppHandle,
    manager: SessionManager,
    control: FrontendControlBridge,
    compatibility: CompatibilityState,
) {
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
                    tokio::spawn(handle_client(
                        server,
                        app.clone(),
                        manager.clone(),
                        control.clone(),
                        compatibility.clone(),
                    ));
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
    app: AppHandle,
    manager: SessionManager,
    control: FrontendControlBridge,
    compatibility: CompatibilityState,
) {
    let (read_half, mut write_half) = tokio::io::split(pipe);
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    if reader.read_line(&mut line).await.unwrap_or(0) == 0 {
        return;
    }

    let resp = match serde_json::from_str::<IpcCmd>(line.trim()) {
        Err(e) => IpcResp::err(format!("parse error: {e}")),
        Ok(cmd) => dispatch(cmd, &app, &manager, &control, &compatibility).await,
    };

    let mut out = serde_json::to_string(&resp).unwrap_or_default();
    out.push('\n');
    let _ = write_half.write_all(out.as_bytes()).await;
}

async fn dispatch(
    cmd: IpcCmd,
    app: &AppHandle,
    manager: &SessionManager,
    control: &FrontendControlBridge,
    compatibility: &CompatibilityState,
) -> IpcResp {
    match cmd {
        IpcCmd::NewSession { name, cols, rows } => {
            match control
                .request(app, "create-workspace", json!({ "name": name }))
                .await
            {
                Ok(payload) => {
                    let workspace_id = payload.get("id").and_then(|value| value.as_str()).map(str::to_owned);
                    if let Some(workspace_id) = workspace_id.clone() {
                        if let Some(pane_id) = resolve_workspace_pane_id(control, app, &workspace_id).await {
                            if let Some(session) = manager.get(&pane_id).await {
                                let _ = session.resize(cols, rows);
                            }
                        }
                    }

                    IpcResp {
                        id: workspace_id,
                        payload: Some(payload),
                        ..IpcResp::ok()
                    }
                }
                Err(err) => IpcResp::err(err),
            }
        }
        IpcCmd::NewWindow { target } => {
            match resolve_workspace_id(control, app, &target).await {
                Some(workspace_id) => frontend(control, app, "create-tab", json!({ "workspaceId": workspace_id })).await,
                None => IpcResp::err("session not found"),
            }
        }
        IpcCmd::SendKeys { name, keys } => match resolve_session(app, manager, control, &name).await {
            None => IpcResp::err("session not found"),
            Some(session) => match session.write(keys.as_bytes()).await {
                Ok(_) => IpcResp::ok(),
                Err(e) => IpcResp::err(e.to_string()),
            },
        },
        IpcCmd::CapturePane { name } => match capture_session_output(app, manager, control, &name).await {
            None => IpcResp::err("session not found"),
            Some(output) => IpcResp { output: Some(output), ..IpcResp::ok() },
        },
        IpcCmd::ListSessions => {
            match control.request(app, "list-workspaces", json!({})).await {
                Ok(payload) => {
                    let mut sessions = payload
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|item| item.get("name").and_then(|value| value.as_str()).map(str::to_owned))
                        .collect::<Vec<_>>();

                    for legacy in manager.list_named().await {
                        if !sessions.iter().any(|name| name == &legacy) {
                            sessions.push(legacy);
                        }
                    }

                    IpcResp { sessions: Some(sessions), payload: Some(payload), ..IpcResp::ok() }
                }
                Err(err) => IpcResp::err(err),
            }
        }
        IpcCmd::KillSession { name } => match resolve_workspace_id(control, app, &name).await {
            Some(workspace_id) => frontend(control, app, "close-workspace", json!({ "workspaceId": workspace_id })).await,
            None => {
                manager.close_named(&name).await;
                IpcResp::ok()
            }
        },
        IpcCmd::HasSession { name } => {
            if resolve_workspace_id(control, app, &name).await.is_some() || resolve_session(app, manager, control, &name).await.is_some() {
                IpcResp::ok()
            } else {
                IpcResp::err("not found")
            }
        }
        IpcCmd::SwitchSession { name } => match resolve_workspace_id(control, app, &name).await {
            Some(workspace_id) => frontend(control, app, "switch-workspace", json!({ "workspaceId": workspace_id })).await,
            None => IpcResp::err("session not found"),
        },
        IpcCmd::WaitFor { channel, action } => compatibility.apply_wait_action(&channel, &action).await,
        IpcCmd::SetOption {
            option,
            value,
            target,
            global,
            append,
            unset,
        } => compatibility
            .store_option(OptionScope::Session, OptionUpdate {
                option,
                value,
                target,
                global,
                append,
                unset,
            })
            .await,
        IpcCmd::SetWindowOption {
            option,
            value,
            target,
            global,
            append,
            unset,
        } => compatibility
            .store_option(OptionScope::Window, OptionUpdate {
                option,
                value,
                target,
                global,
                append,
                unset,
            })
            .await,
        IpcCmd::ListWorkspaces => frontend(control, app, "list-workspaces", json!({})).await,
        IpcCmd::CreateWorkspace { name } => {
            frontend(control, app, "create-workspace", json!({ "name": name })).await
        }
        IpcCmd::SwitchWorkspace { workspace_id } => {
            frontend(control, app, "switch-workspace", json!({ "workspaceId": workspace_id })).await
        }
        IpcCmd::PinWorkspace { workspace_id, pinned } => {
            frontend(control, app, "pin-workspace", json!({ "workspaceId": workspace_id, "pinned": pinned })).await
        }
        IpcCmd::RenameWorkspace { workspace_id, name } => {
            frontend(control, app, "rename-workspace", json!({ "workspaceId": workspace_id, "name": name })).await
        }
        IpcCmd::CloseWorkspace { workspace_id } => {
            frontend(control, app, "close-workspace", json!({ "workspaceId": workspace_id })).await
        }
        IpcCmd::ListTabs { workspace_id } => {
            frontend(control, app, "list-tabs", json!({ "workspaceId": workspace_id })).await
        }
        IpcCmd::CreateTab { workspace_id, target } => {
            frontend(control, app, "create-tab", json!({ "workspaceId": workspace_id, "target": target })).await
        }
        IpcCmd::FocusTab { tab_id } => {
            frontend(control, app, "focus-tab", json!({ "tabId": tab_id })).await
        }
        IpcCmd::MoveTab { tab_id, workspace_id } => {
            frontend(control, app, "move-tab", json!({ "tabId": tab_id, "workspaceId": workspace_id })).await
        }
        IpcCmd::CloseTab { tab_id } => {
            frontend(control, app, "close-tab", json!({ "tabId": tab_id })).await
        }
        IpcCmd::ListPanes { tab_id } => {
            frontend(control, app, "list-panes", json!({ "tabId": tab_id })).await
        }
        IpcCmd::SplitPane { pane_id, direction } => {
            frontend(control, app, "split-pane", json!({ "paneId": pane_id, "direction": direction })).await
        }
        IpcCmd::FocusPane { pane_id } => {
            frontend(control, app, "focus-pane", json!({ "paneId": pane_id })).await
        }
        IpcCmd::ClosePane { pane_id } => {
            frontend(control, app, "close-pane", json!({ "paneId": pane_id })).await
        }
        IpcCmd::ListWindows { workspace_id } => {
            let resolved_workspace_id = match workspace_id {
                Some(target) => resolve_workspace_id(control, app, &target).await,
                None => None,
            };
            frontend(control, app, "list-windows", json!({ "workspaceId": resolved_workspace_id })).await
        }
        IpcCmd::FocusWindow { tab_id } => {
            frontend(control, app, "focus-window", json!({ "tabId": tab_id })).await
        }
        IpcCmd::ListBrowsers { tab_id } => {
            frontend(control, app, "list-browsers", json!({ "tabId": tab_id })).await
        }
        IpcCmd::OpenBrowser { tab_id, url } => {
            frontend(control, app, "open-browser", json!({ "tabId": tab_id, "url": url })).await
        }
        IpcCmd::NavigateBrowser { label, url } => {
            frontend(control, app, "navigate-browser", json!({ "label": label, "url": url })).await
        }
        IpcCmd::CloseBrowser { label } => {
            frontend(control, app, "close-browser", json!({ "label": label })).await
        }
        IpcCmd::ListNotifications { tab_id } => {
            frontend(control, app, "list-notifications", json!({ "tabId": tab_id })).await
        }
        IpcCmd::Notify { tab_id, title, body } => {
            frontend(control, app, "publish-notification", json!({ "tabId": tab_id, "title": title, "body": body })).await
        }
        IpcCmd::GetLayout => frontend(control, app, "get-layout", json!({})).await,
    }
}

async fn resolve_session(
    app: &AppHandle,
    manager: &SessionManager,
    control: &FrontendControlBridge,
    name_or_id: &str,
) -> Option<std::sync::Arc<crate::conpty::ConPtySession>> {
    if let Some(session) = manager.get(name_or_id).await {
        return Some(session);
    }
    if let Some(session) = manager.find_by_name(name_or_id).await {
        return Some(session);
    }
    let pane_id = resolve_workspace_pane_id(control, app, name_or_id).await?;
    manager.get(&pane_id).await
}

async fn capture_session_output(
    app: &AppHandle,
    manager: &SessionManager,
    control: &FrontendControlBridge,
    name_or_id: &str,
) -> Option<String> {
    if let Some(output) = manager.capture_output_by_id(name_or_id).await {
        return Some(output);
    }
    if let Some(output) = manager.capture_output(name_or_id).await {
        return Some(output);
    }

    let pane_id = resolve_workspace_pane_id(control, app, name_or_id).await?;
    manager.capture_output_by_id(&pane_id).await
}

async fn resolve_workspace_id(
    control: &FrontendControlBridge,
    app: &AppHandle,
    target: &str,
) -> Option<String> {
    let payload = control.request(app, "list-workspaces", json!({})).await.ok()?;
    payload
        .as_array()?
        .iter()
        .find(|item| {
            item.get("id").and_then(|value| value.as_str()) == Some(target)
                || item.get("name").and_then(|value| value.as_str()) == Some(target)
        })
        .and_then(|item| item.get("id").and_then(|value| value.as_str()).map(str::to_owned))
}

async fn resolve_workspace_pane_id(
    control: &FrontendControlBridge,
    app: &AppHandle,
    target: &str,
) -> Option<String> {
    let workspace_id = resolve_workspace_id(control, app, target).await?;
    let payload = control.request(app, "list-panes", json!({ "tabId": Value::Null })).await.ok()?;
    let panes = payload.as_array()?;

    panes
        .iter()
        .find(|item| {
            item.get("workspaceId").and_then(|value| value.as_str()) == Some(workspace_id.as_str())
                && item.get("active").and_then(|value| value.as_bool()).unwrap_or(false)
        })
        .or_else(|| {
            panes.iter().find(|item| {
                item.get("workspaceId").and_then(|value| value.as_str()) == Some(workspace_id.as_str())
            })
        })
        .and_then(|item| item.get("paneId").and_then(|value| value.as_str()).map(str::to_owned))
}

async fn frontend(
    control: &FrontendControlBridge,
    app: &AppHandle,
    action: &str,
    payload: Value,
) -> IpcResp {
    match control.request(app, action, payload).await {
        Ok(Value::Null) => IpcResp::ok(),
        Ok(Value::Object(map)) if map.is_empty() => IpcResp::ok(),
        Ok(payload) => IpcResp::payload(payload),
        Err(err) => IpcResp::err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::{IpcCmd, OptionKey, OptionScope, OptionStore, WaitChannel};
    use std::sync::Arc;
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    async fn wait_channel_signal_releases_waiter() {
        let channel = Arc::new(WaitChannel::default());
        let waiter = {
            let channel = channel.clone();
            tokio::spawn(async move {
                channel.wait_signal().await;
            })
        };

        tokio::time::sleep(Duration::from_millis(10)).await;
        channel.signal().await;

        timeout(Duration::from_millis(100), waiter)
            .await
            .expect("waiter should be released")
            .expect("task should complete");
    }

    #[tokio::test]
    async fn wait_channel_unlock_releases_lock_waiter() {
        let channel = Arc::new(WaitChannel::default());
        channel.lock().await;

        let waiter = {
            let channel = channel.clone();
            tokio::spawn(async move {
                channel.lock().await;
            })
        };

        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiter.is_finished());

        channel.unlock().await;

        timeout(Duration::from_millis(100), waiter)
            .await
            .expect("lock waiter should be released")
            .expect("task should complete");
    }

    #[test]
    fn option_store_appends_and_unsets_values() {
        let key = OptionKey {
            scope: OptionScope::Session,
            option: "terminal-overrides".to_string(),
            target: None,
            global: true,
        };
        let mut store = OptionStore::default();

        store.set(key.clone(), Some("xterm".to_string()), false, false);
        store.set(key.clone(), Some(",*:Tc".to_string()), true, false);

        assert_eq!(store.values.get(&key).map(String::as_str), Some("xterm,*:Tc"));

        store.set(key.clone(), None, false, true);

        assert!(!store.values.contains_key(&key));
    }

    #[test]
    fn parses_notify_command_with_optional_tab() {
        let cmd = serde_json::from_str::<IpcCmd>(
            r#"{"cmd":"notify","tab_id":"tab-1","title":"Build finished","body":"ok"}"#,
        )
        .expect("notify command should parse");

        match cmd {
            IpcCmd::Notify { tab_id, title, body } => {
                assert_eq!(tab_id.as_deref(), Some("tab-1"));
                assert_eq!(title, "Build finished");
                assert_eq!(body, "ok");
            }
            _ => panic!("expected notify command"),
        }
    }

    #[test]
    fn parses_create_tab_with_target() {
        let cmd = serde_json::from_str::<IpcCmd>(
            r#"{"cmd":"create-tab","workspace_id":"ws-1","target":{"type":"ssh","host":"example.com","user":"dan","port":22}}"#,
        )
        .expect("create-tab command should parse");

        match cmd {
            IpcCmd::CreateTab {
                workspace_id,
                target: Some(crate::ShellTarget::Ssh { host, user, port, identity_file }),
            } => {
                assert_eq!(workspace_id.as_deref(), Some("ws-1"));
                assert_eq!(host, "example.com");
                assert_eq!(user.as_deref(), Some("dan"));
                assert_eq!(port, Some(22));
                assert_eq!(identity_file, None);
            }
            _ => panic!("expected create-tab ssh command"),
        }
    }

    #[test]
    fn parses_list_tabs_without_workspace() {
        let cmd = serde_json::from_str::<IpcCmd>(r#"{"cmd":"list-tabs"}"#)
            .expect("list-tabs command should parse");

        match cmd {
            IpcCmd::ListTabs { workspace_id } => assert_eq!(workspace_id, None),
            _ => panic!("expected list-tabs command"),
        }
    }

    #[test]
    fn parses_split_pane_with_direction() {
        let cmd = serde_json::from_str::<IpcCmd>(
            r#"{"cmd":"split-pane","pane_id":"pane-1","direction":"h"}"#,
        )
        .expect("split-pane command should parse");

        match cmd {
            IpcCmd::SplitPane { pane_id, direction } => {
                assert_eq!(pane_id, "pane-1");
                assert_eq!(direction.as_deref(), Some("h"));
            }
            _ => panic!("expected split-pane command"),
        }
    }

    #[test]
    fn parses_list_windows_without_workspace() {
        let cmd = serde_json::from_str::<IpcCmd>(r#"{"cmd":"list-windows"}"#)
            .expect("list-windows command should parse");

        match cmd {
            IpcCmd::ListWindows { workspace_id } => assert_eq!(workspace_id, None),
            _ => panic!("expected list-windows command"),
        }
    }

    #[test]
    fn parses_wait_for_command() {
        let cmd = serde_json::from_str::<IpcCmd>(
            r#"{"cmd":"wait-for","channel":"bootstrap","action":"signal"}"#,
        )
        .expect("wait-for command should parse");

        match cmd {
            IpcCmd::WaitFor { channel, action } => {
                assert_eq!(channel, "bootstrap");
                assert_eq!(action, "signal");
            }
            _ => panic!("expected wait-for command"),
        }
    }

    #[test]
    fn parses_set_option_command() {
        let cmd = serde_json::from_str::<IpcCmd>(
            r#"{"cmd":"set-option","option":"status","value":"off","global":true}"#,
        )
        .expect("set-option command should parse");

        match cmd {
            IpcCmd::SetOption { option, value, global, .. } => {
                assert_eq!(option, "status");
                assert_eq!(value.as_deref(), Some("off"));
                assert!(global);
            }
            _ => panic!("expected set-option command"),
        }
    }

    #[test]
    fn rejects_unknown_command() {
        let err = serde_json::from_str::<IpcCmd>(r#"{"cmd":"nope"}"#)
            .err()
            .expect("unknown command should fail");
        assert!(err.to_string().contains("unknown variant"));
    }
}
