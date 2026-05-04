//! End-to-end capture pipeline tests.
//!
//! These tests verify the full capture flow: given raw request and response bytes,
//! the pipeline produces correct hash files, correct metadata, and all cross-references
//! are consistent.

use flate2::read::GzDecoder;
use serde_json::Value;
use std::fs;
use std::io::Read;
use tempfile::TempDir;

use recondo_gateway::capture;
use recondo_gateway::hash;

/// Helper: decompress gzip bytes.
fn gunzip(compressed: &[u8]) -> Vec<u8> {
    let mut decoder = GzDecoder::new(compressed);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).expect("gunzip failed");
    out
}

/// Helper: read the single metadata file from captures/ and return parsed JSON.
fn read_capture_metadata(data_dir: &std::path::Path) -> Value {
    let captures_dir = data_dir.join("captures");
    let entries: Vec<_> = fs::read_dir(&captures_dir)
        .expect("captures/ must exist")
        .filter_map(|e| e.ok())
        .collect();
    assert!(
        !entries.is_empty(),
        "At least one capture metadata file must exist"
    );
    let content = fs::read_to_string(entries[0].path()).unwrap();
    serde_json::from_str(&content).unwrap()
}

/// **Proves:** The full pipeline produces request objects, response objects, and metadata
/// with consistent cross-references.
/// **Anti-fake property:** Verifies the entire chain: content -> hash -> file on disk ->
/// metadata refs -> file exists -> decompress -> matches original. A partial implementation
/// cannot pass all these checks.
#[test]
fn full_pipeline_produces_consistent_objects_and_metadata() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes =
        br#"{"model":"claude-3-opus","messages":[{"role":"user","content":"What is 2+2?"}]}"#;
    let response_bytes =
        br#"{"id":"msg_abc123","type":"message","content":[{"type":"text","text":"4"}]}"#;

    let expected_req_hash = hash::sha256_hex(request_bytes);
    let expected_resp_hash = hash::sha256_hex(response_bytes);

    capture::record_capture(&data_dir, request_bytes, response_bytes, "anthropic")
        .expect("Full pipeline must succeed");

    // 1. Verify request object exists at correct path
    let req_object_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", expected_req_hash));
    assert!(
        req_object_path.exists(),
        "Request object must exist at {:?}",
        req_object_path
    );

    // 2. Verify response object exists at correct path
    let resp_object_path = data_dir
        .join("objects")
        .join("resp")
        .join(format!("{}.json.gz", expected_resp_hash));
    assert!(
        resp_object_path.exists(),
        "Response object must exist at {:?}",
        resp_object_path
    );

    // 3. Verify request object decompresses to original
    let req_compressed = fs::read(&req_object_path).unwrap();
    let req_decompressed = gunzip(&req_compressed);
    assert_eq!(
        req_decompressed,
        request_bytes.to_vec(),
        "Request object must decompress to original request bytes"
    );

    // 4. Verify response object decompresses to original
    let resp_compressed = fs::read(&resp_object_path).unwrap();
    let resp_decompressed = gunzip(&resp_compressed);
    assert_eq!(
        resp_decompressed,
        response_bytes.to_vec(),
        "Response object must decompress to original response bytes"
    );

    // 5. Verify metadata exists and references match
    let metadata = read_capture_metadata(tmp.path());
    assert_eq!(
        metadata["request_hash"].as_str().unwrap(),
        expected_req_hash
    );
    assert_eq!(
        metadata["response_hash"].as_str().unwrap(),
        expected_resp_hash
    );
    assert_eq!(metadata["provider"].as_str().unwrap(), "anthropic");
    assert_eq!(
        metadata["request_size"].as_u64().unwrap(),
        request_bytes.len() as u64
    );
    assert_eq!(
        metadata["response_size"].as_u64().unwrap(),
        response_bytes.len() as u64
    );

    // 6. Verify metadata refs resolve to the object files
    let req_ref = metadata["req_bytes_ref"].as_str().unwrap();
    let resp_ref = metadata["resp_bytes_ref"].as_str().unwrap();

    let resolved_req = if std::path::Path::new(req_ref).is_absolute() {
        std::path::PathBuf::from(req_ref)
    } else {
        data_dir.join(req_ref)
    };
    let resolved_resp = if std::path::Path::new(resp_ref).is_absolute() {
        std::path::PathBuf::from(resp_ref)
    } else {
        data_dir.join(resp_ref)
    };

    assert!(
        resolved_req.exists(),
        "req_bytes_ref must resolve to existing file"
    );
    assert!(
        resolved_resp.exists(),
        "resp_bytes_ref must resolve to existing file"
    );
}

