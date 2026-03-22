//! wmux `tmux` shim — a drop-in `tmux.exe` replacement that routes commands
//! to the running wmux process via the named pipe `\\.\pipe\wmux-ipc`.
//!
//! Place this binary in a directory that appears on PATH *before* any real
//! `tmux` installation.  Clients such as Claude Code that detect `tmux` and
//! use it to manage terminal sessions will transparently drive wmux panes.
//!
//! Supported tmux commands:
//!   new-session   [-d] [-s name] [-x cols] [-y rows] [-P] [-F format]
//!   new-window    -t name        (create tab in workspace/session)
//!   send-keys     -t name [keys...] [Enter|Space|Escape|Tab|BSpace|C-c|C-d|C-z]
//!   capture-pane  [-p] -t name
//!   list-sessions
//!   list-windows  [-t name] [-F format]
//!   select-window -t tab_id
//!   list-panes    [-t tab_id] [-F format]
//!   split-window  [-h|-v] -t pane_id
//!   select-pane   -t pane_id
//!   kill-pane     -t pane_id
//!   kill-session  -t name
//!   has-session   -t name        (exit 0 = exists, exit 1 = not found)
//!   attach-session [-t name]
//!   switch-client  [-t name]
//!   wait-for      [-L|-S|-U] channel
//!   set-option / set-window-option / refresh-client / source-file
//!   display-message [-p] [-F format] [-t target] message...

use std::error::Error;
use std::io::{BufRead, BufReader, Write};

enum ListKind {
    Panes,
    Windows,
}

enum ParsedCommand {
    Ipc {
        request_json: String,
        response_mode: ResponseMode,
    },
    DisplayQuery {
        format: String,
        target: Option<String>,
    },
}

enum ResponseMode {
    Default,
    Created {
        name: String,
        format: Option<String>,
    },
    List {
        kind: ListKind,
        format: Option<String>,
    },
}

impl ParsedCommand {
    fn plain(request_json: String) -> Self {
        Self::Ipc {
            request_json,
            response_mode: ResponseMode::Default,
        }
    }

    fn list(request_json: String, kind: ListKind, format: Option<String>) -> Self {
        Self::Ipc {
            request_json,
            response_mode: ResponseMode::List { kind, format },
        }
    }

