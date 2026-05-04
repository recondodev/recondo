//! Tests for data schema types (CaptureRecord).
//!
//! These tests verify that the CaptureRecord struct serializes to JSON with
//! all required fields and correct types.

use recondo_gateway::schema::CaptureRecord;

/// **Proves:** CaptureRecord serializes to JSON with all required fields present.
/// **Anti-fake property:** Checks every field name in the serialized output —
/// missing or renamed fields will fail.
#[test]
fn capture_record_serializes_with_all_fields() {
    let record = CaptureRecord {
        timestamp: "2026-03-16T12:00:00Z".to_string(),
        uuid: "550e8400-e29b-41d4-a716-446655440000".to_string(),
        provider: "anthropic".to_string(),
        request_hash: "abc123".to_string(),
        response_hash: "def456".to_string(),
        req_bytes_ref: "objects/req/abc123.json.gz".to_string(),
        resp_bytes_ref: "objects/resp/def456.json.gz".to_string(),
        request_size: 1024,
        response_size: 2048,
    };

    let json = serde_json::to_string(&record).expect("CaptureRecord must serialize to JSON");
    let parsed: serde_json::Value =
        serde_json::from_str(&json).expect("Serialized JSON must be parseable");

    assert_eq!(
        parsed["timestamp"].as_str().unwrap(),
        "2026-03-16T12:00:00Z"
    );
    assert_eq!(
        parsed["uuid"].as_str().unwrap(),
        "550e8400-e29b-41d4-a716-446655440000"
    );
    assert_eq!(parsed["provider"].as_str().unwrap(), "anthropic");
    assert_eq!(parsed["request_hash"].as_str().unwrap(), "abc123");
    assert_eq!(parsed["response_hash"].as_str().unwrap(), "def456");
    assert_eq!(
        parsed["req_bytes_ref"].as_str().unwrap(),
        "objects/req/abc123.json.gz"
    );
    assert_eq!(
        parsed["resp_bytes_ref"].as_str().unwrap(),
        "objects/resp/def456.json.gz"
    );
    assert_eq!(parsed["request_size"].as_u64().unwrap(), 1024);
    assert_eq!(parsed["response_size"].as_u64().unwrap(), 2048);
}

/// **Proves:** CaptureRecord can round-trip through JSON serialization/deserialization.
/// **Anti-fake property:** Both Serialize and Deserialize must be correctly derived.
#[test]
fn capture_record_roundtrips_through_json() {
    let original = CaptureRecord {
        timestamp: "2026-03-16T15:30:00Z".to_string(),
        uuid: "12345678-abcd-efgh-ijkl-123456789012".to_string(),
        provider: "openai".to_string(),
        request_hash: "aabbccdd".to_string(),
        response_hash: "eeff0011".to_string(),
        req_bytes_ref: "objects/req/aabbccdd.json.gz".to_string(),
        resp_bytes_ref: "objects/resp/eeff0011.json.gz".to_string(),
        request_size: 500,
        response_size: 1500,
    };

    let json = serde_json::to_string(&original).unwrap();
    let deserialized: CaptureRecord = serde_json::from_str(&json).unwrap();

    assert_eq!(deserialized.timestamp, original.timestamp);
    assert_eq!(deserialized.uuid, original.uuid);
    assert_eq!(deserialized.provider, original.provider);
    assert_eq!(deserialized.request_hash, original.request_hash);
    assert_eq!(deserialized.response_hash, original.response_hash);
    assert_eq!(deserialized.req_bytes_ref, original.req_bytes_ref);
    assert_eq!(deserialized.resp_bytes_ref, original.resp_bytes_ref);
    assert_eq!(deserialized.request_size, original.request_size);
    assert_eq!(deserialized.response_size, original.response_size);
}

/// **Proves:** CaptureRecord serialization uses snake_case field names (not camelCase).
/// **Anti-fake property:** serde defaults to the Rust field name, but if someone adds
/// `#[serde(rename_all = "camelCase")]`, this test catches it.
#[test]
fn capture_record_uses_snake_case_field_names() {
    let record = CaptureRecord {
        timestamp: "t".to_string(),
        uuid: "u".to_string(),
        provider: "p".to_string(),
        request_hash: "rh".to_string(),
        response_hash: "rsh".to_string(),
        req_bytes_ref: "rbr".to_string(),
        resp_bytes_ref: "rsbr".to_string(),
        request_size: 0,
        response_size: 0,
    };

    let json = serde_json::to_string(&record).unwrap();

    // These snake_case names must appear in the JSON
    assert!(
        json.contains("\"request_hash\""),
        "Must use snake_case: request_hash"
    );
    assert!(
        json.contains("\"response_hash\""),
        "Must use snake_case: response_hash"
    );
    assert!(
        json.contains("\"req_bytes_ref\""),
        "Must use snake_case: req_bytes_ref"
    );
    assert!(
        json.contains("\"resp_bytes_ref\""),
        "Must use snake_case: resp_bytes_ref"
    );
    assert!(
        json.contains("\"request_size\""),
        "Must use snake_case: request_size"
    );
    assert!(
        json.contains("\"response_size\""),
        "Must use snake_case: response_size"
    );

    // These camelCase names must NOT appear
    assert!(!json.contains("\"requestHash\""), "Must not use camelCase");
    assert!(!json.contains("\"responseHash\""), "Must not use camelCase");
    assert!(!json.contains("\"reqBytesRef\""), "Must not use camelCase");
    assert!(!json.contains("\"respBytesRef\""), "Must not use camelCase");
    assert!(!json.contains("\"requestSize\""), "Must not use camelCase");
    assert!(!json.contains("\"responseSize\""), "Must not use camelCase");
}
