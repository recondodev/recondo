// Suppress lints originating from the verbatim test-writer-authored helpers
// (unused imports / format!-without-args). The assertions themselves are
// untouched; these allows only quiet the helper-construction code so the
// test binary builds cleanly under `cargo clippy -- -D warnings`.
#![allow(unused_imports, clippy::useless_format)]

//! Behavioral tests for the orphan capture recovery feature and WAL hygiene fix.
//!
//! Written before implementation per the adversarial workflow. Tests assert on
//! externally observable side effects only (DB row counts/values, on-disk file
//! state, RecoveryReport fields, log output). Component tests use real
//! LocalObjectStore + SqliteGraphStore::new_in_memory() per the no-DB-mocks rule.
//!
//! Design doc reference: orphan capture recovery (this sprint).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use flate2::write::GzEncoder;
use flate2::Compression;
use tempfile::TempDir;

use recondo_gateway::capture;
use recondo_gateway::capture::recovery::{recover_orphan_captures, RecoveryConfig, RecoveryReport};
use recondo_gateway::gateway;
use recondo_gateway::hash;
use recondo_gateway::schema::CaptureRecord;
use recondo_gateway::session::SessionManager;
use recondo_gateway::storage::graph::{GraphStore, SqliteGraphStore};
use recondo_gateway::storage::object::{LocalObjectStore, ObjectStore};
use recondo_gateway::storage::pipeline::WritePipeline;
use recondo_gateway::wal::Wal;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a minimal but realistic Anthropic streaming request body.
fn anthropic_request_bytes(user_text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "system": "You are a helpful assistant.",
        "messages": [{"role": "user", "content": user_text}],
        "stream": true,
    }))
    .unwrap()
}

/// Build a complete Anthropic SSE response body (HTTP-stripped form: just the
/// SSE event stream — that's what `parse_capture_data` already handles via
/// `prepare_response_body`).
fn anthropic_sse_response_bytes(text: &str) -> Vec<u8> {
    let mut buf = String::new();
    buf.push_str(&format!(
        "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_t\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{{\"input_tokens\":7,\"output_tokens\":1}}}}}}\n\n"
    ));
    buf.push_str("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n");
    buf.push_str(&format!(
        "event: content_block_delta\ndata: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":{}}}}}\n\n",
        serde_json::to_string(text).unwrap()
    ));
    buf.push_str(
        "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
    );
    buf.push_str("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":3}}\n\n");
    buf.push_str("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
    buf.into_bytes()
}

/// Build a Google/Gemini request body.
fn gemini_request_bytes(user_text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "contents": [
            {"role": "user", "parts": [{"text": user_text}]}
        ],
        "generationConfig": {"maxOutputTokens": 256},
    }))
    .unwrap()
}

/// Build a Gemini streamGenerateContent SSE response with one text chunk.
fn gemini_sse_response_bytes(text: &str) -> Vec<u8> {
    let mut buf = String::new();
    buf.push_str(&format!(
        "data: {{\"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":{}}}],\"role\":\"model\"}},\"finishReason\":\"STOP\",\"index\":0}}],\"usageMetadata\":{{\"promptTokenCount\":5,\"candidatesTokenCount\":4,\"totalTokenCount\":9}},\"modelVersion\":\"gemini-2.0-flash\"}}\n\n",
        serde_json::to_string(text).unwrap()
    ));
    buf.into_bytes()
}

/// Build an OpenAI Chat Completions request body.
fn openai_request_bytes(user_text: &str) -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "model": "gpt-4o-2024-05-13",
        "messages": [{"role": "user", "content": user_text}],
        "stream": true,
    }))
    .unwrap()
}

/// Build a minimal OpenAI SSE response.
fn openai_sse_response_bytes(text: &str) -> Vec<u8> {
    let mut buf = String::new();
    buf.push_str(&format!(
        "data: {{\"id\":\"chatcmpl-x\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-4o-2024-05-13\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{}}},\"finish_reason\":null}}]}}\n\n",
        serde_json::to_string(text).unwrap()
    ));
    buf.push_str("data: {\"id\":\"chatcmpl-x\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"gpt-4o-2024-05-13\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":4,\"total_tokens\":9}}\n\n");
    buf.push_str("data: [DONE]\n\n");
    buf.into_bytes()
}

