//! Tests for the PostgresGraphStore implementation.
//!
//! Tests are split into two groups:
//!
//! 1. **Compile-time and config tests** (always run): verify that the feature
//!    flag and env var logic in `create_from_env` works correctly.
//!
//! 2. **Integration tests** (gated behind `#[cfg(feature = "postgres-tests")]`):
//!    full GraphStore trait contract tests against a running PostgreSQL instance.
//!    Run with: `cargo nextest run --features postgres-tests`
//!    Requires: `RECONDO_DB_URL=postgresql://user:pass@localhost:5432/recondo_test`

// W7 fix: serial_test ensures env-var-mutating tests run one at a time.
use serial_test::serial;

// FIND-15-Rust-1: shared cross-process advisory-lock helper. This file
// originally had the OnceLock-runtime + verify pattern inlined; it was
// the SOLE binary in Round 14 that had it correct. The shared helper
// now lives in `gateway/tests/common/pg_lock.rs` and is used by every
// PG-touching binary. We keep the local `setup_pg_store` calling the
// shared helper so all four sites converge on a single implementation.
mod common;

// ============================================================================
// Group 1: Config / feature-flag tests (always run, no PG needed)
// ============================================================================

/// When RECONDO_STORE=postgres and the postgres feature is compiled in,
/// create_from_env should fail with a clear error about RECONDO_DB_URL
/// being required (not with "not yet implemented").
#[test]
#[serial]
#[cfg(feature = "postgres")]
fn create_from_env_postgres_requires_db_url() {
    // Temporarily set env vars for this test.
    // Safety: this test must not run in parallel with other tests that read
    // these env vars. nextest runs each test in a separate process, so this is safe.
    std::env::set_var("RECONDO_STORE", "postgres");
    std::env::remove_var("RECONDO_DB_URL");

    let result = recondo_gateway::storage::create_from_env();
    assert!(result.is_err());
    let err = format!("{}", result.err().unwrap());
    assert!(
        err.contains("RECONDO_DB_URL"),
        "Error must mention RECONDO_DB_URL, got: {}",
        err
    );

    // Clean up
    std::env::set_var("RECONDO_STORE", "sqlite");
}

/// When RECONDO_STORE=postgres but the postgres feature is NOT compiled in,
/// create_from_env should fail with a message about the feature flag.
#[test]
#[serial]
#[cfg(not(feature = "postgres"))]
fn create_from_env_postgres_without_feature_flag_fails() {
    std::env::set_var("RECONDO_STORE", "postgres");

    let result = recondo_gateway::storage::create_from_env();
    assert!(result.is_err());
    let err = format!("{}", result.err().unwrap());
    assert!(
        err.contains("postgres") && err.contains("feature"),
        "Error must mention the postgres feature, got: {}",
        err
    );

    // Clean up
    std::env::set_var("RECONDO_STORE", "sqlite");
}

/// Verify that unknown RECONDO_STORE values produce a clear error.
#[test]
#[serial]
fn create_from_env_unknown_store_value_fails() {
    std::env::set_var("RECONDO_STORE", "oracle");
    std::env::remove_var("RECONDO_DATA_DIR");

    let result = recondo_gateway::storage::create_from_env();
    assert!(result.is_err());
    let err = format!("{}", result.err().unwrap());
    assert!(
        err.contains("oracle"),
        "Error must echo the unknown value, got: {}",
        err
    );

    // Clean up
    std::env::set_var("RECONDO_STORE", "sqlite");
}

/// Verify that the default RECONDO_STORE=sqlite path still works.
#[test]
#[serial]
fn create_from_env_sqlite_default_works() {
    std::env::set_var("RECONDO_STORE", "sqlite");
    std::env::remove_var("RECONDO_DATA_DIR");

    let result = recondo_gateway::storage::create_from_env();
    assert!(
        result.is_ok(),
        "Default sqlite path must work, got: {:?}",
        result.err()
    );

    // Clean up
    std::env::set_var("RECONDO_STORE", "sqlite");
}

// ============================================================================
// Group 2: Full GraphStore integration tests (require running PG)
// ============================================================================

