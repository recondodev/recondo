//! Request-interception decisions: percent-decoding, path normalisation, and
//! the per-provider `should_intercept` policy. Split out of `gateway/mod.rs`
//! per the Batch 6 H2 audit follow-up.

// ---------------------------------------------------------------------------
// Request interception logic
// ---------------------------------------------------------------------------

/// Whether a decrypted HTTP request inside the tunnel should be captured.
///
/// Currently captures:
/// - `POST /v1/messages` (Anthropic Messages API)
/// - `POST /v1/chat/completions` (OpenAI Chat Completions API)
///
/// Does NOT capture:
/// - GET requests
/// - Other POST paths
/// - Non-HTTP data
///
/// Fields remain `pub` because existing integration tests assert on them directly
/// (e.g., `decision.should_capture`, `decision.method.as_deref()`). Making them
/// private would break those test assertions, which we must not modify.
#[derive(Debug, Clone, PartialEq)]
pub struct InterceptDecision {
    /// Whether to capture this request/response pair.
    pub should_capture: bool,
    /// The HTTP method, if detected.
    pub method: Option<String>,
    /// The HTTP path, if detected. Query strings are stripped before storage
    /// to prevent API key leakage in structured logs (e.g., Gemini `?key=...`).
    pub path: Option<String>,
}

/// Known HTTP methods used to detect whether bytes look like an HTTP request.
/// CONNECT is excluded because it is only used for the outer gateway handshake
/// (the CONNECT line is handled by parse_connect_request). Inside the MITM
/// tunnel, the decrypted traffic uses standard methods like GET, POST, etc.
const HTTP_METHODS: &[&str] = &[
    "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE",
];

/// Percent-decode a string, handling %XX sequences.
/// Only decodes valid two-digit hex sequences; invalid sequences are left as-is.
///
/// Returns `Err` if the decoded bytes are not valid UTF-8. Callers should treat
/// decode failure as a non-capturable request (the path is not meaningful text).
fn percent_decode(input: &str) -> Result<String, std::str::Utf8Error> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = bytes[i + 1];
            let lo = bytes[i + 2];
            if let (Some(h), Some(l)) = (hex_val(hi), hex_val(lo)) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    // Safe conversion: returns Err if the decoded bytes are not valid UTF-8.
    // The compiler optimizes this equivalently to the previous unsafe variant.
    match String::from_utf8(out) {
        Ok(s) => Ok(s),
        Err(e) => Err(e.utf8_error()),
    }
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Normalize a path by collapsing double slashes and resolving `.` and `..` segments.
///
/// Note on `..` handling: `..` segments can pop earlier path components, which may
/// produce unexpected matches (e.g., `/v1/foo/../messages` normalizes to `/v1/messages`).
/// This is intentional for a governance gateway -- we err on the side of capturing more
/// traffic rather than less, so a client cannot evade capture via path traversal tricks.
fn normalize_path(path: &str) -> String {
    let mut segments: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => continue,
            ".." => {
                segments.pop();
            }
            s => segments.push(s),
        }
    }
    format!("/{}", segments.join("/"))
}

/// Check if a normalized path matches a Gemini generation endpoint pattern:
/// - `/v1beta/models/{model_name}/generateContent`
/// - `/v1beta/models/{model_name}/streamGenerateContent`
///
/// Uses path segment matching (not regex) for clarity and performance.
/// The model name segment must be non-empty and is treated as a wildcard.
fn is_gemini_generation_path(path: &str) -> bool {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    // Standard Gemini API: /v1beta/models/<model>/generateContent|streamGenerateContent
    if segments.len() == 4
        && segments[0] == "v1beta"
        && segments[1] == "models"
        && !segments[2].is_empty()
        && (segments[3] == "generateContent" || segments[3] == "streamGenerateContent")
    {
        return true;
    }
    // Gemini CLI uses cloudcode-{region}.googleapis.com with /v1internal: prefix.
    // Paths: /v1internal:generateContent, /v1internal:streamGenerateContent
    let normalized = path.trim_start_matches('/');
    if normalized == "v1internal:generateContent"
        || normalized == "v1internal:streamGenerateContent"
    {
        return true;
    }
    false
}

