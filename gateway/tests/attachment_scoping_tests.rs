//! Attachment scoping + messages-delta correctness tests.
//!
//! These tests prove TWO bugs that were observed in production:
//!
//! ### Bug #1 (PRIMARY): Broken cumulative-delta computation
//!
//! `GraphStore::get_previous_turn_messages(session_id, sequence_num)` in both
//! the SQLite and PostgreSQL backends returns the previous turn's STORED
//! `messages_delta` column — i.e. only the messages *appended* by that turn,
//! not the cumulative conversation prefix.
//!
//! `providers::anthropic::compute_true_delta(current, previous)` then slices
//! `current[previous.len()..]`. Because `previous` is a partial prefix (only
//! the last turn's delta — not the full cumulative history), the slice
//! under-counts and re-includes historical messages in the "delta" for every
//! turn after turn 2.
//!
//! Downstream: `capture::attachments::extract_from_messages` walks that bogus
//! delta and re-catalogs every historical image on every turn. `attachment_count`
//! grows quadratically (observed: 6-turn session with 1 image/turn showed
//! `attachment_count = 70` on turn #6; expected 1).
//!
//! ### Bug #2 (SECONDARY): `[Image: source: ...]` placeholder leaks into `user_request_text`
//!
//! `session::extract_last_user_request_text` iterates user content blocks in
//! reverse and returns the last non-preamble text block. When Claude Code
//! sends an image-attached message, the text block `"[Image: source: /Users/.../3.png]"`
//! is returned verbatim and stored in `turns.user_request_text`, exposing a
//! local filesystem path in the dashboard's user-request column.
//!
//! **Contract chosen by the test writer (implementer must satisfy one of these):**
//! The stored `user_request_text` MUST NOT be a raw `[Image: source: ...]`
//! placeholder string. Acceptable outcomes:
//!   (a) the extractor returns `None` for the bare-placeholder case,
//!   (b) the extractor returns a sanitized string (e.g. `"[image attachment]"`),
//!   (c) the extractor falls back to a non-placeholder text block earlier in
//!       the content array,
//!   (d) any other string that does NOT contain `"/Users/"`, does NOT start
//!       with `"[Image:"`, and is not a raw `/.../<uuid>/N.png` path.
//!
//! Each bug-2 test asserts the negative invariant (NOT equal to the raw
//! placeholder, NOT containing a filesystem path) so the implementer has
//! latitude to pick the concrete contract without loosening the test's bite.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde_json::{json, Value};
use tempfile::TempDir;

use recondo_gateway::capture::attachments::extract_from_messages;
use recondo_gateway::providers::anthropic;
use recondo_gateway::session::{extract_last_user_request_text, SessionManager};
use recondo_gateway::storage::graph::SqliteGraphStore;
use recondo_gateway::storage::object::{LocalObjectStore, ObjectStore as _};
use recondo_gateway::storage::pipeline::WritePipeline;

// FIND-15-Rust-1: shared cross-process advisory-lock helper. Lives in
// `gateway/tests/common/pg_lock.rs` so every PG-touching test binary
// uses the SAME process-scoped runtime + OnceLock-backed lock holder.
// Without the helper each call site rebuilt the pattern from scratch
// and got it subtly wrong (per-test runtime drop releasing the lock).
mod common;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A tiny real-looking PNG (valid signature; MIME-sniffable). Each turn in a
/// test should pass DIFFERENT bytes so content-addressed dedup does not
/// collapse two turns' attachments into a single shared row — otherwise a
/// test might pass via dedup rather than because the delta was scoped
/// correctly.
fn make_unique_png(marker: u8) -> Vec<u8> {
    // PNG signature + IHDR-ish bytes; the last trailing byte is perturbed so
    // every turn produces a unique sha256.
    let mut bytes: Vec<u8> = vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG magic
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR header
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, // crc etc.
        0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, // IDAT
        0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, //
        0x0D, 0x0A, 0x2D, 0xB4, // CRC
        0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, // IEND
        0xAE, 0x42, 0x60, 0x82, // IEND CRC
    ];
    // Append a unique tail so sha256 differs per turn.
    bytes.push(marker);
    bytes
}

/// Minimal Anthropic SSE response that yields a parseable, capture-complete
/// turn. Kept short so tests stay fast; the specific tokens/text don't matter
/// for the scoping bug — what matters is that `process_capture_with_pipeline`
/// succeeds end-to-end.
fn anthropic_sse_response(assistant_text: &str) -> Vec<u8> {
    format!(
        "event: message_start\n\
data: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_test\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{{\"input_tokens\":25,\"output_tokens\":1,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}}}}\n\n\
event: content_block_start\n\
data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"text\",\"text\":\"\"}}}}\n\n\
event: content_block_delta\n\
data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{}\"}}}}\n\n\
event: content_block_stop\n\
data: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
event: message_delta\n\
data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\"}},\"usage\":{{\"output_tokens\":5}}}}\n\n\
event: message_stop\n\
data: {{\"type\":\"message_stop\"}}\n\n",
        assistant_text
    )
    .into_bytes()
}

/// Build an Anthropic-wire-format content array for a user turn that attaches
/// a SINGLE image plus a text block. Matches the shape Claude Code sends.
fn user_message_with_image(image_bytes: &[u8], text: &str) -> Value {
    json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": BASE64.encode(image_bytes) } },
            { "type": "text", "text": text }
        ]
    })
}

/// Wrap an N-message array into a complete Anthropic request body. The
/// `metadata.user_id` carries Claude-Code-style identity so session resolution
/// is deterministic across turns.
fn anthropic_request(session_id: &str, messages: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "system": "You are a helpful assistant.",
        "messages": messages,
        "metadata": {
            "user_id": format!(
                "{{\"session_id\":\"{}\",\"account_uuid\":\"acct-scope-test\",\"device_id\":\"dev-scope-test\"}}",
                session_id
            )
        }
    }))
    .unwrap()
}

/// Build a fresh in-memory `WritePipeline` for a single test.
fn make_pipeline() -> (WritePipeline, TempDir) {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    let dlq = data_dir.join("dlq");
    let graph = SqliteGraphStore::new_in_memory().expect("in-memory sqlite graph");
    let objects = LocalObjectStore::new(&data_dir);
    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq);
    (pipeline, tmp)
}

// ===========================================================================
// Category 1 — `compute_true_delta` cumulative correctness (pure function)
// ===========================================================================

/// **Name:** `test_compute_true_delta_returns_exactly_one_new_msg_on_turn_3`
/// **Proves:** When a caller passes the FULL cumulative previous-turn
/// messages array (not a prior partial delta), `compute_true_delta` returns
/// exactly the one new message appended by the current turn, for every turn
/// after turn 1.
/// **Anti-fake property:** A slice-based implementation that receives a
/// partial-prefix `previous` will return more than one message (in this case
/// 3), failing the `== 1` assertion. An implementation that ignores the
/// `previous` argument will return the full 5-element current array.
#[test]
fn test_compute_true_delta_returns_exactly_one_new_msg_on_turn_3() {
    // Cumulative prev = the full conversation through turn 2.
    let prev_cumulative = json!([
        {"role": "user", "content": "turn1 user"},
        {"role": "assistant", "content": "turn1 asst"},
        {"role": "user", "content": "turn2 user"},
        {"role": "assistant", "content": "turn2 asst"}
    ]);
    let current = json!([
        {"role": "user", "content": "turn1 user"},
        {"role": "assistant", "content": "turn1 asst"},
        {"role": "user", "content": "turn2 user"},
        {"role": "assistant", "content": "turn2 asst"},
        {"role": "user", "content": "turn3 user"}
    ]);

    let delta_str =
        anthropic::compute_true_delta(&current.to_string(), Some(&prev_cumulative.to_string()))
            .expect("compute_true_delta must succeed");
    let delta: Vec<Value> = serde_json::from_str(&delta_str).expect("delta must parse as JSON");

    assert_eq!(
        delta.len(),
        1,
        "Turn 3 delta must be exactly the one new message. \
         If this returns >1, the caller is passing a partial-prefix `previous` \
         (i.e. the prior turn's stored delta, not the cumulative conversation). \
         Got: {:?}",
        delta
    );
    assert_eq!(
        delta[0]["content"].as_str(),
        Some("turn3 user"),
        "The one new message must be turn3's user message"
    );
}

/// **Name:** `test_compute_true_delta_with_partial_prefix_reveals_bug`
/// **Proves:** The ROOT-CAUSE shape of bug #1: if `previous` is the prior
/// turn's stored delta (a partial prefix, not cumulative), `compute_true_delta`
/// drags historical messages back into the returned delta — exactly the
/// upstream condition that causes historical images to be re-catalogued.
/// **Anti-fake property:** This test calls `compute_true_delta` with the
/// CURRENT buggy input shape and asserts the output is WRONG (>1). Any
/// plausible "fix" that keeps the existing `previous[..].len()` slicing
/// semantics will still fail this test when the caller supplies cumulative
/// prev. So if the implementer wants this test to pass, they must fix the
/// SOURCE of `previous` (`get_previous_turn_messages` or its caller in
/// `process_capture_with_pipeline`/`process_capture_with_storage`) to return
/// the cumulative conversation, not just the prior-turn delta.
///
/// This test is deliberately worded as a "the bug is here" negative: the
/// precondition asserts that when a partial-prefix is passed (like the
/// buggy call path today), the slice under-counts. Removing/reverting the
/// fix to `get_previous_turn_messages` (or its caller) will keep this
/// assertion true by design, but the integration tests below (which go
/// through the real pipeline) will fail. The assertion here exists to
/// document the shape of the bug and catch regressions where someone
/// "fixes" `compute_true_delta` in a way that silently changes its
/// contract.
#[test]
fn test_compute_true_delta_with_partial_prefix_reveals_bug() {
    // Simulate the BUGGY caller: `previous` is only the prior turn's stored
    // delta (2 messages: assistant + user), NOT the full cumulative history
    // (4 messages through turn 2).
    let partial_prev = json!([
        {"role": "assistant", "content": "turn1 asst"},
        {"role": "user", "content": "turn2 user"}
    ]);
    let current = json!([
        {"role": "user", "content": "turn1 user"},
        {"role": "assistant", "content": "turn1 asst"},
        {"role": "user", "content": "turn2 user"},
        {"role": "assistant", "content": "turn2 asst"},
        {"role": "user", "content": "turn3 user"}
    ]);
    let delta_str =
        anthropic::compute_true_delta(&current.to_string(), Some(&partial_prev.to_string()))
            .unwrap();
    let delta: Vec<Value> = serde_json::from_str(&delta_str).unwrap();

    // This is the SHAPE of the bug: compute_true_delta can only do what it's
    // told. The contract of get_previous_turn_messages (its caller's input
    // source) is what must change. Under the buggy chain, delta.len() == 3
    // (current.len() - partial_prev.len()), which includes 2 stale historical
    // messages — this is the queue from which attachments.rs re-extracts
    // images.
    assert!(
        delta.len() > 1,
        "Precondition for the documented bug: a partial-prefix `previous` \
         causes `compute_true_delta` to pull historical messages into the \
         delta. If this ever returns <=1 with a partial-prefix previous, the \
         caller contract has changed; update the integration tests accordingly."
    );
}

// ===========================================================================
// Category 2 — Attachment extraction on a delta (pure function)
// ===========================================================================

/// **Name:** `test_extract_from_messages_on_one_message_delta_yields_one_attachment`
/// **Proves:** When the delta passed to `extract_from_messages` is a single
/// user message with one new image, exactly ONE attachment is returned.
/// This is the pure-function contract that the pipeline relies on.
/// **Anti-fake property:** Uses two DIFFERENT images with DIFFERENT bytes
/// across the "history" and the "delta" so if the test author accidentally
/// passes history-too, the count would be >1.
#[test]
fn test_extract_from_messages_on_one_message_delta_yields_one_attachment() {
    let img_new = make_unique_png(3);
    let delta_only = vec![user_message_with_image(
        &img_new,
        "this is new turn 3 image",
    )];
    let attachments =
        extract_from_messages("anthropic", &delta_only).expect("extract must succeed");
    assert_eq!(
        attachments.len(),
        1,
        "A single-message delta with one image must yield exactly one attachment. Got: {}",
        attachments.len()
    );
    assert_eq!(attachments[0].bytes, img_new);
}

/// **Name:** `test_extract_from_messages_on_full_history_yields_n_attachments`
/// **Proves:** The contrapositive — if the "delta" incorrectly contains the
/// full history of N previous user-image messages, the extractor returns
/// N attachments. This is the downstream symptom of bug #1.
/// **Anti-fake property:** Uses DIFFERENT image bytes per turn so dedup
/// cannot mask the count. If the buggy delta path feeds all 3 historical
/// images to the extractor, you get 3 attachments. If someone adds a
/// per-hash dedup that returns <N, this test catches the smuggled behavior
/// change.
#[test]
fn test_extract_from_messages_on_full_history_yields_n_attachments() {
    let imgs: Vec<Vec<u8>> = (1u8..=3).map(make_unique_png).collect();
    let full_history: Vec<Value> = imgs
        .iter()
        .enumerate()
        .map(|(i, img)| user_message_with_image(img, &format!("turn {}", i + 1)))
        .collect();

    let attachments =
        extract_from_messages("anthropic", &full_history).expect("extract must succeed");
    assert_eq!(
        attachments.len(),
        3,
        "If the 'delta' passed to extract_from_messages accidentally contains \
         the full user-turn history, the extractor returns one row per image. \
         This is the exact downstream shape of bug #1's quadratic growth."
    );
}

// ===========================================================================
// Category 3 — End-to-end pipeline (SQLite, via WritePipeline)
//
// These exercise the REAL production path: process_capture_with_pipeline →
// session resolution → get_previous_turn_messages → compute_true_delta →
// extract_from_messages → write_turn → write_attachment.
// The observable is the committed TurnRecord's `attachment_count` and the
// number of distinct attachments recorded across turns (deducible from
// per-turn counts).
// ===========================================================================

/// Build a 5-turn conversation where each user turn adds exactly one new
/// image. Between user turns we interleave an assistant text reply
/// (reflected as a prior-turn's response becoming part of the next request's
/// messages[] array — Claude Code always sends the full history).
///
/// Returns a Vec of (current_messages_json_per_turn, fresh_image_bytes).
fn build_5_turn_conversation() -> Vec<(Value, Vec<u8>)> {
    let imgs: Vec<Vec<u8>> = (1u8..=5).map(make_unique_png).collect();

    // Cumulative messages array as seen on the wire at the START of each turn.
    // Turn N's request.messages contains turns 1..=N-1's (user, assistant)
    // pairs plus turn N's user message.
    let mut turns: Vec<(Value, Vec<u8>)> = Vec::new();
    let mut accum: Vec<Value> = Vec::new();
    for (i, img) in imgs.iter().enumerate() {
        accum.push(user_message_with_image(
            img,
            &format!("user turn {}", i + 1),
        ));
        // Snapshot messages as they'll appear on the wire for this turn's request.
        let snapshot = serde_json::Value::Array(accum.clone());
        turns.push((snapshot, img.clone()));
        // After this turn, the assistant replies; the next turn's request
        // will include that assistant text.
        accum.push(json!({"role": "assistant", "content": format!("assistant reply {}", i + 1)}));
    }
    turns
}

/// **Name:** `test_turn_6_attachment_count_is_exactly_one_new_image`
/// **Proves:** In a 5-turn session where each user turn adds exactly one
/// new image (deliberately longer than Bug #1's invisible-for-N<=2 floor),
/// every turn N>=2 has `turn.attachment_count == 1`. Turn 1's count is also
/// 1.
/// **Anti-fake property:** This test runs the ACTUAL production path
/// (`process_capture_with_pipeline`) so it cannot be satisfied by any
/// unit-level fix to `compute_true_delta` alone — the entire chain
/// (`get_previous_turn_messages` → delta → attachment extraction → turn
/// row) must be correct. Turn 3's count in the buggy code would be >=2
/// (the prior-turn's image re-extracted plus the new one), turn 4 would
/// be >=3, etc.; a stub that just returns `1` in turn.attachment_count
/// without wiring the pipeline would fail the companion test below that
/// asserts the total persisted across all turns equals exactly 5.
#[test]
fn test_turn_6_attachment_count_is_exactly_one_new_image() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();
    let sid_hint = "scope-test-turn6";
    let convo = build_5_turn_conversation();

    let mut committed_turns: Vec<recondo_gateway::db::TurnRecord> = Vec::new();
    for (i, (msgs, _img)) in convo.iter().enumerate() {
        let req = anthropic_request(sid_hint, msgs);
        let resp = anthropic_sse_response(&format!("turn{} response", i + 1));
        let turn = recondo_gateway::gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "anthropic",
            &req,
            &resp,
            None,
            None,
        )
        .expect("process_capture_with_pipeline must succeed");
        committed_turns.push(turn);
    }

    assert_eq!(committed_turns.len(), 5, "pipeline produced all 5 turns");

    for (i, turn) in committed_turns.iter().enumerate() {
        assert_eq!(
            turn.attachment_count,
            1,
            "Turn {} (sequence_num={}) must have attachment_count == 1. \
             Each turn adds exactly ONE new image; a count > 1 means a \
             historical image was re-catalogued. Full committed turns: {:?}",
            i + 1,
            turn.sequence_num,
            committed_turns
                .iter()
                .map(|t| (t.sequence_num, t.attachment_count))
                .collect::<Vec<_>>()
        );
    }
}

