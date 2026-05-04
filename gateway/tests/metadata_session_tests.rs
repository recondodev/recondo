//! Metadata-based session identity tests.
//!
//! Claude Code sends a `metadata` field in every API request body containing
//! identity signals: session_id, account_uuid, and device_id. These tests
//! verify that the gateway extracts these signals and uses them for session
//! identity instead of content-based hashing when available.
//!
//! ## Types under test
//!
//! - `recondo_gateway::session::ClientMetadata` — struct with session_id,
//!   account_uuid, device_id fields (all Option<String>)
//! - `recondo_gateway::session::extract_client_metadata` — parses request body
//!   bytes and extracts the nested metadata.user_id JSON

use recondo_gateway::db;
use recondo_gateway::hash;
use recondo_gateway::session::{self, extract_client_metadata, ClientMetadata, SessionManager};
#[allow(unused_imports)]
use recondo_gateway::stream;
use serde_json::json;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a realistic Anthropic request body with the metadata.user_id field
/// that Claude Code sends on every request.
fn request_body_with_metadata(session_id: &str, account_uuid: &str, device_id: &str) -> Vec<u8> {
    let user_id_json = json!({
        "device_id": device_id,
        "account_uuid": account_uuid,
        "session_id": session_id,
    });
    let body = json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 8096,
        "system": "You are Claude Code, Anthropic's official CLI.",
        "messages": [
            {"role": "user", "content": "What is 2+2?"}
        ],
        "metadata": {
            "user_id": user_id_json.to_string()
        }
    });
    serde_json::to_vec(&body).unwrap()
}

/// Build a request body without any metadata field.
fn request_body_without_metadata() -> Vec<u8> {
    let body = json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "Hello world"}
        ]
    });
    serde_json::to_vec(&body).unwrap()
}

/// Build a request body with malformed metadata.user_id (not valid JSON).
fn request_body_with_malformed_metadata() -> Vec<u8> {
    let body = json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "messages": [
            {"role": "user", "content": "Hello"}
        ],
        "metadata": {
            "user_id": "this-is-not-json{{{invalid"
        }
    });
    serde_json::to_vec(&body).unwrap()
}

/// Prefix raw JSON body with HTTP headers to simulate raw captured bytes.
fn with_http_headers(body: &[u8]) -> Vec<u8> {
    let header = format!(
        "POST /v1/messages HTTP/1.1\r\n\
         Host: api.anthropic.com\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         \r\n",
        body.len()
    );
    let mut raw = header.into_bytes();
    raw.extend_from_slice(body);
    raw
}

// ===========================================================================
// Section 1: Metadata Extraction (6 tests)
// ===========================================================================

/// **Proves:** extract_client_metadata can parse a full request body with
/// metadata.user_id containing all 3 identity fields: session_id,
/// account_uuid, device_id.
///
/// **Anti-fake property:** Each field is verified individually against the
/// exact values embedded in the request. A stub returning hardcoded values
/// would fail when the input changes.
#[test]
fn extract_metadata_from_realistic_request() {
    let session_id = "9a14ef1b-6203-429f-ba90-0430b8417868";
    let account_uuid = "a154da90-5c17-4b33-b686-078d8fbec775";
    let device_id = "5a65b564abcd1234";

    let body = request_body_with_metadata(session_id, account_uuid, device_id);
    let metadata = extract_client_metadata(&body);

    assert_eq!(
        metadata.session_id.as_deref(),
        Some(session_id),
        "session_id must be extracted from metadata.user_id"
    );
    assert_eq!(
        metadata.account_uuid.as_deref(),
        Some(account_uuid),
        "account_uuid must be extracted from metadata.user_id"
    );
    assert_eq!(
        metadata.device_id.as_deref(),
        Some(device_id),
        "device_id must be extracted from metadata.user_id"
    );
}