/// Gzip-compress bytes and write to <data_dir>/objects/<kind>/<hash>.json.gz.
/// Mirrors what `crate::store::store_object` produces so the orphan looks
/// identical to one written by the live capture path.
fn write_gzipped_object(data_dir: &Path, kind: &str, bytes: &[u8]) -> String {
    let h = hash::sha256_hex(bytes);
    let dir = data_dir.join("objects").join(kind);
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{}.json.gz", h));
    let f = fs::File::create(&path).unwrap();
    let mut enc = GzEncoder::new(f, Compression::default());
    enc.write_all(bytes).unwrap();
    enc.finish().unwrap();
    h
}

/// Write a JSON capture-metadata file under <data_dir>/captures/. Filename
/// matches the timestamp-based shape produced by `capture::record_capture`.
fn write_capture_metadata(data_dir: &Path, record: &CaptureRecord) -> PathBuf {
    let dir = data_dir.join("captures");
    fs::create_dir_all(&dir).unwrap();
    // Use a filesystem-safe form derived from the record's timestamp + uuid.
    // Implementation produces "YYYYMMDDTHHMMSS.uuuuuuZ_<uuid>.json" but for the
    // recovery scan, only the `.json` extension and contents matter.
    let safe_ts = record
        .timestamp
        .replace([':', '+', '-'], "")
        .replace('.', "_");
    let filename = format!("{}_{}.json", safe_ts, record.uuid);
    let path = dir.join(filename);
    fs::write(&path, serde_json::to_string_pretty(record).unwrap()).unwrap();
    path
}

/// Seed a self-consistent orphan: object bytes on disk + capture metadata
/// pointing at them, no DB row. Returns (request_hash, response_hash, capture_path).
fn seed_orphan(
    data_dir: &Path,
    provider: &str,
    request_bytes: &[u8],
    response_bytes: &[u8],
    timestamp: &str,
) -> (String, String, PathBuf) {
    let req_hash = write_gzipped_object(data_dir, "req", request_bytes);
    let resp_hash = write_gzipped_object(data_dir, "resp", response_bytes);
    let record = CaptureRecord {
        timestamp: timestamp.to_string(),
        uuid: uuid::Uuid::new_v4().to_string(),
        provider: provider.to_string(),
        request_hash: req_hash.clone(),
        response_hash: resp_hash.clone(),
        req_bytes_ref: format!("objects/req/{}.json.gz", req_hash),
        resp_bytes_ref: format!("objects/resp/{}.json.gz", resp_hash),
        request_size: request_bytes.len() as u64,
        response_size: response_bytes.len() as u64,
    };
    let path = write_capture_metadata(data_dir, &record);
    (req_hash, resp_hash, path)
}

/// Count turns in the graph store across all sessions whose request_hash
/// equals the given hash. Returns the count.
fn count_turns_with_request_hash(store: &dyn GraphStore, request_hash: &str) -> usize {
    let sessions = store.list_sessions(None).unwrap();
    let mut count = 0usize;
    for s in &sessions {
        let turns = store.get_turns_for_session(&s.id).unwrap();
        for t in turns {
            if t.request_hash == request_hash {
                count += 1;
            }
        }
    }
    count
}

// ===========================================================================
// 1. Core: an orphan with no matching turn IS recovered and inserted
// ===========================================================================

