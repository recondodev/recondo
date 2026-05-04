use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::stream::SseEvent;

/// A tool call extracted from an Anthropic response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: String,
}

/// Parsed Anthropic response, extracted from accumulated SSE events.
#[derive(Debug, Clone)]
pub struct ParsedResponse {
    /// Concatenated text from all `text` content blocks.
    pub response_text: String,
    /// Concatenated text from all `thinking` content blocks.
    pub thinking_text: Option<String>,
    /// Tool calls from `tool_use` content blocks.
    pub tool_calls: Vec<ToolCall>,
    /// Stop reason from `message_delta`.
    pub stop_reason: String,
    /// Input tokens from usage.
    pub input_tokens: u64,
    /// Output tokens from usage.
    pub output_tokens: u64,
    /// Cache read tokens (default 0).
    pub cache_read_tokens: u64,
    /// Cache creation tokens (default 0).
    pub cache_creation_tokens: u64,
    /// Model name from `message_start`.
    pub model: String,
    /// Message ID from `message_start`.
    pub message_id: String,
    /// Unknown fields preserved as JSON.
    pub raw_extra: Option<String>,
    /// Parser version (semver).
    pub parser_version: Option<String>,
    /// List of parse error strings.
    pub parse_errors: Option<Vec<String>>,
    /// Thinking tokens from provider-reported usage metadata (e.g., Gemini
    /// `usageMetadata.thoughtsTokenCount`). `None` when the provider does not
    /// report thinking tokens, in which case the gateway falls back to a
    /// heuristic estimate from `thinking_text`.
    pub thinking_tokens: Option<u64>,
}

/// Parsed Anthropic request body.
#[derive(Debug, Clone)]
pub struct ParsedRequest {
    pub model: String,
    pub messages: Vec<serde_json::Value>,
    pub system: Option<String>,
    pub tools: Option<Vec<serde_json::Value>>,
    pub max_tokens: u64,
}

/// Tracks the type and accumulated content of a content block during parsing.
#[derive(Debug)]
enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input_json: String,
    },
}