/// **Proves:** Two different request bodies with different session_ids produce
/// different ClientMetadata.session_id values — the extraction is not returning
/// a cached/static value.
///
/// **Anti-fake property:** A stub that always returns the same session_id would
/// fail this test.
#[test]
fn extract_metadata_session_id_is_unique_per_cli() {
    let body_a = request_body_with_metadata(
        "aaaa1111-0000-0000-0000-000000000001",
        "shared-account-uuid",
        "shared-device-id",
    );
    let body_b = request_body_with_metadata(
        "bbbb2222-0000-0000-0000-000000000002",
        "shared-account-uuid",
        "shared-device-id",
    );

    let meta_a = extract_client_metadata(&body_a);
    let meta_b = extract_client_metadata(&body_b);

    assert_ne!(
        meta_a.session_id, meta_b.session_id,
        "Different CLI instances must produce different session_ids"
    );
    // Both should have valid session_ids
    assert!(meta_a.session_id.is_some());
    assert!(meta_b.session_id.is_some());
}

/// **Proves:** Two requests from different sessions but the same user account
/// share the same account_uuid — enabling per-user aggregation.
///
/// **Anti-fake property:** The account_uuid is extracted from the body, not
/// derived from the session_id. Changing session_id alone does not change
/// account_uuid.
#[test]
fn extract_metadata_same_account_across_sessions() {
    let shared_account = "a154da90-5c17-4b33-b686-078d8fbec775";
    let body_session1 = request_body_with_metadata("session-1111", shared_account, "device-abc");
    let body_session2 = request_body_with_metadata("session-2222", shared_account, "device-abc");

    let meta1 = extract_client_metadata(&body_session1);
    let meta2 = extract_client_metadata(&body_session2);

    assert_eq!(
        meta1.account_uuid, meta2.account_uuid,
        "Same account_uuid must be extracted regardless of session_id"
    );
    assert_eq!(meta1.account_uuid.as_deref(), Some(shared_account),);
    // session_ids must differ
    assert_ne!(meta1.session_id, meta2.session_id);
}

/// **Proves:** A request body without a metadata field returns ClientMetadata
/// with all None fields — graceful degradation, no panic.
///
/// **Anti-fake property:** The function does not crash or return fabricated
/// values for missing data.
#[test]
fn extract_metadata_missing_metadata_returns_none_fields() {
    let body = request_body_without_metadata();
    let metadata = extract_client_metadata(&body);

    assert!(
        metadata.session_id.is_none(),
        "Missing metadata must produce None session_id"
    );
    assert!(
        metadata.account_uuid.is_none(),
        "Missing metadata must produce None account_uuid"
    );
    assert!(
        metadata.device_id.is_none(),
        "Missing metadata must produce None device_id"
    );
}

/// **Proves:** When metadata.user_id is present but is not valid JSON,
/// extract_client_metadata returns None fields instead of panicking.
///
/// **Anti-fake property:** The function handles malformed input gracefully.
/// A naive implementation that unwraps the JSON parse would panic here.
#[test]
fn extract_metadata_malformed_user_id_returns_none() {
    let body = request_body_with_malformed_metadata();
    let metadata = extract_client_metadata(&body);

    assert!(
        metadata.session_id.is_none(),
        "Malformed user_id must produce None session_id"
    );
    assert!(
        metadata.account_uuid.is_none(),
        "Malformed user_id must produce None account_uuid"
    );
    assert!(
        metadata.device_id.is_none(),
        "Malformed user_id must produce None device_id"
    );
}

/// **Proves:** When raw captured bytes include HTTP headers before the JSON
/// body, extract_client_metadata still extracts the metadata correctly by
/// stripping the HTTP framing first (using strip_http_headers).
///
/// **Anti-fake property:** If the function does not handle HTTP headers, the
/// JSON parse will fail and return all-None. This test verifies the full path
/// from raw bytes to extracted metadata.
#[test]
fn extract_metadata_handles_http_headers() {
    let session_id = "http-header-session-id-001";
    let account_uuid = "http-header-account-uuid-001";
    let device_id = "http-header-device-id-001";

    let json_body = request_body_with_metadata(session_id, account_uuid, device_id);
    let raw_with_headers = with_http_headers(&json_body);

    // The raw bytes start with HTTP headers — confirm they are present
    assert!(
        raw_with_headers.starts_with(b"POST"),
        "Raw bytes must start with HTTP method"
    );

    let metadata = extract_client_metadata(&raw_with_headers);

    assert_eq!(
        metadata.session_id.as_deref(),
        Some(session_id),
        "Must extract session_id even when HTTP headers are present"
    );
    assert_eq!(
        metadata.account_uuid.as_deref(),
        Some(account_uuid),
        "Must extract account_uuid even when HTTP headers are present"
    );
    assert_eq!(
        metadata.device_id.as_deref(),
        Some(device_id),
        "Must extract device_id even when HTTP headers are present"
    );
}