/// **Proves:** When a capture metadata file exists with no matching `turns`
/// row, `recover_orphan_captures` reads the gzipped req/resp objects, replays
/// them through the parse-and-insert path, and a `turns` row appears in the
/// graph store with the orphan's request_hash.
///
/// **Anti-fake property:** Pre-recovery assertion `count == 0` proves the row
/// did not exist. Post-recovery `count == 1` plus `report.recovered == 1`
/// proves the recovery code (not some unrelated pipeline) inserted it. The
/// current gateway has no recovery path, so this test cannot pass without
/// the new code.
#[test]
fn orphan_capture_with_no_matching_turns_row_is_recovered_and_inserted() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    let req = anthropic_request_bytes("orphan-1");
    let resp = anthropic_sse_response_bytes("recovered text");
    let (req_hash, _resp_hash, _) =
        seed_orphan(data_dir, "anthropic", &req, &resp, "2026-05-02T18:19:56Z");

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    // Pre-condition: no turn exists yet.
    assert_eq!(
        count_turns_with_request_hash(&graph, &req_hash),
        0,
        "Sanity check: orphan's request_hash must not yet appear in any turn"
    );

    let report =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();

    assert_eq!(report.scanned, 1, "Must have scanned the one capture file");
    assert_eq!(report.orphans_found, 1, "Must have found the orphan");
    assert_eq!(report.recovered, 1, "Must have recovered the orphan");
    assert!(
        report.failed.is_empty(),
        "No failures expected: {:?}",
        report.failed
    );

    assert_eq!(
        count_turns_with_request_hash(&graph, &req_hash),
        1,
        "Recovery must insert exactly one turn for the orphan's request_hash"
    );
}

// ===========================================================================
// 2. Idempotency: a second invocation finds zero orphans
// ===========================================================================

/// **Proves:** A second `recover_orphan_captures` call against the same
/// data_dir returns `orphans_found == 0` and `recovered == 0` because the
/// turn from the first run is now in the DB. No double-insert occurs.
///
/// **Anti-fake property:** A naive implementation that re-inserts on every
/// scan would either error on a UNIQUE violation (test would fail) or end
/// up with `count == 2` (test would fail).
#[test]
fn second_invocation_finds_zero_orphans_and_does_not_double_insert() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    let req = anthropic_request_bytes("orphan-idem");
    let resp = anthropic_sse_response_bytes("idempotent");
    let (req_hash, _, _) = seed_orphan(data_dir, "anthropic", &req, &resp, "2026-05-02T18:20:00Z");

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let r1 =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert_eq!(r1.recovered, 1);

    let r2 =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert_eq!(r2.orphans_found, 0, "Second run must find no orphans");
    assert_eq!(r2.recovered, 0, "Second run must recover nothing");
    assert!(r2.failed.is_empty());

    assert_eq!(
        count_turns_with_request_hash(&graph, &req_hash),
        1,
        "Must still have exactly one turn — no double-insert across two recovery passes"
    );
}

// ===========================================================================
// 3. Recovered turn preserves the original capture timestamp (not "now")
// ===========================================================================

/// **Proves:** The `turns.timestamp` column on the recovered row equals the
/// `CaptureRecord.timestamp` from the metadata file, not the wall clock at
/// recovery time.
///
/// **Anti-fake property:** A trivial implementation that calls
/// `Utc::now()` for the recovered turn would produce a 2026-05-02 timestamp
/// (today); we seed a fixed past timestamp from 2024 and assert exact match.
#[test]
fn recovered_turn_preserves_original_capture_timestamp() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    let original_ts = "2024-01-15T08:30:00Z";
    let req = anthropic_request_bytes("preserve ts");
    let resp = anthropic_sse_response_bytes("ok");
    let (req_hash, _, _) = seed_orphan(data_dir, "anthropic", &req, &resp, original_ts);

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let report =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert_eq!(report.recovered, 1);

    // Find the recovered turn
    let sessions = graph.list_sessions(None).unwrap();
    let mut found_turn = None;
    for s in &sessions {
        for t in graph.get_turns_for_session(&s.id).unwrap() {
            if t.request_hash == req_hash {
                found_turn = Some(t);
                break;
            }
        }
    }
    let turn = found_turn.expect("Recovered turn must exist");

    assert_eq!(
        turn.timestamp, original_ts,
        "Recovered turn.timestamp must equal the CaptureRecord.timestamp, \
         not the recovery wall-clock. Got {} expected {}",
        turn.timestamp, original_ts
    );
}

