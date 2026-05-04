//! WebSocket frame parsing and encoding (RFC 6455).
//!
//! Provides low-level WebSocket frame operations needed for the gateway to
//! intercept and relay WebSocket traffic (e.g., OpenAI Codex via chatgpt.com).
//!
//! # Frame format (RFC 6455 Section 5.2)
//!
//! ```text
//!  0                   1                   2                   3
//!  0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//! +-+-+-+-+-------+-+-------------+-------------------------------+
//! |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
//! |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
//! |N|V|V|V|       |S|             |   (if payload len==126/127)   |
//! | |1|2|3|       |K|             |                               |
//! +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - -+
//! |     Extended payload length continued, if payload len == 127  |
//! + - - - - - - - - - - - - - - -+-------------------------------+
//! |                               |Masking-key, if MASK set to 1  |
//! +-------------------------------+-------------------------------+
//! | Masking-key (continued)       |          Payload Data         |
//! +-------------------------------- - - - - - - - - - - - - - - -+
//! :                     Payload Data continued ...                :
//! + - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -+
//! |                     Payload Data (continued)                  |
//! +---------------------------------------------------------------+
//! ```
//!
//! # Known limitations (Phase 1)
//!
//! - **Fragmented message reassembly is not performed.** The frame parser
//!   correctly exposes the `fin` bit and continuation opcode (0x0), but
//!   reassembling fragmented messages into complete application messages is
//!   a higher-level concern deferred to Phase 2. Callers that need full
//!   messages must accumulate continuation frames themselves.

use anyhow::{bail, Result};

/// Maximum WebSocket payload size (64 MB). Frames with payloads exceeding
/// this limit are rejected to prevent out-of-memory conditions. This is
/// intentionally generous — typical WebSocket messages are well under 1 MB.
const MAX_WS_PAYLOAD: usize = 64 * 1024 * 1024;

/// Maximum total size for a reassembled WebSocket message (128 MB).
/// R1-09 fix: The `MessageAssembler` buffer is bounded to prevent
/// memory exhaustion from infinite continuation frame sequences.
/// If the accumulated payload exceeds this limit, the assembler
/// resets its state and discards the in-progress message.
const MAX_MESSAGE_SIZE: usize = 128 * 1024 * 1024;

/// A parsed WebSocket frame.
#[derive(Debug, Clone)]
pub struct WebSocketFrame {
    /// Frame opcode (0x0=continuation, 0x1=text, 0x2=binary,
    /// 0x8=close, 0x9=ping, 0xA=pong).
    pub opcode: u8,
    /// The unmasked payload data.
    pub payload: Vec<u8>,
    /// FIN bit: true if this is the final fragment of a message.
    pub fin: bool,
    /// Whether the frame was masked (client-to-server frames are masked).
    pub masked: bool,
}