// ===========================================================================
// Section 2: Session Identity from Metadata (4 tests)
// ===========================================================================

/// **Proves:** When ClientMetadata has a session_id, the SessionManager uses
/// that value as the session ID instead of the content-based hash.
///
/// **Anti-fake property:** The session ID in the resolution must equal the
/// metadata session_id exactly — not a hash of it, not a UUID, not derived
/// from message content.
#[test]
fn session_id_uses_metadata_session_id() {
    let mut mgr = SessionManager::new();
    let msgs = vec![json!({"role": "user", "content": "What is Rust?"})];
    let metadata_session_id = "metadata-session-aaaa-bbbb-ccccddddeeee";

    let client_meta = ClientMetadata {
        session_id: Some(metadata_session_id.to_string()),
        account_uuid: Some("account-123".to_string()),
        device_id: Some("device-456".to_string()),
    };

    let resolution = mgr
        .resolve(
            &msgs,
            None,
            Some("system prompt"),
            "2026-03-20T10:00:00Z",
            None,
            Some(&client_meta),
        )
        .expect("resolve must succeed");

    // H1: metadata session_id is now hashed through sha256_hex for normalization.
    let expected_session_id = hash::sha256_hex(metadata_session_id.as_bytes());
    assert_eq!(
        resolution.session_id, expected_session_id,
        "Session ID must be sha256 of the metadata session_id (H1 validation)"
    );
    assert_eq!(
        resolution.session_id.len(),
        64,
        "Hashed session ID must be a 64-char SHA-256 hex string"
    );
    assert!(resolution.is_new_session);
    assert_eq!(resolution.sequence_num, 1);
}

/// **Proves:** Two requests with the same metadata session_id are assigned to
/// the same session, with incrementing sequence numbers.
///
/// **Anti-fake property:** The session_id stays the same across turns, and
/// sequence_num increments — proving the manager tracks state by metadata
/// session_id.
#[test]
fn same_metadata_session_id_same_session() {
    let mut mgr = SessionManager::new();
    let metadata_session_id = "stable-session-id-for-both-turns";

    let client_meta = ClientMetadata {
        session_id: Some(metadata_session_id.to_string()),
        account_uuid: Some("acct-1".to_string()),
        device_id: Some("dev-1".to_string()),
    };

    // Turn 1
    let msgs1 = vec![json!({"role": "user", "content": "First question"})];
    let r1 = mgr
        .resolve(
            &msgs1,
            None,
            None,
            "2026-03-20T10:00:00Z",
            None,
            Some(&client_meta),
        )
        .unwrap();

    // Turn 2 (different messages, same metadata session_id)
    let msgs2 = vec![
        json!({"role": "user", "content": "First question"}),
        json!({"role": "assistant", "content": "Answer"}),
        json!({"role": "user", "content": "Follow-up question"}),
    ];
    let r2 = mgr
        .resolve(
            &msgs2,
            None,
            None,
            "2026-03-20T10:01:00Z",
            None,
            Some(&client_meta),
        )
        .unwrap();

    // H1: metadata session_id is now hashed through sha256_hex for normalization.
    let expected_session_id = hash::sha256_hex(metadata_session_id.as_bytes());
    assert_eq!(
        r1.session_id, r2.session_id,
        "Same metadata session_id must produce the same session"
    );
    assert_eq!(r1.session_id, expected_session_id);
    assert_eq!(r1.sequence_num, 1);
    assert_eq!(r2.sequence_num, 2);
    assert!(!r2.is_new_session);
}

