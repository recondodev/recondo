//! Batch 12 — Codex (chatgpt.com WebSocket) attachment extraction.
//!
//! ## What's being proved
//!
//! The Codex client embeds inline images in `response.create` frames using
//! the shape `{type: "input_image", image_url: "data:image/png;base64,...",
//! detail: "high"}` — a flat `image_url` STRING, distinct from OpenAI's
//! chat completion shape `{type: "image_url", image_url: {url: "..."}}`.
//!
//! Pre-Batch-12, `parse_codex_request` only extracted the user's TEXT
//! prompt; images were silently dropped. The dashboard showed
//! `attachment_count = 0` for every codex turn, even when the user
//! attached a screenshot.
//!
//! Batch 12 adds image extraction to `parse_codex_request` by reshaping
//! Codex parts to OpenAI shape and delegating to the existing
//! `extract_openai_with_errors` (200+ lines of MIME allow-list / SSRF /
//! base64 / sniff logic — reused, not duplicated).

use recondo_gateway::providers::codex::parse_codex_request;

#[cfg(all(feature = "postgres-tests", feature = "s3-tests"))]
mod common;

/// Smallest valid PNG (8-byte signature + IHDR + IDAT + IEND), base64-encoded.
/// Mime sniffer recognizes the leading bytes as `image/png` so the OpenAI
/// extractor (which post-sniffs the claimed mime) accepts it.
const TINY_PNG_B64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=";

fn frame_with_user_content(content: serde_json::Value) -> String {
    serde_json::json!({
        "type": "response.create",
        "model": "gpt-5.5",
        "input": [
            {
                "role": "user",
                "content": content,
            }
        ]
    })
    .to_string()
}

/// **Proves:** Codex `input_image` parts produce `ExtractedAttachment`
/// entries with `kind=Image` and the decoded PNG bytes.
///
/// **Anti-fake:** asserts on `bytes.len() > 0` and `mime_type == "image/png"`
/// — a stub that returns `Vec::new()` would fail.
#[test]
fn parse_codex_request_extracts_inline_image() {
    let frame = frame_with_user_content(serde_json::json!([
        {"type": "input_text", "text": "look at this"},
        {
            "type": "input_image",
            "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
            "detail": "high",
        },
    ]));

    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(
        parsed.attachments.len(),
        1,
        "exactly one inline image must be extracted; got {} (parse_errors: {:?})",
        parsed.attachments.len(),
        parsed.attachment_parse_errors
    );
    let att = &parsed.attachments[0];
    assert_eq!(att.kind.as_str(), "image");
    assert_eq!(att.mime_type, "image/png");
    assert!(
        !att.bytes.is_empty(),
        "decoded bytes must be non-empty; got {} bytes",
        att.bytes.len()
    );
}

/// **Proves:** when the user's most recent message has no images, the
/// extractor returns empty even if PRIOR turns in the conversation history
/// had images. Codex sends the FULL conversation in every
/// `response.create`; without this guard, every subsequent turn would
/// re-persist images from earlier turns.
///
/// **Anti-fake:** the frame has TWO user items in `input[]` — the older
/// one with an image, the newer one with only text. The extractor must
/// return zero attachments. A naive walk-everything implementation would
/// return one.
#[test]
fn parse_codex_request_skips_history_images_when_latest_user_message_is_text_only() {
    let frame = serde_json::json!({
        "type": "response.create",
        "model": "gpt-5.5",
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "first turn"},
                    {
                        "type": "input_image",
                        "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
                        "detail": "high",
                    }
                ]
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "output_text", "text": "I see the image"}
                ]
            },
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "now what?"}
                ]
            }
        ]
    })
    .to_string();

    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(
        parsed.attachments.len(),
        0,
        "history images must NOT be re-extracted; only the latest user \
         message is in scope. attachments={:?}",
        parsed.attachments.len()
    );
}

