//! Live-trace pretty-printer for the `--trace` CLI flag: HTTP request/response
//! decoding, chunked transfer-encoding decode, gzip decompress, and SSE event
//! pretty-printing. Split out of `gateway/mod.rs` per the Batch 6 H2 audit
//! follow-up.

use super::trace_enabled;

// ---------------------------------------------------------------------------
// Live trace output (--trace flag)
// ---------------------------------------------------------------------------

/// Print a live trace of the request to stderr.
pub(super) fn trace_request(request_bytes: &[u8], provider: &str) {
    if !trace_enabled() {
        return;
    }

    let now = time::OffsetDateTime::now_utc();
    let ts = format!("{:02}:{:02}:{:02}", now.hour(), now.minute(), now.second());

    // Parse the HTTP body from the request
    let text = match std::str::from_utf8(request_bytes) {
        Ok(t) => t,
        Err(_) => return,
    };

    let body_start = match text.find("\r\n\r\n") {
        Some(pos) => pos + 4,
        None => return,
    };

    let body = &text[body_start..];
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return,
    };

    let model = json["model"].as_str().unwrap_or("unknown");
    let messages = json["messages"].as_array();
    let stream = json["stream"].as_bool().unwrap_or(false);

    eprintln!(
        "\n\x1b[36m[{ts}]\x1b[0m \x1b[1;33m→ POST /v1/messages\x1b[0m ({provider}, {model}{})",
        if stream { ", streaming" } else { "" }
    );

    // Show the last user message (the prompt)
    if let Some(msgs) = messages {
        for msg in msgs.iter().rev() {
            if msg["role"].as_str() == Some("user") {
                let content = if let Some(s) = msg["content"].as_str() {
                    truncate_for_trace(s, 200)
                } else if let Some(arr) = msg["content"].as_array() {
                    // Content array — find first text block
                    arr.iter()
                        .find_map(|b| {
                            if b["type"].as_str() == Some("text") {
                                b["text"].as_str().map(|s| truncate_for_trace(s, 200))
                            } else {
                                None
                            }
                        })
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                if !content.is_empty() {
                    eprintln!("  \x1b[2muser:\x1b[0m {content}");
                }
                break;
            }
        }
    }
}

