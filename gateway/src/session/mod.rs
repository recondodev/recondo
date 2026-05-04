use anyhow::Result;

use crate::hash;
use crate::stream;

// ---------------------------------------------------------------------------
// Explicit identity headers (OD-002)
// ---------------------------------------------------------------------------

/// Identity headers explicitly set by the agent or orchestrator.
///
/// These are extracted from HTTP request headers (`X-Recondo-Agent-Id`,
/// `X-Recondo-Session-Id`, `X-Recondo-User-Id`). When present, they override
/// the auto-extracted values from `ClientMetadata` in the capture pipeline.
///
/// **Layer 2 identity (OD-002):** Agents that know their identity (e.g., CI
/// pipelines, orchestrated multi-agent setups) can set these headers to provide
/// deterministic, operator-controlled identity signals instead of relying on
/// heuristic extraction from request bodies.
///
/// **SECURITY:** Same caveat as `ClientMetadata` — these headers are
/// self-asserted by the agent, not cryptographically verified. Do NOT use
/// for access control without cross-referencing a server-verified identity.
#[derive(Debug, Clone, Default)]
pub struct IdentityHeaders {
    /// Explicit agent identifier (e.g., "ci-pipeline-prod", "my-custom-agent").
    pub agent_id: Option<String>,
    /// Explicit session identifier, overrides auto-derived session_id.
    pub session_id: Option<String>,
    /// Explicit user identifier (e.g., email, employee ID).
    pub user_id: Option<String>,
}

/// Extract explicit identity headers from raw HTTP request bytes.
///
/// Parses the HTTP headers (everything before `\r\n\r\n`) and looks for:
/// - `X-Recondo-Agent-Id`
/// - `X-Recondo-Session-Id`
/// - `X-Recondo-User-Id`
///
/// Returns `IdentityHeaders` with `None` for any header not found.
/// Case-insensitive header name matching (per HTTP/1.1 spec).
/// Never panics — returns default (all `None`) on any parse failure.
pub fn extract_identity_headers(raw: &[u8]) -> IdentityHeaders {
    // Convert to string; HTTP headers are ASCII
    let text = match std::str::from_utf8(raw) {
        Ok(t) => t,
        Err(_) => return IdentityHeaders::default(),
    };

    // Find the end of headers
    let header_section = match text.find("\r\n\r\n") {
        Some(pos) => &text[..pos],
        None => text,
    };

    let mut result = IdentityHeaders::default();

    for line in header_section.split("\r\n") {
        if let Some(colon_pos) = line.find(':') {
            let name = line[..colon_pos].trim();
            let value = line[colon_pos + 1..].trim();

            match name.to_ascii_lowercase().as_str() {
                "x-recondo-agent-id" => {
                    result.agent_id = Some(value.to_string());
                }
                "x-recondo-session-id" => {
                    result.session_id = Some(value.to_string());
                }
                "x-recondo-user-id" => {
                    result.user_id = Some(value.to_string());
                }
                _ => {}
            }
        }
    }

    result
}

/// Client-supplied metadata extracted from the Anthropic `metadata.user_id` field.
///
/// Claude Code sends a JSON string inside `metadata.user_id` on every API request
/// containing identity signals: session_id, account_uuid, and device_id.
/// All fields are `Option<String>` — missing or malformed data results in `None`.
///
/// **SECURITY: These values are self-asserted by the agent/CLI, not cryptographically
/// verified by the server. A malicious agent could forge any session_id, account_uuid,
/// or device_id. Do NOT use these fields for access control or authorization decisions
/// without cross-referencing against a server-verified identity (e.g., API key hash,
/// Anthropic organization-id from response headers). Safe for audit attribution and
/// usage analytics.**
#[derive(Debug, Clone, Default)]
pub struct ClientMetadata {
    pub session_id: Option<String>,
    pub account_uuid: Option<String>,
    pub device_id: Option<String>,
}

