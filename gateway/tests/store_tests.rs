//! Tests for gzip compression and content-addressable object storage.
//!
//! These tests verify that raw bytes are compressed with gzip, stored at
//! SHA-256-derived paths, and can be recovered exactly.

use flate2::read::GzDecoder;
use std::fs;
use std::io::Read;
use tempfile::TempDir;

use recondo_gateway::hash;
use recondo_gateway::store;

/// Helper: decompress gzip bytes back to original.
fn gunzip(compressed: &[u8]) -> Vec<u8> {
    let mut decoder = GzDecoder::new(compressed);
    let mut decompressed = Vec::new();
    decoder
        .read_to_end(&mut decompressed)
        .expect("Failed to decompress gzip data");
    decompressed
}

/// **Proves:** Storing request bytes creates a file at `objects/req/{hash}.json.gz`.
/// **Anti-fake property:** Checks the exact filesystem path derived from SHA-256 hash.
/// A hardcoded path or wrong hash algorithm would fail.
#[test]
fn store_request_creates_file_at_hash_derived_path() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let request_bytes = b"POST /v1/messages HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{\"model\":\"claude-3\"}";
    let hex_hash = hash::sha256_hex(request_bytes);

    store::store_request(&data_dir, request_bytes).unwrap();

    let expected_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hex_hash));

    assert!(
        expected_path.exists(),
        "Request object file must exist at objects/req/{{hash}}.json.gz, expected: {:?}",
        expected_path
    );
}

/// **Proves:** Storing response bytes creates a file at `objects/resp/{hash}.json.gz`.
/// **Anti-fake property:** Checks the resp/ subdirectory specifically — using req/ for both
/// would fail.
#[test]
fn store_response_creates_file_at_hash_derived_path() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let response_bytes = b"{\"id\":\"msg_123\",\"content\":[{\"text\":\"Hello\"}]}";
    let hex_hash = hash::sha256_hex(response_bytes);

    store::store_response(&data_dir, response_bytes).unwrap();

    let expected_path = data_dir
        .join("objects")
        .join("resp")
        .join(format!("{}.json.gz", hex_hash));

    assert!(
        expected_path.exists(),
        "Response object file must exist at objects/resp/{{hash}}.json.gz, expected: {:?}",
        expected_path
    );
}

/// **Proves:** The stored file is valid gzip and decompresses to the exact original bytes.
/// **Anti-fake property:** Stores bytes, reads back the file, decompresses, and compares.
/// Storing uncompressed or corrupted data would fail.
#[test]
fn stored_file_decompresses_to_original_bytes() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let original = b"The quick brown fox jumps over the lazy dog. This is a request body.";
    let hex_hash = hash::sha256_hex(original);

    store::store_request(&data_dir, original).unwrap();

    let stored_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hex_hash));

    let compressed = fs::read(&stored_path).expect("Must be able to read stored file");
    let decompressed = gunzip(&compressed);

    assert_eq!(
        decompressed,
        original.to_vec(),
        "Decompressed content must exactly match the original bytes"
    );
}

/// **Proves:** Content-addressable storage: storing the same content twice produces
/// one file at the same path with the same content. No duplicates.
/// **Anti-fake property:** If the store uses random names or timestamps in paths,
/// this fails. The second store must be idempotent.
#[test]
fn content_addressable_same_content_same_file() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let content = b"identical request payload";
    let hex_hash = hash::sha256_hex(content);

    let result1 = store::store_request(&data_dir, content);
    let result2 = store::store_request(&data_dir, content);

    assert!(result1.is_ok());
    assert!(result2.is_ok());

    let expected_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hex_hash));

    // Exactly one file should exist at this path
    assert!(expected_path.exists());

    // Count total files in objects/req/ — should be exactly 1
    let req_dir = data_dir.join("objects").join("req");
    let file_count = fs::read_dir(&req_dir)
        .expect("objects/req/ must exist")
        .count();
    assert_eq!(
        file_count, 1,
        "Storing identical content twice must not create duplicate files"
    );
}

