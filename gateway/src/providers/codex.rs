//! Codex/OpenAI WebSocket frame parser and accumulator.
//!
//! Codex communicates over WebSocket text frames containing JSON messages.
//! A logical "turn" is delimited by `codex.rate_limits` messages: the first
//! `rate_limits` opens a turn (providing the model name), and the next
//! `rate_limits` after content frames closes it.
//!
//! ## Frame types
//!
//! - `codex.rate_limits` — contains model name in `additional_rate_limits` keys
//! - `response.output_item.added` — turn phase indicator (reasoning or message)
//! - `response.output_text.delta` — incremental response text
//! - `response.output_text.done` — complete text for one output
//! - `response.output_item.done` — complete item with type, content, status
//! - `response.content_part.done` — complete content part text
//!
//! ## Token estimation
//!
//! Codex WebSocket frames do not include token usage data. Tokens are estimated:
//! - Text tokens: `ceil(text.len() / 4)` (approximate bytes-per-token ratio)
//! - Encrypted reasoning tokens: `ceil(blob.len() / 6)` (accounts for base64 overhead)
//!
//! Token estimation accuracy: ~80-90% for English text, less accurate for
//! CJK/emoji. The flag `tokens_estimated: true` signals downstream consumers
//! that these are estimates, not actual counts from the provider.

use anyhow::{anyhow, Result};
use tracing::warn;

/// Maximum accumulated text size in bytes (10 MB). If delta text exceeds this
/// limit, further deltas are silently dropped and `truncated` is set to true.
/// This prevents unbounded memory growth from a malicious or runaway upstream.
pub const MAX_ACCUMULATED_TEXT: usize = 10_485_760;

// ---------------------------------------------------------------------------
// Frame types
// ---------------------------------------------------------------------------

/// Parsed Codex WebSocket frame types.
#[derive(Debug)]
pub enum CodexFrameType {
    /// `codex.rate_limits` — appears between turns. The `model` is extracted
    /// from the first key in `additional_rate_limits`.
    RateLimits { model: Option<String> },
    /// `response.output_text.done` — complete text for one output item.
    OutputTextDone { text: String },
    /// `response.output_text.delta` — incremental text chunk.
    OutputTextDelta { delta: String },
    /// `response.output_item.done` — complete item (message or reasoning).
    OutputItemDone {
        item_type: String,
        content_text: Option<String>,
        status: Option<String>,
        encrypted_content: Option<String>,
    },
    /// `response.output_item.added` — start of a new item phase.
    OutputItemAdded { item_type: String },
    /// `response.content_part.done` — complete content part text.
    ContentPartDone { text: String },
    /// `response.content_part.added` — start of a new content part.
    ContentPartAdded,
    /// `response.function_call_arguments.delta` — incremental function call argument chunk.
    FunctionCallArgumentsDelta { delta: String },
    /// `response.function_call_arguments.done` — complete function call arguments.
    FunctionCallArgumentsDone { arguments: String },
    /// Unknown/unrecognized frame type (forward compatibility).
    Unknown { frame_type: String },
}

// ---------------------------------------------------------------------------
// Frame parser
// ---------------------------------------------------------------------------