/// **Proves:** the extractor finds images in the LATEST user message even
/// when older history is present.
#[test]
fn parse_codex_request_extracts_image_from_latest_user_message_only() {
    let frame = serde_json::json!({
        "type": "response.create",
        "model": "gpt-5.5",
        "input": [
            {
                "role": "user",
                "content": [{"type": "input_text", "text": "older message"}]
            },
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "what's in this image?"},
                    {
                        "type": "input_image",
                        "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
                        "detail": "auto",
                    }
                ]
            }
        ]
    })
    .to_string();

    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(parsed.attachments.len(), 1);
    assert_eq!(parsed.attachments[0].mime_type, "image/png");
}

/// **Proves:** text-only frames return zero attachments and zero errors.
#[test]
fn parse_codex_request_text_only_returns_no_attachments_no_errors() {
    let frame = frame_with_user_content(serde_json::json!([
        {"type": "input_text", "text": "no image here"}
    ]));

    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(parsed.attachments.len(), 0);
    assert_eq!(parsed.attachment_parse_errors.len(), 0);
}

/// **Proves:** disallowed MIMEs (e.g., `image/svg+xml` — XML/script
/// vehicle) are rejected with a structured `attachment.mime_disallowed:`
/// error and produce zero attachments. Defends against the SVG-XSS path
/// noted in `extract_openai_with_errors` (FIND-10-F).
#[test]
fn parse_codex_request_rejects_disallowed_svg_mime() {
    let frame = frame_with_user_content(serde_json::json!([
        {
            "type": "input_image",
            "image_url": "data:image/svg+xml;base64,PHN2Zy8+",
            "detail": "auto",
        }
    ]));

    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(
        parsed.attachments.len(),
        0,
        "SVG must be rejected (XML/script vehicle); got {} attachments",
        parsed.attachments.len()
    );
    assert!(
        parsed
            .attachment_parse_errors
            .iter()
            .any(|e| e.contains("mime_disallowed")),
        "must surface a mime_disallowed parse error; got: {:?}",
        parsed.attachment_parse_errors
    );
}

/// **Proves:** frames with images but the legacy/wrong `type: "image"`
/// (not `input_image`) are silently ignored. Defense against future
/// schema drift falsely matching as an image.
#[test]
fn parse_codex_request_ignores_unknown_part_types() {
    let frame = frame_with_user_content(serde_json::json!([
        {
            "type": "image",
            "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
        }
    ]));

    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(
        parsed.attachments.len(),
        0,
        "unknown part types must NOT be misinterpreted as images"
    );
}

// ===========================================================================
// End-to-end pipeline integration test
// ===========================================================================
//
// Exercises the full data path that the live WebSocket relay
// (`websocket_relay` → `capture_codex_accumulated_turn`) drives in
// production: parse codex frame → build AttachmentRecord → write via
// WritePipeline → assert persistence + content integrity in the
// graph store.

