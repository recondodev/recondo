//! Tests for the SHA-256 hashing module.
//!
//! These tests verify that the hash module produces correct, deterministic,
//! collision-resistant SHA-256 hashes of arbitrary byte content.

use recondo_gateway::hash;

/// **Proves:** The hash function produces the correct SHA-256 digest for a known input.
/// **Anti-fake property:** Uses a NIST-style test vector. The expected hash is independently
/// computed — returning a hardcoded value or a different algorithm will fail.
#[test]
fn hash_of_known_input_matches_sha256_test_vector() {
    // SHA-256("hello world") = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
    let input = b"hello world";
    let hex = hash::sha256_hex(input);
    assert_eq!(
        hex, "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        "SHA-256 of 'hello world' must match the known test vector"
    );
}

/// **Proves:** The hash function produces the correct SHA-256 for the empty byte string.
/// **Anti-fake property:** Empty-input hash is a specific 64-char hex value — cannot be faked
/// by returning input length or a constant.
#[test]
fn hash_of_empty_input_matches_sha256_of_empty_string() {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    let input = b"";
    let hex = hash::sha256_hex(input);
    assert_eq!(
        hex, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "SHA-256 of empty input must match the known test vector"
    );
}

/// **Proves:** Hashing the same input twice produces the identical hash (determinism).
/// **Anti-fake property:** If the implementation uses any randomness or timestamp, this fails.
#[test]
fn same_input_produces_same_hash_deterministically() {
    let input = b"determinism check with some payload bytes 12345";
    let hash1 = hash::sha256_hex(input);
    let hash2 = hash::sha256_hex(input);
    assert_eq!(
        hash1, hash2,
        "Hashing identical input must produce identical output"
    );
}

/// **Proves:** Different inputs produce different hashes.
/// **Anti-fake property:** A constant-return implementation would fail this test.
#[test]
fn different_inputs_produce_different_hashes() {
    let input_a = b"request body A";
    let input_b = b"request body B";
    let hash_a = hash::sha256_hex(input_a);
    let hash_b = hash::sha256_hex(input_b);
    assert_ne!(
        hash_a, hash_b,
        "Different inputs must produce different SHA-256 hashes"
    );
}

/// **Proves:** The hash output is always exactly 64 lowercase hex characters.
/// **Anti-fake property:** Validates format — base64, uppercase, or truncated output will fail.
#[test]
fn hash_output_is_64_lowercase_hex_characters() {
    let input = b"format validation test";
    let hex = hash::sha256_hex(input);
    assert_eq!(hex.len(), 64, "SHA-256 hex string must be 64 characters");
    assert!(
        hex.chars()
            .all(|c: char| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
        "Hash must be lowercase hex only, got: {}",
        hex
    );
}

/// **Proves:** The hash function handles large inputs correctly.
/// **Anti-fake property:** Ensures the implementation doesn't truncate or fail on large payloads.
#[test]
fn hash_handles_large_input() {
    // 1 MB of repeated bytes
    let input: Vec<u8> = vec![0xAB; 1_000_000];
    let hex = hash::sha256_hex(&input);
    assert_eq!(
        hex.len(),
        64,
        "Hash of large input must still be 64 hex chars"
    );
    // Re-hash to confirm determinism even for large inputs
    let hex2 = hash::sha256_hex(&input);
    assert_eq!(hex, hex2);
}

/// **Proves:** Hash of JSON-like request body matches a known pre-computed value.
/// **Anti-fake property:** Uses a realistic payload so the hash module is tested with
/// the kind of data it will actually process. The expected hash is independently verified.
#[test]
fn hash_of_json_request_body_matches_precomputed_value() {
    let json_body = br#"{"model":"claude-3-opus","messages":[{"role":"user","content":"Hello"}]}"#;
    let hex = hash::sha256_hex(json_body);
    // Pre-computed: echo -n '{"model":"claude-3-opus","messages":[{"role":"user","content":"Hello"}]}' | sha256sum
    assert_eq!(
        hex,
        // This is the real SHA-256 of the above JSON bytes
        "769546b28fa1ae37d473c7afcec403fe30b29f938a322ea554d70c194c95031d",
        "Hash of JSON body must match independently computed SHA-256"
    );
}