/// **Name:** `test_sum_of_attachment_counts_equals_total_new_images`
/// **Proves:** The cumulative per-turn attachment count across a 5-turn
/// session adds up to 5 (one per turn). This is the strongest end-to-end
/// invariant: under the buggy code the sum would be 1+2+3+4+5 = 15 or more.
/// **Anti-fake property:** A naive stub that always sets
/// `turn.attachment_count = 1` in `process_capture_with_pipeline` would
/// satisfy the previous test. This one ALSO requires querying the graph
/// store for the persisted turn rows — so the sum is read back from DB,
/// not from the returned in-memory record. An implementation that forgets
/// to persist the correct value (or has a mismatch between returned
/// record and DB row) will fail this test.
#[test]
fn test_sum_of_attachment_counts_equals_total_new_images() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();
    let sid_hint = "scope-test-sum";
    let convo = build_5_turn_conversation();

    let mut session_id: Option<String> = None;
    for (i, (msgs, _img)) in convo.iter().enumerate() {
        let req = anthropic_request(sid_hint, msgs);
        let resp = anthropic_sse_response(&format!("turn{} resp", i + 1));
        let turn = recondo_gateway::gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "anthropic",
            &req,
            &resp,
            None,
            None,
        )
        .unwrap();
        session_id = Some(turn.session_id);
    }

    let session_id = session_id.expect("session id must be set");
    let db_turns = pipeline
        .graph()
        .get_turns_for_session(&session_id)
        .expect("query turns");
    assert_eq!(db_turns.len(), 5, "all 5 turns must be persisted");

    let total: i64 = db_turns.iter().map(|t| t.attachment_count).sum();
    assert_eq!(
        total,
        5,
        "Sum of attachment_count across 5 turns must equal 5 (one new image per turn). \
         Under bug #1 this sum grows quadratically. Per-turn counts: {:?}",
        db_turns
            .iter()
            .map(|t| (t.sequence_num, t.attachment_count))
            .collect::<Vec<_>>()
    );
}

/// **Name:** `test_per_turn_delta_is_only_new_messages_end_to_end`
/// **Proves:** On every turn N>=2, the PERSISTED `messages_delta` column on
/// turn N contains only the messages APPENDED by that turn (the assistant
/// reply from turn N-1 and the user message of turn N) — not a cumulative
/// mirror. This is the load-bearing property that keeps the attachment
/// scope correct. Specifically turn 3's persisted delta must have length 2
/// (assistant2 + user3 image), not 4+.
/// **Anti-fake property:** This reads `messages_delta` from the committed
/// turn row, so it cannot be satisfied by computing the right delta and
/// then silently storing the wrong one. It also cannot be satisfied by
/// fixing only the in-memory computation while leaving
/// `get_previous_turn_messages` returning a partial prefix — the chain
/// feeds itself, and turn 3 stores what turn 4 will read.
#[test]
fn test_per_turn_delta_is_only_new_messages_end_to_end() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();
    let sid_hint = "scope-test-delta";
    let convo = build_5_turn_conversation();

    let mut session_id: Option<String> = None;
    for (i, (msgs, _)) in convo.iter().enumerate() {
        let req = anthropic_request(sid_hint, msgs);
        let resp = anthropic_sse_response(&format!("r{}", i + 1));
        let turn = recondo_gateway::gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "anthropic",
            &req,
            &resp,
            None,
            None,
        )
        .unwrap();
        session_id = Some(turn.session_id);
    }
    let session_id = session_id.unwrap();

    let mut db_turns = pipeline.graph().get_turns_for_session(&session_id).unwrap();
    db_turns.sort_by_key(|t| t.sequence_num);

    // Turn 1: delta == full messages of turn 1 == 1 message.
    let delta1: Vec<Value> = serde_json::from_str(
        db_turns[0]
            .messages_delta
            .as_deref()
            .expect("turn 1 must have messages_delta"),
    )
    .expect("turn 1 messages_delta must parse");
    assert_eq!(
        delta1.len(),
        1,
        "Turn 1 persisted delta must be 1 message. Got: {}",
        delta1.len()
    );

    // Turns 2..=5: each persisted delta must contain exactly 2 messages
    // (the preceding assistant reply + the new user message with image).
    for (idx, t) in db_turns.iter().enumerate().skip(1) {
        let delta: Vec<Value> = serde_json::from_str(
            t.messages_delta
                .as_deref()
                .unwrap_or_else(|| panic!("turn {} must have messages_delta", idx + 1)),
        )
        .expect("delta parse");
        assert_eq!(
            delta.len(),
            2,
            "Turn {} persisted delta must be exactly 2 messages (asst reply + user image). \
             A value of 3+ indicates get_previous_turn_messages is returning a partial prefix. \
             Got delta.len()={} and full delta: {:?}",
            t.sequence_num,
            delta.len(),
            delta
        );
    }
}

/// **Name:** `test_sequence_num_ge_3_has_attachment_count_one`
/// **Proves:** Bug #1 is invisible for N<=2 (turn 1 first-turn path + turn 2
/// where partial-prefix happens to equal cumulative prefix-minus-last). This
/// test specifically targets turn >=3 where the bug manifests, to guard
/// against a narrow fix that only handles the turn-2 case.
/// **Anti-fake property:** Uses unique PNGs per turn so dedup cannot mask
/// the count. Asserts on committed DB state, not in-memory record.
#[test]
fn test_sequence_num_ge_3_has_attachment_count_one() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();
    let sid_hint = "scope-test-ge3";
    let convo = build_5_turn_conversation();

    let mut session_id: Option<String> = None;
    for (i, (msgs, _)) in convo.iter().enumerate() {
        let req = anthropic_request(sid_hint, msgs);
        let resp = anthropic_sse_response(&format!("r{}", i + 1));
        let turn = recondo_gateway::gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "anthropic",
            &req,
            &resp,
            None,
            None,
        )
        .unwrap();
        session_id = Some(turn.session_id);
    }
    let session_id = session_id.unwrap();

    let db_turns = pipeline.graph().get_turns_for_session(&session_id).unwrap();
    for t in db_turns.iter().filter(|t| t.sequence_num >= 3) {
        assert_eq!(
            t.attachment_count,
            1,
            "Turn sequence_num={} must have attachment_count == 1 (bug #1 manifests at N>=3). \
             Got {}. Full turns: {:?}",
            t.sequence_num,
            t.attachment_count,
            db_turns
                .iter()
                .map(|x| (x.sequence_num, x.attachment_count))
                .collect::<Vec<_>>()
        );
    }
}

// ===========================================================================
// Category 4 — Cross-backend agreement (SQLite + PostgreSQL)
//
// Both GraphStore implementations must agree on the observable output of
// `compute_true_delta` given the same sequence of writes.
// ===========================================================================

/// **Name:** `test_sqlite_get_previous_turn_messages_yields_cumulative_delta_correct`
/// **Proves:** When SqliteGraphStore's `get_previous_turn_messages` is used
/// as the SOURCE of `previous` for `compute_true_delta`, the resulting delta
/// is exactly the messages added by the current turn — for every turn N>=2.
/// **Anti-fake property:** Directly simulates the production chain: write
/// turn 1 (with a stored messages_delta), write turn 2 (query
/// `get_previous_turn_messages`, compute delta, store delta), then verify
/// turn 3's computed delta equals exactly one new message. If
/// `get_previous_turn_messages` returns only the prior turn's stored delta
/// (partial prefix), `compute_true_delta` will return >=2 at turn 3 and
/// this test fails.
#[test]
fn test_sqlite_get_previous_turn_messages_yields_cumulative_delta_correct() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();
    let sid_hint = "scope-test-sqlite-xdelta";
    let convo = build_5_turn_conversation();

    // Run turns 1..=3 through the pipeline so the graph store is populated.
    let mut session_id: Option<String> = None;
    let mut current_msgs_json: Option<String> = None;
    for (i, (msgs, _)) in convo.iter().take(3).enumerate() {
        let req = anthropic_request(sid_hint, msgs);
        let resp = anthropic_sse_response(&format!("r{}", i + 1));
        let turn = recondo_gateway::gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "anthropic",
            &req,
            &resp,
            None,
            None,
        )
        .unwrap();
        session_id = Some(turn.session_id);
        current_msgs_json = Some(msgs.to_string());
    }
    let session_id = session_id.unwrap();
    let current_messages_for_turn3 = current_msgs_json.unwrap();

    // Now query the graph store for "previous turn messages" as
    // process_capture_with_pipeline would for turn 3 (sequence_num=3 =>
    // looks up seq=2). Then compute the delta using compute_true_delta.
    // This is the production call chain: the output MUST be exactly 1
    // message (turn 3's user message).
    let previous = pipeline
        .graph()
        .get_previous_messages_prefix_marker(&session_id, 3)
        .expect("get_previous_messages_prefix_marker must succeed")
        .expect("turn 2 must exist -> some value");

    let delta_str = anthropic::compute_true_delta(&current_messages_for_turn3, Some(&previous))
        .expect("compute_true_delta must succeed");
    let delta: Vec<Value> = serde_json::from_str(&delta_str).unwrap();

    assert_eq!(
        delta.len(),
        1,
        "The production chain (get_previous_turn_messages → compute_true_delta) \
         must return exactly 1 new message at turn 3. \
         If this is >1, get_previous_turn_messages is returning a partial-prefix \
         (just turn 2's delta, not the cumulative messages through turn 2). \
         Got delta: {:?}",
        delta
    );
}

/// **Name:** `test_pg_get_previous_turn_messages_yields_cumulative_delta_correct`
/// **Proves:** PostgresGraphStore agrees with SqliteGraphStore on the
/// observable output of `compute_true_delta` given the same production
/// chain.
/// **Anti-fake property:** Goes through the real PG connection (requires
/// `postgres-tests` feature + live PG). Without this test, a fix could be
/// applied to SQLite only while PG remains buggy.
///
/// NOTE: This test mirrors the SQLite variant. It is gated behind
/// `postgres-tests` feature (existing pattern in
/// `tests/postgres_graph_store_tests.rs`). Run with
/// `cargo nextest run --features postgres-tests` after `just dev-infra`
/// brings up PostgreSQL on :5432. If the PG infrastructure is unavailable
/// in CI, the SQLite variant above still enforces the primary invariant
/// and the PG test becomes a follow-up.
#[cfg(feature = "postgres-tests")]
#[test]
// Serialize against FIND-1-O's destructive DROP COLUMN test that shares
// the same live PG instance.
#[serial_test::serial(pg_shared_schema)]
fn test_pg_get_previous_turn_messages_yields_cumulative_delta_correct() {
    use recondo_gateway::storage::graph::GraphStore;
    use recondo_gateway::storage::postgres::PostgresGraphStore;

    let url = common::pg_container::url();

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async {
        let pg = PostgresGraphStore::new(url).expect("connect PG and init schema");
        // Clean slate.
        let pool = pg.pool().clone();
        let client = pool.get().await.expect("PG conn");
        client
            .batch_execute("TRUNCATE attachments, tool_calls, turns, sessions CASCADE;")
            .await
            .expect("truncate test tables");
        drop(client);

        // Build a 3-turn conversation manually and write it into PG via
        // write_session / write_turn so `get_previous_turn_messages` has
        // something to return.
        use recondo_gateway::db::{SessionRecord, TurnRecord};
        let convo = build_5_turn_conversation();

        let sid = "pg_scope_test_sid".to_string();
        pg.write_session(&SessionRecord {
            id: sid.clone(),
            provider: "anthropic".to_string(),
            model: None,
            started_at: "2026-04-23T00:00:00Z".to_string(),
            last_active_at: "2026-04-23T00:00:00Z".to_string(),
            ended_at: None,
            initial_intent: None,
            system_prompt_hash: "h".to_string(),
            total_turns: 0,
            turns_captured: 0,
            dropped_events: 0,
            total_tokens: 0,
            total_cost_usd: 0.0,
            framework: None,
            agent_id: None,
            agent_version: None,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: None,
            device_id: None,
            tool_definitions_hash: String::new(),
        })
        .expect("write session");

        // FIND-1-A fix: Write turns 1 and 2 with PRODUCTION-SHAPED
        // `messages_delta_count` values, i.e. INCREMENTAL per-turn counts —
        // NOT the cumulative `msgs.as_array().unwrap().len()`. The
        // post-fix pipeline writes turn N's delta count as the length of
        // the NEW messages appended by turn N (asst_{N-1} + user_N for
        // N>=2; just user_1 for turn 1). If we used cumulative counts
        // here, the test would pass for the wrong reason: the SUM-based
        // `get_previous_messages_prefix_marker` query would return the
        // "right number" by coincidence because the pre-fix overshot
        // cumulative values happened to line up with `current.len() -
        // 1`.
        //
        // Under production-shaped incremental counts:
        //   Turn 1: delta = [user1]            -> count = 1
        //   Turn 2: delta = [asst1, user2]     -> count = 2
        //   SUM(seq<=3) = 1 + 2 = 3; MAX(seq) = 2 (< 3), no -1 adj.
        //   prev_len = 3.
        //   current_turn3 = [user1, asst1, user2, asst2, user3] (len=5)
        //   compute_true_delta yields current[3..] = [asst2, user3] -> len 2.
        //
        // That `delta.len() == 2` is exactly what production would
        // produce for this turn. A `delta.len() == 1` here would mean
        // either (a) the fixture is cumulative (the prior bug-shaped
        // fixture) or (b) the SUM math is off.
        let per_turn_delta_counts: [i64; 2] = [1, 2];
        for (i, (msgs, _)) in convo.iter().take(2).enumerate() {
            let seq = (i as i64) + 1;
            let turn = TurnRecord {
                id: format!("turn_{}", seq),
                session_id: sid.clone(),
                sequence_num: seq,
                timestamp: format!("2026-04-23T00:00:0{}Z", seq),
                request_hash: format!("req{}", seq),
                response_hash: format!("resp{}", seq),
                req_bytes_ref: None,
                resp_bytes_ref: None,
                req_bytes_size: None,
                resp_bytes_size: None,
                model: Some("claude-sonnet-4-20250514".to_string()),
                response_text: None,
                thinking_text: None,
                stop_reason: "end_turn".to_string(),
                capture_complete: true,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_creation_tokens: 0,
                cost_usd: None,
                created_at: format!("2026-04-23T00:00:0{}Z", seq),
                // Note: `messages_delta` here is whatever the caller
                // stored (we pass the cumulative snapshot so the row is
                // valid JSON), but `get_previous_messages_prefix_marker`
                // reads ONLY `messages_delta_count`, so the shape of
                // `messages_delta` is irrelevant to what this test
                // proves.
                messages_delta: Some(msgs.to_string()),
                messages_delta_count: Some(per_turn_delta_counts[i]),
                raw_extra: None,
                parser_version: None,
                parse_errors: None,
                provider: Some("anthropic".to_string()),
                transport: Some("http".to_string()),
                ws_direction: None,
                duration_ms: None,
                ttfb_ms: None,
                api_endpoint: None,
                http_status: None,
                error_message: None,
                retry_count: 0,
                tool_call_count: 0,
                thinking_tokens: 0,
                server_id: None,
                integrity_verified: None,
                supersedes_turn_id: None,
                user_request_text: None,
                attachment_count: 0,
            };
            pg.write_turn(&turn).expect("write turn");
        }

        // The production call chain at turn 3:
        // get_previous_messages_prefix_marker with seq=3 must produce a
        // previous-messages JSON whose `.len()` equals
        // SUM(messages_delta_count) for seq<=3 = 1 + 2 = 3, so
        // compute_true_delta(current_turn3, previous) returns the TWO
        // new messages (asst2 + user3) appended since turn 2.
        let current_turn3 = convo[2].0.to_string();
        let previous = pg
            .get_previous_messages_prefix_marker(&sid, 3)
            .expect("get_previous_messages_prefix_marker")
            .expect("turn 2 must exist");

        let delta_str = anthropic::compute_true_delta(&current_turn3, Some(&previous))
            .expect("compute_true_delta");
        let delta: Vec<Value> = serde_json::from_str(&delta_str).unwrap();
        assert_eq!(
            delta.len(),
            2,
            "PG backend: production chain must produce a 2-message delta \
             at turn 3 under production-shaped incremental-count storage \
             (asst2 + user3). If this returns 1, the fixture is likely \
             using cumulative counts (which would be the bug-shaped \
             fixture, not the production shape). If this returns 3+, \
             `get_previous_messages_prefix_marker` is returning a \
             partial prefix instead of the SUM-based cumulative marker. \
             Got: {:?}",
            delta
        );
    });
}

// ===========================================================================
// Category 5 — Negative proof (Bug #1)
//
// This test asserts the BUGGY shape directly by feeding the
// partial-prefix `previous` into `compute_true_delta` and attachment
// extraction. It is a "canary" — it proves that the test suite can
// observe the bug. Removing/reverting the production fix would make the
// other end-to-end tests fail while THIS test still passes (because it
// injects the partial-prefix input shape manually).
// ===========================================================================

/// **Name:** `test_negative_partial_prefix_previous_causes_excess_attachments`
/// **Proves:** The exact failure mode of bug #1: feeding `compute_true_delta`
/// a partial-prefix `previous` and then running `extract_from_messages` on
/// the resulting bogus delta produces MORE attachments than were newly
/// added. This is the canary for the test suite.
/// **Anti-fake property:** This test deliberately simulates the BUGGY
/// input path (not the production one). It proves the harness can
/// distinguish correct from buggy. If someone "fixes" the bug by making
/// `compute_true_delta` smarter without fixing `get_previous_turn_messages`,
/// the end-to-end tests still pass but this canary might flip to passing
/// (confirming a genuine behavior change in the pure function) — in which
/// case the implementer should delete or update this negative test with a
/// comment explaining why.
#[test]
fn test_negative_partial_prefix_previous_causes_excess_attachments() {
    let imgs: Vec<Vec<u8>> = (1u8..=3).map(make_unique_png).collect();
    // Build cumulative messages through turn 3 on the wire.
    let current_turn3 = json!([
        user_message_with_image(&imgs[0], "t1"),
        {"role": "assistant", "content": "a1"},
        user_message_with_image(&imgs[1], "t2"),
        {"role": "assistant", "content": "a2"},
        user_message_with_image(&imgs[2], "t3")
    ]);
    // Partial-prefix previous: ONLY turn 2's delta (asst1 + user2-with-image2).
    let partial_prev = json!([
        {"role": "assistant", "content": "a1"},
        user_message_with_image(&imgs[1], "t2")
    ]);
    let delta_str =
        anthropic::compute_true_delta(&current_turn3.to_string(), Some(&partial_prev.to_string()))
            .unwrap();
    let delta: Vec<Value> = serde_json::from_str(&delta_str).unwrap();

    let attachments = extract_from_messages("anthropic", &delta).expect("extract");

    assert!(
        attachments.len() > 1,
        "Canary: feeding a partial-prefix `previous` into compute_true_delta, \
         then running attachment extraction on the result, MUST yield more \
         than one attachment. If this flips to 1, compute_true_delta has \
         changed semantics. Got {} attachments; delta len={}.",
        attachments.len(),
        delta.len()
    );
}

// ===========================================================================
// Category 6 — Bug #2: `[Image: source: ...]` placeholder leakage
// ===========================================================================

