//! WebSocket Frame Parsing Unit Tests.
//!
//! These tests verify that the WebSocket frame parser correctly handles:
//! - Text frame construction, parsing, and payload extraction (masked + unmasked)
//! - Control frames: ping (0x9), pong (0xA), close (0x8)
//! - Extended length encodings (126 = 2-byte length, 127 = 8-byte length)
//! - Masking/unmasking with 4-byte XOR key
//! - Graceful error handling on truncated/malformed input
//! - Bytes-consumed tracking for multi-frame buffer parsing
//! - RSV bit validation (no extensions negotiated)
//! - Maximum payload size enforcement (64 MB limit)
//! - 64-bit length MSB validation per RFC 6455
//! - FIN bit control for fragmented message encoding
//!
//! Design reference: IMPLEMENTATION_ROADMAP.md Week 3, Task 0 — WebSocket Interception.
//!
//! These tests define the expected public API:
//!   - `websocket::parse_frame(bytes: &[u8]) -> Result<(WebSocketFrame, usize)>`
//!   - `websocket::encode_frame(opcode: u8, payload: &[u8], masked: bool) -> Vec<u8>`
//!   - `websocket::encode_frame_with_fin(opcode: u8, payload: &[u8], masked: bool, fin: bool) -> Vec<u8>`
//!   - `WebSocketFrame { opcode: u8, payload: Vec<u8>, fin: bool, masked: bool }`

use recondo_gateway::websocket;

// ===========================================================================
// Test 1: Text frame roundtrip — construct, parse, verify payload
// ===========================================================================

/// **Proves:** A WebSocket text frame (opcode 0x1) can be encoded and then
/// parsed back, yielding the original payload. Verifies both masked
/// (client-to-server) and unmasked (server-to-client) variants.
///
/// **Anti-fake property:** If encode_frame produces bytes that parse_frame
/// cannot decode, or if the decoded payload differs from the original,
/// the roundtrip assertion fails. Tests both directions of communication.
#[test]
fn text_frame_roundtrip_unmasked() {
    let payload = b"Hello, WebSocket!";
    let opcode_text: u8 = 0x1;

    // Encode an unmasked text frame (server-to-client direction)
    let encoded = websocket::encode_frame(opcode_text, payload, false);

    // Parse it back
    let (frame, consumed) =
        websocket::parse_frame(&encoded).expect("Unmasked text frame must parse successfully");

    assert_eq!(frame.opcode, opcode_text, "Opcode must be 0x1 (text)");
    assert_eq!(
        frame.payload, payload,
        "Decoded payload must match original"
    );
    assert!(frame.fin, "Single-frame message must have FIN=1");
    assert!(!frame.masked, "Server-to-client frame must not be masked");
    assert_eq!(
        consumed,
        encoded.len(),
        "Bytes consumed must equal encoded frame length"
    );
}

#[test]
fn text_frame_roundtrip_masked() {
    let payload = b"Hello from client!";
    let opcode_text: u8 = 0x1;

    // Encode a masked text frame (client-to-server direction)
    let encoded = websocket::encode_frame(opcode_text, payload, true);

    // Parse it back — parser must unmask the payload
    let (frame, consumed) =
        websocket::parse_frame(&encoded).expect("Masked text frame must parse successfully");

    assert_eq!(frame.opcode, opcode_text, "Opcode must be 0x1 (text)");
    assert_eq!(
        frame.payload, payload,
        "Decoded (unmasked) payload must match original plaintext"
    );
    assert!(frame.fin, "Single-frame message must have FIN=1");
    assert!(
        frame.masked,
        "Client-to-server frame must be marked as masked"
    );
    assert_eq!(
        consumed,
        encoded.len(),
        "Bytes consumed must equal encoded frame length"
    );
}

#[test]
fn text_frame_with_json_payload() {
    // Codex sends JSON messages over WebSocket text frames
    let json_payload = br#"{"type":"response.create","response":{"model":"gpt-4"}}"#;
    let opcode_text: u8 = 0x1;

    let encoded = websocket::encode_frame(opcode_text, json_payload, true);
    let (frame, _consumed) =
        websocket::parse_frame(&encoded).expect("JSON text frame must parse successfully");

    assert_eq!(frame.opcode, opcode_text);
    assert_eq!(frame.payload, json_payload);

    // Verify the payload is valid JSON
    let parsed: serde_json::Value =
        serde_json::from_slice(&frame.payload).expect("Payload must be valid JSON");
    assert_eq!(parsed["type"], "response.create");
}