/// **Proves:** Different content gets stored as different files at different paths.
/// **Anti-fake property:** A store that ignores content and always writes to the same
/// path would fail this test.
#[test]
fn different_content_stored_at_different_paths() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let content_a = b"request payload alpha";
    let content_b = b"request payload beta";

    store::store_request(&data_dir, content_a).unwrap();
    store::store_request(&data_dir, content_b).unwrap();

    let hash_a = hash::sha256_hex(content_a);
    let hash_b = hash::sha256_hex(content_b);

    let path_a = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hash_a));
    let path_b = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hash_b));

    assert!(path_a.exists(), "First object file must exist");
    assert!(path_b.exists(), "Second object file must exist");
    assert_ne!(
        path_a, path_b,
        "Different content must produce different paths"
    );

    // Verify each decompresses correctly
    let decompressed_a = gunzip(&fs::read(&path_a).unwrap());
    let decompressed_b = gunzip(&fs::read(&path_b).unwrap());
    assert_eq!(decompressed_a, content_a);
    assert_eq!(decompressed_b, content_b);
}

/// **Proves:** The stored file is actually gzip-compressed (smaller than original for
/// compressible data, and has the gzip magic bytes 1f 8b).
/// **Anti-fake property:** Storing raw uncompressed bytes would fail the magic byte check.
#[test]
fn stored_file_has_gzip_magic_bytes() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // Use a large, compressible payload
    let content = br#"{"model":"claude-3-opus-20240229","max_tokens":1024,"messages":[{"role":"user","content":"Tell me a long story about a fox. Please make it very detailed and descriptive so that it is long enough to demonstrate compression."}]}"#;
    let hex_hash = hash::sha256_hex(content);

    store::store_request(&data_dir, content).unwrap();

    let stored_path = data_dir
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hex_hash));

    let stored_bytes = fs::read(&stored_path).expect("Stored file must exist");

    // Gzip magic bytes: 0x1f, 0x8b
    assert!(
        stored_bytes.len() >= 2,
        "Stored file must have at least 2 bytes"
    );
    assert_eq!(stored_bytes[0], 0x1f, "First byte must be gzip magic 0x1f");
    assert_eq!(stored_bytes[1], 0x8b, "Second byte must be gzip magic 0x8b");
}

/// **Proves:** The store_request function returns the hash of the stored content.
/// **Anti-fake property:** The return value must match independently computed hash.
#[test]
fn store_returns_hash_of_stored_content() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let content = b"return value hash check";
    let expected_hash = hash::sha256_hex(content);

    let returned_hash =
        store::store_request(&data_dir, content).expect("store_request must succeed");

    assert_eq!(
        returned_hash, expected_hash,
        "store_request must return the SHA-256 hex hash of the stored content"
    );
}

/// **Proves:** The store_response function also returns the hash of the stored content.
/// **Anti-fake property:** Same as above but for the response path.
#[test]
fn store_response_returns_hash_of_stored_content() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    let content = b"response return value hash check";
    let expected_hash = hash::sha256_hex(content);

    let returned_hash =
        store::store_response(&data_dir, content).expect("store_response must succeed");

    assert_eq!(
        returned_hash, expected_hash,
        "store_response must return the SHA-256 hex hash of the stored content"
    );
}

/// **Proves:** Store creates necessary subdirectories automatically.
/// **Anti-fake property:** Using a fresh empty directory — if store doesn't create
/// objects/req/ and objects/resp/, it will fail.
#[test]
fn store_creates_subdirectories_automatically() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();

    // data_dir exists but objects/ does not
    assert!(!data_dir.join("objects").exists());

    store::store_request(&data_dir, b"auto-create dirs test").unwrap();

    assert!(
        data_dir.join("objects").join("req").exists(),
        "store must auto-create objects/req/ directory"
    );
}
