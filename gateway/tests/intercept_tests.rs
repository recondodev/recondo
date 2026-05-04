//! Tests for the gateway TCP loop helpers: CONNECT response construction,
//! HTTP body extraction, and Content-Length parsing.
//!
//! These tests cover Categories A through D from the intercept design document.
//! They test library functions only — no live network connections or TLS.

use recondo_gateway::gateway;

// ===========================================================================
// Category A: CONNECT Response (4 tests)
// ===========================================================================

/// **Proves:** connect_response starts with the correct HTTP/1.1 200 status line.
/// **Anti-fake property:** A stub that returns arbitrary bytes would fail the
/// prefix check against the exact status line.
#[test]
fn connect_response_has_correct_status_line() {
    let resp = gateway::connect_response();
    let text = std::str::from_utf8(resp).expect("Response must be valid UTF-8");

    assert!(
        text.starts_with("HTTP/1.1 200"),
        "Response must start with 'HTTP/1.1 200', got: {:?}",
        text
    );
}

/// **Proves:** connect_response ends with the double CRLF that signals the
/// end of HTTP headers (no body follows).
/// **Anti-fake property:** A response that omits the trailing \r\n\r\n would
/// cause the client to hang waiting for more header data.
#[test]
fn connect_response_ends_with_double_crlf() {
    let resp = gateway::connect_response();

    assert!(
        resp.ends_with(b"\r\n\r\n"),
        "Response must end with \\r\\n\\r\\n (double CRLF)"
    );
}

/// **Proves:** connect_response bytes are all valid ASCII.
/// **Anti-fake property:** HTTP/1.1 status lines must be ASCII. Non-ASCII bytes
/// would be rejected by conformant HTTP clients.
#[test]
fn connect_response_is_valid_ascii() {
    let resp = gateway::connect_response();

    assert!(
        resp.is_ascii(),
        "All bytes in the CONNECT response must be valid ASCII"
    );
}

/// **Proves:** connect_response contains the phrase "Connection Established",
/// which is the standard reason phrase for CONNECT 200 responses (RFC 7231).
/// **Anti-fake property:** A response that says "200 OK" instead of
/// "200 Connection Established" would fail. Some HTTP clients depend on the
/// exact reason phrase.
#[test]
fn connect_response_contains_connection_established() {
    let resp = gateway::connect_response();
    let text = std::str::from_utf8(resp).expect("Response must be valid UTF-8");

    assert!(
        text.contains("Connection Established"),
        "Response must contain 'Connection Established', got: {:?}",
        text
    );
}

// ===========================================================================
// Category B: HTTP Body Extraction (8 tests)
// ===========================================================================

/// **Proves:** extract_http_body correctly splits headers from body when
/// Content-Length is present and matches the actual body length.
/// **Anti-fake property:** Both the headers string and body bytes are checked
/// independently — a stub returning empty values would fail both assertions.
#[test]
fn extract_body_with_content_length() {
    let raw = b"POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Length: 13\r\n\r\n{\"key\":\"val\"}";

    let (headers, body) = gateway::extract_http_body(raw).expect("Must parse valid HTTP");

    assert!(
        headers.contains("Content-Length: 13"),
        "Headers must contain the Content-Length header"
    );
    assert_eq!(
        body, b"{\"key\":\"val\"}",
        "Body must match the bytes after the header boundary"
    );
}

/// **Proves:** The extracted body length exactly matches the Content-Length value.
/// **Anti-fake property:** If the implementation returns all bytes after headers
/// regardless of Content-Length, this test would still pass — but the
/// content_length_larger_than_data test in Category D catches that case.
#[test]
fn extracted_body_length_matches_content_length() {
    let body_content = b"hello world!!"; // exactly 13 bytes
    let raw_str = format!(
        "POST /test HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
        body_content.len()
    );
    let mut raw = raw_str.into_bytes();
    raw.extend_from_slice(body_content);

    let (_headers, body) = gateway::extract_http_body(&raw).expect("Must parse valid HTTP");

    assert_eq!(
        body.len(),
        body_content.len(),
        "Extracted body length must equal Content-Length value"
    );
}

