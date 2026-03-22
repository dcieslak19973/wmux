/// Scans terminal output for localhost URLs worth surfacing to the user —
/// primarily OAuth callback servers and local dev servers that CLIs spin up
/// during authentication flows (e.g. `gh auth login`, `gcloud auth login`,
/// `az login`, GitHub Copilot device-flow, etc.).
///
/// This mirrors VS Code's "local port forwarding" / "OAuth redirect" detection
/// but runs entirely locally — no SSH tunnel needed since wmux is native.

/// Strip ANSI/VT escape sequences from a byte slice.
/// Handles CSI (`ESC [`), OSC (`ESC ]`), and 2-char sequences.
/// Made `pub` so other modules (e.g. session_manager) can use it for capture-pane.
pub fn strip_ansi(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == 0x1b {
            i += 1;
            if i >= data.len() {
                break;
            }
            match data[i] {
                b'[' => {
                    // CSI: ESC [ <params> <final 0x40-0x7e>
                    i += 1;
                    while i < data.len() && !(0x40..=0x7e).contains(&data[i]) {
                        i += 1;
                    }
                    i += 1; // consume final byte
                }
                b']' => {
                    // OSC: ESC ] <text> ST (BEL or ESC \)
                    i += 1;
                    while i < data.len() {
                        if data[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if data[i] == 0x1b && i + 1 < data.len() && data[i + 1] == b'\\' {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                _ => {
                    i += 1; // 2-char escape: skip
                }
            }
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    out
}

/// Extract notable localhost URLs from a raw terminal output chunk.
///
/// Returns `(url, is_oauth)` pairs. Ignores external / non-localhost URLs.
/// Deduplication across chunks is the caller's responsibility.
pub fn extract_notable_urls(data: &[u8]) -> Vec<(String, bool)> {
    let clean = strip_ansi(data);
    let text = String::from_utf8_lossy(&clean);
    let bytes = text.as_bytes();
    let mut results = Vec::new();
    let mut i = 0;

    while i < bytes.len() {
        let rest = &bytes[i..];
        let is_http = rest.starts_with(b"http://");
        let is_https = rest.starts_with(b"https://");

        if is_http || is_https {
            let start = i;
            // Consume URL-valid characters
            while i < bytes.len()
                && !matches!(
                    bytes[i],
                    b' ' | b'\n' | b'\r' | b'\t' | b'"' | b'\'' | b'`'
                        | b')' | b']' | b'>' | b',' | b';'
                )
            {
                i += 1;
            }
            // Trim trailing punctuation that likely isn't part of the URL
            while i > start && matches!(bytes[i - 1], b'.' | b',' | b';' | b':' | b'!') {
                i -= 1;
            }

            let url = &text[start..i];

            // Only surface localhost / loopback URLs
            if url.contains("localhost") || url.contains("127.0.0.1") {
                // Require a port — avoids false-positives like
                // `http://localhost.attacker.com`
                if has_explicit_port(url) {
                    let oauth = is_oauth_hint(url);
                    results.push((url.to_string(), oauth));
                }
            }
        } else {
            i += 1;
        }
    }

    results
}

/// Returns true if the URL contains an explicit port number after the host.
fn has_explicit_port(url: &str) -> bool {
    // Strip scheme
    let after_scheme = if let Some(s) = url.strip_prefix("https://") {
        s
    } else if let Some(s) = url.strip_prefix("http://") {
        s
    } else {
        return false;
    };
    // The host section ends at the first `/` or end of string
    let host_part = after_scheme.split('/').next().unwrap_or("");
    // Port is present if host_part contains `:` (and it's followed by digits)
    if let Some(colon_pos) = host_part.rfind(':') {
        let port_str = &host_part[colon_pos + 1..];
        !port_str.is_empty() && port_str.chars().all(|c| c.is_ascii_digit())
    } else {
        false
    }
}

/// Heuristic: does this URL look like an OAuth callback or auth initiation?
fn is_oauth_hint(url: &str) -> bool {
    let l = url.to_lowercase();
    l.contains("/callback")
        || l.contains("/oauth")
        || l.contains("/auth")
        || l.contains("/login")
        || l.contains("/authorize")
        || l.contains("code=")
        || l.contains("token=")
        || l.contains("access_token")
        || l.contains("redirect_uri")
        || l.contains("device")
}

/// Validate that a URL is safe to open as a system URL.
/// Only allows localhost / 127.0.0.1 with an explicit port.
pub fn is_safe_to_open(url: &str) -> bool {
    (url.starts_with("http://localhost:")
        || url.starts_with("https://localhost:")
        || url.starts_with("http://127.0.0.1:")
        || url.starts_with("https://127.0.0.1:"))
        && has_explicit_port(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_oauth_callback() {
        let input = b"Open your browser at http://localhost:3000/callback?code=abc123\r\n";
        let urls = extract_notable_urls(input);
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].0, "http://localhost:3000/callback?code=abc123");
        assert!(urls[0].1, "should be flagged as oauth");
    }

    #[test]
    fn strips_ansi_before_detecting() {
        let input = b"\x1b[32mOpen: http://localhost:8080/\x1b[0m\r\n";
        let urls = extract_notable_urls(input);
        assert_eq!(urls.len(), 1);
        assert_eq!(urls[0].0, "http://localhost:8080/");
    }

    #[test]
    fn ignores_external_urls() {
        let input = b"See https://github.com/foo/bar for more info\n";
        assert!(extract_notable_urls(input).is_empty());
    }

    #[test]
    fn ignores_localhost_without_port() {
        // Prevents confusion with `http://localhost.malicious.com`
        let input = b"http://localhost/path\n";
        assert!(extract_notable_urls(input).is_empty());
    }

    #[test]
    fn detects_dev_server() {
        let input = b"  Local:   http://127.0.0.1:5173/\n";
        let urls = extract_notable_urls(input);
        assert_eq!(urls.len(), 1);
        assert!(!urls[0].1, "plain dev server should not be flagged as oauth");
    }

    #[test]
    fn safe_to_open_validation() {
        assert!(is_safe_to_open("http://localhost:3000/callback"));
        assert!(is_safe_to_open("https://127.0.0.1:8080/"));
        assert!(!is_safe_to_open("http://localhost/nope")); // no port
        assert!(!is_safe_to_open("https://example.com"));   // external
    }
}