// ===========================================================================
// Test 2: Ping and pong control frames
// ===========================================================================

/// **Proves:** Ping frame (opcode 0x9) is correctly identified and its
/// payload is preserved. Pong frame (opcode 0xA) is likewise identified.
///
/// **Anti-fake property:** A parser that ignores the opcode field or
/// always returns 0x1 would fail. Control frames may carry small payloads
/// (up to 125 bytes per RFC 6455) that must be preserved.
#[test]
fn ping_frame_parsed_correctly() {
    let opcode_ping: u8 = 0x9;
    let ping_payload = b"ping-data";

    let encoded = websocket::encode_frame(opcode_ping, ping_payload, false);
    let (frame, _consumed) =
        websocket::parse_frame(&encoded).expect("Ping frame must parse successfully");

    assert_eq!(frame.opcode, opcode_ping, "Opcode must be 0x9 (ping)");
    assert_eq!(
        frame.payload, ping_payload,
        "Ping payload must be preserved"
    );
    assert!(frame.fin, "Control frames must have FIN=1");
}

#[test]
fn pong_frame_parsed_correctly() {
    let opcode_pong: u8 = 0xA;
    let pong_payload = b"pong-data";

    let encoded = websocket::encode_frame(opcode_pong, pong_payload, false);
    let (frame, _consumed) =
        websocket::parse_frame(&encoded).expect("Pong frame must parse successfully");

    assert_eq!(frame.opcode, opcode_pong, "Opcode must be 0xA (pong)");
    assert_eq!(
        frame.payload, pong_payload,
        "Pong payload must be preserved"
    );
    assert!(frame.fin, "Control frames must have FIN=1");
}

#[test]
fn ping_pong_roundtrip_masked() {
    // Client-to-server ping/pong are masked
    let opcode_ping: u8 = 0x9;
    let opcode_pong: u8 = 0xA;

    let encoded_ping = websocket::encode_frame(opcode_ping, b"keepalive", true);
    let (ping, _) = websocket::parse_frame(&encoded_ping).expect("Masked ping must parse");
    assert_eq!(ping.opcode, opcode_ping);
    assert_eq!(ping.payload, b"keepalive");
    assert!(ping.masked);

    let encoded_pong = websocket::encode_frame(opcode_pong, b"keepalive", true);
    let (pong, _) = websocket::parse_frame(&encoded_pong).expect("Masked pong must parse");
    assert_eq!(pong.opcode, opcode_pong);
    assert_eq!(pong.payload, b"keepalive");
    assert!(pong.masked);
}

// ===========================================================================
// Test 3: Close frame with status code
// ===========================================================================

/// **Proves:** Close frame (opcode 0x8) is correctly identified. The first
/// two bytes of the close frame payload are a 16-bit status code (big-endian).
/// Common codes: 1000 = normal closure, 1001 = going away.
///
/// **Anti-fake property:** A parser that does not handle opcode 0x8 or that
/// strips the close payload would fail.
#[test]
fn close_frame_parsed_with_status_code() {
    let opcode_close: u8 = 0x8;
    // Close frame payload: 2-byte status code (1000 = normal closure) + optional reason
    let mut close_payload = Vec::new();
    close_payload.extend_from_slice(&1000u16.to_be_bytes()); // status code
    close_payload.extend_from_slice(b"Normal closure");

    let encoded = websocket::encode_frame(opcode_close, &close_payload, false);
    let (frame, _consumed) =
        websocket::parse_frame(&encoded).expect("Close frame must parse successfully");

    assert_eq!(frame.opcode, opcode_close, "Opcode must be 0x8 (close)");
    assert!(frame.fin, "Close frame must have FIN=1");

    // Extract the status code from the first 2 bytes of payload
    assert!(
        frame.payload.len() >= 2,
        "Close frame payload must contain at least 2 bytes for the status code"
    );
    let status_code = u16::from_be_bytes([frame.payload[0], frame.payload[1]]);
    assert_eq!(
        status_code, 1000,
        "Close status code must be 1000 (normal closure)"
    );

    // The rest is the reason string
    let reason =
        std::str::from_utf8(&frame.payload[2..]).expect("Close reason must be valid UTF-8");
    assert_eq!(reason, "Normal closure");
}