/// Parse a sequence of SSE events (from an Anthropic Messages API response)
/// into a structured ParsedResponse.
pub fn parse_response(events: &[SseEvent]) -> Result<ParsedResponse> {
    let mut model = String::new();
    let mut message_id = String::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cache_read_tokens: u64 = 0;
    let mut cache_creation_tokens: u64 = 0;
    let mut stop_reason = String::new();
    let mut found_message_start = false;
    let mut extra_fields: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut parse_errors_list: Vec<String> = Vec::new();

    // Known fields on the message object in message_start
    const KNOWN_MESSAGE_FIELDS: &[&str] = &[
        "id",
        "type",
        "role",
        "model",
        "content",
        "stop_reason",
        "stop_sequence",
        "usage",
    ];

    // Known fields on the delta object in message_delta
    const KNOWN_DELTA_FIELDS: &[&str] = &["stop_reason", "stop_sequence"];

    // Map from block index to ContentBlock
    let mut blocks: std::collections::HashMap<u64, ContentBlock> = std::collections::HashMap::new();

    for event in events {
        match event.event_type.as_str() {
            "message_start" => {
                let v: serde_json::Value = serde_json::from_str(&event.data)?;
                let msg = &v["message"];
                model = msg["model"].as_str().unwrap_or("").to_string();
                message_id = msg["id"].as_str().unwrap_or("").to_string();
                let usage = &msg["usage"];
                input_tokens = usage["input_tokens"].as_u64().unwrap_or(0);
                cache_read_tokens = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
                cache_creation_tokens = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);
                found_message_start = true;

                // Capture unknown fields into raw_extra
                if let Some(msg_obj) = msg.as_object() {
                    for (key, value) in msg_obj {
                        if !KNOWN_MESSAGE_FIELDS.contains(&key.as_str()) {
                            extra_fields.insert(key.clone(), value.clone());
                        }
                    }
                }
            }
            "content_block_start" => {
                let v: serde_json::Value = serde_json::from_str(&event.data)?;
                let index = v["index"].as_u64().unwrap_or(0);
                let block = &v["content_block"];
                let block_type = block["type"].as_str().unwrap_or("");

                match block_type {
                    "text" => {
                        blocks.insert(
                            index,
                            ContentBlock::Text {
                                text: String::new(),
                            },
                        );
                    }
                    "thinking" => {
                        blocks.insert(
                            index,
                            ContentBlock::Thinking {
                                text: String::new(),
                            },
                        );
                    }
                    "tool_use" => {
                        let id = block["id"].as_str().unwrap_or("").to_string();
                        let name = block["name"].as_str().unwrap_or("").to_string();
                        blocks.insert(
                            index,
                            ContentBlock::ToolUse {
                                id,
                                name,
                                input_json: String::new(),
                            },
                        );
                    }
                    other => {
                        parse_errors_list.push(format!("unknown content block type: {}", other));
                    }
                }
            }
            "content_block_delta" => {
                let v: serde_json::Value = serde_json::from_str(&event.data)?;
                let index = v["index"].as_u64().unwrap_or(0);
                let delta = &v["delta"];
                let delta_type = delta["type"].as_str().unwrap_or("");

                if let Some(block) = blocks.get_mut(&index) {
                    match (block, delta_type) {
                        (ContentBlock::Text { text }, "text_delta") => {
                            if let Some(t) = delta["text"].as_str() {
                                text.push_str(t);
                            }
                        }
                        (ContentBlock::Thinking { text }, "thinking_delta") => {
                            if let Some(t) = delta["thinking"].as_str() {
                                text.push_str(t);
                            }
                        }
                        (ContentBlock::ToolUse { input_json, .. }, "input_json_delta") => {
                            if let Some(j) = delta["partial_json"].as_str() {
                                input_json.push_str(j);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "message_delta" => {
                let v: serde_json::Value = serde_json::from_str(&event.data)?;
                if let Some(sr) = v["delta"]["stop_reason"].as_str() {
                    stop_reason = sr.to_string();
                }
                if let Some(ot) = v["usage"]["output_tokens"].as_u64() {
                    output_tokens = ot;
                }

                // Capture unknown fields from the delta object
                if let Some(delta_obj) = v["delta"].as_object() {
                    for (key, value) in delta_obj {
                        if !KNOWN_DELTA_FIELDS.contains(&key.as_str()) {
                            extra_fields.insert(format!("delta.{}", key), value.clone());
                        }
                    }
                }
            }
            _ => {
                // ping, content_block_stop, message_stop, etc. - no action needed
            }
        }
    }

    if !found_message_start {
        return Err(anyhow!("No message_start event found in events"));
    }

    // Assemble the final response from accumulated blocks
    let mut response_text = String::new();
    let mut thinking_text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    // Process blocks in index order
    let mut indices: Vec<u64> = blocks.keys().copied().collect();
    indices.sort();

    for index in indices {
        if let Some(block) = blocks.remove(&index) {
            match block {
                ContentBlock::Text { text } => {
                    response_text.push_str(&text);
                }
                ContentBlock::Thinking { text } => {
                    thinking_text_parts.push(text);
                }
                ContentBlock::ToolUse {
                    id,
                    name,
                    input_json,
                } => {
                    tool_calls.push(ToolCall {
                        id,
                        name,
                        input: input_json,
                    });
                }
            }
        }
    }

    let thinking_text = if thinking_text_parts.is_empty() {
        None
    } else {
        Some(thinking_text_parts.join(""))
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
        thinking_text,
        tool_calls,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        model,
        message_id,
        raw_extra,
        parser_version: Some("0.1.0".to_string()),
        parse_errors,
        thinking_tokens: None, // Anthropic does not report thinking tokens in usage metadata
    })
}

/// Parse a non-streaming Anthropic Messages API response (`Content-Type:
/// application/json`) into the same `ParsedResponse` shape the SSE parser
/// produces. Used for Claude Code's quota preflight (`POST /v1/messages` with
/// `max_tokens=1`, no `stream: true`) and any other non-streaming caller.
///
/// Response shape:
/// ```json
/// {
///   "id": "msg_...",
///   "type": "message",
///   "role": "assistant",
///   "model": "claude-...",
///   "content": [{"type": "text", "text": "..."}, ...],
///   "stop_reason": "end_turn"|"max_tokens"|"tool_use"|...,
///   "usage": {"input_tokens": N, "output_tokens": N, ...}
/// }
/// ```
pub fn parse_response_json(body: &[u8]) -> Result<ParsedResponse> {
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|e| {
        anyhow!(
            "non-streaming JSON parse error: {} (first 200 bytes: {:?})",
            e,
            String::from_utf8_lossy(&body[..body.len().min(200)])
        )
    })?;

    let model = v["model"].as_str().unwrap_or("").to_string();
    let message_id = v["id"].as_str().unwrap_or("").to_string();
    let stop_reason = v["stop_reason"].as_str().unwrap_or("").to_string();

    let usage = &v["usage"];
    let input_tokens = usage["input_tokens"].as_u64().unwrap_or(0);
    let output_tokens = usage["output_tokens"].as_u64().unwrap_or(0);
    let cache_read_tokens = usage["cache_read_input_tokens"].as_u64().unwrap_or(0);
    let cache_creation_tokens = usage["cache_creation_input_tokens"].as_u64().unwrap_or(0);

    let mut response_text = String::new();
    let mut thinking_text_parts: Vec<String> = Vec::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();

    if let Some(content_arr) = v["content"].as_array() {
        for block in content_arr {
            match block["type"].as_str() {
                Some("text") => {
                    if let Some(t) = block["text"].as_str() {
                        response_text.push_str(t);
                    }
                }
                Some("thinking") => {
                    if let Some(t) = block["thinking"].as_str() {
                        thinking_text_parts.push(t.to_string());
                    }
                }
                Some("tool_use") => {
                    tool_calls.push(ToolCall {
                        id: block["id"].as_str().unwrap_or("").to_string(),
                        name: block["name"].as_str().unwrap_or("").to_string(),
                        input: block["input"].to_string(),
                    });
                }
                _ => {}
            }
        }
    }

    let thinking_text = if thinking_text_parts.is_empty() {
        None
    } else {
        Some(thinking_text_parts.join(""))
    };

    Ok(ParsedResponse {
        response_text,
        thinking_text,
        tool_calls,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        model,
        message_id,
        raw_extra: None,
        parser_version: Some("0.1.0".to_string()),
        parse_errors: None,
        thinking_tokens: None,
    })
}

/// The result of computing the messages delta between two turns.
#[derive(Debug, Clone)]
pub struct MessagesDelta {
    /// The new messages (tail of current that was appended after previous).
    pub messages_delta: Vec<serde_json::Value>,
    /// The count of new messages.
    pub messages_delta_count: i64,
}

/// Compute the messages delta between the current and previous messages arrays.
///
/// If `previous` is `None` (first turn), the delta is the entire `current` array.
/// Otherwise, the delta is `current[previous.len()..]` — messages appended after
/// the previous turn's messages.
///
/// # Limitation: index-based comparison
///
/// The comparison is index-based: messages at indices `0..previous.len()` are assumed
/// to be unchanged from the previous turn. This means:
/// - Edits to earlier messages (e.g., truncation, summarization) are not detected.
/// - Deletions from the middle of the array will produce incorrect deltas.
///
/// Revisit with content-hash-based comparison if agents that mutate message
/// history mid-session are encountered (e.g., context window compaction).
pub fn compute_messages_delta(
    current: &[serde_json::Value],
    previous: Option<&[serde_json::Value]>,
) -> MessagesDelta {
    match previous {
        None => MessagesDelta {
            messages_delta: current.to_vec(),
            messages_delta_count: current.len() as i64,
        },
        Some(prev) => {
            if current.len() > prev.len() {
                let delta = current[prev.len()..].to_vec();
                let count = delta.len() as i64;
                MessagesDelta {
                    messages_delta: delta,
                    messages_delta_count: count,
                }
            } else {
                MessagesDelta {
                    messages_delta: Vec::new(),
                    messages_delta_count: 0,
                }
            }
        }
    }
}

/// Compute the true delta between current and previous messages arrays.
///
/// # Caller contract (STABLE — see also `GraphStore::get_previous_messages_prefix_marker`)
///
/// `current_messages` is a JSON-serialized array of message objects matching
/// the wire-format `messages[]` of the current turn's request. This is used
/// fully — both `.len()` and each element's contents are read.
///
/// `previous_messages` is a JSON-serialized array whose **only observable
/// property `compute_true_delta` reads is `.len()`**. The array may be the
/// real cumulative prior conversation, OR a length-only synthesized marker
/// (e.g. an array of `null` values produced by
/// [`crate::storage::graph::GraphStore::get_previous_messages_prefix_marker`]).
/// Callers MUST treat the shape as opaque beyond its length.
///
/// A future change that inspects `previous[i]` (e.g. to do structural
/// comparison) is a **breaking contract change** and must update every
/// `GraphStore` implementation to materialise real messages.
///
/// # Behaviour
///
/// Returns a JSON-serialized array of `current[previous.len()..]` — the new
/// messages that were appended since the previous turn.
///
/// - If `previous` is `None` or empty string: returns `current` as-is (first turn).
/// - If `current.len() <= previous.len()`: returns `"[]"` (empty delta).
///
/// # Bug #1 / FIND-1-F backward-compat safety clamp
///
/// If `previous.len() > current.len()`, we have a contract violation —
/// either (a) the caller computed a bogus marker length (e.g. from pre-fix
/// on-disk data where `messages_delta_count` was overshot), or (b) the
/// `messages[]` array on the wire actually shrank (pathological /
/// impossible under normal LLM-request semantics). Rather than silently
/// returning `"[]"` (which would drop the whole turn's attachments on the
/// first post-upgrade turn of a resumed pre-fix session), we **fall back
/// to treating the current turn's last message as the delta**. This is
/// always safe:
/// * It over-reports at worst: the last message is always a new user
///   message (Claude Code / Codex always append the new user turn last).
/// * It never re-catalogues historical attachments beyond this single
///   last message.
/// * It guarantees the new turn's attachments are captured even when the
///   cumulative-count bookkeeping got corrupted upstream.
///
/// Operators who want to eliminate this fallback fully should recompute
/// `messages_delta_count` on pre-fix sessions on upgrade (see
/// `docs/Recondo_Business_Plan_v0.4.md`). Until then, the clamp ensures
/// forward captures remain correct.
pub fn compute_true_delta(
    current_messages: &str,
    previous_messages: Option<&str>,
) -> Result<String> {
    let current: Vec<serde_json::Value> = serde_json::from_str(current_messages)?;

    let previous = match previous_messages {
        None | Some("") => {
            return Ok(serde_json::to_string(&current)?);
        }
        Some(prev_str) => {
            let prev: Vec<serde_json::Value> = serde_json::from_str(prev_str)?;
            prev
        }
    };

    if current.len() > previous.len() {
        let delta = &current[previous.len()..];
        Ok(serde_json::to_string(delta)?)
    } else if previous.len() > current.len() && !current.is_empty() {
        // FIND-1-F safety clamp: pre-fix data can report a `previous.len()`
        // larger than the current wire messages[]. Fall back to
        // "last message only" as a safe delta — never silently return "[]"
        // because that would drop real new attachments on every post-upgrade
        // turn of a resumed pre-fix session.
        let delta = &current[current.len() - 1..];
        Ok(serde_json::to_string(delta)?)
    } else {
        // Equal lengths OR current is empty: no new messages to report.
        Ok("[]".to_string())
    }
}

/// Parse a raw JSON request body (for the Anthropic Messages API) into a ParsedRequest.
pub fn parse_request(body: &[u8]) -> Result<ParsedRequest> {
    let v: serde_json::Value = serde_json::from_slice(body)?;

    let obj = v
        .as_object()
        .ok_or_else(|| anyhow!("Request body must be a JSON object"))?;

    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("Missing or invalid 'model' field"))?
        .to_string();

    // max_tokens may be absent in future Anthropic API versions or when
    // using server-side defaults. Default to 0 when missing since this
    // field is not used after parsing — it is only stored for reference.
    let max_tokens = obj.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(0);

    let messages = obj
        .get("messages")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("Missing or invalid 'messages' field"))?
        .clone();

    // Parse system prompt: can be a string or an array of text blocks
    let system = match obj.get("system") {
        None => None,
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Array(arr)) => {
            let mut parts = Vec::new();
            for item in arr {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    parts.push(text.to_string());
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(""))
            }
        }
        Some(_) => None,
    };

    let tools = obj.get("tools").and_then(|v| v.as_array()).cloned();

    Ok(ParsedRequest {
        model,
        messages,
        system,
        tools,
        max_tokens,
    })
}
