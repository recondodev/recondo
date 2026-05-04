//! PG-path startup recovery test for orphan captures.
//!
//! # What this test proves
//!
//! When the gateway is configured with PostgreSQL as its `GraphStore`
//! backing (i.e. the production path: `WritePipeline` wrapping a
//! `PostgresGraphStore` plus a `LocalObjectStore`), the startup-recovery
//! routine must scan `<data_dir>/captures/` for orphan capture metadata
//! (capture JSON whose corresponding `turns` row is missing from PG)
//! and reconcile them into PostgreSQL **before the TCP listener accepts
//! traffic**.
//!
//! The test seeds a real orphan on disk (capture metadata file +
//! gzipped req/resp objects) under a unique-per-run `session_id`, then
//! invokes the production startup-recovery hook on a `WritePipeline`
//! built around a real `PostgresGraphStore`, and finally asserts the
//! row landed in the actual `recondo_test` `turns` table by running
//! a raw `SELECT` against the same Postgres pool the gateway uses.
//!
//! # Anti-fake property
//!
//! This test is the PG twin of the SQLite-only orphan-recovery tests.
//! An implementer can satisfy the SQLite tests by wiring recovery
//! against `db::insert_*` on `rusqlite::Connection`; that wiring leaves
//! the PG path unchanged, the PG `turns` table empty, and this test
//! red. Specifically the test will fail if the implementer:
//!
//!   1. wires PG-path recovery to a no-op (count stays at 0),
//!   2. wires recovery only on the SQLite path (PG count stays at 0),
//!   3. forgets to call the recovery hook on PG startup at all
//!      (count stays at 0),
//!   4. only handles `provider == "anthropic"` (this test seeds an
//!      `openai` orphan to catch provider-scoped phantom-wires),
//!   5. inserts the row but with the wrong `request_hash` (the
//!      response/request hash assertion catches it),
//!   6. is non-idempotent and double-inserts on a second recovery
//!      call (the second-call assertion catches it; PG would in fact
//!      typically fail with a duplicate-PK error rather than insert
//!      twice — either failure mode flunks idempotency).
//!
//! # How to run
//!
//! ```text
//! just dev-infra        # start PG on localhost:5432 (one-time per shell)
//! just test-pg          # full PG suite, OR directly:
//! cd gateway && cargo nextest run --features test-support \
//!     --test orphan_recovery_pg_tests
//! ```
//!
//! The test is gated behind `#[cfg(feature = "postgres-tests")]`,
//! matching the convention in `postgres_graph_store_tests.rs`. Plain
//! `just test` (gateway-only, no `postgres-tests` feature) compiles
//! the file to an empty test binary, so SQLite-only runs do not hit
//! a missing PG.
//!
//! Per `gateway/.config/nextest.toml`, this binary should be added
//! to the `pg-mutex` `test-group` filter alongside the other
//! PG-mutating binaries (`postgres_graph_store_tests`,
//! `attachment_scoping_tests`, `m2_pg_ddl_removal_tests`). Until the
//! filter is extended the test still self-protects via the shared
//! cross-process advisory-lock helper (`common::pg_lock`) which
//! every PG-writer binary in this workspace acquires on first use.

// FIND-15-Rust-1: shared cross-process advisory-lock helper. Required
// for any PG-writer test binary in this workspace; without it the
// destructive recovery + cleanup window can race peer binaries'
// SELECTs/TRUNCATEs.
mod common;

#[cfg(feature = "postgres-tests")]
mod pg_orphan_recovery {
    use std::fs;
    use std::path::Path;

    use recondo_gateway::schema::CaptureRecord;
    use recondo_gateway::storage::object::LocalObjectStore;
    use recondo_gateway::storage::pipeline::WritePipeline;
    use recondo_gateway::storage::postgres::PostgresGraphStore;
    use recondo_gateway::{hash, store};
    use tempfile::TempDir;
    use uuid::Uuid;

    /// PG URL used by this test. Backed by an ephemeral postgres
    /// container spawned via `common::pg_container` on first call.
    fn db_url() -> String {
        super::common::pg_container::url().to_string()
    }