// ===========================================================================
// 4. NEGATIVE: orphan stays un-recovered when recovery is NOT invoked
// ===========================================================================

/// **Proves:** Without calling `recover_orphan_captures`, the orphan remains
/// orphaned: no `turns` row exists for its `request_hash`. This proves the
/// recovery function is load-bearing — its absence is observable.
///
/// **Anti-fake property:** If some other path (e.g. the live capture
/// pipeline starting up) silently scanned `captures/` and inserted rows,
/// this test would fail. The bug under repair is precisely that no such
/// path exists today; this test pins that fact in place when recovery is
/// NOT called.
#[test]
fn orphan_remains_unrecovered_when_recovery_function_is_not_invoked() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    let req = anthropic_request_bytes("never recovered");
    let resp = anthropic_sse_response_bytes("ghost");
    let (req_hash, _, capture_path) =
        seed_orphan(data_dir, "anthropic", &req, &resp, "2026-05-02T18:21:00Z");

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    // Note: NOT calling recover_orphan_captures.

    // The orphan capture file must still exist on disk (we wrote it).
    assert!(capture_path.exists(), "Sanity: capture metadata must exist");

    // The DB must NOT contain a turn for the orphan's request_hash.
    assert_eq!(
        count_turns_with_request_hash(&graph, &req_hash),
        0,
        "Without invoking recovery, the orphan must remain un-recovered. \
         Any nonzero count proves a phantom recovery path exists."
    );
}

// ===========================================================================
// 5. BOUNDARY: zero orphans — every capture file already has a matching turn
// ===========================================================================

/// **Proves:** When all capture files correspond to turns already in the
/// DB, recovery returns `scanned > 0`, `orphans_found == 0`, `recovered == 0`.
/// This proves the dedup probe (request_hash existence check) is real.
///
/// **Anti-fake property:** An implementation that always reports
/// `orphans_found == scanned` would fail this test.
#[test]
fn zero_orphans_when_every_capture_already_has_a_matching_turns_row() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    let req = anthropic_request_bytes("already-in-db");
    let resp = anthropic_sse_response_bytes("done");
    let (req_hash, _, _) = seed_orphan(data_dir, "anthropic", &req, &resp, "2026-05-02T18:22:00Z");

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    // First run: recovery picks it up.
    let r1 =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert_eq!(r1.recovered, 1);

    // Second run: same captures dir, but turn now exists.
    let r2 =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert!(
        r2.scanned >= 1,
        "Captures dir is non-empty; must have scanned"
    );
    assert_eq!(r2.orphans_found, 0);
    assert_eq!(r2.recovered, 0);
    assert_eq!(
        count_turns_with_request_hash(&graph, &req_hash),
        1,
        "Still exactly one turn after the second pass"
    );
}

// ===========================================================================
// 6. BOUNDARY: missing captures/ directory is not an error
// ===========================================================================

/// **Proves:** When `<data_dir>/captures/` does not exist, recovery returns
/// `scanned == 0` and `orphans_found == 0` without erroring.
///
/// **Anti-fake property:** A trivial `read_dir(...).unwrap()` would panic
/// on a missing directory; this test enforces graceful handling.
#[test]
fn missing_captures_directory_returns_zero_scanned_and_no_error() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    // Do not create captures/.
    assert!(!data_dir.join("captures").exists());

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let report = recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default())
        .expect("Missing captures/ must not error");
    assert_eq!(report.scanned, 0);
    assert_eq!(report.orphans_found, 0);
    assert_eq!(report.recovered, 0);
    assert!(report.failed.is_empty());
}

// ===========================================================================
// 7. BOUNDARY: corrupt capture file — recorded as failed, sibling recovered
// ===========================================================================