/// **Proves:** Headers and body are separated at the \r\n\r\n boundary.
/// **Anti-fake property:** The headers string must NOT contain the body content
/// and the body must NOT contain header text. Checked both directions.
#[test]
fn headers_and_body_separated_at_boundary() {
    let raw = b"GET /test HTTP/1.1\r\nX-Custom: value\r\nContent-Length: 4\r\n\r\nBODY";

    let (headers, body) = gateway::extract_http_body(raw).expect("Must parse valid HTTP");

    assert!(
        headers.contains("X-Custom: value"),
        "Headers must contain the custom header"
    );
    assert!(
        !headers.contains("BODY"),
        "Headers must NOT contain body content"
    );
    assert_eq!(
        body, b"BODY",
        "Body must be exactly the bytes after \\r\\n\\r\\n"
    );
}

/// **Proves:** When Content-Length is absent, body is everything after headers.
/// **Anti-fake property:** The implementation must use read-until-end semantics
/// when no Content-Length is present, not return an empty body.
#[test]
fn missing_content_length_returns_remaining_as_body() {
    let raw = b"POST /data HTTP/1.1\r\nHost: example.com\r\n\r\nsome arbitrary body content here";

    let (_headers, body) =
        gateway::extract_http_body(raw).expect("Must parse without Content-Length");

    assert_eq!(
        body, b"some arbitrary body content here",
        "Without Content-Length, body must be all bytes after header boundary"
    );
}

/// **Proves:** Content-Length: 0 yields an empty body.
/// **Anti-fake property:** A function that always returns remaining bytes would
/// fail if there are extra bytes after the header boundary. This test has
/// zero bytes after headers, so the body must be empty.
#[test]
fn empty_body_with_content_length_zero() {
    let raw = b"POST /empty HTTP/1.1\r\nContent-Length: 0\r\n\r\n";

    let (_headers, body) = gateway::extract_http_body(raw).expect("Must parse Content-Length: 0");

    assert!(
        body.is_empty(),
        "Content-Length: 0 must produce an empty body"
    );
}

/// **Proves:** Large bodies (100 KB) are extracted correctly.
/// **Anti-fake property:** A function that truncates at an internal buffer
/// boundary (e.g., 4 KB, 8 KB, 64 KB) would produce a shorter body.
#[test]
fn large_body_100kb() {
    let body_content = vec![b'A'; 100 * 1024]; // 100 KB of 'A's
    let header = format!(
        "POST /large HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
        body_content.len()
    );
    let mut raw = header.into_bytes();
    raw.extend_from_slice(&body_content);

    let (_headers, body) = gateway::extract_http_body(&raw).expect("Must handle 100KB body");

    assert_eq!(
        body.len(),
        100 * 1024,
        "Large body must be extracted in full (100 KB)"
    );
    assert!(
        body.iter().all(|&b| b == b'A'),
        "All bytes in the large body must be 'A'"
    );
}

/// **Proves:** Malformed input (no \r\n\r\n boundary) returns an error.
/// **Anti-fake property:** A function that never errors would fail this test.
#[test]
fn malformed_headers_no_boundary_returns_error() {
    let raw = b"POST /test HTTP/1.1\r\nHost: example.com\r\nno double crlf here";

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "Missing \\r\\n\\r\\n boundary must return an error"
    );
}

/// **Proves:** Completely empty input returns an error.
/// **Anti-fake property:** A function that returns Ok(("", vec![])) would fail.
#[test]
fn empty_input_returns_error() {
    let result = gateway::extract_http_body(b"");

    assert!(result.is_err(), "Empty input must return an error");
}

// ===========================================================================
// Category C: Content-Length Parsing (5 tests)
// ===========================================================================

/// **Proves:** A standard Content-Length header is parsed to its numeric value.
/// **Anti-fake property:** The returned value must be exactly 42 — a function
/// that returns a hardcoded value would fail the case-insensitive test below.
#[test]
fn parse_standard_content_length() {
    let headers = "POST /test HTTP/1.1\r\nContent-Length: 42\r\nHost: example.com";

    let result = gateway::parse_content_length(headers);

    assert_eq!(
        result,
        Some(42),
        "Content-Length: 42 must parse to Some(42)"
    );
}