/// Print a live trace of the response to stderr.
pub(super) fn trace_response(response_bytes: &[u8]) {
    if !trace_enabled() {
        return;
    }

    let now = time::OffsetDateTime::now_utc();
    let ts = format!("{:02}:{:02}:{:02}", now.hour(), now.minute(), now.second());

    // Find header/body boundary (headers are always ASCII/UTF-8)
    let header_end = match response_bytes.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(pos) => pos + 4,
        None => return,
    };

    let headers_str = match std::str::from_utf8(&response_bytes[..header_end]) {
        Ok(s) => s,
        Err(_) => return,
    };

    let status_line = headers_str.lines().next().unwrap_or("");
    let raw_body = &response_bytes[header_end..];

    // Detect encodings from headers
    let headers_lower = headers_str.to_ascii_lowercase();
    let is_gzip = headers_lower
        .lines()
        .any(|l| l.starts_with("content-encoding:") && l.contains("gzip"));
    let is_chunked_te =
        headers_lower.contains("transfer-encoding:") && headers_lower.contains("chunked");

    // Step 1: decode chunked TE to get raw body bytes
    let unchunked = if is_chunked_te {
        decode_chunked_bytes(raw_body)
    } else {
        raw_body.to_vec()
    };

    // Step 2: decompress if gzipped
    let body_bytes = if is_gzip {
        match decompress_gzip(&unchunked) {
            Some(d) => d,
            None => {
                eprintln!(
                    "\x1b[36m[{ts}]\x1b[0m \x1b[1;32m← {status_line}\x1b[0m (gzip, {} bytes compressed)",
                    unchunked.len()
                );
                return;
            }
        }
    } else {
        unchunked
    };

    let body = match std::str::from_utf8(&body_bytes) {
        Ok(s) => s,
        Err(_) => return,
    };

    // Try to parse as JSON (non-streaming response)
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(err) = json.get("error") {
            let err_type = err["type"].as_str().unwrap_or("unknown");
            let err_msg = err["message"].as_str().unwrap_or("");
            eprintln!("\x1b[36m[{ts}]\x1b[0m \x1b[1;31m← {status_line}\x1b[0m");
            eprintln!("  \x1b[31merror:\x1b[0m [{err_type}] {err_msg}");
            return;
        }

        let response_text = json["content"]
            .as_array()
            .and_then(|arr| {
                arr.iter().find_map(|b| {
                    if b["type"].as_str() == Some("text") {
                        b["text"].as_str()
                    } else {
                        None
                    }
                })
            })
            .unwrap_or("");

        let input_tokens = json["usage"]["input_tokens"].as_u64().unwrap_or(0);
        let output_tokens = json["usage"]["output_tokens"].as_u64().unwrap_or(0);
        let stop = json["stop_reason"].as_str().unwrap_or("");

        eprintln!("\x1b[36m[{ts}]\x1b[0m \x1b[1;32m← {status_line}\x1b[0m");
        if !response_text.is_empty() {
            eprintln!(
                "  \x1b[2mtext:\x1b[0m {}",
                truncate_for_trace(response_text, 300)
            );
        }
        eprintln!("  \x1b[2mtokens:\x1b[0m {input_tokens} in / {output_tokens} out | stop: {stop}");
        return;
    }

    // Try to parse as SSE events (streaming response)
    let mut response_text = String::new();
    let mut thinking_text = String::new();
    let mut tool_names: Vec<String> = Vec::new();
    let mut input_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut stop_reason = String::new();
    let mut model = String::new();

    for line in body.lines() {
        if !line.starts_with("data: ") {
            continue;
        }
        let data = &line[6..];
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
            match v["type"].as_str().unwrap_or("") {
                "message_start" => {
                    model = v["message"]["model"].as_str().unwrap_or("").to_string();
                    input_tokens = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
                }
                "content_block_delta" => {
                    let delta = &v["delta"];
                    match delta["type"].as_str().unwrap_or("") {
                        "text_delta" => {
                            if let Some(t) = delta["text"].as_str() {
                                response_text.push_str(t);
                            }
                        }
                        "thinking_delta" => {
                            if let Some(t) = delta["thinking"].as_str() {
                                thinking_text.push_str(t);
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_start"
                    if v["content_block"]["type"].as_str() == Some("tool_use") =>
                {
                    if let Some(name) = v["content_block"]["name"].as_str() {
                        tool_names.push(name.to_string());
                    }
                }
                "message_delta" => {
                    if let Some(sr) = v["delta"]["stop_reason"].as_str() {
                        stop_reason = sr.to_string();
                    }
                    if let Some(ot) = v["usage"]["output_tokens"].as_u64() {
                        output_tokens = ot;
                    }
                }
                _ => {}
            }
        }
    }

    if !model.is_empty() || !response_text.is_empty() || !thinking_text.is_empty() {
        eprintln!("\x1b[36m[{ts}]\x1b[0m \x1b[1;32m← {status_line}\x1b[0m ({model})");
    }
    if !thinking_text.is_empty() {
        eprintln!(
            "  \x1b[2;35m[thinking]\x1b[0m {}",
            truncate_for_trace(&thinking_text, 200)
        );
    }
    if !response_text.is_empty() {
        eprintln!(
            "  \x1b[2mtext:\x1b[0m {}",
            truncate_for_trace(&response_text, 300)
        );
    }
    for name in &tool_names {
        eprintln!("  \x1b[2;34m[tool]\x1b[0m {name}");
    }
    if input_tokens > 0 || output_tokens > 0 {
        eprintln!(
            "  \x1b[2mtokens:\x1b[0m {input_tokens} in / {output_tokens} out | stop: {stop_reason}"
        );
    }
}

/// Decode a chunked HTTP body into a plain string.
/// Strips chunk-size lines and concatenates chunk data.
pub(super) fn decode_chunked_body(raw: &str) -> String {
    let mut result = String::new();
    for line in raw.lines() {
        // Try to parse as hex chunk size
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if u64::from_str_radix(trimmed, 16).is_ok() {
            // This is a chunk size line — skip it, next lines are data
            continue;
        }
        // This is data
        result.push_str(line);
        result.push('\n');
    }
    result
}

/// Decode chunked transfer encoding from raw bytes.
/// Parses hex chunk-size lines and concatenates chunk data.
pub(super) fn decode_chunked_bytes(raw: &[u8]) -> Vec<u8> {
    let mut result = Vec::new();
    let mut pos = 0;

    while pos < raw.len() {
        // Find the end of the chunk-size line
        let line_end = match raw[pos..].windows(2).position(|w| w == b"\r\n") {
            Some(p) => pos + p,
            None => break,
        };

        // Parse the hex chunk size
        let size_str = match std::str::from_utf8(&raw[pos..line_end]) {
            Ok(s) => s.trim(),
            Err(_) => break,
        };

        // Strip chunk extensions (everything after ';')
        let size_hex = size_str.split(';').next().unwrap_or("").trim();
        let chunk_size = match usize::from_str_radix(size_hex, 16) {
            Ok(s) => s,
            Err(_) => break,
        };

        if chunk_size == 0 {
            break; // Terminal chunk
        }

        // Data starts after the CRLF
        let data_start = line_end + 2;
        let data_end = data_start + chunk_size;

        if data_end > raw.len() {
            // Partial chunk — take what we have
            result.extend_from_slice(&raw[data_start..]);
            break;
        }

        result.extend_from_slice(&raw[data_start..data_end]);

        // Skip past the chunk data and its trailing CRLF
        pos = data_end + 2;
    }

    result
}

/// Decompress gzip-encoded bytes. Returns None if decompression fails.
pub(super) fn decompress_gzip(compressed: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::GzDecoder;
    use std::io::Read;

    let mut decoder = GzDecoder::new(compressed);
    let mut decompressed = Vec::new();
    match decoder.read_to_end(&mut decompressed) {
        Ok(_) => Some(decompressed),
        Err(_) => None,
    }
}

/// Decompress gzip data, tolerating incomplete streams.
/// Unlike `decompress_gzip`, this returns whatever was successfully
/// decompressed even if the gzip stream is truncated (missing trailer).
/// This enables live tracing of SSE events as compressed chunks arrive.
pub(super) fn decompress_gzip_partial(compressed: &[u8]) -> Vec<u8> {
    use flate2::read::GzDecoder;
    use std::io::Read;

    let mut decoder = GzDecoder::new(compressed);
    let mut decompressed = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match decoder.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => decompressed.extend_from_slice(&buf[..n]),
            Err(_) => break, // incomplete gzip — return what we have
        }
    }
    decompressed
}