#[cfg(feature = "postgres-tests")]
mod pg_integration {
    use recondo_gateway::db::{SessionRecord, ToolCallRecord, TurnRecord};
    use recondo_gateway::storage::graph::GraphStore;
    use recondo_gateway::storage::postgres::PostgresGraphStore;

    /// Database URL backed by an ephemeral postgres container (see
    /// `tests/common/pg_container.rs`). First call in the process
    /// starts the container and runs migrations against it.
    fn db_url() -> String {
        super::common::pg_container::url().to_string()
    }

    // Create a fresh PostgresGraphStore, cleaning up any leftover test data.
    //
    // W6+W7: nextest runs each test in a separate process, so env var mutations
    // and cleanup are isolated. We use TRUNCATE CASCADE for faster, more
    // thorough cleanup than row-by-row DELETE.
    //
    // FIND-7-E (orig): wrapped TRUNCATE in BEGIN; LOCK TABLE
    // ACCESS EXCLUSIVE; ...; COMMIT to keep schema state stable
    // against cross-binary races.
    //
    // FIND-9-D: drop the explicit ACCESS EXCLUSIVE preamble. The
    // `pg-mutex` test-group (max-threads = 1, configured in
    // .config/nextest.toml) makes the runner serialise all PG-writer
    // binaries — no two of them hold table locks at the same time.
    // Inside this binary, nextest spawns each test in a fresh process,
    // so SELECT/INSERT from a previous test cannot leak via shared
    // state. TRUNCATE CASCADE itself takes ACCESS EXCLUSIVE for its
    // own commit; the redundant pre-LOCK was layering a third strategy
    // on top of the test-group + per-process isolation.
    //
    // FIND-15-Rust-1: cross-process advisory lock key is now the
    // canonical `common::pg_lock::SHARED_SCHEMA_LOCK_KEY` constant
    // (still 4242424242424242 — wire-compatible with prior rounds).
    // The local `const SHARED_SCHEMA_LOCK_KEY` was removed in favor
    // of the shared helper.

