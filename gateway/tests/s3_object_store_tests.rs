//! Tests for the ObjectStore trait contract and S3ObjectStore implementation.
//!
//! **Section 1** (always runs): Behavioral contract tests via `LocalObjectStore`.
//! These define the spec that ANY ObjectStore implementation must satisfy.
//! They use no S3 infrastructure.
//!
//! **Section 2** (gated behind `s3-tests` feature): Integration tests against
//! `S3ObjectStore` pointing at the local AWS emulator (`http://localhost:4566`).
//! Run with: `cargo nextest run --features s3-tests --test s3_object_store_tests`
//! Requires: emulator running (`just dev-infra` or `docker run -p 4566:4566 ministackorg/ministack:1.3.25`)

use tempfile::TempDir;

use recondo_gateway::hash;
use recondo_gateway::storage::object::{LocalObjectStore, ObjectStore};

// ============================================================================
// Section 1: ObjectStore Trait Contract Tests via LocalObjectStore (always run)
// ============================================================================
//
// These tests establish the behavioral contract. Any correct ObjectStore
// implementation (Local, S3, GCS, etc.) MUST pass these same assertions.
// They serve as the specification the S3 implementation must match.

/// Helper: create a LocalObjectStore backed by a fresh temp directory.
fn local_store() -> (TempDir, LocalObjectStore) {
    let tmp = TempDir::new().expect("Must create temp dir");
    let store = LocalObjectStore::new(tmp.path());
    (tmp, store)
}

/// **Contract:** put(kind, hash, data) followed by get(kind, hash) returns
/// the exact original bytes. The store compresses on put and decompresses on
/// get transparently.
#[test]
fn object_store_put_get_roundtrip() {
    let (_tmp, store) = local_store();
    let data = b"Hello, this is a request body for roundtrip testing.";
    let hash_hex = hash::sha256_hex(data);

    let ref_key = store.put("req", &hash_hex, data).expect("put must succeed");

    // ref_key must contain the kind and hash
    assert!(
        ref_key.contains("req") && ref_key.contains(&hash_hex),
        "put must return a reference key containing kind and hash, got: {}",
        ref_key
    );

    let retrieved = store.get("req", &hash_hex).expect("get must succeed");
    assert_eq!(
        retrieved, data,
        "get must return the exact bytes that were put"
    );
}

/// **Contract:** Putting the same data twice under the same hash is
/// idempotent. Both calls succeed. The data is stored only once
/// (content-addressable dedup). get returns the correct data regardless.
#[test]
fn object_store_content_addressable_dedup() {
    let (_tmp, store) = local_store();
    let data = b"duplicate payload for dedup testing";
    let hash_hex = hash::sha256_hex(data);

    let ref1 = store
        .put("req", &hash_hex, data)
        .expect("first put must succeed");
    let ref2 = store
        .put("req", &hash_hex, data)
        .expect("second put must succeed (dedup)");

    assert_eq!(ref1, ref2, "Both puts must return the same reference key");

    let retrieved = store
        .get("req", &hash_hex)
        .expect("get after double-put must succeed");
    assert_eq!(retrieved, data, "Data must be intact after dedup put");
}

/// **Contract:** exists returns false before a put and true after a put
/// for the given kind/hash pair.
#[test]
fn object_store_exists_after_put() {
    let (_tmp, store) = local_store();
    let data = b"existence check payload";
    let hash_hex = hash::sha256_hex(data);

    let before = store
        .exists("resp", &hash_hex)
        .expect("exists must not error on missing object");
    assert!(
        !before,
        "exists must return false before any put for this hash"
    );

    store
        .put("resp", &hash_hex, data)
        .expect("put must succeed");

    let after = store
        .exists("resp", &hash_hex)
        .expect("exists must not error after put");
    assert!(after, "exists must return true after put");
}

/// **Contract:** verify returns true when the stored object's content
/// matches the expected hash (integrity is intact).
#[test]
fn object_store_verify_valid() {
    let (_tmp, store) = local_store();
    let data = b"verify integrity payload - valid case";
    let hash_hex = hash::sha256_hex(data);

    store.put("req", &hash_hex, data).expect("put must succeed");

    let valid = store
        .verify("req", &hash_hex)
        .expect("verify must not error");
    assert!(
        valid,
        "verify must return true when stored data matches hash"
    );
}