/// **Proves:** Two requests with different metadata session_ids go to different
/// sessions, even if the message content is identical.
///
/// **Anti-fake property:** This is the opposite of the content-based model
/// where identical first-user-messages would produce the same session. Here
/// the metadata session_id takes precedence.
#[test]
fn different_metadata_session_id_different_session() {
    let mut mgr = SessionManager::new();

    // Identical message content, but different metadata session_ids
    let msgs = vec![json!({"role": "user", "content": "Identical content"})];

    let meta_a = ClientMetadata {
        session_id: Some("session-AAAA".to_string()),
        account_uuid: Some("same-account".to_string()),
        device_id: Some("same-device".to_string()),
    };
    let meta_b = ClientMetadata {
        session_id: Some("session-BBBB".to_string()),
        account_uuid: Some("same-account".to_string()),
        device_id: Some("same-device".to_string()),
    };

    let r1 = mgr
        .resolve(
            &msgs,
            None,
            None,
            "2026-03-20T10:00:00Z",
            None,
            Some(&meta_a),
        )
        .unwrap();

    let r2 = mgr
        .resolve(
            &msgs,
            None,
            None,
            "2026-03-20T10:01:00Z",
            None,
            Some(&meta_b),
        )
        .unwrap();

    // H1: metadata session_ids are hashed through sha256_hex for normalization.
    let expected_a = hash::sha256_hex(b"session-AAAA");
    let expected_b = hash::sha256_hex(b"session-BBBB");
    assert_ne!(
        r1.session_id, r2.session_id,
        "Different metadata session_ids must produce different sessions"
    );
    assert_eq!(r1.session_id, expected_a);
    assert_eq!(r2.session_id, expected_b);
    assert!(r1.is_new_session);
    assert!(r2.is_new_session);
}

/// **Proves:** When ClientMetadata has no session_id (None), the SessionManager
/// falls back to content-based session ID derivation.
///
/// **Anti-fake property:** The session_id in the resolution must be a SHA-256
/// hex string (64 chars), matching the output of tentative_session_id — not the
/// metadata session_id (which is None).
#[test]
fn missing_metadata_falls_back_to_content_hash() {
    let mut mgr = SessionManager::new();
    let msgs = vec![json!({"role": "user", "content": "What is Rust?"})];

    let client_meta = ClientMetadata {
        session_id: None,
        account_uuid: Some("has-account-but-no-session".to_string()),
        device_id: Some("has-device-but-no-session".to_string()),
    };

    let r = mgr
        .resolve(
            &msgs,
            None,
            None,
            "2026-03-20T10:00:00Z",
            None,
            Some(&client_meta),
        )
        .unwrap();

    // Should fall back to the content-based session ID
    let expected_id = session::tentative_session_id(&client_meta, &msgs, None);
    assert_eq!(
        r.session_id, expected_id,
        "With no metadata session_id, must fall back to content-based hash"
    );
    assert_eq!(
        r.session_id.len(),
        64,
        "Content-based session ID must be a 64-char SHA-256 hex string"
    );
}

// ===========================================================================
// Section 3: Identity Storage and Query (4 tests)
// ===========================================================================

/// **Proves:** After inserting a session with account_uuid, the field is
/// persisted and retrievable from the database.
///
/// **Anti-fake property:** The account_uuid read from the DB matches the value
/// that was written — not None, not a default.
#[test]
fn session_record_stores_account_uuid() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session_id = uuid::Uuid::new_v4().to_string();
    let account_uuid = "a154da90-5c17-4b33-b686-078d8fbec775";

    let session = db::SessionRecord {
        id: session_id.clone(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-03-20T10:00:00Z".to_string(),
        last_active_at: "2026-03-20T10:00:00Z".to_string(),
        ended_at: None,
        initial_intent: Some("Test session".to_string()),
        system_prompt_hash: "test_hash".to_string(),
        total_turns: 0,
        turns_captured: 0,
        dropped_events: 0,
        total_tokens: 0,
        total_cost_usd: 0.0,
        framework: Some("claude_code".to_string()),
        agent_id: None,
        agent_version: None,
        git_repo: None,
        git_branch: None,
        git_commit: None,
        working_directory: None,
        parent_session_id: None,
        tags: None,
        account_uuid: Some(account_uuid.to_string()),
        device_id: Some("device-xyz".to_string()),
        tool_definitions_hash: String::new(),
    };

    db::insert_session(&conn, &session).unwrap();

    let db_session = db::get_session(&conn, &session_id)
        .unwrap()
        .expect("Session must exist");

    assert_eq!(
        db_session.account_uuid.as_deref(),
        Some(account_uuid),
        "account_uuid must be stored and retrievable from the DB"
    );
}