/// **Proves:** Multiple captures with different content produce separate metadata files
/// and separate object files.
/// **Anti-fake property:** Verifies isolation between captures — one capture cannot
/// overwrite another's data.
#[test]
fn multiple_captures_produce_isolated_artifacts() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let req1 = b"first request body";
    let resp1 = b"first response body";
    let req2 = b"second request body";
    let resp2 = b"second response body";

    capture::record_capture(&data_dir, req1, resp1, "anthropic").unwrap();
    capture::record_capture(&data_dir, req2, resp2, "openai").unwrap();

    // Should have 2 metadata files
    let captures_dir = data_dir.join("captures");
    let metadata_count = fs::read_dir(&captures_dir).unwrap().count();
    assert_eq!(
        metadata_count, 2,
        "Must have 2 metadata files for 2 captures"
    );

    // Should have 2 request objects
    let req_dir = data_dir.join("objects").join("req");
    let req_count = fs::read_dir(&req_dir).unwrap().count();
    assert_eq!(req_count, 2, "Must have 2 request object files");

    // Should have 2 response objects
    let resp_dir = data_dir.join("objects").join("resp");
    let resp_count = fs::read_dir(&resp_dir).unwrap().count();
    assert_eq!(resp_count, 2, "Must have 2 response object files");

    // Verify both objects decompress correctly
    let hash1 = hash::sha256_hex(req1);
    let hash2 = hash::sha256_hex(req2);

    let path1 = req_dir.join(format!("{}.json.gz", hash1));
    let path2 = req_dir.join(format!("{}.json.gz", hash2));

    assert_eq!(gunzip(&fs::read(&path1).unwrap()), req1.to_vec());
    assert_eq!(gunzip(&fs::read(&path2).unwrap()), req2.to_vec());
}

/// **Proves:** Content-addressable deduplication across captures: if two captures
/// share the same request body, only one request object file is created.
/// **Anti-fake property:** The second capture must not create a duplicate file.
/// Both metadata files must reference the same hash.
#[test]
fn duplicate_request_body_deduplicates_object_file() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let shared_request = b"identical request body in two captures";
    let resp1 = b"response one";
    let resp2 = b"response two";

    capture::record_capture(&data_dir, shared_request, resp1, "anthropic").unwrap();
    capture::record_capture(&data_dir, shared_request, resp2, "anthropic").unwrap();

    // Should have only 1 request object (content-addressable dedup)
    let req_dir = data_dir.join("objects").join("req");
    let req_count = fs::read_dir(&req_dir).unwrap().count();
    assert_eq!(
        req_count, 1,
        "Identical request bodies must result in only 1 object file"
    );

    // But 2 response objects (different content)
    let resp_dir = data_dir.join("objects").join("resp");
    let resp_count = fs::read_dir(&resp_dir).unwrap().count();
    assert_eq!(
        resp_count, 2,
        "Different response bodies must produce 2 object files"
    );

    // And 2 metadata files
    let captures_dir = data_dir.join("captures");
    let metadata_count = fs::read_dir(&captures_dir).unwrap().count();
    assert_eq!(
        metadata_count, 2,
        "Two captures must always produce 2 metadata files"
    );

    // Both metadata files should reference the same request hash
    let mut request_hashes: Vec<String> = Vec::new();
    for entry in fs::read_dir(&captures_dir).unwrap() {
        let entry = entry.unwrap();
        let content = fs::read_to_string(entry.path()).unwrap();
        let metadata: Value = serde_json::from_str(&content).unwrap();
        request_hashes.push(metadata["request_hash"].as_str().unwrap().to_string());
    }
    assert_eq!(
        request_hashes[0], request_hashes[1],
        "Both captures must reference the same request hash"
    );
    assert_eq!(
        request_hashes[0],
        hash::sha256_hex(shared_request),
        "Request hash must match SHA-256 of the shared request body"
    );
}

/// **Proves:** The pipeline handles empty request/response bodies without panicking
/// and produces correct metadata.
/// **Anti-fake property:** Edge case — empty bodies have specific SHA-256 hashes
/// (the well-known empty-string hash). Sizes must be 0.
#[test]
fn pipeline_handles_empty_bodies() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let empty = b"";
    let empty_hash = hash::sha256_hex(empty);

    capture::record_capture(&data_dir, empty, empty, "unknown").unwrap();

    let metadata = read_capture_metadata(tmp.path());
    assert_eq!(metadata["request_hash"].as_str().unwrap(), empty_hash);
    assert_eq!(metadata["response_hash"].as_str().unwrap(), empty_hash);
    assert_eq!(metadata["request_size"].as_u64().unwrap(), 0);
    assert_eq!(metadata["response_size"].as_u64().unwrap(), 0);

    // Object file should still exist and decompress to empty
    let obj_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", empty_hash));
    assert!(obj_path.exists());
    let decompressed = gunzip(&fs::read(&obj_path).unwrap());
    assert!(
        decompressed.is_empty(),
        "Decompressed empty body must be empty"
    );
}

/// **Proves:** The pipeline handles large payloads (simulating real LLM traffic).
/// **Anti-fake property:** A 100KB payload must round-trip correctly — truncation
/// or buffer overflow would cause a mismatch.
#[test]
fn pipeline_handles_large_payload() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // Simulate a large request (100KB of JSON-like content)
    let large_request: Vec<u8> = std::iter::repeat_n(b"content ", 12_500)
        .flatten()
        .copied()
        .collect();
    assert_eq!(large_request.len(), 100_000);

    let response = b"short response";

    capture::record_capture(&data_dir, &large_request, response, "anthropic").unwrap();

    // Verify round-trip
    let req_hash = hash::sha256_hex(&large_request);
    let req_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", req_hash));
    let decompressed = gunzip(&fs::read(&req_path).unwrap());
    assert_eq!(
        decompressed.len(),
        100_000,
        "Decompressed large payload must match original size"
    );
    assert_eq!(
        decompressed, large_request,
        "Decompressed large payload must match original bytes"
    );

    let metadata = read_capture_metadata(tmp.path());
    assert_eq!(metadata["request_size"].as_u64().unwrap(), 100_000);
}