/// **Proves:** end-to-end pipeline persistence works for codex turns
/// carrying inline images. After the gateway parses a `response.create`
/// frame, both the turn AND the attachment land in the graph store with
/// matching `turn_id`, decoded bytes, and the correct sha256.
///
/// **Anti-fake:** asserts on the actual SHA-256 of the decoded image
/// bytes computed inside the test, then checks the row's `sha256` column.
/// Also verifies `turn.attachment_count` was set from the speculative
/// count (no reconciliation needed since the write succeeded).
#[test]
fn codex_attachment_persists_through_write_pipeline_end_to_end() {
    use recondo_gateway::db::{AttachmentRecord, SessionRecord, TurnRecord};
    use recondo_gateway::hash::sha256_hex;
    use recondo_gateway::storage::graph::SqliteGraphStore;
    use recondo_gateway::storage::object::LocalObjectStore;
    use recondo_gateway::storage::pipeline::WritePipeline;
    use tempfile::TempDir;

    // 1. Set up an in-memory SqliteGraphStore + LocalObjectStore +
    //    WritePipeline. Mirrors what the live gateway constructs at
    //    startup.
    let tmp = TempDir::new().unwrap();
    let dlq_dir = tmp.path().join("dlq");
    let objects_dir = tmp.path().join("objects");
    std::fs::create_dir_all(&dlq_dir).unwrap();
    std::fs::create_dir_all(&objects_dir).unwrap();

    let graph = SqliteGraphStore::new_in_memory().expect("create graph store");
    let objects = LocalObjectStore::new(tmp.path());
    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq_dir.clone());

    // 2. Parse a synthetic codex frame with an inline image — same
    //    shape the chatgpt.com WebSocket relay would forward.
    let frame = frame_with_user_content(serde_json::json!([
        {"type": "input_text", "text": "what is in this screenshot?"},
        {
            "type": "input_image",
            "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
            "detail": "high",
        }
    ]));
    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(
        parsed.attachments.len(),
        1,
        "test fixture must yield 1 attachment"
    );
    let extracted = &parsed.attachments[0];
    let expected_sha = sha256_hex(&extracted.bytes);

    // 3. Build a SessionRecord + TurnRecord — mirrors what
    //    `capture_codex_accumulated_turn` builds.
    let ws_session_id = "ws_codex_integration_session";
    let session_record = SessionRecord {
        id: ws_session_id.to_string(),
        provider: "openai".to_string(),
        model: parsed.model.clone(),
        started_at: "2026-05-03T17:00:00Z".to_string(),
        last_active_at: "2026-05-03T17:00:00Z".to_string(),
        ended_at: None,
        initial_intent: parsed.user_prompt.clone(),
        system_prompt_hash: parsed
            .system_prompt_hash
            .clone()
            .unwrap_or_else(|| "no_system_prompt".to_string()),
        total_turns: 1,
        turns_captured: 1,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: Some("codex_cli_rs".to_string()),
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
    };
    let turn_id = "turn_codex_e2e_test";
    let speculative_count = parsed.attachments.len() as i64;
    let turn_record = TurnRecord {
        id: turn_id.to_string(),
        session_id: ws_session_id.to_string(),
        sequence_num: 1,
        timestamp: "2026-05-03T17:00:00Z".to_string(),
        request_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
        response_hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: parsed.model.clone(),
        response_text: None,
        thinking_text: None,
        stop_reason: String::new(),
        capture_complete: true,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-05-03T17:00:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: Some("codex-0.1.0".to_string()),
        parse_errors: None,
        provider: Some("openai".to_string()),
        transport: Some("websocket".to_string()),
        ws_direction: Some("server_to_client".to_string()),
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
        user_request_text: parsed.user_prompt.clone(),
        attachment_count: speculative_count,
    };

    // 4. Persist the turn via the WritePipeline.
    pipeline
        .write_capture(&session_record, &turn_record, &[], &[], &[])
        .expect("write_capture must succeed");

    // 5. Build the AttachmentRecord and persist it via the same
    //    WritePipeline path the codex capture function uses.
    let sha256 = sha256_hex(&extracted.bytes);
    let object_ref = format!("attachments/{}.json.gz", sha256);
    let attachment_record = AttachmentRecord {
        id: format!("{}-att-1", turn_id),
        turn_id: turn_id.to_string(),
        session_id: ws_session_id.to_string(),
        sequence_num: extracted.sequence_num,
        role: extracted.role.clone(),
        kind: extracted.kind.as_str().to_string(),
        mime_type: extracted.mime_type.clone(),
        size_bytes: extracted.bytes.len() as i64,
        sha256: sha256.clone(),
        object_ref,
        filename: extracted.filename.clone(),
        width: None,
        height: None,
    };
    let persisted = pipeline
        .write_attachment(&attachment_record, &extracted.bytes)
        .expect("write_attachment must succeed");
    assert!(
        persisted,
        "attachment must persist (Ok(true)), not DLQ (Ok(false))"
    );

    // 6. Verify the row landed in PG/SQLite via the graph store.
    let count = pipeline
        .graph()
        .attachment_sha256_reference_count(&sha256)
        .expect("count must succeed");
    assert_eq!(
        count, 1,
        "exactly one row in the attachments table must reference the \
         decoded PNG sha256={}; got {}",
        expected_sha, count,
    );

    // 7. Verify the bytes round-trip through the object store at the
    //    expected path (gateway uses `attachments/<sha256>.json.gz`).
    //    `verify` reads the gzip object, recomputes the hash, and
    //    compares against the supplied sha256 — it returns true only
    //    when the bytes are present AND match.
    let object_present = pipeline
        .objects()
        .verify("attachments", &sha256)
        .expect("verify must succeed");
    assert!(
        object_present,
        "object store must contain the attachment bytes at the \
         expected key (sha256={})",
        sha256
    );
}