/// **Proves:** A malformed JSON file in `captures/` is recorded in
/// `report.failed` (not silently swallowed), recovery does NOT abort, and a
/// well-formed sibling capture in the same dir IS still recovered.
///
/// **Anti-fake property:** An implementation that bails on the first error
/// would never reach the sibling, so the sibling's turn would never appear.
/// An implementation that silently ignores bad files would have an empty
/// `failed` list.
#[test]
fn corrupt_capture_file_is_recorded_as_failed_and_does_not_block_siblings() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    // Sibling: a valid orphan.
    let req = anthropic_request_bytes("sibling-of-corrupt");
    let resp = anthropic_sse_response_bytes("sibling-text");
    let (good_hash, _, _) = seed_orphan(data_dir, "anthropic", &req, &resp, "2026-05-02T18:23:00Z");

    // Corrupt: a malformed JSON in captures/.
    let captures_dir = data_dir.join("captures");
    fs::write(
        captures_dir.join("20260502T182400Z_corrupt.json"),
        b"{not json",
    )
    .unwrap();

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let report =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();

    assert!(
        report.scanned >= 2,
        "Must have scanned both files, got {}",
        report.scanned
    );
    assert_eq!(
        report.recovered, 1,
        "The good sibling must still be recovered"
    );
    assert_eq!(
        report.failed.len(),
        1,
        "Corrupt file must be recorded as exactly one failure, got {:?}",
        report.failed
    );
    assert!(
        report.failed[0].0.to_string_lossy().contains("corrupt"),
        "Failure must reference the corrupt file path, got {:?}",
        report.failed
    );
    assert_eq!(
        count_turns_with_request_hash(&graph, &good_hash),
        1,
        "Sibling orphan must be recovered despite the corrupt file"
    );
}

// ===========================================================================
// 8. BOUNDARY: missing object bytes — recorded as failed, no DB row
// ===========================================================================

/// **Proves:** A capture metadata file referencing a request_hash whose
/// gzipped object is missing from `objects/req/` is recorded in
/// `report.failed`, and no `turns` row is inserted for that hash.
///
/// **Anti-fake property:** An implementation that fabricates empty bytes
/// or panics on a missing object would either silently insert a bogus turn
/// or crash the recovery run.
#[test]
fn missing_object_bytes_is_recorded_as_failed_and_no_turn_inserted() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    // Hand-craft a CaptureRecord whose hashes do NOT exist on disk.
    let phantom_req_hash = "0".repeat(64);
    let phantom_resp_hash = "1".repeat(64);
    let record = CaptureRecord {
        timestamp: "2026-05-02T18:25:00Z".to_string(),
        uuid: uuid::Uuid::new_v4().to_string(),
        provider: "anthropic".to_string(),
        request_hash: phantom_req_hash.clone(),
        response_hash: phantom_resp_hash.clone(),
        req_bytes_ref: format!("objects/req/{}.json.gz", phantom_req_hash),
        resp_bytes_ref: format!("objects/resp/{}.json.gz", phantom_resp_hash),
        request_size: 100,
        response_size: 100,
    };
    write_capture_metadata(data_dir, &record);

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let report =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();

    assert_eq!(report.scanned, 1);
    assert_eq!(
        report.orphans_found, 1,
        "Hash absent from DB → still classified as orphan"
    );
    assert_eq!(report.recovered, 0, "Cannot recover what cannot be loaded");
    assert_eq!(
        report.failed.len(),
        1,
        "Must record exactly one failure: {:?}",
        report.failed
    );
    assert_eq!(
        count_turns_with_request_hash(&graph, &phantom_req_hash),
        0,
        "No turn must be inserted for missing-bytes orphan"
    );
}

// ===========================================================================
// 9. BOUNDARY: mixed states — already-in-DB + orphaned + corrupt
// ===========================================================================