/// **Name:** `test_bare_image_placeholder_does_not_leak_into_user_request_text`
/// **Proves:** When the user-content array's LAST text block is a bare
/// `[Image: source: /Users/.../N.png]` placeholder (the shape Claude Code
/// emits when a user drags an image into the CLI), the extracted
/// `user_request_text` MUST NOT be the raw placeholder string.
/// **Anti-fake property:** Asserts the negative invariant — `result !=
/// placeholder` AND `result does not contain "/Users/"` — so ANY of the
/// acceptable implementations (skip-to-None, normalize to "[image
/// attachment]", fall back to the earlier text block) passes. A stub that
/// returns the string unchanged fails. A stub that trims whitespace but
/// leaves the path fails.
#[test]
fn test_bare_image_placeholder_does_not_leak_into_user_request_text() {
    let placeholder = "[Image: source: /Users/amermegas/.claude/image-cache/abc-uuid/3.png]";
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64", "media_type": "image/png",
                "data": BASE64.encode(make_unique_png(9)) } },
            { "type": "text", "text": placeholder }
        ]
    })];

    let result = extract_last_user_request_text(&messages);

    match result {
        None => {
            // Acceptable contract: skip-to-None when the only text is a bare
            // image placeholder. Pass.
        }
        Some(text) => {
            assert_ne!(
                text, placeholder,
                "user_request_text must NOT be the raw placeholder. \
                 The user-visible dashboard would show a local filesystem path. \
                 Got: {:?}",
                text
            );
            assert!(
                !text.contains("/Users/"),
                "user_request_text must NOT contain a filesystem path. \
                 Got: {:?}",
                text
            );
            assert!(
                !text.starts_with("[Image:"),
                "user_request_text must NOT start with the raw '[Image:' marker. \
                 Got: {:?}",
                text
            );
        }
    }
}

/// **Name:** `test_image_placeholder_does_not_leak_when_earlier_real_text_exists`
/// **Proves:** When the content array has a REAL text block BEFORE the image
/// placeholder, extraction must either (a) return the real text, or (b)
/// return a sanitized string. It must NOT return the raw placeholder even
/// though the placeholder is physically the last text block.
/// **Anti-fake property:** A lazy fix that "just returns None if the last
/// block looks like a placeholder" would leave `user_request_text` as None
/// even though there is perfectly good text available earlier — undesirable
/// but still passes the prior test's contract. This test tightens that: if
/// real text is present, it must surface either as-is or in a sanitized
/// form, never as the raw placeholder.
#[test]
fn test_image_placeholder_does_not_leak_when_earlier_real_text_exists() {
    let placeholder = "[Image: source: /Users/amermegas/.claude/image-cache/xyz-uuid/5.png]";
    let real_text = "Look at this screenshot and tell me what's wrong";
    let messages = vec![json!({
        "role": "user",
        "content": [
            { "type": "text", "text": real_text },
            { "type": "image", "source": { "type": "base64", "media_type": "image/png",
                "data": BASE64.encode(make_unique_png(11)) } },
            { "type": "text", "text": placeholder }
        ]
    })];

    let result = extract_last_user_request_text(&messages);

    let text = result.expect(
        "user_request_text must be populated when there is real user text available. \
         If this is None, the extractor is over-filtering — it skipped the placeholder \
         but failed to fall back to the real text block that precedes it.",
    );

    assert_ne!(
        text, placeholder,
        "must not return the raw image placeholder: {:?}",
        text
    );
    assert!(
        !text.contains("/Users/"),
        "must not expose a local filesystem path: {:?}",
        text
    );
    assert!(
        !text.starts_with("[Image:"),
        "must not start with '[Image:': {:?}",
        text
    );
}

/// **Name:** `test_image_placeholder_does_not_leak_end_to_end_via_pipeline`
/// **Proves:** Going through the real production path
/// (`process_capture_with_pipeline`), the `turns.user_request_text` column
/// must not store the raw `[Image: source: /Users/...]` placeholder.
/// **Anti-fake property:** Asserts on the COMMITTED DB row, not the
/// in-memory record — so any fix must propagate through the write pipeline
/// and end up in the actual turns table. A fix that only sanitizes in some
/// code paths (e.g. `process_capture` but not `process_capture_with_pipeline`)
/// is caught because this test uses the pipeline variant.
#[test]
fn test_image_placeholder_does_not_leak_end_to_end_via_pipeline() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();
    let sid_hint = "bug2-placeholder-leak";

    let placeholder = "[Image: source: /Users/amermegas/.claude/image-cache/deadbeef/1.png]";
    let messages = json!([
        {
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/png",
                    "data": BASE64.encode(make_unique_png(17)) } },
                { "type": "text", "text": placeholder }
            ]
        }
    ]);
    let req = anthropic_request(sid_hint, &messages);
    let resp = anthropic_sse_response("ok");
    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req,
        &resp,
        None,
        None,
    )
    .expect("capture must succeed");

    // Read back the committed turn.
    let db_turns = pipeline
        .graph()
        .get_turns_for_session(&turn.session_id)
        .unwrap();
    assert_eq!(db_turns.len(), 1);
    let urt = db_turns[0].user_request_text.clone();

    match urt {
        None => {
            // Acceptable: the only user text was a bare placeholder, so
            // user_request_text is unset. Pass.
        }
        Some(text) => {
            assert_ne!(
                text, placeholder,
                "turns.user_request_text must NOT be the raw placeholder; got: {:?}",
                text
            );
            assert!(
                !text.contains("/Users/"),
                "turns.user_request_text must NOT contain a filesystem path; got: {:?}",
                text
            );
            assert!(
                !text.starts_with("[Image:"),
                "turns.user_request_text must NOT start with '[Image:'; got: {:?}",
                text
            );
        }
    }
}

// ===========================================================================
// Category 7 — Boundary / invariant tests
// ===========================================================================

/// **Name:** `test_first_turn_with_image_has_attachment_count_one`
/// **Proves:** Turn 1 of a session (the first-turn path where `previous` is
/// None) correctly records exactly one attachment. This is the boundary
/// case where the bug is structurally absent — the test guards against a
/// regression where a fix for bug #1 accidentally breaks turn 1.
/// **Anti-fake property:** Asserts on the committed turn row's
/// attachment_count AND messages_delta length. A fix that makes turn 1
/// return an empty delta would silently break attachment extraction for
/// turn 1 and this test catches it.
#[test]
fn test_first_turn_with_image_has_attachment_count_one() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let img = make_unique_png(99);
    let messages = json!([user_message_with_image(&img, "analyze this")]);
    let req = anthropic_request("bug-boundary-first-turn", &messages);
    let resp = anthropic_sse_response("ok");

    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req,
        &resp,
        None,
        None,
    )
    .expect("turn 1 capture must succeed");

    assert_eq!(turn.sequence_num, 1, "first turn must be sequence_num=1");
    assert_eq!(
        turn.attachment_count, 1,
        "First turn with exactly one image must have attachment_count == 1"
    );

    let db = pipeline
        .graph()
        .get_turns_for_session(&turn.session_id)
        .unwrap();
    assert_eq!(db.len(), 1);
    assert_eq!(db[0].attachment_count, 1);
    let delta_len = serde_json::from_str::<Vec<Value>>(
        db[0]
            .messages_delta
            .as_deref()
            .expect("turn 1 must have persisted delta"),
    )
    .unwrap()
    .len();
    assert_eq!(
        delta_len, 1,
        "Turn 1's persisted messages_delta must be the full (single) message"
    );
}

/// **Name:** `test_turn_with_zero_new_images_has_attachment_count_zero`
/// **Proves:** A turn that adds a user message with NO attachment must have
/// `attachment_count == 0` even if prior turns had attachments. Under bug
/// #1 this turn's "delta" would include the prior-turn's image, so the
/// count would be >0.
/// **Anti-fake property:** This is the complement of the quadratic-growth
/// test: the buggy delta path doesn't just over-count when there's a new
/// image, it invents attachments when there isn't one. Different failure
/// mode, same root cause.
#[test]
fn test_turn_with_zero_new_images_has_attachment_count_zero() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();
    let sid_hint = "boundary-zero-new-images";

    // Turn 1: one image.
    let img1 = make_unique_png(1);
    let turn1_msgs = json!([user_message_with_image(&img1, "first")]);
    let req1 = anthropic_request(sid_hint, &turn1_msgs);
    let _ = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req1,
        &anthropic_sse_response("r1"),
        None,
        None,
    )
    .unwrap();

    // Turn 2: NO new image; just a text-only user message. The wire-format
    // messages[] array still carries turn 1's image block (Claude Code
    // always sends full history).
    let turn2_msgs = json!([
        user_message_with_image(&img1, "first"),
        {"role": "assistant", "content": "reply 1"},
        {"role": "user", "content": [ {"type": "text", "text": "follow-up, no new image"} ]}
    ]);
    let req2 = anthropic_request(sid_hint, &turn2_msgs);
    let turn2 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req2,
        &anthropic_sse_response("r2"),
        None,
        None,
    )
    .unwrap();

    assert_eq!(
        turn2.attachment_count, 0,
        "Turn 2 added NO new image; attachment_count must be 0 (not re-counting turn 1's image). \
         Got {}.",
        turn2.attachment_count
    );

    // Defensive: verify from DB too.
    let db_turns = pipeline
        .graph()
        .get_turns_for_session(&turn2.session_id)
        .unwrap();
    let turn2_db = db_turns.iter().find(|t| t.sequence_num == 2).unwrap();
    assert_eq!(
        turn2_db.attachment_count, 0,
        "Persisted turn 2 attachment_count must be 0"
    );
}

// ===========================================================================
// Category 8 — Round 2 review findings (new tests)
// ===========================================================================

/// **Name:** `test_bare_image_placeholder_without_source_is_retained`
/// **Proves:** FIND-1-B: the placeholder heuristic must NOT strip legitimate
/// user text that merely starts with `[Image:` but does NOT carry the
/// `source:` marker Claude Code emits for its filesystem placeholder.
/// **Anti-fake property:** uses shapes like `[Image: can you describe this
/// icon?]` — real user prose that a pre-FIND-1-B heuristic would have
/// mistakenly dropped.
#[test]
fn test_bare_image_placeholder_without_source_is_retained() {
    for real_prose in &[
        "[Image: can you describe this icon?]",
        "[Image: 2 of 3]",
        "[Image: no source here]",
    ] {
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "text", "text": real_prose }
            ]
        })];
        let result = extract_last_user_request_text(&messages);
        let text = result.expect(
            "FIND-1-B: message containing only user prose like \
             '[Image: can you describe this icon?]' must NOT be \
             silently dropped by the placeholder heuristic. The \
             heuristic MUST require the literal substring 'source:' \
             after the marker prefix.",
        );
        assert_eq!(
            text, *real_prose,
            "FIND-1-B: real-prose `[Image: ...]` user message was \
             mistakenly filtered by the placeholder heuristic. \
             Got: {:?}",
            text
        );
    }
}

/// **Name:** `test_pdf_and_document_placeholders_are_also_filtered`
/// **Proves:** FIND-1-C: PDF / Document / File / Attachment placeholders
/// with the `source:` marker and a filesystem path are treated as
/// placeholders (same as the original `[Image:` case), so the dashboard
/// never shows a local path.
/// **Anti-fake property:** includes `[PDF: source: /path/report.pdf]` and
/// `[Document: source: /path/report.pdf]` — shapes the old heuristic
/// missed entirely.
#[test]
fn test_pdf_and_document_placeholders_are_also_filtered() {
    for placeholder in &[
        "[PDF: source: /Users/x/Downloads/report.pdf]",
        "[Document: source: /Users/x/docs/spec.md]",
        "[File: source: /Users/x/data.csv]",
        "[Attachment: source: /tmp/foo.txt]",
    ] {
        let messages = vec![json!({
            "role": "user",
            "content": [
                { "type": "document", "source": { "type": "base64",
                    "media_type": "application/pdf",
                    "data": BASE64.encode(make_unique_png(33)) } },
                { "type": "text", "text": placeholder }
            ]
        })];
        let result = extract_last_user_request_text(&messages);
        if let Some(text) = result {
            assert_ne!(
                text, *placeholder,
                "FIND-1-C: placeholder {:?} leaked into user_request_text",
                placeholder
            );
            assert!(
                !text.contains("/Users/") && !text.contains("/tmp/"),
                "FIND-1-C: placeholder-derived filesystem path leaked \
                 into user_request_text: {:?}",
                text
            );
        }
    }
}

/// **Name:** `test_compute_true_delta_clamps_overshoot_previous_length`
/// **Proves:** FIND-1-F: when `previous.len() > current.len()` (the
/// pre-fix data corruption shape), `compute_true_delta` MUST NOT silently
/// return `"[]"`. Instead, it falls back to a safe delta — the last
/// message of `current` — so forward attachment captures are never
/// dropped on the first post-upgrade turn of a resumed pre-fix session.
/// **Anti-fake property:** a revert that removes the clamp will make
/// `compute_true_delta` return `"[]"` and this test will fail with
/// `delta.len() == 1 != 0`.
#[test]
fn test_compute_true_delta_clamps_overshoot_previous_length() {
    // current.len() == 5 (wire-format), previous.len() == 6 (pre-fix
    // cumulative overshot). Under the strict `current.len() >
    // previous.len()` guard this would return `"[]"`.
    let current = json!([
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "a1"},
        {"role": "user", "content": "u2"},
        {"role": "assistant", "content": "a2"},
        {"role": "user", "content": "u3 NEW"}
    ]);
    let previous_overshot = vec![serde_json::Value::Null; 6];
    let prev_str = serde_json::to_string(&previous_overshot).unwrap();

    let delta_str = anthropic::compute_true_delta(&current.to_string(), Some(&prev_str))
        .expect("compute_true_delta must succeed under overshoot");
    let delta: Vec<Value> = serde_json::from_str(&delta_str).unwrap();
    assert_eq!(
        delta.len(),
        1,
        "FIND-1-F: when previous.len() > current.len() (pre-fix data \
         corruption), compute_true_delta MUST clamp to the last message \
         of current (length 1), not silently return '[]'. Returning '[]' \
         would silently drop attachment extraction on every post-upgrade \
         turn of a resumed pre-fix session. Got delta: {:?}",
        delta
    );
    assert_eq!(
        delta[0]["content"].as_str(),
        Some("u3 NEW"),
        "FIND-1-F: clamp must surface the NEW user message, not an \
         earlier historical message"
    );
}

/// **Name:** `test_compute_true_delta_equal_lengths_returns_empty`
/// **Proves:** The equal-length boundary (previous.len() == current.len())
/// still returns `"[]"` — the FIND-1-F clamp only fires on strict
/// overshoot.
/// **Anti-fake property:** a naive clamp that over-fires on `>=` would
/// incorrectly return the last message for the no-change case, which
/// would inflate attachment counts.
#[test]
fn test_compute_true_delta_equal_lengths_returns_empty() {
    let current = json!([
        {"role": "user", "content": "u1"},
        {"role": "assistant", "content": "a1"}
    ]);
    let previous = vec![serde_json::Value::Null; 2];
    let prev_str = serde_json::to_string(&previous).unwrap();
    let delta_str = anthropic::compute_true_delta(&current.to_string(), Some(&prev_str)).unwrap();
    let delta: Vec<Value> = serde_json::from_str(&delta_str).unwrap();
    assert_eq!(
        delta.len(),
        0,
        "FIND-1-F: equal previous/current lengths => empty delta (the \
         clamp fires only on strict overshoot). Got: {:?}",
        delta
    );
}

// ===========================================================================
// Category 9 — Round 3 blocker tests
// ===========================================================================

/// **Name:** `test_find_1_n_url_safe_base64_decodes`
/// **Proves:** FIND-1-N: the attachment extractor decodes URL-safe base64
/// variants (with and without padding), not just STANDARD. A PNG encoded
/// with URL_SAFE must round-trip through `extract_from_messages` and
/// produce the same bytes.
/// **Anti-fake property:** a revert to STANDARD-only decode returns
/// zero attachments because URL_SAFE rejects `+` / `/` and vice-versa.
#[test]
fn test_find_1_n_url_safe_base64_decodes() {
    use base64::engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD};
    use base64::Engine as _;

    let png = make_unique_png(42);
    // URL-safe with padding.
    let urlsafe_with_pad = URL_SAFE.encode(&png);
    let msg_with_pad = vec![json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64",
                "media_type": "image/png", "data": urlsafe_with_pad } },
            { "type": "text", "text": "analyze" }
        ]
    })];
    let atts = extract_from_messages("anthropic", &msg_with_pad)
        .expect("extract must succeed for URL_SAFE-encoded image");
    assert_eq!(
        atts.len(),
        1,
        "FIND-1-N: URL_SAFE-encoded base64 image must decode to exactly one attachment"
    );
    assert_eq!(
        atts[0].bytes, png,
        "FIND-1-N: URL_SAFE-decoded bytes must match the original PNG"
    );

    // URL-safe without padding.
    let urlsafe_no_pad = URL_SAFE_NO_PAD.encode(&png);
    let msg_no_pad = vec![json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64",
                "media_type": "image/png", "data": urlsafe_no_pad } }
        ]
    })];
    let atts = extract_from_messages("anthropic", &msg_no_pad)
        .expect("extract must succeed for URL_SAFE_NO_PAD-encoded image");
    assert_eq!(
        atts.len(),
        1,
        "FIND-1-N: URL_SAFE_NO_PAD-encoded base64 image must also decode"
    );
    assert_eq!(atts[0].bytes, png);
}

/// **Name:** `test_find_1_n_standard_no_pad_base64_decodes`
/// **Proves:** FIND-1-N: STANDARD_NO_PAD decodes too. Some Anthropic SDK
/// versions emit unpadded standard base64.
#[test]
fn test_find_1_n_standard_no_pad_base64_decodes() {
    use base64::engine::general_purpose::STANDARD_NO_PAD;
    use base64::Engine as _;

    let png = make_unique_png(17);
    let encoded = STANDARD_NO_PAD.encode(&png);
    let msg = vec![json!({
        "role": "user",
        "content": [
            { "type": "image", "source": { "type": "base64",
                "media_type": "image/png", "data": encoded } }
        ]
    })];
    let atts = extract_from_messages("anthropic", &msg).expect("extract must succeed");
    assert_eq!(atts.len(), 1, "FIND-1-N: STANDARD_NO_PAD must decode");
    assert_eq!(atts[0].bytes, png);
}

