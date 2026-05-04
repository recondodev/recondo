use anyhow::{anyhow, Result};

use crate::providers::anthropic::{ParsedResponse, ToolCall};
use crate::providers::parse_drift::extract_array_or_record_drift;
use crate::stream::SseEvent;

// ---------------------------------------------------------------------------
// Gemini CLI request parsing
// ---------------------------------------------------------------------------

/// Parsed request data from a Gemini CLI (`cloudcode-*`) request body.
///
/// Gemini CLI requests differ from standard Gemini API requests: they have a
/// top-level `model`, `project`, and `user_prompt_id`, with the actual Gemini
/// API payload nested under a `request` object that contains `session_id`,
/// `systemInstruction`, `contents`, `tools`, and `generationConfig`.
#[derive(Debug, Clone)]
pub struct GeminiCliRequestData {
    /// Model name from the top-level `model` field.
    pub model: String,
    /// Session ID from `request.session_id`.
    pub session_id: Option<String>,
    /// System prompt from `request.systemInstruction.parts[*].text` (all parts joined with newlines).
    pub system: Option<String>,
    /// Messages array from `request.contents`.
    pub messages: Vec<serde_json::Value>,
    /// Project identifier from the top-level `project` field.
    pub project: Option<String>,
    /// Tool definitions from `request.tools`.
    pub tools: Option<Vec<serde_json::Value>>,
    /// Parse-drift errors recorded when the body's schema does not match
    /// expectations (e.g. `contents` is not an array). Empty / `None` for
    /// well-formed inputs. Audit M1 (`docs/GATEWAY_AUDIT_2026_05_02.md`).
    pub parse_errors: Option<Vec<String>>,
}

/// Parse a Gemini CLI request body into structured fields.
///
/// The Gemini CLI format wraps the standard Gemini API payload in a `request`
/// object with additional top-level fields (`model`, `project`, `user_prompt_id`).
///
/// Returns `Err` if the body is not valid JSON.
pub fn parse_gemini_cli_request(body: &[u8]) -> Result<GeminiCliRequestData> {
    let v: serde_json::Value = serde_json::from_slice(body)?;
    parse_gemini_cli_request_from_value(&v)
}

/// Parse a pre-parsed JSON Value as a Gemini CLI request.
///
/// G-W5 fix: Accepts a pre-parsed `serde_json::Value` to avoid double-parsing
/// the request body (once for format detection, once for actual parsing).
///
/// **Expects a CLI-format body.** In the production path
/// (`gateway::process_capture`) this is guaranteed: the caller flips the
/// `is_cli_format` branch only after verifying `request.is_object()`. The
/// `request: missing` drift entry below is therefore unreachable from the
/// gateway. It IS reachable from external callers (tests, tooling) that
/// feed standard-API bodies into the CLI parser by mistake — and that is
/// the policy choice (FIND-1-3 audit follow-up): we keep the conservative
/// drift signal rather than silently treat the missing wrapper as "no
/// contents." A consumer who wants a permissive parse should call
/// `parse_gemini_request_from_value` directly. This is REBUTTED-with-policy,
/// not a missed fix.
pub fn parse_gemini_cli_request_from_value(v: &serde_json::Value) -> Result<GeminiCliRequestData> {
    // Extract top-level fields
    let model = v
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();

    let project = v
        .get("project")
        .and_then(|p| p.as_str())
        .map(|s| s.to_string());

    // Extract nested request fields
    let request = v.get("request");

    let session_id = request
        .and_then(|r| r.get("session_id"))
        .and_then(|s| s.as_str())
        .map(|s| s.to_string());

    // S-N3 fix: Iterate all parts of systemInstruction and join with newlines,
    // instead of only extracting the first part. Multi-part system instructions
    // would otherwise lose all but the first part.
    let system = request
        .and_then(|r| r.get("systemInstruction"))
        .and_then(|si| si.get("parts"))
        .and_then(|p| p.as_array())
        .and_then(|arr| {
            let texts: Vec<&str> = arr
                .iter()
                .filter_map(|part| part.get("text").and_then(|t| t.as_str()))
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        });

    let mut errors: Vec<String> = Vec::new();

    // M1: log parse-drift if `request.contents` is missing or not an array
    // (instead of silently falling back to an empty Vec). Behaviour preserved:
    // `messages` still degrades to an empty Vec so capture is never lost.
    let messages: Vec<serde_json::Value> = match request {
        Some(r) => extract_array_or_record_drift(r, "contents", &mut errors),
        None => {
            errors.push("expected object at .request, got missing".to_string());
            Vec::new()
        }
    };

    let tools: Option<Vec<serde_json::Value>> = request
        .and_then(|r| r.get("tools"))
        .and_then(|t| t.as_array())
        .cloned();

    let parse_errors = if errors.is_empty() {
        None
    } else {
        Some(errors)
    };

    Ok(GeminiCliRequestData {
        model,
        session_id,
        system,
        messages,
        project,
        tools,
        parse_errors,
    })
}