/// **Proves:** Content-Length matching is case-insensitive per HTTP spec.
/// **Anti-fake property:** A function that does exact "Content-Length" matching
/// would fail on lowercase or mixed-case variants.
#[test]
fn parse_content_length_case_insensitive() {
    let headers = "POST /test HTTP/1.1\r\ncontent-length: 128\r\nHost: example.com";

    let result = gateway::parse_content_length(headers);

    assert_eq!(
        result,
        Some(128),
        "content-length (lowercase) must parse to Some(128)"
    );
}

/// **Proves:** Missing Content-Length header returns None.
/// **Anti-fake property:** A function that always returns Some would fail.
#[test]
fn parse_content_length_missing_returns_none() {
    let headers = "GET /test HTTP/1.1\r\nHost: example.com\r\nAccept: */*";

    let result = gateway::parse_content_length(headers);

    assert_eq!(result, None, "Missing Content-Length must return None");
}

/// **Proves:** Non-numeric Content-Length value returns None.
/// **Anti-fake property:** A function that panics on parse failure would fail.
#[test]
fn parse_content_length_non_numeric_returns_none() {
    let headers = "POST /test HTTP/1.1\r\nContent-Length: abc\r\nHost: example.com";

    let result = gateway::parse_content_length(headers);

    assert_eq!(result, None, "Non-numeric Content-Length must return None");
}

/// **Proves:** Content-Length is found among multiple headers.
/// **Anti-fake property:** A function that only checks the first or last header
/// line would fail if Content-Length is in the middle.
#[test]
fn parse_content_length_among_multiple_headers() {
    let headers = "POST /test HTTP/1.1\r\nHost: example.com\r\nX-Request-Id: abc123\r\nContent-Length: 256\r\nAccept: application/json";

    let result = gateway::parse_content_length(headers);

    assert_eq!(
        result,
        Some(256),
        "Content-Length among multiple headers must parse to Some(256)"
    );
}

// ===========================================================================
// Category D: Negative Tests (3 tests)
// ===========================================================================

/// **Proves:** When Content-Length exceeds the actual available data, the
/// function returns an error (not a partial body or panic).
/// **Anti-fake property:** A function that silently returns whatever bytes
/// are available (without checking Content-Length) would succeed here, but
/// Category B's length-match test ensures Content-Length is respected.
/// This test ensures the mismatch is detected and reported.
#[test]
fn content_length_larger_than_data_returns_error() {
    // Content-Length says 1000 but only 5 bytes of body follow
    let raw = b"POST /test HTTP/1.1\r\nContent-Length: 1000\r\n\r\nhello";

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "Content-Length larger than actual data must return an error"
    );
}

/// **Proves:** Bytes that are not HTTP at all (no recognizable request line,
/// no \r\n\r\n) produce an error.
/// **Anti-fake property:** A function that returns Ok for any input would fail.
#[test]
fn non_http_data_returns_error() {
    // Raw binary data with no HTTP structure
    let raw: &[u8] = &[0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x01, 0x02, 0xff];

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "Non-HTTP binary data must return an error (no \\r\\n\\r\\n boundary)"
    );
}

/// **Proves:** Content-Length: -1 is treated as invalid (returns None).
/// **Anti-fake property:** A function that parses -1 as a signed integer
/// and converts to usize would produce a very large number or panic.
#[test]
fn negative_content_length_returns_none() {
    let headers = "POST /test HTTP/1.1\r\nContent-Length: -1\r\nHost: example.com";

    let result = gateway::parse_content_length(headers);

    assert_eq!(
        result, None,
        "Content-Length: -1 must return None (negative values are invalid)"
    );
}

// ===========================================================================
// Code review findings: additional tests
// ===========================================================================

/// **Finding #3:** Duplicate Content-Length headers with different values return None.
#[test]
fn duplicate_content_length_different_values_returns_none() {
    let headers =
        "POST /test HTTP/1.1\r\nContent-Length: 10\r\nContent-Length: 20\r\nHost: example.com";

    let result = gateway::parse_content_length(headers);

    assert_eq!(
        result, None,
        "Duplicate Content-Length headers with different values must return None"
    );
}