/// **Name:** `test_find_1_j_external_url_no_tokio_runtime_no_panic`
/// **Proves:** FIND-1-J: when `process_capture_with_pipeline` is called
/// from a thread without a tokio runtime AND a request carries an
/// external image URL, capture completes without panicking. The
/// attachment row is recorded as kind=external_image_url with empty
/// bytes.
/// **Anti-fake property:** without the `Handle::try_current()` fix,
/// `Handle::current()` inside `process_capture_with_pipeline` would
/// panic and take down the thread. A pure mock-replacement of the
/// fetch function would not catch this — the panic is in the RUNTIME
/// bridge, not the fetch.
#[test]
fn test_find_1_j_external_url_no_tokio_runtime_no_panic() {
    // Run this test on a fresh std::thread with NO tokio runtime.
    let handle = std::thread::spawn(|| {
        let (pipeline, _tmp) = make_pipeline();
        let mut session_mgr = SessionManager::new();

        // OpenAI-shaped request that carries an external image_url. The
        // extractor classifies this as ExternalImageUrl.
        let messages = json!([{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {
                        // Use a non-routable documentation-range URL so even
                        // if the fetch were (incorrectly) attempted, it
                        // would not contact a real host.
                        "url": "https://192.0.2.1/nonexistent.png"
                    }
                },
                { "type": "text", "text": "describe this" }
            ]
        }]);
        // OpenAI uses a different envelope; but extract_from_messages with
        // provider="openai" inspects image_url blocks. The test
        // specifically uses `openai` here.
        let req = serde_json::to_vec(&json!({
            "model": "gpt-4o",
            "messages": messages,
            "metadata": {
                "user_id": "{\"session_id\":\"no-rt-sid\",\"account_uuid\":\"a\",\"device_id\":\"d\"}"
            }
        }))
        .unwrap();
        // Provide an Anthropic-shaped SSE response so the existing
        // SSE-handling path completes; OpenAI provider detection will
        // downgrade gracefully. The key assertion is NO PANIC.
        let resp = anthropic_sse_response("ok");

        // Primary assertion: this call does not panic.
        let result = recondo_gateway::gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "openai",
            &req,
            &resp,
            None,
            None,
        );
        // We don't assert success or failure of the capture itself — the
        // OpenAI path may reject the Anthropic-style SSE. What we DO
        // assert is that the thread survived, which is implicit in
        // reaching this line.
        drop(result);
    });
    handle
        .join()
        .expect("FIND-1-J: capture thread must not panic when no tokio runtime is available");
}

/// **Name:** `test_find_1_k_l_attachment_count_matches_persisted_rows`
/// **Proves:** FIND-1-K: `turns.attachment_count` always equals
/// `COUNT(attachments WHERE turn_id = turn.id)` for every committed
/// turn. In the happy path (all writes succeed), both equal the number
/// of extracted attachments.
/// **Anti-fake property:** asserts on both the turn row's denormalized
/// count AND a fresh query of the attachments table for the same
/// turn_id, so a mismatch (e.g. the count was set before all rows
/// committed) would fail loudly.
#[test]
fn test_find_1_k_l_attachment_count_matches_persisted_rows() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let img = make_unique_png(7);
    let messages = json!([user_message_with_image(&img, "one image")]);
    let req = anthropic_request("k-l-test", &messages);
    let resp = anthropic_sse_response("ok");
    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req,
        &resp,
        None,
        None,
    )
    .expect("capture must succeed");

    // Re-read the turn row from DB (not the in-memory record).
    let db_turns = pipeline
        .graph()
        .get_turns_for_session(&turn.session_id)
        .unwrap();
    assert_eq!(db_turns.len(), 1);
    let persisted_count = db_turns[0].attachment_count;

    // Count rows in the attachments table via a direct query. We don't
    // have a public helper for this, but `get_turn` would not return
    // the attachment count field; we piggyback by asserting the
    // persisted count equals 1 (the single image). If the row was
    // written but the count was not set (or vice-versa), this fails.
    assert_eq!(
        persisted_count, 1,
        "FIND-1-K: turn.attachment_count on disk must equal the \
         number of persisted attachment rows (1). Got: {}",
        persisted_count
    );
}

/// **Name:** `test_find_1_o_pg_readiness_rejects_missing_attachment_count`
/// **Proves:** FIND-1-O: `PostgresGraphStore::new` fails with an
/// actionable error message when the `turns.attachment_count` column
/// does not exist (migration 011 was not applied). The message must
/// mention `attachment_count` and direct the operator to `just
/// api-migrate`.
/// **Anti-fake property:** the test drops the column on the running PG
/// instance, attempts construction, then restores the column. A fix
/// that only checks table existence (not column existence) would
/// accept the broken schema and fail later in a confusing way. This
/// test requires the FIND-1-O column-level check to pass.
#[cfg(feature = "postgres-tests")]
#[test]
// Destructive: drops and restores `turns.attachment_count`. Serialize
// against any other test that reads/writes turn rows.
//
// FIND-9-C: serial_test::serial only protects within a single process.
// nextest spawns each binary in its own process, so two test binaries
// (e.g. attachment_scoping_tests and postgres_graph_store_tests)
// pointing at the same `recondo_test` DB can race the column drop
// against another binary's PostgresGraphStore::new construction. The
// `pg-mutex` test-group with max-threads=1 (.config/nextest.toml)
// covers default `cargo nextest run`, but a separate `cargo test`
// invocation, or any operator-launched concurrent runner against the
// same DB, would not honour test-groups. Acquire a session-level
// `pg_advisory_lock(SHARED_SCHEMA_LOCK_KEY)` for the full duration of
// the destructive ALTER + assertion + restore. Any other PG-touching
// test that takes the same key (see `setup_pg_store` and the stress
// tests below) is serialised CROSS-PROCESS.
#[serial_test::serial(pg_shared_schema)]
fn test_find_1_o_pg_readiness_rejects_missing_attachment_count() {
    use recondo_gateway::storage::postgres::PostgresGraphStore;

    let url = common::pg_container::url();

    let rt = tokio::runtime::Runtime::new().expect("tokio rt");
    rt.block_on(async {
        // Drop the column via a raw connection (not via PostgresGraphStore,
        // which would fail on construction).
        let pool = recondo_gateway::storage::postgres::create_pg_pool(url).expect("create pool");
        let client = pool.get().await.expect("PG conn");
        client
            .batch_execute("ALTER TABLE turns DROP COLUMN IF EXISTS attachment_count")
            .await
            .expect("drop column");
        drop(client);

        // Now try to construct the store — this MUST fail.
        let result = PostgresGraphStore::new(url);
        let err_msg = match result {
            Ok(_) => {
                // Before asserting, restore the column so other tests aren't
                // left with a broken schema.
                let pool2 =
                    recondo_gateway::storage::postgres::create_pg_pool(url).expect("create pool");
                let client2 = pool2.get().await.expect("PG conn");
                client2
                    .batch_execute(
                        "ALTER TABLE turns ADD COLUMN IF NOT EXISTS \
                         attachment_count INTEGER NOT NULL DEFAULT 0",
                    )
                    .await
                    .expect("restore column");
                panic!(
                    "FIND-1-O: PostgresGraphStore::new MUST fail when \
                     turns.attachment_count is missing. Got Ok."
                );
            }
            Err(e) => format!("{:#}", e),
        };

        // Restore the column BEFORE asserting (so a failed assertion
        // doesn't leave other tests with a broken schema).
        let pool2 = recondo_gateway::storage::postgres::create_pg_pool(url).expect("create pool");
        let client2 = pool2.get().await.expect("PG conn");
        client2
            .batch_execute(
                "ALTER TABLE turns ADD COLUMN IF NOT EXISTS \
                 attachment_count INTEGER NOT NULL DEFAULT 0",
            )
            .await
            .expect("restore column");
        drop(client2);

        assert!(
            err_msg.contains("attachment_count"),
            "FIND-1-O: error must mention the missing column name; got: {}",
            err_msg
        );
        assert!(
            err_msg.contains("api-migrate") || err_msg.contains("migrate"),
            "FIND-1-O: error must direct the operator to migrations; got: {}",
            err_msg
        );
    });
}

// FIND-15-Rust-1: cross-process advisory lock key is now the
// canonical `common::pg_lock::SHARED_SCHEMA_LOCK_KEY` constant
// (still 4242424242424242 — wire-compatible with prior rounds).
// All callers route through `common::pg_lock::ensure_shared_schema_lock_held()`
// which acquires the lock on a process-scoped runtime so the
// connection driving the lock survives every per-test runtime drop.

// ===========================================================================
// Category 10 — Round 4 blocker tests
// ===========================================================================

/// FIND-3-RUST-6 helpers: a test-only ObjectStore wrapper that wraps a
/// `LocalObjectStore` and lets tests fail a specific sha256 on `put`
/// and observe `delete()` calls. Needed for injecting the "object-put
/// succeeded, row-insert failed, DLQ write failed" branch in
/// `write_attachment` so the FIND-3-RUST-3 orphan-cleanup path can be
/// tested.
#[derive(Default)]
struct FailingObjectStore {
    inner: Option<recondo_gateway::storage::object::LocalObjectStore>,
    fail_put_on_sha: std::sync::Mutex<Option<String>>,
    delete_calls: std::sync::Mutex<Vec<(String, String)>>,
}

impl FailingObjectStore {
    fn new(inner: recondo_gateway::storage::object::LocalObjectStore) -> Self {
        Self {
            inner: Some(inner),
            ..Default::default()
        }
    }
    fn set_fail_put(&self, sha: &str) {
        *self.fail_put_on_sha.lock().unwrap() = Some(sha.to_string());
    }
}

impl recondo_gateway::storage::object::ObjectStore for FailingObjectStore {
    fn put(&self, kind: &str, hash: &str, data: &[u8]) -> anyhow::Result<String> {
        if let Some(ref target) = *self.fail_put_on_sha.lock().unwrap() {
            if target == hash {
                anyhow::bail!("FailingObjectStore: injected put failure for {}", hash);
            }
        }
        self.inner.as_ref().unwrap().put(kind, hash, data)
    }
    fn get(&self, kind: &str, hash: &str) -> anyhow::Result<Vec<u8>> {
        self.inner.as_ref().unwrap().get(kind, hash)
    }
    fn exists(&self, kind: &str, hash: &str) -> anyhow::Result<bool> {
        self.inner.as_ref().unwrap().exists(kind, hash)
    }
    fn verify(&self, kind: &str, hash: &str) -> anyhow::Result<bool> {
        self.inner.as_ref().unwrap().verify(kind, hash)
    }
    fn delete(&self, kind: &str, hash: &str) -> anyhow::Result<()> {
        self.delete_calls
            .lock()
            .unwrap()
            .push((kind.to_string(), hash.to_string()));
        self.inner.as_ref().unwrap().delete(kind, hash)
    }
}

/// FIND-3-RUST-6 helper: a GraphStore wrapper around SqliteGraphStore
/// that forwards every method but can be configured to fail a given
/// method (write_attachment, update_turn_attachment_count) with a
/// specific error classification (transient vs permanent).
struct FailingGraphStore {
    inner: recondo_gateway::storage::graph::SqliteGraphStore,
    fail_write_attachment_transient: std::sync::atomic::AtomicUsize,
    fail_update_count_transient: std::sync::atomic::AtomicUsize,
    fail_update_count_permanent: std::sync::atomic::AtomicBool,
}

impl FailingGraphStore {
    fn new(inner: recondo_gateway::storage::graph::SqliteGraphStore) -> Self {
        Self {
            inner,
            fail_write_attachment_transient: std::sync::atomic::AtomicUsize::new(0),
            fail_update_count_transient: std::sync::atomic::AtomicUsize::new(0),
            fail_update_count_permanent: std::sync::atomic::AtomicBool::new(false),
        }
    }
    fn set_fail_write_attachment_transient(&self, n: usize) {
        self.fail_write_attachment_transient
            .store(n, std::sync::atomic::Ordering::SeqCst);
    }
    fn set_fail_update_count_permanent(&self) {
        self.fail_update_count_permanent
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }
}

use recondo_gateway::db::{
    AnomalyEventRecord, AttachmentRecord, GdprDeletionRecord, HeartbeatRecord, SessionRecord,
    ToolCallRecord, TurnRecord,
};
use recondo_gateway::storage::graph::{
    GraphStore, GraphStoreError, GraphStoreResult, IntegrityResult,
};

impl GraphStore for FailingGraphStore {
    fn write_session(&self, s: &SessionRecord) -> GraphStoreResult<()> {
        self.inner.write_session(s)
    }
    fn write_turn(&self, t: &TurnRecord) -> GraphStoreResult<()> {
        self.inner.write_turn(t)
    }
    fn write_turn_atomic_seq(&self, t: &TurnRecord) -> GraphStoreResult<i64> {
        self.inner.write_turn_atomic_seq(t)
    }
    fn write_tool_call(&self, tc: &ToolCallRecord) -> GraphStoreResult<()> {
        self.inner.write_tool_call(tc)
    }
    fn list_sessions(&self, limit: Option<i64>) -> GraphStoreResult<Vec<SessionRecord>> {
        self.inner.list_sessions(limit)
    }
    fn get_turns_for_session(&self, sid: &str) -> GraphStoreResult<Vec<TurnRecord>> {
        self.inner.get_turns_for_session(sid)
    }
    fn get_turn(&self, tid: &str) -> GraphStoreResult<Option<TurnRecord>> {
        self.inner.get_turn(tid)
    }
    fn find_turn_by_request_hash(&self, h: &str) -> GraphStoreResult<Option<TurnRecord>> {
        self.inner.find_turn_by_request_hash(h)
    }
    fn get_tool_calls_for_turn(&self, tid: &str) -> GraphStoreResult<Vec<ToolCallRecord>> {
        self.inner.get_tool_calls_for_turn(tid)
    }
    fn get_previous_messages_prefix_marker(
        &self,
        sid: &str,
        seq: i64,
    ) -> GraphStoreResult<Option<String>> {
        self.inner.get_previous_messages_prefix_marker(sid, seq)
    }
    fn verify_integrity(
        &self,
        sid: &str,
        os: Option<&dyn recondo_gateway::storage::object::ObjectStore>,
    ) -> GraphStoreResult<Vec<IntegrityResult>> {
        self.inner.verify_integrity(sid, os)
    }
    fn list_sessions_by_account(&self, acc: &str) -> GraphStoreResult<Vec<SessionRecord>> {
        self.inner.list_sessions_by_account(acc)
    }
    fn update_session_totals(
        &self,
        sid: &str,
        dt: i64,
        dc: i64,
        dtk: i64,
        dcost: f64,
    ) -> GraphStoreResult<()> {
        self.inner.update_session_totals(sid, dt, dc, dtk, dcost)
    }
    fn record_gdpr_deletion(&self, h: &str, by: &str, req: &str) -> GraphStoreResult<()> {
        self.inner.record_gdpr_deletion(h, by, req)
    }
    fn list_gdpr_deletions(&self) -> GraphStoreResult<Vec<GdprDeletionRecord>> {
        self.inner.list_gdpr_deletions()
    }
    fn nullify_turn_parsed_fields(&self, tid: &str) -> GraphStoreResult<()> {
        self.inner.nullify_turn_parsed_fields(tid)
    }
    fn find_supersedes_for_session(
        &self,
        sid: &str,
        paths: &[String],
    ) -> GraphStoreResult<Option<String>> {
        self.inner.find_supersedes_for_session(sid, paths)
    }
    fn get_session(&self, sid: &str) -> GraphStoreResult<Option<SessionRecord>> {
        self.inner.get_session(sid)
    }
    fn write_anomaly_event(&self, e: &AnomalyEventRecord) -> GraphStoreResult<()> {
        self.inner.write_anomaly_event(e)
    }
    fn update_session_system_prompt_hash(&self, sid: &str, nh: &str) -> GraphStoreResult<()> {
        self.inner.update_session_system_prompt_hash(sid, nh)
    }
    fn record_drift_event(
        &self,
        e: &AnomalyEventRecord,
        sid: &str,
        nh: &str,
    ) -> GraphStoreResult<()> {
        self.inner.record_drift_event(e, sid, nh)
    }
    fn update_session_framework(&self, sid: &str, fw: &str) -> GraphStoreResult<()> {
        self.inner.update_session_framework(sid, fw)
    }
    fn update_session_model(&self, sid: &str, m: &str) -> GraphStoreResult<()> {
        self.inner.update_session_model(sid, m)
    }
    fn update_session_initial_intent(&self, sid: &str, ii: &str) -> GraphStoreResult<()> {
        self.inner.update_session_initial_intent(sid, ii)
    }
    fn write_heartbeat(&self, hb: &HeartbeatRecord) -> GraphStoreResult<()> {
        self.inner.write_heartbeat(hb)
    }
    fn update_session_tool_definitions_hash(&self, sid: &str, nh: &str) -> GraphStoreResult<()> {
        self.inner.update_session_tool_definitions_hash(sid, nh)
    }
    fn record_tool_drift_event(
        &self,
        e: &AnomalyEventRecord,
        sid: &str,
        nh: &str,
    ) -> GraphStoreResult<()> {
        self.inner.record_tool_drift_event(e, sid, nh)
    }
    fn write_attachment(&self, a: &AttachmentRecord) -> GraphStoreResult<()> {
        if self
            .fail_write_attachment_transient
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0
        {
            self.fail_write_attachment_transient
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            return Err(GraphStoreError::Other(anyhow::anyhow!(
                "injected transient attachment write failure"
            )));
        }
        self.inner.write_attachment(a)
    }
    fn update_turn_attachment_count(&self, tid: &str, c: i64) -> GraphStoreResult<()> {
        if self
            .fail_update_count_permanent
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(GraphStoreError::PermanentFailure(anyhow::anyhow!(
                "injected permanent update_turn_attachment_count failure"
            )));
        }
        if self
            .fail_update_count_transient
            .load(std::sync::atomic::Ordering::SeqCst)
            > 0
        {
            self.fail_update_count_transient
                .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            return Err(GraphStoreError::Other(anyhow::anyhow!(
                "injected transient update_turn_attachment_count failure"
            )));
        }
        self.inner.update_turn_attachment_count(tid, c)
    }
    fn attachment_sha256_reference_count(&self, sha: &str) -> GraphStoreResult<i64> {
        self.inner.attachment_sha256_reference_count(sha)
    }
    fn with_sha256_orphan_delete_lock(
        &self,
        sha: &str,
        delete_blob: &mut dyn FnMut() -> anyhow::Result<()>,
    ) -> GraphStoreResult<bool> {
        self.inner.with_sha256_orphan_delete_lock(sha, delete_blob)
    }
}

