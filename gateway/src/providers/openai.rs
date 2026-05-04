use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::ProviderAdapter;

/// A tool call extracted from an OpenAI response, normalized to the Recondo schema.
/// Uses the same field names as `anthropic::ToolCall` for consistency.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: String,
}

/// Parsed OpenAI Chat Completions request body.
#[derive(Debug, Clone)]
pub struct OpenAiParsedRequest {
    /// The model name (e.g., "gpt-4o-2024-05-13").
    pub model: String,
    /// The messages array from the request body.
    pub messages: Vec<serde_json::Value>,
    /// The system message content, if a message with role "system" is present.
    pub system: Option<String>,
    /// The tools array, if present.
    pub tools: Option<Vec<serde_json::Value>>,
    /// The max_tokens value, or 0 if not specified.
    pub max_tokens: u64,
}

/// Parsed OpenAI response, extracted from accumulated SSE events or a single
/// non-streaming response.
#[derive(Debug, Clone)]
pub struct OpenAiParsedResponse {
    /// Concatenated text from all `delta.content` chunks.
    pub response_text: String,
    /// Tool calls accumulated from streamed tool call chunks.
    pub tool_calls: Vec<ToolCall>,
    /// Stop reason from the final chunk's `finish_reason` field.
    pub stop_reason: String,
    /// Input tokens from the `usage.prompt_tokens` field.
    pub input_tokens: u64,
    /// Output tokens from the `usage.completion_tokens` field.
    pub output_tokens: u64,
    /// Cache read tokens from `usage.prompt_tokens_details.cached_tokens` (OpenAI).
    pub cache_read_tokens: u64,
    /// Cache creation tokens (OpenAI does not report this; always 0).
    pub cache_creation_tokens: u64,
    /// Model name from the SSE chunk JSON.
    pub model: String,
    /// Message ID from the SSE chunk's top-level `id` field.
    pub message_id: String,
    /// Unknown fields preserved as JSON.
    pub raw_extra: Option<String>,
    /// Parser version (semver).
    pub parser_version: Option<String>,
    /// List of parse error strings.
    pub parse_errors: Option<Vec<String>>,
}

/// Metadata extracted from OpenAI/Codex WebSocket upgrade request headers.
///
/// Maps header fields to Recondo's common identity model per
/// PROVIDER_IDENTITY_MAPPING.md.
#[derive(Debug, Clone, Default)]
pub struct OpenAiMetadata {
    /// Per-connection session ID from the `session_id` header.
    pub session_id: Option<String>,
    /// OpenAI account UUID from the `chatgpt-account-id` header.
    pub account_uuid: Option<String>,
    /// Device ID — always `None` for Codex CLI (no machine identifier sent).
    pub device_id: Option<String>,
    /// Agent framework from the `originator` header (e.g., "codex_cli_rs").
    pub framework: Option<String>,
    /// Agent version from the `version` header (e.g., "0.116.0").
    pub agent_version: Option<String>,
}

/// The OpenAI provider adapter. Implements `ProviderAdapter` for OpenAI
/// hosts (api.openai.com, chatgpt.com, ab.chatgpt.com).
pub struct OpenAiAdapter;

impl OpenAiAdapter {
    /// Create a new OpenAiAdapter.
    pub fn new() -> Self {
        OpenAiAdapter
    }
}

impl Default for OpenAiAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderAdapter for OpenAiAdapter {
    fn detect(&self, host: &str, _path: &str) -> bool {
        let hostname = match host.rsplit_once(':') {
            Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
            _ => host,
        };
        let lower = hostname.to_ascii_lowercase();
        matches!(
            lower.as_str(),
            "api.openai.com" | "chatgpt.com" | "ab.chatgpt.com"
        )
    }

    fn parse_request(&self, body: &[u8]) -> Result<super::GenericParsedRequest> {
        let parsed = parse_openai_request(body)?;
        Ok(super::GenericParsedRequest {
            model: parsed.model,
            messages: parsed.messages,
            system: parsed.system,
            tools: parsed.tools,
            max_tokens: parsed.max_tokens,
            // OpenAI request parser raises hard errors on schema mismatch
            // (missing `model` / `messages`), so when this conversion runs
            // the body was well-formed and there is nothing to report.
            parse_errors: None,
        })
    }

    fn parse_response(&self, body: &[u8]) -> Result<super::GenericParsedResponse> {
        let parsed = parse_openai_response(body)?;
        Ok(super::GenericParsedResponse {
            response_text: parsed.response_text,
            model: parsed.model,
            stop_reason: parsed.stop_reason,
            input_tokens: parsed.input_tokens,
            output_tokens: parsed.output_tokens,
            cache_read_tokens: parsed.cache_read_tokens,
            cache_creation_tokens: parsed.cache_creation_tokens,
            parse_errors: parsed.parse_errors,
        })
    }