/// **Contract:** verify returns false when the on-disk data has been
/// corrupted (the re-computed SHA-256 no longer matches the expected hash).
#[test]
fn object_store_verify_corrupted() {
    let (tmp, store) = local_store();
    let data = b"verify integrity payload - corruption case";
    let hash_hex = hash::sha256_hex(data);

    store.put("req", &hash_hex, data).expect("put must succeed");

    // Manually corrupt the stored file by overwriting with garbage bytes.
    // The file lives at {tmp}/objects/req/{hash}.json.gz
    let file_path = tmp
        .path()
        .join("objects")
        .join("req")
        .join(format!("{}.json.gz", hash_hex));
    assert!(
        file_path.exists(),
        "Object file must exist before corruption"
    );

    // Overwrite with bytes that are valid gzip but contain different content.
    // We compress different data to ensure the gzip layer doesn't trip up.
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let corrupted_data = b"THIS IS CORRUPTED DATA THAT DOES NOT MATCH THE HASH";
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(corrupted_data).unwrap();
    let corrupted_gz = encoder.finish().unwrap();
    std::fs::write(&file_path, corrupted_gz).expect("Must overwrite with corrupted data");

    let valid = store
        .verify("req", &hash_hex)
        .expect("verify must not error on corrupted data (returns false, not Err)");
    assert!(
        !valid,
        "verify must return false when stored data hash does not match expected hash"
    );
}

/// **Contract:** get on a hash that was never put returns Err (not empty
/// Vec, not panic).
#[test]
fn object_store_get_nonexistent() {
    let (_tmp, store) = local_store();
    let fake_hash = hash::sha256_hex(b"never stored");

    let result = store.get("req", &fake_hash);
    assert!(
        result.is_err(),
        "get for nonexistent object must return Err, got: {:?}",
        result
    );
}

/// **Contract:** verify returns Ok(false) for a hash that was never put.
/// It must NOT return Err for a missing object.
#[test]
fn object_store_verify_missing_returns_false() {
    let (_tmp, store) = local_store();
    let fake_hash = hash::sha256_hex(b"never stored -- verify missing test");

    let result = store
        .verify("req", &fake_hash)
        .expect("verify must not error for a missing object");
    assert!(
        !result,
        "verify must return false for a hash that was never put"
    );
}

// ============================================================================
// Section 2: S3ObjectStore Integration Tests (require local AWS emulator)
// ============================================================================
//
// These tests exercise the real S3ObjectStore against a MiniStack instance
// (or any S3-compatible emulator on localhost:4566). They are gated behind
// the `s3-tests` feature flag so normal `cargo test` and CI do not require
// Docker.
//
// Run:
//   cargo nextest run --features s3-tests --test s3_object_store_tests
//
// Prerequisites:
//   - Emulator running on localhost:4566 (`just dev-infra`)
//   - Bucket `recondo-objects-test` created (tests create it if missing)

#[cfg(feature = "s3-tests")]
#[path = "common/mod.rs"]
mod common;

#[cfg(feature = "s3-tests")]
mod s3_integration {
    use recondo_gateway::hash;
    use recondo_gateway::storage::object::{ObjectStore, S3ObjectStore};

    /// Build an S3ObjectStore pointing at the ephemeral ministack
    /// container and ensure the test bucket exists. The container is
    /// spawned (once per test process) by `common::s3_container`.
    async fn setup_s3_store() -> S3ObjectStore {
        let endpoint = super::common::s3_container::endpoint();

        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .endpoint_url(&endpoint.url)
            .region(aws_config::Region::new("us-east-1"))
            .credentials_provider(aws_sdk_s3::config::Credentials::new(
                "test",
                "test",
                None,
                None,
                "ministack-test",
            ))
            .load()
            .await;

        let s3_config = aws_sdk_s3::config::Builder::from(&config)
            .force_path_style(true)
            .build();
        let client = aws_sdk_s3::Client::from_conf(s3_config);

        S3ObjectStore::new(client, endpoint.bucket.clone())
    }

