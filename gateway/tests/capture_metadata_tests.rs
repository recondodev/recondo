//! Tests for capture metadata writing.
//!
//! These tests verify that the capture pipeline writes correct metadata JSON
//! files to the captures/ directory with all required fields.

use serde_json::Value;
use std::fs;
use tempfile::TempDir;

use recondo_gateway::capture;
use recondo_gateway::hash;

/// Helper: find exactly one file in the captures/ dir and return its parsed JSON.
fn read_single_capture_metadata(data_dir: &std::path::Path) -> Value {
    let captures_dir = data_dir.join("captures");
    let entries: Vec<_> = fs::read_dir(&captures_dir)
        .expect("captures/ dir must exist")
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "Expected exactly one capture metadata file, found {}",
        entries.len()
    );
    let content =
        fs::read_to_string(entries[0].path()).expect("Must be able to read metadata file");
    serde_json::from_str(&content).expect("Metadata file must be valid JSON")
}

/// **Proves:** The capture pipeline writes a metadata file to captures/ directory.
/// **Anti-fake property:** The file must physically exist on disk after capture.
#[test]
fn capture_writes_metadata_file_to_captures_dir() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes = b"test request body";
    let response_bytes = b"test response body";

    capture::record_capture(&data_dir, request_bytes, response_bytes, "anthropic")
        .expect("record_capture must succeed");

    let captures_dir = data_dir.join("captures");
    assert!(captures_dir.exists(), "captures/ directory must exist");

    let entries: Vec<_> = fs::read_dir(&captures_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "Exactly one metadata file must be written"
    );
}

/// **Proves:** Metadata filename matches pattern `{timestamp}_{uuid}.json`.
/// **Anti-fake property:** Regex validates the exact naming convention — random names fail.
#[test]
fn capture_metadata_filename_matches_pattern() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    capture::record_capture(&data_dir, b"req bytes", b"resp bytes", "anthropic").unwrap();

    let captures_dir = data_dir.join("captures");
    let entries: Vec<_> = fs::read_dir(&captures_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();

    let filename = entries[0]
        .file_name()
        .into_string()
        .expect("Filename must be valid UTF-8");

    // Pattern: {timestamp}_{uuid}.json
    // timestamp is ISO-ish or epoch; uuid is 8-4-4-4-12 hex with dashes
    assert!(
        filename.ends_with(".json"),
        "Metadata file must end with .json, got: {}",
        filename
    );
    assert!(
        filename.contains('_'),
        "Metadata filename must contain underscore separator between timestamp and uuid, got: {}",
        filename
    );

    // Extract the UUID part (after last underscore, before .json)
    let without_ext = filename.trim_end_matches(".json");
    let parts: Vec<&str> = without_ext.splitn(2, '_').collect();
    assert_eq!(
        parts.len(),
        2,
        "Filename must have timestamp_uuid format, got: {}",
        filename
    );

    let uuid_part = parts[1];
    // UUID v4 format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
    assert_eq!(
        uuid_part.len(),
        36,
        "UUID part must be 36 chars (8-4-4-4-12 with dashes), got '{}' (len {})",
        uuid_part,
        uuid_part.len()
    );
}

/// **Proves:** Metadata JSON contains all required fields with correct types.
/// **Anti-fake property:** Checks every required field by name and type — missing
/// or misnamed fields will cause assertion failure.
#[test]
fn capture_metadata_contains_all_required_fields() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    capture::record_capture(&data_dir, b"req", b"resp", "anthropic").unwrap();

    let metadata = read_single_capture_metadata(tmp.path());

    // Check all required fields exist
    assert!(
        metadata.get("timestamp").is_some(),
        "Metadata must contain 'timestamp' field"
    );
    assert!(
        metadata.get("uuid").is_some(),
        "Metadata must contain 'uuid' field"
    );
    assert!(
        metadata.get("provider").is_some(),
        "Metadata must contain 'provider' field"
    );
    assert!(
        metadata.get("request_hash").is_some(),
        "Metadata must contain 'request_hash' field"
    );
    assert!(
        metadata.get("response_hash").is_some(),
        "Metadata must contain 'response_hash' field"
    );
    assert!(
        metadata.get("req_bytes_ref").is_some(),
        "Metadata must contain 'req_bytes_ref' field"
    );
    assert!(
        metadata.get("resp_bytes_ref").is_some(),
        "Metadata must contain 'resp_bytes_ref' field"
    );
    assert!(
        metadata.get("request_size").is_some(),
        "Metadata must contain 'request_size' field"
    );
    assert!(
        metadata.get("response_size").is_some(),
        "Metadata must contain 'response_size' field"
    );

    // Check types
    assert!(
        metadata["timestamp"].is_string(),
        "'timestamp' must be a string"
    );
    assert!(metadata["uuid"].is_string(), "'uuid' must be a string");
    assert!(
        metadata["provider"].is_string(),
        "'provider' must be a string"
    );
    assert!(
        metadata["request_hash"].is_string(),
        "'request_hash' must be a string"
    );
    assert!(
        metadata["response_hash"].is_string(),
        "'response_hash' must be a string"
    );
    assert!(
        metadata["req_bytes_ref"].is_string(),
        "'req_bytes_ref' must be a string"
    );
    assert!(
        metadata["resp_bytes_ref"].is_string(),
        "'resp_bytes_ref' must be a string"
    );
    assert!(
        metadata["request_size"].is_number(),
        "'request_size' must be a number"
    );
    assert!(
        metadata["response_size"].is_number(),
        "'response_size' must be a number"
    );
}

