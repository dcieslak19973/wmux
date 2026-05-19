/// Session manager: owns a map of active ConPTY sessions.
///
/// Supports three target types for new sessions:
///   - `Local`  — a native Windows shell (PowerShell 7, PowerShell 5, cmd)
///   - `Wsl`    — a WSL distro, via `wsl.exe -d <distro>`
///   - `Ssh`    — a remote host, via the built-in Windows OpenSSH client
///   - `RemoteTmux` — SSH to a remote host and attach/create a named tmux session
use crate::conpty::ConPtySession;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;
use uuid::Uuid;

// ── Block store ───────────────────────────────────────────────────────────────

/// A completed terminal command block captured via OSC 133 shell integration.
#[derive(Debug, Clone, Serialize)]
pub struct TermBlock {
    /// Monotonic sequence number within this session (starts at 0).
    pub id: u32,
    /// Command text from OSC 133;P=k= marker (empty if shell didn't send it).
    pub command: String,
    /// Plain-text output produced between OSC 133;C and OSC 133;D, ANSI-stripped.
    pub output: String,
    /// Process exit code from OSC 133;D;N (None if not reported).
    pub exit_code: Option<i32>,
    /// Unix epoch milliseconds when the command started (OSC 133;C received).
    pub started_ms: u64,
    /// Unix epoch milliseconds when the command finished (OSC 133;D received).
    pub ended_ms: u64,
}

pub struct BlockStore {
    next_id: u32,
    in_block: bool,
    pending_command: String,
    pending_output_raw: Vec<u8>,
    pending_started_ms: u64,
    blocks: VecDeque<TermBlock>,
}

impl BlockStore {
    pub const MAX_BLOCKS: usize = 200;
    const MAX_OUTPUT_BYTES: usize = 512 * 1024;

    pub fn new() -> Self {
        Self {
            next_id: 0,
            in_block: false,
            pending_command: String::new(),
            pending_output_raw: Vec::new(),
            pending_started_ms: 0,
            blocks: VecDeque::new(),
        }
    }

    pub fn on_command_line(&mut self, cmd: &str) {
        // P=k= marker arrives before C in the stream; update even if already in block.
        self.pending_command = cmd.to_string();
    }

    pub fn on_command_start(&mut self) {
        self.in_block = true;
        self.pending_output_raw.clear();
        self.pending_started_ms = now_ms();
        // command text may have been set by a preceding P=k= marker; keep it.
    }

    /// Feed a raw PTY chunk while a block is active. Chunks arriving outside a
    /// block are silently ignored.
    pub fn feed(&mut self, chunk: &[u8]) {
        if !self.in_block {
            return;
        }
        self.pending_output_raw.extend_from_slice(chunk);
        if self.pending_output_raw.len() > Self::MAX_OUTPUT_BYTES {
            let excess = self.pending_output_raw.len() - Self::MAX_OUTPUT_BYTES;
            self.pending_output_raw.drain(..excess);
        }
    }

    /// Finalise the current block and push it to the ring buffer.
    /// Returns the completed block (or None if no block was in progress).
    pub fn on_command_finished(&mut self, exit_code: Option<i32>) -> Option<TermBlock> {
        if !self.in_block {
            return None;
        }
        self.in_block = false;
        let stripped = crate::url_detector::strip_ansi(&self.pending_output_raw);
        let output = String::from_utf8_lossy(&stripped).into_owned();
        let block = TermBlock {
            id: self.next_id,
            command: std::mem::take(&mut self.pending_command),
            output,
            exit_code,
            started_ms: self.pending_started_ms,
            ended_ms: now_ms(),
        };
        self.next_id += 1;
        if self.blocks.len() >= Self::MAX_BLOCKS {
            self.blocks.pop_front();
        }
        self.blocks.push_back(block.clone());
        self.pending_output_raw.clear();
        Some(block)
    }