    fn created(request_json: String, name: String, format: Option<String>) -> Self {
        Self::Ipc {
            request_json,
            response_mode: ResponseMode::Created { name, format },
        }
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exit_code = run_tmux_args(&args).unwrap_or_else(|e| {
        log::debug!("wmux tmux shim error: {e}");
        1
    });
    std::process::exit(exit_code);
}

fn run_tmux_args(args: &[String]) -> Result<i32, Box<dyn Error>> {
    if args.is_empty() {
        // tmux with no args usually starts a server/session; just succeed silently.
        return Ok(0);
    }

    // Strip flags that appear before the subcommand (e.g. `tmux -u new-session`).
    let mut idx = 0;
    while idx < args.len() && args[idx].starts_with('-') && !is_subcommand(&args[idx]) {
        idx += 1;
    }

    if idx >= args.len() {
        return Ok(0);
    }

    let sub = args[idx].as_str();
    let rest = &args[idx + 1..];

    execute_subcommand(sub, rest)
}

fn execute_subcommand(sub: &str, rest: &[String]) -> Result<i32, Box<dyn Error>> {
    if matches!(sub, "source-file" | "source") {
        return execute_source_file(rest);
    }

    if sub == "refresh-client" {
        return Ok(0);
    }

    let command = match sub {
        "new-session" => parse_new_session(rest),
        "new-window" => ParsedCommand::plain(parse_new_window(rest)),
        "send-keys"   => ParsedCommand::plain(parse_send_keys(rest)),
        "capture-pane" => ParsedCommand::plain(parse_capture_pane(rest)),
        "list-sessions" | "ls" => ParsedCommand::plain(r#"{"cmd":"list-sessions"}"#.to_string()),
        "list-windows" | "lsw" => parse_list_windows(rest),
        "select-window" => ParsedCommand::plain(parse_select_window(rest)),
        "list-panes" => parse_list_panes(rest),
        "split-window" => ParsedCommand::plain(parse_split_window(rest)),
        "select-pane" => ParsedCommand::plain(parse_select_pane(rest)),
        "kill-pane" => ParsedCommand::plain(parse_kill_pane(rest)),
        "kill-session" => ParsedCommand::plain(parse_kill_session(rest)),
        "has-session"  => ParsedCommand::plain(parse_has_session(rest)),
        "attach-session" | "attach" => ParsedCommand::plain(parse_switch_session(rest)),
        "switch-client" | "switchc" => ParsedCommand::plain(parse_switch_session(rest)),
        "wait-for" | "wait" => ParsedCommand::plain(parse_wait_for(rest)),
        "set-option" | "set" => ParsedCommand::plain(parse_set_option(rest, false)),
        "set-window-option" | "setw" => ParsedCommand::plain(parse_set_option(rest, true)),
        "display-message" => parse_display_message(rest),
        // Gracefully ignore commands we don't implement.
        _ => return Ok(0),
    };

    execute_parsed_command(sub, command)
}

fn execute_parsed_command(sub: &str, command: ParsedCommand) -> Result<i32, Box<dyn Error>> {
    match command {
        ParsedCommand::DisplayQuery { format, target } => {
            handle_display_query(&format, target.as_deref())?;
            Ok(0)
        }
        ParsedCommand::Ipc { request_json, response_mode } => {
            let resp_json = send_ipc(&request_json)?;
            Ok(handle_response(sub, &resp_json, &response_mode))
        }
    }
}

fn is_subcommand(s: &str) -> bool {
    matches!(
        s,
        "new-session" | "new-window" | "send-keys" | "capture-pane"
            | "list-sessions" | "ls" | "list-windows" | "lsw" | "select-window"
            | "list-panes" | "split-window" | "select-pane" | "kill-pane"
            | "kill-session" | "has-session" | "attach-session" | "attach"
            | "switch-client" | "switchc" | "wait-for" | "wait"
            | "set-option" | "set" | "set-window-option" | "setw"
            | "refresh-client" | "source-file" | "source"
            | "display-message"
    )
}

// ── Response handler ──────────────────────────────────────────────────────────

fn handle_response(sub: &str, resp_json: &str, response_mode: &ResponseMode) -> i32 {
    let v: serde_json::Value = serde_json::from_str(resp_json).unwrap_or_default();
    let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);

    if sub == "has-session" {
        return if ok { 0 } else { 1 };
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

    if let ResponseMode::List { kind, format } = response_mode {
        match kind {
            ListKind::Panes => print_list_entries(
                v.get("payload").and_then(|x| x.as_array()),
                format.as_deref().unwrap_or("#{pane_id}"),
            ),
            ListKind::Windows => print_list_entries(
                v.get("payload").and_then(|x| x.as_array()),
                format.as_deref().unwrap_or("#{window_id}"),
            ),
        }
    }

    if let ResponseMode::Created { name, format } = response_mode {
        if ok {
            let created_id = v
                .get("id")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let created = serde_json::json!({
                "workspaceId": created_id,
                "workspaceName": name,
                "id": created_id,
                "name": name,
                "active": true,
            });
            println!(
                "{}",
                render_tmux_format(&created, format.as_deref().unwrap_or("#{session_name}"))
            );
        }
    }

    if !ok {
        return 1;
    }

    0
}

// ── Arg parsers ───────────────────────────────────────────────────────────────

fn parse_new_session(args: &[String]) -> ParsedCommand {
    let mut name = "main".to_string();
    let mut cols: u16 = 220;
    let mut rows: u16 = 50;
    let mut print_info = false;
    let mut format: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-s" if i + 1 < args.len() => { name = args[i + 1].clone(); i += 2; }
            "-x" if i + 1 < args.len() => { cols = args[i + 1].parse().unwrap_or(220); i += 2; }
            "-y" if i + 1 < args.len() => { rows = args[i + 1].parse().unwrap_or(50); i += 2; }
            "-P" => { print_info = true; i += 1; }
            "-F" if i + 1 < args.len() => { format = Some(args[i + 1].clone()); i += 2; }
            "-n" | "-c" | "-e" if i + 1 < args.len() => { i += 2; } // skip window-name / start-dir / env
            _ => { i += 1; }
        }
    }
    let request_json = serde_json::json!({
        "cmd": "new-session",
        "name": name,
        "cols": cols,
        "rows": rows
    })
    .to_string();

    if print_info {
        ParsedCommand::created(request_json, name, format)
    } else {
        ParsedCommand::plain(request_json)
    }
}

fn parse_new_window(args: &[String]) -> String {
    let mut target = "main".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" if i + 1 < args.len() => { target = args[i + 1].clone(); i += 2; }
            "-n" | "-c" if i + 1 < args.len() => { i += 2; }
            _ => { i += 1; }
        }
    }

    serde_json::json!({ "cmd": "new-window", "target": target }).to_string()
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

fn parse_list_windows(args: &[String]) -> ParsedCommand {
    let mut target: Option<String> = None;
    let mut format: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" if i + 1 < args.len() => {
                target = Some(args[i + 1].clone());
                i += 2;
            }
            "-F" if i + 1 < args.len() => {
                format = Some(args[i + 1].clone());
                i += 2;
            }
            _ => {
                i += 1;
            }
        }
    }
    ParsedCommand::list(
        serde_json::json!({ "cmd": "list-windows", "workspace_id": target }).to_string(),
        ListKind::Windows,
        format,
    )
}

fn parse_select_window(args: &[String]) -> String {
    let target = extract_target(args);
    serde_json::json!({ "cmd": "focus-window", "tab_id": target }).to_string()
}

fn parse_list_panes(args: &[String]) -> ParsedCommand {
    let mut tab_id: Option<String> = None;
    let mut format: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" if i + 1 < args.len() => { tab_id = Some(args[i + 1].clone()); i += 2; }
            "-F" if i + 1 < args.len() => { format = Some(args[i + 1].clone()); i += 2; }
            _ => { i += 1; }
        }
    }
    ParsedCommand::list(
        serde_json::json!({ "cmd": "list-panes", "tab_id": tab_id }).to_string(),
        ListKind::Panes,
        format,
    )
}