/// **Proves:** A captures dir containing a mix of (already-recovered, fresh
/// orphan, corrupt) classifies each correctly and produces accurate counts:
/// scanned == 3, orphans_found == 1, recovered == 1, failed.len() == 1.
///
/// **Anti-fake property:** A counter that double-counts or short-circuits
/// would fail the exact equality on counts.
#[test]
fn mixed_states_classified_correctly_with_accurate_counts() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    // (a) An already-recovered capture (we'll run recovery once first to put it in DB).
    let req_a = anthropic_request_bytes("already-a");
    let resp_a = anthropic_sse_response_bytes("a");
    let (hash_a, _, _) = seed_orphan(
        data_dir,
        "anthropic",
        &req_a,
        &resp_a,
        "2026-05-02T18:30:00Z",
    );

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let r0 =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert_eq!(r0.recovered, 1);

    // (b) A fresh orphan added after the first recovery pass.
    let req_b = anthropic_request_bytes("orphan-b");
    let resp_b = anthropic_sse_response_bytes("b");
    let (hash_b, _, _) = seed_orphan(
        data_dir,
        "anthropic",
        &req_b,
        &resp_b,
        "2026-05-02T18:31:00Z",
    );

    // (c) A corrupt JSON file.
    let captures_dir = data_dir.join("captures");
    fs::write(
        captures_dir.join("20260502T183200Z_bad.json"),
        b"!!!not-json!!!",
    )
    .unwrap();

    // Now run recovery again on the mixed state.
    let r =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();

    assert_eq!(r.scanned, 3, "Three capture files in the dir");
    assert_eq!(
        r.orphans_found, 1,
        "Only (b) is an orphan; (a) is in DB; (c) failed parse"
    );
    assert_eq!(r.recovered, 1, "Only (b) gets recovered");
    assert_eq!(r.failed.len(), 1, "Only (c) is a failure");

    assert_eq!(
        count_turns_with_request_hash(&graph, &hash_a),
        1,
        "(a) still single row"
    );
    assert_eq!(
        count_turns_with_request_hash(&graph, &hash_b),
        1,
        "(b) recovered"
    );
}

// ===========================================================================
// 10. BOUNDARY: concurrent invocation — idempotency under threads
// ===========================================================================

/// **Proves:** Two threads calling `recover_orphan_captures` against the
/// same `data_dir` do not produce double-inserted turns. Total recovered
/// across both reports = 1 (or one succeeds and the other reports the
/// orphan as already in DB).
///
/// **Anti-fake property:** Without the request_hash existence probe (or
/// equivalent UNIQUE-on-hash protection), a race between two threads
/// would yield two turns sharing the same request_hash.
#[test]
fn concurrent_recovery_invocations_do_not_double_insert() {
    let tmp = TempDir::new().unwrap();
    let data_dir: PathBuf = tmp.path().to_path_buf();

    let req = anthropic_request_bytes("concurrent-orphan");
    let resp = anthropic_sse_response_bytes("c");
    let (req_hash, _, _) = seed_orphan(&data_dir, "anthropic", &req, &resp, "2026-05-02T18:35:00Z");

    // Single shared in-memory SQLite (single connection in pool, per the
    // SqliteGraphStore::new_in_memory() implementation — that's the realistic
    // contention surface for this test).
    let graph = Arc::new(SqliteGraphStore::new_in_memory().unwrap());

    let dd1 = data_dir.clone();
    let g1 = graph.clone();
    let h1 = std::thread::spawn(move || {
        let objects = LocalObjectStore::new(&dd1);
        recover_orphan_captures(&dd1, &*g1, &objects, &RecoveryConfig::default()).unwrap()
    });

    let dd2 = data_dir.clone();
    let g2 = graph.clone();
    let h2 = std::thread::spawn(move || {
        let objects = LocalObjectStore::new(&dd2);
        recover_orphan_captures(&dd2, &*g2, &objects, &RecoveryConfig::default()).unwrap()
    });

    let r1 = h1.join().unwrap();
    let r2 = h2.join().unwrap();

    let total_recovered = r1.recovered + r2.recovered;
    assert!(
        total_recovered <= 1,
        "Combined recovered must be at most 1 (the orphan); got r1={} r2={}",
        r1.recovered,
        r2.recovered
    );

    assert_eq!(
        count_turns_with_request_hash(&*graph, &req_hash),
        1,
        "Concurrent recovery must produce exactly one turn for the orphan, not two"
    );
}

// ===========================================================================
// 11. PROVIDER-AGNOSTIC: anthropic
// ===========================================================================