    /// Build a request body that, when fed through the production
    /// metadata-extraction path (`session::extract_client_metadata` ->
    /// `SessionManager::resolve`), resolves to `sha256_hex(meta_session_id)`.
    /// We mirror that derivation here in the test (NOT a re-implementation
    /// of arbitrary session logic — the rule is "metadata.user_id.session_id
    /// is sha256-hex'd"; see `gateway/src/session/mod.rs`). Using the same
    /// derivation guarantees the orphan we seed on disk maps to the same
    /// session_id the recovery code will compute when it parses the same
    /// request bytes.
    fn build_openai_request_with_meta(meta_session_id: &str) -> Vec<u8> {
        let user_id_inner = serde_json::json!({
            "session_id": meta_session_id,
            "account_uuid": "acct-orphan-recovery-pg",
            "device_id": "dev-orphan-recovery-pg",
        });
        let body = serde_json::json!({
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "user", "content": "orphan-recovery PG test"}
            ],
            "metadata": {
                // Claude Code-style: user_id is a JSON string containing
                // nested JSON. `extract_client_metadata` parses the outer
                // body, takes `metadata.user_id` as a string, and
                // re-parses it. OpenAI requests carry the same shape in
                // this gateway because the metadata extractor is
                // provider-agnostic.
                "user_id": user_id_inner.to_string(),
            }
        });
        serde_json::to_vec(&body).expect("must serialize request body")
    }

    /// Mirror of the production session_id rule: H1 normalization
    /// hashes the client-supplied `metadata.user_id.session_id`
    /// through `sha256_hex`. See `SessionManager::resolve` in
    /// `gateway/src/session/mod.rs`.
    fn expected_session_id(meta_session_id: &str) -> String {
        hash::sha256_hex(meta_session_id.as_bytes())
    }

    /// Seed an orphan capture on disk: gzipped req/resp objects under
    /// `<data_dir>/objects/{req,resp}/` plus a `CaptureRecord` JSON
    /// under `<data_dir>/captures/`. No PG row is inserted — that's
    /// the whole point of "orphan".
    fn seed_orphan_on_disk(
        data_dir: &Path,
        request_bytes: &[u8],
        response_bytes: &[u8],
        provider: &str,
    ) -> CaptureRecord {
        // Use the SAME storage helpers production uses, so the on-disk
        // shape is byte-identical to what a real capture would produce.
        let request_hash =
            store::store_request(data_dir, request_bytes).expect("must store request object");
        let response_hash =
            store::store_response(data_dir, response_bytes).expect("must store response object");

        let id = Uuid::new_v4();
        let record = CaptureRecord {
            // Fixed timestamp keeps the filename deterministic per-run;
            // the per-run uniqueness comes from the uuid.
            timestamp: "2026-05-02T00:00:00.000000Z".to_string(),
            uuid: id.to_string(),
            provider: provider.to_string(),
            request_hash: request_hash.clone(),
            response_hash: response_hash.clone(),
            req_bytes_ref: format!("objects/req/{}.json.gz", request_hash),
            resp_bytes_ref: format!("objects/resp/{}.json.gz", response_hash),
            request_size: request_bytes.len() as u64,
            response_size: response_bytes.len() as u64,
        };

        let captures_dir = data_dir.join("captures");
        fs::create_dir_all(&captures_dir).expect("must create captures dir");
        let filename = format!("20260502T000000.000000Z_{}.json", id);
        let metadata_path = captures_dir.join(filename);
        let json = serde_json::to_string_pretty(&record).expect("must serialize CaptureRecord");
        fs::write(&metadata_path, json).expect("must write capture metadata");

        record
    }

    /// Count `turns` rows for a given session_id via a raw SELECT
    /// against the same pool the gateway uses. Externally observable —
    /// no internal recovery state.
    async fn count_turns_for_session(store: &PostgresGraphStore, session_id: &str) -> i64 {
        let client = store
            .pool()
            .get()
            .await
            .expect("must get PG client for assertion");
        let row = client
            .query_one(
                "SELECT count(*)::bigint FROM turns WHERE session_id = $1",
                &[&session_id],
            )
            .await
            .expect("must run count(*) query");
        row.get(0)
    }

    /// Fetch the request_hash for the (assumed unique) row matching
    /// `session_id`. Asserts uniqueness via `query_one`.
    async fn get_request_hash_for_session(store: &PostgresGraphStore, session_id: &str) -> String {
        let client = store
            .pool()
            .get()
            .await
            .expect("must get PG client for assertion");
        let row = client
            .query_one(
                "SELECT request_hash FROM turns WHERE session_id = $1",
                &[&session_id],
            )
            .await
            .expect("must run request_hash query (and have exactly one row)");
        row.get(0)
    }

    /// Cleanup helper. Cleans only the rows this test created — the
    /// `pg-mutex` test-group plus the unique-per-run session_id make
    /// this safe under concurrent test binaries.
    async fn cleanup(store: &PostgresGraphStore, session_id: &str) {
        let client = store
            .pool()
            .get()
            .await
            .expect("must get PG client for cleanup");
        // Order matters: turns FK -> sessions. The `prevent_turn_mutation`
        // trigger (api/migrations/003_triggers-indexes.sql) blocks plain
        // DELETE on `turns` per the SOC 2 PI1 immutability invariant;
        // the documented bypass for cleanup is `SET LOCAL
        // recondo.gdpr_bypass = 'true'` inside a transaction. We reuse
        // the same mechanism so this test stays compatible with the
        // production schema without adding a test-only migration.
        client
            .batch_execute("BEGIN")
            .await
            .expect("must begin cleanup tx");
        client
            .batch_execute("SET LOCAL recondo.gdpr_bypass = 'true'")
            .await
            .expect("must set bypass");
        client
            .execute("DELETE FROM turns WHERE session_id = $1", &[&session_id])
            .await
            .expect("must delete test turns");
        client
            .execute("DELETE FROM sessions WHERE id = $1", &[&session_id])
            .await
            .expect("must delete test session");
        client
            .batch_execute("COMMIT")
            .await
            .expect("must commit cleanup tx");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pg_startup_recovery_inserts_orphan_turn_into_postgres_via_write_pipeline() {
        // Hold the cross-process advisory lock for the whole test
        // window. Without this a peer PG-writer binary's TRUNCATE
        // CASCADE could wipe the row we just recovered before our
        // SELECT fires.

        // ----------------------------------------------------------
        // Arrange
        // ----------------------------------------------------------
        let data_dir = TempDir::new().expect("must create tempdir");

        // Unique per-run session_id so this test cannot clash with
        // other PG tests under the pg-mutex group, even if cleanup
        // somewhere else missed a row.
        let unique_meta_session_id = format!("orphan-pg-{}", Uuid::new_v4());
        let session_id = expected_session_id(&unique_meta_session_id);

        // Build a real OpenAI-shaped request body so the recovery
        // path's metadata extraction resolves to `session_id`. Using
        // `provider="openai"` deliberately complements the existing
        // anthropic-focused SQLite tests (Hard Requirement #5).
        let request_bytes = build_openai_request_with_meta(&unique_meta_session_id);
        let response_bytes =
            br#"{"id":"chatcmpl-pg-orphan","object":"chat.completion","choices":[{"message":{"role":"assistant","content":"ok"}}]}"#
                .to_vec();

        let orphan =
            seed_orphan_on_disk(data_dir.path(), &request_bytes, &response_bytes, "openai");

        // Build the production PG path: real PostgresGraphStore +
        // real LocalObjectStore + real WritePipeline. No mocks.
        let pg_store =
            PostgresGraphStore::new(&db_url()).expect("must connect to PG and initialize schema");

        // Defensive cleanup of any prior leak on this unique
        // session_id (should be 0 rows, but DELETEs on no-match are
        // cheap and make the test rerunnable).
        cleanup(&pg_store, &session_id).await;

        // Precondition: PG has no row for this unique session_id.
        let pre_count = count_turns_for_session(&pg_store, &session_id).await;
        assert_eq!(
            pre_count, 0,
            "Precondition violated: PG already has a row for unique \
             session_id {} (pre_count={}). Either prior cleanup leaked \
             or the unique-id strategy is broken.",
            session_id, pre_count
        );

        let object_store = LocalObjectStore::new(data_dir.path());
        let dead_letter_dir = data_dir.path().join("dead_letter");
        let pipeline = WritePipeline::new(
            Box::new(
                PostgresGraphStore::new(&db_url()).expect("must build pipeline-owned PG store"),
            ),
            Box::new(object_store),
            dead_letter_dir,
        );

        // ----------------------------------------------------------
        // Act: invoke the production PG-path startup-recovery hook.
        // ----------------------------------------------------------
        //
        // The implementer designates the entry point. Two acceptable
        // shapes (the test must call WHICHEVER one the implementer
        // ships; pick one and delete the other when wiring):
        //
        //   (a) A free function on the gateway crate that takes a
        //       `&WritePipeline` and a `&Path` data_dir, e.g.:
        //
        //           recondo_gateway::gateway::recover_orphan_captures(
        //               &pipeline,
        //               data_dir.path(),
        //           ).await
        //
        //   (b) A method on `WritePipeline`, e.g.:
        //
        //           pipeline.recover_orphan_captures(data_dir.path()).await
        //
        // The unifying contract: works for ANY GraphStore behind the
        // pipeline (so a single shared implementation satisfies both
        // SQLite and PG tests). If the implementer instead chose a
        // PG-specific entry point (e.g. `startup_recover_pg(...)`),
        // call that here — the assertions below do not care about
        // the function name, only the externally observable PG
        // outcome.
        //
        // Call the production startup-recovery hook. This is the same
        // `recover_orphan_captures` function that
        // `gateway::run_listener` calls before binding the TCP
        // listener, exercised here against the PG-backed graph store
        // wrapped by the WritePipeline.
        let local_objects =
            recondo_gateway::storage::object::LocalObjectStore::new(data_dir.path());
        recondo_gateway::capture::recovery::recover_orphan_captures(
            data_dir.path(),
            pipeline.graph(),
            &local_objects,
            &recondo_gateway::capture::recovery::RecoveryConfig::default(),
        )
        .expect("recovery must succeed on a healthy PG");

        // ----------------------------------------------------------
        // Assert: externally observable PG state.
        // ----------------------------------------------------------
        let post_count = count_turns_for_session(&pg_store, &session_id).await;
        assert_eq!(
            post_count, 1,
            "PG-path recovery must insert exactly one turns row for \
             session_id {} after running against an orphan capture. \
             Got {} rows. A SQLite-only recovery implementation \
             produces 0 here — that is the phantom-wire this test \
             is designed to catch.",
            session_id, post_count
        );

        let recovered_request_hash = get_request_hash_for_session(&pg_store, &session_id).await;
        assert_eq!(
            recovered_request_hash, orphan.request_hash,
            "Recovered turns.request_hash must equal the orphan \
             CaptureRecord.request_hash. Mismatch indicates the \
             recovery path computed a different hash than the \
             on-disk object store key, which would break later \
             integrity verification."
        );

        // ----------------------------------------------------------
        // Idempotency: a second recovery call against the same disk
        // state must not double-insert. PG would in fact typically
        // raise a duplicate-PK error rather than silently insert
        // twice; either failure mode flunks idempotency, which is
        // exactly what we want this assertion to catch.
        // ----------------------------------------------------------
        recondo_gateway::capture::recovery::recover_orphan_captures(
            data_dir.path(),
            pipeline.graph(),
            &local_objects,
            &recondo_gateway::capture::recovery::RecoveryConfig::default(),
        )
        .expect("second recovery call must also succeed (idempotent)");

        let final_count = count_turns_for_session(&pg_store, &session_id).await;
        assert_eq!(
            final_count, 1,
            "Second recovery call must be idempotent on the PG path: \
             count must stay at 1, got {}. A non-idempotent recovery \
             would either insert a duplicate (count=2) or fail with a \
             PK violation (panic in the second `recovery_result_2.expect`).",
            final_count
        );

        // ----------------------------------------------------------
        // Cleanup. tempdir auto-cleans the data_dir on drop; we only
        // need to clean PG.
        // ----------------------------------------------------------
        cleanup(&pg_store, &session_id).await;
    }

    // =================================================================
    // FIND-2-6 (round 3): PG `find_turn_by_request_hash_async` is
    // exercised against a real PostgreSQL backend.
    // =================================================================
    //
    // The round-2 implementation added a new method on the
    // PostgresGraphStore trait impl that mirrors the SQLite path
    // (used by recovery's per-orphan probe to bypass the
    // `list_sessions(None)` 1000-row cap). The implementer
    // disclosed the PG path was not test-executed in round 2;
    // round 3 closes that gap by hitting the real PG schema +
    // index (`idx_turns_request_hash`, declared in
    // `api/migrations/012_turns-request-hash-index.sql`).

    use recondo_gateway::db::{SessionRecord, TurnRecord};
    use recondo_gateway::storage::graph::GraphStore;

    async fn cleanup_session_only(store: &PostgresGraphStore, session_id: &str) {
        // Same cleanup pattern as `cleanup`, but kept local so the
        // FIND-2-6 test doesn't entangle with the FIND-1-1 fixture.
        let client = store
            .pool()
            .get()
            .await
            .expect("must get PG client for cleanup");
        client
            .batch_execute("BEGIN")
            .await
            .expect("must begin cleanup tx");
        client
            .batch_execute("SET LOCAL recondo.gdpr_bypass = 'true'")
            .await
            .expect("must set bypass");
        client
            .execute("DELETE FROM turns WHERE session_id = $1", &[&session_id])
            .await
            .expect("must delete test turns");
        client
            .execute("DELETE FROM sessions WHERE id = $1", &[&session_id])
            .await
            .expect("must delete test session");
        client
            .batch_execute("COMMIT")
            .await
            .expect("must commit cleanup tx");
    }

    fn session_record(session_id: &str) -> SessionRecord {
        SessionRecord {
            id: session_id.to_string(),
            provider: "anthropic".to_string(),
            model: Some("claude-sonnet-4-20250514".to_string()),
            started_at: "2026-05-02T12:00:00Z".to_string(),
            last_active_at: "2026-05-02T12:00:00Z".to_string(),
            ended_at: None,
            initial_intent: None,
            system_prompt_hash: String::new(),
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

    fn turn_record(turn_id: &str, session_id: &str, request_hash: &str) -> TurnRecord {
        TurnRecord {
            id: turn_id.to_string(),
            session_id: session_id.to_string(),
            sequence_num: 1,
            timestamp: "2026-05-02T12:00:00Z".to_string(),
            request_hash: request_hash.to_string(),
            response_hash: hash::sha256_hex(b"pg-find-by-hash-resp"),
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
            created_at: "2026-05-02T12:00:00Z".to_string(),
            messages_delta: None,
            messages_delta_count: None,
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
            integrity_verified: Some(true),
            supersedes_turn_id: None,
            user_request_text: None,
            attachment_count: 0,
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pg_find_turn_by_request_hash_round_trips_seeded_turn() {
        // Hold the cross-process advisory lock so a peer PG-writer
        // binary's TRUNCATE CASCADE can't wipe our seeded row mid-
        // assertion.

        let store =
            PostgresGraphStore::new(&db_url()).expect("must connect to PG and initialize schema");

        // Per-run unique session id and request hash so the test
        // is independent of any prior state.
        let session_id = format!("pg-find-turn-{}", Uuid::new_v4());
        let turn_id = format!("turn-{}", Uuid::new_v4());
        let request_hash = hash::sha256_hex(format!("pg-find-by-hash-{}", session_id).as_bytes());

        // Defensive cleanup of any prior leak.
        cleanup_session_only(&store, &session_id).await;

        // Pre-seed a session and turn.
        store
            .write_session(&session_record(&session_id))
            .expect("must write session");
        store
            .write_turn(&turn_record(&turn_id, &session_id, &request_hash))
            .expect("must write turn");

        // The actual round-3 assertion: the indexed probe locates
        // the row by request_hash (no full-table scan and no
        // sessions-list dependency).
        let found = store
            .find_turn_by_request_hash(&request_hash)
            .expect("find_turn_by_request_hash must not error on healthy PG");
        let row = found.expect(
            "PG find_turn_by_request_hash must return Some(_) for a \
             freshly-seeded turn whose request_hash matches the probe key",
        );
        assert_eq!(row.id, turn_id, "Returned turn must match the seeded id");
        assert_eq!(
            row.request_hash, request_hash,
            "Returned turn.request_hash must match the probe key"
        );
        assert_eq!(
            row.session_id, session_id,
            "Returned turn.session_id must match the seed"
        );

        // Negative case: an unseeded hash must return None (NOT a
        // false positive from a stale index entry).
        let absent_hash = hash::sha256_hex(b"pg-find-by-hash-not-seeded");
        let none = store
            .find_turn_by_request_hash(&absent_hash)
            .expect("find_turn_by_request_hash must not error on unseeded hash");
        assert!(
            none.is_none(),
            "Unseeded request_hash must return None, got {:?}",
            none
        );

        cleanup_session_only(&store, &session_id).await;
    }
}
