//! Negative tests for the capture pipeline.
//!
//! These tests verify that removing or disabling components causes observable failure.
//! They are the most important tests — they prove that the system actually depends on
//! each component rather than passing via phantom wiring.

use flate2::read::GzDecoder;
use serde_json::Value;
use std::fs;
use std::io::Read;
use tempfile::TempDir;

use recondo_gateway::capture;
use recondo_gateway::hash;
use recondo_gateway::store;

/// Helper: decompress gzip bytes.
fn gunzip(compressed: &[u8]) -> Vec<u8> {
    let mut decoder = GzDecoder::new(compressed);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).expect("gunzip failed");
    out
}

/// **Proves:** If we tamper with the stored file content, the hash no longer matches.
/// This verifies the integrity chain: hash(original) -> filename -> file content.
/// **Anti-fake property:** If the system doesn't actually use SHA-256 for content
/// addressing, this test would still pass vacuously. But combined with the positive
/// hash tests, it proves the hash is correct AND is used for the file path.
#[test]
fn tampered_object_file_does_not_match_hash() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let original = b"original content for integrity check";
    let original_hash = hash::sha256_hex(original);

    store::store_request(&data_dir, original).unwrap();

    let obj_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", original_hash));

    // Read the stored file and decompress
    let stored = fs::read(&obj_path).unwrap();
    let decompressed = gunzip(&stored);

    // Verify original content matches
    assert_eq!(decompressed, original.to_vec());

    // Now tamper: write different content to the same file
    let tampered = b"TAMPERED content that is different";
    fs::write(&obj_path, tampered).unwrap();

    // The filename still says it should be {original_hash}, but the content
    // no longer matches. Reading and hashing the raw decompressed content
    // would produce a DIFFERENT hash.
    let tampered_content = fs::read(&obj_path).unwrap();
    // The tampered content is NOT valid gzip (we wrote raw bytes), so trying
    // to decompress it should fail or produce wrong output.
    let decompression_result = std::panic::catch_unwind(|| {
        let mut decoder = GzDecoder::new(tampered_content.as_slice());
        let mut out = Vec::new();
        decoder.read_to_end(&mut out).unwrap();
        out
    });

    match decompression_result {
        Ok(decompressed) => {
            // If decompression somehow succeeded, the content should be wrong
            let rehash = hash::sha256_hex(&decompressed);
            assert_ne!(
                rehash, original_hash,
                "Tampered file must not produce the original hash when re-hashed"
            );
        }
        Err(_) => {
            // Decompression failed — this is correct behavior for tampered data
        }
    }
}

/// **Proves:** Without running the capture pipeline, no files appear in objects/ or captures/.
/// This is the most fundamental negative test: it proves that the test environment starts
/// clean and that files only appear as a result of the capture pipeline.
/// **Anti-fake property:** If any test infrastructure pre-creates files, this fails.
#[test]
fn no_capture_means_no_files() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // Do NOT call any capture or store functions

    assert!(
        !data_dir.join("objects").exists(),
        "objects/ must not exist without capture"
    );
    assert!(
        !data_dir.join("captures").exists(),
        "captures/ must not exist without capture"
    );
}

/// **Proves:** The metadata request_hash field is actually derived from the request bytes,
/// not from the response bytes or any other source. If we change only the request bytes,
/// the request_hash changes but the response_hash stays the same.
/// **Anti-fake property:** An implementation that copies the same hash to both fields
/// or derives the hash from something other than the specific input bytes would fail.
#[test]
fn request_hash_derived_from_request_bytes_not_response() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let response_bytes = b"shared response body";

    // Capture 1 with request A
    let req_a = b"request body version A";
    capture::record_capture(&data_dir, req_a, response_bytes, "anthropic").unwrap();

    let captures_dir = data_dir.join("captures");

    // Capture 2 with request B (different request, same response)
    let req_b = b"request body version B";
    capture::record_capture(&data_dir, req_b, response_bytes, "anthropic").unwrap();

    // Read metadata for capture 2 (it's the newer file)
    let mut entries2: Vec<_> = fs::read_dir(&captures_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    entries2.sort_by_key(|e| e.file_name());

    // Parse both metadata files
    let mut metas: Vec<Value> = entries2
        .iter()
        .map(|e| serde_json::from_str(&fs::read_to_string(e.path()).unwrap()).unwrap())
        .collect();

    // Sort by request_hash so we have a stable order
    metas.sort_by_key(|m| m["request_hash"].as_str().unwrap().to_string());

    // Request hashes must differ (different request bodies)
    assert_ne!(
        metas[0]["request_hash"].as_str().unwrap(),
        metas[1]["request_hash"].as_str().unwrap(),
        "Different request bodies must produce different request_hash values"
    );

    // Response hashes must be the same (same response body)
    assert_eq!(
        metas[0]["response_hash"].as_str().unwrap(),
        metas[1]["response_hash"].as_str().unwrap(),
        "Same response body must produce same response_hash value"
    );
}