    /// Most-recent `limit` completed blocks, oldest first.
    pub fn recent(&self, limit: usize) -> Vec<TermBlock> {
        let skip = self.blocks.len().saturating_sub(limit);
        self.blocks.iter().skip(skip).cloned().collect()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── Shell target ─────────────────────────────────────────────────────────────

/// Describes what to launch inside a new ConPTY session.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RemoteTmuxSessionMode {
    Attach,
    Create,
    #[default]
    AttachOrCreate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ShellTarget {
    /// Native Windows shell (PowerShell / cmd).
    Local,
    /// WSL distro by name, e.g. "Ubuntu" or "Ubuntu-22.04".
    /// Pass `None` to use the default distro.
    Wsl { distro: Option<String> },
    /// SSH destination.
    Ssh {
        host: String,
        /// Optional username override (falls back to ssh_config / current user).
        user: Option<String>,
        /// TCP port (default 22).
        port: Option<u16>,
        /// Path to an identity file passed with `-i`.
        identity_file: Option<String>,
    },
    /// SSH destination that auto-attaches to a remote tmux session.
    RemoteTmux {
        host: String,
        /// Optional username override (falls back to ssh_config / current user).
        user: Option<String>,
        /// TCP port (default 22).
        port: Option<u16>,
        /// Path to an identity file passed with `-i`.
        identity_file: Option<String>,
        /// tmux session name to create or attach.
        session_name: String,
        #[serde(default)]
        session_mode: RemoteTmuxSessionMode,
    },
}

impl ShellTarget {
    /// Build the command-line string to pass to `CreateProcessW`.
    /// `ssh_extras` is only used by SSH/RemoteTmux variants; Local and Wsl ignore it.
    fn cmdline(&self, startup_cwd: Option<&str>, ssh_extras: Option<&SshExtras<'_>>) -> Result<String> {
        match self {
            ShellTarget::Local => Ok(default_shell()),
            ShellTarget::Wsl { distro } => {
                let wsl = find_exe("wsl.exe").unwrap_or_else(|| "wsl.exe".to_string());
                let mut args = Vec::new();
                if let Some(cwd) = startup_cwd.map(str::trim).filter(|value| !value.is_empty()) {
                    args.push("--cd".to_string());
                    args.push(quote_windows_cmd_arg(cwd));
                }
                if let Some(d) = distro {
                    args.push("-d".to_string());
                    args.push(quote_windows_cmd_arg(d));
                }
                // Use `script` to allocate a fresh Linux PTY for bash. Without
                // this, bash writes readline echo and the PS1 prompt to
                // /dev/tty, which wsl.exe routes through the Windows console
                // API rather than through ConPTY — so they appear in the dev
                // terminal instead of wmux.  `script` relays all PTY output
                // through its own stdout, which wsl.exe does route through
                // ConPTY, so prompt and echo reach wmux correctly.
                args.push("--".to_string());
                args.push("script".to_string());
                args.push("-q".to_string());
                args.push("-c".to_string());
                args.push("bash".to_string());
                args.push("/dev/null".to_string());
                Ok(if args.is_empty() {
                    wsl
                } else {
                    format!("{wsl} {}", args.join(" "))
                })
            }
            ShellTarget::Ssh { host, user, port, identity_file } => {
                Ok(build_ssh_cmdline(host, user.as_deref(), *port, identity_file.as_deref(), None, ssh_extras))
            }
            ShellTarget::RemoteTmux { host, user, port, identity_file, session_name, session_mode } => {
                let remote_cmd = match session_mode {
                    RemoteTmuxSessionMode::Attach => format!(
                        "tmux attach-session -t {}",
                        quote_remote_shell_arg(session_name),
                    ),
                    RemoteTmuxSessionMode::Create => format!(
                        "tmux new-session -s {}",
                        quote_remote_shell_arg(session_name),
                    ),
                    RemoteTmuxSessionMode::AttachOrCreate => format!(
                        "tmux new-session -A -s {}",
                        quote_remote_shell_arg(session_name),
                    ),
                };
                Ok(build_ssh_cmdline(
                    host,
                    user.as_deref(),
                    *port,
                    identity_file.as_deref(),
                    Some(&remote_cmd),
                    ssh_extras,
                ))
            }
        }
    }

    /// Human-readable tab label.
    pub fn label(&self) -> String {
        match self {
            ShellTarget::Local => "Terminal".to_string(),
            ShellTarget::Wsl { distro } => {
                distro.clone().unwrap_or_else(|| "WSL".to_string())
            }
            ShellTarget::Ssh { host, user, port, .. } => {
                let at = user.as_deref().map(|u| format!("{u}@")).unwrap_or_default();
                let colon = port.map(|p| format!(":{p}")).unwrap_or_default();
                format!("{at}{host}{colon}")
            }
            ShellTarget::RemoteTmux { host, user, port, session_name, session_mode, .. } => {
                let at = user.as_deref().map(|u| format!("{u}@")).unwrap_or_default();
                let colon = port.map(|p| format!(":{p}")).unwrap_or_default();
                let mode = match session_mode {
                    RemoteTmuxSessionMode::Attach => "restore",
                    RemoteTmuxSessionMode::Create => "create",
                    RemoteTmuxSessionMode::AttachOrCreate => "create-or-attach",
                };
                format!("{at}{host}{colon} [tmux:{session_name} · {mode}]")
            }
        }
    }
}

/// Per-session data injected into SSH connections.
pub struct SshExtras<'a> {
    /// wmux pane ID forwarded as WMUX_PANE_ID on the remote.
    pub pane_id: &'a str,
    /// Port for the reverse tunnel on the remote (random per session, 49152-65534).
    pub tunnel_port: u16,
}

/// Derive a stable per-session tunnel port from the UUID pane ID.
/// Uses the dynamic/private port range (49152-65534) to avoid well-known port conflicts.
pub fn pane_id_to_tunnel_port(pane_id: &str) -> u16 {
    let hex: String = pane_id.chars().filter(|c| c.is_ascii_hexdigit()).take(8).collect();
    let n = u32::from_str_radix(&hex, 16).unwrap_or(0);
    49152 + (n % 16383) as u16
}

pub(crate) fn build_ssh_cmdline(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
    identity_file: Option<&str>,
    remote_command: Option<&str>,
    extras: Option<&SshExtras<'_>>,
) -> String {
    let ssh = find_exe("ssh.exe").unwrap_or_else(|| "ssh.exe".to_string());
    let mut cmd = ssh;

    if let Some(p) = port {
        cmd.push_str(&format!(" -p {p}"));
    }
    if let Some(id) = identity_file {
        let win_path = ssh_identity_path(id);
        cmd.push_str(&format!(" -i \"{win_path}\""));
    }

    if let Some(e) = extras {
        // Reverse tunnel: remote:tunnel_port → Windows:7766 (our HTTP API).
        // Binds loopback-only on the remote by default (GatewayPorts no).
        cmd.push_str(&format!(" -R {}:127.0.0.1:{}", e.tunnel_port, crate::http_server::PORT));

        // Forward wmux identity vars to the remote shell via SetEnv (OpenSSH 7.8+).
        // One option per variable — some SSH servers/clients misparse multiple pairs,
        // and the WMUX_API_BASE value contains a colon which can trip up parsers.
        // Servers that don't honour SetEnv silently drop these — connection still works.
        cmd.push_str(" -o \"SetEnv WMUX=1\"");
        cmd.push_str(&format!(" -o \"SetEnv WMUX_PANE_ID={}\"", e.pane_id));
        cmd.push_str(&format!(" -o \"SetEnv WMUX_API_PORT={}\"", e.tunnel_port));
        cmd.push_str(&format!(" -o \"SetEnv WMUX_API_BASE=http://localhost:{}\"", e.tunnel_port));
    }

    cmd.push_str(" -o RequestTTY=force");
    cmd.push_str(" -o SendEnv=COLORTERM");

    match user {
        Some(u) => cmd.push_str(&format!(" {u}@{host}")),
        None => cmd.push_str(&format!(" {host}")),
    }

    if let Some(remote_command) = remote_command {
        cmd.push_str(&format!(" \"{remote_command}\""));
    }

    cmd
}

pub(crate) fn ssh_identity_path(id: &str) -> String {
    if id.starts_with('/') || id.starts_with('~') {
        std::process::Command::new("wsl.exe")
            .args(["wslpath", "-w", id])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| id.to_string())
    } else {
        id.to_string()
    }
}