/// Parse a single WebSocket frame from raw bytes.
///
/// Handles all length encodings (7-bit, 16-bit extended, 64-bit extended)
/// and automatically unmasks payload if the MASK bit is set.
///
/// Returns `Ok((frame, bytes_consumed))` where `bytes_consumed` is the total
/// number of bytes consumed from the input buffer (header + mask key + payload).
/// This allows callers to advance their read position when parsing multiple
/// frames from a contiguous buffer.
///
/// Returns `Err` if the input is truncated, malformed, exceeds `MAX_WS_PAYLOAD`,
/// or has non-zero RSV bits (no extensions are negotiated).
pub fn parse_frame(bytes: &[u8]) -> Result<(WebSocketFrame, usize)> {
    if bytes.len() < 2 {
        bail!(
            "WebSocket frame too short: need at least 2 bytes, got {}",
            bytes.len()
        );
    }

    let byte0 = bytes[0];
    let byte1 = bytes[1];

    let fin = (byte0 & 0x80) != 0;
    let rsv = byte0 & 0x70; // RSV1, RSV2, RSV3 bits

    // RFC 6455 Section 5.2: RSV bits MUST be 0 unless an extension is negotiated
    // that defines meanings for non-zero values. We do not negotiate any
    // extensions, so non-zero RSV bits indicate a protocol error.
    if rsv != 0 {
        bail!(
            "WebSocket frame has non-zero RSV bits (0x{:02X}); no extensions negotiated",
            rsv
        );
    }

    let opcode = byte0 & 0x0F;
    let masked = (byte1 & 0x80) != 0;
    let length_field = (byte1 & 0x7F) as usize;

    let mut offset: usize = 2;

    // Determine payload length based on the 7-bit length field
    let payload_len: usize = if length_field <= 125 {
        length_field
    } else if length_field == 126 {
        // 16-bit extended length
        if bytes.len() < offset + 2 {
            bail!(
                "WebSocket frame truncated: need 2 bytes for extended 16-bit length at offset {}, got {} total bytes",
                offset,
                bytes.len()
            );
        }
        let len = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]) as usize;
        offset += 2;
        len
    } else {
        // length_field == 127: 64-bit extended length
        if bytes.len() < offset + 8 {
            bail!(
                "WebSocket frame truncated: need 8 bytes for extended 64-bit length at offset {}, got {} total bytes",
                offset,
                bytes.len()
            );
        }
        let raw_len = u64::from_be_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        ]);

        // RFC 6455 Section 5.2: the most significant bit MUST be 0 for the
        // 64-bit extended payload length.
        if raw_len & (1u64 << 63) != 0 {
            bail!(
                "WebSocket 64-bit payload length has MSB set (0x{:016X}); RFC 6455 requires MSB=0",
                raw_len
            );
        }

        let len = raw_len as usize;
        offset += 8;
        len
    };

    // Reject payloads exceeding MAX_WS_PAYLOAD to prevent OOM.
    if payload_len > MAX_WS_PAYLOAD {
        bail!(
            "WebSocket payload length ({} bytes) exceeds maximum ({} bytes)",
            payload_len,
            MAX_WS_PAYLOAD
        );
    }

    // Use checked_add to prevent offset arithmetic overflow.
    let end_of_mask = if masked {
        offset
            .checked_add(4)
            .ok_or_else(|| anyhow::anyhow!("Offset overflow computing mask key position"))?
    } else {
        offset
    };

    // Read mask key if present
    let mask_key = if masked {
        if bytes.len() < end_of_mask {
            bail!(
                "WebSocket frame truncated: need 4 bytes for mask key at offset {}, got {} total bytes",
                offset,
                bytes.len()
            );
        }
        let key = [
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ];
        offset += 4;
        Some(key)
    } else {
        None
    };

    // Compute total bytes consumed using checked arithmetic to prevent overflow.
    let total_consumed = offset
        .checked_add(payload_len)
        .ok_or_else(|| anyhow::anyhow!("Offset overflow computing payload end position"))?;

    // Read payload
    if bytes.len() < total_consumed {
        bail!(
            "WebSocket frame truncated: need {} bytes of payload at offset {}, got {} total bytes",
            payload_len,
            offset,
            bytes.len()
        );
    }

    let mut payload = bytes[offset..total_consumed].to_vec();

    // Unmask if masked
    if let Some(key) = mask_key {
        for (i, byte) in payload.iter_mut().enumerate() {
            *byte ^= key[i % 4];
        }
    }

    Ok((
        WebSocketFrame {
            opcode,
            payload,
            fin,
            masked,
        },
        total_consumed,
    ))
}

/// Encode a WebSocket frame into raw bytes.
///
/// If `masked` is true, a mask key is generated and the payload is XOR-masked
/// (per RFC 6455, client-to-server frames must be masked).
///
/// The `fin` parameter controls the FIN bit. Pass `true` for single-frame
/// messages (the common case). Pass `false` for non-final fragments of a
/// multi-frame message.
pub fn encode_frame(opcode: u8, payload: &[u8], masked: bool) -> Vec<u8> {
    encode_frame_with_fin(opcode, payload, masked, true)
}

