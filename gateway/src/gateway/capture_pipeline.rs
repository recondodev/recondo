//! Production capture-orchestration pipeline: provider parsing, session
//! resolution, WAL append, object-store write, graph-store insert, and
//! attachment extraction. Split out of `gateway/mod.rs` per the Batch 6 H2
//! audit follow-up.

use anyhow::{Context, Result};

use tracing::{info, warn};

use crate::providers;

use super::trace::last_user_message_slice;
use super::{block_on_future, external_url_budget_ms, external_url_max_per_turn};

// ---------------------------------------------------------------------------
// Production capture orchestration
// ---------------------------------------------------------------------------

/// Maximum size (in bytes) for a single captured request or response payload.
/// Payloads exceeding this limit are rejected to prevent memory exhaustion and
/// storage abuse. 50 MB is generous for any LLM API call.
pub(super) const MAX_CAPTURE_BYTES: usize = 50 * 1024 * 1024; // 50 MB

#[non_exhaustive]
#[derive(Debug)]
pub enum CaptureError {
    RequestTooLarge {
        actual: usize,
        max: usize,
    },
    ResponseTooLarge {
        actual: usize,
        max: usize,
    },
    WalAppendFailed {
        mode: crate::wal::FailMode,
        source: anyhow::Error,
    },
    StoreFailed(anyhow::Error),
    ParseFailed(anyhow::Error),
    SessionResolutionFailed(anyhow::Error),
    DbWriteFailed(anyhow::Error),
    Other(anyhow::Error),
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        use CaptureError::*;
        match self {
            RequestTooLarge { actual, max } => {
                write!(
                    f,
                    "request payload too large: {} bytes (max {} bytes)",
                    actual, max
                )
            }
            ResponseTooLarge { actual, max } => {
                write!(
                    f,
                    "response payload too large: {} bytes (max {} bytes)",
                    actual, max
                )
            }
            WalAppendFailed { mode, source } => {
                write!(f, "WAL append failed in {:?} mode: {}", mode, source)
            }
            StoreFailed(e) => write!(f, "object store failed: {}", e),
            ParseFailed(e) => write!(f, "parse failed: {}", e),
            SessionResolutionFailed(e) => write!(f, "session resolution failed: {}", e),
            DbWriteFailed(e) => write!(f, "DB write failed: {}", e),
            Other(e) => write!(f, "{}", e),
        }
    }
}

impl std::error::Error for CaptureError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        use CaptureError::*;
        match self {
            WalAppendFailed { source, .. } => Some(source.as_ref()),
            StoreFailed(e)
            | ParseFailed(e)
            | SessionResolutionFailed(e)
            | DbWriteFailed(e)
            | Other(e) => Some(e.as_ref()),
            RequestTooLarge { .. } | ResponseTooLarge { .. } => None,
        }
    }
}

impl From<anyhow::Error> for CaptureError {
    fn from(e: anyhow::Error) -> Self {
        CaptureError::Other(e)
    }
}

pub(super) fn elapsed_millis(start: std::time::Instant) -> i64 {
    start.elapsed().as_millis().min(i64::MAX as u128) as i64
}

/// Estimate the number of thinking tokens from thinking text.
///
/// Uses a word-count heuristic: ~1.3 tokens per word (typical for English text
/// in LLM tokenizers). Returns 0 when thinking_text is None or empty.
/// This is a best-effort estimate; the actual token count depends on the
/// model's tokenizer and is not available from the response metadata.
pub(crate) fn estimate_thinking_tokens(thinking_text: Option<&str>) -> i64 {
    match thinking_text {
        Some(text) if !text.is_empty() => {
            let word_count = text.split_whitespace().count();
            // Approximate 1.3 tokens per word (conservative for English text).
            // INFO-1: f64→i64 cast is safe: word_count * 1.3 is always a small
            // positive number (thinking text is at most ~100K words ≈ 130K tokens,
            // well within i64::MAX).
            (word_count as f64 * 1.3).ceil() as i64
        }
        _ => 0,
    }
}

// ---------------------------------------------------------------------------
// B1 fix: Extract org_id from response headers
// ---------------------------------------------------------------------------

/// Extract the `anthropic-organization-id` header from raw response bytes.
///
/// The response bytes include HTTP headers (before `strip_http_headers` removes
/// them). We use `stream::extract_headers()` to get the header portion, then
/// search for the org ID header (case-insensitive).
///
/// Returns `None` if no headers are found or the header is not present.
pub(crate) fn extract_org_id(response_bytes: &[u8]) -> Option<String> {
    let headers = crate::stream::extract_headers(response_bytes)?;
    for line in headers.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("anthropic-organization-id:") {
            return Some(line.split_once(':')?.1.trim().to_string());
        }
    }
    None
}

/// Query the graph store for the maximum sequence number for a given session.
///
/// Used by process_capture_with_pipeline to recover sequence state after
/// gateway restarts (B3 fix).
pub(super) fn get_max_sequence_from_graph(
    graph: &dyn crate::storage::graph::GraphStore,
    session_id: &str,
) -> Option<i64> {
    match graph.get_turns_for_session(session_id) {
        Ok(turns) => turns.iter().map(|t| t.sequence_num).max(),
        Err(_) => None,
    }
}

// ---------------------------------------------------------------------------
// Shared provider parsing (N3: single source of truth for all capture paths)
// ---------------------------------------------------------------------------

/// Parsed fields extracted from provider-specific request/response data.
///
/// This struct is populated by `parse_capture_data` and consumed by
/// `process_capture_with_pipeline`. Centralising the parsing logic here
/// ensures that fixes (e.g., chunked TE decoding, header stripping) are
/// applied exactly once.
pub struct ParsedFields {
    /// Model name (e.g., "gpt-4o-2024-05-13", "claude-sonnet-4-20250514").
    pub model: Option<String>,
    /// Response text extracted from the provider-specific format.
    pub response_text: Option<String>,
    /// Thinking/reasoning text (Anthropic extended thinking).
    pub thinking_text: Option<String>,
    /// Stop reason (e.g., "stop", "end_turn", "tool_calls").
    pub stop_reason: String,
    /// Input (prompt) token count.
    pub input_tokens: i64,
    /// Output (completion) token count.
    pub output_tokens: i64,
    /// Cache read tokens (Anthropic/OpenAI cache hit).
    pub cache_read_tokens: i64,
    /// Cache creation tokens (Anthropic cache write).
    pub cache_creation_tokens: i64,
    /// System prompt extracted from the request body.
    pub system_prompt: Option<String>,
    /// Tool calls extracted from the response.
    pub tool_calls: Vec<crate::providers::anthropic::ToolCall>,
    /// Whether the capture was complete (all SSE events received).
    pub capture_complete: bool,
    /// Unknown/extra fields preserved as JSON string.
    pub raw_extra: Option<String>,
    /// Parser version used for forward compatibility.
    pub parser_version: Option<String>,
    /// Parse errors encountered during extraction.
    pub parse_errors: Option<Vec<String>>,
    /// Messages array from the request body.
    pub messages: Vec<serde_json::Value>,
    /// Tool definitions from the request body (used for tool drift detection).
    pub tools: Option<Vec<serde_json::Value>>,
    /// Thinking tokens reported by the provider's usage metadata (e.g., Gemini
    /// `usageMetadata.thoughtsTokenCount`). When `Some`, this overrides the
    /// heuristic estimate from `thinking_text`. `None` means the provider did
    /// not report thinking tokens and the heuristic should be used.
    pub thinking_tokens: Option<i64>,
    /// Client-provided session ID extracted from the request body (e.g., Gemini
    /// CLI `request.session_id`). Used for session identity when no explicit
    /// identity header is present.
    pub client_session_id: Option<String>,
    /// Whether this request is an agent-internal probe (e.g. Claude Code's
    /// quota/connectivity preflight at session start, which sends
    /// `max_tokens=1` with a placeholder user message). Preflights should not
    /// influence session-level fields like `initial_intent` because they don't
    /// represent real user intent. Currently only the Anthropic branch sets
    /// this; other providers default to `false`.
    pub is_preflight: bool,
}

/// Parse provider-specific request and response bytes into structured fields.
///
/// This is the single source of truth for the response/request preparation
/// pipeline:
/// 1. Strip HTTP headers from raw captured bytes.
/// 2. Decode chunked transfer encoding if the headers indicate it (W1 fix).
/// 3. Parse SSE events (Anthropic, Google) or skip parsing (unknown providers).
/// 4. Parse request body for providers that support it.
///
/// Both Anthropic and Google request bytes are stripped of HTTP headers (W2 fix).
///
/// FIND-1-2 (audit Round-1): merge two `parse_errors` vectors so request-side
/// drift reaches `TurnRecord.parse_errors` alongside response-side drift. Used
/// by every provider branch that exposes request-side `parse_errors` (Gemini
/// CLI, standard Gemini, Generic adapter). Anthropic and OpenAI request
/// parsers raise hard errors instead of accumulating drift, so their request
/// side has no `parse_errors` to merge — this helper is unused there.
pub(super) fn merge_parse_errors(
    a: Option<Vec<String>>,
    b: Option<Vec<String>>,
) -> Option<Vec<String>> {
    match (a, b) {
        (None, None) => None,
        (a, b) => {
            let merged: Vec<String> = a
                .into_iter()
                .flatten()
                .chain(b.into_iter().flatten())
                .collect();
            if merged.is_empty() {
                None
            } else {
                Some(merged)
            }
        }
    }
}