pub(crate) fn quote_remote_shell_arg(value: &str) -> String {
    format!("'{}'", value.replace('\'', r#"'\''"#))
}

pub(crate) fn quote_windows_cmd_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }
    if !value.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        return value.to_string();
    }

    let mut quoted = String::from("\"");
    let mut backslashes = 0;
    for ch in value.chars() {
        match ch {
            '\\' => backslashes += 1,
            '"' => {
                quoted.push_str(&"\\".repeat(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                if backslashes > 0 {
                    quoted.push_str(&"\\".repeat(backslashes));
                    backslashes = 0;
                }
                quoted.push(ch);
            }
        }
    }
    if backslashes > 0 {
        quoted.push_str(&"\\".repeat(backslashes * 2));
    }
    quoted.push('"');
    quoted
}

fn append_wslenv_value(existing: Option<String>, key: &str) -> String {
    let mut entries: Vec<String> = existing
        .unwrap_or_default()
        .split(':')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect();
    if !entries.iter().any(|entry| entry == key || entry.starts_with(&format!("{key}/"))) {
        entries.push(key.to_string());
    }
    entries.join(":")
}

// ── Session manager ───────────────────────────────────────────────────────────

/// Per-session bookkeeping held by the manager.
struct SessionEntry {
    session: Arc<ConPtySession>,
    label: String,
    /// Rolling raw-byte output buffer (last 256 KB) for `capture-pane` support.
    output_buf: Arc<Mutex<Vec<u8>>>,
    /// OSC 133 block history for agent queries.
    block_store: Arc<Mutex<BlockStore>>,
}

impl Clone for SessionEntry {
    fn clone(&self) -> Self {
        SessionEntry {
            session: self.session.clone(),
            label: self.label.clone(),
            output_buf: self.output_buf.clone(),
            block_store: self.block_store.clone(),
        }
    }
}

#[derive(Clone)]
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, SessionEntry>>>,
    /// Human-readable name → session ID (for tmux-compat IPC).
    named: Arc<Mutex<HashMap<String, String>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            named: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn a new ConPTY session for `target`. Returns `(session_id, tab_label)`.
    pub async fn create(
        &self,
        target: ShellTarget,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        previous_cwd: Option<&str>,
    ) -> Result<(String, String)> {
        let startup_cwd = cwd.map(str::trim).filter(|value| !value.is_empty());
        let id = Uuid::new_v4().to_string();
        let tunnel_port = pane_id_to_tunnel_port(&id);
        let ssh_extras = matches!(target, ShellTarget::Ssh { .. } | ShellTarget::RemoteTmux { .. })
            .then(|| SshExtras { pane_id: &id, tunnel_port });
        let cmdline = target.cmdline(startup_cwd, ssh_extras.as_ref())?;
        let label = target.label();
        let tmux_pane = format!("%{}", &id[..8]);
        let tmux_session = format!("wmux,{},0", &id[..8]);

        // Always inject terminal capability env vars so colors and prompts work
        // for every session type (local, WSL, SSH).
        //
        //  TERM=xterm-256color  — advertises 256-color capability to the shell
        //  COLORTERM=truecolor  — opts into 24-bit RGB (xterm.js supports it)
        //  TMUX / TMUX_PANE     — minimal tmux-presence hints for agent CLIs
        //  WMUX*                — wmux-native escape hatch for future tooling
        //
        // For SSH: OpenSSH reads TERM from the local env and sends it in the
        // PTY-request to the server, so the remote $TERM is set automatically.
        // COLORTERM is forwarded via SendEnv=COLORTERM (when server permits it).
        // SSH sessions point at the per-session reverse-tunnel port (loopback on the remote).
        // WSL sessions use the Windows host IP (the WSL2 gateway) because WSL2's localhost
        // forwarding proxy is unreliable for 127.0.0.1 binds; the gateway IP always works.
        // Local sessions use plain localhost.
        let api_base = if let Some(ref e) = ssh_extras {
            format!("http://localhost:{}", e.tunnel_port)
        } else if matches!(target, ShellTarget::Wsl { .. }) {
            let host_ip = wsl_windows_host_ip().unwrap_or_else(|| "localhost".to_string());
            format!("http://{}:{}", host_ip, crate::http_server::PORT)
        } else {
            format!("http://localhost:{}", crate::http_server::PORT)
        };

        let mut env_overrides = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("COLORTERM".to_string(), "truecolor".to_string()),
            ("TMUX".to_string(), tmux_session),
            ("TMUX_PANE".to_string(), tmux_pane.clone()),
            ("WMUX".to_string(), "1".to_string()),
            ("WMUX_PANE_ID".to_string(), id.clone()),
            ("WMUX_API_BASE".to_string(), api_base),
        ];
        if matches!(target, ShellTarget::Wsl { .. }) {
            // WSLENV tells wsl.exe which Windows env vars to forward into Linux.
            // WMUX must be listed so the shell-integration script sees WMUX=1.
            let mut wslenv_keys = vec!["WMUX", "WMUX_PANE_ID", "WMUX_API_BASE"];
            if let Some(previous_cwd) = previous_cwd.map(str::trim).filter(|value| !value.is_empty()) {
                env_overrides.push(("OLDPWD".to_string(), previous_cwd.to_string()));
                wslenv_keys.push("OLDPWD");
            }
            let wslenv_base = std::env::var("WSLENV").ok();
            let wslenv = wslenv_keys
                .iter()
                .fold(wslenv_base.unwrap_or_default(), |acc, key| {
                    append_wslenv_value(if acc.is_empty() { None } else { Some(acc) }, key)
                });
            env_overrides.push(("WSLENV".to_string(), wslenv));
        }
        let env_override_refs: Vec<(&str, &str)> = env_overrides
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();

        let create_process_cwd = match &target {
            ShellTarget::Local => startup_cwd,
            _ => None,
        };

        let session = ConPtySession::spawn(&cmdline, cols, rows, &env_override_refs, create_process_cwd)?;

        // Background task: feed raw output into the rolling capture buffer.
        let output_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let buf_feed = output_buf.clone();
        let mut rx_buf = session.output_tx.subscribe();
        tokio::spawn(async move {
            while let Ok(chunk) = rx_buf.recv().await {
                let mut b = buf_feed.lock().await;
                b.extend_from_slice(&chunk);
                const MAX: usize = 256 * 1024;
                if b.len() > MAX {
                    let excess = b.len() - MAX;
                    b.drain(..excess);
                }
            }
        });

        let block_store: Arc<Mutex<BlockStore>> = Arc::new(Mutex::new(BlockStore::new()));

        self.sessions.lock().await.insert(
            id.clone(),
            SessionEntry { session: Arc::new(session), label: label.clone(), output_buf, block_store },
        );
        Ok((id, label))
    }

    /// Spawn a named session (for tmux-compat IPC). If a session with the
    /// same name already exists it is reused; otherwise a new one is created.
    pub async fn create_named(
        &self,
        name: String,
        target: ShellTarget,
        cols: u16,
        rows: u16,
    ) -> Result<String> {
        // Reuse existing named session if still alive.
        if let Some(id) = self.named.lock().await.get(&name).cloned() {
            if self.sessions.lock().await.contains_key(&id) {
                return Ok(id);
            }
        }
        let (id, _) = self.create(target, cols, rows, None, None).await?;
        self.named.lock().await.insert(name, id.clone());
        Ok(id)
    }

    pub async fn get(&self, id: &str) -> Option<Arc<ConPtySession>> {
        self.sessions.lock().await.get(id).map(|e| e.session.clone())
    }

    pub async fn get_block_store(&self, id: &str) -> Option<Arc<Mutex<BlockStore>>> {
        self.sessions.lock().await.get(id).map(|e| e.block_store.clone())
    }

    /// Resolve a human name to its `ConPtySession` (for IPC send-keys).
    pub async fn find_by_name(&self, name: &str) -> Option<Arc<ConPtySession>> {
        let id = self.named.lock().await.get(name)?.clone();
        self.get(&id).await
    }

    /// Return the VT-stripped output buffer for a named session (capture-pane).
    pub async fn capture_output(&self, name: &str) -> Option<String> {
        let id = self.named.lock().await.get(name)?.clone();
        self.capture_output_by_id(&id).await
    }

    /// Return the VT-stripped output buffer for a session id.
    pub async fn capture_output_by_id(&self, id: &str) -> Option<String> {
        let entry = self.sessions.lock().await.get(id)?.clone();
        let buf = entry.output_buf.lock().await;
        let stripped = crate::url_detector::strip_ansi(&buf);
        Some(String::from_utf8_lossy(&stripped).to_string())
    }

    /// List named session names (for IPC list-sessions).
    pub async fn list_named(&self) -> Vec<String> {
        self.named.lock().await.keys().cloned().collect()
    }

    /// Kill a named session.
    pub async fn close_named(&self, name: &str) {
        if let Some(id) = self.named.lock().await.remove(name) {
            self.close(&id).await;
        }
    }

    pub async fn close(&self, id: &str) -> bool {
        self.sessions.lock().await.remove(id).is_some()
    }

    pub async fn list(&self) -> Vec<String> {
        self.sessions.lock().await.keys().cloned().collect()
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{append_wslenv_value, quote_windows_cmd_arg, ShellTarget};

    #[test]
    fn local_target_ignores_startup_cwd_in_cmdline() {
        let cmdline = ShellTarget::Local.cmdline(Some("C:\\repo"), None).unwrap_or_default();
        assert!(!cmdline.is_empty());
        assert!(!cmdline.contains("C:\\repo"));
    }

    #[test]
    fn wsl_target_uses_cd_when_restoring_linux_cwd() {
        let cmdline = ShellTarget::Wsl { distro: Some("Ubuntu".to_string()) }
            .cmdline(Some("/home/dan/my project"), None)
            .unwrap_or_default();
        assert!(cmdline.contains("--cd \"/home/dan/my project\""));
        assert!(cmdline.contains("-d Ubuntu"));
    }

    #[test]
    fn quote_windows_cmd_arg_quotes_spaces_and_quotes() {
        assert_eq!(quote_windows_cmd_arg("C:\\Users\\Dan"), "C:\\Users\\Dan");
        assert_eq!(quote_windows_cmd_arg("/home/dan/my project"), "\"/home/dan/my project\"");
        assert_eq!(quote_windows_cmd_arg("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn append_wslenv_value_adds_key_once() {
        assert_eq!(append_wslenv_value(None, "OLDPWD"), "OLDPWD");
        assert_eq!(append_wslenv_value(Some("FOO:BAR".to_string()), "OLDPWD"), "FOO:BAR:OLDPWD");
        assert_eq!(append_wslenv_value(Some("FOO:OLDPWD".to_string()), "OLDPWD"), "FOO:OLDPWD");
    }

    // ── BlockStore ────────────────────────────────────────────────────────────

    use super::BlockStore;

    #[test]
    fn block_store_captures_command_and_output() {
        let mut s = BlockStore::new();
        s.on_command_line("echo hello");
        s.on_command_start();
        s.feed(b"hello\r\n");
        let block = s.on_command_finished(Some(0)).unwrap();
        assert_eq!(block.id, 0);
        assert_eq!(block.command, "echo hello");
        assert!(block.output.contains("hello"), "output: {:?}", block.output);
        assert_eq!(block.exit_code, Some(0));
        assert_eq!(s.recent(10).len(), 1);
    }

    #[test]
    fn block_store_strips_ansi_from_output() {
        let mut s = BlockStore::new();
        s.on_command_start();
        s.feed(b"\x1b[32mgreen text\x1b[0m\r\nline2\r\n");
        let block = s.on_command_finished(Some(0)).unwrap();
        assert!(!block.output.contains('\x1b'), "ANSI not stripped: {:?}", block.output);
        assert!(block.output.contains("green text"));
        assert!(block.output.contains("line2"));
    }

    #[test]
    fn block_store_ignores_feed_outside_block() {
        let mut s = BlockStore::new();
        s.feed(b"noise before any block");
        s.on_command_start();
        s.feed(b"real output\r\n");
        let block = s.on_command_finished(Some(0)).unwrap();
        assert!(!block.output.contains("noise"));
        assert!(block.output.contains("real output"));
    }

    #[test]
    fn block_store_command_line_before_start_is_kept() {
        let mut s = BlockStore::new();
        s.on_command_line("git status");   // P=k= arrives before C in stream
        s.on_command_start();
        s.feed(b"nothing to commit\r\n");
        let block = s.on_command_finished(Some(0)).unwrap();
        assert_eq!(block.command, "git status");
    }

    #[test]
    fn block_store_no_block_in_progress_returns_none_on_finish() {
        let mut s = BlockStore::new();
        assert!(s.on_command_finished(Some(0)).is_none());
    }

    #[test]
    fn block_store_recent_returns_oldest_first_up_to_limit() {
        let mut s = BlockStore::new();
        for i in 0u8..5 {
            s.on_command_start();
            s.feed(&[b'0' + i, b'\n']);
            s.on_command_finished(Some(i as i32));
        }
        let r = s.recent(3);
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].id, 2);
        assert_eq!(r[2].id, 4);
        assert_eq!(r[2].exit_code, Some(4));
    }

    #[test]
    fn block_store_ring_buffer_evicts_oldest() {
        let mut s = BlockStore::new();
        for _ in 0..(BlockStore::MAX_BLOCKS + 5) {
            s.on_command_start();
            s.feed(b"x");
            s.on_command_finished(Some(0));
        }
        let r = s.recent(BlockStore::MAX_BLOCKS + 100);
        assert_eq!(r.len(), BlockStore::MAX_BLOCKS);
        // The oldest visible block should have id = 5 (first 5 were evicted).
        assert_eq!(r[0].id as usize, 5);
    }
}