/// Encode a WebSocket frame with explicit FIN bit control.
///
/// Same as `encode_frame` but allows setting the FIN bit to `false` for
/// fragmented messages.
pub fn encode_frame_with_fin(opcode: u8, payload: &[u8], masked: bool, fin: bool) -> Vec<u8> {
    let mut frame = Vec::with_capacity(2 + 8 + 4 + payload.len());

    // Byte 0: FIN + opcode (RSV bits always 0 — no extensions)
    let fin_bit: u8 = if fin { 0x80 } else { 0x00 };
    frame.push(fin_bit | (opcode & 0x0F));

    // Byte 1: MASK bit + length
    let mask_bit: u8 = if masked { 0x80 } else { 0x00 };
    let len = payload.len();

    if len <= 125 {
        frame.push(mask_bit | (len as u8));
    } else if len <= 65535 {
        frame.push(mask_bit | 126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(mask_bit | 127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }

    // Mask key + masked payload (if masked)
    if masked {
        let mask_key = generate_mask_key(payload);
        frame.extend_from_slice(&mask_key);

        // XOR-mask the payload
        for (i, &byte) in payload.iter().enumerate() {
            frame.push(byte ^ mask_key[i % 4]);
        }
    } else {
        frame.extend_from_slice(payload);
    }

    frame
}

/// Generate a 4-byte mask key for WebSocket frame masking.
///
/// Uses `getrandom` (pulled in transitively via `uuid`/`ring`) for reasonable
/// unpredictability. Falls back to a timestamp-based approach if `getrandom`
/// is unavailable (should not happen in practice).
///
/// # Security note
///
/// RFC 6455 Section 5.3 requires that mask keys are "unpredictable" to prevent
/// cache poisoning attacks. While a CSPRNG is ideal, the threat model
/// only requires preventing an attacker from predicting the key before the
/// frame is sent. The `getrandom` source provides sufficient unpredictability
/// for this purpose. The gateway itself is a trusted component, so the mask key
/// does not need to resist a local attacker.
fn generate_mask_key(_payload: &[u8]) -> [u8; 4] {
    let mut key = [0u8; 4];
    // getrandom is available transitively via uuid (which uses it for v4 UUIDs).
    // If it fails for some reason, fall back to timestamp-based key.
    if getrandom::fill(&mut key).is_ok() {
        return key;
    }

    // Fallback: timestamp-based (kept for robustness)
    use std::time::SystemTime;
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    key[0] = (ts & 0xFF) as u8;
    key[1] = ((ts >> 8) & 0xFF) as u8;
    key[2] = ((ts >> 16) & 0xFF) as u8;
    key[3] = ((ts >> 24) & 0xFF) as u8;

    key
}

/// Detect whether an HTTP response is a WebSocket upgrade (101 Switching Protocols).
///
/// Only examines up to the `\r\n\r\n` header boundary. Any bytes after the
/// header boundary (which may be binary WebSocket frame data) are ignored.
/// This prevents UTF-8 validation errors on binary frame data.
///
/// Checks for:
/// 1. Status line starts with `HTTP/1.1 101` (or `HTTP/1.0 101`)
/// 2. Contains `Upgrade: websocket` header (case-insensitive)
///
/// Returns `false` for non-101 responses or 101 responses upgrading to
/// something other than WebSocket (e.g., h2c).
pub fn is_websocket_upgrade(response_bytes: &[u8]) -> bool {
    // Only examine bytes up to the header boundary to avoid parsing binary
    // WebSocket frame data as text.
    let header_end = response_bytes
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|pos| pos + 4)
        .unwrap_or(response_bytes.len());

    let header_bytes = &response_bytes[..header_end];

    let text = match std::str::from_utf8(header_bytes) {
        Ok(t) => t,
        Err(_) => return false,
    };

    let lower = text.to_ascii_lowercase();

    // Check for 101 status code
    let has_101 = lower.starts_with("http/1.1 101") || lower.starts_with("http/1.0 101");
    if !has_101 {
        return false;
    }

    // Check for Upgrade: websocket header (case-insensitive)
    for line in lower.lines().skip(1) {
        let trimmed = line.trim();
        if let Some((key, value)) = trimmed.split_once(':') {
            if key.trim() == "upgrade" && value.trim() == "websocket" {
                return true;
            }
        }
    }

    false
}

/// Result of streaming a response from upstream to the client.
///
/// After `stream_to_client_and_accumulate` reads the upstream response, it
/// returns one of these variants to tell the caller what happened.
pub enum StreamResult<S> {
    /// Normal HTTP response completed. Contains `(response_bytes, is_partial)`.
    Complete(Vec<u8>, bool),
    /// A WebSocket upgrade (101 Switching Protocols) was detected. The 101
    /// response headers have been forwarded to the client. The upstream TLS
    /// stream is returned so the caller can enter a bidirectional WebSocket
    /// relay loop.
    WebSocketUpgrade(S, Vec<u8>),
}

/// Reassembles fragmented WebSocket messages from continuation frames (RFC 6455).
///
/// RFC 6455 allows a single logical message to be split across multiple frames:
/// - First frame: data opcode (0x1 text or 0x2 binary) with FIN=0
/// - Middle frames: continuation opcode (0x0) with FIN=0
/// - Final frame: continuation opcode (0x0) with FIN=1
///
/// Control frames (ping 0x9, pong 0xA, close 0x8) may be interleaved between
/// continuation frames — they are NOT accumulated into the data message.
///
/// Single-frame messages (FIN=1 with data opcode) pass through immediately.
///
/// # Usage
///
/// ```ignore
/// let mut assembler = MessageAssembler::new();
/// for frame in frames {
///     if let Some((opcode, payload)) = assembler.push(frame) {
///         // Complete message available
///     }
/// }
/// ```
pub struct MessageAssembler {
    /// The opcode of the first frame in the current fragmented sequence
    /// (0x1 for text, 0x2 for binary). `None` when no fragmented message
    /// is in progress.
    start_opcode: Option<u8>,
    /// Accumulated payload bytes from all fragments so far.
    buffer: Vec<u8>,
}

impl Default for MessageAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl MessageAssembler {
    /// Create a new `MessageAssembler` with no in-progress message.
    pub fn new() -> Self {
        MessageAssembler {
            start_opcode: None,
            buffer: Vec::new(),
        }
    }

    /// Feed a parsed `WebSocketFrame` into the assembler.
    ///
    /// Returns `Some((opcode, payload))` when a complete message is assembled:
    /// - `opcode` is the original data frame opcode (0x1 or 0x2)
    /// - `payload` is the concatenated payload bytes from all fragments
    ///
    /// Returns `None` when:
    /// - The frame is a non-final fragment (still accumulating)
    /// - The frame is an interleaved control frame (ping/pong/close)
    /// - The frame is an orphaned continuation frame (no prior start frame)
    pub fn push(&mut self, frame: WebSocketFrame) -> Option<(u8, Vec<u8>)> {
        // Control frames (opcodes 0x8-0xF) are never fragmented per RFC 6455
        // and must not interfere with an in-progress data message.
        if frame.opcode >= 0x8 {
            // Control frames pass through without affecting reassembly state.
            // The caller can inspect them separately if needed.
            return None;
        }

        match frame.opcode {
            // Data frame: text (0x1) or binary (0x2)
            0x1 | 0x2 => {
                if frame.fin {
                    // Single-frame complete message — pass through immediately
                    return Some((frame.opcode, frame.payload));
                }
                // Start of a fragmented message
                self.start_opcode = Some(frame.opcode);
                self.buffer.clear();
                self.buffer.extend_from_slice(&frame.payload);
                None
            }
            // Continuation frame (0x0)
            0x0 => {
                let Some(opcode) = self.start_opcode else {
                    // Orphaned continuation frame — no prior start frame.
                    // Per RFC 6455, this is a protocol error. We silently
                    // discard it to prevent garbage output.
                    return None;
                };

                // R1-09 fix: Bound check — prevent unbounded buffer growth
                // from infinite continuation frame sequences.
                if self.buffer.len() + frame.payload.len() > MAX_MESSAGE_SIZE {
                    // Message exceeds size limit; discard and reset state.
                    self.start_opcode = None;
                    self.buffer.clear();
                    return None;
                }

                self.buffer.extend_from_slice(&frame.payload);

                if frame.fin {
                    // Final continuation frame — emit the complete message
                    self.start_opcode = None;
                    let payload = std::mem::take(&mut self.buffer);
                    Some((opcode, payload))
                } else {
                    // Non-final continuation — keep accumulating
                    None
                }
            }
            // Unknown opcode — ignore
            _ => None,
        }
    }
}
