use serde::{Deserialize, Serialize};

/// Maximum total raw bytes to accumulate before stopping event parsing.
/// Beyond this limit, `feed()` continues tracking raw byte length and
/// completion status but stops parsing new events to prevent memory exhaustion.
const MAX_STREAM_BYTES: usize = 100 * 1024 * 1024; // 100 MB

/// A single parsed SSE event with its event type and data payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseEvent {
    pub event_type: String,
    pub data: String,
}

/// Result of accumulating an SSE stream.
#[derive(Debug, Clone)]
pub struct AccumulatedStream {
    /// All SSE events parsed from the stream.
    ///
    /// **Warning:** Event text may contain U+FFFD replacement characters if the
    /// raw SSE bytes contained invalid UTF-8 sequences, because
    /// `SseAccumulator::feed` uses `String::from_utf8_lossy` for conversion.
    /// If byte-level fidelity is required, use `raw_bytes` — it preserves the
    /// original bytes without any lossy conversion.
    pub events: Vec<SseEvent>,
    /// All raw SSE data concatenated. This is the authoritative byte-level
    /// representation — it is never subject to lossy UTF-8 conversion.
    pub raw_bytes: Vec<u8>,
    /// Whether the stream completed normally (received `message_stop`).
    pub complete: bool,
    /// Whether the stream was truncated because it exceeded `MAX_STREAM_BYTES`.
    /// When `true`, `events` and `raw_bytes` are incomplete — the accumulator
    /// stopped accepting data at the size limit. Callers can use this to
    /// distinguish "stream ended before message_stop" from "stream was too large
    /// and we stopped collecting".
    pub truncated: bool,
}

/// SSE stream accumulator. Feed it raw SSE bytes and it parses/accumulates events.
pub struct SseAccumulator {
    /// All raw bytes fed so far.
    raw_bytes: Vec<u8>,
    /// Parsed events so far.
    events: Vec<SseEvent>,
    /// Whether we've seen a `message_stop` event.
    complete: bool,
    /// Whether the stream was truncated because it exceeded `MAX_STREAM_BYTES`.
    truncated: bool,
    /// Buffer for incomplete lines (when a chunk ends mid-line).
    line_buffer: String,
    /// Current event type being built.
    current_event_type: Option<String>,
    /// Current data being built.
    current_data: Option<String>,
}

impl Default for SseAccumulator {
    fn default() -> Self {
        Self::new()
    }
}

impl SseAccumulator {
    /// Create a new empty accumulator.
    pub fn new() -> Self {
        SseAccumulator {
            raw_bytes: Vec::new(),
            events: Vec::new(),
            complete: false,
            truncated: false,
            line_buffer: String::new(),
            current_event_type: None,
            current_data: None,
        }
    }

    /// Feed raw SSE bytes (potentially partial) into the accumulator.
    ///
    /// Uses `String::from_utf8_lossy` to convert chunks to text for event parsing.
    /// The original bytes are preserved in `raw_bytes`; only the parsed event text
    /// may contain replacement characters for invalid UTF-8 sequences.
    pub fn feed(&mut self, chunk: &[u8]) {
        // Stop accumulating bytes and events past the limit to prevent
        // memory exhaustion. Accounts for both raw_bytes and line_buffer.
        let total = self
            .raw_bytes
            .len()
            .saturating_add(self.line_buffer.len())
            .saturating_add(chunk.len());
        if total > MAX_STREAM_BYTES {
            self.truncated = true;
            return;
        }
        self.raw_bytes.extend_from_slice(chunk);

        // Convert chunk to string and append to line buffer
        let chunk_str = String::from_utf8_lossy(chunk);
        self.line_buffer.push_str(&chunk_str);

        // Process complete lines. drain() avoids copying the tail on each
        // extraction (the line itself still allocates, which is necessary).
        while let Some(newline_pos) = self.line_buffer.find('\n') {
            let line: String = self.line_buffer.drain(..newline_pos).collect();
            self.line_buffer.drain(..1); // consume the '\n'

            let line = line.trim_end_matches('\r');
            self.process_line(line);
        }
    }