/// Extract client metadata from raw request bytes.
///
/// Parses the request body as JSON (stripping HTTP headers first if present using
/// `stream::strip_http_headers`), looks for `metadata.user_id` (a JSON string
/// containing nested JSON), and extracts session_id, account_uuid, device_id.
///
/// Returns `ClientMetadata` with `None` fields on any parse failure (never panics).
pub fn extract_client_metadata(request_body: &[u8]) -> ClientMetadata {
    let body = stream::strip_http_headers(request_body);

    let parsed: serde_json::Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        Err(_) => return ClientMetadata::default(),
    };

    let user_id_str = match parsed
        .get("metadata")
        .and_then(|m| m.get("user_id"))
        .and_then(|u| u.as_str())
    {
        Some(s) => s,
        None => return ClientMetadata::default(),
    };

    let nested: serde_json::Value = match serde_json::from_str(user_id_str) {
        Ok(v) => v,
        Err(_) => return ClientMetadata::default(),
    };

    ClientMetadata {
        session_id: nested
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        account_uuid: nested
            .get("account_uuid")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        device_id: nested
            .get("device_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    }
}

/// Tracks the current session state for detecting session boundaries.
#[derive(Debug, Clone)]
pub struct SessionState {
    /// Current session ID — deterministic hash, not a random UUID.
    pub session_id: String,
    /// Next sequence number within the session.
    pub sequence_num: i64,
    /// Timestamp of the last request in ISO 8601 / RFC 3339 format.
    pub last_request_time: String,
    // NOTE (W2 fix): system_prompt_hash was removed from SessionState because it
    // was computed but never used for session identity. The hash is still
    // computed by the caller and stored on the DB SessionRecord.
}

/// The session manager. Derives session identity from client metadata when
/// available, falling back to content-based hashing.
///
/// # Session Identity Model
///
/// When the client sends metadata containing a `session_id` (e.g., Claude Code
/// includes identity signals in `metadata.user_id`), that value is hashed via
/// `sha256_hex` and used as the session ID (H1 normalization).
///
/// When no metadata session_id is available, falls back to content-based
/// derivation: `sha256(len(org):org + "|" + first_user_message_content)`.
///
/// Both paths are deterministic: the same input always produces the same
/// session ID across gateway instances and restarts.
///
/// # Thread safety
///
/// `SessionManager` is **not** concurrency-safe. Each gateway connection
/// handler should have its own instance.
pub struct SessionManager {
    state: Option<SessionState>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// The result of resolving a session for an incoming request.
#[derive(Debug, Clone)]
pub struct SessionResolution {
    /// The session ID (deterministic hash from conversation content).
    pub session_id: String,
    /// The sequence number for this turn within the session.
    pub sequence_num: i64,
    /// Whether this is a new session (first time seeing this session ID).
    pub is_new_session: bool,
}

impl SessionManager {
    /// Create a new session manager with no prior state.
    pub fn new() -> Self {
        SessionManager { state: None }
    }

    /// Resolve the session for an incoming request using client metadata.
    ///
    /// If `metadata` is `Some` and contains a `session_id`, that value is hashed
    /// via `sha256_hex` and used as the session ID (H1 fix: normalizes
    /// client-supplied values to fixed-length safe strings). Otherwise falls back
    /// to content-based derivation from the first user message.
    ///
    /// - `messages`: the full messages array from the request body
    /// - `org_id`: the anthropic-organization-id from response headers (if available)
    /// - `_system_prompt`: the system prompt text (unused here; callers compute the
    ///   hash themselves for the SessionRecord)
    /// - `request_time`: the timestamp of the request in RFC 3339 format
    /// - `current_max_seq`: if known, the maximum sequence_num already persisted in
    ///   the DB for this session. When provided, a "new" session (not yet tracked
    ///   in-memory) resumes from `current_max_seq + 1` instead of 1. This prevents
    ///   sequence number collisions after gateway restarts (B3 fix).
    /// - `metadata`: optional client metadata extracted from the request body
    pub fn resolve(
        &mut self,
        messages: &[serde_json::Value],
        org_id: Option<&str>,
        _system_prompt: Option<&str>,
        request_time: &str,
        current_max_seq: Option<i64>,
        metadata: Option<&ClientMetadata>,
    ) -> Result<SessionResolution> {
        let metadata_session_id = metadata.and_then(|m| m.session_id.clone());

        let session_id = if let Some(ref meta_sid) = metadata_session_id {
            // H1 fix: Normalize client-supplied session_id through sha256_hex
            // to produce a fixed-length, safe string regardless of what the
            // client sends. Still deterministic — same input always produces
            // the same hash.
            hash::sha256_hex(meta_sid.as_bytes())
        } else {
            // No metadata session_id — fall back to content-based derivation.
            content_based_session_id(messages, org_id)
        };

        match &mut self.state {
            Some(current) if current.session_id == session_id => {
                // Same conversation — increment turn counter.
                // NOTE (N2): saturating_add is used to prevent panic on overflow.
                current.sequence_num = current.sequence_num.saturating_add(1);
                current.last_request_time = request_time.to_string();
                Ok(SessionResolution {
                    session_id,
                    sequence_num: current.sequence_num,
                    is_new_session: false,
                })
            }
            _ => {
                // New conversation (or first request after restart).
                // B3 fix: If current_max_seq is provided, resume from that value
                // instead of starting at 1.
                let start_seq = current_max_seq.map(|n| n + 1).unwrap_or(1);
                let resolution = SessionResolution {
                    session_id: session_id.clone(),
                    sequence_num: start_seq,
                    is_new_session: current_max_seq.is_none(),
                };
                self.state = Some(SessionState {
                    session_id,
                    sequence_num: start_seq,
                    last_request_time: request_time.to_string(),
                });
                Ok(resolution)
            }
        }
    }

    /// Get the current session state, if any.
    pub fn current_state(&self) -> Option<&SessionState> {
        self.state.as_ref()
    }
}

/// Derive a deterministic session ID from conversation content (fallback path).
///
/// Used when client metadata does not provide a session_id. Computes
/// `sha256(len(org):org + "|" + first_user_message_content)`.
///
/// W1 fix: Uses `extract_content_text` to get the actual user text, filtering
/// out preamble blocks. If all content is preamble (or no user message exists),
/// falls back to a random UUID to prevent all sessions from colliding.
fn content_based_session_id(messages: &[serde_json::Value], org_id: Option<&str>) -> String {
    // W1 fix: Use extract_content_text for preamble-aware content extraction,
    // matching the logic used by extract_initial_intent and extract_last_user_message.
    let first_user_content = messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .filter_map(extract_content_text)
        .next();

    let content = match first_user_content {
        Some(ref s) if !s.is_empty() => s.as_str(),
        _ => {
            // No user message with non-preamble content — fall back to UUID
            // to prevent all empty/preamble-only sessions from colliding.
            return uuid::Uuid::new_v4().to_string();
        }
    };

    let org = org_id.unwrap_or("unknown");
    let input = format!("{}:{}|{}", org.len(), org, content);
    hash::sha256_hex(input.as_bytes())
}

/// Compute the tentative session ID from metadata and/or messages.
///
/// Used by callers that need the session ID *before* calling `resolve()` —
/// e.g., to query the DB for `current_max_seq`. The logic mirrors what
/// `resolve()` does internally.
pub fn tentative_session_id(
    metadata: &ClientMetadata,
    messages: &[serde_json::Value],
    org_id: Option<&str>,
) -> String {
    if let Some(ref meta_sid) = metadata.session_id {
        hash::sha256_hex(meta_sid.as_bytes())
    } else {
        content_based_session_id(messages, org_id)
    }
}

/// Compute the SHA-256 hash of a system prompt for session records.
///
/// `None` (no system prompt) hashes a sentinel value, while `Some(prompt)` hashes
/// the prompt bytes directly. This ensures `None` and `Some("")` produce distinct hashes.
pub fn compute_system_prompt_hash(system_prompt: Option<&str>) -> String {
    const SENTINEL: &[u8] = b"__RECONDO_NO_SYSTEM_PROMPT__";
    match system_prompt {
        Some(prompt) => hash::sha256_hex(prompt.as_bytes()),
        None => hash::sha256_hex(SENTINEL),
    }
}

/// Compute the SHA-256 hash of tool definitions for session records.
///
/// `None` (no tools key in the request) hashes a sentinel value, while
/// `Some(tools)` serializes the JSON value to a canonical string and hashes it.
/// This ensures `None` and `Some([])` produce distinct hashes.
pub fn compute_tool_definitions_hash(tools: Option<&serde_json::Value>) -> String {
    const SENTINEL: &[u8] = b"__RECONDO_NO_TOOL_DEFINITIONS__";
    match tools {
        Some(tools_value) => {
            let serialized = serde_json::to_string(tools_value).unwrap_or_default();
            hash::sha256_hex(serialized.as_bytes())
        }
        None => hash::sha256_hex(SENTINEL),
    }
}

/// Extract the initial intent from a messages array.
///
/// Finds the first message with `"role": "user"` and extracts its content as a string,
/// skipping preamble blocks (e.g., `<system-reminder>`, `<available-deferred-tools>`).
/// Delegates to `extract_content_text` for consistent preamble filtering (B1 fix).
///
/// If the content is an array (e.g., containing tool_result blocks), the text from the
/// last non-preamble text block is used. If the extracted text exceeds 200 characters,
/// it is truncated to 200 characters and prefixed with `"[auto] "`.
///
/// Returns `None` if no user message with non-preamble content is found.
pub fn extract_initial_intent(messages: &[serde_json::Value]) -> Option<String> {
    // B1 fix: Use extract_content_text (which filters preamble for both string
    // and array content) instead of duplicating content extraction logic.
    // Find the first user message that has non-preamble content.
    let text = messages
        .iter()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .filter_map(extract_content_text)
        .next()?;

    if text.is_empty() {
        return None;
    }

    if text.chars().count() > 200 {
        let truncated: String = text.chars().take(200).collect();
        Some(format!("[auto] {}", truncated))
    } else {
        Some(text)
    }
}

/// Extract the last user message text from a messages array.
///
/// Iterates the messages array in reverse, finds the last message with
/// `"role": "user"`, and extracts its text content using `extract_content_text`
/// (which filters preamble blocks for both Anthropic and Gemini formats).
///
/// Returns `None` if no user message with non-preamble content is found.
/// Does NOT truncate — the caller is responsible for applying any length limit.
pub fn extract_last_user_request_text(messages: &[serde_json::Value]) -> Option<String> {
    let text = messages
        .iter()
        .rev()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .filter_map(extract_content_text)
        .next()?;

    if text.is_empty() {
        return None;
    }

    Some(text)
}

/// Extract the last user message from a messages_delta JSON string.
///
/// Parses the JSON as `Vec<serde_json::Value>`, finds the last message with
/// `"role": "user"`, skips messages whose content starts with
/// `<available-deferred-tools>` (Claude Code preamble), extracts the text
/// content, and truncates to 500 chars if longer.
///
/// Returns `None` for empty, null, or invalid input.
pub fn extract_last_user_message(messages_delta_json: &str) -> Option<String> {
    let arr: Vec<serde_json::Value> = serde_json::from_str(messages_delta_json).ok()?;

    // N1 fix: The outer is_preamble guard is no longer needed because
    // extract_content_text now filters preamble for both string and array
    // content paths (W2 fix). A single filter_map + next suffices.
    let text = arr
        .iter()
        .rev()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .filter_map(extract_content_text)
        .next()?;

    if text.is_empty() {
        return None;
    }

    if text.chars().count() > 500 {
        let truncated: String = text.chars().take(500).collect();
        Some(format!("{}...", truncated))
    } else {
        Some(text)
    }
}

/// Helper: extract text content from a message Value.
/// If content is a string, return it (filtering preamble). If content is an
/// array, iterate in REVERSE to find the LAST non-preamble
/// `{"type":"text","text":"..."}` block and return its text. Claude Code sends
/// the user's actual message as the last text block, with system-injected
/// preambles (e.g., `<system-reminder>`, `<available-deferred-tools>`,
/// `<task-notification>`) as earlier blocks.
///
/// Returns `None` when no displayable non-preamble text is found. This is
/// intentional: callers (like `extract_last_user_message`) correctly skip
/// these messages via `filter_map`.
pub(crate) fn extract_content_text(msg: &serde_json::Value) -> Option<String> {
    // Anthropic format: messages have a `content` field (string or array of blocks).
    if let Some(content) = msg.get("content") {
        if let Some(s) = content.as_str() {
            // W2 fix: Apply preamble filtering to the string path too.
            // Previously only the array path filtered preamble, so a plain-string
            // content that started with a preamble marker would leak through.
            return if is_preamble(s) {
                None
            } else {
                Some(s.to_string())
            };
        } else if let Some(arr) = content.as_array() {
            // Iterate in reverse: the user's real message is typically the LAST
            // non-preamble text block in the content array.
            return arr.iter().rev().find_map(|block| {
                let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                if block_type == "text" || block_type == "input_text" {
                    let text = block.get("text").and_then(|t| t.as_str())?;
                    if is_preamble(text) {
                        None
                    } else {
                        Some(text.to_string())
                    }
                } else {
                    // W2: Non-text content blocks (images, tool_result, etc.) have no
                    // displayable text — returning None here is intentional.
                    None
                }
            });
        }
        // W2: Content is neither a string nor an array (e.g., null or number) —
        // no displayable text to extract.
        return None;
    }

    // Gemini format: messages have a `parts` array with `{text: "..."}` objects.
    // Used by Gemini CLI (cloudcode-*) requests where `contents` items have
    // `{"role": "user", "parts": [{"text": "..."}]}`.
    if let Some(parts) = msg.get("parts").and_then(|p| p.as_array()) {
        // Iterate in reverse to find the last non-preamble text part.
        return parts.iter().rev().find_map(|part| {
            let text = part.get("text").and_then(|t| t.as_str())?;
            if is_preamble(text) {
                None
            } else {
                Some(text.to_string())
            }
        });
    }

    None
}

/// Check whether a text block is a system-injected preamble.
///
/// Claude Code injects preamble text blocks into the content array before the
/// user's actual message. These blocks start with one of:
/// - `<system-reminder>` — CLAUDE.md contents, skills, context
/// - `<available-deferred-tools>` — deferred tool listings
/// - `<task-notification>` — pending task notifications
///
/// N2: Add new markers here as Claude Code evolves. The marker list is intentionally
/// kept as simple `starts_with` checks rather than a regex or config file, because
/// (a) false positives from user text starting with these XML tags are negligible
/// (N3 trade-off: the probability of a real user message starting with e.g.
/// `<system-reminder>` is effectively zero, and the cost of a false positive is
/// merely omitting one message from intent/session-id — not data loss), and
/// (b) compile-time checking catches typos.
///
/// N4: This function assumes preamble blocks always appear as the leading content
/// of a text block (i.e., `starts_with`). If Claude Code ever injects preamble
/// mid-block or as a suffix, this heuristic would need updating. In practice,
/// preamble is always injected as separate, complete content blocks at the start
/// of the content array, so prefix matching is reliable.
fn is_preamble(text: &str) -> bool {
    text.starts_with("<system-reminder>")
        || text.starts_with("<available-deferred-tools>")
        || text.starts_with("<task-notification>")
        // Codex preamble patterns
        || text.starts_with("<permissions instructions>")
        || text.starts_with("<permissions_instructions>")
        || text.starts_with("<environment_context>")
        || text.starts_with("<skills_instructions>")
        // Gemini CLI preamble patterns
        || text.starts_with("<session_context>")
        // Bug #2 fix: Claude Code emits a "[Image: source: /Users/.../<uuid>/N.png]"
        // placeholder text block alongside an image attachment. Treat it as a
        // preamble-like block and skip during user-request extraction so the
        // stored `turns.user_request_text` never exposes a local filesystem
        // path. The `extract_content_text` reverse walk will fall back to an
        // earlier real text block when one exists, or yield None when the
        // placeholder was the only text content.
        || is_image_source_placeholder(text)
}

/// Returns true for attachment-sibling placeholder text blocks Claude Code
/// (and other CLI agents) emit as a sibling of an `image` / `document` /
/// `file` content block.
///
/// Matches shapes like:
/// * `[Image: source: /Users/x/.claude/image-cache/<uuid>/1.png]`
/// * `[PDF: source: /Users/x/Downloads/report.pdf]`
/// * `[Document: source: /Users/x/docs/spec.md]`
/// * `[File: source: ...]`
/// * `[Attachment: source: ...]`
///
/// FIND-1-B false-positive fix: the prior heuristic flagged any bracketed
/// text starting with `[Image:` and ending with `]` as a placeholder. That
/// matched legitimate user messages like `[Image: can you describe this
/// icon?]` or `[Image: 2 of 3]`, which would then get dropped from
/// `user_request_text`. We now additionally require the literal substring
/// `source:` after the marker prefix — only the Claude-Code-emitted
/// placeholders carry that marker, so real user prose is retained.
///
/// FIND-1-C PDF/Document coverage: the `AttachmentKind::Pdf` and
/// `AttachmentKind::Document` variants are emitted as sibling
/// placeholders with the same structural shape, so the heuristic covers
/// them explicitly here rather than only matching `[Image:`.
///
/// Implementation detail: avoids a `regex` dependency by doing prefix +
/// substring + suffix + newline checks.
fn is_image_source_placeholder(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() || !trimmed.ends_with(']') || trimmed.contains('\n') {
        return false;
    }
    // The literal `source:` is the marker Claude Code always emits for
    // these placeholders; required to avoid false positives against real
    // user text that happens to be bracketed.
    if !trimmed.contains("source:") {
        return false;
    }
    placeholder_prefixes()
        .iter()
        .any(|p| trimmed.starts_with(p.as_str()))
}

/// FIND-3-TS-3 / FIND-1-M: single source of truth for
/// attachment-sibling placeholder prefixes. The JSON file at
/// `shared/placeholder-prefixes.json` is the canonical list; Rust
/// (here) and TypeScript (`api/src/placeholder-mask.ts`) both consume
/// the same file so a Rust-side change can't silently drift from the
/// dashboard-side list.
///
/// Embedded at compile time via `include_str!` + parsed once via
/// `OnceLock`, so steady-state calls are a pointer-compare.
pub fn placeholder_prefixes() -> &'static [String] {
    use std::sync::OnceLock;
    static PREFIXES: OnceLock<Vec<String>> = OnceLock::new();
    PREFIXES.get_or_init(|| {
        const RAW: &str = include_str!("../../../shared/placeholder-prefixes.json");
        let parsed: serde_json::Value =
            serde_json::from_str(RAW).expect("shared/placeholder-prefixes.json must be valid JSON");
        parsed
            .get("prefixes")
            .and_then(|v| v.as_array())
            .expect("shared/placeholder-prefixes.json must have `prefixes` array")
            .iter()
            .map(|v| v.as_str().expect("prefix must be a string").to_string())
            .collect()
    })
}

/// FIND-3-TS-3 / FIND-1-M: the replacement string used wherever we
/// render-time mask a placeholder. Loaded from the same shared JSON so
/// the Rust and TypeScript sides agree.
pub fn placeholder_replacement() -> &'static str {
    use std::sync::OnceLock;
    static REPL: OnceLock<String> = OnceLock::new();
    REPL.get_or_init(|| {
        const RAW: &str = include_str!("../../../shared/placeholder-prefixes.json");
        let parsed: serde_json::Value =
            serde_json::from_str(RAW).expect("shared/placeholder-prefixes.json must be valid JSON");
        parsed
            .get("replacement")
            .and_then(|v| v.as_str())
            .expect("shared/placeholder-prefixes.json must have `replacement` string")
            .to_string()
    })
    .as_str()
}