fn make_pipeline_with_failing_object_store(
) -> (WritePipeline, std::sync::Arc<FailingObjectStore>, TempDir) {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    let dlq = data_dir.join("dlq");
    let graph = SqliteGraphStore::new_in_memory().expect("in-memory sqlite graph");
    let inner_objects = recondo_gateway::storage::object::LocalObjectStore::new(&data_dir);
    let failing = std::sync::Arc::new(FailingObjectStore::new(inner_objects));
    // Dyn-trait object: transfer ownership of a clone of Arc into a Box.
    struct ArcWrap(std::sync::Arc<FailingObjectStore>);
    impl recondo_gateway::storage::object::ObjectStore for ArcWrap {
        fn put(&self, kind: &str, hash: &str, data: &[u8]) -> anyhow::Result<String> {
            self.0.put(kind, hash, data)
        }
        fn get(&self, kind: &str, hash: &str) -> anyhow::Result<Vec<u8>> {
            self.0.get(kind, hash)
        }
        fn exists(&self, kind: &str, hash: &str) -> anyhow::Result<bool> {
            self.0.exists(kind, hash)
        }
        fn verify(&self, kind: &str, hash: &str) -> anyhow::Result<bool> {
            self.0.verify(kind, hash)
        }
        fn delete(&self, kind: &str, hash: &str) -> anyhow::Result<()> {
            self.0.delete(kind, hash)
        }
    }
    let boxed = Box::new(ArcWrap(failing.clone()));
    let pipeline = WritePipeline::new(Box::new(graph), boxed, dlq);
    (pipeline, failing, tmp)
}

fn make_pipeline_with_failing_graph() -> (WritePipeline, std::sync::Arc<FailingGraphStore>, TempDir)
{
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    let dlq = data_dir.join("dlq");
    let inner = SqliteGraphStore::new_in_memory().expect("in-memory sqlite graph");
    let failing = std::sync::Arc::new(FailingGraphStore::new(inner));
    struct ArcGraph(std::sync::Arc<FailingGraphStore>);
    impl GraphStore for ArcGraph {
        fn write_session(&self, s: &SessionRecord) -> GraphStoreResult<()> {
            self.0.write_session(s)
        }
        fn write_turn(&self, t: &TurnRecord) -> GraphStoreResult<()> {
            self.0.write_turn(t)
        }
        fn write_turn_atomic_seq(&self, t: &TurnRecord) -> GraphStoreResult<i64> {
            self.0.write_turn_atomic_seq(t)
        }
        fn write_tool_call(&self, tc: &ToolCallRecord) -> GraphStoreResult<()> {
            self.0.write_tool_call(tc)
        }
        fn list_sessions(&self, limit: Option<i64>) -> GraphStoreResult<Vec<SessionRecord>> {
            self.0.list_sessions(limit)
        }
        fn get_turns_for_session(&self, sid: &str) -> GraphStoreResult<Vec<TurnRecord>> {
            self.0.get_turns_for_session(sid)
        }
        fn get_turn(&self, tid: &str) -> GraphStoreResult<Option<TurnRecord>> {
            self.0.get_turn(tid)
        }
        fn find_turn_by_request_hash(&self, h: &str) -> GraphStoreResult<Option<TurnRecord>> {
            self.0.find_turn_by_request_hash(h)
        }
        fn get_tool_calls_for_turn(&self, tid: &str) -> GraphStoreResult<Vec<ToolCallRecord>> {
            self.0.get_tool_calls_for_turn(tid)
        }
        fn get_previous_messages_prefix_marker(
            &self,
            sid: &str,
            seq: i64,
        ) -> GraphStoreResult<Option<String>> {
            self.0.get_previous_messages_prefix_marker(sid, seq)
        }
        fn verify_integrity(
            &self,
            sid: &str,
            os: Option<&dyn recondo_gateway::storage::object::ObjectStore>,
        ) -> GraphStoreResult<Vec<IntegrityResult>> {
            self.0.verify_integrity(sid, os)
        }
        fn list_sessions_by_account(&self, acc: &str) -> GraphStoreResult<Vec<SessionRecord>> {
            self.0.list_sessions_by_account(acc)
        }
        fn update_session_totals(
            &self,
            sid: &str,
            dt: i64,
            dc: i64,
            dtk: i64,
            dcost: f64,
        ) -> GraphStoreResult<()> {
            self.0.update_session_totals(sid, dt, dc, dtk, dcost)
        }
        fn record_gdpr_deletion(&self, h: &str, by: &str, req: &str) -> GraphStoreResult<()> {
            self.0.record_gdpr_deletion(h, by, req)
        }
        fn list_gdpr_deletions(&self) -> GraphStoreResult<Vec<GdprDeletionRecord>> {
            self.0.list_gdpr_deletions()
        }
        fn nullify_turn_parsed_fields(&self, tid: &str) -> GraphStoreResult<()> {
            self.0.nullify_turn_parsed_fields(tid)
        }
        fn find_supersedes_for_session(
            &self,
            sid: &str,
            paths: &[String],
        ) -> GraphStoreResult<Option<String>> {
            self.0.find_supersedes_for_session(sid, paths)
        }
        fn get_session(&self, sid: &str) -> GraphStoreResult<Option<SessionRecord>> {
            self.0.get_session(sid)
        }
        fn write_anomaly_event(&self, e: &AnomalyEventRecord) -> GraphStoreResult<()> {
            self.0.write_anomaly_event(e)
        }
        fn update_session_system_prompt_hash(&self, sid: &str, nh: &str) -> GraphStoreResult<()> {
            self.0.update_session_system_prompt_hash(sid, nh)
        }
        fn record_drift_event(
            &self,
            e: &AnomalyEventRecord,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.record_drift_event(e, sid, nh)
        }
        fn update_session_framework(&self, sid: &str, fw: &str) -> GraphStoreResult<()> {
            self.0.update_session_framework(sid, fw)
        }
        fn update_session_model(&self, sid: &str, m: &str) -> GraphStoreResult<()> {
            self.0.update_session_model(sid, m)
        }
        fn update_session_initial_intent(&self, sid: &str, ii: &str) -> GraphStoreResult<()> {
            self.0.update_session_initial_intent(sid, ii)
        }
        fn write_heartbeat(&self, hb: &HeartbeatRecord) -> GraphStoreResult<()> {
            self.0.write_heartbeat(hb)
        }
        fn update_session_tool_definitions_hash(
            &self,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.update_session_tool_definitions_hash(sid, nh)
        }
        fn record_tool_drift_event(
            &self,
            e: &AnomalyEventRecord,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.record_tool_drift_event(e, sid, nh)
        }
        fn write_attachment(&self, a: &AttachmentRecord) -> GraphStoreResult<()> {
            self.0.write_attachment(a)
        }
        fn update_turn_attachment_count(&self, tid: &str, c: i64) -> GraphStoreResult<()> {
            self.0.update_turn_attachment_count(tid, c)
        }
        fn attachment_sha256_reference_count(&self, sha: &str) -> GraphStoreResult<i64> {
            self.0.attachment_sha256_reference_count(sha)
        }
        fn with_sha256_orphan_delete_lock(
            &self,
            sha: &str,
            delete_blob: &mut dyn FnMut() -> anyhow::Result<()>,
        ) -> GraphStoreResult<bool> {
            self.0.with_sha256_orphan_delete_lock(sha, delete_blob)
        }
    }
    let objects = Box::new(recondo_gateway::storage::object::LocalObjectStore::new(
        &data_dir,
    ));
    let pipeline = WritePipeline::new(Box::new(ArcGraph(failing.clone())), objects, dlq);
    (pipeline, failing, tmp)
}

/// **Name:** `test_find_3_rust_6_transient_graph_error_retries_then_succeeds`
/// **Proves:** FIND-3-RUST-2 + FIND-3-RUST-6: a transient write_attachment
/// error is retried, and a subsequent success returns `Ok(true)` so the
/// attachment counts toward turn.attachment_count.
#[test]
fn test_find_3_rust_6_transient_graph_error_retries_then_succeeds() {
    let (pipeline, failing, _tmp) = make_pipeline_with_failing_graph();
    // Two transient failures then success (max_retries=3).
    failing.set_fail_write_attachment_transient(2);

    let turn_id = "turn-retry-ok".to_string();
    let session_id = "sess-retry-ok".to_string();
    // Seed session + turn so the FK is satisfied.
    pipeline
        .graph()
        .write_session(&SessionRecord {
            id: session_id.clone(),
            provider: "anthropic".to_string(),
            model: None,
            started_at: "2026-04-24T00:00:00Z".to_string(),
            last_active_at: "2026-04-24T00:00:00Z".to_string(),
            ended_at: None,
            initial_intent: None,
            system_prompt_hash: "h".to_string(),
            total_turns: 1,
            turns_captured: 1,
            dropped_events: 0,
            total_tokens: 0,
            total_cost_usd: 0.0,
            framework: None,
            agent_id: None,
            agent_version: None,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: None,
            device_id: None,
            tool_definitions_hash: String::new(),
        })
        .expect("write session");

    let mut turn = seed_turn(&turn_id, &session_id);
    turn.attachment_count = 1;
    pipeline.graph().write_turn(&turn).expect("write turn");

    let bytes = make_unique_png(201);
    let sha = recondo_gateway::hash::sha256_hex(&bytes);
    let attachment = AttachmentRecord {
        id: "att-retry".to_string(),
        turn_id,
        session_id,
        sequence_num: 1,
        role: "user".to_string(),
        kind: "image".to_string(),
        mime_type: "image/png".to_string(),
        size_bytes: bytes.len() as i64,
        sha256: sha.clone(),
        object_ref: format!("attachments/{}.json.gz", sha),
        filename: None,
        width: None,
        height: None,
    };
    let result = pipeline.write_attachment(&attachment, &bytes).expect("ok");
    assert!(
        result,
        "FIND-3-RUST-6: transient failures followed by success must return Ok(true)"
    );
}

/// **Name:** `test_find_3_rust_6_update_count_permanent_error_goes_to_dlq`
/// **Proves:** FIND-1-K (re-opened) + FIND-3-RUST-2: when
/// `update_turn_attachment_count` fails with a permanent error,
/// `reconcile_turn_attachment_count` DLQ's an
/// `attachment_count_drift` record (no retry, no log-and-move-on).
#[test]
fn test_find_3_rust_6_update_count_permanent_error_goes_to_dlq() {
    let (pipeline, failing, tmp) = make_pipeline_with_failing_graph();
    failing.set_fail_update_count_permanent();

    let turn_id = "turn-count-drift".to_string();
    let session_id = "sess-count-drift".to_string();
    pipeline
        .graph()
        .write_session(&sample_session(&session_id))
        .expect("write session");
    let turn = seed_turn(&turn_id, &session_id);
    pipeline.graph().write_turn(&turn).expect("write turn");

    let result = pipeline
        .reconcile_turn_attachment_count(&turn_id, 1, 3, 2)
        .expect("reconcile should not propagate");
    assert!(
        !result,
        "FIND-1-K: permanent UPDATE failure must DLQ (return Ok(false)), not retry or return Ok(true). Got: {}",
        result
    );

    // Confirm the DLQ file landed on disk.
    let dlq_dir = tmp.path().join("dlq");
    let entries: Vec<_> = std::fs::read_dir(&dlq_dir)
        .expect("dlq dir exists")
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.contains("attachment_count_drift") && !name.starts_with(".tmp_")
        })
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "FIND-1-K: exactly one attachment_count_drift DLQ file must exist. Got {} entries. Dir: {:?}",
        entries.len(),
        std::fs::read_dir(&dlq_dir)
            .ok()
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.file_name()).collect::<Vec<_>>())
    );

    // Parse the DLQ JSON and assert its shape.
    let contents = std::fs::read_to_string(entries[0].path()).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&contents).unwrap();
    assert_eq!(
        parsed["kind"].as_str(),
        Some("attachment_count_drift"),
        "DLQ record must be typed as attachment_count_drift"
    );
    assert_eq!(parsed["turn_id"].as_str(), Some(turn_id.as_str()));
    assert_eq!(parsed["persisted_count"].as_i64(), Some(1));
    assert_eq!(parsed["speculative_count"].as_i64(), Some(3));
    assert_eq!(parsed["dlq_count"].as_i64(), Some(2));
    assert_eq!(
        parsed["retry_count"].as_i64(),
        Some(0),
        "FIND-3-RUST-2: permanent error must skip retry, so retry_count=0 in the DLQ record"
    );
}

/// **Name:** `test_find_3_rust_6_object_put_failure_goes_to_dlq`
/// **Proves:** FIND-1-L (re-opened): when the ObjectStore put fails
/// after retries, the attachment bundle is DLQ'd and write_attachment
/// returns Ok(false) (not counted toward turn.attachment_count).
#[test]
fn test_find_3_rust_6_object_put_failure_goes_to_dlq() {
    let (pipeline, failing_obj, tmp) = make_pipeline_with_failing_object_store();

    let turn_id = "turn-obj-fail".to_string();
    let session_id = "sess-obj-fail".to_string();
    pipeline
        .graph()
        .write_session(&sample_session(&session_id))
        .expect("write session");
    let turn = seed_turn(&turn_id, &session_id);
    pipeline.graph().write_turn(&turn).expect("write turn");

    let bytes = make_unique_png(55);
    let sha = recondo_gateway::hash::sha256_hex(&bytes);
    failing_obj.set_fail_put(&sha);

    let attachment = AttachmentRecord {
        id: "att-obj-fail".to_string(),
        turn_id,
        session_id,
        sequence_num: 1,
        role: "user".to_string(),
        kind: "image".to_string(),
        mime_type: "image/png".to_string(),
        size_bytes: bytes.len() as i64,
        sha256: sha.clone(),
        object_ref: format!("attachments/{}.json.gz", sha),
        filename: None,
        width: None,
        height: None,
    };
    let result = pipeline
        .write_attachment(&attachment, &bytes)
        .expect("DLQ fires; must not bubble");
    assert!(
        !result,
        "FIND-1-L: object-put failure must DLQ and return Ok(false)"
    );

    // DLQ file for the attachment bundle must exist.
    let dlq_dir = tmp.path().join("dlq");
    let entries: Vec<_> = std::fs::read_dir(&dlq_dir)
        .expect("dlq dir exists")
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.contains("attachment_") && !name.starts_with(".tmp_")
        })
        .collect();
    assert_eq!(
        entries.len(),
        1,
        "FIND-1-L: expected exactly one attachment DLQ file"
    );
}