/// **Finding #3:** Duplicate Content-Length headers with the same value return that value.
#[test]
fn duplicate_content_length_same_value_returns_value() {
    let headers =
        "POST /test HTTP/1.1\r\nContent-Length: 42\r\nContent-Length: 42\r\nHost: example.com";

    let result = gateway::parse_content_length(headers);

    assert_eq!(
        result,
        Some(42),
        "Duplicate Content-Length headers with the same value must return Some(42)"
    );
}

/// **Finding #6:** Exact equality test for connect_response.
#[test]
fn connect_response_exact_equality() {
    assert_eq!(
        gateway::connect_response(),
        b"HTTP/1.1 200 Connection Established\r\n\r\n"
    );
}

/// **Finding #7:** All-uppercase CONTENT-LENGTH is parsed correctly.
#[test]
fn parse_content_length_all_uppercase() {
    let headers = "POST /test HTTP/1.1\r\nCONTENT-LENGTH: 99\r\nHost: example.com";

    let result = gateway::parse_content_length(headers);

    assert_eq!(
        result,
        Some(99),
        "CONTENT-LENGTH (all uppercase) must parse to Some(99)"
    );
}

/// **Finding #7:** Standard mixed-case Content-Length is parsed correctly.
#[test]
fn parse_content_length_standard_case() {
    let headers = "POST /test HTTP/1.1\r\nContent-Length: 99\r\nHost: example.com";

    let result = gateway::parse_content_length(headers);

    assert_eq!(
        result,
        Some(99),
        "Content-Length (standard case) must parse to Some(99)"
    );
}

/// **Finding #8:** Content-Length < available data truncates body to CL bytes.
#[test]
fn content_length_less_than_available_data_truncates() {
    // Content-Length is 5 but body has 11 bytes ("hello world")
    let raw = b"POST /test HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello world";

    let (_, body) = gateway::extract_http_body(raw).expect("Must parse valid HTTP");

    assert_eq!(
        body, b"hello",
        "Body must be truncated to Content-Length (5 bytes)"
    );
    assert_eq!(body.len(), 5);
}

/// **Finding #9:** CONNECT_RESPONSE const matches connect_response function.
#[test]
fn connect_response_const_matches_function() {
    assert_eq!(
        gateway::CONNECT_RESPONSE,
        gateway::connect_response(),
        "CONNECT_RESPONSE const must match connect_response() function"
    );
}

/// **Finding #10:** Non-UTF-8 bytes (0xFF) in the header portion produce an error.
#[test]
fn non_utf8_header_bytes_returns_error() {
    let mut raw = Vec::new();
    raw.extend_from_slice(b"POST /test HTTP/1.1\r\n");
    raw.push(0xFF);
    raw.push(0xFF);
    raw.extend_from_slice(b"\r\n\r\nbody");

    let result = gateway::extract_http_body(&raw);

    assert!(
        result.is_err(),
        "Non-UTF8 bytes in headers must return an error"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("non-UTF8") || err_msg.contains("UTF-8") || err_msg.contains("utf8"),
        "Error must mention UTF-8 issue, got: {}",
        err_msg
    );
}

/// **Finding #11:** Content-Length exceeding MAX_BODY_SIZE (50 MB) returns None.
#[test]
fn content_length_exceeding_max_body_size_returns_none() {
    let huge_cl = 50 * 1024 * 1024 + 1; // 50 MB + 1
    let headers = format!(
        "POST /test HTTP/1.1\r\nContent-Length: {}\r\nHost: example.com",
        huge_cl
    );

    let result = gateway::parse_content_length(&headers);

    assert_eq!(
        result, None,
        "Content-Length exceeding 50 MB must return None"
    );
}

/// **Finding #11:** Content-Length at exactly MAX_BODY_SIZE (50 MB) returns Some.
#[test]
fn content_length_at_max_body_size_returns_some() {
    let exact_max = 50 * 1024 * 1024; // exactly 50 MB
    let headers = format!(
        "POST /test HTTP/1.1\r\nContent-Length: {}\r\nHost: example.com",
        exact_max
    );

    let result = gateway::parse_content_length(&headers);

    assert_eq!(
        result,
        Some(exact_max),
        "Content-Length at exactly 50 MB must return Some"
    );
}