    fn parse_sse_events(&self, events: &str) -> Result<super::GenericParsedResponse> {
        let parsed = parse_openai_sse_events(events)?;
        Ok(super::GenericParsedResponse {
            response_text: parsed.response_text,
            model: parsed.model,
            stop_reason: parsed.stop_reason,
            input_tokens: parsed.input_tokens,
            output_tokens: parsed.output_tokens,
            cache_read_tokens: parsed.cache_read_tokens,
            cache_creation_tokens: parsed.cache_creation_tokens,
            parse_errors: parsed.parse_errors,
        })
    }
}

/// Parse an OpenAI Chat Completions request body.
///
/// Extracts model, messages, system prompt (from any system role message),
/// tools, and max_tokens from the JSON request body.
pub fn parse_openai_request(body: &[u8]) -> Result<OpenAiParsedRequest> {
    let v: serde_json::Value = serde_json::from_slice(body)?;

    let obj = v
        .as_object()
        .ok_or_else(|| anyhow!("Request body must be a JSON object"))?;

    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("Missing or invalid 'model' field"))?
        .to_string();

    let messages = obj
        .get("messages")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("Missing or invalid 'messages' field"))?
        .clone();

    // Extract system prompt: look for the first message with role "system"
    let system = messages
        .iter()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("system"))
        .and_then(|m| m.get("content").and_then(|c| c.as_str()))
        .map(|s| s.to_string());

    let max_tokens = obj.get("max_tokens").and_then(|v| v.as_u64()).unwrap_or(0);

    let tools = obj.get("tools").and_then(|v| v.as_array()).cloned();

    Ok(OpenAiParsedRequest {
        model,
        messages,
        system,
        tools,
        max_tokens,
    })
}

/// Parse a non-streaming OpenAI Chat Completions response body.
///
/// Extracts model, response text, tool calls, stop reason, and token counts
/// from a single JSON response object.
pub fn parse_openai_response(body: &[u8]) -> Result<OpenAiParsedResponse> {
    let v: serde_json::Value = serde_json::from_slice(body)?;

    let obj = v
        .as_object()
        .ok_or_else(|| anyhow!("Response body must be a JSON object"))?;

    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let message_id = obj
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let choice = obj
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first());

    let response_text = choice
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    let stop_reason = choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|f| f.as_str())
        .unwrap_or("")
        .to_string();

    let tool_calls = extract_tool_calls_from_message(choice.and_then(|c| c.get("message")));

    let usage = obj.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|t| t.as_u64())
        .unwrap_or(0);
    let cache_read_tokens = usage
        .and_then(|u| u.get("prompt_tokens_details"))
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|t| t.as_u64())
        .unwrap_or(0);

    Ok(OpenAiParsedResponse {
        response_text,
        tool_calls,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens: 0,
        model,
        message_id,
        raw_extra: None,
        parser_version: Some("0.1.0".to_string()),
        parse_errors: None,
    })
}

/// Extract tool calls from a non-streaming OpenAI message object.
fn extract_tool_calls_from_message(message: Option<&serde_json::Value>) -> Vec<ToolCall> {
    let Some(msg) = message else {
        return Vec::new();
    };
    let Some(tcs) = msg.get("tool_calls").and_then(|t| t.as_array()) else {
        return Vec::new();
    };

    tcs.iter()
        .filter_map(|tc| {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let func = tc.get("function")?;
            let name = func
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = func
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Some(ToolCall {
                id,
                name,
                input: arguments,
            })
        })
        .collect()
}