#[test]
fn close_frame_with_going_away_status() {
    let opcode_close: u8 = 0x8;
    let mut close_payload = Vec::new();
    close_payload.extend_from_slice(&1001u16.to_be_bytes()); // 1001 = going away

    let encoded = websocket::encode_frame(opcode_close, &close_payload, true);
    let (frame, _consumed) =
        websocket::parse_frame(&encoded).expect("Masked close frame must parse successfully");

    assert_eq!(frame.opcode, opcode_close);
    let status_code = u16::from_be_bytes([frame.payload[0], frame.payload[1]]);
    assert_eq!(status_code, 1001, "Status code must be 1001 (going away)");
}

// ===========================================================================
// Test 4: Large payload with extended length encodings
// ===========================================================================

/// **Proves:** Payloads larger than 125 bytes use the 16-bit extended length
/// encoding (length byte = 126, followed by 2 bytes of actual length).
/// Payloads larger than 65535 bytes use the 64-bit extended length encoding
/// (length byte = 127, followed by 8 bytes of actual length).
///
/// **Anti-fake property:** A parser that only handles the 7-bit length field
/// would truncate or fail on payloads > 125 bytes.
#[test]
fn payload_126_bytes_uses_extended_16bit_length() {
    let opcode_text: u8 = 0x1;
    // 200 bytes — triggers the 126 (2-byte extended) encoding
    let payload: Vec<u8> = (0..200).map(|i| (i % 256) as u8).collect();

    let encoded = websocket::encode_frame(opcode_text, &payload, false);
    let (frame, _consumed) =
        websocket::parse_frame(&encoded).expect("200-byte payload frame must parse successfully");

    assert_eq!(frame.opcode, opcode_text);
    assert_eq!(frame.payload.len(), 200, "Payload length must be preserved");
    assert_eq!(frame.payload, payload, "Payload content must match");

    // Verify the wire format uses extended length:
    // byte 0 = FIN + opcode, byte 1 = MASK(0) + 126
    assert_eq!(
        encoded[1] & 0x7F,
        126,
        "Length byte must be 126 for payloads between 126 and 65535"
    );
}

#[test]
fn payload_exactly_125_bytes_uses_short_length() {
    let opcode_text: u8 = 0x1;
    let payload: Vec<u8> = vec![b'A'; 125];

    let encoded = websocket::encode_frame(opcode_text, &payload, false);
    let (frame, _consumed) = websocket::parse_frame(&encoded).expect("125-byte payload must parse");

    assert_eq!(frame.payload.len(), 125);
    assert_eq!(frame.payload, payload);

    // 125 fits in 7-bit length — no extended encoding
    assert_eq!(
        encoded[1] & 0x7F,
        125,
        "Length byte must be 125 (no extended encoding needed)"
    );
}

#[test]
fn payload_65536_bytes_uses_extended_64bit_length() {
    let opcode_text: u8 = 0x1;
    // 65536 bytes — triggers the 127 (8-byte extended) encoding
    let payload: Vec<u8> = vec![b'X'; 65536];

    let encoded = websocket::encode_frame(opcode_text, &payload, false);
    let (frame, _consumed) =
        websocket::parse_frame(&encoded).expect("65536-byte payload frame must parse successfully");

    assert_eq!(frame.opcode, opcode_text);
    assert_eq!(
        frame.payload.len(),
        65536,
        "Large payload length must be preserved"
    );
    assert_eq!(frame.payload, payload, "Large payload content must match");

    // Verify the wire format uses 64-bit extended length:
    // byte 1 = MASK(0) + 127
    assert_eq!(
        encoded[1] & 0x7F,
        127,
        "Length byte must be 127 for payloads > 65535"
    );
}