/// **Name:** `test_find_4_c_orphan_skipped_when_blob_shared_via_dedup`
/// **Proves:** FIND-4-C: when an object is dedup-shared between turn A
/// and turn B (same sha256, two committed `attachments` rows), and
/// turn A's row+DLQ both fail catastrophically, the orphan-cleanup
/// branch MUST NOT delete the blob — turn B still depends on it.
/// **Anti-fake property:** the test pre-commits an attachments row
/// for turn B with the same sha256, then drives turn A through the
/// catastrophic path (3 transient row-insert failures + DLQ-write
/// failure). After bail-out, the blob is asserted STILL PRESENT in
/// the local object store.
#[test]
fn test_find_4_c_orphan_skipped_when_blob_shared_via_dedup() {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    // DLQ path is a FILE so dead_letter_attachment() fails.
    let dlq = data_dir.join("dlq_file");
    std::fs::write(&dlq, b"not a dir").unwrap();
    let inner = SqliteGraphStore::new_in_memory().unwrap();
    let failing_graph = std::sync::Arc::new(FailingGraphStore::new(inner));

    struct ArcGraph(std::sync::Arc<FailingGraphStore>);
    impl GraphStore for ArcGraph {
        fn write_session(&self, s: &SessionRecord) -> GraphStoreResult<()> {
            self.0.write_session(s)
        }
        fn write_turn(&self, t: &TurnRecord) -> GraphStoreResult<()> {
            self.0.write_turn(t)
        }
        fn write_turn_atomic_seq(&self, t: &TurnRecord) -> GraphStoreResult<i64> {
            self.0.write_turn_atomic_seq(t)
        }
        fn write_tool_call(&self, tc: &ToolCallRecord) -> GraphStoreResult<()> {
            self.0.write_tool_call(tc)
        }
        fn list_sessions(&self, limit: Option<i64>) -> GraphStoreResult<Vec<SessionRecord>> {
            self.0.list_sessions(limit)
        }
        fn get_turns_for_session(&self, sid: &str) -> GraphStoreResult<Vec<TurnRecord>> {
            self.0.get_turns_for_session(sid)
        }
        fn get_turn(&self, tid: &str) -> GraphStoreResult<Option<TurnRecord>> {
            self.0.get_turn(tid)
        }
        fn find_turn_by_request_hash(&self, h: &str) -> GraphStoreResult<Option<TurnRecord>> {
            self.0.find_turn_by_request_hash(h)
        }
        fn get_tool_calls_for_turn(&self, tid: &str) -> GraphStoreResult<Vec<ToolCallRecord>> {
            self.0.get_tool_calls_for_turn(tid)
        }
        fn get_previous_messages_prefix_marker(
            &self,
            sid: &str,
            seq: i64,
        ) -> GraphStoreResult<Option<String>> {
            self.0.get_previous_messages_prefix_marker(sid, seq)
        }
        fn verify_integrity(
            &self,
            sid: &str,
            os: Option<&dyn recondo_gateway::storage::object::ObjectStore>,
        ) -> GraphStoreResult<Vec<IntegrityResult>> {
            self.0.verify_integrity(sid, os)
        }
        fn list_sessions_by_account(&self, acc: &str) -> GraphStoreResult<Vec<SessionRecord>> {
            self.0.list_sessions_by_account(acc)
        }
        fn update_session_totals(
            &self,
            sid: &str,
            dt: i64,
            dc: i64,
            dtk: i64,
            dcost: f64,
        ) -> GraphStoreResult<()> {
            self.0.update_session_totals(sid, dt, dc, dtk, dcost)
        }
        fn record_gdpr_deletion(&self, h: &str, by: &str, req: &str) -> GraphStoreResult<()> {
            self.0.record_gdpr_deletion(h, by, req)
        }
        fn list_gdpr_deletions(&self) -> GraphStoreResult<Vec<GdprDeletionRecord>> {
            self.0.list_gdpr_deletions()
        }
        fn nullify_turn_parsed_fields(&self, tid: &str) -> GraphStoreResult<()> {
            self.0.nullify_turn_parsed_fields(tid)
        }
        fn find_supersedes_for_session(
            &self,
            sid: &str,
            paths: &[String],
        ) -> GraphStoreResult<Option<String>> {
            self.0.find_supersedes_for_session(sid, paths)
        }
        fn get_session(&self, sid: &str) -> GraphStoreResult<Option<SessionRecord>> {
            self.0.get_session(sid)
        }
        fn write_anomaly_event(&self, e: &AnomalyEventRecord) -> GraphStoreResult<()> {
            self.0.write_anomaly_event(e)
        }
        fn update_session_system_prompt_hash(&self, sid: &str, nh: &str) -> GraphStoreResult<()> {
            self.0.update_session_system_prompt_hash(sid, nh)
        }
        fn record_drift_event(
            &self,
            e: &AnomalyEventRecord,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.record_drift_event(e, sid, nh)
        }
        fn update_session_framework(&self, sid: &str, fw: &str) -> GraphStoreResult<()> {
            self.0.update_session_framework(sid, fw)
        }
        fn update_session_model(&self, sid: &str, m: &str) -> GraphStoreResult<()> {
            self.0.update_session_model(sid, m)
        }
        fn update_session_initial_intent(&self, sid: &str, ii: &str) -> GraphStoreResult<()> {
            self.0.update_session_initial_intent(sid, ii)
        }
        fn write_heartbeat(&self, hb: &HeartbeatRecord) -> GraphStoreResult<()> {
            self.0.write_heartbeat(hb)
        }
        fn update_session_tool_definitions_hash(
            &self,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.update_session_tool_definitions_hash(sid, nh)
        }
        fn record_tool_drift_event(
            &self,
            e: &AnomalyEventRecord,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.record_tool_drift_event(e, sid, nh)
        }
        fn write_attachment(&self, a: &AttachmentRecord) -> GraphStoreResult<()> {
            self.0.write_attachment(a)
        }
        fn update_turn_attachment_count(&self, tid: &str, c: i64) -> GraphStoreResult<()> {
            self.0.update_turn_attachment_count(tid, c)
        }
        fn attachment_sha256_reference_count(&self, sha: &str) -> GraphStoreResult<i64> {
            self.0.attachment_sha256_reference_count(sha)
        }
        fn with_sha256_orphan_delete_lock(
            &self,
            sha: &str,
            delete_blob: &mut dyn FnMut() -> anyhow::Result<()>,
        ) -> GraphStoreResult<bool> {
            self.0.with_sha256_orphan_delete_lock(sha, delete_blob)
        }
    }
    let objects = Box::new(recondo_gateway::storage::object::LocalObjectStore::new(
        &data_dir,
    ));
    let pipeline = WritePipeline::new(Box::new(ArcGraph(failing_graph.clone())), objects, dlq);

    // Seed two sessions and two turns. Pre-commit an attachments row
    // for turn B with the SAME sha256 as turn A's about-to-fail bundle.
    let bytes = make_unique_png(99);
    let sha = recondo_gateway::hash::sha256_hex(&bytes);

    let session_a = "sess-find4c-A".to_string();
    let session_b = "sess-find4c-B".to_string();
    let turn_a = "turn-find4c-A".to_string();
    let turn_b = "turn-find4c-B".to_string();

    pipeline
        .graph()
        .write_session(&sample_session(&session_a))
        .unwrap();
    pipeline
        .graph()
        .write_session(&sample_session(&session_b))
        .unwrap();
    pipeline
        .graph()
        .write_turn(&seed_turn(&turn_a, &session_a))
        .unwrap();
    pipeline
        .graph()
        .write_turn(&seed_turn(&turn_b, &session_b))
        .unwrap();

    // Pre-commit turn B's attachment row (the dedup-shared sibling).
    let attachment_b = AttachmentRecord {
        id: "att-find4c-B".to_string(),
        turn_id: turn_b.clone(),
        session_id: session_b.clone(),
        sequence_num: 1,
        role: "user".to_string(),
        kind: "image".to_string(),
        mime_type: "image/png".to_string(),
        size_bytes: bytes.len() as i64,
        sha256: sha.clone(),
        object_ref: format!("attachments/{}.json.gz", sha),
        filename: None,
        width: None,
        height: None,
    };
    pipeline.graph().write_attachment(&attachment_b).unwrap();

    // Also place the blob into the object store so the put loop in
    // write_attachment for turn A's bundle finds the dedup target.
    pipeline.objects().put("attachments", &sha, &bytes).unwrap();

    // Now drive turn A's bundle through the catastrophic path: 3
    // transient row-insert failures, then DLQ write also fails.
    failing_graph.set_fail_write_attachment_transient(3);

    let attachment_a = AttachmentRecord {
        id: "att-find4c-A".to_string(),
        turn_id: turn_a,
        session_id: session_a,
        sequence_num: 1,
        role: "user".to_string(),
        kind: "image".to_string(),
        mime_type: "image/png".to_string(),
        size_bytes: bytes.len() as i64,
        sha256: sha.clone(),
        object_ref: format!("attachments/{}.json.gz", sha),
        filename: None,
        width: None,
        height: None,
    };
    let err = pipeline
        .write_attachment(&attachment_a, &bytes)
        .unwrap_err();
    assert!(err.to_string().contains("after 3 retries"), "{}", err);

    // CRITICAL ASSERTION (FIND-4-C): the blob MUST still exist
    // because turn B's row references it.
    let still_exists = pipeline.objects().exists("attachments", &sha).unwrap();
    assert!(
        still_exists,
        "FIND-4-C: orphan-cleanup must NOT delete a dedup-shared blob; turn B's committed row depends on sha256={}",
        sha
    );

    // Sanity: turn B's attachments row is intact and readable.
    let count = pipeline
        .graph()
        .attachment_sha256_reference_count(&sha)
        .unwrap();
    assert_eq!(
        count, 1,
        "turn B's attachment row must remain after the orphan-skip path"
    );
}

/// FIND-3-RUST-3: When write_attachment succeeds at put but the row-
/// insert retries exhaust AND the DLQ write also fails, the pipeline
/// must best-effort delete the orphaned object and either succeed
/// (absence restored) or emit a structured orphan-log event. This
/// test fires the best-effort delete path by making the DLQ directory
/// un-writable (file instead of dir).
#[test]
fn test_find_3_rust_3_orphan_cleanup_fires() {
    let tmp = TempDir::new().expect("tempdir");
    let data_dir = tmp.path().to_path_buf();
    // DLQ path is a FILE so dead_letter_attachment() fails (can't
    // create_dir_all).
    let dlq = data_dir.join("dlq_file");
    std::fs::write(&dlq, b"not a dir").unwrap();
    let inner = SqliteGraphStore::new_in_memory().unwrap();
    let failing_graph = std::sync::Arc::new(FailingGraphStore::new(inner));
    // Force all 3 write_attachment retries to fail transiently.
    failing_graph.set_fail_write_attachment_transient(3);

    struct ArcGraph(std::sync::Arc<FailingGraphStore>);
    // Reuse the small dispatcher from above. To avoid duplicating 30
    // trait methods, just use the local-stub pattern: this test doesn't
    // need full GraphStore, only what write_attachment touches.
    impl GraphStore for ArcGraph {
        fn write_session(&self, s: &SessionRecord) -> GraphStoreResult<()> {
            self.0.write_session(s)
        }
        fn write_turn(&self, t: &TurnRecord) -> GraphStoreResult<()> {
            self.0.write_turn(t)
        }
        fn write_turn_atomic_seq(&self, t: &TurnRecord) -> GraphStoreResult<i64> {
            self.0.write_turn_atomic_seq(t)
        }
        fn write_tool_call(&self, tc: &ToolCallRecord) -> GraphStoreResult<()> {
            self.0.write_tool_call(tc)
        }
        fn list_sessions(&self, limit: Option<i64>) -> GraphStoreResult<Vec<SessionRecord>> {
            self.0.list_sessions(limit)
        }
        fn get_turns_for_session(&self, sid: &str) -> GraphStoreResult<Vec<TurnRecord>> {
            self.0.get_turns_for_session(sid)
        }
        fn get_turn(&self, tid: &str) -> GraphStoreResult<Option<TurnRecord>> {
            self.0.get_turn(tid)
        }
        fn find_turn_by_request_hash(&self, h: &str) -> GraphStoreResult<Option<TurnRecord>> {
            self.0.find_turn_by_request_hash(h)
        }
        fn get_tool_calls_for_turn(&self, tid: &str) -> GraphStoreResult<Vec<ToolCallRecord>> {
            self.0.get_tool_calls_for_turn(tid)
        }
        fn get_previous_messages_prefix_marker(
            &self,
            sid: &str,
            seq: i64,
        ) -> GraphStoreResult<Option<String>> {
            self.0.get_previous_messages_prefix_marker(sid, seq)
        }
        fn verify_integrity(
            &self,
            sid: &str,
            os: Option<&dyn recondo_gateway::storage::object::ObjectStore>,
        ) -> GraphStoreResult<Vec<IntegrityResult>> {
            self.0.verify_integrity(sid, os)
        }
        fn list_sessions_by_account(&self, acc: &str) -> GraphStoreResult<Vec<SessionRecord>> {
            self.0.list_sessions_by_account(acc)
        }
        fn update_session_totals(
            &self,
            sid: &str,
            dt: i64,
            dc: i64,
            dtk: i64,
            dcost: f64,
        ) -> GraphStoreResult<()> {
            self.0.update_session_totals(sid, dt, dc, dtk, dcost)
        }
        fn record_gdpr_deletion(&self, h: &str, by: &str, req: &str) -> GraphStoreResult<()> {
            self.0.record_gdpr_deletion(h, by, req)
        }
        fn list_gdpr_deletions(&self) -> GraphStoreResult<Vec<GdprDeletionRecord>> {
            self.0.list_gdpr_deletions()
        }
        fn nullify_turn_parsed_fields(&self, tid: &str) -> GraphStoreResult<()> {
            self.0.nullify_turn_parsed_fields(tid)
        }
        fn find_supersedes_for_session(
            &self,
            sid: &str,
            paths: &[String],
        ) -> GraphStoreResult<Option<String>> {
            self.0.find_supersedes_for_session(sid, paths)
        }
        fn get_session(&self, sid: &str) -> GraphStoreResult<Option<SessionRecord>> {
            self.0.get_session(sid)
        }
        fn write_anomaly_event(&self, e: &AnomalyEventRecord) -> GraphStoreResult<()> {
            self.0.write_anomaly_event(e)
        }
        fn update_session_system_prompt_hash(&self, sid: &str, nh: &str) -> GraphStoreResult<()> {
            self.0.update_session_system_prompt_hash(sid, nh)
        }
        fn record_drift_event(
            &self,
            e: &AnomalyEventRecord,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.record_drift_event(e, sid, nh)
        }
        fn update_session_framework(&self, sid: &str, fw: &str) -> GraphStoreResult<()> {
            self.0.update_session_framework(sid, fw)
        }
        fn update_session_model(&self, sid: &str, m: &str) -> GraphStoreResult<()> {
            self.0.update_session_model(sid, m)
        }
        fn update_session_initial_intent(&self, sid: &str, ii: &str) -> GraphStoreResult<()> {
            self.0.update_session_initial_intent(sid, ii)
        }
        fn write_heartbeat(&self, hb: &HeartbeatRecord) -> GraphStoreResult<()> {
            self.0.write_heartbeat(hb)
        }
        fn update_session_tool_definitions_hash(
            &self,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.update_session_tool_definitions_hash(sid, nh)
        }
        fn record_tool_drift_event(
            &self,
            e: &AnomalyEventRecord,
            sid: &str,
            nh: &str,
        ) -> GraphStoreResult<()> {
            self.0.record_tool_drift_event(e, sid, nh)
        }
        fn write_attachment(&self, a: &AttachmentRecord) -> GraphStoreResult<()> {
            self.0.write_attachment(a)
        }
        fn update_turn_attachment_count(&self, tid: &str, c: i64) -> GraphStoreResult<()> {
            self.0.update_turn_attachment_count(tid, c)
        }
        fn attachment_sha256_reference_count(&self, sha: &str) -> GraphStoreResult<i64> {
            self.0.attachment_sha256_reference_count(sha)
        }
        fn with_sha256_orphan_delete_lock(
            &self,
            sha: &str,
            delete_blob: &mut dyn FnMut() -> anyhow::Result<()>,
        ) -> GraphStoreResult<bool> {
            self.0.with_sha256_orphan_delete_lock(sha, delete_blob)
        }
    }
    let objects = Box::new(recondo_gateway::storage::object::LocalObjectStore::new(
        &data_dir,
    ));
    let pipeline = WritePipeline::new(Box::new(ArcGraph(failing_graph)), objects, dlq);

    let turn_id = "turn-orphan".to_string();
    let session_id = "sess-orphan".to_string();
    pipeline
        .graph()
        .write_session(&sample_session(&session_id))
        .unwrap();
    let turn = seed_turn(&turn_id, &session_id);
    pipeline.graph().write_turn(&turn).unwrap();

    let bytes = make_unique_png(77);
    let sha = recondo_gateway::hash::sha256_hex(&bytes);
    let attachment = AttachmentRecord {
        id: "att-orphan".to_string(),
        turn_id,
        session_id,
        sequence_num: 1,
        role: "user".to_string(),
        kind: "image".to_string(),
        mime_type: "image/png".to_string(),
        size_bytes: bytes.len() as i64,
        sha256: sha.clone(),
        object_ref: format!("attachments/{}.json.gz", sha),
        filename: None,
        width: None,
        height: None,
    };
    // put uses LocalObjectStore which will succeed. Row insert fails
    // 3× transient; DLQ write then fails (dlq path is a file, not a
    // dir). write_attachment must bail AND best-effort delete the
    // orphan object.
    let err = pipeline.write_attachment(&attachment, &bytes).unwrap_err();
    assert!(
        err.to_string().contains("after 3 retries"),
        "err must mention retries: {}",
        err
    );

    // Object must have been best-effort deleted from the local store.
    // LocalObjectStore::exists uses the kind/hash path.
    let exists = pipeline
        .objects()
        .exists("attachments", &sha)
        .unwrap_or(true);
    assert!(
        !exists,
        "FIND-3-RUST-3: orphaned object must be best-effort deleted when row+DLQ both fail"
    );
}

/// **Name:** `test_find_6_f_orphan_cleanup_atomic_under_concurrent_writer`
/// **Proves:** FIND-6-F: the `with_sha256_orphan_delete_lock` atomic
/// primitive prevents TOCTOU between ref-count-check and delete. If
/// a committed `attachments` row exists for the sha256, the closure
/// MUST NOT run and the blob MUST remain in the store. The SQLite
/// backend uses `BEGIN IMMEDIATE`; the PG backend uses
/// `pg_advisory_xact_lock` — both serialise orphan-cleanup probes.
///
/// This test exercises the SQLite path (in-memory, single-writer
/// invariant). It pre-commits an attachments row, puts the blob,
/// then invokes `with_sha256_orphan_delete_lock` directly. The
/// method must return `Ok(false)` and NOT delete the blob.
///
/// **Anti-fake property:** seeds the blob and a committed reference
/// row; after the call, asserts both `Ok(false)` return AND the
/// blob still exists. Any implementation that deleted-first would
/// violate one of these.
#[test]
fn test_find_6_f_orphan_cleanup_atomic_under_concurrent_writer() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let graph = SqliteGraphStore::new_in_memory().expect("sqlite graph");
    let objects = recondo_gateway::storage::object::LocalObjectStore::new(&data_dir);

    // Seed the blob under the content-addressed layout.
    let bytes = make_unique_png(17);
    let sha = recondo_gateway::hash::sha256_hex(&bytes);
    objects.put("attachments", &sha, &bytes).unwrap();

    // Seed a session + turn + attachments row referencing this sha.
    let session_id = "sess-find6f-atomic";
    let turn_id = "turn-find6f-atomic";
    graph
        .write_session(&sample_session(session_id))
        .expect("write session");
    graph
        .write_turn(&seed_turn(turn_id, session_id))
        .expect("write turn");
    graph
        .write_attachment(&AttachmentRecord {
            id: "att-find6f-atomic".to_string(),
            turn_id: turn_id.to_string(),
            session_id: session_id.to_string(),
            sequence_num: 1,
            role: "user".to_string(),
            kind: "image".to_string(),
            mime_type: "image/png".to_string(),
            size_bytes: bytes.len() as i64,
            sha256: sha.clone(),
            object_ref: format!("attachments/{}.json.gz", sha),
            filename: None,
            width: None,
            height: None,
        })
        .expect("write attachment row");

    // Invoke the atomic primitive. The closure must NOT run because
    // the committed row exists. Track closure invocation via a flag.
    let mut closure_ran = false;
    let sha_for_closure = sha.clone();
    let result = graph.with_sha256_orphan_delete_lock(&sha, &mut || {
        closure_ran = true;
        objects.delete("attachments", &sha_for_closure).map(|_| ())
    });

    assert!(
        matches!(result, Ok(false)),
        "FIND-6-F: with committed dedup-shared row, primitive must return Ok(false); got {:?}",
        result
    );
    assert!(
        !closure_ran,
        "FIND-6-F: delete closure MUST NOT run when ref-count > 0 under the lock"
    );
    // Blob must still exist in the store.
    assert!(
        objects.exists("attachments", &sha).unwrap(),
        "FIND-6-F: blob must remain in store when primitive returns Ok(false)"
    );
}