fn parse_split_window(args: &[String]) -> String {
    let mut pane_id = "".to_string();
    let mut direction = "v".to_string();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" if i + 1 < args.len() => { pane_id = args[i + 1].clone(); i += 2; }
            "-h" => { direction = "h".to_string(); i += 1; }
            "-v" => { direction = "v".to_string(); i += 1; }
            _ => { i += 1; }
        }
    }
    serde_json::json!({ "cmd": "split-pane", "pane_id": pane_id, "direction": direction }).to_string()
}

fn parse_select_pane(args: &[String]) -> String {
    let target = extract_target(args);
    serde_json::json!({ "cmd": "focus-pane", "pane_id": target }).to_string()
}

fn parse_kill_pane(args: &[String]) -> String {
    let target = extract_target(args);
    serde_json::json!({ "cmd": "close-pane", "pane_id": target }).to_string()
}

fn parse_kill_session(args: &[String]) -> String {
    let target = extract_target(args);
    serde_json::json!({ "cmd": "kill-session", "name": target }).to_string()
}

fn parse_has_session(args: &[String]) -> String {
    let target = extract_target(args);
    serde_json::json!({ "cmd": "has-session", "name": target }).to_string()
}

fn parse_switch_session(args: &[String]) -> String {
    let target = extract_target(args);
    serde_json::json!({ "cmd": "switch-session", "name": target }).to_string()
}

fn parse_display_message(args: &[String]) -> ParsedCommand {
    let mut tab_id: Option<String> = None;
    let mut format: Option<String> = None;
    let mut print_only = false;
    let mut message_parts: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-p" => {
                print_only = true;
                i += 1;
            }
            "-F" if i + 1 < args.len() => {
                format = Some(args[i + 1].clone());
                i += 2;
            }
            "-t" if i + 1 < args.len() => {
                tab_id = Some(args[i + 1].clone());
                i += 2;
            }
            _ => {
                message_parts.push(args[i].clone());
                i += 1;
            }
        }
    }

    if print_only {
        let query_format = format.unwrap_or_else(|| message_parts.join(" "));
        return ParsedCommand::DisplayQuery {
            format: query_format,
            target: tab_id,
        };
    }

    ParsedCommand::plain(
        serde_json::json!({
            "cmd": "notify",
            "tab_id": tab_id,
            "title": message_parts.join(" "),
            "body": ""
        })
        .to_string(),
    )
}

fn parse_wait_for(args: &[String]) -> String {
    let mut action = "wait";
    let mut channel: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-S" => {
                action = "signal";
                i += 1;
            }
            "-L" => {
                action = "lock";
                i += 1;
            }
            "-U" => {
                action = "unlock";
                i += 1;
            }
            arg if !arg.starts_with('-') && channel.is_none() => {
                channel = Some(arg.to_string());
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }

    serde_json::json!({
        "cmd": "wait-for",
        "channel": channel.unwrap_or_else(|| "wmux".to_string()),
        "action": action,
    })
    .to_string()
}

fn parse_set_option(args: &[String], window: bool) -> String {
    let mut option: Option<String> = None;
    let mut value_parts: Vec<String> = Vec::new();
    let mut target: Option<String> = None;
    let mut global = false;
    let mut append = false;
    let mut unset = false;
    let mut i = 0;

    while i < args.len() {
        match args[i].as_str() {
            "-g" => {
                global = true;
                i += 1;
            }
            "-a" => {
                append = true;
                i += 1;
            }
            "-u" | "-U" => {
                unset = true;
                i += 1;
            }
            "-q" => {
                i += 1;
            }
            "-t" if i + 1 < args.len() => {
                target = Some(args[i + 1].clone());
                i += 2;
            }
            arg if arg.starts_with('-') => {
                i += 1;
            }
            arg if option.is_none() => {
                option = Some(arg.to_string());
                i += 1;
            }
            arg => {
                value_parts.push(arg.to_string());
                i += 1;
            }
        }
    }

    serde_json::json!({
        "cmd": if window { "set-window-option" } else { "set-option" },
        "option": option.unwrap_or_default(),
        "value": if unset || value_parts.is_empty() { None::<String> } else { Some(value_parts.join(" ")) },
        "target": target,
        "global": global,
        "append": append,
        "unset": unset,
    })
    .to_string()
}

fn execute_source_file(args: &[String]) -> Result<i32, Box<dyn Error>> {
    let mut quiet = false;
    let mut path: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-q" => {
                quiet = true;
                i += 1;
            }
            arg if !arg.starts_with('-') && path.is_none() => {
                path = Some(arg.to_string());
                i += 1;
            }
            _ => {
                i += 1;
            }
        }
    }

    let Some(path) = path else {
        return Ok(if quiet { 0 } else { 1 });
    };

    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) if quiet => {
            log::debug!("wmux source-file ignored read error for {path}: {err}");
            return Ok(0);
        }
        Err(err) => return Err(Box::new(err)),
    };

    for (line_number, line) in collect_source_commands(&content)? {
        let tokens = match tokenize_tmux_line(&line) {
            Ok(tokens) if tokens.is_empty() => continue,
            Ok(tokens) => tokens,
            Err(err) if quiet => {
                log::debug!("wmux source-file ignored parse error at {path}:{line_number}: {err}");
                continue;
            }
            Err(err) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("{path}:{line_number}: {err}"),
                )
                .into());
            }
        };

        let exit_code = run_tmux_args(&tokens)?;
        if exit_code != 0 && !quiet {
            return Ok(exit_code);
        }
    }

    Ok(0)
}