/// **Proves:** After inserting a session with device_id, the field is persisted
/// and retrievable from the database.
///
/// **Anti-fake property:** The device_id read from the DB matches the value
/// that was written. A schema without this column would fail at insert time.
#[test]
fn session_record_stores_device_id() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let session_id = uuid::Uuid::new_v4().to_string();
    let device_id = "5a65b564abcd1234";

    let session = db::SessionRecord {
        id: session_id.clone(),
        provider: "anthropic".to_string(),
        model: None,
        started_at: "2026-03-20T10:00:00Z".to_string(),
        last_active_at: "2026-03-20T10:00:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "test_hash_2".to_string(),
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
        device_id: Some(device_id.to_string()),
        tool_definitions_hash: String::new(),
    };

    db::insert_session(&conn, &session).unwrap();

    let db_session = db::get_session(&conn, &session_id)
        .unwrap()
        .expect("Session must exist");

    assert_eq!(
        db_session.device_id.as_deref(),
        Some(device_id),
        "device_id must be stored and retrievable from the DB"
    );
}

/// **Proves:** Multiple sessions from the same account_uuid can be inserted
/// and queried back together — enabling per-identity aggregation.
///
/// **Anti-fake property:** Two distinct sessions share the same account_uuid
/// in the DB. A query filtering by account_uuid returns both.
#[test]
fn multiple_sessions_same_identity() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    let account_uuid = "shared-identity-uuid-001";

    // Insert two sessions with same account_uuid but different session IDs
    for i in 1..=2 {
        let session = db::SessionRecord {
            id: format!("session-{}", i),
            provider: "anthropic".to_string(),
            model: Some("claude-sonnet-4-20250514".to_string()),
            started_at: format!("2026-03-20T10:0{}:00Z", i),
            last_active_at: format!("2026-03-20T10:0{}:00Z", i),
            ended_at: None,
            initial_intent: Some(format!("Intent {}", i)),
            system_prompt_hash: format!("hash_{}", i),
            total_turns: i as i64 * 5,
            turns_captured: i as i64 * 5,
            dropped_events: 0,
            total_tokens: i as i64 * 1000,
            total_cost_usd: i as f64 * 0.05,
            framework: Some("claude_code".to_string()),
            agent_id: None,
            agent_version: None,
            git_repo: None,
            git_branch: None,
            git_commit: None,
            working_directory: None,
            parent_session_id: None,
            tags: None,
            account_uuid: Some(account_uuid.to_string()),
            device_id: Some("device-shared".to_string()),
            tool_definitions_hash: String::new(),
        };
        db::insert_session(&conn, &session).unwrap();
    }

    // Query sessions by account_uuid using the new identity query function
    let sessions = db::list_sessions_by_account(&conn, account_uuid)
        .expect("list_sessions_by_account must succeed");

    assert_eq!(
        sessions.len(),
        2,
        "Both sessions with same account_uuid must be returned"
    );
    // Verify both sessions have the correct account_uuid
    for s in &sessions {
        assert_eq!(
            s.account_uuid.as_deref(),
            Some(account_uuid),
            "Each session must have the queried account_uuid"
        );
    }

    // Verify aggregate totals can be computed
    let total_tokens: i64 = sessions.iter().map(|s| s.total_tokens).sum();
    assert_eq!(
        total_tokens, 3000,
        "Total tokens across sessions must be sum of individual totals"
    );
    let total_cost: f64 = sessions.iter().map(|s| s.total_cost_usd).sum();
    assert!(
        (total_cost - 0.15).abs() < 0.001,
        "Total cost across sessions must be sum of individual costs"
    );
}

/// **Proves:** After db::initialize, the sessions table contains the
/// account_uuid and device_id columns. This verifies the schema migration
/// was applied.
///
/// **Anti-fake property:** We query PRAGMA table_info and check for the
/// column names. If the migration is missing, the columns will not exist.
#[test]
fn schema_has_account_uuid_and_device_id_columns() {
    let conn = db::open_in_memory().unwrap();
    db::initialize(&conn).unwrap();

    // Query the sessions table schema for column names
    let mut stmt = conn
        .prepare("PRAGMA table_info(sessions)")
        .expect("PRAGMA table_info must succeed");
    let columns: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert!(
        columns.contains(&"account_uuid".to_string()),
        "sessions table must have account_uuid column after initialize. \
         Found columns: {:?}",
        columns
    );
    assert!(
        columns.contains(&"device_id".to_string()),
        "sessions table must have device_id column after initialize. \
         Found columns: {:?}",
        columns
    );
}