    fn process_line(&mut self, line: &str) {
        if line.is_empty() {
            // Blank line: emit the current event if we have both type and data
            if let (Some(event_type), Some(data)) =
                (self.current_event_type.take(), self.current_data.take())
            {
                if event_type == "message_stop" {
                    self.complete = true;
                }
                self.events.push(SseEvent { event_type, data });
            }
            // Reset for next event regardless
            self.current_event_type = None;
            self.current_data = None;
        } else if let Some(rest) = line.strip_prefix("event: ") {
            self.current_event_type = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("event:") {
            self.current_event_type = Some(rest.trim_start().to_string());
        } else if let Some(rest) = line.strip_prefix("data: ") {
            // Per SSE spec, multiple data: lines are concatenated with newlines.
            match &mut self.current_data {
                Some(existing) => {
                    existing.push('\n');
                    existing.push_str(rest);
                }
                None => {
                    self.current_data = Some(rest.to_string());
                }
            }
        } else if let Some(rest) = line.strip_prefix("data:") {
            let rest = rest.trim_start();
            match &mut self.current_data {
                Some(existing) => {
                    existing.push('\n');
                    existing.push_str(rest);
                }
                None => {
                    self.current_data = Some(rest.to_string());
                }
            }
        }
        // Other lines (comments starting with :, or malformed) are ignored
    }

    /// Finalize and return the accumulated stream result.
    pub fn finish(mut self) -> AccumulatedStream {
        // Process any remaining partial event (in case the stream didn't end with \n\n)
        // But only if we have a pending event with both type and data
        if let (Some(event_type), Some(data)) =
            (self.current_event_type.take(), self.current_data.take())
        {
            if event_type == "message_stop" {
                self.complete = true;
            }
            self.events.push(SseEvent { event_type, data });
        }

        AccumulatedStream {
            events: self.events,
            raw_bytes: self.raw_bytes,
            complete: self.complete,
            truncated: self.truncated,
        }
    }
}

/// Strip HTTP response/request headers from raw captured bytes.
///
/// First scans for the standard `\r\n\r\n` boundary between headers and body.
/// If not found AND the data looks like an HTTP message (starts with `HTTP/`
/// or an HTTP method), falls back to scanning for `\n\n` (bare LF), which
/// some HTTP implementations emit.
/// Returns everything after the boundary (the body).
/// If neither boundary is found, returns the original bytes unchanged (already pure body).
pub fn strip_http_headers(raw: &[u8]) -> &[u8] {
    // Pass 1: Search for the standard \r\n\r\n boundary (CRLF pairs).
    if raw.len() >= 4 {
        for i in 0..raw.len() - 3 {
            if raw[i] == b'\r' && raw[i + 1] == b'\n' && raw[i + 2] == b'\r' && raw[i + 3] == b'\n'
            {
                return &raw[i + 4..];
            }
        }
    }

    // Pass 2: Fall back to bare \n\n boundary, but ONLY if the data looks like
    // an HTTP message. Without this guard, pure SSE data (which uses \n\n as
    // event delimiters) would be incorrectly split at the first blank line.
    if looks_like_http(raw) && raw.len() >= 2 {
        for i in 0..raw.len() - 1 {
            if raw[i] == b'\n' && raw[i + 1] == b'\n' {
                return &raw[i + 2..];
            }
        }
    }

    // No boundary found — the bytes are already pure body (SSE or JSON).
    raw
}

/// Heuristic: does the raw data look like it starts with HTTP headers?
///
/// Returns true if the data starts with an HTTP response status line (`HTTP/`)
/// or an HTTP request method (`GET`, `POST`, `PUT`, `DELETE`, `PATCH`,
/// `HEAD`, `OPTIONS`, `CONNECT`).
fn looks_like_http(raw: &[u8]) -> bool {
    raw.starts_with(b"HTTP/")
        || raw.starts_with(b"GET ")
        || raw.starts_with(b"POST ")
        || raw.starts_with(b"PUT ")
        || raw.starts_with(b"DELETE ")
        || raw.starts_with(b"PATCH ")
        || raw.starts_with(b"HEAD ")
        || raw.starts_with(b"OPTIONS ")
        || raw.starts_with(b"CONNECT ")
}

/// Extract HTTP headers as a string from raw captured bytes.
///
/// Returns the header portion (before `\r\n\r\n` or `\n\n`) as a UTF-8 string.
/// Returns `None` if no header boundary is found or headers are not valid UTF-8.
pub fn extract_headers(raw: &[u8]) -> Option<String> {
    // Check for \r\n\r\n boundary first.
    if raw.len() >= 4 {
        for i in 0..raw.len() - 3 {
            if raw[i] == b'\r' && raw[i + 1] == b'\n' && raw[i + 2] == b'\r' && raw[i + 3] == b'\n'
            {
                return std::str::from_utf8(&raw[..i]).ok().map(|s| s.to_string());
            }
        }
    }
    // Check for bare \n\n boundary (only if data looks like HTTP).
    if looks_like_http(raw) && raw.len() >= 2 {
        for i in 0..raw.len() - 1 {
            if raw[i] == b'\n' && raw[i + 1] == b'\n' {
                return std::str::from_utf8(&raw[..i]).ok().map(|s| s.to_string());
            }
        }
    }
    None
}

/// Extract the `Content-Type` media type from HTTP headers, lower-cased and
/// stripped of parameters (e.g. `text/event-stream; charset=utf-8` → `text/event-stream`).
/// Returns `None` if the header is not present.
pub fn extract_content_type(headers: &str) -> Option<String> {
    for line in headers.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("content-type") {
                let media = value.split(';').next().unwrap_or("").trim().to_lowercase();
                if media.is_empty() {
                    return None;
                }
                return Some(media);
            }
        }
    }
    None
}