pub fn parse_capture_data(
    provider: &str,
    request_bytes: &[u8],
    response_bytes: &[u8],
) -> ParsedFields {
    use crate::stream;

    match provider {
        "anthropic" => {
            // Prepare response body: strip headers, decode chunked TE if present.
            let response_body = stream::prepare_response_body(response_bytes);
            let request_body = stream::strip_http_headers(request_bytes);

            // Anthropic responses come in two shapes:
            //   - SSE (`text/event-stream`) for normal streaming /v1/messages calls
            //   - One-shot JSON (`application/json`) for non-streaming calls,
            //     including Claude Code's quota preflight at session start
            //     (POST /v1/messages with max_tokens=1, no `stream: true`).
            // Branch on Content-Type so the JSON probe doesn't fall into the
            // SSE accumulator and emit a "No message_start event" parse error.
            let content_type = stream::extract_headers(response_bytes)
                .as_deref()
                .and_then(stream::extract_content_type);
            let is_json_response = content_type
                .as_deref()
                .map(|ct| ct == "application/json")
                .unwrap_or(false);

            let (parsed_resp_result, capture_complete) = if is_json_response {
                let result = crate::providers::anthropic::parse_response_json(&response_body);
                let complete = result.is_ok();
                (result, complete)
            } else {
                let accumulated = stream::parse_sse_stream(&response_body);
                let result = crate::providers::anthropic::parse_response(&accumulated.events);
                (result, accumulated.complete)
            };
            let parsed_req_result = crate::providers::anthropic::parse_request(request_body);

            match (parsed_resp_result, parsed_req_result) {
                (Ok(parsed_resp), Ok(parsed_req)) => ParsedFields {
                    model: Some(parsed_resp.model.clone()),
                    response_text: Some(parsed_resp.response_text.clone()),
                    thinking_text: parsed_resp.thinking_text.clone(),
                    stop_reason: parsed_resp.stop_reason.clone(),
                    // INFO-1: u64→i64 casts are safe for real-world token counts
                    // (max ~1M tokens per request, well within i64::MAX ≈ 9.2e18).
                    input_tokens: parsed_resp.input_tokens as i64,
                    output_tokens: parsed_resp.output_tokens as i64,
                    cache_read_tokens: parsed_resp.cache_read_tokens as i64,
                    cache_creation_tokens: parsed_resp.cache_creation_tokens as i64,
                    system_prompt: parsed_req.system,
                    tool_calls: parsed_resp.tool_calls,
                    capture_complete,
                    raw_extra: parsed_resp.raw_extra,
                    parser_version: parsed_resp.parser_version,
                    parse_errors: parsed_resp.parse_errors,
                    // is_preflight: detect Claude Code's quota probe at session
                    // start (max_tokens=1, content="quota"). The request struct
                    // gives us max_tokens; that alone is a strong enough signal —
                    // no real user request sets max_tokens to 1.
                    is_preflight: parsed_req.max_tokens <= 1,
                    messages: parsed_req.messages,
                    tools: parsed_req.tools,
                    thinking_tokens: parsed_resp.thinking_tokens.map(|t| t as i64),
                    client_session_id: None, // Anthropic uses metadata.user_id, not a request-body session_id
                },
                (resp_result, req_result) => {
                    let mut errors = Vec::new();
                    if let Err(ref e) = resp_result {
                        errors.push(format!("response parse error: {}", e));
                    }
                    if let Err(ref e) = req_result {
                        errors.push(format!("request parse error: {}", e));
                    }
                    warn!(
                        provider,
                        errors = ?errors,
                        "Anthropic parsing failed; storing raw bytes with basic metadata"
                    );
                    let (system_prompt, messages, tools) = match req_result {
                        Ok(parsed_req) => {
                            (parsed_req.system, parsed_req.messages, parsed_req.tools)
                        }
                        Err(_) => (None, Vec::new(), None),
                    };
                    ParsedFields {
                        model: None,
                        response_text: None,
                        thinking_text: None,
                        stop_reason: String::new(),
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        system_prompt,
                        tool_calls: Vec::new(),
                        capture_complete: false,
                        raw_extra: None,
                        parser_version: None,
                        parse_errors: Some(errors),
                        messages,
                        tools,
                        thinking_tokens: None,
                        client_session_id: None,
                        is_preflight: false,
                    }
                }
            }
        }
        "google" => {
            // Prepare response body: strip headers, decode chunked TE if present.
            let response_body = stream::prepare_response_body(response_bytes);
            let request_body = stream::strip_http_headers(request_bytes);

            // G-W5 fix: Parse the request body JSON once, then pass the parsed Value
            // to the appropriate parser. This avoids double-parsing (once for format
            // detection, once for actual parsing).
            //
            // S-N1 fix: Check that `"request"` is a JSON object (not string/array/null)
            // to avoid misclassifying a standard request that happens to have a
            // `"request"` field with a non-object value.
            let parsed_json = serde_json::from_slice::<serde_json::Value>(request_body);
            let is_cli_format = parsed_json
                .as_ref()
                .map(|v| v.get("request").is_some_and(|r| r.is_object()))
                .unwrap_or(false);

            if is_cli_format {
                // Gemini CLI path: use CLI-specific parsers that handle the
                // `request` wrapper in requests and `response` wrapper in SSE events.
                let parsed_req_result = parsed_json
                    .as_ref()
                    .map_err(|e| anyhow::anyhow!("{}", e))
                    .and_then(crate::providers::google::parse_gemini_cli_request_from_value);
                let parsed_resp_result =
                    crate::providers::google::parse_gemini_cli_sse_response(&response_body);

                match (parsed_resp_result, parsed_req_result) {
                    (Ok(parsed_resp), Ok(parsed_req)) => {
                        // Prefer model from request (always present in CLI format);
                        // fall back to response modelVersion.
                        let model = if !parsed_req.model.is_empty() {
                            parsed_req.model.clone()
                        } else if !parsed_resp.model.is_empty() {
                            parsed_resp.model.clone()
                        } else {
                            String::new()
                        };
                        // INFO-2 fix: Derive capture_complete from stop_reason.
                        // If the response was parsed and has a recognized stop_reason
                        // (e.g., "end_turn"), the capture is complete. Otherwise it
                        // may have been truncated.
                        let capture_complete = !parsed_resp.stop_reason.is_empty();

                        // F3 fix: Merge the Gemini CLI `project` field into raw_extra
                        // so it is observable in the DB (not silently discarded).
                        let raw_extra = {
                            let mut extra: serde_json::Map<String, serde_json::Value> = parsed_resp
                                .raw_extra
                                .as_deref()
                                .and_then(|s| serde_json::from_str(s).ok())
                                .unwrap_or_default();
                            if let Some(ref project) = parsed_req.project {
                                extra.insert(
                                    "project".to_string(),
                                    serde_json::Value::String(project.clone()),
                                );
                            }
                            if extra.is_empty() {
                                None
                            } else {
                                Some(serde_json::to_string(&extra).unwrap_or_default())
                            }
                        };

                        // FIND-1-2: merge request-side and response-side
                        // drift so request schema mismatches reach
                        // TurnRecord.parse_errors.
                        let parse_errors =
                            merge_parse_errors(parsed_req.parse_errors, parsed_resp.parse_errors);

                        ParsedFields {
                            model: Some(model),
                            response_text: Some(parsed_resp.response_text.clone()),
                            thinking_text: parsed_resp.thinking_text.clone(),
                            stop_reason: parsed_resp.stop_reason.clone(),
                            // INFO-1: u64→i64 casts are safe for real-world token counts
                            // (max ~1M tokens per request, well within i64::MAX ≈ 9.2e18).
                            input_tokens: parsed_resp.input_tokens as i64,
                            output_tokens: parsed_resp.output_tokens as i64,
                            cache_read_tokens: parsed_resp.cache_read_tokens as i64,
                            cache_creation_tokens: parsed_resp.cache_creation_tokens as i64,
                            system_prompt: parsed_req.system,
                            tool_calls: parsed_resp.tool_calls,
                            capture_complete,
                            raw_extra,
                            parser_version: parsed_resp.parser_version,
                            parse_errors,
                            messages: parsed_req.messages,
                            tools: parsed_req.tools,
                            // LOW-1 fix: Use API-reported thinking tokens from usageMetadata.
                            thinking_tokens: parsed_resp.thinking_tokens.map(|t| t as i64),
                            // LOW-2 fix: Propagate the Gemini CLI session_id for session identity.
                            client_session_id: parsed_req.session_id,
                            is_preflight: false,
                        }
                    }
                    (resp_result, req_result) => {
                        let mut errors = Vec::new();
                        if let Err(ref e) = resp_result {
                            errors.push(format!("response parse error: {}", e));
                        }
                        if let Err(ref e) = req_result {
                            errors.push(format!("request parse error: {}", e));
                        }
                        warn!(
                            provider,
                            errors = ?errors,
                            "Gemini CLI parsing failed; storing raw bytes with basic metadata"
                        );
                        let (system_prompt, messages, tools) = match req_result {
                            Ok(parsed_req) => {
                                (parsed_req.system, parsed_req.messages, parsed_req.tools)
                            }
                            Err(_) => (None, Vec::new(), None),
                        };
                        ParsedFields {
                            model: None,
                            response_text: None,
                            thinking_text: None,
                            stop_reason: String::new(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_tokens: 0,
                            cache_creation_tokens: 0,
                            system_prompt,
                            tool_calls: Vec::new(),
                            capture_complete: false,
                            raw_extra: None,
                            parser_version: None,
                            parse_errors: Some(errors),
                            messages,
                            tools,
                            thinking_tokens: None,
                            client_session_id: None,
                            is_preflight: false,
                        }
                    }
                }
            } else {
                // Standard Gemini API path (generativelanguage.googleapis.com).
                // F4 fix: Parse request body for system prompt, messages, and tools.
                // G-W5 fix: Reuse the pre-parsed JSON value instead of parsing again.
                // S-N7 fix: Standard Gemini requests now get deterministic content-based
                // session IDs (derived from the first user message) instead of random UUIDs.
                // This is a behavior change from the pre-request-parsing era, when
                // messages were empty and content_based_session_id fell back to UUID.
                let parsed_req_result = parsed_json
                    .as_ref()
                    .map_err(|e| anyhow::anyhow!("{}", e))
                    .and_then(crate::providers::google::parse_gemini_request_from_value);
                let accumulated = stream::parse_sse_stream(&response_body);
                let parsed_resp_result =
                    crate::providers::google::parse_response(&accumulated.events);

                // FIND-1-2: capture request-side parse_errors so they merge
                // into the final ParsedFields.parse_errors. On request parse
                // failure we get None here (the err message is folded into
                // parse_errors by the response branch below).
                let (system_prompt, messages, tools, req_parse_errors) = match parsed_req_result {
                    Ok(parsed_req) => (
                        parsed_req.system,
                        parsed_req.messages,
                        parsed_req.tools,
                        parsed_req.parse_errors,
                    ),
                    Err(_) => (None, Vec::new(), None, None),
                };

                match parsed_resp_result {
                    Ok(parsed_resp) => ParsedFields {
                        model: Some(parsed_resp.model.clone()),
                        response_text: Some(parsed_resp.response_text.clone()),
                        thinking_text: parsed_resp.thinking_text.clone(),
                        stop_reason: parsed_resp.stop_reason.clone(),
                        // INFO-1: u64→i64 casts are safe for real-world token counts
                        // (max ~1M tokens per request, well within i64::MAX ≈ 9.2e18).
                        input_tokens: parsed_resp.input_tokens as i64,
                        output_tokens: parsed_resp.output_tokens as i64,
                        cache_read_tokens: parsed_resp.cache_read_tokens as i64,
                        cache_creation_tokens: parsed_resp.cache_creation_tokens as i64,
                        system_prompt,
                        tool_calls: parsed_resp.tool_calls,
                        capture_complete: accumulated.complete,
                        raw_extra: parsed_resp.raw_extra,
                        parser_version: parsed_resp.parser_version,
                        // FIND-1-2: merge req + resp drift.
                        parse_errors: merge_parse_errors(
                            req_parse_errors,
                            parsed_resp.parse_errors,
                        ),
                        messages,
                        tools,
                        thinking_tokens: parsed_resp.thinking_tokens.map(|t| t as i64),
                        client_session_id: None, // Standard Gemini API does not have a request-body session_id
                        is_preflight: false,
                    },
                    Err(e) => {
                        warn!(
                            provider,
                            error = %e,
                            "Gemini parsing failed; storing raw bytes with basic metadata"
                        );
                        ParsedFields {
                            model: None,
                            response_text: None,
                            thinking_text: None,
                            stop_reason: String::new(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_tokens: 0,
                            cache_creation_tokens: 0,
                            system_prompt,
                            tool_calls: Vec::new(),
                            capture_complete: false,
                            raw_extra: None,
                            parser_version: None,
                            // FIND-1-2: preserve any request-side drift even
                            // when the response failed to parse.
                            parse_errors: merge_parse_errors(
                                req_parse_errors,
                                Some(vec![format!("response parse error: {}", e)]),
                            ),
                            messages,
                            tools,
                            thinking_tokens: None,
                            client_session_id: None,
                            is_preflight: false,
                        }
                    }
                }
            }
        }
        "openai" => {
            // Prepare response body: strip headers, decode chunked TE if present.
            let response_body = stream::prepare_response_body(response_bytes);
            let request_body = stream::strip_http_headers(request_bytes);
            // R1-08 / R2 fix: OpenAI SSE uses "data: {JSON}\n\n" format WITHOUT
            // "event:" prefix lines. The generic `parse_sse_stream` requires both
            // `event:` and `data:` to emit an event, so it silently drops all
            // OpenAI events. Instead, pass the prepared response body directly to
            // the OpenAI SSE parser, which handles the raw "data:" lines natively.
            let sse_text = String::from_utf8_lossy(&response_body);
            let parsed_resp_result = crate::providers::openai::parse_openai_sse_events(&sse_text);
            let parsed_req_result = crate::providers::openai::parse_openai_request(request_body);
            // Track completeness: presence of [DONE] signal in the SSE text.
            let capture_complete = sse_text.contains("[DONE]");

            match (parsed_resp_result, parsed_req_result) {
                (Ok(parsed_resp), Ok(parsed_req)) => {
                    // FIND-1-2: OpenAI's request parser intentionally raises
                    // hard errors instead of accumulating drift entries —
                    // see `OpenAiParsedRequest` in providers/openai.rs, which
                    // has no parse_errors field. So there is no request-side
                    // vector to merge; if the request body is malformed it
                    // takes the (resp_result, req_result) failure branch
                    // below, where the err is captured into parse_errors.
                    let mut parse_errors = parsed_resp.parse_errors.clone();
                    // NOTE 1 (R1-13): record a parse_error when no usage data found
                    if parsed_resp.input_tokens == 0 && parsed_resp.output_tokens == 0 {
                        let errs = parse_errors.get_or_insert_with(Vec::new);
                        errs.push("No usage data found in OpenAI SSE stream".to_string());
                    }
                    ParsedFields {
                        model: Some(parsed_resp.model.clone()),
                        response_text: Some(parsed_resp.response_text.clone()),
                        thinking_text: None,
                        stop_reason: parsed_resp.stop_reason.clone(),
                        // INFO-1: u64→i64 casts are safe for real-world token counts
                        // (max ~1M tokens per request, well within i64::MAX ≈ 9.2e18).
                        input_tokens: parsed_resp.input_tokens as i64,
                        output_tokens: parsed_resp.output_tokens as i64,
                        cache_read_tokens: parsed_resp.cache_read_tokens as i64,
                        cache_creation_tokens: parsed_resp.cache_creation_tokens as i64,
                        system_prompt: parsed_req.system,
                        tool_calls: parsed_resp
                            .tool_calls
                            .into_iter()
                            .map(|tc| crate::providers::anthropic::ToolCall {
                                id: tc.id,
                                name: tc.name,
                                input: tc.input,
                            })
                            .collect(),
                        is_preflight: false,
                        capture_complete,
                        raw_extra: parsed_resp.raw_extra,
                        parser_version: parsed_resp.parser_version,
                        parse_errors,
                        messages: parsed_req.messages,
                        tools: parsed_req.tools,
                        thinking_tokens: None, // OpenAI does not report thinking tokens in usage metadata
                        client_session_id: None, // OpenAI uses metadata.user_id, not a request-body session_id
                    }
                }
                (resp_result, req_result) => {
                    let mut errors = Vec::new();
                    if let Err(ref e) = resp_result {
                        errors.push(format!("response parse error: {}", e));
                    }
                    if let Err(ref e) = req_result {
                        errors.push(format!("request parse error: {}", e));
                    }
                    warn!(
                        provider,
                        errors = ?errors,
                        "OpenAI parsing failed; storing raw bytes with basic metadata"
                    );
                    let (system_prompt, messages, tools) = match req_result {
                        Ok(parsed_req) => {
                            (parsed_req.system, parsed_req.messages, parsed_req.tools)
                        }
                        Err(_) => (None, Vec::new(), None),
                    };
                    ParsedFields {
                        model: None,
                        response_text: None,
                        thinking_text: None,
                        stop_reason: String::new(),
                        input_tokens: 0,
                        output_tokens: 0,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        system_prompt,
                        tool_calls: Vec::new(),
                        capture_complete: false,
                        raw_extra: None,
                        parser_version: None,
                        parse_errors: Some(errors),
                        messages,
                        tools,
                        thinking_tokens: None,
                        client_session_id: None,
                        is_preflight: false,
                    }
                }
            }
        }
        other => {
            // R2-05: Check if a generic YAML adapter is configured for this provider.
            // Generic adapters are loaded from RECONDO_GENERIC_ADAPTER_CONFIG at startup.
            let generic_config = providers::generic_adapter_configs()
                .iter()
                .find(|c| c.provider_name == other);

            if let Some(config) = generic_config {
                let response_body = stream::strip_http_headers(response_bytes);
                let request_body = stream::strip_http_headers(request_bytes);
                let adapter = crate::providers::generic::GenericAdapter::new(config.clone());

                let parsed_resp_result = adapter.parse_response(response_body);
                let parsed_req_result = adapter.parse_request(request_body);

                match (parsed_resp_result, parsed_req_result) {
                    (Ok(parsed_resp), Ok(parsed_req)) => ParsedFields {
                        model: if parsed_resp.model.is_empty() {
                            None
                        } else {
                            Some(parsed_resp.model)
                        },
                        response_text: if parsed_resp.response_text.is_empty() {
                            None
                        } else {
                            Some(parsed_resp.response_text)
                        },
                        thinking_text: None,
                        stop_reason: parsed_resp.stop_reason,
                        // INFO-1: u64→i64 casts are safe for real-world token counts
                        // (max ~1M tokens per request, well within i64::MAX ≈ 9.2e18).
                        input_tokens: parsed_resp.input_tokens as i64,
                        output_tokens: parsed_resp.output_tokens as i64,
                        cache_read_tokens: 0,
                        cache_creation_tokens: 0,
                        system_prompt: parsed_req.system,
                        tool_calls: Vec::new(),
                        capture_complete: true,
                        raw_extra: None,
                        parser_version: Some("0.1.0-generic".to_string()),
                        // FIND-1-2: merge generic-adapter request + response
                        // drift so configured-but-unresolvable paths surface
                        // in TurnRecord.parse_errors. The previous shape
                        // hardcoded `None`, defeating the audit's "log to
                        // parse_errors" intent.
                        parse_errors: merge_parse_errors(
                            parsed_req.parse_errors,
                            parsed_resp.parse_errors,
                        ),
                        messages: parsed_req.messages,
                        tools: parsed_req.tools,
                        thinking_tokens: None,
                        client_session_id: None,
                        is_preflight: false,
                    },
                    (resp_result, req_result) => {
                        let mut errors = Vec::new();
                        if let Err(ref e) = resp_result {
                            errors.push(format!("generic response parse error: {}", e));
                        }
                        if let Err(ref e) = req_result {
                            errors.push(format!("generic request parse error: {}", e));
                        }
                        warn!(
                            provider = other,
                            errors = ?errors,
                            "Generic adapter parsing failed; storing raw bytes"
                        );
                        ParsedFields {
                            model: None,
                            response_text: None,
                            thinking_text: None,
                            stop_reason: String::new(),
                            input_tokens: 0,
                            output_tokens: 0,
                            cache_read_tokens: 0,
                            cache_creation_tokens: 0,
                            system_prompt: None,
                            tool_calls: Vec::new(),
                            capture_complete: false,
                            raw_extra: None,
                            parser_version: None,
                            parse_errors: Some(errors),
                            messages: Vec::new(),
                            tools: None,
                            thinking_tokens: None,
                            client_session_id: None,
                            is_preflight: false,
                        }
                    }
                }
            } else {
                warn!(
                    provider = other,
                    "Unsupported provider encountered; storing raw bytes without parsing"
                );
                ParsedFields {
                    model: None,
                    response_text: None,
                    thinking_text: None,
                    stop_reason: String::new(),
                    input_tokens: 0,
                    output_tokens: 0,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                    system_prompt: None,
                    tool_calls: Vec::new(),
                    capture_complete: true,
                    raw_extra: None,
                    parser_version: None,
                    parse_errors: None,
                    messages: Vec::new(),
                    tools: None,
                    thinking_tokens: None,
                    client_session_id: None,
                    is_preflight: false,
                }
            }
        }
    }
}

/// Process a capture using a `WritePipeline` (production gateway path).
///
/// This is the canonical production entry point: it performs request/response
/// parsing, session resolution, and record-building, then delegates the actual
/// object store + graph store writes to `WritePipeline::write_capture`, which
/// provides:
/// - Retry with exponential backoff on transient graph failures
/// - Dead-letter queue for captures that fail all retries
/// - Hash recomputation to ensure graph references match object store keys
pub fn process_capture_with_pipeline(
    pipeline: &crate::storage::pipeline::WritePipeline,
    session_mgr: &mut crate::session::SessionManager,
    provider: &str,
    request_bytes: &[u8],
    response_bytes: &[u8],
    wal: Option<&crate::wal::Wal>,
    registry: Option<&std::sync::Arc<crate::metrics::MetricsRegistry>>,
) -> Result<crate::db::TurnRecord, CaptureError> {
    use crate::{db, hash, session};
    let capture_start = std::time::Instant::now();

    // Guard: reject payloads that exceed the size limit.
    if request_bytes.len() > MAX_CAPTURE_BYTES {
        return Err(CaptureError::RequestTooLarge {
            actual: request_bytes.len(),
            max: MAX_CAPTURE_BYTES,
        });
    }
    if response_bytes.len() > MAX_CAPTURE_BYTES {
        return Err(CaptureError::ResponseTooLarge {
            actual: response_bytes.len(),
            max: MAX_CAPTURE_BYTES,
        });
    }

    // Step 0: WAL append. Track per-capture WalEntry handles so we mark
    // ONLY the entries we wrote in this call as flushed after the pipeline
    // write — never the global unflushed set, which may contain orphans
    // from a prior crashed run that orphan recovery is responsible for
    // handling.
    let mut this_capture_entries: Vec<crate::wal::WalEntry> = Vec::with_capacity(2);
    if let Some(wal) = wal {
        match wal.append_entry(request_bytes) {
            Ok(entry) => this_capture_entries.push(entry),
            Err(e) => {
                if wal.fail_mode() == crate::wal::FailMode::Closed {
                    return Err(CaptureError::WalAppendFailed {
                        mode: crate::wal::FailMode::Closed,
                        source: e.context("WAL append failed for request bytes (closed mode)"),
                    });
                }
                warn!(error = %e, "WAL append failed for request bytes (open mode, continuing)");
                crate::metrics::MetricsRegistry::global().incr_subpipeline_failure("wal_append", 1);
            }
        }
        match wal.append_entry(response_bytes) {
            Ok(entry) => this_capture_entries.push(entry),
            Err(e) => {
                if wal.fail_mode() == crate::wal::FailMode::Closed {
                    return Err(CaptureError::WalAppendFailed {
                        mode: crate::wal::FailMode::Closed,
                        source: e.context("WAL append failed for response bytes (closed mode)"),
                    });
                }
                warn!(error = %e, "WAL append failed for response bytes (open mode, continuing)");
                crate::metrics::MetricsRegistry::global().incr_subpipeline_failure("wal_append", 1);
            }
        }
    }

    // Step 1: Compute hashes (needed for record building and integrity check).
    let req_hash = hash::sha256_hex(request_bytes);
    let resp_hash = hash::sha256_hex(response_bytes);

    // Step 2: Provider-specific parsing (delegated to shared function).
    let parsed = parse_capture_data(provider, request_bytes, response_bytes);

    // B1+B2+B3 fix: Extract client metadata from request bytes.
    let metadata = session::extract_client_metadata(request_bytes);

    // B2 fix: Extract explicit identity headers from HTTP request.
    let identity_headers = session::extract_identity_headers(request_bytes);

    // B1 fix: Extract org_id from response headers.
    let org_id = extract_org_id(response_bytes);

    // Step 3: Session resolution (using metadata-aware path)
    let now = time::OffsetDateTime::now_utc();
    let timestamp = now
        .format(&time::format_description::well_known::Rfc3339)
        .context("Failed to format timestamp")?;

    // B3 fix: Compute tentative session_id first, then query graph for max sequence.
    let graph_store = pipeline.graph();
    // B2 fix: If explicit session_id header is present, use it to override the
    // auto-derived session_id for tentative lookup.
    // LOW-2 fix: If the provider extracted a client session_id from the request
    // body (e.g., Gemini CLI `request.session_id`), use it when no explicit
    // identity header overrides it.
    let effective_metadata = if identity_headers.session_id.is_some() {
        session::ClientMetadata {
            session_id: identity_headers.session_id.clone(),
            account_uuid: metadata.account_uuid.clone(),
            device_id: metadata.device_id.clone(),
        }
    } else if parsed.client_session_id.is_some() && metadata.session_id.is_none() {
        session::ClientMetadata {
            session_id: parsed.client_session_id.clone(),
            account_uuid: metadata.account_uuid.clone(),
            device_id: metadata.device_id.clone(),
        }
    } else {
        metadata.clone()
    };
    let tentative_sid = crate::session::tentative_session_id(
        &effective_metadata,
        &parsed.messages,
        org_id.as_deref(),
    );
    let current_max_seq = get_max_sequence_from_graph(graph_store, &tentative_sid);

    let resolution = session_mgr
        .resolve(
            &parsed.messages,
            org_id.as_deref(),
            parsed.system_prompt.as_deref(),
            &timestamp,
            current_max_seq,
            Some(&effective_metadata),
        )
        .map_err(CaptureError::SessionResolutionFailed)?;

    // Step 4: Compute messages delta using compute_true_delta.
    //
    // LOW-3 fix: Also compute messages_delta for Google (Gemini CLI) provider,
    // which extracts messages from `request.contents`.
    let (messages_delta, messages_delta_count) =
        if (provider == "anthropic" || provider == "google") && !parsed.messages.is_empty() {
            let current_json =
                serde_json::to_string(&parsed.messages).unwrap_or_else(|_| "[]".to_string());

            let previous_messages = if resolution.sequence_num > 1 {
                match graph_store.get_previous_messages_prefix_marker(
                    &resolution.session_id,
                    resolution.sequence_num,
                ) {
                    Ok(prev) => prev,
                    Err(e) => {
                        warn!(
                            error = %e,
                            "Failed to get previous turn messages; falling back to full delta"
                        );
                        None
                    }
                }
            } else {
                None
            };

            match crate::providers::anthropic::compute_true_delta(
                &current_json,
                previous_messages.as_deref(),
            ) {
                Ok(delta_str) => {
                    let delta_count = serde_json::from_str::<Vec<serde_json::Value>>(&delta_str)
                        .map(|arr| arr.len() as i64)
                        .unwrap_or(0);
                    (Some(delta_str), Some(delta_count))
                }
                Err(e) => {
                    warn!(error = %e, "compute_true_delta failed; storing full messages as delta");
                    crate::metrics::MetricsRegistry::global()
                        .incr_subpipeline_failure("messages_delta", 1);
                    let result =
                        crate::providers::anthropic::compute_messages_delta(&parsed.messages, None);
                    (
                        Some(
                            serde_json::to_string(&result.messages_delta)
                                .unwrap_or_else(|_| "[]".to_string()),
                        ),
                        Some(result.messages_delta_count),
                    )
                }
            }
        } else {
            (None, None)
        };

    // Step 5: Build records
    let turn_id = uuid::Uuid::new_v4().to_string();
    let cost_usd = parsed.model.as_deref().map(|m| {
        db::compute_cost_usd(
            db::model_pricing::canonical(),
            m,
            parsed.input_tokens,
            parsed.output_tokens,
            parsed.cache_creation_tokens,
            parsed.cache_read_tokens,
            &time::OffsetDateTime::now_utc(),
        )
    });
    let capture_duration_ms = elapsed_millis(capture_start);

    // Sprint P1B: extract inline attachments (images / PDFs / documents)
    // from NEW messages in this turn and upload their raw bytes to the
    // object store. Every API request carries the full conversation history
    // including prior images, so extracting from `parsed.messages` would
    // re-record every historical image onto every turn. We instead extract
    // from the delta (messages appended since the previous turn); for the
    // first turn the delta equals the full messages array.
    //
    // Fallback: when a delta couldn't be computed (non-anthropic/google
    // provider, or compute_true_delta failed), extract from the last user
    // message only — new user input is always the newest message and is
    // where attachments the user just added live.
    let messages_for_attachments: Vec<serde_json::Value> = match messages_delta.as_deref() {
        Some(delta_str) => serde_json::from_str(delta_str).unwrap_or_else(|e| {
            warn!(error = %e, "Failed to parse messages_delta for attachment extraction; falling back to last user message");
            crate::metrics::MetricsRegistry::global()
                .incr_subpipeline_failure("messages_delta", 1);
            last_user_message_slice(&parsed.messages)
        }),
        None => last_user_message_slice(&parsed.messages),
    };
    let mut extracted_attachments =
        crate::capture::attachments::extract_from_messages(provider, &messages_for_attachments)
            .unwrap_or_else(|e| {
                warn!(error = %e, "Attachment extraction failed; no attachments will be recorded");
                crate::metrics::MetricsRegistry::global()
                    .incr_subpipeline_failure("attachment_extract", 1);
                Vec::new()
            });

    // Rehost external image URLs (OpenAI `image_url.url` pointing at a
    // remote CDN). `fetch_and_rehost_external` is async and SSRF-guarded.
    //
    // FIND-1-J behaviour — latency budget and runtime safety:
    //
    //   * LATENCY: Each URL adds up to 5s of blocking (the reqwest client
    //     timeout in `fetch_and_rehost_external`). N external URLs in one
    //     turn = up to 5N seconds blocking the caller. This is the
    //     documented worst case; most inline captures carry 0 external
    //     URLs because Anthropic and Gemini use base64 inline bytes.
    //     `block_in_place` moves this thread off the async worker pool so
    //     other tasks can make progress during the fetch.
    //
    //   * RUNTIME SAFETY: a bare `Handle::current()` panics when the
    //     caller is NOT inside a tokio runtime. Synchronous tests that
    //     exercise `process_capture_with_pipeline` WITHOUT first spinning
    //     up a runtime would crash the whole process before FIND-1-J's
    //     fix. Use `Handle::try_current()` instead: when no runtime is
    //     present, skip the fetch, leave the entry as
    //     kind=ExternalImageUrl with empty bytes, and log once. No panic,
    //     no silent data drop beyond what already happens for an SSRF
    //     rejection.
    //
    //   * FAILURE MODE: SSRF rejection, timeout, non-2xx, oversize — any
    //     of these leave the entry as kind=ExternalImageUrl so the
    //     dashboard can still surface "there was a remote image here"
    //     even when bytes couldn't be captured.
    //
    // TODO(attachment-async-hydration): post-capture async hydration
    // (option J/a) requires either a job queue or a `tokio::spawn` that
    // outlives this function. The full refactor is tracked separately;
    // the `Handle::try_current()` fix here is the minimum safety
    // guarantee that the finding required.
    let runtime_handle = tokio::runtime::Handle::try_current().ok();
    // FIND-3-RUST-8: Per-turn external-URL budget. A client sending 50
    // URLs pointing at slow / black-hole servers would otherwise pin a
    // Tokio worker for up to 5s × 50 = 250s. Two caps in combination:
    //
    //   MAX_EXTERNAL_URLS_PER_TURN (3): a per-turn cap on how many
    //   URLs we even attempt to rehost. URLs past this cap are
    //   recorded as kind=ExternalImageUrl with no bytes and a
    //   skip-reason note so the dashboard still shows "there was an
    //   image pointer here".
    //
    //   MAX_EXTERNAL_URL_TOTAL_BUDGET (4s): an aggregate time cap.
    //   Once we've spent this much time across all URL fetches for
    //   this turn, remaining URLs are skipped.
    //
    // Both caps are deliberately conservative — inline base64 is the
    // overwhelming majority of real traffic; external URLs only appear
    // for OpenAI `image_url.url` pointing at remote CDNs.
    // FIND-3-RUST-8 + FIND-4-J: configurable caps + per-fetch wall-clock.
    //
    // FIND-4-J corrected the prior implementation's worst-case wall-
    // clock claim. The two caps are now:
    //
    //   max_urls_per_turn (default 3, env RECONDO_MAX_EXTERNAL_URLS_PER_TURN):
    //     count cap. URLs past this index are skipped.
    //
    //   total_budget_ms (default 4000, env RECONDO_EXTERNAL_URL_BUDGET_MS):
    //     aggregate wall-clock cap measured from the first URL's
    //     attempt to the moment it is reached. Each `fetch_and_rehost_external`
    //     call is wrapped in `tokio::time::timeout(remaining_budget)`
    //     so an in-flight fetch is INTERRUPTED when the aggregate
    //     budget is exhausted, not just checked between fetches. This
    //     bounds the real wall-clock per turn to
    //     `total_budget_ms + ~50ms scheduler slack`, regardless of how
    //     long each individual fetch wants to take.
    // FIND-6-E: hoist the env-var reads into `OnceLock`-backed
    // accessors so we pay the syscall + env-lock cost ONCE (first
    // access), not on every turn. Malformed values fall back to the
    // documented defaults via the same `parse_url_budget_env` helper
    // that unit tests exercise.
    //
    // Operator contract: both env vars are read at startup (first
    // process_capture_with_pipeline invocation). Changing them
    // requires a gateway restart. This is documented in the helper's
    // doc comment.
    let max_urls_per_turn = external_url_max_per_turn();
    let total_budget = std::time::Duration::from_millis(external_url_budget_ms());
    let mut urls_attempted: usize = 0;
    let external_budget_start = std::time::Instant::now();
    for extracted in extracted_attachments.iter_mut() {
        if extracted.kind != crate::capture::attachments::AttachmentKind::ExternalImageUrl {
            continue;
        }
        let Some(ref url) = extracted.source_url else {
            continue;
        };
        let Some(ref handle) = runtime_handle else {
            warn!(
                url = %url,
                "No tokio runtime available for external-URL rehost; \
                 recording as kind=ExternalImageUrl without bytes"
            );
            continue;
        };

        // FIND-3-RUST-8: enforce the per-turn URL count cap.
        if urls_attempted >= max_urls_per_turn {
            warn!(
                url = %url,
                attempted = urls_attempted,
                cap = max_urls_per_turn,
                "External-URL rehost skipped: per-turn URL cap reached"
            );
            continue;
        }
        // FIND-4-J: compute the remaining budget; skip if exhausted,
        // otherwise wrap the fetch in `tokio::time::timeout` so the
        // in-flight fetch is interrupted when the aggregate budget
        // runs out.
        let elapsed = external_budget_start.elapsed();
        // FIND-7-N: budget exhausted -> Duration::ZERO -> short-circuit
        // to skip. `checked_sub` returns None when elapsed > budget;
        // `unwrap_or_default()` on Duration yields ZERO, which the
        // `is_zero()` check below treats as "no budget left".
        let remaining = total_budget.checked_sub(elapsed).unwrap_or_default();
        if remaining.is_zero() {
            warn!(
                url = %url,
                elapsed_ms = elapsed.as_millis() as u64,
                budget_ms = total_budget.as_millis() as u64,
                "External-URL rehost skipped: per-turn total time budget exhausted"
            );
            continue;
        }
        urls_attempted += 1;

        // FIND-7-B: `block_on_future` now returns `Option<T>`.
        // `Some(...)` when the future ran (multi_thread runtime —
        // safe `block_in_place + block_on`); `None` when the
        // helper detected a current_thread runtime and skipped to
        // avoid a guaranteed `Handle::block_on`-from-runtime panic.
        // The skip path mirrors the "no runtime" branch above:
        // record kind=ExternalImageUrl with no bytes, log once.
        //
        // FIND-6-J's prior fix tried to call `handle.block_on(...)`
        // on current_thread inside an active runtime, which Tokio
        // explicitly rejects: "Cannot start a runtime from within a
        // runtime." That regression panicked the test that was
        // supposed to defend the contract. Skip-and-record is the
        // documented option (a) from FIND-7-B.
        let fetched = block_on_future(handle, async {
            tokio::time::timeout(
                remaining,
                crate::capture::attachments::fetch_and_rehost_external(url),
            )
            .await
        });
        let Some(fetched) = fetched else {
            // FIND-7-B: current_thread runtime — fetch was skipped
            // to avoid the panic. Record-and-continue.
            warn!(
                url = %url,
                "External-URL rehost skipped: current_thread runtime cannot drive the fetch (would panic). \
                 Recording as kind=ExternalImageUrl without bytes; the dashboard still shows the URL pointer. \
                 Production gateway uses multi_thread runtime where the fetch runs as expected."
            );
            continue;
        };
        match fetched {
            Ok(Ok(Some((bytes, mime)))) => {
                extracted.bytes = bytes;
                extracted.mime_type = if mime.is_empty() {
                    "application/octet-stream".to_string()
                } else {
                    mime
                };
                extracted.kind = crate::capture::attachments::AttachmentKind::Image;
                // `source_url` intentionally preserved — it's the
                // provenance of the rehosted bytes and useful audit data.
            }
            Ok(Ok(None)) => {
                // SSRF-blocked, non-2xx, oversized, or other rejection.
                // Keep the record as an external URL pointer so the
                // dashboard still shows SOMETHING for this request.
            }
            Ok(Err(e)) => {
                warn!(url = %url, error = %e, "External attachment rehost failed");
                crate::metrics::MetricsRegistry::global()
                    .incr_subpipeline_failure("attachment_rehost", 1);
            }
            Err(_elapsed) => {
                // FIND-4-J: tokio::time::timeout fired. Per-turn
                // budget exhausted mid-fetch; remaining URLs are
                // skipped on the next loop iteration via the
                // remaining-budget check above.
                warn!(
                    url = %url,
                    budget_ms = total_budget.as_millis() as u64,
                    "External-URL rehost timed out: aggregate per-turn budget exhausted mid-fetch"
                );
            }
        }
    }

    // Build the in-memory AttachmentRecord list. Object-store uploads and
    // DB row inserts are deferred to AFTER the turn is written (FK
    // attachments.turn_id -> turns.id requires the turn to exist first);
    // they run through `pipeline.write_attachment` which owns the retry +
    // DLQ semantics per FIND-1-L.
    //
    // `bytes_by_attachment_id` carries the raw bytes keyed by the record
    // id so the post-turn loop can hand them to
    // `pipeline.write_attachment` without re-scanning
    // `extracted_attachments`.
    let mut attachment_records: Vec<db::AttachmentRecord> =
        Vec::with_capacity(extracted_attachments.len());
    let mut bytes_by_attachment_id: std::collections::HashMap<String, Vec<u8>> =
        std::collections::HashMap::with_capacity(extracted_attachments.len());
    for extracted in &extracted_attachments {
        // At this point, ExternalImageUrl entries either (a) got rehosted
        // to kind=Image above with bytes populated, or (b) remained
        // kind=ExternalImageUrl with empty bytes. The `bytes.is_empty()`
        // check below dispatches on that.
        let (sha256, object_ref, size_bytes, bytes_for_put): (String, String, i64, Vec<u8>) =
            if extracted.bytes.is_empty() {
                // URL-only record — store the source URL in object_ref so
                // the API loader can surface it directly as the browser's
                // fetch target (matches loaders.ts external_image_url
                // handling).
                (
                    String::new(),
                    extracted.source_url.clone().unwrap_or_default(),
                    0,
                    Vec::new(),
                )
            } else {
                let sha256 = crate::hash::sha256_hex(&extracted.bytes);
                // object_ref mirrors the ObjectStore layout:
                // attachments/hash.json.gz (flat, no hash-prefix subdir).
                // The API route reconstructs the same path from sha256,
                // so the two stay in sync even though the field itself
                // is not read for inline attachments.
                let object_ref = format!("attachments/{}.json.gz", sha256);
                (
                    sha256,
                    object_ref,
                    extracted.bytes.len() as i64,
                    extracted.bytes.clone(),
                )
            };
        let record = db::AttachmentRecord {
            id: uuid::Uuid::new_v4().to_string(),
            turn_id: turn_id.clone(),
            session_id: resolution.session_id.clone(),
            sequence_num: extracted.sequence_num,
            role: extracted.role.clone(),
            kind: extracted.kind.as_str().to_string(),
            mime_type: extracted.mime_type.clone(),
            size_bytes,
            sha256,
            object_ref,
            filename: extracted.filename.clone(),
            width: None, // Phase 1B ships without dimension decoding.
            height: None,
        };
        bytes_by_attachment_id.insert(record.id.clone(), bytes_for_put);
        attachment_records.push(record);
    }

    // N3: Integrity verification is deferred to AFTER the pipeline write.
    // Pre-write verification was a no-op because objects haven't been stored
    // yet. The WritePipeline stores objects first (with hash verification via
    // ObjectStore::put), then writes graph records. We verify post-write below.
    let integrity_verified: Option<bool> = None;

    let mut turn_record = db::TurnRecord {
        id: turn_id.clone(),
        session_id: resolution.session_id.clone(),
        sequence_num: resolution.sequence_num,
        timestamp: timestamp.clone(),
        request_hash: req_hash.clone(),
        response_hash: resp_hash.clone(),
        req_bytes_ref: Some(format!("objects/req/{}.json.gz", req_hash)),
        resp_bytes_ref: Some(format!("objects/resp/{}.json.gz", resp_hash)),
        req_bytes_size: Some(request_bytes.len() as i64),
        resp_bytes_size: Some(response_bytes.len() as i64),
        model: parsed.model.clone(),
        response_text: parsed.response_text.clone(),
        thinking_text: parsed.thinking_text.clone(),
        stop_reason: parsed.stop_reason.clone(),
        capture_complete: parsed.capture_complete,
        input_tokens: parsed.input_tokens,
        output_tokens: parsed.output_tokens,
        cache_read_tokens: parsed.cache_read_tokens,
        cache_creation_tokens: parsed.cache_creation_tokens,
        cost_usd,
        created_at: timestamp.clone(),
        messages_delta,
        messages_delta_count,
        raw_extra: parsed.raw_extra.clone(),
        parser_version: parsed.parser_version.clone(),
        parse_errors: parsed
            .parse_errors
            .as_ref()
            .map(|errors| serde_json::to_string(errors).unwrap_or_else(|_| "[]".to_string())),
        provider: Some(provider.to_string()),
        transport: Some("http".to_string()),
        ws_direction: None,
        duration_ms: Some(capture_duration_ms),
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: parsed.tool_calls.len() as i64,
        // LOW-1 fix: Prefer provider-reported thinking tokens (e.g., Gemini
        // thoughtsTokenCount) over the heuristic word-count estimate.
        thinking_tokens: parsed
            .thinking_tokens
            .unwrap_or_else(|| estimate_thinking_tokens(parsed.thinking_text.as_deref())),
        server_id: None,
        integrity_verified,
        supersedes_turn_id: None,
        // D1.1: Extract last user message text, truncate to 2000 chars max.
        user_request_text: session::extract_last_user_request_text(&parsed.messages).map(|t| {
            if t.chars().count() > 2000 {
                t.chars().take(2000).collect()
            } else {
                t
            }
        }),
        // FIND-1-E: placeholder initial value — overwritten below at
        // `turn_record.attachment_count = attachment_records.len() as i64`
        // once the delta has been computed and the extractor has run.
        attachment_count: 0,
    };

    // B1 fix: Resolve SUPERSEDES chain from extracted artifacts BEFORE pipeline write.
    {
        let mut all_artifact_paths: Vec<String> = Vec::new();
        for tc in &parsed.tool_calls {
            let artifacts = crate::artifacts::extract_artifacts(&tc.name, &tc.input);
            for a in &artifacts {
                all_artifact_paths.push(a.path.clone());
            }
        }
        if !all_artifact_paths.is_empty() {
            match graph_store
                .find_supersedes_for_session(&resolution.session_id, &all_artifact_paths)
            {
                Ok(supersedes_id) => {
                    turn_record.supersedes_turn_id = supersedes_id;
                }
                Err(e) => {
                    warn!(error = %e, "Failed to resolve SUPERSEDES chain via pipeline (non-fatal)");
                    crate::metrics::MetricsRegistry::global()
                        .incr_subpipeline_failure("supersedes_resolution", 1);
                }
            }
        }
    }

    // Step 6: Build session record if new.
    let session_record = if resolution.is_new_session {
        let system_prompt_hash =
            session::compute_system_prompt_hash(parsed.system_prompt.as_deref());
        let tools_value = parsed
            .tools
            .as_ref()
            .map(|t| serde_json::Value::Array(t.clone()));
        let tool_definitions_hash = session::compute_tool_definitions_hash(tools_value.as_ref());
        // Skip Claude Code's quota preflight when computing initial_intent —
        // its user message is the literal string "quota", which is meaningless
        // as session intent. The next non-preflight turn will populate it via
        // update_session_initial_intent (idempotent: only writes when empty).
        let initial_intent = if parsed.is_preflight {
            None
        } else {
            session::extract_initial_intent(&parsed.messages)
        };
        let framework = parsed
            .system_prompt
            .as_deref()
            .and_then(session::detect_agent_framework);

        Some(db::SessionRecord {
            id: resolution.session_id.clone(),
            provider: provider.to_string(),
            model: parsed.model.clone(),
            started_at: timestamp.clone(),
            last_active_at: timestamp.clone(),
            ended_at: None,
            initial_intent,
            system_prompt_hash,
            total_turns: 1,
            turns_captured: 1,
            dropped_events: 0,
            // N4: Use saturating_add to prevent overflow on token sum.
            total_tokens: parsed
                .input_tokens
                .saturating_add(parsed.output_tokens)
                .saturating_add(parsed.cache_read_tokens)
                .saturating_add(parsed.cache_creation_tokens),
            total_cost_usd: cost_usd.unwrap_or(0.0),
            framework,
            // B2 fix: Store explicit agent_id from identity headers.
            agent_id: identity_headers.agent_id.clone(),
            agent_version: None,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            // B2 fix: Use identity header user_id as account_uuid override.
            account_uuid: identity_headers
                .user_id
                .clone()
                .or_else(|| metadata.account_uuid.clone()),
            device_id: metadata.device_id.clone(),
            tool_definitions_hash,
        })
    } else {
        None
    };

    // Build tool call records with artifact tracking.
    let tool_records: Vec<db::ToolCallRecord> = parsed
        .tool_calls
        .iter()
        .map(|tc| {
            let artifacts = crate::artifacts::extract_artifacts(&tc.name, &tc.input);
            let artifacts_created = Some(
                serde_json::to_string(&artifacts.iter().map(|a| &a.path).collect::<Vec<_>>())
                    .unwrap_or_else(|_| "[]".to_string()),
            );
            let artifact_hashes = Some(
                serde_json::to_string(&artifacts.iter().map(|a| &a.hash).collect::<Vec<_>>())
                    .unwrap_or_else(|_| "[]".to_string()),
            );

            db::ToolCallRecord {
                id: uuid::Uuid::new_v4().to_string(),
                turn_id: turn_id.clone(),
                tool_name: tc.name.clone(),
                tool_input: tc.input.clone(),
                input_hash: Some(crate::hash::sha256_hex(tc.input.as_bytes())),
                sequence_num: None,
                output: None,
                output_hash: None,
                duration_ms: None,
                error: None,
                status: None,
                artifacts_created,
                artifact_hashes,
            }
        })
        .collect();

    // Step 7: Delegate to WritePipeline for atomic write with retry + DLQ.
    // Use a default session record for existing sessions (the pipeline's
    // write_graph ignores duplicate session writes).
    let session_for_pipeline = session_record.unwrap_or_else(|| db::SessionRecord {
        id: resolution.session_id.clone(),
        provider: provider.to_string(),
        model: parsed.model.clone(),
        started_at: timestamp.clone(),
        last_active_at: timestamp.clone(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: String::new(),
        total_turns: 0,
        turns_captured: 0,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: None,
        agent_id: None,
        agent_version: None,
        git_repo: None,
        git_branch: None,
        git_commit: None,
        working_directory: None,
        parent_session_id: None,
        tags: None,
        account_uuid: metadata.account_uuid.clone(),
        device_id: metadata.device_id.clone(),
        tool_definitions_hash: String::new(),
    });

    // FIND-1-K: Set an initial `attachment_count` to the extracted count
    // so the turn row is written with a reasonable default, but then
    // RECONCILE it below after the per-attachment writes finish. The
    // invariant `turns.attachment_count == COUNT(attachments WHERE
    // turn_id = turn.id)` is enforced by:
    //   1. Writing the turn with the extracted count (speculative).
    //   2. Running every attachment bundle through
    //      `pipeline.write_attachment` (retry + DLQ per FIND-1-L).
    //   3. Counting Ok(true) returns (true success) vs Ok(false)
    //      returns (DLQ'd — row not persisted).
    //   4. If the reconciled count differs from the speculative count,
    //      issue an `update_turn_attachment_count` to correct the row
    //      so reads never see a count > the persisted row count.
    turn_record.attachment_count = attachment_records.len() as i64;

    pipeline
        .write_capture(
            &session_for_pipeline,
            &turn_record,
            &tool_records,
            request_bytes,
            response_bytes,
        )
        .map_err(CaptureError::DbWriteFailed)?;

    // Sprint P1B / FIND-1-L: insert attachment rows after the turn is
    // committed so the FK (attachments.turn_id -> turns.id) is always
    // satisfied. FIND-1-L wraps each bundle in the pipeline's retry +
    // DLQ semantics so transient object-store or graph-store failures
    // don't silently drop attachments.
    let speculative_count = attachment_records.len() as i64;
    let mut persisted_count: i64 = 0;
    let mut dlq_count: i64 = 0;
    for attachment in &attachment_records {
        let bytes = bytes_by_attachment_id
            .remove(&attachment.id)
            .unwrap_or_default();
        match pipeline.write_attachment(attachment, &bytes) {
            Ok(true) => persisted_count += 1,
            Ok(false) => {
                dlq_count += 1;
                warn!(
                    turn_id = %turn_id,
                    attachment_id = %attachment.id,
                    "Attachment bundle dead-lettered after retries; row not counted"
                );
            }
            Err(e) => {
                // write_attachment + DLQ both failed — operational error.
                // Do NOT count toward persisted_count. Turn row stays at
                // the speculative count; reconciliation below will
                // UPDATE it down to match reality.
                warn!(
                    turn_id = %turn_id,
                    attachment_id = %attachment.id,
                    error = %e,
                    "Attachment bundle fully failed (DLQ also failed); row not counted"
                );
            }
        }
    }
    // FIND-1-K reconciliation: if any attachment bundle was dead-lettered
    // or outright lost, UPDATE the turn row so
    // `turns.attachment_count == COUNT(attachments WHERE turn_id = turn.id)`
    // on disk. The speculative count was an upper bound; the real count
    // is `persisted_count`.
    if persisted_count != speculative_count {
        warn!(
            turn_id = %turn_id,
            speculative = speculative_count,
            persisted = persisted_count,
            dlq = dlq_count,
            "Attachment count drift detected; reconciling turn.attachment_count"
        );
        // FIND-1-K re-fix: reconciliation is now retry + DLQ via
        // `pipeline.reconcile_turn_attachment_count`. A single UPDATE
        // failure used to log-and-move-on, leaving the row to overcount
        // forever — no retry, no DLQ. Now:
        //   Ok(true)  => UPDATE succeeded; mirror persisted count.
        //   Ok(false) => UPDATE failed + DLQ record written. Row on
        //                disk still overcounts, but operator has the
        //                DLQ entry for reconciliation.
        //   Err(e)    => UPDATE failed AND DLQ failed — genuine
        //                operational crisis; surface loudly.
        match pipeline.reconcile_turn_attachment_count(
            &turn_id,
            persisted_count,
            speculative_count,
            dlq_count,
        ) {
            Ok(true) => {
                // Mirror the on-disk value back into the returned record so
                // the caller sees the reconciled count (the return value
                // feeds GraphQL and tests that assert on it).
                turn_record.attachment_count = persisted_count;
            }
            Ok(false) => {
                // FIND-4-F: increment the count_drift Prometheus
                // counter so operators alerting on
                // recondo_attachment_dlq_total{reason="count_drift"}>0
                // see this failure mode. The DLQ file is on disk; the
                // metric mirrors that.
                crate::metrics::MetricsRegistry::global()
                    .incr_attachment_dlq_total("count_drift", 1);
                tracing::error!(
                    turn_id = %turn_id,
                    speculative = speculative_count,
                    persisted = persisted_count,
                    "turn.attachment_count reconciliation DLQ'd; row still overcounts — operator must reconcile"
                );
            }
            Err(e) => {
                // FIND-4-F: also increment count_drift on the
                // worst-case path (UPDATE failed AND DLQ failed) — the
                // operator alarm should fire here too.
                crate::metrics::MetricsRegistry::global()
                    .incr_attachment_dlq_total("count_drift", 1);
                tracing::error!(
                    turn_id = %turn_id,
                    speculative = speculative_count,
                    persisted = persisted_count,
                    error = %e,
                    "turn.attachment_count reconciliation AND DLQ both failed"
                );
            }
        }
    }

    // FIND-3-RUST-7: export the per-turn DLQ count as a Prometheus
    // counter so operators can alert on sustained attachment DLQ
    // activity without scraping logs. The reason label distinguishes
    // attachment-bundle DLQs (object-put or row-insert exhaustion)
    // from count-drift DLQs (reconciliation UPDATE failure). The
    // count_drift branch is wired above at the
    // `pipeline.reconcile_turn_attachment_count` Ok(false)/Err arms.
    if dlq_count > 0 {
        crate::metrics::MetricsRegistry::global()
            .incr_attachment_dlq_total("attachment_bundle", dlq_count as u64);
    }

    // B2 fix: When this is NOT a new session, the session already exists in the
    // graph store but its aggregate totals (total_turns, turns_captured,
    // total_tokens, total_cost_usd) were not updated by write_capture (which
    // only does insert-or-ignore on the session). Use update_session_totals to
    // atomically increment the counters with this turn's deltas.
    if !resolution.is_new_session {
        let delta_tokens = parsed
            .input_tokens
            .saturating_add(parsed.output_tokens)
            .saturating_add(parsed.cache_read_tokens)
            .saturating_add(parsed.cache_creation_tokens);
        if let Err(e) = pipeline.graph().update_session_totals(
            &resolution.session_id,
            1,                       // delta_turns
            1,                       // delta_captured
            delta_tokens,            // delta_tokens (all 4 token types)
            cost_usd.unwrap_or(0.0), // delta_cost_usd
        ) {
            warn!(
                session_id = %resolution.session_id,
                error = %e,
                "Failed to update session totals for existing session (non-fatal)"
            );
            crate::metrics::MetricsRegistry::global().incr_subpipeline_failure("session_totals", 1);
        }

        // Backfill framework if the session was created without one (e.g. quota check
        // was the first turn) but this turn has a system prompt with a known framework.
        if let Some(fw) = parsed
            .system_prompt
            .as_deref()
            .and_then(session::detect_agent_framework)
        {
            if let Err(e) = pipeline
                .graph()
                .update_session_framework(&resolution.session_id, &fw)
            {
                warn!(
                    session_id = %resolution.session_id,
                    error = %e,
                    "Failed to backfill session framework (non-fatal)"
                );
                crate::metrics::MetricsRegistry::global()
                    .incr_subpipeline_failure("session_backfill_framework", 1);
            }
        }

        // Backfill initial_intent for sessions whose first turn was a preflight
        // (intent left NULL on insert). update_session_initial_intent is
        // idempotent — the SQL only writes when the column is NULL or empty.
        if !parsed.is_preflight {
            if let Some(intent) = session::extract_initial_intent(&parsed.messages) {
                if let Err(e) = pipeline
                    .graph()
                    .update_session_initial_intent(&resolution.session_id, &intent)
                {
                    warn!(
                        session_id = %resolution.session_id,
                        error = %e,
                        "Failed to backfill session initial_intent (non-fatal)"
                    );
                    crate::metrics::MetricsRegistry::global()
                        .incr_subpipeline_failure("session_backfill_initial_intent", 1);
                }
            }
        }

        // Backfill model if the session was created without one.
        if let Some(ref model) = parsed.model {
            if !model.is_empty() {
                if let Err(e) = pipeline
                    .graph()
                    .update_session_model(&resolution.session_id, model)
                {
                    warn!(
                        session_id = %resolution.session_id,
                        error = %e,
                        "Failed to backfill session model (non-fatal)"
                    );
                    crate::metrics::MetricsRegistry::global()
                        .incr_subpipeline_failure("session_backfill_model", 1);
                }
            }
        }
    }

    // Sprint 7: System prompt drift detection via pipeline's graph store.
    {
        let current_sph = session::compute_system_prompt_hash(parsed.system_prompt.as_deref());
        match crate::drift::detect_drift_via_graph(
            pipeline.graph(),
            &resolution.session_id,
            &turn_record.id,
            &current_sph,
            resolution.sequence_num,
        ) {
            Ok(Some(_anomaly)) => {
                info!(
                    session_id = %resolution.session_id,
                    turn_id = %turn_record.id,
                    "System prompt drift detected (pipeline path)"
                );
                // Issue 2: Webhook dispatch requires async runtime (Sprint 14 control
                // plane). The anomaly has been persisted; the control plane will poll
                // and dispatch webhooks asynchronously.
            }
            Ok(None) => {} // No drift
            Err(e) => {
                warn!(error = %e, "Drift detection failed via pipeline (non-fatal)");
                crate::metrics::MetricsRegistry::global()
                    .incr_subpipeline_failure("drift_detection", 1);
            }
        }
    }

    // Sprint 7 Phase 2: Tool definition drift detection via pipeline's graph store.
    {
        let tools_value = parsed
            .tools
            .as_ref()
            .map(|t| serde_json::Value::Array(t.clone()));
        let current_tdh = session::compute_tool_definitions_hash(tools_value.as_ref());
        match crate::drift::detect_tool_drift_via_graph(
            pipeline.graph(),
            &resolution.session_id,
            &turn_record.id,
            &current_tdh,
            resolution.sequence_num,
        ) {
            Ok(Some(_anomaly)) => {
                info!(
                    session_id = %resolution.session_id,
                    turn_id = %turn_record.id,
                    "Tool definition drift detected (pipeline path)"
                );
                // Issue 2: Webhook dispatch requires async runtime (Sprint 14 control
                // plane). The anomaly has been persisted; the control plane will poll
                // and dispatch webhooks asynchronously.
            }
            Ok(None) => {} // No drift
            Err(e) => {
                warn!(error = %e, "Tool drift detection failed via pipeline (non-fatal)");
                crate::metrics::MetricsRegistry::global()
                    .incr_subpipeline_failure("tool_drift_detection", 1);
            }
        }
    }

    // N3: Post-write integrity verification. Objects are now stored by the
    // pipeline, so ObjectStore::verify will find them and re-hash to confirm
    // no corruption occurred during the write.
    {
        let objects = pipeline.objects();
        let req_ok = objects.verify("req", &req_hash).unwrap_or(false);
        let resp_ok = objects.verify("resp", &resp_hash).unwrap_or(false);
        turn_record.integrity_verified = Some(req_ok && resp_ok);
        if !req_ok || !resp_ok {
            warn!(
                req_hash = %req_hash,
                resp_hash = %resp_hash,
                req_ok,
                resp_ok,
                "Post-write integrity verification failed"
            );
        }
    }

    // Step 8: Mark WAL entries as flushed after successful pipeline write.
    // Only mark entries we appended in THIS capture; orphan entries from a
    // prior crashed run are reserved for the orphan-recovery path.
    if let Some(wal) = wal {
        for entry in &this_capture_entries {
            if let Err(e) = wal.mark_flushed(entry) {
                warn!(error = %e, "Failed to mark WAL entry as flushed (non-fatal)");
                crate::metrics::MetricsRegistry::global()
                    .incr_subpipeline_failure("wal_flush_mark", 1);
            }
        }
    }

    // H5 fix: Record successful capture metrics.
    if let Some(reg) = registry {
        let latency = capture_start.elapsed();
        let bytes = (request_bytes.len() + response_bytes.len()) as u64;
        crate::metrics::record_capture(reg, latency, bytes);
    }

    Ok(turn_record)
}