// ── WSL host IP ──────────────────────────────────────────────────────────────

/// Return the Windows host IP as seen from inside WSL2 (the default-route gateway).
/// WSL2's localhost forwarding is unreliable for 127.0.0.1 binds, so callers that
/// need to reach a Windows service from within WSL should use this IP instead.
pub fn wsl_windows_host_ip() -> Option<String> {
    // `wsl -- ip route show default` prints e.g. "default via 172.30.32.1 dev eth0"
    let output = std::process::Command::new("wsl.exe")
        .args(["--", "ip", "route", "show", "default"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    // Extract the IP after "via "
    stdout
        .lines()
        .find(|l| l.contains("default"))
        .and_then(|l| l.split_whitespace().nth(2))
        .map(str::to_string)
}

// ── WSL distro enumeration ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct WslDistro {
    pub name: String,
    pub is_default: bool,
}

/// Enumerate installed WSL distros by running `wsl.exe --list --quiet`.
///
/// The WSL CLI outputs UTF-16LE (with BOM) even when redirected; we decode
/// it manually so we get the correct distro names.
pub fn list_wsl_distros() -> Vec<WslDistro> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let Ok(mut child) = Command::new("wsl.exe")
        .args(["--list", "--verbose"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return Vec::new();
    };

    let mut raw: Vec<u8> = Vec::new();
    if child
        .stdout
        .take()
        .map(|mut s| s.read_to_end(&mut raw))
        .is_none()
    {
        return Vec::new();
    }
    let _ = child.wait();

    // `wsl --list --verbose` outputs UTF-16LE with BOM.
    // Decode to String so we can parse lines normally.
    let text = decode_utf16le(&raw);

    let mut distros: Vec<WslDistro> = Vec::new();
    // First non-header line that starts with '*' is the default distro.
    // Format:  `  NAME   STATE   VERSION`  or  `* NAME   STATE   VERSION`
    let mut header_skipped = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !header_skipped {
            // First non-empty line is the column header.
            header_skipped = true;
            continue;
        }
        let is_default = trimmed.starts_with('*');
        // Strip leading '*' or ' ', then take the first whitespace-separated token.
        let rest = trimmed.trim_start_matches('*').trim();
        let name = rest.split_whitespace().next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        distros.push(WslDistro { name, is_default });
    }

    // Default distro first, then alphabetical.
    distros.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.cmp(&b.name)));
    distros
}

