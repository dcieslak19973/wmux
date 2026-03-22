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
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

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
    fn cmdline(&self, startup_cwd: Option<&str>) -> Result<String> {
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
                Ok(if args.is_empty() {
                    wsl
                } else {
                    format!("{wsl} {}", args.join(" "))
                })
            }
            ShellTarget::Ssh { host, user, port, identity_file } => {
                Ok(build_ssh_cmdline(host, user.as_deref(), *port, identity_file.as_deref(), None))
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

pub(crate) fn build_ssh_cmdline(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
    identity_file: Option<&str>,
    remote_command: Option<&str>,
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
}

impl Clone for SessionEntry {
    fn clone(&self) -> Self {
        SessionEntry {
            session: self.session.clone(),
            label: self.label.clone(),
            output_buf: self.output_buf.clone(),
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
        let cmdline = target.cmdline(startup_cwd)?;
        let label = target.label();
        let id = Uuid::new_v4().to_string();
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
        let mut env_overrides = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("COLORTERM".to_string(), "truecolor".to_string()),
            ("TMUX".to_string(), tmux_session),
            ("TMUX_PANE".to_string(), tmux_pane.clone()),
            ("WMUX".to_string(), "1".to_string()),
            ("WMUX_PANE_ID".to_string(), id.clone()),
        ];
        if matches!(target, ShellTarget::Wsl { .. }) {
            if let Some(previous_cwd) = previous_cwd.map(str::trim).filter(|value| !value.is_empty()) {
                env_overrides.push(("OLDPWD".to_string(), previous_cwd.to_string()));
                env_overrides.push((
                    "WSLENV".to_string(),
                    append_wslenv_value(std::env::var("WSLENV").ok(), "OLDPWD"),
                ));
            }
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

        // Start a background task that feeds raw output into the capture buffer.
        let output_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let buf_feed = output_buf.clone();
        let mut rx_buf = session.output_tx.subscribe();
        tokio::spawn(async move {
            while let Ok(chunk) = rx_buf.recv().await {
                let mut b = buf_feed.lock().await;
                b.extend_from_slice(&chunk);
                // Keep last 256 KB to bound memory use.
                const MAX: usize = 256 * 1024;
                if b.len() > MAX {
                    let excess = b.len() - MAX;
                    b.drain(..excess);
                }
            }
        });

        self.sessions.lock().await.insert(
            id.clone(),
            SessionEntry { session: Arc::new(session), label: label.clone(), output_buf },
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
        let cmdline = ShellTarget::Local.cmdline(Some("C:\\repo")).unwrap_or_default();
        assert!(!cmdline.is_empty());
        assert!(!cmdline.contains("C:\\repo"));
    }

    #[test]
    fn wsl_target_uses_cd_when_restoring_linux_cwd() {
        let cmdline = ShellTarget::Wsl { distro: Some("Ubuntu".to_string()) }
            .cmdline(Some("/home/dan/my project"))
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
