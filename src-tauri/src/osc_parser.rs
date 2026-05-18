/// Parse OSC (Operating System Command) notification sequences from raw terminal bytes.
///
/// Supported formats:
///   OSC 7                       BEL/ST  — cwd change (file://host/path)
///   OSC 9   ; <message>         BEL/ST  — ConEmu / cmux-style bell notification
///   OSC 99  ; <title> ; <body>  BEL/ST  — Windows NotificationCenter style
///   OSC 777 ; notify ; <title> ; <body>  BEL/ST  — libnotify / iTerm2 style
use serde::Serialize;

/// All events that can be parsed from OSC terminal sequences.
#[derive(Debug, Clone)]
pub enum OscEvent {
    Notification(OscNotification),
    /// Current working directory emitted by shell via OSC 7.
    Cwd(String),
    /// Clipboard text emitted by OSC 52.
    Clipboard(String),
    /// OSC 133;A — shell is displaying a prompt.
    BlockPromptStart,
    /// OSC 133;C — user submitted a command; execution is starting.
    BlockCommandStart,
    /// OSC 133;D or OSC 133;D;<n> — command finished, optional exit code.
    BlockCommandFinished { exit_code: Option<i32> },
    /// OSC 133;P=k=<command> — the command text about to be executed.
    BlockCommandLine(String),
}

/// A notification parsed from OSC 9/99/777 terminal output.
#[derive(Debug, Clone, Serialize)]
pub struct OscNotification {
    pub title: String,
    pub body: String,
}

/// Scan `data` for all OSC events (notifications + cwd changes).
pub fn extract_osc_events(data: &[u8]) -> Vec<OscEvent> {
    let mut result = Vec::new();
    let mut i = 0;
    while i + 1 < data.len() {
        if data[i] == 0x1b && data[i + 1] == b']' {
            i += 2;
            let start = i;
            let mut end = i;
            while end < data.len() {
                if data[end] == 0x07 { break; }
                if data[end] == 0x1b && end + 1 < data.len() && data[end + 1] == b'\\' { break; }
                end += 1;
            }
            if let Ok(s) = std::str::from_utf8(&data[start..end]) {
                if let Some(uri) = s.strip_prefix("7;") {
                    result.push(OscEvent::Cwd(extract_path_from_file_uri(uri)));
                } else if let Some(text) = parse_osc_52(s) {
                    result.push(OscEvent::Clipboard(text));
                } else if let Some(ev) = parse_osc_133(s) {
                    result.push(ev);
                } else if let Some(n) = parse_osc(s) {
                    result.push(OscEvent::Notification(n));
                }
            }
            i = if end < data.len() && data[end] == 0x07 {
                end + 1
            } else if end + 1 < data.len() {
                end + 2
            } else {
                end + 1
            };
        } else {
            i += 1;
        }
    }
    result
}

fn extract_path_from_file_uri(uri: &str) -> String {
    let path = if let Some(rest) = uri.strip_prefix("file:///") {
        rest.to_string()
    } else if let Some(rest) = uri.strip_prefix("file://") {
        if let Some(idx) = rest.find('/') { rest[idx..].to_string() } else { rest.to_string() }
    } else {
        uri.to_string()
    };
    percent_decode(path.trim_end_matches('/'))
}

fn percent_decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(hex) = std::str::from_utf8(&b[i + 1..i + 3]) {
                if let Ok(byte) = u8::from_str_radix(hex, 16) {
                    out.push(byte as char);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(b[i] as char);
        i += 1;
    }
    out
}

fn parse_osc_133(s: &str) -> Option<OscEvent> {
    let rest = s.strip_prefix("133;")?;
    if rest == "A" {
        return Some(OscEvent::BlockPromptStart);
    }
    if rest == "C" {
        return Some(OscEvent::BlockCommandStart);
    }
    if rest == "D" {
        return Some(OscEvent::BlockCommandFinished { exit_code: None });
    }
    if let Some(code_str) = rest.strip_prefix("D;") {
        let exit_code = code_str.trim().parse::<i32>().ok();
        return Some(OscEvent::BlockCommandFinished { exit_code });
    }
    // 133;P=k=<command> — command text
    if let Some(params) = rest.strip_prefix("P=k=") {
        return Some(OscEvent::BlockCommandLine(params.to_string()));
    }
    None
}