fn collect_source_commands(content: &str) -> Result<Vec<(usize, String)>, String> {
    let mut commands = Vec::new();
    let mut buffer = String::new();
    let mut start_line = 0usize;
    let mut quote_context: Option<char> = None;

    for (index, raw_line) in content.lines().enumerate() {
        let line_number = index + 1;
        let (uncommented, next_quote_context) = strip_inline_comment_with_context(raw_line, quote_context);
        let trimmed = uncommented.trim();

        if trimmed.is_empty() && buffer.is_empty() {
            quote_context = next_quote_context;
            continue;
        }

        let continuation = has_trailing_continuation(uncommented.as_str())?;
        let segment = if continuation {
            trim_trailing_continuation(uncommented.as_str())?.trim()
        } else {
            trimmed
        };

        if !segment.is_empty() {
            if buffer.is_empty() {
                start_line = line_number;
                buffer.push_str(segment);
            } else {
                buffer.push_str(segment.trim_start());
            }
        }

        if continuation {
            quote_context = next_quote_context;
            continue;
        }

        for command in split_source_commands(&buffer)? {
            let command = command.trim();
            if !command.is_empty() {
                commands.push((start_line, command.to_string()));
            }
        }
        buffer.clear();
        quote_context = None;
    }

    if !buffer.trim().is_empty() {
        return Err("dangling line continuation".to_string());
    }

    Ok(commands)
}

#[cfg(test)]
fn strip_inline_comment(line: &str) -> String {
    strip_inline_comment_with_context(line, None).0
}

fn strip_inline_comment_with_context(line: &str, initial_quote: Option<char>) -> (String, Option<char>) {
    let mut out = String::new();
    let mut quote = initial_quote;
    let mut escaped = false;
    let mut previous_was_whitespace = initial_quote.is_none();

    for ch in line.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            previous_was_whitespace = false;
            continue;
        }

        match quote {
            Some(delim) if ch == delim => {
                out.push(ch);
                quote = None;
                previous_was_whitespace = false;
            }
            Some(_) => {
                out.push(ch);
                previous_was_whitespace = false;
            }
            None => match ch {
                '\\' => {
                    out.push(ch);
                    escaped = true;
                    previous_was_whitespace = false;
                }
                '\'' | '"' => {
                    out.push(ch);
                    quote = Some(ch);
                    previous_was_whitespace = false;
                }
                '#' if previous_was_whitespace => break,
                _ => {
                    previous_was_whitespace = ch.is_whitespace();
                    out.push(ch);
                }
            },
        }
    }

    (out, quote)
}

fn has_trailing_continuation(line: &str) -> Result<bool, String> {
    let trimmed = line.trim_end();
    if trimmed.is_empty() {
        return Ok(false);
    }

    let mut escaped = false;
    let mut backslashes = 0usize;

    for ch in trimmed.chars() {
        if escaped {
            escaped = false;
            backslashes = 0;
            continue;
        }

        match ch {
            '\\' => {
                escaped = true;
                backslashes += 1;
                continue;
            }
            _ => backslashes = 0,
        }
    }

    Ok(trimmed.ends_with('\\') && backslashes % 2 == 1)
}

fn trim_trailing_continuation(line: &str) -> Result<&str, String> {
    if !has_trailing_continuation(line)? {
        return Ok(line);
    }

    let trimmed = line.trim_end();
    Ok(&trimmed[..trimmed.len() - 1])
}

fn split_source_commands(line: &str) -> Result<Vec<String>, String> {
    let mut commands = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in line.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        match quote {
            Some(delim) if ch == delim => {
                current.push(ch);
                quote = None;
            }
            Some(_) => current.push(ch),
            None => match ch {
                '\\' => {
                    current.push(ch);
                    escaped = true;
                }
                '\'' | '"' => {
                    current.push(ch);
                    quote = Some(ch);
                }
                ';' => {
                    let command = current.trim();
                    if !command.is_empty() {
                        commands.push(command.to_string());
                    }
                    current.clear();
                }
                _ => current.push(ch),
            },
        }
    }

    if quote.is_some() {
        return Err("unterminated quote".to_string());
    }

    let trailing = current.trim();
    if !trailing.is_empty() {
        commands.push(trailing.to_string());
    }

    Ok(commands)
}