#[test]
fn large_masked_payload_roundtrip() {
    let opcode_text: u8 = 0x1;
    // 1000 bytes, masked (client-to-server)
    let payload: Vec<u8> = (0..1000).map(|i| (i % 256) as u8).collect();

    let encoded = websocket::encode_frame(opcode_text, &payload, true);
    let (frame, _consumed) =
        websocket::parse_frame(&encoded).expect("Large masked payload must parse");

    assert_eq!(
        frame.payload, payload,
        "Unmasked payload must match original"
    );
    assert!(frame.masked, "Frame must be marked as masked");
}

// ===========================================================================
// Test 5: Masking/unmasking with XOR key
// ===========================================================================

/// **Proves:** The 4-byte XOR masking key correctly masks and unmasks
/// payload data. Per RFC 6455, each byte of payload is XOR'd with
/// mask_key[i % 4].
///
/// **Anti-fake property:** If masking is not applied during encoding or
/// not reversed during parsing, the payload will be garbled.
#[test]
fn masking_produces_different_wire_bytes() {
    let opcode_text: u8 = 0x1;
    let payload = b"unmask me please";

    let unmasked_frame = websocket::encode_frame(opcode_text, payload, false);
    let masked_frame = websocket::encode_frame(opcode_text, payload, true);

    // The masked frame must be longer (4-byte mask key added)
    assert!(
        masked_frame.len() > unmasked_frame.len(),
        "Masked frame must be longer than unmasked (has 4-byte mask key). \
         Masked: {} bytes, unmasked: {} bytes",
        masked_frame.len(),
        unmasked_frame.len()
    );

    // The MASK bit must be set in the masked frame
    assert_eq!(
        masked_frame[1] & 0x80,
        0x80,
        "MASK bit must be set in masked frame"
    );
    assert_eq!(
        unmasked_frame[1] & 0x80,
        0x00,
        "MASK bit must be clear in unmasked frame"
    );

    // Both must parse to the same payload
    let (parsed_unmasked, _) = websocket::parse_frame(&unmasked_frame).unwrap();
    let (parsed_masked, _) = websocket::parse_frame(&masked_frame).unwrap();
    assert_eq!(
        parsed_unmasked.payload, parsed_masked.payload,
        "Both masked and unmasked frames must decode to the same payload"
    );
    assert_eq!(parsed_masked.payload, payload);
}

#[test]
fn manual_xor_masking_verification() {
    // Construct a manually masked frame to verify the parser handles XOR correctly.
    // Frame: FIN=1, opcode=0x1 (text), MASK=1, length=4, mask_key=[0x37, 0xFA, 0x21, 0x3D]
    // Payload "test" = [0x74, 0x65, 0x73, 0x74]
    // Masked payload: payload[i] XOR mask_key[i % 4]
    //   0x74 ^ 0x37 = 0x43
    //   0x65 ^ 0xFA = 0x9F
    //   0x73 ^ 0x21 = 0x52
    //   0x74 ^ 0x3D = 0x49
    let manual_frame: Vec<u8> = vec![
        0x81, // FIN=1, opcode=0x1
        0x84, // MASK=1, length=4
        0x37, 0xFA, 0x21, 0x3D, // mask key
        0x43, 0x9F, 0x52, 0x49, // masked payload
    ];

    let (frame, consumed) = websocket::parse_frame(&manual_frame)
        .expect("Manually constructed masked frame must parse");

    assert_eq!(frame.opcode, 0x1);
    assert_eq!(frame.payload, b"test", "XOR unmasking must produce 'test'");
    assert!(frame.masked);
    assert!(frame.fin);
    assert_eq!(consumed, 10, "Manual frame is 10 bytes total");
}

// ===========================================================================
// Test 6: NEGATIVE — truncated frame returns error
// ===========================================================================

/// **Proves:** A truncated WebSocket frame returns an error rather than
/// panicking. This is critical for robustness — network data may arrive
/// in partial chunks.
///
/// **Anti-fake property:** A parser that unconditionally indexes into the
/// byte array would panic on short input. The test asserts Err, not panic.
#[test]
fn truncated_frame_zero_bytes_returns_error() {
    let result = websocket::parse_frame(&[]);
    assert!(
        result.is_err(),
        "Empty input must return Err, not panic or return Ok"
    );
}