// ---------------------------------------------------------------------------
// Standard Gemini API request parsing
// ---------------------------------------------------------------------------

/// Parsed request data from a standard Gemini API request body.
///
/// Standard Gemini API requests have top-level `contents`, `systemInstruction`,
/// and `tools` fields (no `request` wrapper like the CLI format).
#[derive(Debug, Clone)]
pub struct GeminiRequestData {
    /// System prompt from `systemInstruction.parts[*].text` (all parts joined with newlines).
    pub system: Option<String>,
    /// Messages array from `contents`.
    pub messages: Vec<serde_json::Value>,
    /// Tool definitions from `tools`.
    pub tools: Option<Vec<serde_json::Value>>,
    /// Parse-drift errors recorded when the body's schema does not match
    /// expectations (e.g. `contents` is missing or not an array). Empty /
    /// `None` for well-formed inputs. Audit M1
    /// (`docs/GATEWAY_AUDIT_2026_05_02.md`).
    pub parse_errors: Option<Vec<String>>,
}

/// Parse a pre-parsed JSON Value as a standard Gemini API request.
///
/// G-W5 fix: Accepts a pre-parsed `serde_json::Value` to avoid double-parsing
/// the request body (once for format detection, once for actual parsing).
pub fn parse_gemini_request_from_value(v: &serde_json::Value) -> Result<GeminiRequestData> {
    // S-N3 fix: Iterate all parts of systemInstruction and join with newlines,
    // instead of only extracting the first part. Multi-part system instructions
    // would otherwise lose all but the first part.
    let system = v
        .get("systemInstruction")
        .and_then(|si| si.get("parts"))
        .and_then(|p| p.as_array())
        .and_then(|arr| {
            let texts: Vec<&str> = arr
                .iter()
                .filter_map(|part| part.get("text").and_then(|t| t.as_str()))
                .collect();
            if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            }
        });

    let mut errors: Vec<String> = Vec::new();

    // M1: log parse-drift if `contents` is missing or not an array (instead
    // of silently falling back to an empty Vec). Behaviour preserved:
    // `messages` still degrades to an empty Vec so capture is never lost.
    let messages: Vec<serde_json::Value> =
        extract_array_or_record_drift(v, "contents", &mut errors);

    let tools: Option<Vec<serde_json::Value>> = v.get("tools").and_then(|t| t.as_array()).cloned();

    let parse_errors = if errors.is_empty() {
        None
    } else {
        Some(errors)
    };

    Ok(GeminiRequestData {
        system,
        messages,
        tools,
        parse_errors,
    })
}

// ---------------------------------------------------------------------------
// Gemini CLI SSE response parsing
// ---------------------------------------------------------------------------

/// Known top-level fields in Gemini response objects (both CLI and standard API).
/// Fields not in this list are captured into raw_extra.
/// S-N5 fix: Deduplicated from the former KNOWN_CLI_RESPONSE_FIELDS and
/// KNOWN_TOP_LEVEL_FIELDS constants that were identical.
const KNOWN_GEMINI_RESPONSE_FIELDS: &[&str] = &["candidates", "usageMetadata", "modelVersion"];