fn tokenize_tmux_line(line: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for ch in line.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }

        match quote {
            Some(delim) if ch == delim => quote = None,
            Some(_) => current.push(ch),
            None => match ch {
                '\\' => escaped = true,
                '\'' | '"' => quote = Some(ch),
                c if c.is_whitespace() => {
                    if !current.is_empty() {
                        tokens.push(std::mem::take(&mut current));
                    }
                }
                _ => current.push(ch),
            },
        }
    }

    if escaped {
        current.push('\\');
    }

    if quote.is_some() {
        return Err("unterminated quote".to_string());
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    Ok(tokens)
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

fn print_list_entries(entries: Option<&Vec<serde_json::Value>>, default_format: &str) {
    if let Some(items) = entries {
        for item in items {
            println!("{}", render_tmux_format(item, default_format));
        }
    }
}

fn render_tmux_format(entry: &serde_json::Value, format_str: &str) -> String {
    let replacements = [
        ("#{pane_id}", value_str_any(entry, &["paneId", "id"])),
        ("#{pane_current_path}", value_str_any(entry, &["cwd"])),
        ("#{pane_title}", value_str_any(entry, &["paneTitle", "paneLabel", "title", "name"])),
        ("#{pane_current_command}", value_str_any(entry, &["paneLabel", "paneTitle", "targetLabel", "title"])),
        ("#{pane_active}", bool_str_any(entry, &["active"])),
        ("#{window_id}", value_str_any(entry, &["tabId", "id"])),
        ("#{window_name}", value_str_any(entry, &["title", "name"])),
        ("#{window_active}", bool_str_any(entry, &["active"])),
        ("#{session_id}", value_str_any(entry, &["workspaceId", "id"])),
        ("#{session_name}", value_str_any(entry, &["workspaceName", "name"])),
        ("#{session_attached}", bool_str_any(entry, &["active"])),
        ("#{client_termtype}", tmux_client_termtype()),
        ("#{client_termname}", tmux_client_termname()),
    ];

    let mut rendered = format_str.to_string();
    for (token, value) in replacements {
        rendered = rendered.replace(token, &value);
    }
    rendered
}

fn tmux_client_termtype() -> String {
    if let Some(term_program) = std::env::var("TERM_PROGRAM").ok().filter(|v| !v.is_empty()) {
        if let Some(version) = std::env::var("TERM_PROGRAM_VERSION").ok().filter(|v| !v.is_empty()) {
            return format!("{term_program} {version}");
        }
        return term_program;
    }

    std::env::var("TERM")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_default()
}

fn tmux_client_termname() -> String {
    std::env::var("TERM")
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_default()
}

fn value_str_any(entry: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = entry.get(key).and_then(|v| v.as_str()) {
            return value.to_string();
        }
    }
    String::new()
}

fn bool_str_any(entry: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(value) = entry.get(key).and_then(|v| v.as_bool()) {
            return if value { "1".to_string() } else { "0".to_string() };
        }
    }
    "0".to_string()
}