/// Print SSE events from a raw chunk as they stream through.
/// Called on each chunk from the upstream during streaming responses.
/// The chunk is in HTTP chunked transfer encoding, so we strip chunk-size lines first.
pub(super) fn trace_sse_chunk(chunk: &[u8]) {
    let text = match std::str::from_utf8(chunk) {
        Ok(t) => t,
        Err(_) => return,
    };

    // Decode chunked TE: skip hex chunk-size lines, collect data lines
    let decoded = decode_chunked_body(text);

    for line in decoded.lines() {
        let line = line.trim();
        if !line.starts_with("data: ") {
            continue;
        }
        let data = &line[6..];
        let v: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => continue,
        };

        match v["type"].as_str().unwrap_or("") {
            "message_start" => {
                let model = v["message"]["model"].as_str().unwrap_or("");
                let input = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
                eprintln!("  \x1b[2mmodel:\x1b[0m {model} | \x1b[2minput:\x1b[0m {input} tokens");
            }
            "content_block_start" => {
                let block_type = v["content_block"]["type"].as_str().unwrap_or("");
                match block_type {
                    "thinking" => {
                        eprint!("  \x1b[35m[thinking]\x1b[0m ");
                    }
                    "text" => {
                        eprint!("  \x1b[2mtext:\x1b[0m ");
                    }
                    "tool_use" => {
                        let name = v["content_block"]["name"].as_str().unwrap_or("?");
                        eprintln!("  \x1b[34m[tool]\x1b[0m {name}");
                    }
                    _ => {}
                }
            }
            "content_block_delta" => {
                let delta = &v["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        if let Some(t) = delta["text"].as_str() {
                            eprint!("{t}");
                        }
                    }
                    "thinking_delta" => {
                        if let Some(t) = delta["thinking"].as_str() {
                            // Only print first 100 chars of thinking to avoid flooding
                            let truncated: String = t.chars().take(80).collect();
                            eprint!("{truncated}");
                        }
                    }
                    "input_json_delta" => {
                        // Tool input streaming — skip for trace
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                eprintln!(); // newline after the content block
            }
            "message_delta" => {
                let stop = v["delta"]["stop_reason"].as_str().unwrap_or("");
                let output = v["usage"]["output_tokens"].as_u64().unwrap_or(0);
                eprintln!("  \x1b[2mtokens:\x1b[0m {output} out | \x1b[2mstop:\x1b[0m {stop}");
            }
            _ => {}
        }
    }
}

