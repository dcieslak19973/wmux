/// ConPTY-based pseudoterminal for Windows.
///
/// Uses the Windows Pseudoconsole API (ConPTY) introduced in Windows 10 1809.
/// Each `ConPtySession` holds a pseudoconsole handle, the shell process, and
/// two anonymous pipe pairs for I/O.
use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use windows::Win32::
{
    Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
    Security::SECURITY_ATTRIBUTES,
    Storage::FileSystem::{ReadFile, WriteFile},
    System::{
        Console::{
            ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD,
            HPCON,
        },
        Pipes::CreatePipe,
        Threading::{
            CreateProcessW, DeleteProcThreadAttributeList,
            InitializeProcThreadAttributeList, UpdateProcThreadAttribute,
            WaitForSingleObject, EXTENDED_STARTUPINFO_PRESENT,
            PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            STARTUPINFOEXW,
        },
    },
};

/// Safe wrapper around a raw Windows HANDLE that closes on drop.
struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe { let _ = CloseHandle(self.0); }
        }
    }
}

unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

/// A live pseudoterminal session backed by ConPTY.
pub struct ConPtySession {
    /// Write end of the pipe that feeds data INTO the pseudoconsole (keyboard input).
    write_pipe: Arc<Mutex<OwnedHandle>>,
    /// The pseudoconsole handle.
    hpc: HPCON,
    /// Process info for the child shell.
    proc_info: PROCESS_INFORMATION,
    /// Broadcast channel — readers subscribe to receive terminal output bytes.
    pub output_tx: broadcast::Sender<Vec<u8>>,
    /// A subscriber created at session startup so all output is buffered until
    /// the frontend calls `start_session_stream`. Taken (set to None) exactly once.
    pub initial_rx: tokio::sync::Mutex<Option<broadcast::Receiver<Vec<u8>>>>,
}

// HPCON and PROCESS_INFORMATION contain raw handles; we manage lifetime manually.
unsafe impl Send for ConPtySession {}
unsafe impl Sync for ConPtySession {}

impl ConPtySession {
    /// Spawn a new ConPTY session.
    ///
    /// `cmdline` is the full command line string passed verbatim to
    /// `CreateProcessW` — it may be a bare executable or include arguments,
    /// e.g. `"ssh.exe user@host"` or `"wsl.exe -d Ubuntu"`.
    ///
    /// `extra_env` is a list of `("KEY", "VALUE")` pairs that are **merged on
    /// top of** the inherited parent environment before the child starts.
    /// Use this to inject `TERM`, `COLORTERM`, etc.
    pub fn spawn(
        cmdline: &str,
        cols: u16,
        rows: u16,
        extra_env: &[(&str, &str)],
        cwd: Option<&str>,
    ) -> Result<Self> {
        unsafe {
            // ── Create two pipe pairs ────────────────────────────────────────
            // Pipe 1: our write end → ConPTY read end  (keyboard input)
            // Pipe 2: ConPTY write end → our read end  (terminal output)
            let (pipe_pty_in_read, pipe_pty_in_write) = create_pipe()?;
            let (pipe_pty_out_read, pipe_pty_out_write) = create_pipe()?;

            // ── Create the Pseudoconsole ─────────────────────────────────────
            let size = COORD { X: cols as i16, Y: rows as i16 };
            let hpc = CreatePseudoConsole(size, pipe_pty_in_read.0, pipe_pty_out_write.0, 0)
                .context("CreatePseudoConsole failed")?;

            // The ConPTY has taken ownership of the pipe ends passed to it;
            // close our copies so reads/writes behave correctly on EOF.
            drop(pipe_pty_in_read);
            drop(pipe_pty_out_write);

            // ── Build STARTUPINFOEX with PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE ─
            let mut attr_list_size: usize = 0;
            // First call: query required size.
            let _ = InitializeProcThreadAttributeList(
                windows::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST::default(),
                1,
                0,
                &mut attr_list_size,
            );

            let mut attr_list_buf: Vec<u8> = vec![0u8; attr_list_size];
            let attr_list = windows::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST(
                attr_list_buf.as_mut_ptr() as *mut _,
            );

            InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_list_size)
                .context("InitializeProcThreadAttributeList failed")?;

            UpdateProcThreadAttribute(
                attr_list,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                Some(hpc.0 as *const _),
                std::mem::size_of::<HPCON>(),
                None,
                None,
            )
            .context("UpdateProcThreadAttribute failed")?;

            let mut siex: STARTUPINFOEXW = std::mem::zeroed();
            siex.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            siex.lpAttributeList = attr_list;

            // ── Build environment block ──────────────────────────────────────
            // Start from the current process environment, then overlay
            // extra_env so callers can inject TERM, COLORTERM, etc.
            let env_block_opt = if extra_env.is_empty() {
                None // inherit parent env verbatim — no allocation needed
            } else {
                Some(build_env_block(extra_env))
            };
            let lp_env = env_block_opt
                .as_ref()
                .map(|v| v.as_ptr() as *const std::ffi::c_void);

            // CREATE_UNICODE_ENVIRONMENT (0x400) must be set when passing a
            // UTF-16 env block.
            use windows::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;
            let creation_flags = EXTENDED_STARTUPINFO_PRESENT
                | if lp_env.is_some() { CREATE_UNICODE_ENVIRONMENT } else {
                    windows::Win32::System::Threading::PROCESS_CREATION_FLAGS(0)
                };

            // ── Spawn the shell process ──────────────────────────────────────
            let mut cmdline_w: Vec<u16> =
                cmdline.encode_utf16().chain(std::iter::once(0)).collect();
            let mut cwd_w = cwd.map(|value| {
                value.encode_utf16()
                    .chain(std::iter::once(0))
                    .collect::<Vec<u16>>()
            });
            let mut proc_info: PROCESS_INFORMATION = std::mem::zeroed();

            CreateProcessW(
                None,
                windows::core::PWSTR(cmdline_w.as_mut_ptr()),
                None,
                None,
                false,
                creation_flags,
                lp_env,
                cwd_w
                    .as_mut()
                    .map(|value| windows::core::PCWSTR(value.as_ptr()))
                    .unwrap_or(windows::core::PCWSTR::null()),
                &siex.StartupInfo as *const _ as *mut _,
                &mut proc_info,
            )
            .context("CreateProcessW failed — is the shell path valid?")?;

            DeleteProcThreadAttributeList(attr_list);

            // ── Start output reader task ─────────────────────────────────────
            let (output_tx, _) = broadcast::channel::<Vec<u8>>(128);
            let tx_clone = output_tx.clone();
            // Transmit the raw handle value as isize to cross the thread
            // boundary; HANDLE is a newtype over *mut c_void which isn't Send.
            let raw_handle = pipe_pty_out_read.0.0 as isize;

            // Spawn a blocking thread; ReadFile blocks until data is available.
            std::thread::spawn(move || {
                let read_handle = HANDLE(raw_handle as *mut _);
                let mut buf = vec![0u8; 4096];
                loop {
                    let mut bytes_read: u32 = 0;
                    let ok =
                        ReadFile(read_handle, Some(&mut buf), Some(&mut bytes_read), None).is_ok();
                    if !ok || bytes_read == 0 {
                        break;
                    }
                    let chunk = buf[..bytes_read as usize].to_vec();
                    // Ignore send errors (no subscribers yet is fine).
                    let _ = tx_clone.send(chunk);
                }
                // Close handle when done
                let _ = CloseHandle(read_handle);
            });

            // Transfer ownership of the read handle to the thread above;
            // prevent double-close by forgetting the OwnedHandle wrapper.
            std::mem::forget(pipe_pty_out_read);

            // Subscribe before returning so all output is buffered for late consumer.
            let initial_rx = tokio::sync::Mutex::new(Some(output_tx.subscribe()));

            Ok(Self {
                write_pipe: Arc::new(Mutex::new(pipe_pty_in_write)),
                hpc,
                proc_info,
                output_tx,
                initial_rx,
            })
        }
    }

    /// Write bytes (keyboard input) into the pseudoterminal.
    pub async fn write(&self, data: &[u8]) -> Result<()> {
        let guard = self.write_pipe.lock().await;
        unsafe {
            let mut written: u32 = 0;
            WriteFile(guard.0, Some(data), Some(&mut written), None)
                .context("WriteFile to ConPTY pipe failed")?;
        }
        Ok(())
    }

    /// Resize the pseudoconsole viewport.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let size = COORD { X: cols as i16, Y: rows as i16 };
        unsafe {
            ResizePseudoConsole(self.hpc, size).context("ResizePseudoConsole failed")?;
        }
        Ok(())
    }

    /// Check whether the child process has exited.
    pub fn is_alive(&self) -> bool {
        unsafe {
            WaitForSingleObject(self.proc_info.hProcess, 0).0 != 0
        }
    }
}

