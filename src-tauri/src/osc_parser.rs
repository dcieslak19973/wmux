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