/// **Proves:** Recovery works for `provider="anthropic"` orphans.
///
/// **Anti-fake property:** Combined with tests 12 and 13, this proves the
/// recovery code does not silently special-case any single provider.
#[test]
fn anthropic_orphan_is_recovered_via_recovery_function() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    let req = anthropic_request_bytes("provider-anthropic");
    let resp = anthropic_sse_response_bytes("anth ok");
    let (req_hash, _, _) = seed_orphan(data_dir, "anthropic", &req, &resp, "2026-05-02T18:40:00Z");

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let report =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert_eq!(
        report.recovered, 1,
        "Anthropic orphan must be recovered: {:?}",
        report.failed
    );
    assert_eq!(count_turns_with_request_hash(&graph, &req_hash), 1);
}

// ===========================================================================
// 12. PROVIDER-AGNOSTIC: google (Gemini)
// ===========================================================================

/// **Proves:** Recovery works for `provider="google"` orphans, end-to-end:
/// metadata + bytes + parse-and-insert produces a turn whose request_hash
/// matches the orphan.
///
/// **Anti-fake property:** A `match provider` that only handles "anthropic"
/// would either fall through to a panic or skip the file, so this test
/// would fail.
#[test]
fn google_orphan_is_recovered_via_recovery_function() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    let req = gemini_request_bytes("provider-google");
    let resp = gemini_sse_response_bytes("gemini ok");
    let (req_hash, _, _) = seed_orphan(data_dir, "google", &req, &resp, "2026-05-02T18:41:00Z");

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let report =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert_eq!(
        report.recovered, 1,
        "Google orphan must be recovered: {:?}",
        report.failed
    );
    assert_eq!(count_turns_with_request_hash(&graph, &req_hash), 1);
}

// ===========================================================================
// 13. PROVIDER-AGNOSTIC: openai
// ===========================================================================

/// **Proves:** Recovery works for `provider="openai"` orphans.
///
/// **Anti-fake property:** OpenAI's parse path and SSE shape differ from
/// Anthropic's. A recovery implementation that special-cases anthropic
/// would either bail or write a turn missing OpenAI-specific fields.
/// Combined with tests 11 and 12, three providers are covered.
#[test]
fn openai_orphan_is_recovered_via_recovery_function() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();

    let req = openai_request_bytes("provider-openai");
    let resp = openai_sse_response_bytes("openai ok");
    let (req_hash, _, _) = seed_orphan(data_dir, "openai", &req, &resp, "2026-05-02T18:42:00Z");

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(data_dir);

    let report =
        recover_orphan_captures(data_dir, &graph, &objects, &RecoveryConfig::default()).unwrap();
    assert_eq!(
        report.recovered, 1,
        "OpenAI orphan must be recovered: {:?}",
        report.failed
    );
    assert_eq!(count_turns_with_request_hash(&graph, &req_hash), 1);
}

// ===========================================================================
// 14. WAL HYGIENE: orphan WAL entry from a prior run is NOT marked flushed
//     when a NEW unrelated capture commits.
// ===========================================================================

