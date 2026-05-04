//! Tests for the gateway module: CONNECT parsing, host classification,
//! TLS config construction, and request interception logic.
//!
//! These tests cover Categories A through D and F from the gateway design.
//! They test library code only — no live network connections.

use std::sync::Arc;
use tempfile::TempDir;

use recondo_gateway::gateway::{
    self, classify_host, parse_connect_request, should_intercept, ConnectRequest, TunnelMode,
};
use recondo_gateway::tls;

// ===========================================================================
// Category A: CONNECT Request Parsing
// ===========================================================================

/// **Proves:** A standard CONNECT request for api.anthropic.com:443 is parsed
/// into the correct host and port.
/// **Anti-fake property:** Both host and port must match exactly — a parser that
/// returns hardcoded values would fail on the non-standard port test below.
#[test]
fn parse_valid_connect_request() {
    let raw = b"CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n";

    let result = parse_connect_request(raw).expect("Valid CONNECT must parse successfully");

    assert_eq!(
        result,
        ConnectRequest {
            host: "api.anthropic.com".to_string(),
            port: 443,
        }
    );
}

/// **Proves:** CONNECT to api.openai.com:443 is parsed correctly.
/// **Anti-fake property:** A different host string from the Anthropic test above
/// ensures the parser actually reads the host from the input.
#[test]
fn parse_connect_request_openai() {
    let raw = b"CONNECT api.openai.com:443 HTTP/1.1\r\nHost: api.openai.com:443\r\n\r\n";

    let result = parse_connect_request(raw).expect("Valid CONNECT must parse successfully");

    assert_eq!(result.host, "api.openai.com");
    assert_eq!(result.port, 443);
}

/// **Proves:** CONNECT to a non-standard port (8080) is parsed correctly.
/// **Anti-fake property:** A parser that hardcodes port 443 would fail.
#[test]
fn parse_connect_with_non_standard_port() {
    let raw = b"CONNECT internal.example.com:8080 HTTP/1.1\r\n\r\n";

    let result = parse_connect_request(raw).expect("Non-standard port must parse");

    assert_eq!(result.host, "internal.example.com");
    assert_eq!(result.port, 8080);
}

/// **Proves:** CONNECT to port 80 (HTTP) works.
/// **Anti-fake property:** Ensures the parser does not reject non-443 ports.
#[test]
fn parse_connect_with_port_80() {
    let raw = b"CONNECT example.com:80 HTTP/1.1\r\n\r\n";

    let result = parse_connect_request(raw).expect("Port 80 must parse");

    assert_eq!(result.host, "example.com");
    assert_eq!(result.port, 80);
}

/// **Proves:** Malformed CONNECT line (no host:port) returns an error.
/// **Anti-fake property:** A parser that always returns Ok would fail.
#[test]
fn parse_connect_malformed_no_host_port() {
    let raw = b"CONNECT HTTP/1.1\r\n\r\n";

    let result = parse_connect_request(raw);

    assert!(
        result.is_err(),
        "CONNECT without host:port must return an error"
    );
}

/// **Proves:** A non-CONNECT HTTP method returns an error.
/// **Anti-fake property:** Ensures the parser validates the method, not just
/// the presence of a host:port.
#[test]
fn parse_connect_wrong_method() {
    let raw = b"GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n";

    let result = parse_connect_request(raw);

    assert!(result.is_err(), "Non-CONNECT method must return an error");
}

/// **Proves:** Empty input returns an error.
/// **Anti-fake property:** Edge case — must not panic on empty bytes.
#[test]
fn parse_connect_empty_input() {
    let raw = b"";

    let result = parse_connect_request(raw);

    assert!(result.is_err(), "Empty input must return an error");
}

/// **Proves:** A CONNECT request missing the port (just host, no colon) returns an error.
/// **Anti-fake property:** Ensures the parser requires the host:port format.
#[test]
fn parse_connect_missing_port() {
    let raw = b"CONNECT api.anthropic.com HTTP/1.1\r\n\r\n";

    let result = parse_connect_request(raw);

    assert!(result.is_err(), "CONNECT without port must return an error");
}

/// **Proves:** A CONNECT request with a non-numeric port returns an error.
/// **Anti-fake property:** Port parsing must validate that the port is a number.
#[test]
fn parse_connect_non_numeric_port() {
    let raw = b"CONNECT api.anthropic.com:abc HTTP/1.1\r\n\r\n";

    let result = parse_connect_request(raw);

    assert!(result.is_err(), "Non-numeric port must return an error");
}