/// Parse a single Codex WebSocket JSON frame into a typed variant.
///
/// Returns `Err` for malformed JSON or missing `type` field.
/// Returns `Ok(Unknown { .. })` for valid JSON with an unrecognized type.
pub fn parse_codex_frame(json: &str) -> Result<CodexFrameType> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| anyhow!("malformed JSON: {}", e))?;

    let obj = v
        .as_object()
        .ok_or_else(|| anyhow!("frame must be a JSON object"))?;

    let frame_type = obj
        .get("type")
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("frame missing 'type' field"))?;

    match frame_type {
        "codex.rate_limits" => {
            // Extract model name from the first key in additional_rate_limits
            let model = obj
                .get("additional_rate_limits")
                .and_then(|arl| arl.as_object())
                .and_then(|map| map.keys().next())
                .map(|k| k.to_string());
            Ok(CodexFrameType::RateLimits { model })
        }
        "response.output_text.done" => {
            let text = obj
                .get("text")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            Ok(CodexFrameType::OutputTextDone { text })
        }
        "response.output_text.delta" => {
            let delta = obj
                .get("delta")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            Ok(CodexFrameType::OutputTextDelta { delta })
        }
        "response.output_item.done" => {
            let item = obj.get("item");
            let item_type = item
                .and_then(|i| i.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string();
            let status = item
                .and_then(|i| i.get("status"))
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());

            // For "message" items, extract content text from item.content[].text
            let content_text = if item_type == "message" {
                item.and_then(|i| i.get("content"))
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|part| part.get("text"))
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            };

            // For "reasoning" items, extract encrypted_content
            let encrypted_content = if item_type == "reasoning" {
                item.and_then(|i| i.get("encrypted_content"))
                    .and_then(|e| e.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            };

            Ok(CodexFrameType::OutputItemDone {
                item_type,
                content_text,
                status,
                encrypted_content,
            })
        }
        "response.output_item.added" => {
            let item_type = obj
                .get("item")
                .and_then(|i| i.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("unknown")
                .to_string();
            Ok(CodexFrameType::OutputItemAdded { item_type })
        }
        "response.content_part.done" => {
            let text = obj
                .get("part")
                .and_then(|p| p.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .to_string();
            Ok(CodexFrameType::ContentPartDone { text })
        }
        "response.content_part.added" => Ok(CodexFrameType::ContentPartAdded),
        "response.function_call_arguments.delta" => {
            let delta = obj
                .get("delta")
                .and_then(|d| d.as_str())
                .unwrap_or("")
                .to_string();
            Ok(CodexFrameType::FunctionCallArgumentsDelta { delta })
        }
        "response.function_call_arguments.done" => {
            let arguments = obj
                .get("arguments")
                .and_then(|a| a.as_str())
                .unwrap_or("")
                .to_string();
            Ok(CodexFrameType::FunctionCallArgumentsDone { arguments })
        }
        other => Ok(CodexFrameType::Unknown {
            frame_type: other.to_string(),
        }),
    }
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/// Estimate token count from text using ceil(len / 4).
///
/// This is a rough approximation: English text averages ~4 bytes per token
/// for GPT-family tokenizers. Returns 0 for empty strings.
pub fn estimate_tokens(text: &str) -> i64 {
    let len = text.len();
    if len == 0 {
        return 0;
    }
    // Defensive clamp to prevent theoretical overflow on extremely large inputs.
    // Practically unreachable with MAX_ACCUMULATED_TEXT (10 MB) cap, but defense in depth.
    (len as f64 / 4.0).ceil().min(i64::MAX as f64) as i64
}

/// Estimate token count from a base64-encoded encrypted blob using ceil(len / 6).
///
/// Base64 encoding has ~1.33x overhead over raw bytes, so dividing by 6 instead
/// of 4 accounts for this expansion. Returns 0 for empty strings.
pub fn estimate_encrypted_tokens(blob: &str) -> i64 {
    let len = blob.len();
    if len == 0 {
        return 0;
    }
    // Defensive clamp to prevent theoretical overflow on extremely large inputs.
    (len as f64 / 6.0).ceil().min(i64::MAX as f64) as i64
}

// ---------------------------------------------------------------------------
// Accumulated turn data
// ---------------------------------------------------------------------------

/// Data accumulated from a complete Codex turn (multiple WebSocket frames).
#[derive(Debug, Clone)]
pub struct CodexTurnData {
    /// Model name extracted from `codex.rate_limits`.
    pub model: Option<String>,
    /// Response text from `response.output_text.done` or accumulated deltas.
    pub response_text: Option<String>,
    /// Whether any reasoning items were present in this turn.
    pub has_reasoning: bool,
    /// Total size (in bytes) of encrypted reasoning content.
    pub reasoning_encrypted_size: usize,
    /// Estimated input tokens (from client request frame content).
    pub estimated_input_tokens: i64,
    /// Estimated output tokens: ceil(response_text.len() / 4).
    pub estimated_output_tokens: i64,
    /// Estimated thinking tokens: ceil(encrypted_content.len() / 6).
    pub estimated_thinking_tokens: i64,
    /// Always true for Codex (no actual usage data in WebSocket frames).
    pub tokens_estimated: bool,
    /// True if accumulated text was truncated due to exceeding MAX_ACCUMULATED_TEXT.
    pub truncated: bool,
}

// ---------------------------------------------------------------------------
// Stateful accumulator
// ---------------------------------------------------------------------------

/// Accumulates Codex WebSocket frames into a single logical turn.
///
/// A turn starts with the first `codex.rate_limits` frame and ends when
/// a second `codex.rate_limits` frame arrives after content frames have
/// been received. Consecutive `rate_limits` without content between them
/// do not trigger false completion.
pub struct CodexFrameAccumulator {
    /// Model name from the first rate_limits frame.
    model: Option<String>,
    /// Authoritative response text from `output_text.done`.
    done_text: Option<String>,
    /// Accumulated delta text (used as fallback if no `output_text.done`).
    delta_text: String,
    /// Whether any reasoning items were present.
    has_reasoning: bool,
    /// Total encrypted reasoning content size.
    reasoning_encrypted_size: usize,
    /// Number of rate_limits frames seen.
    rate_limits_count: usize,
    /// Whether any content frames have been seen since the last rate_limits.
    has_content_since_rate_limits: bool,
    /// Whether the turn is complete (second rate_limits after content).
    complete: bool,
    /// Whether accumulated text was truncated due to exceeding MAX_ACCUMULATED_TEXT.
    truncated: bool,
}

impl CodexFrameAccumulator {
    /// Create a new accumulator with no state.
    pub fn new() -> Self {
        CodexFrameAccumulator {
            model: None,
            done_text: None,
            delta_text: String::new(),
            has_reasoning: false,
            reasoning_encrypted_size: 0,
            rate_limits_count: 0,
            has_content_since_rate_limits: false,
            complete: false,
            truncated: false,
        }
    }

    /// Feed a parsed frame into the accumulator.
    pub fn feed(&mut self, frame: CodexFrameType) {
        match frame {
            CodexFrameType::RateLimits { model } => {
                self.rate_limits_count += 1;
                // First rate_limits sets the model name
                if self.rate_limits_count == 1 {
                    self.model = model;
                } else if self.has_content_since_rate_limits {
                    // Second (or later) rate_limits after content = turn boundary
                    self.complete = true;
                }
                // Reset content flag for the next inter-rate_limits interval.
                // NOTE: This is intentional — consecutive rate_limits without
                // content between them do NOT trigger a false turn boundary.
                // The `has_content_since_rate_limits` gate ensures only
                // rate_limits frames that follow actual content complete a turn.
                self.has_content_since_rate_limits = false;
            }
            CodexFrameType::OutputTextDone { text } => {
                self.done_text = Some(text);
                self.has_content_since_rate_limits = true;
            }
            CodexFrameType::OutputTextDelta { delta } => {
                if self.delta_text.len() + delta.len() > MAX_ACCUMULATED_TEXT {
                    if !self.truncated {
                        warn!(
                            accumulated = self.delta_text.len(),
                            delta_len = delta.len(),
                            limit = MAX_ACCUMULATED_TEXT,
                            "Codex accumulated text exceeds limit, truncating"
                        );
                        self.truncated = true;
                    }
                    // Stop accumulating but still mark content as present
                } else {
                    self.delta_text.push_str(&delta);
                }
                self.has_content_since_rate_limits = true;
            }
            CodexFrameType::OutputItemDone {
                ref item_type,
                ref encrypted_content,
                ref content_text,
                ref status,
                ..
            } => {
                if item_type == "reasoning" {
                    self.has_reasoning = true;
                    if let Some(ref ec) = encrypted_content {
                        self.reasoning_encrypted_size += ec.len();
                    }
                }
                // A message item with status "completed" is the final item in a turn.
                // This is the primary turn completion signal for Codex, since
                // rate_limits frames are NOT reliably sent between turns.
                if item_type == "message" {
                    if let Some(ref text) = content_text {
                        if self.done_text.is_none() {
                            self.done_text = Some(text.clone());
                        }
                    }
                    if status.as_deref() == Some("completed") {
                        self.complete = true;
                    }
                }
                self.has_content_since_rate_limits = true;
            }
            CodexFrameType::OutputItemAdded { item_type } => {
                if item_type == "reasoning" {
                    self.has_reasoning = true;
                }
                self.has_content_since_rate_limits = true;
            }
            CodexFrameType::ContentPartDone { .. } => {
                self.has_content_since_rate_limits = true;
            }
            CodexFrameType::ContentPartAdded => {
                self.has_content_since_rate_limits = true;
            }
            CodexFrameType::FunctionCallArgumentsDelta { .. } => {
                // Tool call arguments are streaming — track as content
                self.has_content_since_rate_limits = true;
            }
            CodexFrameType::FunctionCallArgumentsDone { .. } => {
                // Tool call complete — track as content
                self.has_content_since_rate_limits = true;
            }
            CodexFrameType::Unknown { .. } => {
                // Unknown frames are silently ignored — forward compatibility
            }
        }
    }

    /// Returns true when a complete turn has been accumulated
    /// (a second `rate_limits` frame was received after content).
    pub fn is_complete(&self) -> bool {
        self.complete
    }

    /// Returns true if the accumulator has any in-progress content
    /// (non-empty delta_text or done_text). Used to detect partial data
    /// on connection drops so it can be flushed rather than silently discarded.
    pub fn has_content(&self) -> bool {
        self.done_text.is_some() || !self.delta_text.is_empty()
    }

    /// Consume the accumulator and return the accumulated turn data.
    ///
    /// Call this after `is_complete()` returns true (or on an empty
    /// accumulator for safe default values).
    pub fn finish(self) -> CodexTurnData {
        // Prefer done_text (authoritative), fall back to accumulated deltas
        let response_text = if self.done_text.is_some() {
            self.done_text
        } else if !self.delta_text.is_empty() {
            Some(self.delta_text)
        } else {
            None
        };

        let estimated_output_tokens = response_text.as_deref().map(estimate_tokens).unwrap_or(0);

        let estimated_thinking_tokens = if self.reasoning_encrypted_size > 0 {
            // Build a string of the right length to pass to estimate_encrypted_tokens
            // We already stored the total size, so compute directly
            (self.reasoning_encrypted_size as f64 / 6.0).ceil() as i64
        } else {
            0
        };

        CodexTurnData {
            model: self.model,
            response_text,
            has_reasoning: self.has_reasoning,
            reasoning_encrypted_size: self.reasoning_encrypted_size,
            estimated_input_tokens: 0, // Input tokens are estimated from client frames separately
            estimated_output_tokens,
            estimated_thinking_tokens,
            tokens_estimated: true,
            truncated: self.truncated,
        }
    }
}

impl Default for CodexFrameAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Request parsing (client → server `response.create` frames)
// ---------------------------------------------------------------------------

/// Data extracted from a Codex `response.create` client frame.
///
/// The `response.create` frame is sent by the Codex client to initiate an LLM
/// turn. It contains the model, system prompt (instructions), conversation
/// messages (input[]), and available tools. This data is more accurate than
/// the server-side `codex.rate_limits` frame for model identification and
/// provides the user's prompt for session intent tracking.
#[derive(Debug, Clone)]
pub struct CodexRequestData {
    /// Model name from the `model` field (e.g., "gpt-5.4").
    /// More accurate than the rate_limits model name.
    pub model: Option<String>,
    /// The user's prompt: text from the LAST `input[]` item with `role: "user"`.
    pub user_prompt: Option<String>,
    /// The system prompt from the `instructions` field.
    /// N1: Stored for future compliance features (prompt content auditing).
    /// Currently only the hash is used in production; the full text is
    /// preserved in the raw bytes object store.
    pub system_prompt: Option<String>,
    /// SHA-256 hex hash of the `instructions` field.
    pub system_prompt_hash: Option<String>,
    /// Serialized JSON string of the `input[]` array.
    pub messages_json: Option<String>,
    /// Number of tools in the `tools[]` array.
    pub tool_count: usize,
    /// Inline attachments (images, PDFs) extracted from `input[].content[]`
    /// parts of type `input_image`. Codex's content schema uses the same
    /// shape as OpenAI's chat completion messages but with
    /// `type: "input_image"` and `image_url` as a flat string instead of
    /// `{url: "..."}`. We translate the shape and delegate to the OpenAI
    /// extractor so SSRF guards / MIME allow-list / decoder are reused.
    /// **Stable ordinal:** `sequence_num` is 1-based across the whole
    /// `input[]` array so dashboard `[Image #N]` placeholders match.
    pub attachments: Vec<crate::capture::attachments::ExtractedAttachment>,
    /// Per-attachment parse errors (`attachment.mime_disallowed`,
    /// `attachment.decode_failed`, etc.) suitable for the turn record's
    /// `parse_errors` column.
    pub attachment_parse_errors: Vec<String>,
}

/// Parse a Codex `response.create` WebSocket frame to extract request data.
///
/// Returns `Err` for malformed JSON. Returns `Err` for frames whose `type` is
/// not `"response.create"` (callers should silently ignore non-request frames).
///
/// # Fields extracted
///
/// - `model` — the `model` string field
/// - `instructions` — becomes `system_prompt`, and its SHA-256 → `system_prompt_hash`
/// - `input[]` — the LAST item with `role: "user"` provides `user_prompt`;
///   the full array is serialized as `messages_json`
/// - `tools[]` — array length becomes `tool_count`
pub fn parse_codex_request(json: &str) -> Result<CodexRequestData> {
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| anyhow!("malformed JSON: {}", e))?;

    let obj = v
        .as_object()
        .ok_or_else(|| anyhow!("frame must be a JSON object"))?;

    // Verify this is a response.create frame
    let frame_type = obj
        .get("type")
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("frame missing 'type' field"))?;

    if frame_type != "response.create" {
        return Err(anyhow!(
            "not a response.create frame (type: {})",
            frame_type
        ));
    }

    // Extract model
    let model = obj
        .get("model")
        .and_then(|m| m.as_str())
        .map(|s| s.to_string());

    // Extract instructions → system_prompt + system_prompt_hash
    let system_prompt = obj
        .get("instructions")
        .and_then(|i| i.as_str())
        .map(|s| s.to_string());

    let system_prompt_hash = system_prompt
        .as_deref()
        .map(|s| crate::hash::sha256_hex(s.as_bytes()));

    // Extract input[] array
    let input_array = obj.get("input").and_then(|i| i.as_array());

    // Find the LAST user message in input[]
    let user_prompt = input_array.and_then(|arr| {
        arr.iter()
            .rev()
            .find(|item| item.get("role").and_then(|r| r.as_str()) == Some("user"))
            .and_then(|item| {
                item.get("content")
                    .and_then(|c| c.as_array())
                    .and_then(|parts| parts.first())
                    .and_then(|part| part.get("text"))
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
            })
    });

    // Serialize input[] as JSON string. W2 fix: truncate to 256KB to prevent
    // unbounded storage in SQLite messages_delta column for long conversations.
    const MAX_MESSAGES_JSON: usize = 262_144;
    let messages_json = input_array.map(|arr| {
        let json = serde_json::to_string(&serde_json::Value::Array(arr.clone()))
            .unwrap_or_else(|_| "[]".to_string());
        if json.len() > MAX_MESSAGES_JSON {
            // N1 fix: truncate at a char boundary, not a byte boundary,
            // to avoid splitting multi-byte chars or \uXXXX escape sequences.
            let truncated: String = json.chars().take(MAX_MESSAGES_JSON).collect();
            format!("{}...TRUNCATED", truncated)
        } else {
            json
        }
    });

    // Count tools
    let tool_count = obj
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|arr| arr.len())
        .unwrap_or(0);

    // Extract inline attachments. Codex content parts have shape
    // `{type: "input_image", image_url: "data:...", detail: "high"}` —
    // OpenAI uses `{type: "image_url", image_url: {url: "..."}}` with a
    // nested object. Reshape codex parts to OpenAI shape so we can
    // delegate to `extract_openai_with_errors` (200+ lines of
    // battle-tested data-URI / SSRF / MIME-allow-list / sniffing code).
    let (attachments, attachment_parse_errors) =
        extract_attachments_from_codex_input(input_array.unwrap_or(&Vec::new()));

    Ok(CodexRequestData {
        model,
        user_prompt,
        system_prompt,
        system_prompt_hash,
        messages_json,
        tool_count,
        attachments,
        attachment_parse_errors,
    })
}