/// Print a single SSE data line to the trace output.
pub(super) fn trace_sse_line(line: &str) {
    if !line.starts_with("data: ") {
        return;
    }
    let data = &line[6..];
    let v: serde_json::Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => return,
    };

    match v["type"].as_str().unwrap_or("") {
        "message_start" => {
            let model = v["message"]["model"].as_str().unwrap_or("");
            let input = v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
            eprintln!("  \x1b[2mmodel:\x1b[0m {model} | \x1b[2minput:\x1b[0m {input} tokens");
        }
        "content_block_start" => {
            let block_type = v["content_block"]["type"].as_str().unwrap_or("");
            match block_type {
                "thinking" => eprint!("  \x1b[35m[thinking]\x1b[0m "),
                "text" => eprint!("  \x1b[2mtext:\x1b[0m "),
                "tool_use" => {
                    let name = v["content_block"]["name"].as_str().unwrap_or("?");
                    eprintln!("  \x1b[34m[tool]\x1b[0m {name}");
                }
                _ => {}
            }
        }
        "content_block_delta" => {
            let delta = &v["delta"];
            match delta["type"].as_str().unwrap_or("") {
                "text_delta" => {
                    if let Some(t) = delta["text"].as_str() {
                        eprint!("{t}");
                    }
                }
                "thinking_delta" => {
                    if let Some(t) = delta["thinking"].as_str() {
                        let truncated: String = t.chars().take(80).collect();
                        eprint!("{truncated}");
                    }
                }
                _ => {}
            }
        }
        "content_block_stop" => {
            eprintln!();
        }
        "message_delta" => {
            let stop = v["delta"]["stop_reason"].as_str().unwrap_or("");
            let output = v["usage"]["output_tokens"].as_u64().unwrap_or(0);
            eprintln!("  \x1b[2mtokens:\x1b[0m {output} out | \x1b[2mstop:\x1b[0m {stop}");
        }
        _ => {}
    }
}

/// Truncate a string for trace display.
pub(super) fn truncate_for_trace(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.replace('\n', " ↵ ")
    } else {
        let truncated: String = s.chars().take(max).collect();
        format!("{}...", truncated.replace('\n', " ↵ "))
    }
}

/// Return a vec containing just the last `role=user` message from `messages`,
/// or the empty vec if none. Used as a fallback when `messages_delta` is
/// unavailable so attachment extraction operates only on newly-added user
/// content rather than re-ingesting the entire conversation history.
pub(super) fn last_user_message_slice(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"))
        .cloned()
        .into_iter()
        .collect()
}