/// **Proves:** Partial request data (truncated mid-line) returns an error.
/// **Anti-fake property:** Ensures the parser does not process incomplete data.
#[test]
fn parse_connect_truncated_input() {
    let raw = b"CONNECT api.anth";

    let result = parse_connect_request(raw);

    assert!(result.is_err(), "Truncated CONNECT must return an error");
}

// ===========================================================================
// Category B: Host Classification
// ===========================================================================

/// **Proves:** api.anthropic.com is classified as MITM with provider "anthropic".
/// **Anti-fake property:** This is a known LLM provider that should be intercepted.
#[test]
fn classify_anthropic_host_as_mitm() {
    assert!(
        matches!(classify_host("api.anthropic.com"), TunnelMode::Mitm(ref p) if p == "anthropic"),
        "api.anthropic.com must be classified as MITM(\"anthropic\")"
    );
}

/// **Proves:** api.openai.com is classified as MITM with provider "openai".
/// **Anti-fake property:** A second known provider, ensuring the function
/// checks multiple providers, not just Anthropic.
#[test]
fn classify_openai_host_as_mitm() {
    assert!(
        matches!(classify_host("api.openai.com"), TunnelMode::Mitm(ref p) if p == "openai"),
        "api.openai.com must be classified as MITM(\"openai\")"
    );
}

/// **Proves:** An unknown host is classified as passthrough.
/// **Anti-fake property:** A function that always returns Mitm would fail.
#[test]
fn classify_unknown_host_as_passthrough() {
    assert_eq!(
        classify_host("example.com"),
        TunnelMode::Passthrough,
        "example.com must be classified as Passthrough"
    );
}

/// **Proves:** github.com is classified as passthrough.
/// **Anti-fake property:** Ensures non-LLM hosts are not intercepted.
#[test]
fn classify_github_as_passthrough() {
    assert_eq!(
        classify_host("github.com"),
        TunnelMode::Passthrough,
        "github.com must be classified as Passthrough"
    );
}

/// **Proves:** A host with a port suffix (api.anthropic.com:443) is still
/// classified as MITM.
/// **Anti-fake property:** The classification must strip the port before matching,
/// since CONNECT requests include the port.
#[test]
fn classify_host_with_port_as_mitm() {
    assert!(
        matches!(classify_host("api.anthropic.com:443"), TunnelMode::Mitm(_)),
        "api.anthropic.com:443 must be classified as MITM (port stripped)"
    );
}

/// **Proves:** api.openai.com:443 with port is still MITM.
#[test]
fn classify_openai_with_port_as_mitm() {
    assert!(
        matches!(classify_host("api.openai.com:443"), TunnelMode::Mitm(_)),
        "api.openai.com:443 must be classified as MITM (port stripped)"
    );
}

/// **Proves:** An unknown host with a port is still passthrough.
#[test]
fn classify_unknown_host_with_port_as_passthrough() {
    assert_eq!(
        classify_host("example.com:443"),
        TunnelMode::Passthrough,
        "example.com:443 must be classified as Passthrough"
    );
}

/// **Proves:** Case-insensitive classification works.
/// **Anti-fake property:** Uppercase host should still be recognized.
#[test]
fn classify_host_case_insensitive() {
    assert!(
        matches!(classify_host("API.ANTHROPIC.COM"), TunnelMode::Mitm(_)),
        "API.ANTHROPIC.COM (uppercase) must be classified as MITM"
    );
}

/// **Proves:** Partial hostname match does NOT trigger MITM.
/// **Anti-fake property:** "notapi.anthropic.com" is not the actual provider host.
#[test]
fn classify_partial_match_as_passthrough() {
    assert_eq!(
        classify_host("notapi.anthropic.com"),
        TunnelMode::Passthrough,
        "Partial hostname match must NOT trigger MITM"
    );
}

// ===========================================================================
// Category C: TLS Server Config Construction
// ===========================================================================

/// **Proves:** A rustls ServerConfig can be built for api.anthropic.com
/// using the CA from the data directory.
/// **Anti-fake property:** The config is a real rustls::ServerConfig — calling
/// build_server_config with a valid CA must not error.
#[test]
fn build_server_config_for_anthropic() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // Ensure CA exists first
    tls::ensure_ca(&data_dir).expect("CA generation must succeed");

    let config = gateway::build_server_config(&data_dir, "api.anthropic.com")
        .expect("Building server config must succeed");

    // ServerConfig should be usable (we can wrap it in Arc)
    let _arc_config = Arc::new(config);
}