/// Check whether HTTP headers indicate chunked transfer encoding.
///
/// Performs a case-insensitive search for `Transfer-Encoding: chunked`.
/// Handles multi-value TE headers where "chunked" may appear alongside other
/// encodings (e.g., `gzip, chunked`).
pub fn is_chunked_transfer_encoding(headers: &str) -> bool {
    for line in headers.lines() {
        let line = line.trim();
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("transfer-encoding")
                && value
                    .split(',')
                    .any(|t| t.trim().eq_ignore_ascii_case("chunked"))
            {
                return true;
            }
        }
    }
    false
}

/// Decode chunked transfer encoding from raw bytes.
///
/// Parses hex chunk-size lines and concatenates chunk data, stripping the
/// chunked framing. Returns `Err` if the first line is not a valid hex chunk size.
pub fn decode_chunked(raw: &[u8]) -> Result<Vec<u8>, &'static str> {
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
            Err(_) => return Err("Invalid UTF-8 in chunk size line"),
        };

        // Strip chunk extensions (everything after ';')
        let size_hex = size_str.split(';').next().unwrap_or("").trim();
        let chunk_size = match usize::from_str_radix(size_hex, 16) {
            Ok(s) => s,
            Err(_) => return Err("Invalid hex chunk size"),
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

    Ok(result)
}

/// Prepare raw captured response bytes for SSE/JSON parsing.
///
/// This is the single entry point for response body preparation. It performs:
/// 1. Extract HTTP headers (to detect Transfer-Encoding and Content-Encoding).
/// 2. Strip HTTP headers from the raw bytes.
/// 3. Decode chunked transfer encoding if present.
/// 4. Decompress gzip content encoding if present.
///
/// Returns owned bytes ready for `parse_sse_stream` or JSON parsing.
pub fn prepare_response_body(raw: &[u8]) -> Vec<u8> {
    let headers = extract_headers(raw);
    let body = strip_http_headers(raw);
    let is_chunked = headers
        .as_deref()
        .map(is_chunked_transfer_encoding)
        .unwrap_or(false);
    let is_gzip = headers
        .as_deref()
        .map(is_gzip_content_encoding)
        .unwrap_or(false);

    let mut result = if is_chunked {
        decode_chunked(body).unwrap_or_else(|_| body.to_vec())
    } else {
        body.to_vec()
    };

    // Decompress gzip if Content-Encoding: gzip (server-side compression).
    // This is separate from the gzip in the object store (which we apply ourselves).
    // Cloudflare/CDNs often gzip SSE streams in transit.
    if is_gzip {
        if let Some(decompressed) = decompress_gzip(&result) {
            result = decompressed;
        }
    }

    result
}

/// Check if HTTP headers indicate Content-Encoding: gzip.
fn is_gzip_content_encoding(headers: &str) -> bool {
    headers.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("content-encoding:") && lower.contains("gzip")
    })
}

/// Decompress gzip data. Returns None if decompression fails.
fn decompress_gzip(compressed: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut decoder = GzDecoder::new(compressed);
    let mut decompressed = Vec::new();
    match decoder.read_to_end(&mut decompressed) {
        Ok(_) => Some(decompressed),
        Err(_) => None,
    }
}

/// Convenience: parse a complete SSE byte stream in one shot.
pub fn parse_sse_stream(raw: &[u8]) -> AccumulatedStream {
    let mut acc = SseAccumulator::new();
    acc.feed(raw);
    acc.finish()
}