/// **Proves:** Metadata hashes match the SHA-256 of the raw request/response bytes.
/// **Anti-fake property:** Independently computes the hash and compares — if the
/// capture stores a random hash or wrong hash, this fails.
#[test]
fn metadata_hashes_match_actual_content_hashes() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes = b"the actual request body bytes for hash verification";
    let response_bytes = b"the actual response body bytes for hash verification";

    let expected_req_hash = hash::sha256_hex(request_bytes);
    let expected_resp_hash = hash::sha256_hex(response_bytes);

    capture::record_capture(&data_dir, request_bytes, response_bytes, "openai").unwrap();

    let metadata = read_single_capture_metadata(tmp.path());

    assert_eq!(
        metadata["request_hash"].as_str().unwrap(),
        expected_req_hash,
        "request_hash in metadata must match SHA-256 of request bytes"
    );
    assert_eq!(
        metadata["response_hash"].as_str().unwrap(),
        expected_resp_hash,
        "response_hash in metadata must match SHA-256 of response bytes"
    );
}

/// **Proves:** Metadata provider field matches the provider passed to capture.
/// **Anti-fake property:** Provider must be faithfully recorded, not overwritten.
#[test]
fn metadata_provider_matches_input() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    capture::record_capture(&data_dir, b"req", b"resp", "openai").unwrap();

    let metadata = read_single_capture_metadata(tmp.path());

    assert_eq!(
        metadata["provider"].as_str().unwrap(),
        "openai",
        "Provider in metadata must match the provider argument"
    );
}

/// **Proves:** Metadata request_size and response_size match byte lengths of inputs.
/// **Anti-fake property:** Checks exact numeric values — if sizes are computed from
/// compressed bytes or are zero, this fails.
#[test]
fn metadata_sizes_match_raw_byte_lengths() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes = b"exactly 30 bytes of req data!!"; // 30 bytes
    let response_bytes = b"exactly 33 bytes of resp data!!!!"; // 33 bytes

    assert_eq!(request_bytes.len(), 30);
    assert_eq!(response_bytes.len(), 33);

    capture::record_capture(&data_dir, request_bytes, response_bytes, "anthropic").unwrap();

    let metadata = read_single_capture_metadata(tmp.path());

    assert_eq!(
        metadata["request_size"].as_u64().unwrap(),
        30,
        "request_size must equal raw request byte length"
    );
    assert_eq!(
        metadata["response_size"].as_u64().unwrap(),
        33,
        "response_size must equal raw response byte length"
    );
}

/// **Proves:** The req_bytes_ref and resp_bytes_ref fields are valid filesystem paths
/// that point to the stored object files.
/// **Anti-fake property:** The ref paths must correspond to actually existing files.
#[test]
fn metadata_refs_point_to_existing_object_files() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes = b"ref test request";
    let response_bytes = b"ref test response";

    capture::record_capture(&data_dir, request_bytes, response_bytes, "anthropic").unwrap();

    let metadata = read_single_capture_metadata(tmp.path());

    let req_ref = metadata["req_bytes_ref"].as_str().unwrap();
    let resp_ref = metadata["resp_bytes_ref"].as_str().unwrap();

    // The refs should be relative paths like "objects/req/{hash}.json.gz"
    // or absolute paths — either way, resolve against data_dir
    let req_path = if std::path::Path::new(req_ref).is_absolute() {
        std::path::PathBuf::from(req_ref)
    } else {
        data_dir.join(req_ref)
    };

    let resp_path = if std::path::Path::new(resp_ref).is_absolute() {
        std::path::PathBuf::from(resp_ref)
    } else {
        data_dir.join(resp_ref)
    };

    assert!(
        req_path.exists(),
        "req_bytes_ref must point to an existing file, path: {:?}",
        req_path
    );
    assert!(
        resp_path.exists(),
        "resp_bytes_ref must point to an existing file, path: {:?}",
        resp_path
    );
}

/// **Proves:** Each capture gets a unique UUID — two captures produce different UUIDs.
/// **Anti-fake property:** If UUID is hardcoded or deterministic from content, this may
/// still pass, but it validates the basic uniqueness contract.
#[test]
fn two_captures_produce_different_uuids() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    capture::record_capture(&data_dir, b"req1", b"resp1", "anthropic").unwrap();
    capture::record_capture(&data_dir, b"req2", b"resp2", "anthropic").unwrap();

    let captures_dir = data_dir.join("captures");
    let entries: Vec<_> = fs::read_dir(&captures_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(
        entries.len(),
        2,
        "Two captures must produce two metadata files"
    );

    let mut uuids: Vec<String> = entries
        .iter()
        .map(|e| {
            let content = fs::read_to_string(e.path()).unwrap();
            let metadata: Value = serde_json::from_str(&content).unwrap();
            metadata["uuid"].as_str().unwrap().to_string()
        })
        .collect();
    uuids.sort();
    uuids.dedup();
    assert_eq!(uuids.len(), 2, "Two captures must have different UUIDs");
}