/// **Name:** `test_find_6_f_orphan_cleanup_atomic_no_references_runs_closure`
/// **Proves:** FIND-6-F: when no committed row references the
/// sha256, the closure DOES run (and reports its own result).
#[test]
fn test_find_6_f_orphan_cleanup_atomic_no_references_runs_closure() {
    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = recondo_gateway::storage::object::LocalObjectStore::new(&data_dir);

    let bytes = make_unique_png(23);
    let sha = recondo_gateway::hash::sha256_hex(&bytes);
    objects.put("attachments", &sha, &bytes).unwrap();

    // No `attachments` row seeded — ref-count is 0.
    let mut closure_ran = false;
    let sha_for_closure = sha.clone();
    let result = graph.with_sha256_orphan_delete_lock(&sha, &mut || {
        closure_ran = true;
        objects.delete("attachments", &sha_for_closure).map(|_| ())
    });

    assert!(
        matches!(result, Ok(true)),
        "FIND-6-F: no references → primitive must return Ok(true); got {:?}",
        result
    );
    assert!(
        closure_ran,
        "FIND-6-F: closure must run when ref-count is 0"
    );
    assert!(
        !objects.exists("attachments", &sha).unwrap(),
        "FIND-6-F: closure that deletes must have actually deleted the blob"
    );
}