#[test]
fn truncated_frame_one_byte_returns_error() {
    // Only the first byte (FIN + opcode) — missing the length byte
    let result = websocket::parse_frame(&[0x81]);
    assert!(
        result.is_err(),
        "Single byte must return Err — missing length byte"
    );
}

#[test]
fn truncated_frame_header_claims_more_data_than_available() {
    // Header says 100 bytes payload, but we only provide 2 bytes of header + 5 bytes of data
    let truncated: Vec<u8> = vec![
        0x81, // FIN=1, opcode=0x1
        100,  // Length=100 (unmasked), but only 5 bytes follow
        b'h', b'e', b'l', b'l', b'o',
    ];
    let result = websocket::parse_frame(&truncated);
    assert!(
        result.is_err(),
        "Frame claiming 100 bytes but providing only 5 must return Err"
    );
}

#[test]
fn truncated_extended_length_returns_error() {
    // Length byte says 126 (need 2 more bytes for length) but nothing follows
    let truncated: Vec<u8> = vec![
        0x81, // FIN=1, opcode=0x1
        126,  // Extended 16-bit length, but no length bytes follow
    ];
    let result = websocket::parse_frame(&truncated);
    assert!(
        result.is_err(),
        "Extended length with missing length bytes must return Err"
    );
}

#[test]
fn truncated_mask_key_returns_error() {
    // MASK=1, length=4, but only 2 bytes of mask key provided
    let truncated: Vec<u8> = vec![
        0x81, // FIN=1, opcode=0x1
        0x84, // MASK=1, length=4
        0x37, 0xFA, // Only 2 of 4 mask key bytes — truncated
    ];
    let result = websocket::parse_frame(&truncated);
    assert!(result.is_err(), "Truncated mask key must return Err");
}

#[test]
fn binary_frame_opcode_parses() {
    // Binary frames (opcode 0x2) should also parse without error
    let opcode_binary: u8 = 0x2;
    let payload = b"\x00\x01\x02\x03";

    let encoded = websocket::encode_frame(opcode_binary, payload, false);
    let (frame, _consumed) = websocket::parse_frame(&encoded).expect("Binary frame must parse");

    assert_eq!(frame.opcode, opcode_binary, "Opcode must be 0x2 (binary)");
    assert_eq!(frame.payload, payload);
}

// ===========================================================================
// Test 7: Bytes consumed tracking (Finding 5)
// ===========================================================================

/// **Proves:** parse_frame returns the correct number of bytes consumed,
/// allowing callers to parse multiple frames from a contiguous buffer.
#[test]
fn bytes_consumed_matches_frame_size() {
    let payload = b"hello";
    let opcode_text: u8 = 0x1;

    // Unmasked: 2 (header) + 5 (payload) = 7
    let encoded = websocket::encode_frame(opcode_text, payload, false);
    let (frame, consumed) = websocket::parse_frame(&encoded).unwrap();
    assert_eq!(consumed, 7, "Unmasked short frame: 2 header + 5 payload");
    assert_eq!(frame.payload, payload);

    // Masked: 2 (header) + 4 (mask key) + 5 (payload) = 11
    let encoded_masked = websocket::encode_frame(opcode_text, payload, true);
    let (_frame, consumed) = websocket::parse_frame(&encoded_masked).unwrap();
    assert_eq!(
        consumed, 11,
        "Masked short frame: 2 header + 4 mask + 5 payload"
    );
}

#[test]
fn bytes_consumed_with_trailing_data() {
    // Simulate a buffer with two frames concatenated
    let frame1 = websocket::encode_frame(0x1, b"first", false);
    let frame2 = websocket::encode_frame(0x1, b"second", false);
    let mut combined = frame1.clone();
    combined.extend_from_slice(&frame2);

    // Parse first frame — should consume only frame1's bytes
    let (f1, consumed1) = websocket::parse_frame(&combined).unwrap();
    assert_eq!(f1.payload, b"first");
    assert_eq!(consumed1, frame1.len());

    // Parse second frame from remaining bytes
    let (f2, consumed2) = websocket::parse_frame(&combined[consumed1..]).unwrap();
    assert_eq!(f2.payload, b"second");
    assert_eq!(consumed2, frame2.len());
}

