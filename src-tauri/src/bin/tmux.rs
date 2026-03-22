//! wmux `tmux` shim — a drop-in `tmux.exe` replacement that routes commands
//! to the running wmux process via the named pipe `\\.\pipe\wmux-ipc`.
//!
//! Place this binary in a directory that appears on PATH *before* any real
//! `tmux` installation.  Clients such as Claude Code that detect `tmux` and
//! use it to manage terminal sessions will transparently drive wmux panes.
//!
//! Supported tmux commands:
//!   new-session   [-d] [-s name] [-x cols] [-y rows]
//!   send-keys     -t name [keys...] [Enter|Space|Escape|Tab|BSpace|C-c|C-d|C-z]
//!   capture-pane  [-p] -t name
//!   list-sessions
//!   kill-session  -t name
//!   has-session   -t name        (exit 0 = exists, exit 1 = not found)
//!   new-window    -t name        (treated as new-session with same name)

use std::io::{BufRead, BufReader, Write};

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    if args.is_empty() {
        // tmux with no args usually starts a server/session; just succeed silently.
        std::process::exit(0);
    }

    // Strip flags that appear before the subcommand (e.g. `tmux -u new-session`).
    let mut idx = 0;
    while idx < args.len() && args[idx].starts_with('-') && !is_subcommand(&args[idx]) {
        idx += 1;
    }

    if idx >= args.len() {
        std::process::exit(0);
    }

    let sub = args[idx].as_str();
    let rest = &args[idx + 1..];

    let cmd_json = match sub {
        "new-session" | "new-window" => parse_new_session(rest),
        "send-keys"   => parse_send_keys(rest),
        "capture-pane" => parse_capture_pane(rest),
        "list-sessions" | "ls" => r#"{"cmd":"list-sessions"}"#.to_string(),
        "kill-session" => parse_kill_session(rest),
        "has-session"  => parse_has_session(rest),
        // Gracefully ignore commands we don't implement.
        _ => std::process::exit(0),
    };

    match send_ipc(&cmd_json) {
        Ok(resp_json) => handle_response(sub, &resp_json),
        Err(e) => {
            // wmux is not running — silently exit.
            log::debug!("wmux IPC unavailable: {e}");
            std::process::exit(1);
        }
    }
}

fn is_subcommand(s: &str) -> bool {
    matches!(
        s,
        "new-session" | "new-window" | "send-keys" | "capture-pane"
            | "list-sessions" | "ls" | "kill-session" | "has-session"
    )
}

// ── Response handler ──────────────────────────────────────────────────────────

fn handle_response(sub: &str, resp_json: &str) {
    let v: serde_json::Value = serde_json::from_str(resp_json).unwrap_or_default();
    let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);

    if sub == "has-session" {
        std::process::exit(if ok { 0 } else { 1 });
    }

    if let Some(output) = v.get("output").and_then(|x| x.as_str()) {
        print!("{output}");
    }

    if let Some(sessions) = v.get("sessions").and_then(|x| x.as_array()) {
        for s in sessions {
            if let Some(name) = s.as_str() {
                // Print in tmux list-sessions format.
                println!("{name}: 1 windows (created 0) [220x50]");
            }
        }
    }

    if !ok {
        std::process::exit(1);
    }
}

// ── Arg parsers ───────────────────────────────────────────────────────────────

fn parse_new_session(args: &[String]) -> String {
    let mut name = "main".to_string();
    let mut cols: u16 = 220;
    let mut rows: u16 = 50;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-s" if i + 1 < args.len() => { name = args[i + 1].clone(); i += 2; }
            "-x" if i + 1 < args.len() => { cols = args[i + 1].parse().unwrap_or(220); i += 2; }
            "-y" if i + 1 < args.len() => { rows = args[i + 1].parse().unwrap_or(50); i += 2; }
            "-n" | "-c" | "-e" if i + 1 < args.len() => { i += 2; } // skip window-name / start-dir / env
            _ => { i += 1; }
        }
    }
    serde_json::json!({
        "cmd": "new-session",
        "name": name,
        "cols": cols,
        "rows": rows
    })
    .to_string()
}

fn parse_send_keys(args: &[String]) -> String {
    let mut target = "main".to_string();
    let mut key_parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" if i + 1 < args.len() => { target = args[i + 1].clone(); i += 2; }
            "-l" => { i += 1; } // literal flag — keys are passed as-is (default)
            _ => { key_parts.push(args[i].clone()); i += 1; }
        }
    }
    // Translate tmux key names to actual byte sequences.
    let keys = translate_keys(&key_parts);
    serde_json::json!({ "cmd": "send-keys", "name": target, "keys": keys }).to_string()
}

fn parse_capture_pane(args: &[String]) -> String {
    let mut target = "main".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" if i + 1 < args.len() => { target = args[i + 1].clone(); i += 2; }
            _ => { i += 1; }
        }
    }
    serde_json::json!({ "cmd": "capture-pane", "name": target }).to_string()
}

fn parse_kill_session(args: &[String]) -> String {
    let target = extract_target(args);
    serde_json::json!({ "cmd": "kill-session", "name": target }).to_string()
}

fn parse_has_session(args: &[String]) -> String {
    let target = extract_target(args);
    serde_json::json!({ "cmd": "has-session", "name": target }).to_string()
}

fn extract_target(args: &[String]) -> String {
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-t" && i + 1 < args.len() {
            return args[i + 1].clone();
        }
        i += 1;
    }
    "main".to_string()
}

// ── Key translation ───────────────────────────────────────────────────────────

fn translate_keys(parts: &[String]) -> String {
    let mut out = String::new();
    for part in parts {
        match part.as_str() {
            "Enter"      => out.push('\r'),
            "Space"      => out.push(' '),
            "Escape"     => out.push('\x1b'),
            "Tab"        => out.push('\t'),
            "BSpace"     => out.push('\x7f'),
            "C-c" | "q"  => out.push('\x03'),
            "C-d"        => out.push('\x04'),
            "C-z"        => out.push('\x1a'),
            "C-a"        => out.push('\x01'),
            "C-e"        => out.push('\x05'),
            "C-l"        => out.push('\x0c'),
            other        => out.push_str(other),
        }
    }
    out
}

// ── Named pipe I/O ────────────────────────────────────────────────────────────

fn send_ipc(cmd_json: &str) -> Result<String, Box<dyn std::error::Error>> {
    let mut pipe = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(r"\\.\pipe\wmux-ipc")?;

    pipe.write_all(cmd_json.as_bytes())?;
    pipe.write_all(b"\n")?;
    pipe.flush()?;

    let mut reader = BufReader::new(&pipe);
    let mut response = String::new();
    reader.read_line(&mut response)?;
    Ok(response)
}