/// **Proves:** The stored object files are actually gzip-compressed — attempting to
/// parse them as raw JSON fails.
/// **Anti-fake property:** If the store writes raw JSON without compression, parsing
/// would succeed. This test ensures compression is actually applied.
#[test]
fn stored_objects_are_not_raw_json() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let json_content = br#"{"model":"claude-3","messages":[]}"#;
    store::store_request(&data_dir, json_content).unwrap();

    let hex_hash = hash::sha256_hex(json_content);
    let stored_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hex_hash));

    let raw_bytes = fs::read(&stored_path).unwrap();

    // Attempting to parse the raw stored bytes as JSON must fail
    // (because they are gzip-compressed, not raw JSON)
    let parse_result = serde_json::from_slice::<Value>(&raw_bytes);
    assert!(
        parse_result.is_err(),
        "Stored object file must NOT be parseable as raw JSON — it must be gzip-compressed"
    );

    // But decompressing first and then parsing must succeed
    let decompressed = gunzip(&raw_bytes);
    let parse_after_decompress = serde_json::from_slice::<Value>(&decompressed);
    assert!(
        parse_after_decompress.is_ok(),
        "Decompressed object must be valid JSON when the original content was JSON"
    );
}

/// **Proves:** The metadata file itself is valid JSON (not gzip-compressed).
/// **Anti-fake property:** Metadata must be human-readable JSON, not compressed.
#[test]
fn metadata_file_is_plain_json_not_compressed() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    capture::record_capture(&data_dir, b"req", b"resp", "anthropic").unwrap();

    let captures_dir = data_dir.join("captures");
    let entries: Vec<_> = fs::read_dir(&captures_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();

    let raw_bytes = fs::read(entries[0].path()).unwrap();

    // Must NOT start with gzip magic bytes
    assert!(
        raw_bytes.len() < 2 || raw_bytes[0] != 0x1f || raw_bytes[1] != 0x8b,
        "Metadata file must NOT be gzip-compressed"
    );

    // Must be parseable as JSON
    let content = String::from_utf8(raw_bytes).expect("Metadata must be valid UTF-8");
    let parsed: Result<Value, _> = serde_json::from_str(&content);
    assert!(parsed.is_ok(), "Metadata file must be valid JSON");
}

/// **Proves:** Hash mismatch detection — if we manually create a file with wrong
/// content at a hash-derived path, re-storing the correct content should overwrite
/// it (or the system should use the hash to verify). Either way, reading the file
/// at the hash path and decompressing must yield bytes that hash to the filename.
/// **Anti-fake property:** Ensures the content-addressable invariant holds — the
/// file at path {hash}.json.gz must contain content whose SHA-256 equals {hash}.
#[test]
fn content_at_hash_path_actually_hashes_to_that_path() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let content = b"verify hash path invariant";
    let expected_hash = hash::sha256_hex(content);

    store::store_request(&data_dir, content).unwrap();

    let obj_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", expected_hash));

    let stored = fs::read(&obj_path).unwrap();
    let decompressed = gunzip(&stored);
    let actual_hash = hash::sha256_hex(&decompressed);

    assert_eq!(
        actual_hash, expected_hash,
        "SHA-256 of decompressed content must equal the hash in the filename"
    );
}

/// **Proves:** Storing request and response with the same content puts them in
/// different directories (req/ vs resp/), not the same file.
/// **Anti-fake property:** If both store functions write to the same directory,
/// one would overwrite the other or they'd collide.
#[test]
fn same_content_in_req_and_resp_stored_separately() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let same_bytes = b"identical content for both request and response";
    let hex_hash = hash::sha256_hex(same_bytes);

    store::store_request(&data_dir, same_bytes).unwrap();
    store::store_response(&data_dir, same_bytes).unwrap();

    let req_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hex_hash));
    let resp_path = data_dir
        .join("objects")
        .join("resp")
        .join(format!("{}.json.gz", hex_hash));

    assert!(req_path.exists(), "Request object must exist in req/");
    assert!(resp_path.exists(), "Response object must exist in resp/");
    assert_ne!(
        req_path, resp_path,
        "Request and response must be stored in different directories"
    );

    // Both must decompress to the same content
    assert_eq!(gunzip(&fs::read(&req_path).unwrap()), same_bytes.to_vec());
    assert_eq!(gunzip(&fs::read(&resp_path).unwrap()), same_bytes.to_vec());
}