impl Drop for ConPtySession {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.hpc);
            let _ = CloseHandle(self.proc_info.hProcess);
            let _ = CloseHandle(self.proc_info.hThread);
        }
    }
}

/// Helper: create an anonymous pipe and return (read_end, write_end).
unsafe fn create_pipe() -> Result<(OwnedHandle, OwnedHandle)> {
    let mut read = INVALID_HANDLE_VALUE;
    let mut write = INVALID_HANDLE_VALUE;
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: std::ptr::null_mut(),
        bInheritHandle: false.into(),
    };
    CreatePipe(&mut read, &mut write, Some(&sa), 0).context("CreatePipe failed")?;
    Ok((OwnedHandle(read), OwnedHandle(write)))
}

/// Build a UTF-16 environment block for `CreateProcessW`.
///
/// Starts from the current process environment, then overlays `overrides` so
/// callers can add/replace specific variables (e.g. TERM, COLORTERM).
///
/// Format: `KEY=VALUE\0 KEY=VALUE\0 \0` (double-null terminated), UTF-16LE.
fn build_env_block(overrides: &[(&str, &str)]) -> Vec<u16> {
    use std::collections::{hash_map::Entry, HashMap};

    // Collect current environment into an ordered map (case-insensitive keys
    // on Windows — we preserve the original casing of the first occurrence).
    let mut env: HashMap<String, (String, String)> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for (key, val) in std::env::vars() {
        let upper = key.to_uppercase();
        match env.entry(upper.clone()) {
            Entry::Vacant(entry) => {
                order.push(upper);
                entry.insert((key, val));
            }
            Entry::Occupied(_) => {}
        }
    }

    // Apply overrides (add or replace)
    for &(k, v) in overrides {
        let upper = k.to_uppercase();
        if let Entry::Vacant(entry) = env.entry(upper.clone()) {
            order.push(upper);
            entry.insert((k.to_string(), v.to_string()));
        } else {
            env.insert(upper, (k.to_string(), v.to_string()));
        }
    }

    // Encode as block of null-terminated UTF-16 strings, double-null at end
    let mut block: Vec<u16> = Vec::new();
    for key_upper in &order {
        if let Some((key, val)) = env.get(key_upper) {
            let entry = format!("{key}={val}");
            block.extend(entry.encode_utf16());
            block.push(0); // null terminator for this entry
        }
    }
    block.push(0); // final null = end of block
    block
}