/// Tracks a tool call being accumulated from streamed SSE chunks.
#[derive(Debug)]
struct StreamingToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Parse OpenAI SSE streaming response events.
///
/// OpenAI SSE format:
/// - Each event is `data: {JSON}\n\n`
/// - Terminal signal is `data: [DONE]\n\n`
/// - Content arrives as `choices[0].delta.content` chunks
/// - Tool calls arrive as `choices[0].delta.tool_calls[]` chunks with index-based accumulation
/// - Token usage appears in the final chunk's `usage` field
/// - The model name appears in every chunk
/// - The message ID appears in every chunk as the top-level `id` field
pub fn parse_openai_sse_events(events: &str) -> Result<OpenAiParsedResponse> {
    let mut response_text = String::new();
    let mut tool_calls_map: HashMap<u64, StreamingToolCall> = HashMap::new();
    let mut stop_reason = String::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut cache_read_tokens: u64 = 0;
    let mut model = String::new();
    let mut message_id = String::new();
    let mut parse_errors_list: Vec<String> = Vec::new();
    let mut parsed_any = false;

    for line in events.lines() {
        let data = if let Some(rest) = line.strip_prefix("data: ") {
            rest.trim()
        } else if let Some(rest) = line.strip_prefix("data:") {
            rest.trim()
        } else {
            continue;
        };

        // Terminal signal
        if data == "[DONE]" {
            continue;
        }

        // Parse JSON
        let v: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(e) => {
                parse_errors_list.push(format!("malformed JSON in SSE event: {}", e));
                continue;
            }
        };
        parsed_any = true;

        // Extract model from every chunk (overwrite each time — they should be the same)
        if let Some(m) = v.get("model").and_then(|m| m.as_str()) {
            model = m.to_string();
        }

        // Extract message ID from every chunk
        if let Some(id) = v.get("id").and_then(|i| i.as_str()) {
            message_id = id.to_string();
        }

        // Extract from choices[0]
        if let Some(choice) = v
            .get("choices")
            .and_then(|c| c.as_array())
            .and_then(|a| a.first())
        {
            // Extract delta.content
            if let Some(content) = choice
                .get("delta")
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
            {
                response_text.push_str(content);
            }

            // Extract finish_reason
            if let Some(fr) = choice.get("finish_reason").and_then(|f| f.as_str()) {
                stop_reason = fr.to_string();
            }

            // Extract tool calls from delta
            if let Some(tcs) = choice
                .get("delta")
                .and_then(|d| d.get("tool_calls"))
                .and_then(|t| t.as_array())
            {
                for tc in tcs {
                    let index = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0);

                    // If this chunk has an id, it's the start of a new tool call
                    if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                        let name = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                            .unwrap_or("")
                            .to_string();
                        let arguments = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(|a| a.as_str())
                            .unwrap_or("")
                            .to_string();
                        tool_calls_map.insert(
                            index,
                            StreamingToolCall {
                                id: id.to_string(),
                                name,
                                arguments,
                            },
                        );
                    } else if let Some(existing) = tool_calls_map.get_mut(&index) {
                        // Continuation chunk — accumulate arguments
                        if let Some(args) = tc
                            .get("function")
                            .and_then(|f| f.get("arguments"))
                            .and_then(|a| a.as_str())
                        {
                            existing.arguments.push_str(args);
                        }
                        // Update name if present (shouldn't happen, but be safe)
                        if let Some(name) = tc
                            .get("function")
                            .and_then(|f| f.get("name"))
                            .and_then(|n| n.as_str())
                        {
                            existing.name = name.to_string();
                        }
                    }
                }
            }
        }

        // Extract usage from the final chunk
        if let Some(usage) = v.get("usage") {
            if let Some(pt) = usage.get("prompt_tokens").and_then(|t| t.as_u64()) {
                input_tokens = pt;
            }
            if let Some(ct) = usage.get("completion_tokens").and_then(|t| t.as_u64()) {
                output_tokens = ct;
            }
            if let Some(cached) = usage
                .get("prompt_tokens_details")
                .and_then(|d| d.get("cached_tokens"))
                .and_then(|t| t.as_u64())
            {
                cache_read_tokens = cached;
            }
        }
    }

    if !parsed_any {
        return Err(anyhow!("No valid SSE events found in input"));
    }

    // Convert tool calls map to sorted vec
    let mut indices: Vec<u64> = tool_calls_map.keys().copied().collect();
    indices.sort();
    let tool_calls: Vec<ToolCall> = indices
        .into_iter()
        .filter_map(|idx| {
            tool_calls_map.remove(&idx).map(|tc| ToolCall {
                id: tc.id,
                name: tc.name,
                input: tc.arguments,
            })
        })
        .collect();

    let parse_errors = if parse_errors_list.is_empty() {
        None
    } else {
        Some(parse_errors_list)
    };

    Ok(OpenAiParsedResponse {
        response_text,
        tool_calls,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens: 0,
        model,
        message_id,
        raw_extra: None,
        parser_version: Some("0.1.0".to_string()),
        parse_errors,
    })
}

/// Extract OpenAI/Codex identity metadata from WebSocket upgrade request headers.
///
/// Parses the raw HTTP headers (as a string) and extracts:
/// - `chatgpt-account-id` -> `account_uuid`
/// - `session_id` -> `session_id`
/// - `originator` -> `framework`
/// - `version` -> `agent_version`
/// - `device_id` -> always `None` (Codex CLI does not send a machine identifier)
///
/// Returns `OpenAiMetadata` with `None` fields for any header not found.
pub fn extract_openai_metadata(headers: &str) -> OpenAiMetadata {
    let mut metadata = OpenAiMetadata::default();

    for line in headers.lines() {
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once(':') {
            let key_lower = key.trim().to_ascii_lowercase();
            let value_trimmed = value.trim().to_string();

            match key_lower.as_str() {
                "chatgpt-account-id" => {
                    metadata.account_uuid = Some(value_trimmed);
                }
                "session_id" => {
                    metadata.session_id = Some(value_trimmed);
                }
                "originator" => {
                    metadata.framework = Some(value_trimmed);
                }
                // R1-11: The `version` header is used by Codex CLI to report
                // its build version (e.g., "0.116.0"). While the header name
                // is generic, it is the only version header Codex sends, and
                // no other standard HTTP header uses this exact name. If a
                // more specific header like `x-codex-version` is introduced,
                // this match should be updated to prefer it.
                "version" => {
                    metadata.agent_version = Some(value_trimmed);
                }
                _ => {}
            }
        }
    }

    metadata
}