    fn setup_pg_store() -> PostgresGraphStore {
        let url = db_url();
        let store =
            PostgresGraphStore::new(&url).expect("Must connect to PG and initialize schema");

        // Clean up any leftover test data now that we hold the
        // cross-process lock. TRUNCATE CASCADE takes ACCESS EXCLUSIVE
        // for its own commit; combined with the advisory lock above,
        // no other PG test can be running concurrently.
        let pool = store.pool().clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let client = pool.get().await.expect("Must get PG connection");
                client
                    .batch_execute("TRUNCATE attachments, tool_calls, turns, sessions CASCADE;")
                    .await
                    .expect("Must clean up test data");
            })
        });

        store
    }

    fn sample_session(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            provider: "anthropic".to_string(),
            model: None,
            started_at: "2026-03-17T10:00:00Z".to_string(),
            last_active_at: "2026-03-17T10:05:00Z".to_string(),
            ended_at: None,
            initial_intent: None,
            system_prompt_hash: "abc123def456".to_string(),
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
            ..Default::default()
        }
    }

    fn sample_turn(id: &str, session_id: &str, seq: i64) -> TurnRecord {
        TurnRecord {
            id: id.to_string(),
            session_id: session_id.to_string(),
            sequence_num: seq,
            timestamp: format!("2026-03-17T10:{:02}:00Z", seq),
            request_hash: format!("req_hash_{}", seq),
            response_hash: format!("resp_hash_{}", seq),
            req_bytes_ref: None,
            resp_bytes_ref: None,
            req_bytes_size: None,
            resp_bytes_size: None,
            model: Some("claude-sonnet-4-20250514".to_string()),
            response_text: None,
            thinking_text: None,
            stop_reason: "end_turn".to_string(),
            capture_complete: true,
            input_tokens: 100 * seq,
            output_tokens: 50 * seq,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            cost_usd: None,
            created_at: format!("2026-03-17T10:{:02}:00Z", seq),
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

    fn sample_tool_call(id: &str, turn_id: &str) -> ToolCallRecord {
        ToolCallRecord {
            id: id.to_string(),
            turn_id: turn_id.to_string(),
            tool_name: "read_file".to_string(),
            tool_input: r#"{"path":"src/main.rs"}"#.to_string(),
            input_hash: None,
            sequence_num: None,
            output: None,
            output_hash: None,
            duration_ms: None,
            error: None,
            status: None,
            artifacts_created: None,
            artifact_hashes: None,
        }
    }

    // All pg_integration tests must run inside a tokio runtime since
    // PostgresGraphStore::new() calls block_on internally.
    macro_rules! pg_test {
        ($name:ident, $body:expr) => {
            #[test]
            fn $name() {
                let rt = tokio::runtime::Runtime::new().expect("Must create tokio runtime");
                rt.block_on(async { $body });
            }
        };
    }

    // --- Session tests ---

    pg_test!(pg_write_and_list_sessions, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_sess_1"))
            .expect("Must write session");
        store
            .write_session(&sample_session("pg_sess_2"))
            .expect("Must write session");

        let sessions = store.list_sessions(None).expect("Must list sessions");
        assert_eq!(sessions.len(), 2);
    });

    pg_test!(pg_list_sessions_empty, {
        let store = setup_pg_store();
        let sessions = store.list_sessions(None).expect("Must list sessions");
        assert!(sessions.is_empty());
    });

    pg_test!(pg_list_sessions_with_limit, {
        let store = setup_pg_store();
        for i in 0..5 {
            store
                .write_session(&sample_session(&format!("pg_lim_{}", i)))
                .expect("Must write session");
        }

        let sessions = store.list_sessions(Some(3)).expect("Must list sessions");
        assert_eq!(sessions.len(), 3);
    });

    pg_test!(pg_session_fields_roundtrip, {
        let store = setup_pg_store();

        let session = SessionRecord {
            id: "pg_rt_sess".to_string(),
            provider: "openai".to_string(),
            model: Some("gpt-4o".to_string()),
            started_at: "2026-03-17T10:00:00Z".to_string(),
            last_active_at: "2026-03-17T10:05:00Z".to_string(),
            ended_at: Some("2026-03-17T11:00:00Z".to_string()),
            initial_intent: Some("Write tests".to_string()),
            system_prompt_hash: "hash123".to_string(),
            total_turns: 5,
            turns_captured: 4,
            dropped_events: 1,
            total_tokens: 10000,
            total_cost_usd: 0.15,
            framework: Some("claude-code".to_string()),
            agent_id: Some("agent-001".to_string()),
            agent_version: Some("1.0.0".to_string()),
            git_repo: Some("recondo".to_string()),
            git_branch: Some("main".to_string()),
            git_commit: Some("abc123".to_string()),
            working_directory: Some("/home/user/recondo".to_string()),
            parent_session_id: None,
            tags: Some("test,ci".to_string()),
            account_uuid: None,
            device_id: None,
            ..Default::default()
        };

        store.write_session(&session).expect("Must write session");
        let sessions = store.list_sessions(None).expect("Must list sessions");
        assert_eq!(sessions.len(), 1);
        let s = &sessions[0];

        assert_eq!(s.id, "pg_rt_sess");
        assert_eq!(s.provider, "openai");
        assert_eq!(s.model, Some("gpt-4o".to_string()));
        assert_eq!(s.ended_at, Some("2026-03-17T11:00:00Z".to_string()));
        assert_eq!(s.initial_intent, Some("Write tests".to_string()));
        assert_eq!(s.total_turns, 5);
        assert_eq!(s.turns_captured, 4);
        assert_eq!(s.dropped_events, 1);
        assert_eq!(s.total_tokens, 10000);
        assert!((s.total_cost_usd - 0.15).abs() < f64::EPSILON);
        assert_eq!(s.framework, Some("claude-code".to_string()));
        assert_eq!(s.agent_id, Some("agent-001".to_string()));
        assert_eq!(s.tags, Some("test,ci".to_string()));
    });

    // --- Turn tests ---

    pg_test!(pg_write_and_get_turns, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_turn_sess"))
            .expect("Must write session");
        store
            .write_turn(&sample_turn("pg_turn_1", "pg_turn_sess", 1))
            .expect("Must write turn");
        store
            .write_turn(&sample_turn("pg_turn_2", "pg_turn_sess", 2))
            .expect("Must write turn");

        let turns = store
            .get_turns_for_session("pg_turn_sess")
            .expect("Must get turns");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].sequence_num, 1);
        assert_eq!(turns[1].sequence_num, 2);
    });

    pg_test!(pg_get_turn_by_id, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_tid_sess"))
            .expect("Must write session");
        store
            .write_turn(&sample_turn("pg_tid_turn", "pg_tid_sess", 1))
            .expect("Must write turn");

        let turn = store
            .get_turn("pg_tid_turn")
            .expect("Must get turn")
            .expect("Turn must exist");
        assert_eq!(turn.id, "pg_tid_turn");
        assert_eq!(turn.session_id, "pg_tid_sess");
        assert_eq!(turn.sequence_num, 1);
    });

    pg_test!(pg_get_nonexistent_turn, {
        let store = setup_pg_store();
        let turn = store.get_turn("does_not_exist").expect("Must not error");
        assert!(turn.is_none());
    });

    pg_test!(pg_turn_fields_roundtrip, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_trt_sess"))
            .expect("Must write session");

        let turn = TurnRecord {
            id: "pg_trt_turn".to_string(),
            session_id: "pg_trt_sess".to_string(),
            sequence_num: 5,
            timestamp: "2026-03-17T12:00:00Z".to_string(),
            request_hash: "req_hash_abc".to_string(),
            response_hash: "resp_hash_def".to_string(),
            req_bytes_ref: Some("req/req_hash_abc.json.gz".to_string()),
            resp_bytes_ref: Some("resp/resp_hash_def.json.gz".to_string()),
            req_bytes_size: Some(1024),
            resp_bytes_size: Some(2048),
            model: Some("claude-opus-4-20250514".to_string()),
            response_text: Some("Hello world".to_string()),
            thinking_text: Some("Let me think...".to_string()),
            stop_reason: "tool_use".to_string(),
            capture_complete: true,
            input_tokens: 500,
            output_tokens: 250,
            cache_read_tokens: 100,
            cache_creation_tokens: 50,
            cost_usd: Some(0.05),
            created_at: "2026-03-17T12:00:00Z".to_string(),
            messages_delta: Some(r#"{"added":["msg1"]}"#.to_string()),
            messages_delta_count: Some(1),
            raw_extra: Some(r#"{"extra":"data"}"#.to_string()),
            parser_version: Some("1.0".to_string()),
            parse_errors: Some("[]".to_string()),
            provider: Some("anthropic".to_string()),
            transport: Some("http".to_string()),
            ws_direction: None,
            duration_ms: Some(1500),
            ttfb_ms: Some(200),
            api_endpoint: Some("/v1/messages".to_string()),
            http_status: Some(200),
            error_message: None,
            retry_count: 0,
            tool_call_count: 2,
            thinking_tokens: 75,
            server_id: Some("srv-001".to_string()),
            integrity_verified: Some(true),
            supersedes_turn_id: None,
            user_request_text: None,
            attachment_count: 0,
        };

        store.write_turn(&turn).expect("Must write turn");

        let retrieved = store
            .get_turn("pg_trt_turn")
            .expect("Must get turn")
            .expect("Turn must exist");

        assert_eq!(retrieved.id, "pg_trt_turn");
        assert_eq!(retrieved.sequence_num, 5);
        assert_eq!(retrieved.request_hash, "req_hash_abc");
        assert_eq!(retrieved.response_hash, "resp_hash_def");
        assert_eq!(
            retrieved.req_bytes_ref,
            Some("req/req_hash_abc.json.gz".to_string())
        );
        assert_eq!(retrieved.req_bytes_size, Some(1024));
        assert_eq!(retrieved.resp_bytes_size, Some(2048));
        assert_eq!(retrieved.model, Some("claude-opus-4-20250514".to_string()));
        assert_eq!(retrieved.response_text, Some("Hello world".to_string()));
        assert_eq!(retrieved.thinking_text, Some("Let me think...".to_string()));
        assert_eq!(retrieved.stop_reason, "tool_use");
        assert!(retrieved.capture_complete);
        assert_eq!(retrieved.input_tokens, 500);
        assert_eq!(retrieved.output_tokens, 250);
        assert_eq!(retrieved.cache_read_tokens, 100);
        assert_eq!(retrieved.cache_creation_tokens, 50);
        assert_eq!(retrieved.cost_usd, Some(0.05));
        assert_eq!(retrieved.provider, Some("anthropic".to_string()));
        assert_eq!(retrieved.transport, Some("http".to_string()));
        assert_eq!(retrieved.duration_ms, Some(1500));
        assert_eq!(retrieved.ttfb_ms, Some(200));
        assert_eq!(retrieved.tool_call_count, 2);
        assert_eq!(retrieved.thinking_tokens, 75);
        assert_eq!(retrieved.server_id, Some("srv-001".to_string()));
        assert_eq!(retrieved.integrity_verified, Some(true));
    });

    // `write_turn` uses `INSERT ... ON CONFLICT (id) DO NOTHING` (see
    // gateway/src/storage/postgres.rs:406) so a duplicate-id insert is
    // a deliberate idempotent no-op, not an error. This test pins that
    // contract: re-writing the same `id` returns Ok and leaves the
    // original row untouched (the second `sequence_num` is discarded).
    // Secondary UNIQUE collisions (different id, same `(session_id,
    // sequence_num)` slot) DO surface as an error — covered by
    // `pg_atomic_seq_advisory_lock_serializes_multi_instance_writers`
    // in `batch11_silent_dup_loss_tests.rs`.
    pg_test!(pg_duplicate_turn_id_is_idempotent_noop, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_dup_sess"))
            .expect("Must write session");
        store
            .write_turn(&sample_turn("pg_dup_turn", "pg_dup_sess", 1))
            .expect("Must write first turn");

        store
            .write_turn(&sample_turn("pg_dup_turn", "pg_dup_sess", 2))
            .expect("Re-writing the same turn id must succeed (ON CONFLICT DO NOTHING)");

        // The second write was discarded — the row still has seq=1.
        let turn = store
            .get_turn("pg_dup_turn")
            .expect("get_turn must not error")
            .expect("turn row must exist");
        assert_eq!(
            turn.sequence_num, 1,
            "Original sequence_num must be preserved (second write was a no-op)"
        );
    });

    pg_test!(pg_turns_ordered_by_sequence_num, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_ord_sess"))
            .expect("Must write session");

        // Insert out of order: 3, 1, 2
        store
            .write_turn(&sample_turn("pg_ord_3", "pg_ord_sess", 3))
            .expect("Must write turn 3");
        store
            .write_turn(&sample_turn("pg_ord_1", "pg_ord_sess", 1))
            .expect("Must write turn 1");
        store
            .write_turn(&sample_turn("pg_ord_2", "pg_ord_sess", 2))
            .expect("Must write turn 2");

        let turns = store
            .get_turns_for_session("pg_ord_sess")
            .expect("Must get turns");
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0].sequence_num, 1);
        assert_eq!(turns[1].sequence_num, 2);
        assert_eq!(turns[2].sequence_num, 3);
    });

    pg_test!(pg_turns_isolated_between_sessions, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_iso_A"))
            .expect("Must write session A");
        store
            .write_session(&sample_session("pg_iso_B"))
            .expect("Must write session B");

        store
            .write_turn(&sample_turn("pg_iso_t1", "pg_iso_A", 1))
            .expect("Must write turn");
        store
            .write_turn(&sample_turn("pg_iso_t2", "pg_iso_A", 2))
            .expect("Must write turn");
        store
            .write_turn(&sample_turn("pg_iso_t3", "pg_iso_B", 1))
            .expect("Must write turn");

        let turns_a = store
            .get_turns_for_session("pg_iso_A")
            .expect("Must get turns");
        let turns_b = store
            .get_turns_for_session("pg_iso_B")
            .expect("Must get turns");

        assert_eq!(turns_a.len(), 2);
        assert_eq!(turns_b.len(), 1);
    });

    // --- Tool call tests ---

    pg_test!(pg_write_and_get_tool_calls, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_tc_sess"))
            .expect("Must write session");
        store
            .write_turn(&sample_turn("pg_tc_turn", "pg_tc_sess", 1))
            .expect("Must write turn");

        store
            .write_tool_call(&sample_tool_call("pg_tc_1", "pg_tc_turn"))
            .expect("Must write tool call");

        let tc2 = ToolCallRecord {
            id: "pg_tc_2".to_string(),
            turn_id: "pg_tc_turn".to_string(),
            tool_name: "write_file".to_string(),
            tool_input: r#"{"path":"b.rs"}"#.to_string(),
            input_hash: Some("hash456".to_string()),
            sequence_num: Some(1),
            output: Some("ok".to_string()),
            output_hash: Some("out_hash".to_string()),
            duration_ms: Some(100),
            error: None,
            status: Some("success".to_string()),
            artifacts_created: None,
            artifact_hashes: None,
        };
        store.write_tool_call(&tc2).expect("Must write tool call");

        let tool_calls = store
            .get_tool_calls_for_turn("pg_tc_turn")
            .expect("Must get tool calls");
        assert_eq!(tool_calls.len(), 2);

        let names: Vec<&str> = tool_calls.iter().map(|tc| tc.tool_name.as_str()).collect();
        assert!(names.contains(&"read_file"));
        assert!(names.contains(&"write_file"));
    });

    pg_test!(pg_tool_calls_isolated_between_turns, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_tciso_sess"))
            .expect("Must write session");
        store
            .write_turn(&sample_turn("pg_tciso_t1", "pg_tciso_sess", 1))
            .expect("Must write turn");
        store
            .write_turn(&sample_turn("pg_tciso_t2", "pg_tciso_sess", 2))
            .expect("Must write turn");

        store
            .write_tool_call(&sample_tool_call("pg_tciso_tc1", "pg_tciso_t1"))
            .expect("Must write tool call");
        store
            .write_tool_call(&sample_tool_call("pg_tciso_tc2", "pg_tciso_t2"))
            .expect("Must write tool call");
        store
            .write_tool_call(&ToolCallRecord {
                id: "pg_tciso_tc3".to_string(),
                turn_id: "pg_tciso_t2".to_string(),
                tool_name: "bash".to_string(),
                tool_input: "{}".to_string(),
                input_hash: None,
                sequence_num: None,
                output: None,
                output_hash: None,
                duration_ms: None,
                error: None,
                status: None,
                artifacts_created: None,
                artifact_hashes: None,
            })
            .expect("Must write tool call");

        let tc1 = store
            .get_tool_calls_for_turn("pg_tciso_t1")
            .expect("Must get tool calls");
        let tc2 = store
            .get_tool_calls_for_turn("pg_tciso_t2")
            .expect("Must get tool calls");

        assert_eq!(tc1.len(), 1);
        assert_eq!(tc2.len(), 2);
    });

    pg_test!(pg_no_tool_calls_returns_empty, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_notc_sess"))
            .expect("Must write session");
        store
            .write_turn(&sample_turn("pg_notc_turn", "pg_notc_sess", 1))
            .expect("Must write turn");

        let tc = store
            .get_tool_calls_for_turn("pg_notc_turn")
            .expect("Must get tool calls");
        assert!(tc.is_empty());
    });

    // --- Previous turn messages ---

    pg_test!(pg_get_previous_turn_messages, {
        // Bug #1 fix: the old semantic (return the prior turn's raw
        // messages_delta JSON) has been replaced with a cumulative-prefix
        // semantic. See the SQLite graph.rs docstring for the full contract.
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_msg_sess"))
            .expect("Must write session");

        let mut turn1 = sample_turn("pg_msg_t1", "pg_msg_sess", 1);
        turn1.messages_delta = Some(r#"[{"role":"user","content":"hello"}]"#.to_string());
        turn1.messages_delta_count = Some(1);
        store.write_turn(&turn1).expect("Must write turn 1");

        let mut turn2 = sample_turn("pg_msg_t2", "pg_msg_sess", 2);
        turn2.messages_delta = Some(
            r#"[{"role":"assistant","content":"hi"},{"role":"user","content":"again"}]"#
                .to_string(),
        );
        turn2.messages_delta_count = Some(2);
        store.write_turn(&turn2).expect("Must write turn 2");

        // Post-write query for seq=2: MAX(seq)==2 triggers -1 adjustment.
        // prev prefix length == SUM(counts for seq<=2) - 1 == (1+2) - 1 == 2.
        let prev = store
            .get_previous_messages_prefix_marker("pg_msg_sess", 2)
            .expect("Must get previous messages")
            .expect("Must return Some when prior turns exist");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&prev).expect("prev prefix must parse as JSON array");
        assert_eq!(parsed.len(), 2, "Got: {}", prev);

        // Pipeline-shaped query for seq=3 (not yet written): no -1 adjustment.
        // prev prefix length == SUM(counts for seq<3) == 1+2 == 3.
        let prev = store
            .get_previous_messages_prefix_marker("pg_msg_sess", 3)
            .expect("Must get previous messages")
            .expect("Must return Some when prior turns exist");
        let parsed: Vec<serde_json::Value> =
            serde_json::from_str(&prev).expect("prev prefix must parse as JSON array");
        assert_eq!(parsed.len(), 3, "Got: {}", prev);

        // Get previous messages for turn 1 (no previous turn)
        let prev = store
            .get_previous_messages_prefix_marker("pg_msg_sess", 1)
            .expect("Must get previous messages");
        assert!(prev.is_none());
    });

    // --- Integrity verification ---

    pg_test!(pg_verify_integrity_shallow, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_integ_sess"))
            .expect("Must write session");
        store
            .write_turn(&sample_turn("pg_integ_t1", "pg_integ_sess", 1))
            .expect("Must write turn");

        let results = store
            .verify_integrity("pg_integ_sess", None)
            .expect("Must verify integrity");
        assert_eq!(results.len(), 1);
        assert!(results[0].passed, "Shallow check with hashes should pass");
    });

    pg_test!(pg_verify_integrity_missing_hash, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_integ2_sess"))
            .expect("Must write session");

        let mut turn = sample_turn("pg_integ2_t1", "pg_integ2_sess", 1);
        turn.request_hash = "".to_string(); // Empty hash
        store.write_turn(&turn).expect("Must write turn");

        let results = store
            .verify_integrity("pg_integ2_sess", None)
            .expect("Must verify integrity");
        assert_eq!(results.len(), 1);
        assert!(!results[0].passed, "Missing hash should fail");
        assert!(
            results[0]
                .details
                .as_ref()
                .is_some_and(|d| d.contains("Missing")),
            "Details should mention missing hash"
        );
    });

    pg_test!(pg_verify_integrity_empty_session, {
        let store = setup_pg_store();
        store
            .write_session(&sample_session("pg_integ3_sess"))
            .expect("Must write session");

        let results = store
            .verify_integrity("pg_integ3_sess", None)
            .expect("Must verify integrity");
        assert!(results.is_empty(), "Empty session should have no results");
    });

    // --- create_from_env with PG ---

    pg_test!(pg_create_from_env_with_db_url, {
        // FIND-15-3: do NOT mutate process env vars from this test.
        // `std::env::set_var` and `remove_var` are not thread-safe in
        // the Rust stdlib; peer tests in the same binary that read
        // these vars can observe garbage during the racy write window
        // (reviewer reproduced `pg_verify_integrity_missing_hash`
        // failures from this exact race). Use the new
        // `create_with_config` entry point that takes an explicit
        // `StorageConfig` instead, avoiding the env-mutation entirely.
        let db_url = db_url();
        let config = recondo_gateway::storage::StorageConfig {
            store_type: "postgres".to_string(),
            objects_type: "local".to_string(),
            explicit_data_dir: None,
            db_url: Some(db_url),
            s3_bucket: None,
        };

        let result = recondo_gateway::storage::create_with_config(config);
        assert!(
            result.is_ok(),
            "create_with_config with valid PG URL must work, got: {:?}",
            result.err()
        );
    });
}