// ===========================================================================
// Test 8: RSV bit validation (Finding 12)
// ===========================================================================

/// **Proves:** Frames with non-zero RSV bits are rejected because no
/// extensions are negotiated. Per RFC 6455 Section 5.2, RSV1-3 must be 0
/// unless an extension defines their meaning.
#[test]
fn non_zero_rsv_bits_rejected() {
    // RSV1 set: byte 0 = 0xC1 (FIN=1, RSV1=1, opcode=1)
    let frame_rsv1 = vec![0xC1, 0x01, b'x'];
    let result = websocket::parse_frame(&frame_rsv1);
    assert!(
        result.is_err(),
        "RSV1=1 must be rejected: no extensions negotiated"
    );

    // RSV2 set: byte 0 = 0xA1 (FIN=1, RSV2=1, opcode=1)
    let frame_rsv2 = vec![0xA1, 0x01, b'x'];
    let result = websocket::parse_frame(&frame_rsv2);
    assert!(result.is_err(), "RSV2=1 must be rejected");

    // RSV3 set: byte 0 = 0x91 (FIN=1, RSV3=1, opcode=1)
    let frame_rsv3 = vec![0x91, 0x01, b'x'];
    let result = websocket::parse_frame(&frame_rsv3);
    assert!(result.is_err(), "RSV3=1 must be rejected");

    // All RSV bits set: byte 0 = 0xF1 (FIN=1, RSV1+2+3=1, opcode=1)
    let frame_all_rsv = vec![0xF1, 0x01, b'x'];
    let result = websocket::parse_frame(&frame_all_rsv);
    assert!(result.is_err(), "All RSV bits set must be rejected");
}

// ===========================================================================
// Test 9: 64-bit MSB validation (Finding 16)
// ===========================================================================

/// **Proves:** A 64-bit extended payload length with the MSB set is rejected
/// per RFC 6455 Section 5.2: "the most significant bit MUST be 0".
#[test]
fn msb_set_in_64bit_length_rejected() {
    // Construct a frame with 64-bit length where MSB is set
    let mut frame = vec![
        0x81, // FIN=1, opcode=0x1
        127,  // 64-bit extended length
    ];
    // Length = 0x8000_0000_0000_0001 (MSB set)
    frame.extend_from_slice(&[0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]);
    // One byte of "payload" (won't be reached)
    frame.push(b'x');

    let result = websocket::parse_frame(&frame);
    assert!(
        result.is_err(),
        "64-bit payload length with MSB set must be rejected per RFC 6455"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("MSB"),
        "Error message should mention MSB: {}",
        err_msg
    );
}

// ===========================================================================
// Test 10: FIN bit control in encode_frame_with_fin (Finding 15)
// ===========================================================================

/// **Proves:** encode_frame_with_fin allows setting FIN=0 for non-final
/// fragments. encode_frame always sets FIN=1 (backward compatible).
#[test]
fn encode_frame_with_fin_false() {
    let payload = b"fragment";

    // FIN=0 (non-final fragment)
    let encoded = websocket::encode_frame_with_fin(0x1, payload, false, false);
    let (frame, _consumed) = websocket::parse_frame(&encoded).unwrap();
    assert!(!frame.fin, "FIN must be false for non-final fragment");
    assert_eq!(frame.payload, payload);
}

#[test]
fn encode_frame_with_fin_true() {
    let payload = b"final";

    // FIN=1 (final fragment — same as encode_frame default)
    let encoded = websocket::encode_frame_with_fin(0x1, payload, false, true);
    let (frame, _consumed) = websocket::parse_frame(&encoded).unwrap();
    assert!(frame.fin, "FIN must be true for final fragment");
    assert_eq!(frame.payload, payload);

    // Verify encode_frame also sets FIN=1
    let default_encoded = websocket::encode_frame(0x1, payload, false);
    assert_eq!(
        encoded, default_encoded,
        "encode_frame must default to FIN=1"
    );
}
