//! Tests for LLM provider detection from CONNECT host.
//!
//! These tests verify that the provider detection module correctly
//! identifies LLM providers from the hostname in the CONNECT request.

use recondo_gateway::providers;

/// **Proves:** api.anthropic.com is detected as provider "anthropic".
/// **Anti-fake property:** Checks the exact string value — returning a default
/// or wrong provider name fails.
#[test]
fn anthropic_host_detected_as_anthropic_provider() {
    let provider = providers::detect_provider("api.anthropic.com");
    assert_eq!(
        provider, "anthropic",
        "api.anthropic.com must be detected as 'anthropic'"
    );
}

/// **Proves:** api.openai.com is detected as provider "openai".
/// **Anti-fake property:** Must distinguish between anthropic and openai hosts.
#[test]
fn openai_host_detected_as_openai_provider() {
    let provider = providers::detect_provider("api.openai.com");
    assert_eq!(
        provider, "openai",
        "api.openai.com must be detected as 'openai'"
    );
}

/// **Proves:** An unknown host returns "unknown" (not a panic, not empty, not None).
/// **Anti-fake property:** The function must handle arbitrary hosts gracefully.
#[test]
fn unknown_host_returns_unknown_provider() {
    let provider = providers::detect_provider("example.com");
    assert_eq!(
        provider, "unknown",
        "Unknown hosts must be detected as 'unknown'"
    );
}

/// **Proves:** The function handles hosts with port numbers correctly.
/// **Anti-fake property:** CONNECT requests may include port (api.anthropic.com:443).
/// The detection must still work.
#[test]
fn host_with_port_detected_correctly() {
    let provider = providers::detect_provider("api.anthropic.com:443");
    assert_eq!(
        provider, "anthropic",
        "api.anthropic.com:443 must be detected as 'anthropic'"
    );

    let provider = providers::detect_provider("api.openai.com:443");
    assert_eq!(
        provider, "openai",
        "api.openai.com:443 must be detected as 'openai'"
    );
}

/// **Proves:** The function does not perform partial matching on substrings.
/// **Anti-fake property:** A naive `contains("anthropic")` implementation would
/// incorrectly match this host.
#[test]
fn partial_match_does_not_trigger_false_positive() {
    let provider = providers::detect_provider("not-api.anthropic.com.evil.com");
    assert_eq!(
        provider, "unknown",
        "Subdomain spoofing must not trigger a false positive"
    );
}

/// **Proves:** Empty string host returns "unknown".
/// **Anti-fake property:** Edge case — must not panic.
#[test]
fn empty_host_returns_unknown() {
    let provider = providers::detect_provider("");
    assert_eq!(provider, "unknown", "Empty host must return 'unknown'");
}

/// **Proves:** Detection is case-insensitive for hosts (DNS is case-insensitive).
/// **Anti-fake property:** A case-sensitive exact match would fail this.
#[test]
fn host_detection_is_case_insensitive() {
    let provider = providers::detect_provider("API.ANTHROPIC.COM");
    assert_eq!(
        provider, "anthropic",
        "Host detection should be case-insensitive"
    );

    let provider = providers::detect_provider("Api.OpenAI.Com");
    assert_eq!(
        provider, "openai",
        "Host detection should be case-insensitive"
    );
}