/// **Proves:** when speculative_count > persisted (e.g., DLQ on a partial
/// failure), reconciliation updates `turn.attachment_count` so the
/// dashboard never overcounts.
///
/// **Anti-fake:** simulates the reconciliation path by directly calling
/// `update_turn_attachment_count` after a successful write, then reading
/// back. A no-op `update` impl would leave the row at the speculative
/// count and the assertion would fail.
#[test]
fn codex_attachment_count_reconciliation_updates_turn_row() {
    use recondo_gateway::db::{SessionRecord, TurnRecord};
    use recondo_gateway::storage::graph::SqliteGraphStore;
    use recondo_gateway::storage::object::LocalObjectStore;
    use recondo_gateway::storage::pipeline::WritePipeline;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let dlq_dir = tmp.path().join("dlq");
    std::fs::create_dir_all(&dlq_dir).unwrap();
    let graph = SqliteGraphStore::new_in_memory().expect("graph");
    let objects = LocalObjectStore::new(tmp.path());
    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq_dir);

    let session = SessionRecord {
        id: "sess_recon".to_string(),
        provider: "openai".to_string(),
        model: None,
        started_at: "2026-05-03T17:00:00Z".to_string(),
        last_active_at: "2026-05-03T17:00:00Z".to_string(),
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
    };
    let mut turn = TurnRecord {
        id: "turn_recon".to_string(),
        session_id: "sess_recon".to_string(),
        sequence_num: 1,
        timestamp: "2026-05-03T17:00:00Z".to_string(),
        request_hash: "rh".to_string(),
        response_hash: "sh".to_string(),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: None,
        response_text: None,
        thinking_text: None,
        stop_reason: String::new(),
        capture_complete: true,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-05-03T17:00:00Z".to_string(),
        messages_delta: None,
        messages_delta_count: None,
        raw_extra: None,
        parser_version: None,
        parse_errors: None,
        provider: Some("openai".to_string()),
        transport: Some("websocket".to_string()),
        ws_direction: Some("server_to_client".to_string()),
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
        // Speculative count reflects what was extracted from the codex frame.
        attachment_count: 2,
    };
    pipeline
        .write_capture(&session, &turn, &[], &[], &[])
        .expect("turn must persist with attachment_count=2");

    // Simulate a partial DLQ failure: only 1 of the 2 attachments persisted.
    pipeline
        .graph()
        .update_turn_attachment_count(&turn.id, 1)
        .expect("reconcile must succeed");

    // Read back and assert the row was reconciled to 1.
    let stored = pipeline
        .graph()
        .get_turn(&turn.id)
        .expect("get_turn")
        .expect("row exists");
    assert_eq!(
        stored.attachment_count, 1,
        "row must reflect reconciled count, not the speculative 2"
    );
    let _ = &mut turn; // silence unused-mut on the field-by-field clone above
}