fn parse_osc(s: &str) -> Option<OscNotification> {
    // OSC 9 ; <message>
    if let Some(msg) = s.strip_prefix("9;") {
        return Some(OscNotification {
            title: "Terminal".to_string(),
            body: msg.to_string(),
        });
    }
    // OSC 99 ; <title> ; <body>
    if let Some(rest) = s.strip_prefix("99;") {
        let (title, body) = rest.split_once(';').unwrap_or((rest, ""));
        return Some(OscNotification {
            title: title.to_string(),
            body: body.to_string(),
        });
    }
    // OSC 777 ; notify ; <title> ; <body>
    if let Some(rest) = s.strip_prefix("777;notify;") {
        let (title, body) = rest.split_once(';').unwrap_or((rest, ""));
        return Some(OscNotification {
            title: title.to_string(),
            body: body.to_string(),
        });
    }
    None
}

fn parse_osc_52(s: &str) -> Option<String> {
    let rest = s.strip_prefix("52;")?;
    let (_, encoded) = rest.split_once(';').unwrap_or(("", rest));
    if encoded.is_empty() || encoded == "?" {
        return None;
    }
    let decoded = decode_base64(encoded.trim())?;
    let text = String::from_utf8(decoded).ok()?;
    (!text.is_empty()).then_some(text)
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity((value.len() * 3) / 4);
    let mut buffer = 0u32;
    let mut bits = 0usize;

    for byte in value.bytes() {
        let sextet = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            b'\r' | b'\n' | b'\t' | b' ' => continue,
            _ => return None,
        } as u32;

        buffer = (buffer << 6) | sextet;
        bits += 6;

        while bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xff) as u8);
            buffer &= (1u32 << bits).saturating_sub(1);
        }
    }

    Some(output)
}

#[cfg(test)]
mod tests {
    use super::{extract_osc_events, OscEvent};

    #[test]
    fn parses_osc52_clipboard_payload() {
        let input = b"\x1b]52;c;aHR0cHM6Ly9jbGF1ZGUuYWkvbG9naW4=\x07";
        let events = extract_osc_events(input);
        assert!(matches!(events.first(), Some(OscEvent::Clipboard(value)) if value == "https://claude.ai/login"));
    }

    #[test]
    fn parses_osc133_prompt_start() {
        let input = b"\x1b]133;A\x07";
        let events = extract_osc_events(input);
        assert!(matches!(events.first(), Some(OscEvent::BlockPromptStart)));
    }

    #[test]
    fn parses_osc133_command_start() {
        let input = b"\x1b]133;C\x07";
        let events = extract_osc_events(input);
        assert!(matches!(events.first(), Some(OscEvent::BlockCommandStart)));
    }

    #[test]
    fn parses_osc133_command_finished_no_code() {
        let input = b"\x1b]133;D\x07";
        let events = extract_osc_events(input);
        assert!(matches!(events.first(), Some(OscEvent::BlockCommandFinished { exit_code: None })));
    }

    #[test]
    fn parses_osc133_command_finished_with_code() {
        let input = b"\x1b]133;D;42\x07";
        let events = extract_osc_events(input);
        assert!(matches!(events.first(), Some(OscEvent::BlockCommandFinished { exit_code: Some(42) })));
    }

    #[test]
    fn parses_osc133_command_line() {
        let input = b"\x1b]133;P=k=git status\x07";
        let events = extract_osc_events(input);
        assert!(matches!(events.first(), Some(OscEvent::BlockCommandLine(cmd)) if cmd == "git status"));
    }
}