/// Parse a Gemini CLI SSE response stream into a structured `ParsedResponse`.
///
/// Gemini CLI SSE events use `data: {JSON}` format where each JSON payload wraps
/// the actual response in a `{"response": {...}}` object. This function:
///
/// 1. Splits raw bytes into SSE data lines.
/// 2. Unwraps the `response` wrapper from each event.
/// 3. Separates thinking parts (`thought: true`) from regular text.
/// 4. Extracts token counts from `usageMetadata`.
/// 5. Extracts `modelVersion` and `finishReason`.
///
/// Returns `Ok(ParsedResponse)` with safe defaults for empty input, or
/// populated fields for valid SSE streams.
pub fn parse_gemini_cli_sse_response(body: &[u8]) -> Result<ParsedResponse> {
    let text = String::from_utf8_lossy(body);

    // Split into SSE data lines. Each event is "data: {JSON}\n\n".
    let data_payloads: Vec<&str> = text
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("data:") {
                let payload = rest.trim();
                if !payload.is_empty() {
                    return Some(payload);
                }
            }
            None
        })
        .collect();

    // Empty input: return safe defaults
    if data_payloads.is_empty() {
        return Ok(ParsedResponse {
            response_text: String::new(),
            thinking_text: None,
            tool_calls: Vec::new(),
            stop_reason: String::new(),
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: String::new(),
            message_id: String::new(),
            raw_extra: None,
            parser_version: Some("0.1.0-cli".to_string()),
            parse_errors: None,
            thinking_tokens: None,
        });
    }

    let mut response_text = String::new();
    let mut thinking_text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut stop_reason = String::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cache_read_tokens: u64 = 0;
    let mut thinking_tokens_from_api: Option<u64> = None;
    let mut model = String::new();
    let mut extra_fields: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut parse_errors_list: Vec<String> = Vec::new();
    let mut tool_call_counter: usize = 0;
    let mut successfully_parsed_count: usize = 0;

    for payload in &data_payloads {
        let outer: serde_json::Value = match serde_json::from_str(payload) {
            Ok(v) => {
                successfully_parsed_count += 1;
                v
            }
            Err(e) => {
                parse_errors_list.push(format!("malformed JSON in SSE event: {}", e));
                continue;
            }
        };

        // Unwrap the "response" wrapper. If no wrapper, use the value as-is.
        let v = outer.get("response").cloned().unwrap_or(outer.clone());

        // Extract modelVersion
        if let Some(mv) = v.get("modelVersion").and_then(|v| v.as_str()) {
            model = mv.to_string();
        }

        // Extract usageMetadata (cumulative; keep max values).
        if let Some(usage) = v.get("usageMetadata") {
            if let Some(pt) = usage.get("promptTokenCount").and_then(|v| v.as_u64()) {
                input_tokens = input_tokens.max(pt);
            }
            if let Some(ct) = usage.get("candidatesTokenCount").and_then(|v| v.as_u64()) {
                output_tokens = output_tokens.max(ct);
            }
            if let Some(crt) = usage
                .get("cachedContentTokenCount")
                .and_then(|v| v.as_u64())
            {
                cache_read_tokens = cache_read_tokens.max(crt);
            }
            // LOW-1 fix: Extract thoughtsTokenCount from usageMetadata into a
            // dedicated field instead of relying solely on raw_extra / heuristic.
            if let Some(ttc) = usage.get("thoughtsTokenCount").and_then(|v| v.as_u64()) {
                thinking_tokens_from_api =
                    Some(thinking_tokens_from_api.map_or(ttc, |prev: u64| prev.max(ttc)));
            }

            // G-W3 fix: Do NOT explicitly insert usageMetadata into raw_extra.
            // All relevant fields (promptTokenCount, candidatesTokenCount,
            // cachedContentTokenCount, thoughtsTokenCount) are already extracted
            // into dedicated struct fields. raw_extra should only contain unknown
            // fields — usageMetadata is a known field per KNOWN_GEMINI_RESPONSE_FIELDS.
        }

        // Capture unknown top-level fields into raw_extra.
        if let Some(obj) = v.as_object() {
            for (key, value) in obj {
                if !KNOWN_GEMINI_RESPONSE_FIELDS.contains(&key.as_str()) {
                    extra_fields.insert(key.clone(), value.clone());
                }
            }
        }

        // Extract candidates
        if let Some(candidates) = v.get("candidates").and_then(|c| c.as_array()) {
            for candidate in candidates {
                // Extract finishReason
                if let Some(fr) = candidate.get("finishReason").and_then(|v| v.as_str()) {
                    stop_reason = map_finish_reason(fr);
                }

                // Extract content.parts
                if let Some(parts) = candidate
                    .get("content")
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.as_array())
                {
                    for part in parts {
                        let is_thought = part
                            .get("thought")
                            .and_then(|t| t.as_bool())
                            .unwrap_or(false);

                        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                            if is_thought {
                                thinking_text.push_str(text);
                            } else {
                                response_text.push_str(text);
                            }
                        } else if let Some(fc) = part.get("functionCall") {
                            let name = fc
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("")
                                .to_string();
                            let args = fc
                                .get("args")
                                .cloned()
                                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                            let input =
                                serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
                            let id = format!("call_{}", tool_call_counter);
                            tool_call_counter += 1;
                            tool_calls.push(ToolCall { id, name, input });
                        }
                    }
                }
            }
        }
    }

    // If ALL events were malformed, return an error.
    if successfully_parsed_count == 0 && !data_payloads.is_empty() {
        return Err(anyhow!(
            "All {} events had malformed JSON",
            data_payloads.len()
        ));
    }

    let thinking_text_opt = if thinking_text.is_empty() {
        None
    } else {
        Some(thinking_text)
    };

    let raw_extra = if extra_fields.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&extra_fields)?)
    };

    let parse_errors = if parse_errors_list.is_empty() {
        None
    } else {
        Some(parse_errors_list)
    };

    Ok(ParsedResponse {
        response_text,
        thinking_text: thinking_text_opt,
        tool_calls,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens: 0,
        model,
        message_id: String::new(),
        raw_extra,
        parser_version: Some("0.1.0-cli".to_string()),
        parse_errors,
        // LOW-1 fix: Use the API-reported thoughtsTokenCount instead of a
        // heuristic estimate from thinking_text word count.
        thinking_tokens: thinking_tokens_from_api,
    })
}