/// **Finding #12:** Transfer-Encoding: chunked is detected and rejected.
#[test]
fn chunked_transfer_encoding_returns_error() {
    let raw = b"POST /test HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n";

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "Transfer-Encoding: chunked must return an error"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("Chunked transfer encoding is unsupported"),
        "Error must mention chunked not supported, got: {}",
        err_msg
    );
}

/// **Finding #12:** Transfer-Encoding: chunked detection is case-insensitive.
#[test]
fn chunked_transfer_encoding_case_insensitive() {
    let raw = b"POST /test HTTP/1.1\r\ntransfer-encoding: Chunked\r\n\r\nbody";

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "transfer-encoding: Chunked (mixed case) must return an error"
    );
}

// ===========================================================================
// Code Review Round 2 findings
// ===========================================================================

/// **Round 2, Finding #1:** Multi-value Transfer-Encoding header with "chunked"
/// among other encodings (e.g., `gzip, chunked`) is detected and rejected.
#[test]
fn chunked_transfer_encoding_multi_value() {
    let raw = b"POST /test HTTP/1.1\r\nTransfer-Encoding: gzip, chunked\r\n\r\nbody";

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "Transfer-Encoding: gzip, chunked (multi-value) must return an error"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("Chunked transfer encoding is unsupported"),
        "Error must mention chunked not supported, got: {}",
        err_msg
    );
}

/// **Round 2, Finding #2:** Content-Length header present but invalid causes
/// extract_http_body to error instead of silently falling through to read-until-end.
#[test]
fn invalid_content_length_causes_error_not_fallthrough() {
    let raw = b"POST /test HTTP/1.1\r\nContent-Length: abc\r\n\r\nsome body data";

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "Invalid Content-Length must cause an error, not silent read-until-end"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("Content-Length header present but invalid"),
        "Error must mention invalid Content-Length, got: {}",
        err_msg
    );
}

/// **Round 2, Finding #2:** Content-Length header present but exceeding MAX_BODY_SIZE
/// causes extract_http_body to error.
#[test]
fn oversized_content_length_causes_error_not_fallthrough() {
    let huge_cl = 50 * 1024 * 1024 + 1; // 50 MB + 1
    let raw_str = format!(
        "POST /test HTTP/1.1\r\nContent-Length: {}\r\n\r\nshort body",
        huge_cl
    );
    let raw = raw_str.as_bytes();

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "Oversized Content-Length must cause an error, not silent read-until-end"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("Content-Length header present but invalid"),
        "Error must mention invalid Content-Length, got: {}",
        err_msg
    );
}

/// **Round 2, Finding #3:** All-uppercase TRANSFER-ENCODING: chunked is detected.
#[test]
fn chunked_transfer_encoding_all_uppercase() {
    let raw = b"POST /test HTTP/1.1\r\nTRANSFER-ENCODING: chunked\r\n\r\nbody";

    let result = gateway::extract_http_body(raw);

    assert!(
        result.is_err(),
        "TRANSFER-ENCODING: chunked (all uppercase) must return an error"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("Chunked transfer encoding is unsupported"),
        "Error must mention chunked not supported, got: {}",
        err_msg
    );
}

/// **Round 2, Finding #5:** Body without Content-Length and without Transfer-Encoding
/// that exceeds MAX_BODY_SIZE (50 MB) is rejected.
#[test]
fn body_without_cl_exceeding_max_size_returns_error() {
    // Build a raw HTTP message with no Content-Length and a body > 50 MB.
    // We only need the header + boundary + enough remaining bytes to exceed the limit.
    let header = b"POST /test HTTP/1.1\r\nHost: example.com\r\n\r\n";
    let body_size = 50 * 1024 * 1024 + 1; // 50 MB + 1
    let mut raw = Vec::with_capacity(header.len() + body_size);
    raw.extend_from_slice(header);
    raw.resize(header.len() + body_size, b'X');

    let result = gateway::extract_http_body(&raw);

    assert!(
        result.is_err(),
        "Body without Content-Length exceeding 50 MB must return an error"
    );
    let err_msg = result.unwrap_err().to_string();
    assert!(
        err_msg.contains("exceeds maximum body size"),
        "Error must mention body size exceeded, got: {}",
        err_msg
    );
}