fn payload_array(resp_json: &str) -> Result<Vec<serde_json::Value>, Box<dyn std::error::Error>> {
    let response: serde_json::Value = serde_json::from_str(resp_json)?;
    if !response.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        return Ok(Vec::new());
    }
    Ok(response
        .get("payload")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

fn fetch_payload_array(cmd_json: &str) -> Result<Vec<serde_json::Value>, Box<dyn std::error::Error>> {
    let response = send_ipc(cmd_json)?;
    payload_array(&response)
}

fn handle_display_query(format: &str, target: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let workspaces = fetch_payload_array(r#"{"cmd":"list-workspaces"}"#)?;
    let tabs = fetch_payload_array(r#"{"cmd":"list-tabs"}"#)?;
    let panes = fetch_payload_array(r#"{"cmd":"list-panes"}"#)?;

    let entry = resolve_display_entry(target, &workspaces, &tabs, &panes)
        .or_else(|| panes.iter().find(|item| item.get("active").and_then(|v| v.as_bool()).unwrap_or(false)).cloned())
        .or_else(|| tabs.iter().find(|item| item.get("active").and_then(|v| v.as_bool()).unwrap_or(false)).cloned())
        .or_else(|| workspaces.iter().find(|item| item.get("active").and_then(|v| v.as_bool()).unwrap_or(false)).cloned())
        .unwrap_or_else(|| serde_json::json!({}));

    println!("{}", render_tmux_format(&entry, format));
    Ok(())
}

fn resolve_display_entry(
    target: Option<&str>,
    workspaces: &[serde_json::Value],
    tabs: &[serde_json::Value],
    panes: &[serde_json::Value],
) -> Option<serde_json::Value> {
    let target = target?;

    find_entry_by_keys(panes, &["paneId", "id"], target)
        .or_else(|| find_entry_by_keys(tabs, &["tabId", "id"], target))
        .or_else(|| find_entry_by_keys(workspaces, &["workspaceId", "id", "name"], target))
        .or_else(|| find_entry_by_keys(tabs, &["workspaceId", "workspaceName"], target))
        .or_else(|| find_entry_by_keys(panes, &["workspaceId", "workspaceName", "tabId"], target))
}

fn find_entry_by_keys(
    entries: &[serde_json::Value],
    keys: &[&str],
    target: &str,
) -> Option<serde_json::Value> {
    entries
        .iter()
        .find(|entry| keys.iter().any(|key| entry.get(key).and_then(|v| v.as_str()) == Some(target)))
        .cloned()
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

#[cfg(test)]
mod tests {
    use super::{collect_source_commands, parse_capture_pane, parse_display_message, parse_kill_pane, parse_kill_session, parse_list_panes, parse_list_windows, parse_new_session, parse_new_window, parse_select_pane, parse_send_keys, parse_set_option, parse_split_window, parse_switch_session, parse_wait_for, render_tmux_format, split_source_commands, strip_inline_comment, tokenize_tmux_line, ParsedCommand, ResponseMode, ListKind, translate_keys};

    const CLAUDE_BOOTSTRAP: &str = include_str!("../../tests/fixtures/claude-code-bootstrap.tmux");
    const CODEX_BOOTSTRAP: &str = include_str!("../../tests/fixtures/codex-bootstrap.tmux");
    const MIXED_AGENT_BOOTSTRAP: &str = include_str!("../../tests/fixtures/mixed-agent-bootstrap.tmux");

    fn parse_fixture_command(tokens: &[String]) -> Option<serde_json::Value> {
        let sub = tokens.first()?.as_str();
        let rest = &tokens[1..];

        let json = match sub {
            "new-session" => match parse_new_session(rest) {
                ParsedCommand::Ipc { request_json, .. } => request_json,
                ParsedCommand::DisplayQuery { .. } => return None,
            },
            "new-window" => parse_new_window(rest),
            "send-keys" => parse_send_keys(rest),
            "capture-pane" => parse_capture_pane(rest),
            "list-windows" | "lsw" => match parse_list_windows(rest) {
                ParsedCommand::Ipc { request_json, .. } => request_json,
                ParsedCommand::DisplayQuery { .. } => return None,
            },
            "list-panes" => match parse_list_panes(rest) {
                ParsedCommand::Ipc { request_json, .. } => request_json,
                ParsedCommand::DisplayQuery { .. } => return None,
            },
            "split-window" => parse_split_window(rest),
            "select-pane" => parse_select_pane(rest),
            "kill-pane" => parse_kill_pane(rest),
            "kill-session" => parse_kill_session(rest),
            "attach-session" | "attach" | "switch-client" | "switchc" => parse_switch_session(rest),
            "wait-for" | "wait" => parse_wait_for(rest),
            "set-option" | "set" => parse_set_option(rest, false),
            "set-window-option" | "setw" => parse_set_option(rest, true),
            "display-message" => match parse_display_message(rest) {
                ParsedCommand::Ipc { request_json, .. } => request_json,
                ParsedCommand::DisplayQuery { format, target } => {
                    return Some(serde_json::json!({
                        "cmd": "display-query",
                        "format": format,
                        "target": target,
                    }));
                }
            },
            "refresh-client" => return Some(serde_json::json!({ "cmd": "refresh-client" })),
            _ => return None,
        };

        serde_json::from_str(&json).ok()
    }

    #[test]
    fn new_session_print_mode_preserves_format() {
        let command = parse_new_session(&[
            "-d".to_string(),
            "-s".to_string(),
            "coord".to_string(),
            "-P".to_string(),
            "-F".to_string(),
            "#{session_name} #{session_id}".to_string(),
        ]);

        match command {
            ParsedCommand::Ipc { request_json, response_mode } => {
                let value: serde_json::Value = serde_json::from_str(&request_json).expect("json should parse");
                assert_eq!(value["cmd"], "new-session");
                assert_eq!(value["name"], "coord");
                match response_mode {
                    ResponseMode::Created { name, format } => {
                        assert_eq!(name, "coord");
                        assert_eq!(format.as_deref(), Some("#{session_name} #{session_id}"));
                    }
                    _ => panic!("expected creation response mode"),
                }
            }
            _ => panic!("expected ipc command"),
        }
    }

    #[test]
    fn display_message_maps_to_notify_command() {
        let command = parse_display_message(&[
            "-t".to_string(),
            "tab-42".to_string(),
            "Deploy".to_string(),
            "done".to_string(),
        ]);
        let ParsedCommand::Ipc { request_json: json, .. } = command else {
            panic!("expected notify command");
        };
        let value: serde_json::Value = serde_json::from_str(&json).expect("json should parse");

        assert_eq!(value["cmd"], "notify");
        assert_eq!(value["tab_id"], "tab-42");
        assert_eq!(value["title"], "Deploy done");
        assert_eq!(value["body"], "");
    }

    #[test]
    fn display_message_print_mode_preserves_format_and_target() {
        let command = parse_display_message(&[
            "-p".to_string(),
            "-F".to_string(),
            "#{session_name} #{window_id}".to_string(),
            "-t".to_string(),
            "tab-7".to_string(),
        ]);

        match command {
            ParsedCommand::DisplayQuery { format, target } => {
                assert_eq!(format, "#{session_name} #{window_id}");
                assert_eq!(target.as_deref(), Some("tab-7"));
            }
            _ => panic!("expected display query command"),
        }
    }

    #[test]
    fn send_keys_translates_special_tmux_keys() {
        let json = parse_send_keys(&[
            "-t".to_string(),
            "main".to_string(),
            "echo".to_string(),
            "Space".to_string(),
            "ok".to_string(),
            "Enter".to_string(),
        ]);
        let value: serde_json::Value = serde_json::from_str(&json).expect("json should parse");

        assert_eq!(value["cmd"], "send-keys");
        assert_eq!(value["name"], "main");
        assert_eq!(value["keys"], "echo ok\r");
    }

    #[test]
    fn key_translation_handles_control_shortcuts() {
        let translated = translate_keys(&[
            "C-c".to_string(),
            "Tab".to_string(),
            "BSpace".to_string(),
        ]);
        assert_eq!(translated, "\u{3}\t\u{7f}");
    }

    #[test]
    fn split_window_maps_to_split_pane_command() {
        let json = parse_split_window(&[
            "-h".to_string(),
            "-t".to_string(),
            "pane-1".to_string(),
        ]);
        let value: serde_json::Value = serde_json::from_str(&json).expect("json should parse");

        assert_eq!(value["cmd"], "split-pane");
        assert_eq!(value["pane_id"], "pane-1");
        assert_eq!(value["direction"], "h");
    }

    #[test]
    fn list_panes_preserves_format_and_targets_tab() {
        let command = parse_list_panes(&[
            "-t".to_string(),
            "tab-7".to_string(),
            "-F".to_string(),
            "#{pane_id}".to_string(),
        ]);
        match command {
            ParsedCommand::Ipc { request_json, response_mode } => {
                let value: serde_json::Value = serde_json::from_str(&request_json).expect("json should parse");
                assert_eq!(value["cmd"], "list-panes");
                assert_eq!(value["tab_id"], "tab-7");
                match response_mode {
                    ResponseMode::List { kind: ListKind::Panes, format } => {
                        assert_eq!(format.as_deref(), Some("#{pane_id}"));
                    }
                    _ => panic!("expected list-panes response mode"),
                }
            }
            _ => panic!("expected ipc command"),
        }
    }

    #[test]
    fn list_windows_preserves_requested_format() {
        let command = parse_list_windows(&[
            "-t".to_string(),
            "coord".to_string(),
            "-F".to_string(),
            "#{window_id} #{window_name}".to_string(),
        ]);
        match command {
            ParsedCommand::Ipc { request_json, response_mode } => {
                let value: serde_json::Value = serde_json::from_str(&request_json).expect("json should parse");
                assert_eq!(value["cmd"], "list-windows");
                assert_eq!(value["workspace_id"], "coord");
                match response_mode {
                    ResponseMode::List { kind: ListKind::Windows, format } => {
                        assert_eq!(format.as_deref(), Some("#{window_id} #{window_name}"));
                    }
                    _ => panic!("expected list-windows response mode"),
                }
            }
            _ => panic!("expected ipc command"),
        }
    }

    #[test]
    fn select_pane_maps_to_focus_pane_command() {
        let json = parse_select_pane(&["-t".to_string(), "pane-9".to_string()]);
        let value: serde_json::Value = serde_json::from_str(&json).expect("json should parse");

        assert_eq!(value["cmd"], "focus-pane");
        assert_eq!(value["pane_id"], "pane-9");
    }

    #[test]
    fn new_window_targets_workspace_session() {
        let json = parse_new_window(&["-t".to_string(), "coord".to_string()]);
        let value: serde_json::Value = serde_json::from_str(&json).expect("json should parse");

        assert_eq!(value["cmd"], "new-window");
        assert_eq!(value["target"], "coord");
    }

    #[test]
    fn attach_and_switch_map_to_switch_session_command() {
        let json = parse_switch_session(&["-t".to_string(), "coord".to_string()]);
        let value: serde_json::Value = serde_json::from_str(&json).expect("json should parse");

        assert_eq!(value["cmd"], "switch-session");
        assert_eq!(value["name"], "coord");
    }

    #[test]
    fn wait_for_parser_maps_lock_signal_and_unlock() {
        let signal: serde_json::Value = serde_json::from_str(&parse_wait_for(&[
            "-S".to_string(),
            "bootstrap".to_string(),
        ]))
        .expect("json should parse");
        let lock: serde_json::Value = serde_json::from_str(&parse_wait_for(&[
            "-L".to_string(),
            "bootstrap".to_string(),
        ]))
        .expect("json should parse");
        let unlock: serde_json::Value = serde_json::from_str(&parse_wait_for(&[
            "-U".to_string(),
            "bootstrap".to_string(),
        ]))
        .expect("json should parse");

        assert_eq!(signal["action"], "signal");
        assert_eq!(lock["action"], "lock");
        assert_eq!(unlock["action"], "unlock");
        assert_eq!(signal["channel"], "bootstrap");
    }

    #[test]
    fn set_option_parser_preserves_flags_and_values() {
        let json = parse_set_option(&[
            "-g".to_string(),
            "status".to_string(),
            "off".to_string(),
        ], false);
        let value: serde_json::Value = serde_json::from_str(&json).expect("json should parse");

        assert_eq!(value["cmd"], "set-option");
        assert_eq!(value["option"], "status");
        assert_eq!(value["value"], "off");
        assert_eq!(value["global"], true);
    }

    #[test]
    fn tokenizer_handles_quotes_and_escapes() {
        let tokens = tokenize_tmux_line(r#"set-option -g status-left \"build agent\""#)
            .expect("line should tokenize");

        assert_eq!(tokens, vec!["set-option", "-g", "status-left", "\"build", "agent\""]);

        let quoted = tokenize_tmux_line("set-option -g status-left 'build agent'")
            .expect("quoted line should tokenize");
        assert_eq!(quoted, vec!["set-option", "-g", "status-left", "build agent"]);
    }

    #[test]
    fn strip_inline_comment_ignores_hash_inside_tokens_and_quotes() {
        let token_hash = strip_inline_comment("set-option -g @name value#keep");
        let quoted_hash = strip_inline_comment("set-option -g status-left '#[fg=green]ok'");
        let commented = strip_inline_comment("set-option -g status off # turn off status");

        assert_eq!(token_hash, "set-option -g @name value#keep");
        assert_eq!(quoted_hash, "set-option -g status-left '#[fg=green]ok'");
        assert_eq!(commented.trim_end(), "set-option -g status off");
    }

    #[test]
    fn split_source_commands_respects_quotes() {
        let commands = split_source_commands("set -g status off; display-message 'a; b'; refresh-client")
            .expect("commands should split");

        assert_eq!(
            commands,
            vec![
                "set -g status off",
                "display-message 'a; b'",
                "refresh-client",
            ]
        );
    }

    #[test]
    fn collect_source_commands_handles_comments_continuations_and_separators() {
        let source = r#"
# bootstrap comment
set -g status-left 'build' ; set -g status-right 'agent' # trailing comment
set -g terminal-overrides '\
  ,*:Tc'
display-message 'ready'
"#;

        let commands = collect_source_commands(source).expect("source commands should parse");

        assert_eq!(
            commands,
            vec![
                (3, "set -g status-left 'build'".to_string()),
                (3, "set -g status-right 'agent'".to_string()),
                (4, "set -g terminal-overrides ',*:Tc'".to_string()),
                (6, "display-message 'ready'".to_string()),
            ]
        );
    }

    #[test]
    fn collect_source_commands_strips_comments_after_continued_quotes() {
        let source = "set-option -g terminal-overrides '\\\n  ,*:Tc' # truecolor hint\n";

        let commands = collect_source_commands(source).expect("source commands should parse");

        assert_eq!(
            commands,
            vec![(1, "set-option -g terminal-overrides ',*:Tc'".to_string())]
        );
    }

    #[test]
    fn fixture_claude_bootstrap_collects_expected_commands() {
        let commands = collect_source_commands(CLAUDE_BOOTSTRAP).expect("fixture should parse");

        assert_eq!(
            commands,
            vec![
                (2, "set-option -g status off".to_string()),
                (3, "set-option -g status-left '#S'".to_string()),
                (4, "set-window-option -g synchronize-panes off".to_string()),
                (7, "wait-for bootstrap-ready".to_string()),
                (8, "display-message -p -F '#{session_name}:#{window_id}'".to_string()),
                (8, "wait-for -S bootstrap-finished".to_string()),
            ]
        );
    }

    #[test]
    fn fixture_codex_bootstrap_collects_expected_commands() {
        let commands = collect_source_commands(CODEX_BOOTSTRAP).expect("fixture should parse");

        assert_eq!(
            commands,
            vec![
                (2, "set-option -g terminal-overrides ',*:Tc'".to_string()),
                (4, "set-window-option -g pane-border-format '#{pane_title}'".to_string()),
                (4, "refresh-client".to_string()),
                (5, "display-message 'codex bootstrap ready'".to_string()),
            ]
        );
    }

    #[test]
    fn fixture_mixed_agent_bootstrap_collects_expected_commands() {
        let commands = collect_source_commands(MIXED_AGENT_BOOTSTRAP).expect("fixture should parse");

        assert_eq!(
            commands,
            vec![
                (2, "set-option -g status-right 'agent:#(whoami)'".to_string()),
                (2, "set-window-option -g automatic-rename off".to_string()),
                (3, "wait-for -L agent-lock".to_string()),
                (4, "display-message 'workspace ready; attach if needed'".to_string()),
                (5, "wait-for -U agent-lock".to_string()),
                (5, "wait-for -S agent-ready".to_string()),
            ]
        );
    }

    #[test]
    fn fixture_commands_parse_into_known_tmux_requests() {
        for fixture in [CLAUDE_BOOTSTRAP, CODEX_BOOTSTRAP, MIXED_AGENT_BOOTSTRAP] {
            let commands = collect_source_commands(fixture).expect("fixture should parse");
            for (_, command) in commands {
                let tokens = tokenize_tmux_line(&command).expect("fixture command should tokenize");
                let parsed = parse_fixture_command(&tokens)
                    .unwrap_or_else(|| panic!("fixture command should parse: {command}"));
                assert!(parsed.get("cmd").is_some(), "fixture command should produce a request: {command}");
            }
        }
    }

    #[test]
    fn tmux_format_renderer_replaces_known_tokens() {
        let entry = serde_json::json!({
            "paneId": "pane-1",
            "cwd": "C:/repo",
            "title": "Terminal",
            "paneTitle": "feature-login",
            "paneLabel": "feature-login",
            "active": true,
            "tabId": "tab-1",
            "workspaceName": "Main",
            "workspaceId": "ws-1",
            "targetLabel": "pwsh"
        });

        let rendered = render_tmux_format(&entry, "#{session_id} #{session_name} #{window_id} #{pane_id} #{pane_current_path} #{pane_title} #{pane_current_command} #{pane_active}");
        assert_eq!(rendered, "ws-1 Main tab-1 pane-1 C:/repo feature-login feature-login 1");
    }

    #[test]
    fn tmux_format_renderer_replaces_client_terminal_tokens() {
        let _term_program = EnvGuard::set("TERM_PROGRAM", Some("WezTerm"));
        let _term_program_version = EnvGuard::set("TERM_PROGRAM_VERSION", Some("20240203"));
        let _term = EnvGuard::set("TERM", Some("xterm-256color"));

        let rendered = render_tmux_format(&serde_json::json!({}), "#{client_termtype} #{client_termname}");
        assert_eq!(rendered, "WezTerm 20240203 xterm-256color");
    }

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: Option<&str>) -> Self {
            let previous = std::env::var(key).ok();
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.previous.as_deref() {
                Some(value) => unsafe { std::env::set_var(self.key, value) },
                None => unsafe { std::env::remove_var(self.key) },
            }
        }
    }
}