// F9 fix: KNOWN_GEMINI_RESPONSE_FIELDS removed — replaced by shared KNOWN_GEMINI_RESPONSE_FIELDS above.

/// Parse a sequence of SSE events (from a Gemini streaming API response)
/// into a structured ParsedResponse.
///
/// Gemini streaming format: each SSE event has event_type "message" and the data
/// payload is a JSON object with `candidates[]`, `usageMetadata`, and `modelVersion`.
///
/// - Text parts from `candidates[].content.parts[].text` are concatenated into `response_text`.
/// - `functionCall` parts are extracted as `ToolCall` entries with sequential IDs.
/// - `finishReason` is mapped: "STOP" -> "end_turn", "MAX_TOKENS" -> "max_tokens", etc.
/// - `usageMetadata.promptTokenCount` -> `input_tokens`, `candidatesTokenCount` -> `output_tokens`.
/// - Unknown top-level fields are preserved in `raw_extra`.
/// - Unknown part types are logged to `parse_errors`.
pub fn parse_response(events: &[SseEvent]) -> Result<ParsedResponse> {
    if events.is_empty() {
        return Err(anyhow!("No events to parse"));
    }

    let mut response_text = String::new();
    let mut thinking_text = String::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut stop_reason = String::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cache_read_tokens: u64 = 0;
    let mut thinking_tokens_from_api: Option<u64> = None;
    let mut model = String::new();
    let mut extra_fields: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut parse_errors_list: Vec<String> = Vec::new();
    let mut tool_call_counter: usize = 0;

    let mut successfully_parsed_count: usize = 0;

    for event in events {
        let v: serde_json::Value = match serde_json::from_str(&event.data) {
            Ok(v) => {
                successfully_parsed_count += 1;
                v
            }
            Err(e) => {
                parse_errors_list.push(format!("malformed JSON in SSE event: {}", e));
                continue;
            }
        };

        // Extract modelVersion
        if let Some(mv) = v.get("modelVersion").and_then(|v| v.as_str()) {
            model = mv.to_string();
        }

        // Extract usageMetadata.
        // Gemini sends cumulative token counts in the last event, not deltas.
        // We use .max() as a defensive measure: if multiple events contain
        // usageMetadata, keep the largest value (which should be the final
        // cumulative count).
        if let Some(usage) = v.get("usageMetadata") {
            if let Some(pt) = usage.get("promptTokenCount").and_then(|v| v.as_u64()) {
                input_tokens = input_tokens.max(pt);
            }
            if let Some(ct) = usage.get("candidatesTokenCount").and_then(|v| v.as_u64()) {
                output_tokens = output_tokens.max(ct);
            }
            // F11 fix: Extract cachedContentTokenCount as cache_read_tokens.
            if let Some(crt) = usage
                .get("cachedContentTokenCount")
                .and_then(|v| v.as_u64())
            {
                cache_read_tokens = cache_read_tokens.max(crt);
            }
            // F11 fix: Extract thoughtsTokenCount into a dedicated field.
            if let Some(ttc) = usage.get("thoughtsTokenCount").and_then(|v| v.as_u64()) {
                thinking_tokens_from_api =
                    Some(thinking_tokens_from_api.map_or(ttc, |prev: u64| prev.max(ttc)));
            }
        }

        // Capture unknown top-level fields into raw_extra.
        // Log a parse error if a duplicate key is overwritten.
        if let Some(obj) = v.as_object() {
            for (key, value) in obj {
                if !KNOWN_GEMINI_RESPONSE_FIELDS.contains(&key.as_str()) {
                    if extra_fields.contains_key(key) {
                        parse_errors_list
                            .push(format!("raw_extra duplicate key overwritten: {}", key));
                    }
                    extra_fields.insert(key.clone(), value.clone());
                }
            }
        }

        // Extract candidates
        if let Some(candidates) = v.get("candidates").and_then(|c| c.as_array()) {
            if candidates.len() > 1 {
                parse_errors_list.push(format!(
                    "multiple candidates ({}) in single event; concatenating all",
                    candidates.len()
                ));
            }
            for candidate in candidates {
                // Extract finishReason
                if let Some(fr) = candidate.get("finishReason").and_then(|v| v.as_str()) {
                    stop_reason = map_finish_reason(fr);
                }

                // Extract content.parts
                if let Some(parts) = candidate
                    .get("content")
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.as_array())
                {
                    for part in parts {
                        // F11 fix: Separate thinking parts (thought: true) from
                        // regular text, matching the CLI parser's behavior.
                        let is_thought = part
                            .get("thought")
                            .and_then(|t| t.as_bool())
                            .unwrap_or(false);

                        if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                            if is_thought {
                                thinking_text.push_str(text);
                            } else {
                                response_text.push_str(text);
                            }
                        } else if let Some(fc) = part.get("functionCall") {
                            let name = fc
                                .get("name")
                                .and_then(|n| n.as_str())
                                .unwrap_or("")
                                .to_string();
                            let args = fc
                                .get("args")
                                .cloned()
                                .unwrap_or(serde_json::Value::Object(serde_json::Map::new()));
                            let input =
                                serde_json::to_string(&args).unwrap_or_else(|_| "{}".to_string());
                            let id = format!("call_{}", tool_call_counter);
                            tool_call_counter += 1;
                            tool_calls.push(ToolCall { id, name, input });
                        } else {
                            // Unknown part type — record parse error.
                            // E7 carve-out (audit docs/GATEWAY_AUDIT_2026_05_02.md):
                            // the `.unwrap_or_default` below is defensive
                            // scaffolding — the keys list IS the error context
                            // for the "unknown part type" log line. Not silent
                            // fallback; intentional.
                            let part_keys: Vec<String> = part
                                .as_object()
                                .map(|o| o.keys().cloned().collect())
                                .unwrap_or_default();
                            parse_errors_list
                                .push(format!("unknown part type with keys: {:?}", part_keys));
                        }
                    }
                }
            }
        }
    }

    // If ALL events were malformed (none parsed successfully), return an error.
    if successfully_parsed_count == 0 {
        return Err(anyhow!("All {} events had malformed JSON", events.len()));
    }

    let raw_extra = if extra_fields.is_empty() {
        None
    } else {
        Some(serde_json::to_string(&extra_fields)?)
    };

    let parse_errors = if parse_errors_list.is_empty() {
        None
    } else {
        Some(parse_errors_list)
    };

    // F11 fix: Convert thinking_text accumulator to Option.
    let thinking_text_opt = if thinking_text.is_empty() {
        None
    } else {
        Some(thinking_text)
    };

    Ok(ParsedResponse {
        response_text,
        thinking_text: thinking_text_opt,
        tool_calls,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens: 0, // Gemini has no cache creation tokens
        model,
        message_id: String::new(), // Gemini does not have a message ID
        raw_extra,
        parser_version: Some("0.1.0".to_string()),
        parse_errors,
        thinking_tokens: thinking_tokens_from_api,
    })
}

/// Map Gemini finishReason to a normalized stop_reason string.
fn map_finish_reason(reason: &str) -> String {
    match reason {
        "STOP" => "end_turn".to_string(),
        "MAX_TOKENS" => "max_tokens".to_string(),
        "SAFETY" => "safety".to_string(),
        "RECITATION" => "recitation".to_string(),
        other => other.to_lowercase(),
    }
}