/// Reshape Codex `input[].content[]` parts into OpenAI-shaped messages and
/// delegate to the OpenAI attachment extractor.
///
/// Codex part shape: `{type: "input_image", image_url: "data:image/png;base64,..."}`.
/// OpenAI part shape: `{type: "image_url", image_url: {url: "data:..."}}`.
///
/// `text` parts are passed through unchanged (the OpenAI extractor
/// ignores them). Tool / function-call / tool-result parts are dropped —
/// they don't carry attachment payload.
fn extract_attachments_from_codex_input(
    input: &[serde_json::Value],
) -> (
    Vec<crate::capture::attachments::ExtractedAttachment>,
    Vec<String>,
) {
    use serde_json::{json, Value};

    // Codex sends the FULL conversation history in every `response.create`,
    // so the latest `input[]` array contains every prior message including
    // images from earlier turns. Walking the whole array would re-extract
    // (and re-persist) the same image on every subsequent turn. Mirror the
    // HTTP path's fallback in `capture_pipeline.rs:1041` (when no
    // `messages_delta` is available, scan only the LAST user message —
    // attachments the user just added live there). Tool-result frames
    // appended after the user's message are skipped because they don't
    // carry inline images in the codex content schema.
    let last_user = input
        .iter()
        .rev()
        .find(|item| item.get("role").and_then(|r| r.as_str()) == Some("user"));
    let scan: &[Value] = match last_user {
        Some(item) => std::slice::from_ref(item),
        None => return (Vec::new(), Vec::new()),
    };

    let mut openai_messages: Vec<Value> = Vec::with_capacity(scan.len());
    for item in scan {
        let role = item
            .get("role")
            .and_then(|r| r.as_str())
            .unwrap_or("user")
            .to_string();
        let content = match item.get("content").and_then(|c| c.as_array()) {
            Some(parts) => parts,
            None => continue,
        };
        let mut reshaped_parts: Vec<Value> = Vec::with_capacity(content.len());
        for part in content {
            let part_type = part.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match part_type {
                "input_image" => {
                    // Codex stores image_url as a flat string. Wrap it.
                    let image_url_str = match part.get("image_url").and_then(|v| v.as_str()) {
                        Some(s) => s,
                        None => continue,
                    };
                    let mut image_url_obj = serde_json::Map::new();
                    image_url_obj.insert("url".to_string(), json!(image_url_str));
                    if let Some(detail) = part.get("detail") {
                        image_url_obj.insert("detail".to_string(), detail.clone());
                    }
                    reshaped_parts.push(json!({
                        "type": "image_url",
                        "image_url": Value::Object(image_url_obj),
                    }));
                }
                _ => {
                    // Pass-through; OpenAI extractor ignores non-image_url parts.
                    reshaped_parts.push(part.clone());
                }
            }
        }
        openai_messages.push(json!({
            "role": role,
            "content": reshaped_parts,
        }));
    }

    match crate::capture::attachments::extract_from_messages_with_errors("openai", &openai_messages)
    {
        Ok(pair) => pair,
        Err(e) => (
            Vec::new(),
            vec![format!("attachment.codex_extract_failed: {}", e)],
        ),
    }
}