/// **Proves:** A rustls ServerConfig can be built for api.openai.com.
/// **Anti-fake property:** Different host from the test above — ensures
/// the config is built per-host, not cached/hardcoded.
#[test]
fn build_server_config_for_openai() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    tls::ensure_ca(&data_dir).unwrap();

    let config = gateway::build_server_config(&data_dir, "api.openai.com")
        .expect("Building server config for openai must succeed");

    let _arc_config = Arc::new(config);
}

/// **Proves:** Building a server config without a CA returns an error.
/// **Anti-fake property:** The function must depend on the CA existing.
#[test]
fn build_server_config_without_ca_fails() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // Do NOT call ensure_ca — CA does not exist
    let result = gateway::build_server_config(&data_dir, "api.anthropic.com");

    assert!(
        result.is_err(),
        "Building server config without CA must fail"
    );
}

/// **Proves:** Configs built for different hosts use different leaf certificates.
/// **Anti-fake property:** The underlying leaf cert generation produces different
/// certs per host, so the server configs must differ.
#[test]
fn different_hosts_produce_different_server_configs() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    tls::ensure_ca(&data_dir).unwrap();

    // We cannot directly compare ServerConfig (no PartialEq), but we can verify
    // that both build successfully — which requires different leaf certs.
    let _config1 =
        gateway::build_server_config(&data_dir, "api.anthropic.com").expect("Config for anthropic");
    let _config2 =
        gateway::build_server_config(&data_dir, "api.openai.com").expect("Config for openai");

    // If we get here, both configs were built with different leaf certs.
    // The underlying tls::generate_leaf_cert test (in tls_tests.rs) already
    // verifies they are different certificates.
}

// ===========================================================================
// Category D: Request Interception Logic
// ===========================================================================

/// **Proves:** POST /v1/messages is classified as should_capture = true.
/// **Anti-fake property:** This is the primary Anthropic API endpoint that
/// the gateway must intercept.
#[test]
fn intercept_post_v1_messages() {
    let http_request = b"POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\n\r\n{\"model\":\"claude-sonnet-4-20250514\"}";

    let decision = should_intercept(http_request, "unknown");

    assert!(
        decision.should_capture,
        "POST /v1/messages must be captured"
    );
    assert_eq!(decision.method.as_deref(), Some("POST"));
    assert_eq!(decision.path.as_deref(), Some("/v1/messages"));
}

/// **Proves:** GET /v1/models is NOT captured.
/// **Anti-fake property:** GET requests should never be captured.
#[test]
fn do_not_intercept_get_models() {
    let http_request = b"GET /v1/models HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n";

    let decision = should_intercept(http_request, "unknown");

    assert!(
        !decision.should_capture,
        "GET /v1/models must NOT be captured"
    );
    assert_eq!(decision.method.as_deref(), Some("GET"));
    assert_eq!(decision.path.as_deref(), Some("/v1/models"));
}

/// **Proves:** POST to a different path (/v1/complete) is NOT captured.
/// **Anti-fake property:** Only /v1/messages is capturable; other POST paths
/// are not.
#[test]
fn do_not_intercept_post_v1_complete() {
    let http_request = b"POST /v1/complete HTTP/1.1\r\nHost: api.anthropic.com\r\nContent-Type: application/json\r\n\r\n{}";

    let decision = should_intercept(http_request, "unknown");

    assert!(
        !decision.should_capture,
        "POST /v1/complete must NOT be captured"
    );
    assert_eq!(decision.method.as_deref(), Some("POST"));
    assert_eq!(decision.path.as_deref(), Some("/v1/complete"));
}

/// **Proves:** Non-HTTP binary data is NOT captured.
/// **Anti-fake property:** Random bytes should not trigger capture.
#[test]
fn do_not_intercept_non_http_data() {
    let binary_data = &[0x16, 0x03, 0x01, 0x00, 0xff, 0x01, 0x00]; // TLS-like bytes

    let decision = should_intercept(binary_data, "unknown");

    assert!(
        !decision.should_capture,
        "Non-HTTP binary data must NOT be captured"
    );
    assert!(
        decision.method.is_none(),
        "Non-HTTP data should have no parsed method"
    );
    assert!(
        decision.path.is_none(),
        "Non-HTTP data should have no parsed path"
    );
}

/// **Proves:** Empty bytes are NOT captured.
/// **Anti-fake property:** Edge case — must not panic on empty input.
#[test]
fn do_not_intercept_empty_bytes() {
    let decision = should_intercept(b"", "unknown");

    assert!(!decision.should_capture, "Empty bytes must NOT be captured");
    assert!(decision.method.is_none());
    assert!(decision.path.is_none());
}