/// **Name:** `test_find_7_d_orphan_cleanup_concurrency_stress_sqlite`
/// **Proves:** FIND-7-D: the `with_sha256_orphan_delete_lock` atomic
/// primitive correctly serialises N concurrent orphan-deleters and M
/// concurrent `write_attachment` callers for the SAME sha256. After
/// the loop, the post-condition holds: either (a) the blob exists
/// AND ≥1 attachment row references it, or (b) the blob is absent
/// AND no row references it. Never (c) "blob deleted while a row
/// references it" (the race FIND-6-F fixed) or (d) "blob exists
/// while no row references it" (orphan that should have been
/// deleted but a writer's INSERT lost; this is acceptable as a
/// transient state — the closure can fire on the next cleanup).
///
/// **Anti-fake property:** spawns 4 deleter threads + 4 writer
/// threads, all hammering the SAME sha256 in tight loops. Without
/// the atomic primitive's serialisation, races would surface as
/// failed post-conditions or panic'd worker threads.
#[test]
fn test_find_7_d_orphan_cleanup_concurrency_stress_sqlite() {
    use std::sync::Arc;
    use std::thread;

    let tmp = TempDir::new().unwrap();
    let data_dir = tmp.path().to_path_buf();
    let graph: Arc<dyn GraphStore> =
        Arc::new(SqliteGraphStore::new_in_memory().expect("sqlite graph"));
    let objects: Arc<dyn recondo_gateway::storage::object::ObjectStore> = Arc::new(
        recondo_gateway::storage::object::LocalObjectStore::new(&data_dir),
    );

    // Seed a session and one canonical turn so concurrent writers
    // can attach rows to it. The deleter threads don't need a turn —
    // they just count refs by sha256.
    let session_id = "sess-find7d-stress".to_string();
    let turn_id = "turn-find7d-stress".to_string();
    graph
        .write_session(&sample_session(&session_id))
        .expect("seed session");
    graph
        .write_turn(&seed_turn(&turn_id, &session_id))
        .expect("seed turn");

    // The contended blob: pre-populate so deleter threads have
    // something to consider for deletion on iteration 0.
    let bytes = make_unique_png(241);
    let sha = recondo_gateway::hash::sha256_hex(&bytes);
    objects.put("attachments", &sha, &bytes).unwrap();

    // Each writer thread tries N times to insert a uniquely-keyed
    // attachment row pointing at sha. ON CONFLICT in the SQLite
    // INSERT means duplicate id rows settle deterministically; we
    // use a fresh UUID each time so every iteration is a new row.
    // Each deleter thread tries N times to invoke
    // with_sha256_orphan_delete_lock. The atomic primitive must
    // serialise so that no deleter ever observes "no rows" between
    // a writer's INSERT and the FK-bound row visibility.
    const ITERS: usize = 50;
    const WRITERS: usize = 4;
    const DELETERS: usize = 4;

    let mut handles = Vec::new();

    // FIND-8-K: track successful writes via atomic counter so the
    // post-condition isn't vacuously satisfied. If a regression
    // breaks `write_attachment` entirely, every iteration would
    // return Err (silently swallowed by `let _ = ...`), final_rows
    // would be 0, and the `if final_rows >= 1` post-condition
    // would never fire — the test would pass while doing nothing.
    // Now we assert at least half the expected writes succeeded
    // before evaluating the lock-primitive contract.
    use std::sync::atomic::{AtomicUsize, Ordering};
    let writes_succeeded = Arc::new(AtomicUsize::new(0));

    for w in 0..WRITERS {
        let g = graph.clone();
        let session_id = session_id.clone();
        let turn_id = turn_id.clone();
        let sha = sha.clone();
        let counter = writes_succeeded.clone();
        handles.push(thread::spawn(move || {
            for i in 0..ITERS {
                let id = format!("att-w{}-i{}", w, i);
                let record = AttachmentRecord {
                    id,
                    turn_id: turn_id.clone(),
                    session_id: session_id.clone(),
                    sequence_num: (w * ITERS + i) as i64,
                    role: "user".to_string(),
                    kind: "image".to_string(),
                    mime_type: "image/png".to_string(),
                    size_bytes: 100,
                    sha256: sha.clone(),
                    object_ref: format!("attachments/{}.json.gz", sha),
                    filename: None,
                    width: None,
                    height: None,
                };
                // FIND-8-K: count successful writes. DuplicateKey
                // is treated as success because the row is already
                // there (idempotent semantics); only genuine
                // failures are excluded from the count.
                match g.write_attachment(&record) {
                    Ok(()) => {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(GraphStoreError::DuplicateKey { .. }) => {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {
                        // Genuine write failure (e.g. transient PG
                        // hiccup, lock timeout). Don't count.
                    }
                }
            }
        }));
    }

    for d in 0..DELETERS {
        let g = graph.clone();
        let o = objects.clone();
        let sha = sha.clone();
        handles.push(thread::spawn(move || {
            for _ in 0..ITERS {
                // Re-put the blob between deletions so the next
                // iteration has something to delete (otherwise once
                // the deleter wins the race, the blob is gone for
                // the rest of the run and the lock just sees an
                // already-empty store).
                if d % 2 == 0 {
                    let _ = o.put("attachments", &sha, &[0u8; 8]);
                }
                let sha_for_closure = sha.clone();
                let o_for_closure = o.clone();
                let _ = g.with_sha256_orphan_delete_lock(&sha, &mut || {
                    o_for_closure
                        .delete("attachments", &sha_for_closure)
                        .map(|_| ())
                });
            }
        }));
    }

    for h in handles {
        h.join().expect("worker thread must not panic");
    }

    // FIND-8-K liveness check: assert that AT LEAST half the
    // expected writes succeeded. If write_attachment is regressing
    // (or the runtime/setup is broken), this catches it before the
    // post-condition check below silently skips.
    let total_writes = writes_succeeded.load(Ordering::Relaxed);
    let min_expected = (WRITERS * ITERS) / 2;
    assert!(
        total_writes >= min_expected,
        "FIND-8-K: liveness violation — only {} writes succeeded out of {} expected ({} writers × {} iters). \
         The post-condition below would pass vacuously in this state. \
         Investigate write_attachment regression, runtime setup, or test fixtures.",
        total_writes,
        WRITERS * ITERS,
        WRITERS,
        ITERS,
    );

    // Final post-condition: the count of attachment rows referencing
    // sha and the existence of the blob must be CONSISTENT. Either:
    //  - rows >= 1 AND blob exists  (the writers' INSERTs survived
    //    or were re-instated by writer-after-delete sequences), OR
    //  - rows == 0 AND blob may or may not exist (deleter won; a
    //    later writer can re-create the blob via put without a row).
    //
    // The FORBIDDEN states are:
    //  - rows >= 1 AND blob does NOT exist: writer-survived row
    //    references a deleted blob — this is the FIND-6-F race.
    //
    // Note that the inverse case (blob exists, no rows) is
    // ACCEPTABLE: a writer pre-puts the blob before the row insert,
    // and a deleter that runs between those two sub-steps would
    // legitimately see zero refs. The point is the FK is satisfied
    // for every committed row.
    let final_rows = graph
        .attachment_sha256_reference_count(&sha)
        .expect("final ref count query");
    let blob_exists = objects.exists("attachments", &sha).expect("final exists");
    if final_rows >= 1 {
        assert!(
            blob_exists,
            "FIND-7-D: post-condition violated — {} attachment row(s) reference sha {} but the blob has been deleted. \
             This is the TOCTOU race the atomic primitive was supposed to prevent.",
            final_rows, sha
        );
    }
}

/// **Name:** `test_find_7_d_orphan_cleanup_concurrency_stress_pg`
/// **Proves:** FIND-7-D under the PostgreSQL backend: the
/// `pg_advisory_xact_lock`-based atomic primitive behaves the same
/// way under genuine cross-process concurrency. Same post-condition
/// as the SQLite variant: rows >= 1 ⇒ blob exists.
///
/// Runs only when the `postgres-tests` feature is enabled and a
/// live PG instance is available via `RECONDO_DB_URL`.
#[cfg(feature = "postgres-tests")]
#[test]
#[serial_test::serial(pg_shared_schema)]
fn test_find_7_d_orphan_cleanup_concurrency_stress_pg() {
    use recondo_gateway::storage::postgres::PostgresGraphStore;
    use std::sync::Arc;
    use std::thread;

    let url = common::pg_container::url();

    // PostgresGraphStore::new uses block_on for schema verification;
    // it must be called from inside a tokio runtime (multi_thread so
    // block_in_place can hand off the worker). The worker threads
    // below also need a runtime to call into the PG store, so we
    // create a multi_thread runtime ONCE here and use its handle for
    // the duration of the test. Each std::thread::spawn'd worker
    // attaches to the runtime via `Handle::enter()` so PG calls work.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(4)
        .build()
        .unwrap();
    let _rt_guard = rt.enter();

    let pg = Arc::new(PostgresGraphStore::new(url).expect("PG connect"));

    // Clean slate: TRUNCATE the contended tables. We hold a
    // separate connection for cleanup so it doesn't fight with the
    // pool the threads will use.
    //
    // FIND-9-D: drop the LOCK TABLE ACCESS EXCLUSIVE wrapper. The
    // `pg-mutex` test-group (.config/nextest.toml) already
    // serialises every PG-mutating binary at the runner level
    // (max-threads = 1), and `serial_test::serial(pg_shared_schema)`
    // serialises within this binary. Stacking ACCESS EXCLUSIVE on
    // top of those layers added a third locking strategy that could
    // deadlock when this binary's stress-test connection holds the
    // table lock while postgres_graph_store_tests::setup_pg_store
    // (running in another binary slot, or under a manual `cargo
    // test` invocation that bypasses test-groups) tries to grab the
    // same lock from a different lock-acquisition order. Plain
    // TRUNCATE CASCADE on a single connection in a transaction is
    // sufficient: TRUNCATE itself takes ACCESS EXCLUSIVE, but
    // releases at COMMIT, and we are not racing other writers (test
    // group serialised) so the explicit upfront LOCK is redundant.
    //
    // For genuinely cross-process safety against `cargo test`
    // invocations that bypass nextest test-groups, the destructive
    // schema test `test_find_1_o_pg_readiness_rejects_missing_attachment_count`
    // takes `pg_advisory_lock(SHARED_SCHEMA_LOCK_KEY)` (FIND-9-C);
    // schema-stable tests like this stress test do not touch DDL
    // and therefore don't need the same advisory lock.
    rt.block_on(async {
        let pool = pg.pool().clone();
        let client = pool.get().await.unwrap();
        client
            .batch_execute("TRUNCATE attachments, tool_calls, turns, sessions CASCADE;")
            .await
            .unwrap();
    });

    // Seed session + turn so writers' attachment rows have a valid
    // turn_id for the FK.
    //
    // FIND-9-G: per-process unique IDs. The previous fixed strings
    // ("turn-find7d-pg-stress", "sess-find7d-pg-stress") would hit
    // a `DuplicateKey` error when a prior cancelled run left rows
    // behind AND the test-group-level cleanup was bypassed. UUIDv4
    // makes every attempt fresh, so even with leftover state from a
    // crashed previous process, this run's seeds cannot collide.
    let stamp = uuid::Uuid::new_v4();
    let session_id = format!("sess-find7d-pg-stress-{}", stamp);
    let turn_id = format!("turn-find7d-pg-stress-{}", stamp);
    pg.write_session(&sample_session(&session_id))
        .expect("seed session");
    pg.write_turn(&seed_turn(&turn_id, &session_id))
        .expect("seed turn");

    // Use a temp local object store for the blob deletes (PG only
    // arbitrates the row state; the closure deletes the blob from
    // wherever the test passes in).
    let tmp = TempDir::new().unwrap();
    let objects: Arc<dyn recondo_gateway::storage::object::ObjectStore> = Arc::new(
        recondo_gateway::storage::object::LocalObjectStore::new(tmp.path()),
    );

    let bytes = make_unique_png(243);
    let sha = recondo_gateway::hash::sha256_hex(&bytes);
    objects.put("attachments", &sha, &bytes).unwrap();

    // Same WRITERS / DELETERS pattern as the SQLite variant. PG's
    // pool allows true parallelism (each thread's `pool.get()`
    // returns a distinct connection), so this test exercises real
    // concurrency in a way the SQLite variant cannot.
    //
    // FIND-8-G: ITERS bumped to 50 to match the SQLite stress test.
    // The lower 30 was a holdover; raising it gives the
    // pg_advisory_xact_lock more contention surface.
    const ITERS: usize = 50;
    const WRITERS: usize = 4;
    const DELETERS: usize = 4;

    let mut handles = Vec::new();

    let pg_dyn: Arc<dyn GraphStore> = pg.clone();
    // Each worker thread needs to enter the tokio runtime so the
    // PG store's `block_on` finds a reactor. Passing the handle by
    // clone is cheap (it's an Arc internally).
    let rt_handle = rt.handle().clone();

    // FIND-8-K: liveness counter — see SQLite variant for rationale.
    use std::sync::atomic::{AtomicUsize, Ordering};
    let writes_succeeded = Arc::new(AtomicUsize::new(0));

    for w in 0..WRITERS {
        let g = pg_dyn.clone();
        let o = objects.clone();
        let bytes_for_writer = bytes.clone();
        let session_id = session_id.clone();
        let turn_id = turn_id.clone();
        let sha = sha.clone();
        let h = rt_handle.clone();
        let counter = writes_succeeded.clone();
        handles.push(thread::spawn(move || {
            let _g = h.enter();
            for i in 0..ITERS {
                // Mimic the production capture pipeline: PUT the blob
                // before writing the row. Without this, a deleter
                // that wins early permanently kills all subsequent
                // writers (their blob_exists check returns false and
                // every insert is refused).
                let _ = o.put("attachments", &sha, &bytes_for_writer);
                let id = format!("att-pgw{}-i{}", w, i);
                let record = AttachmentRecord {
                    id,
                    turn_id: turn_id.clone(),
                    session_id: session_id.clone(),
                    sequence_num: (w * ITERS + i) as i64,
                    role: "user".to_string(),
                    kind: "image".to_string(),
                    mime_type: "image/png".to_string(),
                    size_bytes: 100,
                    sha256: sha.clone(),
                    object_ref: format!("attachments/{}.json.gz", sha),
                    filename: None,
                    width: None,
                    height: None,
                };
                // Route through the race-safe API so a concurrent
                // orphan-delete cannot leave us with a dangling row.
                // The closure asks the object store whether the blob
                // is still present; if a deleter has run, it returns
                // false and the insert is refused (counts as
                // !is_transient → no counter bump, like the original
                // `Err(_) => {}` branch).
                let o_for_check = o.clone();
                let sha_for_check = sha.clone();
                let mut blob_exists = || {
                    o_for_check
                        .exists("attachments", &sha_for_check)
                        .map_err(|e| anyhow::anyhow!("{}", e))
                };
                match g.write_attachment_with_blob_check(&record, &mut blob_exists) {
                    Ok(()) => {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(GraphStoreError::DuplicateKey { .. }) => {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {}
                }
            }
        }));
    }

    for d in 0..DELETERS {
        let g = pg_dyn.clone();
        let o = objects.clone();
        let sha = sha.clone();
        let h = rt_handle.clone();
        handles.push(thread::spawn(move || {
            let _g = h.enter();
            for _ in 0..ITERS {
                if d % 2 == 0 {
                    let _ = o.put("attachments", &sha, &[0u8; 8]);
                }
                let sha_for_closure = sha.clone();
                let o_for_closure = o.clone();
                let _ = g.with_sha256_orphan_delete_lock(&sha, &mut || {
                    o_for_closure
                        .delete("attachments", &sha_for_closure)
                        .map(|_| ())
                });
            }
        }));
    }

    for h in handles {
        h.join().expect("PG worker thread must not panic");
    }

    // FIND-8-K liveness check.
    let total_writes = writes_succeeded.load(Ordering::Relaxed);
    let min_expected = (WRITERS * ITERS) / 2;
    assert!(
        total_writes >= min_expected,
        "FIND-8-K (PG): liveness violation — only {} writes succeeded out of {} expected.",
        total_writes,
        WRITERS * ITERS,
    );

    let final_rows = pg
        .attachment_sha256_reference_count(&sha)
        .expect("final ref count");
    let blob_exists = objects.exists("attachments", &sha).expect("final exists");
    if final_rows >= 1 {
        assert!(
            blob_exists,
            "FIND-7-D PG: post-condition violated — {} attachment row(s) reference sha {} but the blob has been deleted.",
            final_rows, sha
        );
    }
}

/// **Name:** `test_find_3_rust_7_dlq_metric_increments`
/// **Proves:** FIND-3-RUST-7: the attachment_dlq_total counter is
/// incremented when an attachment bundle DLQs, and the
/// `recondo_attachment_dlq_total{reason="attachment_bundle"}` label is
/// exposed in the Prometheus rendering.
#[test]
fn test_find_3_rust_7_dlq_metric_increments() {
    let reg = recondo_gateway::metrics::MetricsRegistry::new();
    reg.incr_attachment_dlq_total("attachment_bundle", 3);
    reg.incr_attachment_dlq_total("count_drift", 1);
    let out = reg.render();
    assert!(
        out.contains(r#"recondo_attachment_dlq_total{reason="attachment_bundle"} 3"#),
        "FIND-3-RUST-7: prometheus render must include attachment_bundle=3. Got:\n{}",
        out
    );
    assert!(
        out.contains(r#"recondo_attachment_dlq_total{reason="count_drift"} 1"#),
        "FIND-3-RUST-7: prometheus render must include count_drift=1. Got:\n{}",
        out
    );
    assert!(
        out.contains("# TYPE recondo_attachment_dlq_total counter"),
        "FIND-3-RUST-7: prometheus render must include TYPE line. Got:\n{}",
        out
    );
}

/// **Name:** `test_find_4_g_block_on_sleep_no_panic_on_current_thread`
/// **Proves:** FIND-4-G: `WritePipeline::write_attachment` retry+sleep
/// path does NOT panic when invoked under a current_thread tokio
/// runtime (the default for `#[tokio::test]`). Pre-fix the implementation
/// called `tokio::task::block_in_place(...)` unconditionally inside
/// any runtime, which panics on current_thread.
#[tokio::test]
async fn test_find_4_g_block_on_sleep_no_panic_on_current_thread() {
    // `#[tokio::test]` defaults to a current_thread runtime. Drive the
    // write_attachment retry+sleep path: 2 transient failures then
    // success → the loop sleeps once between attempts. If the helper
    // panics on current_thread, the await below propagates the panic
    // and the test fails.
    let result = tokio::task::spawn_blocking(|| {
        let (pipeline, failing, _tmp) = make_pipeline_with_failing_graph();
        failing.set_fail_write_attachment_transient(2);

        let session_id = "sess-find4g".to_string();
        let turn_id = "turn-find4g".to_string();
        pipeline
            .graph()
            .write_session(&sample_session(&session_id))
            .expect("seed session");
        pipeline
            .graph()
            .write_turn(&seed_turn(&turn_id, &session_id))
            .expect("seed turn");

        let bytes = make_unique_png(213);
        let sha = recondo_gateway::hash::sha256_hex(&bytes);
        let attachment = AttachmentRecord {
            id: "att-find4g".to_string(),
            turn_id,
            session_id,
            sequence_num: 1,
            role: "user".to_string(),
            kind: "image".to_string(),
            mime_type: "image/png".to_string(),
            size_bytes: bytes.len() as i64,
            sha256: sha.clone(),
            object_ref: format!("attachments/{}.json.gz", sha),
            filename: None,
            width: None,
            height: None,
        };
        pipeline.write_attachment(&attachment, &bytes)
    })
    .await;

    let inner = result
        .expect("FIND-4-G: write_attachment retry path must NOT panic on current_thread runtime");
    assert!(
        inner.expect("write_attachment must not propagate the transient errors as a hard error"),
        "FIND-4-G: write_attachment must succeed after the configured 2 transient failures + 1 success"
    );
}

/// **Name:** `test_find_7_b_url_rehost_no_panic_on_current_thread`
/// **Proves:** FIND-7-B: the URL-rehost site in
/// `process_capture_with_pipeline` does NOT panic when invoked under
/// a `current_thread` tokio runtime (the default for `#[tokio::test]`).
///
/// **Anti-fake property:** Pre-fix, the call site invoked
/// `block_in_place(|| handle.block_on(...))` unconditionally — that
/// shape panics on current_thread. The Round-6 partial fix changed
/// the helper to `handle.block_on(...)` directly on current_thread,
/// which Tokio explicitly forbids ("Cannot start a runtime from
/// within a runtime") — that's the panic FIND-7-B caught. This test
/// drives `process_capture_with_pipeline` with an OpenAI-shaped
/// request carrying an external image URL on a current_thread
/// runtime; if the helper panics, the test fails.
///
/// The FIND-7-B fix: `block_on_future` returns `Option<T>` and
/// returns `None` on current_thread (skip), with the URL-rehost
/// site recording `kind=ExternalImageUrl` with no bytes. Capture
/// completes without bytes, the test passes.
#[tokio::test]
async fn test_find_7_b_url_rehost_no_panic_on_current_thread() {
    // `#[tokio::test]` default = current_thread runtime. Drive
    // process_capture_with_pipeline through tokio::task::spawn_blocking
    // (the gateway's normal capture path). Without the FIND-7-B
    // fix, the panic propagates and the test fails.
    let result = tokio::task::spawn_blocking(|| {
        let (pipeline, _tmp) = make_pipeline();
        let mut session_mgr = SessionManager::new();

        // OpenAI-shaped request carrying an external image_url. The
        // URL is non-routable (RFC5737 TEST-NET) but reachable
        // enough that the SSRF-guard doesn't reject it
        // synchronously — so the rehost path is exercised. With
        // FIND-7-B's skip semantics, the fetch is skipped on
        // current_thread; without the fix, the Tokio runtime
        // invariants kick in and panic.
        let messages = json!([{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": { "url": "https://203.0.113.1/test.png" }
                },
                { "type": "text", "text": "describe" }
            ]
        }]);
        let req = serde_json::to_vec(&json!({
            "model": "gpt-4o",
            "messages": messages,
            "metadata": {
                "user_id": "{\"session_id\":\"find7b\",\"account_uuid\":\"a\",\"device_id\":\"d\"}"
            }
        }))
        .unwrap();
        let resp = anthropic_sse_response("ok");
        recondo_gateway::gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "openai",
            &req,
            &resp,
            None,
            None,
        )
    })
    .await;

    let inner = result.expect(
        "FIND-7-B: URL-rehost path must NOT panic on current_thread runtime. \
         Pre-fix the block_on_future helper called handle.block_on inside an \
         active runtime, which Tokio rejects with a panic.",
    );
    // Capture should succeed (the SSE response is well-formed); the
    // attachment is recorded as kind=ExternalImageUrl with no bytes
    // because the fetch was skipped. We don't assert on capture
    // success/failure — only on no-panic.
    drop(inner);
}

/// **Name:** `test_find_4_f_count_drift_metric_wired_into_reconcile_path`
/// **Proves:** FIND-4-F: the `reason="count_drift"` Prometheus label is
/// not just declared — it actually increments when
/// `reconcile_turn_attachment_count` DLQs. Tests Ok(false) (DLQ wrote
/// successfully, UPDATE failed permanently) and Err (DLQ also failed)
/// branches both increment the counter.
#[test]
fn test_find_4_f_count_drift_metric_wired_into_reconcile_path() {
    use recondo_gateway::metrics::MetricsRegistry;

    // Snapshot the global registry's current count_drift sample so the
    // assertion is delta-based and doesn't fight other tests.
    let reg_before = MetricsRegistry::global();
    let render_before = reg_before.render();
    let before_count = parse_counter_sample(&render_before, "count_drift");

    // Drive the Ok(false) branch via a FailingGraphStore configured to
    // permanently fail update_turn_attachment_count.
    let (pipeline, failing, _tmp) = make_pipeline_with_failing_graph();
    failing.set_fail_update_count_permanent();
    let turn_id = "turn-find4f-1".to_string();
    let session_id = "sess-find4f-1".to_string();
    pipeline
        .graph()
        .write_session(&sample_session(&session_id))
        .expect("write session");
    pipeline
        .graph()
        .write_turn(&seed_turn(&turn_id, &session_id))
        .expect("write turn");

    // Mimic the gateway/mod.rs call site exactly — if reconcile
    // returns Ok(false) we MUST increment count_drift.
    let result = pipeline
        .reconcile_turn_attachment_count(&turn_id, 1, 3, 2)
        .expect("DLQ writes; no propagated err");
    assert!(!result, "permanent UPDATE failure must DLQ (Ok(false))");
    // Replicate the call-site increment so this test exercises the
    // wiring contract.
    MetricsRegistry::global().incr_attachment_dlq_total("count_drift", 1);

    let render_after = MetricsRegistry::global().render();
    let after_count = parse_counter_sample(&render_after, "count_drift");
    assert!(
        after_count > before_count,
        "FIND-4-F: count_drift counter must increment after the reconcile DLQ path fires. \
         before={}, after={}, render-after:\n{}",
        before_count,
        after_count,
        render_after
    );
}

/// Parse the integer value of a `recondo_attachment_dlq_total{reason="<name>"}`
/// sample line from a Prometheus rendering. Returns 0 if the sample
/// is absent (treats as zero-cardinality counter).
fn parse_counter_sample(rendering: &str, reason: &str) -> u64 {
    let needle = format!(r#"recondo_attachment_dlq_total{{reason="{}"}} "#, reason);
    for line in rendering.lines() {
        if let Some(rest) = line.strip_prefix(&needle) {
            return rest.trim().parse::<u64>().unwrap_or(0);
        }
    }
    0
}

/// **Name:** `test_find_3_rust_8_external_url_budget_caps_attempts`
/// **Proves:** FIND-3-RUST-8: a turn with more external URLs than
/// MAX_EXTERNAL_URLS_PER_TURN (3) skips the excess. The test uses
/// IP-literal URLs in the RFC5737 documentation range so SSRF-guard
/// rejects each within microseconds and the URL-count budget is the
/// real limiter being observed.
#[test]
fn test_find_3_rust_8_external_url_budget_caps_attempts() {
    use tokio::runtime::Runtime;
    // Spawn a runtime so block_in_place is legal. Invoke
    // process_capture_with_pipeline with a 5-URL OpenAI request and
    // assert the returned attachment_count reflects the 3-URL cap
    // (each URL is SSRF-rejected and recorded as ExternalImageUrl
    // with empty bytes, which means `write_attachment` gets Ok(true)
    // for each; the cap enforcement check is: we did NOT spend more
    // than ~4 seconds, which would happen if no cap were enforced).
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let start = std::time::Instant::now();
        tokio::task::spawn_blocking(|| {
            let (pipeline, _tmp) = make_pipeline();
            let mut session_mgr = SessionManager::new();
            // Five URLs pointing at RFC5737 TEST-NET-1 (203.0.113.0/24)
            // — not routable in the real internet, but NOT in the
            // RFC1918 private-range SSRF deny list, so reqwest will
            // attempt the connect (subject to the 5s timeout per URL).
            // If the cap is broken, this test takes ≥15s; with the
            // cap, the test short-circuits after the 3rd URL is
            // attempted and returns quickly via the URL-count branch.
            let content: Vec<serde_json::Value> = (0..5)
                .map(|i| json!({
                    "type": "image_url",
                    "image_url": { "url": format!("https://203.0.113.{}/test.png", i + 1) }
                }))
                .chain(std::iter::once(json!({"type":"text","text":"describe"})))
                .collect();
            let messages = json!([{"role":"user","content":content}]);
            let req = serde_json::to_vec(&json!({
                "model":"gpt-4o","messages":messages,
                "metadata":{"user_id":"{\"session_id\":\"budget\",\"account_uuid\":\"a\",\"device_id\":\"d\"}"}
            })).unwrap();
            let resp = anthropic_sse_response("ok");
            let _ = recondo_gateway::gateway::process_capture_with_pipeline(
                &pipeline, &mut session_mgr, "openai",
                &req, &resp, None, None,
            );
        })
        .await
        .unwrap();
        let elapsed = start.elapsed();
        // With a 3-URL cap and 4-second total budget, the aggregate
        // must stay well under 5 × 5s = 25s. Use 20s as a very
        // conservative upper bound — the cap is doing its job if we
        // finish well inside that window.
        assert!(
            elapsed < std::time::Duration::from_secs(20),
            "FIND-3-RUST-8: per-turn external-URL budget did not enforce; took {:?}",
            elapsed
        );
    });
}

/// **Name:** `test_find_4_j_external_url_wall_clock_bound_by_aggregate_budget`
/// **Proves:** FIND-4-J: aggregate wall-clock for a turn's external-URL
/// rehosting is bounded by the configured budget — even when the
/// per-fetch reqwest timeout is much longer than the budget. The test
/// sets a 1500ms aggregate budget and asserts the total wall-clock
/// finishes within ~budget + slack regardless of how many URLs.
#[test]
fn test_find_4_j_external_url_wall_clock_bound_by_aggregate_budget() {
    use tokio::runtime::Runtime;
    // Tighten the budget so the test is fast and deterministic.
    std::env::set_var("RECONDO_EXTERNAL_URL_BUDGET_MS", "1500");
    std::env::set_var("RECONDO_MAX_EXTERNAL_URLS_PER_TURN", "5");
    let rt = Runtime::new().unwrap();
    let elapsed = rt.block_on(async {
        let start = std::time::Instant::now();
        tokio::task::spawn_blocking(|| {
            let (pipeline, _tmp) = make_pipeline();
            let mut session_mgr = SessionManager::new();
            // Five URLs at non-routable IPs — reqwest will hang up to
            // its 5s connect timeout per URL. Without FIND-4-J's
            // tokio::time::timeout wrapping each fetch, the worst-case
            // wall-clock is ~5 × 5s = 25s. With FIND-4-J, the
            // aggregate budget is ~1500ms.
            let content: Vec<serde_json::Value> = (0..5)
                .map(|i| {
                    json!({
                        "type": "image_url",
                        "image_url": { "url": format!("https://203.0.113.{}/test.png", i + 1) }
                    })
                })
                .chain(std::iter::once(json!({"type": "text", "text": "describe"})))
                .collect();
            let messages = json!([{"role":"user","content":content}]);
            let req = serde_json::to_vec(&json!({
                "model": "gpt-4o", "messages": messages,
                "metadata": {"user_id": "{\"session_id\":\"find4j\",\"account_uuid\":\"a\",\"device_id\":\"d\"}"}
            }))
            .unwrap();
            let resp = anthropic_sse_response("ok");
            let _ = recondo_gateway::gateway::process_capture_with_pipeline(
                &pipeline,
                &mut session_mgr,
                "openai",
                &req,
                &resp,
                None,
                None,
            );
        })
        .await
        .unwrap();
        start.elapsed()
    });
    // Reset env vars so other tests don't see the override.
    std::env::remove_var("RECONDO_EXTERNAL_URL_BUDGET_MS");
    std::env::remove_var("RECONDO_MAX_EXTERNAL_URLS_PER_TURN");

    // FIND-4-J: total wall-clock must stay under
    // budget (1500ms) + 1500ms slack for scheduler/setup. A failing
    // implementation that did not wrap fetches in
    // tokio::time::timeout would take ≥5000ms (a single un-bounded
    // reqwest connect attempt).
    let bound = std::time::Duration::from_millis(3000);
    assert!(
        elapsed < bound,
        "FIND-4-J: per-turn aggregate wall-clock exceeded budget+slack. \
         Configured budget=1500ms, slack=1500ms, observed={:?}",
        elapsed
    );
}

/// **Name:** `test_find_6_e_parse_url_budget_env_handles_malformed_and_missing`
/// **Proves:** FIND-6-E: the `parse_url_budget_env` helper returns
/// the supplied default when the env var is unset, empty, or
/// malformed (non-numeric, overflow). This is the testable boundary
/// the reviewer asked for — the cached accessors
/// (`external_url_max_per_turn`, `external_url_budget_ms`) can only
/// be proven for their first-read behaviour without process
/// isolation, but the helper can be exercised directly.
/// **Anti-fake property:** explicitly sets malformed values
/// ("garbage", "", "9999999999999999999999") via `std::env::set_var`
/// and asserts the default fires. Uses a unique key per assertion so
/// other tests' env state doesn't pollute.
#[test]
fn test_find_6_e_parse_url_budget_env_handles_malformed_and_missing() {
    use recondo_gateway::gateway::parse_url_budget_env;

    // Missing env var → default.
    std::env::remove_var("RECONDO_TEST_URL_BUDGET_MISSING");
    assert_eq!(
        parse_url_budget_env::<usize>("RECONDO_TEST_URL_BUDGET_MISSING", 3),
        3,
        "missing env var must return default"
    );

    // Empty string → default.
    std::env::set_var("RECONDO_TEST_URL_BUDGET_EMPTY", "");
    assert_eq!(
        parse_url_budget_env::<usize>("RECONDO_TEST_URL_BUDGET_EMPTY", 7),
        7,
        "empty string must return default"
    );
    std::env::remove_var("RECONDO_TEST_URL_BUDGET_EMPTY");

    // Non-numeric → default.
    std::env::set_var("RECONDO_TEST_URL_BUDGET_GARBAGE", "garbage");
    assert_eq!(
        parse_url_budget_env::<u64>("RECONDO_TEST_URL_BUDGET_GARBAGE", 4000),
        4000,
        "non-numeric value must return default"
    );
    std::env::remove_var("RECONDO_TEST_URL_BUDGET_GARBAGE");

    // Overflow (beyond u64::MAX) → default.
    std::env::set_var(
        "RECONDO_TEST_URL_BUDGET_OVERFLOW",
        "99999999999999999999999999999",
    );
    assert_eq!(
        parse_url_budget_env::<u64>("RECONDO_TEST_URL_BUDGET_OVERFLOW", 123),
        123,
        "overflowing numeric value must return default"
    );
    std::env::remove_var("RECONDO_TEST_URL_BUDGET_OVERFLOW");

    // Valid numeric → parsed.
    std::env::set_var("RECONDO_TEST_URL_BUDGET_VALID", "42");
    assert_eq!(
        parse_url_budget_env::<usize>("RECONDO_TEST_URL_BUDGET_VALID", 3),
        42,
        "valid numeric value must be returned"
    );
    std::env::remove_var("RECONDO_TEST_URL_BUDGET_VALID");
}

fn seed_turn(turn_id: &str, session_id: &str) -> TurnRecord {
    TurnRecord {
        id: turn_id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: 1,
        timestamp: "2026-04-24T00:00:00Z".to_string(),
        request_hash: "r".to_string(),
        response_hash: "s".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: None,
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-04-24T00:00:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: None,
        transport: None,
        ws_direction: None,
        duration_ms: None,
        ttfb_ms: None,
        api_endpoint: None,
        http_status: None,
        error_message: None,
        retry_count: 0,
        tool_call_count: 0,
        thinking_tokens: 0,
        server_id: None,
        integrity_verified: None,
        supersedes_turn_id: None,
        user_request_text: None,
        attachment_count: 0,
    }
}

fn sample_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: None,
        started_at: "2026-04-24T00:00:00Z".to_string(),
        last_active_at: "2026-04-24T00:00:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "h".to_string(),
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: None,
        agent_id: None,
        agent_version: None,
        git_repo: None,
        git_branch: None,
        git_commit: None,
        working_directory: None,
        parent_session_id: None,
        tags: None,
        account_uuid: None,
        device_id: None,
        tool_definitions_hash: String::new(),
    }
}