/// Detect the agent framework from a system prompt.
///
/// Checks the system prompt for known framework signatures using case-insensitive
/// substring matching. Returns the framework identifier if a match is found:
/// - `"claude_code"` — system prompt contains "Claude Code" (the complete phrase)
/// - `"cursor"` — system prompt contains "Cursor"
/// - `"aider"` — system prompt contains "Aider"
/// - `"gemini_cli"` — system prompt contains "Gemini CLI" (the complete phrase)
///
/// S-N6 fix: Matches are priority-ordered (first match wins). If a system prompt
/// contains signatures for multiple frameworks (e.g., both "Claude Code" and
/// "Cursor"), the first matching entry in the list above takes precedence.
///
/// Returns `None` for empty prompts or if no known framework is detected.
pub fn detect_agent_framework(system_prompt: &str) -> Option<String> {
    if system_prompt.is_empty() {
        return None;
    }

    let lower = system_prompt.to_lowercase();

    // Check for "Claude Code" as a complete phrase (not just "Claude")
    if lower.contains("claude code") {
        return Some("claude_code".to_string());
    }

    if lower.contains("cursor") {
        return Some("cursor".to_string());
    }

    if lower.contains("aider") {
        return Some("aider".to_string());
    }

    // "gemini cli" as a phrase — not just "gemini" alone, which is too broad
    if lower.contains("gemini cli") {
        return Some("gemini_cli".to_string());
    }

    None
}