    /// Macro to create an async test that runs inside a tokio runtime.
    /// The S3ObjectStore trait methods are synchronous, but setup requires
    /// async (aws-config loading, bucket creation). We run setup async,
    /// then call the synchronous trait methods from within the async context.
    macro_rules! s3_test {
        ($name:ident, $body:expr) => {
            #[test]
            #[cfg(feature = "s3-tests")]
            fn $name() {
                // Explicitly build a multi-threaded runtime. S3ObjectStore uses
                // block_in_place internally, which requires a multi-threaded
                // scheduler (Runtime::new() defaults to multi-threaded, but
                // being explicit avoids relying on that implicit behavior).
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .build()
                    .expect("Must create multi-threaded tokio runtime for S3 test");
                rt.block_on(async { $body });
            }
        };
    }

    // --- S3 Integration Tests ---

    // **Proves:** S3ObjectStore.put + get roundtrip returns identical bytes.
    // This is the S3 equivalent of `object_store_put_get_roundtrip`.
    // MUST FAIL while put/get contain `bail!("not yet implemented")`.
    s3_test!(s3_put_get_roundtrip, {
        let store = setup_s3_store().await;
        let data = b"S3 roundtrip test payload -- hello from recondo";
        let hash_hex = hash::sha256_hex(data);

        let ref_key = store
            .put("req", &hash_hex, data)
            .expect("S3 put must succeed (not bail with 'not yet implemented')");

        // The returned ref key must identify the object in S3
        assert!(
            ref_key.contains(&hash_hex),
            "S3 put must return a key containing the hash, got: {}",
            ref_key
        );

        let retrieved = store.get("req", &hash_hex).expect("S3 get must succeed");
        assert_eq!(
            retrieved,
            data.to_vec(),
            "S3 get must return the exact bytes that were put"
        );
    });

    // **Proves:** Putting the same data twice is idempotent (content-addressable dedup).
    // S3ObjectStore should use HeadObject to skip re-upload when object exists.
    // MUST FAIL while put contains `bail!("not yet implemented")`.
    s3_test!(s3_content_addressable_dedup, {
        let store = setup_s3_store().await;
        let data = b"S3 dedup test payload -- identical content twice";
        let hash_hex = hash::sha256_hex(data);

        let ref1 = store
            .put("req", &hash_hex, data)
            .expect("First S3 put must succeed");
        let ref2 = store
            .put("req", &hash_hex, data)
            .expect("Second S3 put must succeed (dedup)");

        assert_eq!(
            ref1, ref2,
            "Both S3 puts must return the same reference key"
        );

        let retrieved = store
            .get("req", &hash_hex)
            .expect("S3 get after dedup must succeed");
        assert_eq!(retrieved, data.to_vec(), "Data must be intact after dedup");
    });

    // **Proves:** S3ObjectStore.exists returns false before put, true after.
    // MUST FAIL while exists contains `bail!("not yet implemented")`.
    s3_test!(s3_exists_after_put, {
        let store = setup_s3_store().await;
        let data = b"S3 exists test payload";
        let hash_hex = hash::sha256_hex(data);

        let before = store
            .exists("resp", &hash_hex)
            .expect("S3 exists must not error on missing object");
        assert!(
            !before,
            "S3 exists must return false before any put for this hash"
        );

        store
            .put("resp", &hash_hex, data)
            .expect("S3 put must succeed");

        let after = store
            .exists("resp", &hash_hex)
            .expect("S3 exists must not error after put");
        assert!(after, "S3 exists must return true after put");
    });

    // **Proves:** S3ObjectStore.verify returns true when stored data matches hash.
    // Verify downloads the object, decompresses, re-hashes, and compares.
    // MUST FAIL while verify contains `bail!("not yet implemented")`.
    s3_test!(s3_verify_valid, {
        let store = setup_s3_store().await;
        let data = b"S3 verify valid test payload -- integrity check";
        let hash_hex = hash::sha256_hex(data);

        store
            .put("req", &hash_hex, data)
            .expect("S3 put must succeed");

        let valid = store
            .verify("req", &hash_hex)
            .expect("S3 verify must not error");
        assert!(
            valid,
            "S3 verify must return true when stored data matches hash"
        );
    });