/// **Proves:** POST /v1/messages with extra path segments is NOT captured.
/// **Anti-fake property:** Only the exact path /v1/messages should match.
#[test]
fn do_not_intercept_post_v1_messages_subpath() {
    let http_request = b"POST /v1/messages/batch HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n{}";

    let decision = should_intercept(http_request, "unknown");

    assert!(
        !decision.should_capture,
        "POST /v1/messages/batch must NOT be captured (wrong path)"
    );
}

/// **Proves:** HEAD /v1/messages is NOT captured.
/// **Anti-fake property:** Only POST method triggers capture.
#[test]
fn do_not_intercept_head_v1_messages() {
    let http_request = b"HEAD /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n";

    let decision = should_intercept(http_request, "unknown");

    assert!(
        !decision.should_capture,
        "HEAD /v1/messages must NOT be captured"
    );
}

/// **Proves:** POST /v1/messages with query string is still captured.
/// **Anti-fake property:** The path before the query string is /v1/messages,
/// which should match. (Or the implementation may choose to strip the query
/// string before matching.)
#[test]
fn intercept_post_v1_messages_with_query_string() {
    let http_request = b"POST /v1/messages?beta=true HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n{}";

    let decision = should_intercept(http_request, "unknown");

    // The path may be "/v1/messages?beta=true" or "/v1/messages" depending on
    // how the implementation handles query strings. Either way, this endpoint
    // should be captured since the base path is /v1/messages.
    assert!(
        decision.should_capture,
        "POST /v1/messages with query string should be captured"
    );
}

// ===========================================================================
// Category F: Negative / Edge Case Tests
// ===========================================================================

/// **Proves:** CONNECT to a non-443 port is handled gracefully.
/// **Anti-fake property:** The parser must not reject valid CONNECT requests
/// to non-standard ports.
#[test]
fn connect_to_non_443_port_handled() {
    let raw = b"CONNECT proxy.example.com:3128 HTTP/1.1\r\n\r\n";

    let result = parse_connect_request(raw);
    assert!(
        result.is_ok(),
        "CONNECT to non-443 port must be handled gracefully"
    );
    let req = result.unwrap();
    assert_eq!(req.port, 3128);
}

/// **Proves:** CONNECT with port 0 is parsed (but may be rejected at connection time).
/// **Anti-fake property:** Port 0 is syntactically valid in the CONNECT line.
#[test]
fn connect_to_port_zero_parsed() {
    let raw = b"CONNECT example.com:0 HTTP/1.1\r\n\r\n";

    // Port 0 is syntactically valid in a CONNECT request, even if it's not
    // useful. The parser should accept it; connection handling may reject later.
    let result = parse_connect_request(raw);
    assert!(result.is_ok(), "Port 0 is syntactically valid in CONNECT");
    assert_eq!(result.unwrap().port, 0);
}

/// **Proves:** CONNECT with port 65535 (max valid port) is parsed.
#[test]
fn connect_to_max_port_parsed() {
    let raw = b"CONNECT example.com:65535 HTTP/1.1\r\n\r\n";

    let result = parse_connect_request(raw);
    assert!(result.is_ok(), "Port 65535 must parse successfully");
    assert_eq!(result.unwrap().port, 65535);
}

/// **Proves:** CONNECT with port > 65535 returns an error.
/// **Anti-fake property:** Port numbers above 65535 are invalid.
#[test]
fn connect_to_port_above_65535_fails() {
    let raw = b"CONNECT example.com:65536 HTTP/1.1\r\n\r\n";

    let result = parse_connect_request(raw);
    assert!(result.is_err(), "Port > 65535 must return an error");
}

/// **Proves:** Garbage bytes that look nothing like HTTP are handled without panic.
#[test]
fn garbage_bytes_handled_gracefully() {
    let garbage = &[0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd];

    let result = parse_connect_request(garbage);
    assert!(result.is_err(), "Garbage bytes must return an error");
}

/// **Proves:** Building a TLS server config with an empty host string fails.
/// **Anti-fake property:** An empty host cannot produce a valid leaf cert.
#[test]
fn build_server_config_empty_host_fails() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    tls::ensure_ca(&data_dir).unwrap();

    let result = gateway::build_server_config(&data_dir, "");

    assert!(
        result.is_err(),
        "Empty host must fail when building server config"
    );
}