/// **Proves:** The WAL bookkeeping fix at `gateway/src/gateway/mod.rs:2225-2240`
/// (and siblings at ~2730 and ~3745) marks only the just-committed capture's
/// WAL entries as flushed — not every unflushed entry in the WAL.
///
/// Setup:
///   1. Append two unrelated bytes to the WAL ("orphan_req", "orphan_resp"),
///      simulating a prior capture that crashed before its DB commit.
///   2. Run a fresh, unrelated successful capture through
///      `process_capture_with_pipeline` with the same WAL handle.
///   3. Inspect the WAL directory: the new capture's bytes are now `.flushed`
///      but the orphan's bytes remain `.wal` (still unflushed).
///
/// **Anti-fake property:** The CURRENT post-commit code at the three sites
/// calls `wal.flush()` (returns ALL unflushed) and then marks every entry
/// flushed. If we run this test against the current gateway, both the
/// orphan and the new capture's entries end up `.flushed` and the orphan
/// entry is silently buried — failing the orphan-stays-unflushed assertion.
/// This test is the smoking gun for the hygiene fix.
#[test]
fn unrelated_orphan_wal_entry_is_not_marked_flushed_by_a_subsequent_successful_capture() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path();
    let wal_dir = data_dir.join("wal");
    let wal = Wal::open(&wal_dir).unwrap();

    // (1) Pre-existing orphan WAL entries with a unique sentinel byte sequence
    // we can identify after-the-fact.
    let orphan_req = b"ORPHAN_REQ_SENTINEL_xyz123".to_vec();
    let orphan_resp = b"ORPHAN_RESP_SENTINEL_xyz123".to_vec();
    wal.append(&orphan_req).unwrap();
    wal.append(&orphan_resp).unwrap();
    assert_eq!(wal.unflushed_count(), 2, "Two orphan WAL entries appended");

    // (2) Stand up the storage backends and a write pipeline.
    let graph_store = Box::new(SqliteGraphStore::new_in_memory().unwrap()) as Box<dyn GraphStore>;
    let object_store = Box::new(LocalObjectStore::new(data_dir)) as Box<dyn ObjectStore>;
    let dead_letter_dir = data_dir.join("dead_letters");
    let pipeline = WritePipeline::new(graph_store, object_store, dead_letter_dir);

    let mut session_mgr = SessionManager::new();
    let new_req = anthropic_request_bytes("brand-new-capture");
    let new_resp = anthropic_sse_response_bytes("hi");

    // (3) Run a real successful capture with the same WAL — this is the path
    // that contains the buggy post-commit `wal.flush(); for e in entries { mark_flushed(e) }`
    // pattern. After the fix, only the new capture's two WAL entries (req,resp)
    // should end up `.flushed`; the orphans must stay `.wal`.
    let _turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &new_req,
        &new_resp,
        Some(&wal),
        None,
    )
    .expect("New capture must commit successfully");

    // Inspect WAL dir: collect all `.wal` (unflushed) and `.wal.flushed` files
    // along with their bytes so we can match by content (not by sequence number).
    let mut unflushed: Vec<Vec<u8>> = Vec::new();
    let mut flushed: Vec<Vec<u8>> = Vec::new();
    for entry in fs::read_dir(&wal_dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().to_string();
        if !entry.path().is_file() {
            continue;
        }
        let bytes = fs::read(entry.path()).unwrap_or_default();
        if name.ends_with(".wal.flushed") {
            flushed.push(bytes);
        } else if name.ends_with(".wal") {
            unflushed.push(bytes);
        }
    }

    // Orphan entries must still be on disk as `.wal` (NOT `.flushed`).
    assert!(
        unflushed.iter().any(|b| b == &orphan_req),
        "Orphan request bytes must remain unflushed (.wal). Unflushed contents: {:?}",
        unflushed
            .iter()
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .collect::<Vec<_>>()
    );
    assert!(
        unflushed.iter().any(|b| b == &orphan_resp),
        "Orphan response bytes must remain unflushed (.wal)"
    );

    // The NEW capture's bytes must be marked flushed.
    assert!(
        flushed.iter().any(|b| b == &new_req),
        "New capture's request bytes must be marked .flushed after commit"
    );
    assert!(
        flushed.iter().any(|b| b == &new_resp),
        "New capture's response bytes must be marked .flushed after commit"
    );

    // The orphans must NOT have been silently flushed by the bug being repaired.
    assert!(
        !flushed.iter().any(|b| b == &orphan_req),
        "Orphan request must NOT have been silently marked flushed by the new capture's commit"
    );
    assert!(
        !flushed.iter().any(|b| b == &orphan_resp),
        "Orphan response must NOT have been silently marked flushed by the new capture's commit"
    );

    // Final unflushed_count must be exactly 2 (the two orphan entries).
    assert_eq!(
        wal.unflushed_count(),
        2,
        "After the new capture commits, the only remaining unflushed entries \
         must be the two pre-existing orphans"
    );
}