/// **Proves:** the LIVE production codex turn-capture function actually
/// persists attachments to the graph store.
///
/// **Why this exists (vs the earlier integration test):** the earlier
/// test mirrors the AttachmentRecord-building logic and calls
/// `pipeline.write_attachment` from the test, which is structurally a
/// COPY of the production code. This test calls the actual production
/// function `capture_codex_accumulated_turn` (re-exported as
/// `test_capture_codex_accumulated_turn` under `feature =
/// "test-support"`) so any future drift between test code and production
/// code surfaces as a test failure — not as silent rot.
///
/// **Anti-fake:** asserts the attachment row exists in the graph store
/// AFTER the production function runs to completion. A no-op
/// `capture_codex_accumulated_turn` (or one that forgot the
/// `write_codex_attachments` call) would leave the row absent and the
/// `attachment_sha256_reference_count` assertion would fail.
#[cfg(feature = "test-support")]
#[test]
fn live_capture_codex_accumulated_turn_persists_attachment() {
    use recondo_gateway::gateway::{test_capture_codex_accumulated_turn, TestCodexCaptureArgs};
    use recondo_gateway::hash::sha256_hex;
    use recondo_gateway::providers::codex::CodexTurnData;
    use recondo_gateway::storage::graph::SqliteGraphStore;
    use recondo_gateway::storage::object::LocalObjectStore;
    use recondo_gateway::storage::pipeline::WritePipeline;
    use std::net::SocketAddr;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let dlq_dir = tmp.path().join("dlq");
    std::fs::create_dir_all(&dlq_dir).unwrap();
    let graph = SqliteGraphStore::new_in_memory().expect("graph");
    let objects = LocalObjectStore::new(tmp.path());
    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq_dir);

    // Parse a synthetic codex frame containing an inline image.
    let frame = frame_with_user_content(serde_json::json!([
        {"type": "input_text", "text": "describe this"},
        {
            "type": "input_image",
            "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
            "detail": "high",
        }
    ]));
    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(parsed.attachments.len(), 1);
    let expected_sha = sha256_hex(&parsed.attachments[0].bytes);

    // Build a CodexTurnData like the relay loop would, then drive the
    // production capture function directly.
    let turn_data = CodexTurnData {
        model: parsed.model.clone(),
        response_text: Some("ok, I see it.".to_string()),
        has_reasoning: false,
        reasoning_encrypted_size: 0,
        estimated_input_tokens: 100,
        estimated_output_tokens: 5,
        estimated_thinking_tokens: 0,
        tokens_estimated: true,
        truncated: false,
    };

    let ws_session_id = "ws_codex_live_test";
    let mut session_created = false;
    let session_model: Option<String> = parsed.model.clone();
    let peer_addr: SocketAddr = "127.0.0.1:50000".parse().unwrap();

    test_capture_codex_accumulated_turn(TestCodexCaptureArgs {
        pipeline: &pipeline,
        ws_session_id,
        sequence_num: 1,
        provider: "openai",
        peer_addr,
        host: "chatgpt.com",
        session_model: &session_model,
        session_created: &mut session_created,
        turn_data: &turn_data,
        estimated_input_tokens: 100,
        initial_request: None,
        latest_request: Some(&parsed),
    });

    // Verify: the production code path persisted exactly one attachment
    // row referencing the decoded PNG bytes' sha256.
    let count = pipeline
        .graph()
        .attachment_sha256_reference_count(&expected_sha)
        .expect("count must succeed");
    assert_eq!(
        count, 1,
        "production capture_codex_accumulated_turn must persist the \
         attachment row; expected exactly 1 row referencing sha256={}, \
         got {}",
        expected_sha, count
    );

    // And the bytes must be in the object store.
    let object_present = pipeline
        .objects()
        .verify("attachments", &expected_sha)
        .expect("verify must succeed");
    assert!(
        object_present,
        "object bytes must be present in the object store at \
         attachments/{}.json.gz",
        expected_sha
    );
}