/// Decode a byte slice as UTF-16LE, stripping an optional BOM (FF FE).
fn decode_utf16le(raw: &[u8]) -> String {
    let bytes = if raw.starts_with(&[0xFF, 0xFE]) {
        &raw[2..]
    } else {
        raw
    };

    // Collect u16 code units (little-endian pairs).
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .collect();

    String::from_utf16_lossy(&units)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn default_shell() -> String {
    let candidates = [
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Windows\System32\cmd.exe",
    ];
    candidates
        .iter()
        .find(|p| std::path::Path::new(p).exists())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "cmd.exe".to_string())
}

/// Find an executable, checking known System32 locations first to avoid PATH-hijacking.
pub(crate) fn find_exe(name: &str) -> Option<String> {
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    let system32 = std::path::PathBuf::from(&system_root).join("System32");

    // Direct System32 lookup (covers wsl.exe, cmd.exe, etc.)
    let candidate = system32.join(name);
    if candidate.exists() {
        return Some(candidate.to_string_lossy().into_owned());
    }

    // Windows bundles OpenSSH at System32\OpenSSH\ssh.exe
    let openssh_candidate = system32.join("OpenSSH").join(name);
    if openssh_candidate.exists() {
        return Some(openssh_candidate.to_string_lossy().into_owned());
    }

    // Fall back to PATH
    std::env::split_paths(&std::env::var("PATH").unwrap_or_default())
        .map(|dir| dir.join(name))
        .find(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
}
