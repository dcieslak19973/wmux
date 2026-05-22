//! Manages ephemeral port-forward tunnels for the wmux browser pane.
//!
//! SSH  →  `ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote> [user@]host`
//!          (external process; needs key-based auth)
//!
//! WSL  →  in-process Tokio TCP proxy: binds 127.0.0.1:<local> on Windows,
//!          connects to <wsl-vm-ip>:<remote> inside the VM.
//!          No external tools, no WSL localhost-relay, no startup race.
//!
//! Local → URL returned unchanged.
//!
//! Tunnels are keyed by (pane_id, remote_port) and reused across repeated opens.
//! All tunnels for a pane are killed/aborted when that pane closes.

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tokio::io::copy_bidirectional;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::session_manager::{find_exe, ShellTarget};

enum TunnelHandle {
    Process(Child),
    Task(JoinHandle<()>),
}

struct TunnelEntry {
    connect_host: String,
    local_port: u16,
    handle: TunnelHandle,
}

pub struct TunnelManager {
    tunnels: Arc<Mutex<HashMap<(String, u16), TunnelEntry>>>,
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TunnelManager {
    pub fn new() -> Self {
        Self { tunnels: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub async fn resolve(
        &self,
        pane_id: &str,
        target: &ShellTarget,
        url: &str,
    ) -> Result<String, String> {
        let remote_port = parse_port(url)
            .ok_or_else(|| format!("could not parse port from URL: {url}"))?;

        {
            let tunnels = self.tunnels.lock().await;
            if let Some(e) = tunnels.get(&(pane_id.to_string(), remote_port)) {
                return Ok(remap_url(url, &e.connect_host, e.local_port));
            }
        }

        match target {
            ShellTarget::Local => Ok(url.to_string()),

            ShellTarget::Wsl { distro } => {
                let wsl_ip = wsl_vm_ip(distro.as_deref())
                    .ok_or_else(|| "could not determine WSL VM IP".to_string())?;
                let (local_port, task) =
                    spawn_in_process_proxy(wsl_ip.clone(), remote_port).await?;
                self.tunnels.lock().await.insert(
                    (pane_id.to_string(), remote_port),
                    TunnelEntry {
                        connect_host: "127.0.0.1".to_string(),
                        local_port,
                        handle: TunnelHandle::Task(task),
                    },
                );
                // Listener is already bound — no startup delay needed.
                Ok(remap_url(url, "127.0.0.1", local_port))
            }

            ShellTarget::Ssh { host, user, port, identity_file } |
            ShellTarget::RemoteTmux { host, user, port, identity_file, .. } => {
                let local_port = pick_ephemeral_port()?;
                let child = spawn_ssh_tunnel(
                    host, user.as_deref(), *port, identity_file.as_deref(),
                    local_port, remote_port,
                )?;
                // Give ssh time to connect and establish the forward.
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                self.tunnels.lock().await.insert(
                    (pane_id.to_string(), remote_port),
                    TunnelEntry {
                        connect_host: "127.0.0.1".to_string(),
                        local_port,
                        handle: TunnelHandle::Process(child),
                    },
                );
                Ok(remap_url(url, "127.0.0.1", local_port))
            }
        }
    }

    pub async fn kill_for_pane(&self, pane_id: &str) {
        let mut tunnels = self.tunnels.lock().await;
        tunnels.retain(|(pid, _), entry| {
            if pid == pane_id {
                match &mut entry.handle {
                    TunnelHandle::Process(c) => { let _ = c.kill(); }
                    TunnelHandle::Task(t)    => t.abort(),
                }
                false
            } else {
                true
            }
        });
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Bind 127.0.0.1:0, get the assigned port, release the listener.
fn pick_ephemeral_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("failed to pick ephemeral port: {e}"))?;
    Ok(l.local_addr().map_err(|e| e.to_string())?.port())
}

fn parse_port(url: &str) -> Option<u16> {
    let after_scheme = url.split_once("://")?.1;
    let host_part = after_scheme.split('/').next()?;
    host_part.rsplit(':').next()?.parse::<u16>().ok()
}

fn remap_url(url: &str, host: &str, new_port: u16) -> String {
    let scheme_end = url.find("://").map(|i| i + 3).unwrap_or(0);
    let rest = &url[scheme_end..];
    let path_start = rest.find('/').unwrap_or(rest.len());
    let path = &rest[path_start..];
    format!("{}{}:{}{}", &url[..scheme_end], host, new_port, path)
}

/// Spawn an in-process Tokio proxy: listens on 127.0.0.1:<auto> on Windows,
/// forwards each connection to `connect_host:remote_port`.
async fn spawn_in_process_proxy(
    connect_host: String,
    remote_port: u16,
) -> Result<(u16, JoinHandle<()>), String> {
    let listener = TcpListener::bind("127.0.0.1:0").await
        .map_err(|e| format!("failed to bind proxy listener: {e}"))?;
    let local_port = listener.local_addr()
        .map_err(|e| e.to_string())?.port();

    let task = tokio::spawn(async move {
        loop {
            let Ok((mut client, _)) = listener.accept().await else { break };
            let target = format!("{connect_host}:{remote_port}");
            tokio::spawn(async move {
                let Ok(mut remote) = TcpStream::connect(&target).await else { return };
                let _ = copy_bidirectional(&mut client, &mut remote).await;
            });
        }
    });

    Ok((local_port, task))
}

/// Get the WSL2 VM's IP by running `hostname -I` inside WSL.
fn wsl_vm_ip(distro: Option<&str>) -> Option<String> {
    let wsl = find_exe("wsl.exe").unwrap_or_else(|| "wsl.exe".to_string());
    let mut cmd = Command::new(&wsl);
    if let Some(d) = distro {
        cmd.args(["-d", d]);
    }
    cmd.args(["--", "bash", "-c", "hostname -I 2>/dev/null | awk '{print $1}'"]);
    let out = cmd.output().ok()?;
    let ip = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if ip.is_empty() { None } else { Some(ip) }
}

fn spawn_ssh_tunnel(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
    identity_file: Option<&str>,
    local_port: u16,
    remote_port: u16,
) -> Result<Child, String> {
    let ssh = find_exe("ssh.exe").unwrap_or_else(|| "ssh.exe".to_string());
    let mut cmd = Command::new(&ssh);

    if let Some(p) = port {
        cmd.args(["-p", &p.to_string()]);
    }
    if let Some(id) = identity_file {
        let win_path = crate::session_manager::ssh_identity_path(id);
        cmd.args(["-i", &win_path]);
    }

    cmd.args([
        "-N",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-L", &format!("127.0.0.1:{local_port}:127.0.0.1:{remote_port}"),
    ]);

    match user {
        Some(u) => cmd.arg(format!("{u}@{host}")),
        None    => cmd.arg(host),
    };

    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn ssh tunnel: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_remap() {
        assert_eq!(parse_port("http://localhost:3000/path"), Some(3000));
        assert_eq!(parse_port("https://127.0.0.1:8080/"), Some(8080));
        assert_eq!(parse_port("http://localhost/nope"), None);

        assert_eq!(
            remap_url("http://localhost:3000/path?q=1", "127.0.0.1", 54321),
            "http://127.0.0.1:54321/path?q=1"
        );
        assert_eq!(
            remap_url("http://127.0.0.1:8080/", "172.31.0.1", 12345),
            "http://172.31.0.1:12345/"
        );
    }
}