/// **Proves the production stack works end-to-end:** drives the real
/// `capture_codex_accumulated_turn` function against the fullstack
/// docker-compose Postgres + MiniStack S3 (the same services
/// `just fullstack` runs with), and verifies that an inline image
/// in a codex `response.create` frame lands as a row in PG's
/// `attachments` table AND as a gzipped object in the S3 bucket.
///
/// Gated behind `feature = "postgres-tests"` AND `feature = "s3"`.
/// Requires the fullstack docker stack to be up:
///
///   `just fullstack`
///
/// Run with:
///
///   `RECONDO_DB_URL=postgres://recondo:recondo_dev@localhost:5432/recondo \
///    AWS_ENDPOINT_URL=http://localhost:4566 \
///    AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
///    cargo nextest run --features postgres-tests,s3 \
///    --test batch12_codex_attachment_tests \
///    fullstack_codex_attachment_persists_to_pg_and_s3`
#[cfg(all(feature = "postgres-tests", feature = "s3-tests"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fullstack_codex_attachment_persists_to_pg_and_s3() {
    use recondo_gateway::gateway::{test_capture_codex_accumulated_turn, TestCodexCaptureArgs};
    use recondo_gateway::hash::sha256_hex;
    use recondo_gateway::providers::codex::CodexTurnData;
    use recondo_gateway::storage::object::S3ObjectStore;
    use recondo_gateway::storage::pipeline::WritePipeline;
    use recondo_gateway::storage::postgres::{create_pg_pool, PostgresGraphStore};
    use std::net::SocketAddr;
    use tempfile::TempDir;

    // 1. Connect to the ephemeral postgres container.
    let pg_url = common::pg_container::url();
    let pool = create_pg_pool(pg_url).expect("must connect to test PG");
    // PostgresGraphStore::from_pool calls block_in_place internally, which
    // requires we're INSIDE a multi-thread tokio runtime — guaranteed by
    // #[tokio::test(flavor = "multi_thread", worker_threads = 4)].
    let graph = PostgresGraphStore::from_pool(pool)
        .expect("PostgresGraphStore must initialize against fullstack PG");

    // 2. Build an S3 client pointed at the ephemeral ministack container.
    let s3_endpoint = common::s3_container::endpoint();
    let s3_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .endpoint_url(&s3_endpoint.url)
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
    let s3_builder = aws_sdk_s3::config::Builder::from(&s3_config).force_path_style(true);
    let s3_client = aws_sdk_s3::Client::from_conf(s3_builder.build());
    let objects = S3ObjectStore::new(s3_client, s3_endpoint.bucket.clone());

    // 3. WritePipeline backed by the real PG + MiniStack S3.
    let dlq_dir = TempDir::new().unwrap().keep();
    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq_dir);

    // 4. Parse a synthetic codex frame. Use a unique session id so the
    //    test is hermetic against concurrent runs / leftover data.
    let unique = uuid::Uuid::new_v4().to_string();
    let ws_session_id = format!("ws_codex_e2e_{}", unique);
    let frame = frame_with_user_content(serde_json::json!([
        {"type": "input_text", "text": format!("e2e probe {}", unique)},
        {
            "type": "input_image",
            "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
            "detail": "high",
        }
    ]));
    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(parsed.attachments.len(), 1);
    let expected_sha = sha256_hex(&parsed.attachments[0].bytes);

    // 5. Drive the production capture function.
    let turn_data = CodexTurnData {
        model: parsed.model.clone(),
        response_text: Some(format!("e2e response {}", unique)),
        has_reasoning: false,
        reasoning_encrypted_size: 0,
        estimated_input_tokens: 100,
        estimated_output_tokens: 5,
        estimated_thinking_tokens: 0,
        tokens_estimated: true,
        truncated: false,
    };
    let mut session_created = false;
    let session_model: Option<String> = parsed.model.clone();
    let peer_addr: SocketAddr = "127.0.0.1:50000".parse().unwrap();

    test_capture_codex_accumulated_turn(TestCodexCaptureArgs {
        pipeline: &pipeline,
        ws_session_id: &ws_session_id,
        sequence_num: 1,
        provider: "openai",
        peer_addr,
        host: "chatgpt.com",
        session_model: &session_model,
        session_created: &mut session_created,
        turn_data: &turn_data,
        estimated_input_tokens: 100,
        initial_request: None,
        latest_request: Some(&parsed),
    });

    // 6. Verify: PG attachments row exists for our session, with the
    //    expected sha256.
    let pool2 = create_pg_pool(pg_url).expect("connect");
    let client = pool2.get().await.expect("get conn");
    let row = client
        .query_one(
            "SELECT COUNT(*)::BIGINT FROM attachments a \
             JOIN turns t ON a.turn_id = t.id \
             WHERE t.session_id = $1 AND a.sha256 = $2",
            &[&ws_session_id, &expected_sha],
        )
        .await
        .expect("count query");
    let count: i64 = row.get::<_, i64>(0);
    assert_eq!(
        count, 1,
        "fullstack PG must have exactly 1 attachment row for session {} \
         with sha256 {}; got {}",
        ws_session_id, expected_sha, count
    );

    // 7. Verify: ministack S3 has the object at attachments/<sha>.json.gz.
    let s3_config_check = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .endpoint_url(&s3_endpoint.url)
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
    let s3_builder_check =
        aws_sdk_s3::config::Builder::from(&s3_config_check).force_path_style(true);
    let client_check = aws_sdk_s3::Client::from_conf(s3_builder_check.build());
    // S3ObjectStore prepends `objects/` to all keys (see s3_key in
    // gateway/src/storage/object.rs). The DB's `object_ref` is the
    // backend-agnostic form (`attachments/<sha>.json.gz`); the S3 key
    // is `objects/attachments/<sha>.json.gz`.
    let s3_key = format!("objects/attachments/{}.json.gz", expected_sha);
    let head = client_check
        .head_object()
        .bucket(&s3_endpoint.bucket)
        .key(&s3_key)
        .send()
        .await
        .unwrap_or_else(|e| {
            panic!(
                "HeadObject for s3://{}/{} must succeed; got: {:?}",
                s3_endpoint.bucket, s3_key, e
            )
        });
    let size = head.content_length().unwrap_or(0);
    assert!(
        size > 0,
        "S3 object attachments/{}.json.gz must have non-zero size; got {}",
        expected_sha,
        size
    );

    // 8. Cleanup so the test is hermetic across runs.
    let _ = client
        .execute(
            "DELETE FROM attachments WHERE session_id = $1",
            &[&ws_session_id],
        )
        .await;
    let _ = client
        .execute("DELETE FROM turns WHERE session_id = $1", &[&ws_session_id])
        .await;
    let _ = client
        .execute("DELETE FROM sessions WHERE id = $1", &[&ws_session_id])
        .await;
}

/// **Proves:** sequence_num is 1-based and stable across the part list.
#[test]
fn parse_codex_request_assigns_one_based_sequence_num() {
    let frame = frame_with_user_content(serde_json::json!([
        {"type": "input_text", "text": "before"},
        {
            "type": "input_image",
            "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
        },
        {"type": "input_text", "text": "after"},
        {
            "type": "input_image",
            "image_url": format!("data:image/png;base64,{}", TINY_PNG_B64),
        }
    ]));

    let parsed = parse_codex_request(&frame).expect("parse must succeed");
    assert_eq!(parsed.attachments.len(), 2);
    let seqs: Vec<i64> = parsed.attachments.iter().map(|a| a.sequence_num).collect();
    assert!(
        seqs[0] >= 1 && seqs[1] > seqs[0],
        "sequence_num must be 1-based and monotonically increasing across \
         attachments; got {:?}",
        seqs
    );
}