// ===========================================================================
// Section 4: Integration Test — Full Pipeline (1 test)
// ===========================================================================

/// **Proves:** `process_capture_with_pipeline` extracts metadata from realistic
/// request bytes and populates the session with the correct session_id (from
/// metadata, hashed via H1), account_uuid, and device_id.
///
/// **Anti-fake property:** Builds a full WritePipeline with in-memory SQLite,
/// sends realistic request bytes through `process_capture_with_pipeline`, then
/// queries the graph store to verify the session has the expected identity fields.
#[test]
fn integration_pipeline_wires_metadata_to_session() {
    use recondo_gateway::gateway;
    use recondo_gateway::session::SessionManager;
    use recondo_gateway::storage::graph::SqliteGraphStore;
    use recondo_gateway::storage::object::LocalObjectStore;
    use recondo_gateway::storage::pipeline::WritePipeline;
    use tempfile::TempDir;

    // Create pipeline backed by in-memory SQLite + temp filesystem.
    let tmp = TempDir::new().expect("Must create temp dir");
    let data_dir = tmp.path().to_path_buf();
    let dlq_dir = data_dir.join("dlq");

    let graph = SqliteGraphStore::new_in_memory().expect("Must create in-memory graph store");
    let objects = LocalObjectStore::new(&data_dir);
    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq_dir);

    let mut session_mgr = SessionManager::new();

    // Build realistic request bytes with metadata.user_id containing identity fields.
    let metadata_session_id = "integration-test-session-12345";
    let account_uuid = "acct-integration-test-uuid";
    let device_id = "device-integration-test-id";

    let user_id_json = json!({
        "device_id": device_id,
        "account_uuid": account_uuid,
        "session_id": metadata_session_id,
    });
    let req_body = json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 8096,
        "system": "You are Claude Code, Anthropic's official CLI.",
        "messages": [
            {"role": "user", "content": "What is 2+2?"}
        ],
        "metadata": {
            "user_id": user_id_json.to_string()
        },
        "stream": true
    });
    let req_bytes_body = serde_json::to_vec(&req_body).unwrap();

    // Wrap in HTTP headers (as the gateway would see them)
    let req_bytes = format!(
        "POST /v1/messages HTTP/1.1\r\n\
         Host: api.anthropic.com\r\n\
         Content-Type: application/json\r\n\
         x-api-key: sk-ant-test\r\n\
         Content-Length: {}\r\n\
         \r\n",
        req_bytes_body.len()
    )
    .into_bytes()
    .into_iter()
    .chain(req_bytes_body)
    .collect::<Vec<u8>>();

    // Realistic SSE response bytes (with HTTP headers)
    let resp_bytes = b"HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
\r\n\
event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":100,\"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"4\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":10}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

    // Process the capture through the full pipeline.
    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req_bytes,
        resp_bytes,
        None,
        None, // no metrics registry
    )
    .expect("process_capture_with_pipeline must succeed");

    // Verify the session_id is the H1-hashed metadata session_id.
    let expected_session_id = hash::sha256_hex(metadata_session_id.as_bytes());
    assert_eq!(
        turn.session_id, expected_session_id,
        "Turn session_id must be sha256 of the metadata session_id"
    );

    // Query the session from the graph store and verify identity fields.
    let sessions = pipeline
        .graph()
        .list_sessions(Some(10))
        .expect("list_sessions must succeed");
    assert_eq!(sessions.len(), 1, "Must have exactly 1 session");

    let session = &sessions[0];
    assert_eq!(
        session.id, expected_session_id,
        "Session ID must match the hashed metadata session_id"
    );
    assert_eq!(
        session.account_uuid.as_deref(),
        Some(account_uuid),
        "Session must have the account_uuid from metadata"
    );
    assert_eq!(
        session.device_id.as_deref(),
        Some(device_id),
        "Session must have the device_id from metadata"
    );

    // Verify the account query function also works via graph store.
    let account_sessions = pipeline
        .graph()
        .list_sessions_by_account(account_uuid)
        .expect("list_sessions_by_account must succeed");
    assert_eq!(
        account_sessions.len(),
        1,
        "Must find the session by account_uuid"
    );
    assert_eq!(account_sessions[0].id, expected_session_id);
}