/// Inspect decrypted bytes from the tunnel and decide whether to capture.
///
/// Looks for an HTTP request line (e.g., `POST /v1/messages HTTP/1.1`)
/// and determines if it matches a capturable endpoint.
///
/// # Caller contract
///
/// Only the first HTTP request line is inspected — callers should pass at
/// most the first 8 KB of the decrypted stream. Passing the entire
/// request body is safe but wasteful; the function never reads past the
/// first line.
pub fn should_intercept(decrypted_bytes: &[u8], provider: &str) -> InterceptDecision {
    if decrypted_bytes.is_empty() {
        return InterceptDecision {
            should_capture: false,
            method: None,
            path: None,
        };
    }

    // Strict UTF-8 check: non-UTF-8 bytes cannot be a valid HTTP request line.
    // Return a non-capture decision rather than silently replacing invalid bytes.
    let text = match std::str::from_utf8(decrypted_bytes) {
        Ok(s) => s,
        Err(_) => {
            return InterceptDecision {
                should_capture: false,
                method: None,
                path: None,
            };
        }
    };

    // Get the first line
    let first_line = match text.lines().next() {
        Some(line) => line.trim(),
        None => {
            return InterceptDecision {
                should_capture: false,
                method: None,
                path: None,
            };
        }
    };

    // Split into parts: METHOD /path HTTP/1.x
    let parts: Vec<&str> = first_line.split_whitespace().collect();

    if parts.len() < 2 {
        return InterceptDecision {
            should_capture: false,
            method: None,
            path: None,
        };
    }

    let method = parts[0];
    let path = parts[1];

    // Check if this looks like an HTTP request (starts with a known method)
    if !HTTP_METHODS.contains(&method) {
        return InterceptDecision {
            should_capture: false,
            method: None,
            path: None,
        };
    }

    // Validate HTTP version token if present
    if parts.len() >= 3 && !parts[2].starts_with("HTTP/") {
        // Invalid HTTP version token — treat as non-HTTP
        return InterceptDecision {
            should_capture: false,
            method: None,
            path: None,
        };
    }

    // Strip query string for path matching
    let base_path = path.split('?').next().unwrap_or(path);

    // Percent-decode and normalize the path to prevent encoding bypass.
    //
    // Single-decode invariant: we decode percent-encoding exactly once. Double-
    // encoding (e.g., `%2525` -> `%25` -> `%`) is intentionally NOT handled,
    // because HTTP intermediaries normalize percent-encoding before forwarding.
    // A single decode is sufficient to catch evasion attempts like `%2F` for `/`.
    let decoded_path = match percent_decode(base_path) {
        Ok(d) => d,
        Err(_) => {
            // Decoded bytes are not valid UTF-8 -- not a meaningful HTTP path.
            // Treat as non-capturable. Store base_path (query-stripped) to
            // avoid leaking API keys from query parameters into logs.
            return InterceptDecision {
                should_capture: false,
                method: Some(method.to_string()),
                path: Some(base_path.to_string()),
            };
        }
    };
    let normalized_path = normalize_path(&decoded_path);

    // Check for Gemini generation endpoints: /v1beta/models/*/generateContent
    // and /v1beta/models/*/streamGenerateContent. The wildcard matches any
    // model name segment.
    let is_gemini_endpoint = is_gemini_generation_path(&normalized_path);

    // Check if this host is served by a generic YAML adapter — if so, capture
    // all POST requests regardless of path.
    let is_generic_provider = !matches!(provider, "anthropic" | "openai" | "google" | "unknown")
        && !crate::providers::generic_adapter_configs().is_empty();

    // Determine if this is a capturable endpoint
    let is_post_api = method == "POST"
        && (normalized_path == "/v1/messages"
            || normalized_path == "/v1/chat/completions"
            || normalized_path.starts_with("/backend-api/codex/")
            || is_gemini_endpoint
            || is_generic_provider);

    // Codex WebSocket upgrade: GET /backend-api/codex/... with Upgrade: websocket.
    // Only flag as capturable if the Upgrade: websocket header is actually present,
    // to avoid capturing non-WebSocket GET requests to Codex endpoints.
    let is_codex_ws = method == "GET"
        && normalized_path.starts_with("/backend-api/codex/")
        && has_upgrade_websocket_header(text);

    let should_capture = is_post_api || is_codex_ws;

    InterceptDecision {
        should_capture,
        method: Some(method.to_string()),
        path: Some(base_path.to_string()),
    }
}

/// Check whether the HTTP request text contains an `Upgrade: websocket` header
/// (case-insensitive). Used by `should_intercept` to distinguish WebSocket
/// upgrade requests from regular GET requests.
fn has_upgrade_websocket_header(request_text: &str) -> bool {
    for line in request_text.lines().skip(1) {
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.trim().eq_ignore_ascii_case("upgrade")
                && value.trim().eq_ignore_ascii_case("websocket")
            {
                return true;
            }
        }
    }
    false
}