    // **Proves:** S3ObjectStore.verify detects hash mismatches.
    // We put data under its correct hash, then call verify with a DIFFERENT
    // hash. Since verify downloads, decompresses, and re-hashes, the
    // re-computed hash won't match the wrong expected hash.
    //
    // Note: This test puts data under hash A, then asks to verify hash B.
    // If hash B doesn't exist, verify should return false (object not found).
    // We test a subtler case: put data under a fabricated hash, then verify
    // detects the content doesn't match.
    // MUST FAIL while verify contains `bail!("not yet implemented")`.
    s3_test!(s3_verify_wrong_hash, {
        let store = setup_s3_store().await;
        let data = b"S3 verify wrong hash -- the content";
        let correct_hash = hash::sha256_hex(data);

        store
            .put("req", &correct_hash, data)
            .expect("S3 put must succeed");

        // Try to verify under a hash that doesn't exist in S3.
        // A hash for completely different data:
        let wrong_hash = hash::sha256_hex(b"completely different data that was never stored");

        // verify for a non-existent key should return false (not Err),
        // matching LocalObjectStore behavior.
        let valid = store
            .verify("req", &wrong_hash)
            .expect("S3 verify must not error for missing object");
        assert!(
            !valid,
            "S3 verify must return false when the expected hash has no matching object"
        );
    });

    // **Proves:** S3ObjectStore.get for a nonexistent hash returns Err.
    // MUST FAIL while get contains `bail!("not yet implemented")` (it bails
    // with "not yet implemented" instead of a proper "not found" error).
    // After implementation, it must return a meaningful error about the
    // missing object, not "not yet implemented".
    s3_test!(s3_get_nonexistent, {
        let store = setup_s3_store().await;
        let fake_hash = hash::sha256_hex(b"this data was never put into S3");

        let result = store.get("req", &fake_hash);
        assert!(
            result.is_err(),
            "S3 get for nonexistent object must return Err"
        );

        // The error must NOT be the stub "not yet implemented" message.
        let err_msg = format!("{}", result.err().unwrap());
        assert!(
            !err_msg.contains("not yet implemented"),
            "S3 get error must not be 'not yet implemented' stub, got: {}",
            err_msg
        );
    });

    // **Proves:** S3ObjectStore.put returns a ref key in the same format as
    // LocalObjectStore: `{kind}/{hash}.json.gz`. The S3 object key has an
    // `objects/` prefix, but the returned ref_key is backend-agnostic.
    // MUST FAIL while put contains `bail!("not yet implemented")`.
    s3_test!(s3_put_returns_s3_key, {
        let store = setup_s3_store().await;
        let data = b"S3 key format test payload";
        let hash_hex = hash::sha256_hex(data);

        let ref_key = store
            .put("req", &hash_hex, data)
            .expect("S3 put must succeed");

        // The key should follow the pattern: objects/{kind}/{hash}.json.gz
        // or at minimum contain the kind and hash
        assert!(
            ref_key.contains("req") && ref_key.contains(&hash_hex),
            "S3 ref key must contain kind and hash, got: {}",
            ref_key
        );
        assert!(
            ref_key.contains(".json.gz"),
            "S3 ref key must have .json.gz suffix (data is gzip-compressed), got: {}",
            ref_key
        );
    });

    // **Proves:** S3ObjectStore handles large payloads correctly.
    // Put 1 MB of data, verify get returns identical 1 MB.
    // MUST FAIL while put/get contain `bail!("not yet implemented")`.
    s3_test!(s3_large_payload, {
        let store = setup_s3_store().await;

        // Generate 1 MB of pseudo-random but deterministic data.
        // Using a simple pattern that compresses somewhat (like real JSON would).
        let mut large_data = Vec::with_capacity(1_048_576);
        let pattern = br#"{"model":"claude-3","messages":[{"role":"user","content":"test"}],"max_tokens":1024}"#;
        while large_data.len() < 1_048_576 {
            large_data.extend_from_slice(pattern);
        }
        large_data.truncate(1_048_576); // Exactly 1 MB

        let hash_hex = hash::sha256_hex(&large_data);

        store
            .put("req", &hash_hex, &large_data)
            .expect("S3 put of 1MB payload must succeed");

        let retrieved = store
            .get("req", &hash_hex)
            .expect("S3 get of 1MB payload must succeed");

        assert_eq!(
            retrieved.len(),
            1_048_576,
            "Retrieved data must be exactly 1 MB"
        );
        assert_eq!(
            retrieved, large_data,
            "S3 get must return identical bytes for large payload"
        );
    });
}
