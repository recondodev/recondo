//! Batch 11 — silent data loss when a SECONDARY UNIQUE constraint is violated.
//!
//! ## What's being proved
//!
//! `WritePipeline::write_graph` (gateway/src/storage/pipeline.rs:632-669) treats
//! every `GraphStoreError::DuplicateKey` as "the same row was already persisted
//! on a previous retry attempt — it's idempotent success." That assumption is
//! only valid for the PRIMARY KEY collision (turn.id matches an existing row).
//!
//! The `turns` table has TWO unique constraints: `turns_pkey` PRIMARY
//! KEY(id), and `turns_session_id_sequence_num_key` UNIQUE(session_id,
//! sequence_num). See `gateway/src/db/mod.rs:364` for the SQLite DDL
//! and `api/migrations/001_core-tables.sql:90` for the PostgreSQL DDL.
//!
//! Both `PostgresGraphStore::write_turn_async` (postgres.rs:401-410) and
//! `SqliteGraphStore::write_turn` (graph.rs:574-591) classify ANY 23505 /
//! SQLITE_CONSTRAINT_UNIQUE as `GraphStoreError::DuplicateKey` — so a SECONDARY
//! unique violation (a DIFFERENT row trying to land on the same
//! (session_id, sequence_num) slot) is misreported as "PK collision, idempotent
//! success" and silently swallowed by the pipeline.
//!
//! Result: the second turn is dropped on the floor. The capture file on disk
//! is intact, the gateway logs `capture pipeline succeeded`, but no row exists
//! in the DB. Worse, downstream attachment inserts FK-fail with `db error`
//! (the turn row their `turn_id` references doesn't exist) — exactly the DLQ
//! pattern observed in production on 2026-05-03.
//!
//! ## Why this matters
//!
//! Per CLAUDE.md, Recondo is "AI Governance Gateway. Every agent-to-LLM call
//! flows through it for compliance auditing (SOC 2, ISO 42001)." A silent turn
//! drop violates the audit trail invariant: the gateway must either persist
//! the turn or surface a hard error so the operator can recover. Today it does
//! neither.

use recondo_gateway::db::{SessionRecord, TurnRecord};
use recondo_gateway::storage::graph::{GraphStore, GraphStoreError, SqliteGraphStore};
use recondo_gateway::storage::object::LocalObjectStore;
use recondo_gateway::storage::pipeline::WritePipeline;
use tempfile::TempDir;

#[cfg(feature = "postgres-tests")]
mod common;

fn sample_session(id: &str) -> SessionRecord {
    SessionRecord {
        id: id.to_string(),
        provider: "anthropic".to_string(),
        model: Some("claude-sonnet-4-20250514".to_string()),
        started_at: "2026-05-03T15:00:00Z".to_string(),
        last_active_at: "2026-05-03T15:05:00Z".to_string(),
        ended_at: None,
        initial_intent: None,
        system_prompt_hash: "spr_hash".to_string(),
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
    }
}

fn sample_turn(id: &str, session_id: &str, seq: i64, req_hash_suffix: &str) -> TurnRecord {
    TurnRecord {
        id: id.to_string(),
        session_id: session_id.to_string(),
        sequence_num: seq,
        timestamp: "2026-05-03T15:00:00Z".to_string(),
        request_hash: format!("req_hash_{}", req_hash_suffix),
        response_hash: format!("resp_hash_{}", req_hash_suffix),
        req_bytes_ref: None,
        resp_bytes_ref: None,
        req_bytes_size: None,
        resp_bytes_size: None,
        model: Some("claude-sonnet-4-20250514".to_string()),
        response_text: None,
        thinking_text: None,
        stop_reason: "end_turn".to_string(),
        capture_complete: true,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd: None,
        created_at: "2026-05-03T15:00:00Z".to_string(),
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

/// Direct GraphStore probe — proves PK vs secondary UNIQUE classification.
///
/// **Setup:** Insert a baseline turn with id=A at (session=X, seq=1).
///
/// **Action #1 (PK collision):** Re-insert turn id=A. Same id collides on
/// the PK. Expected: `DuplicateKey { entity: "turn", id: "turn_A" }`.
/// This is the legitimate idempotent-retry case the pipeline swallows.
///
/// **Action #2 (secondary UNIQUE collision):** Insert turn id=B at the
/// same (session=X, seq=1). The PK is unique (B != A), but the secondary
/// `UNIQUE(session_id, sequence_num)` collides. Expected: a distinct
/// `UniqueViolation` variant carrying the constraint name and the
/// underlying message — NOT misclassified as a PK retry.
///
/// **Why this matters:** the WritePipeline at `write_graph` only swallows
/// `DuplicateKey`. After Batch 11, secondary UNIQUE violations surface
/// as `UniqueViolation` and propagate through `Err(e) =>` arms, ensuring
/// the audit trail does not silently drop a turn that collides on
/// `(session_id, sequence_num)` with a different row.
#[test]
fn write_turn_distinguishes_pk_from_secondary_unique_violations() {
    let store = SqliteGraphStore::new_in_memory().expect("create in-memory store");
    let session = sample_session("X");
    store.write_session(&session).expect("session insert");

    // Baseline: id=A at (X, 1) succeeds.
    let turn_a = sample_turn("turn_A", "X", 1, "a");
    store.write_turn(&turn_a).expect("first turn insert");

    // PK collision: same id "turn_A" at a different seq. After Batch 11,
    // `ON CONFLICT (id) DO NOTHING` absorbs PK collisions at the SQL layer,
    // so the second write returns Ok (idempotent retry semantics) and the
    // original row is preserved unchanged.
    let turn_a_redo = sample_turn("turn_A", "X", 99, "a-redo");
    store
        .write_turn(&turn_a_redo)
        .expect("PK collision must be absorbed by ON CONFLICT (id) DO NOTHING");
    // Original row preserved: sequence_num is still 1 (not 99).
    let stored = store
        .get_turn("turn_A")
        .expect("read back must succeed")
        .expect("row must exist");
    assert_eq!(
        stored.sequence_num, 1,
        "Original row must NOT be overwritten on PK collision"
    );

    // Secondary UNIQUE collision: a DIFFERENT row (id=B) at the SAME (X, 1)
    // slot. Batch 11 fix: the store MUST classify this as UniqueViolation,
    // NOT DuplicateKey, so write_graph propagates instead of swallowing.
    let turn_b = sample_turn("turn_B", "X", 1, "b");
    let sec_err = store
        .write_turn(&turn_b)
        .expect_err("must fail on (session_id, sequence_num) collision");
    match &sec_err {
        GraphStoreError::UniqueViolation {
            entity,
            constraint,
            message,
        } => {
            assert_eq!(entity, "turn");
            assert!(
                constraint.contains("session_id") && constraint.contains("sequence_num"),
                "constraint must name the violating columns; got {:?}",
                constraint
            );
            assert!(
                message.contains("UNIQUE constraint failed"),
                "message must include the underlying SQLite text; got {:?}",
                message
            );
        }
        GraphStoreError::DuplicateKey { .. } => panic!(
            "BATCH 11 BUG: secondary UNIQUE(session_id, sequence_num) violation \
             was misclassified as DuplicateKey — this is the silent-data-loss \
             trigger. write_graph swallows DuplicateKey as 'idempotent retry \
             success' but a different row is sitting in the slot."
        ),
        other => panic!(
            "secondary UNIQUE collision must be UniqueViolation; got {:?}",
            other
        ),
    }
}

/// End-to-end pipeline probe — proves silent data loss.
///
/// **Setup:** A `WritePipeline` over an in-memory SQLite + a local object
/// store. Write turn id=A at (session=X, seq=1) via `write_capture`. This
/// is the "testing 123" turn equivalent.
///
/// **Action:** Write turn id=B at (session=X, seq=1) via `write_capture` —
/// a DIFFERENT row trying to land on the same slot. This is the "looks
/// good?" turn that arrives with a stale-or-racey sequence_num assignment.
///
/// **Expected (compliance invariant):** the second `write_capture` MUST
/// return an error AND/OR write the bundle to the DLQ. The audit trail
/// must not silently lose the turn.
///
/// **Today's behaviour (the bug):** `write_capture` returns `Ok(())`. No DB
/// row is created for B, no DLQ entry is written, and the gateway logs
/// `capture pipeline succeeded`. The capture file on disk references a
/// turn_id that nobody persisted. Downstream attachment inserts then
/// FK-fail (because the turn doesn't exist) and produce the DLQ rows the
/// operator sees in production.
#[test]
fn write_capture_recovers_secondary_unique_collision_via_seq_bump() {
    let tmp = TempDir::new().unwrap();
    let dlq_dir = tmp.path().join("dlq");
    let objects_dir = tmp.path().join("objects");
    std::fs::create_dir_all(&dlq_dir).unwrap();
    std::fs::create_dir_all(&objects_dir).unwrap();

    let graph = SqliteGraphStore::new_in_memory().expect("create in-memory store");
    let objects = LocalObjectStore::new(tmp.path());

    let pipeline = WritePipeline::new(Box::new(graph), Box::new(objects), dlq_dir.clone());

    let session = sample_session("X");
    let turn_a = sample_turn("turn_A", "X", 1, "a");
    let turn_b = sample_turn("turn_B", "X", 1, "b");

    // First turn: succeeds. DB now has (X, seq=1, id=turn_A).
    pipeline
        .write_capture(
            &session,
            &turn_a,
            &[],
            br#"{"req":"a"}"#,
            br#"{"resp":"a"}"#,
        )
        .expect("first turn must succeed");

    // Second turn: a DIFFERENT row trying to land at (X, seq=1).
    // Bug-2 fix: the pipeline detects UniqueViolation on the
    // (session_id, sequence_num) constraint, re-queries the max
    // sequence_num for the session, and retries with the bumped seq.
    // BOTH turns persist with distinct sequence_nums.
    let result = pipeline.write_capture(
        &session,
        &turn_b,
        &[],
        br#"{"req":"b"}"#,
        br#"{"resp":"b"}"#,
    );

    assert!(
        result.is_ok(),
        "Bug-2: write_capture must recover from a (session, seq) collision \
         by bumping the in-memory turn's sequence_num and retrying. \
         Got: {:?}",
        result.err()
    );

    // Both rows persisted with distinct seq_nums.
    let turns = pipeline
        .graph()
        .get_turns_for_session("X")
        .expect("read back turns");
    let mut ids: Vec<String> = turns.iter().map(|t| t.id.clone()).collect();
    ids.sort();
    assert_eq!(ids, vec!["turn_A".to_string(), "turn_B".to_string()]);
    let mut seqs: Vec<i64> = turns.iter().map(|t| t.sequence_num).collect();
    seqs.sort();
    assert_eq!(seqs, vec![1, 2]);

    // No DLQ entry: the loser recovered via seq bump, did not dead-letter.
    let dlq_entries: Vec<_> = std::fs::read_dir(&dlq_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            s.ends_with(".json") && !s.starts_with(".tmp_")
        })
        .collect();
    assert_eq!(
        dlq_entries.len(),
        0,
        "no DLQ entry expected — the loser recovered via seq bump"
    );
}

/// Concurrent-race probe — proves the production trigger.
///
/// **Setup:** Two threads each call `write_capture` for the SAME session.
/// Each computes `sequence_num` from its own view (e.g., a stale read of
/// the current max). The threads commit roughly simultaneously.
///
/// **The production trigger:** in `gateway/src/gateway/run_listener.rs:709`
/// every TCP connection is `tokio::spawn`-ed with its OWN `SessionManager`
/// (line 1008). When Claude Code opens parallel connections — common during
/// image-attachment turns — each handler reads `current_max_seq` from PG
/// and computes `start_seq = max + 1`. Two concurrent handlers reading
/// `max=3` both compute `4`, and one of them collides on
/// `UNIQUE(session_id, sequence_num)`.
///
/// **Compliance invariant:** even when the collision is a race (not a real
/// data conflict), the audit trail must not silently drop a turn. Either
/// the gateway retries with the next free sequence_num, or it surfaces an
/// error so the operator can investigate.
///
/// **Today's behaviour (the bug):** the loser of the race silently DLQ's
/// or — worse, with the misclassification bug above — silently returns Ok.
/// In production this manifests as a missing turn whose attachments
/// FK-fail downstream.
#[test]
fn concurrent_write_capture_with_same_seq_does_not_lose_turn_silently() {
    use std::sync::Arc;
    use std::thread;

    let tmp = TempDir::new().unwrap();
    let dlq_dir = tmp.path().join("dlq");
    let objects_dir = tmp.path().join("objects");
    std::fs::create_dir_all(&dlq_dir).unwrap();
    std::fs::create_dir_all(&objects_dir).unwrap();

    let graph = SqliteGraphStore::new_in_memory().expect("create in-memory store");
    let objects = LocalObjectStore::new(tmp.path());

    let pipeline = Arc::new(WritePipeline::new(
        Box::new(graph),
        Box::new(objects),
        dlq_dir.clone(),
    ));

    let session = sample_session("Y");
    pipeline
        .graph()
        .write_session(&session)
        .expect("session insert");

    // Two threads each try to insert at (Y, sequence_num=1) with DIFFERENT
    // ids. This simulates two parallel TCP handlers reading
    // `max_seq = 0` and both computing `start_seq = 1`.
    let p1 = Arc::clone(&pipeline);
    let p2 = Arc::clone(&pipeline);
    let session_clone1 = session.clone();
    let session_clone2 = session.clone();

    let h1 = thread::spawn(move || {
        let turn = sample_turn("turn_C", "Y", 1, "c");
        p1.write_capture(
            &session_clone1,
            &turn,
            &[],
            br#"{"req":"c"}"#,
            br#"{"resp":"c"}"#,
        )
    });
    let h2 = thread::spawn(move || {
        let turn = sample_turn("turn_D", "Y", 1, "d");
        p2.write_capture(
            &session_clone2,
            &turn,
            &[],
            br#"{"req":"d"}"#,
            br#"{"resp":"d"}"#,
        )
    });
    let r1 = h1.join().unwrap();
    let r2 = h2.join().unwrap();

    // Compliance invariant: both writes are accounted for. EITHER both
    // succeed (the loser retried with the next free seq), OR the loser
    // either propagates an error or lands a DLQ entry. SILENT Ok with no
    // DLQ for a dropped turn is unacceptable for an audit gateway.
    let dlq_entries: Vec<_> = std::fs::read_dir(&dlq_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            s.ends_with(".json") && !s.starts_with(".tmp_")
        })
        .collect();

    let both_ok = r1.is_ok() && r2.is_ok();
    let loser_propagated = r1.is_err() || r2.is_err();
    let loser_dlqd = !dlq_entries.is_empty();

    // Count turns actually persisted for session Y.
    let turn_count_y = pipeline
        .graph()
        .get_turns_for_session("Y")
        .map(|v| v.len() as i64)
        .unwrap_or(0);

    assert!(
        (both_ok && turn_count_y == 2) || loser_propagated || loser_dlqd,
        "SILENT RACE LOSS: r1={:?} r2={:?} turns_in_db={} dlq_entries={}. \
         Two concurrent writers at the same (session, sequence_num) slot \
         both reported success but only {} row(s) persisted. The audit \
         trail dropped the loser of the race silently — the operator has \
         no signal that a turn was lost. This is the production trigger \
         for the missing-turn bug observed on 2026-05-03.",
        r1.as_ref().map(|_| "Ok").unwrap_or("Err"),
        r2.as_ref().map(|_| "Ok").unwrap_or("Err"),
        turn_count_y,
        dlq_entries.len(),
        turn_count_y,
    );
}

/// **Stricter invariant** (Bug 2 from the 2026-05-03 production incident):
/// when two concurrent connection handlers race on the same `sequence_num`,
/// BOTH turns must end up persisted — the loser of the race must NOT
/// dead-letter, it must auto-retry with the next-free sequence_num.
///
/// **Production trigger** observed by the user: Claude Code makes parallel
/// haiku/opus calls for a single user prompt. Two TCP handlers each
/// `tokio::spawn`ed with their own `SessionManager` both compute
/// `start_seq = current_max_seq + 1`, both attempt insert. Today the
/// loser hits `UNIQUE(session_id, sequence_num)`, the WritePipeline
/// retries 3× with the SAME stale seq_num (each retry hits the same
/// constraint), and dead-letters. The user sees the turn vanish.
///
/// **Expected behaviour after the fix:** the loser detects
/// `UniqueViolation { entity: "turn", constraint: "...session_id...sequence_num..." }`,
/// re-queries `MAX(sequence_num) + 1` for the session, bumps the in-memory
/// turn record's seq_num, and retries. Both turns persist with distinct
/// sequence_nums.
///
/// **Anti-fake**: counts persisted turns AFTER the race. Two `Ok(())`
/// returns + only one row in the DB is exactly the bug we're trying
/// to fix.
#[test]
fn concurrent_write_capture_with_same_seq_persists_both_turns() {
    use std::sync::Arc;
    use std::thread;

    let tmp = TempDir::new().unwrap();
    let dlq_dir = tmp.path().join("dlq");
    let objects_dir = tmp.path().join("objects");
    std::fs::create_dir_all(&dlq_dir).unwrap();
    std::fs::create_dir_all(&objects_dir).unwrap();

    let graph = SqliteGraphStore::new_in_memory().expect("create in-memory store");
    let objects = LocalObjectStore::new(tmp.path());
    let pipeline = Arc::new(WritePipeline::new(
        Box::new(graph),
        Box::new(objects),
        dlq_dir.clone(),
    ));

    let session = sample_session("Z_strict");
    pipeline
        .graph()
        .write_session(&session)
        .expect("session insert");

    let p1 = Arc::clone(&pipeline);
    let p2 = Arc::clone(&pipeline);
    let session_clone1 = session.clone();
    let session_clone2 = session.clone();

    let h1 = thread::spawn(move || {
        let turn = sample_turn("turn_E", "Z_strict", 1, "e");
        p1.write_capture(
            &session_clone1,
            &turn,
            &[],
            br#"{"req":"e"}"#,
            br#"{"resp":"e"}"#,
        )
    });
    let h2 = thread::spawn(move || {
        let turn = sample_turn("turn_F", "Z_strict", 1, "f");
        p2.write_capture(
            &session_clone2,
            &turn,
            &[],
            br#"{"req":"f"}"#,
            br#"{"resp":"f"}"#,
        )
    });
    let r1 = h1.join().unwrap();
    let r2 = h2.join().unwrap();

    // The strict invariant: BOTH writers must succeed AND both turns must
    // be in the DB with distinct sequence_nums.
    assert!(
        r1.is_ok() && r2.is_ok(),
        "both writers must return Ok: r1={:?} r2={:?}",
        r1.err(),
        r2.err()
    );
    let turns = pipeline
        .graph()
        .get_turns_for_session("Z_strict")
        .expect("read back turns");
    assert_eq!(
        turns.len(),
        2,
        "BOTH turns must persist after concurrent race; got {} turns. \
         Today's bug: WritePipeline retries with the stale sequence_num \
         and dead-letters the loser. Fix: detect UniqueViolation on \
         `(session_id, sequence_num)`, re-query MAX(sequence_num)+1 for \
         the session, bump the turn record's seq_num, and retry.",
        turns.len()
    );
    let mut seqs: Vec<i64> = turns.iter().map(|t| t.sequence_num).collect();
    seqs.sort();
    assert_eq!(
        seqs,
        vec![1, 2],
        "both turns must occupy distinct sequence_nums (1 and 2); got {:?}",
        seqs
    );
    let mut ids: Vec<String> = turns.iter().map(|t| t.id.clone()).collect();
    ids.sort();
    assert_eq!(
        ids,
        vec!["turn_E".to_string(), "turn_F".to_string()],
        "both turn IDs must be preserved (no row was overwritten); got {:?}",
        ids
    );
}

/// **High-contention stress test** — 10 concurrent writers all trying to
/// land at `(session, sequence_num=1)`. Mirrors the production failure
/// mode: Claude Code under burst load fires multiple parallel
/// haiku/opus calls into a single session.
///
/// Today's live behaviour with 10 concurrent writers (without the
/// expanded collision-retry budget): only 4 of 10 turns persisted; 6
/// dead-lettered with `Graph write failed after 3 retries`. The fix
/// expands the collision-retry budget to 64 (each collision retry
/// strictly progresses by bumping seq_num) so all writers eventually
/// converge.
///
/// **Anti-fake**: counts persisted turns AFTER the burst. A retry-budget
/// regression would surface as `< 10 turns` / non-distinct seqs and the
/// test fails.
#[test]
fn high_contention_concurrent_writers_all_persist() {
    use std::sync::Arc;
    use std::thread;

    let tmp = TempDir::new().unwrap();
    let dlq_dir = tmp.path().join("dlq");
    let objects_dir = tmp.path().join("objects");
    std::fs::create_dir_all(&dlq_dir).unwrap();
    std::fs::create_dir_all(&objects_dir).unwrap();

    let graph = SqliteGraphStore::new_in_memory().expect("create in-memory store");
    let objects = LocalObjectStore::new(tmp.path());
    let pipeline = Arc::new(WritePipeline::new(
        Box::new(graph),
        Box::new(objects),
        dlq_dir.clone(),
    ));

    let session = sample_session("burst_session");
    pipeline
        .graph()
        .write_session(&session)
        .expect("session insert");

    const N: usize = 10;
    let mut handles = Vec::with_capacity(N);
    for i in 0..N {
        let pipeline_clone = Arc::clone(&pipeline);
        let session_clone = session.clone();
        handles.push(thread::spawn(move || {
            let id = format!("turn_{:02}", i);
            let suffix = format!("{:02}", i);
            // Every writer starts at seq=1 — the worst-case burst.
            let turn = sample_turn(&id, "burst_session", 1, &suffix);
            let req = format!(r#"{{"req":"{}"}}"#, i);
            let resp = format!(r#"{{"resp":"{}"}}"#, i);
            pipeline_clone.write_capture(
                &session_clone,
                &turn,
                &[],
                req.as_bytes(),
                resp.as_bytes(),
            )
        }));
    }

    let results: Vec<Result<(), anyhow::Error>> =
        handles.into_iter().map(|h| h.join().unwrap()).collect();
    let n_ok = results.iter().filter(|r| r.is_ok()).count();
    let first_err = results.iter().find_map(|r| r.as_ref().err());

    assert_eq!(
        n_ok, N,
        "all {} concurrent writers must succeed; got {}/{}. \
         First error: {:?}",
        N, n_ok, N, first_err
    );

    let turns = pipeline
        .graph()
        .get_turns_for_session("burst_session")
        .expect("read back turns");
    assert_eq!(
        turns.len(),
        N,
        "all {} turns must be persisted in the DB; got {}",
        N,
        turns.len()
    );
    let mut seqs: Vec<i64> = turns.iter().map(|t| t.sequence_num).collect();
    seqs.sort();
    let expected_seqs: Vec<i64> = (1..=N as i64).collect();
    assert_eq!(
        seqs, expected_seqs,
        "all {} turns must occupy distinct, contiguous sequence_nums 1..={}; got {:?}",
        N, N, seqs
    );

    // No DLQ entries — every loser recovered via seq bump.
    let dlq_entries: Vec<_> = std::fs::read_dir(&dlq_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let s = name.to_string_lossy();
            s.ends_with(".json") && !s.starts_with(".tmp_")
        })
        .collect();
    assert_eq!(
        dlq_entries.len(),
        0,
        "no DLQ entries expected; high-contention writers must all converge"
    );
}

/// **Multi-instance race against live PG** — the production-correct
/// proof that `pg_advisory_xact_lock` actually serializes concurrent
/// writers across separate `PostgresGraphStore` instances (which is
/// what a multi-gateway-process deployment looks like from PG's
/// perspective).
///
/// Spawns two `PostgresGraphStore` instances (each with its own
/// connection pool, simulating two gateway processes), then races 20
/// concurrent writers across the two stores all trying to write turns
/// into the same session. Expectation: all 20 turns persist with
/// distinct contiguous sequence_nums 1..20. No DLQ, no lost writes.
///
/// **The retry-with-bump approach this replaces would have failed**
/// here: even with 64 retries, two PROCESSES spinning past each other
/// without synchronization can cycle endlessly. The advisory lock is
/// the only thing that makes this safe across multiple gateway
/// instances.
///
/// Gated behind `feature = "postgres-tests"`. Requires a live PG with
/// `RECONDO_DB_URL` set.
#[cfg(feature = "postgres-tests")]
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn pg_atomic_seq_advisory_lock_serializes_multi_instance_writers() {
    use recondo_gateway::storage::graph::GraphStore;
    use recondo_gateway::storage::postgres::PostgresGraphStore;
    use std::sync::Arc;

    let url = common::pg_container::url();

    // Two separate PostgresGraphStore instances — each has its own
    // connection pool, simulating two gateway processes.
    let store_a = Arc::new(PostgresGraphStore::new(url).expect("connect store A"));
    let store_b = Arc::new(PostgresGraphStore::new(url).expect("connect store B"));

    // Unique session id for hermetic isolation.
    let session_id = format!("multiinstance_{}", uuid::Uuid::new_v4());
    let mut session = sample_session(&session_id);
    session.id = session_id.clone();
    store_a.write_session(&session).expect("session insert");

    const N: usize = 20;
    let mut handles = Vec::with_capacity(N);
    for i in 0..N {
        let store = if i % 2 == 0 {
            Arc::clone(&store_a)
        } else {
            Arc::clone(&store_b)
        };
        let sid = session_id.clone();
        handles.push(tokio::task::spawn_blocking(move || {
            let id = format!("turn_mi_{:02}", i);
            let suffix = format!("{:02}", i);
            // Every writer claims seq=1 — atomic-seq must allocate distinct slots.
            let turn = sample_turn(&id, &sid, 1, &suffix);
            store.write_turn_atomic_seq(&turn)
        }));
    }
    let mut all_ok = true;
    let mut returned_seqs: Vec<i64> = Vec::with_capacity(N);
    for h in handles {
        match h.await.unwrap() {
            Ok(seq) => returned_seqs.push(seq),
            Err(e) => {
                eprintln!("write_turn_atomic_seq failed: {:?}", e);
                all_ok = false;
            }
        }
    }
    assert!(all_ok, "all {} writers must succeed", N);

    let mut sorted = returned_seqs.clone();
    sorted.sort();
    let expected: Vec<i64> = (1..=N as i64).collect();
    assert_eq!(
        sorted, expected,
        "atomic-seq writers must receive distinct contiguous seqs 1..{}; got {:?}",
        N, returned_seqs
    );

    // Cross-check: PG actually has all 20 rows.
    let turns = store_a
        .get_turns_for_session(&session_id)
        .expect("read turns");
    assert_eq!(
        turns.len(),
        N,
        "all {} turns must be persisted in PG; got {}",
        N,
        turns.len()
    );

    // Cleanup.
    let pool = store_a.pool().clone();
    {
        let client = pool.get().await.expect("pool get");
        client
            .execute("DELETE FROM turns WHERE session_id = $1", &[&session_id])
            .await
            .ok();
        client
            .execute("DELETE FROM sessions WHERE id = $1", &[&session_id])
            .await
            .ok();
    }
}

/// PG jsonb-bind probe — B2 from the production incident.
///
/// **The bug:** `anomaly_events.metadata` is `JSONB` in PG (per migration
/// `api/migrations/007_fix-anomaly-events.sql:23`). The Rust struct
/// `AnomalyEventRecord.metadata` is `String` (per
/// `gateway/src/db/mod.rs:199`). All three PG insert sites in
/// `gateway/src/storage/postgres.rs:1175, 1240, 1402` bind the String
/// directly:
///
///   `&event.metadata,  // 9th positional`
///
/// `tokio_postgres::types::ToSql for String` serializes as TEXT/VARCHAR,
/// not JSONB. PG rejects the bind with "error serializing parameter 8"
/// (0-indexed). The drift-detection sub-pipeline silently swallows this
/// error as non-fatal, but the result is that ZERO anomaly events ever
/// land in PG — defeating ISO 42001 Cl.9.1 audit reporting.
///
/// This test directly exercises the PG path. Gated behind
/// `feature = "postgres-tests"` because it requires `RECONDO_DB_URL`.
#[cfg(feature = "postgres-tests")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pg_write_anomaly_event_with_metadata_succeeds() {
    use recondo_gateway::db::AnomalyEventRecord;
    use recondo_gateway::storage::graph::GraphStore;
    use recondo_gateway::storage::postgres::PostgresGraphStore;

    let url = common::pg_container::url();
    let store = PostgresGraphStore::new(url).expect("connect to PG and initialize schema");

    // Seed a session so the anomaly's session_id FK is satisfied. Use a
    // unique id so the test is hermetic across concurrent runs.
    let session_id = format!("anomaly_test_{}", uuid::Uuid::new_v4());
    let mut session = sample_session(&session_id);
    session.id = session_id.clone();
    let _ = store.write_session(&session);

    let event = AnomalyEventRecord {
        id: format!("anom_{}", uuid::Uuid::new_v4()),
        session_id: session_id.clone(),
        turn_id: "turn_x".to_string(),
        anomaly_type: "system_prompt_drift".to_string(),
        severity: "high".to_string(),
        description: "test drift".to_string(),
        detected_at: "2026-05-03T15:30:00Z".to_string(),
        resolved_at: None,
        metadata: r#"{"old_hash":"abc","new_hash":"def"}"#.to_string(),
    };

    let result = store.write_anomaly_event(&event);

    // Today's bug: result is Err with "error serializing parameter 8"
    // because metadata is bound as String against a JSONB column.
    assert!(
        result.is_ok(),
        "PG jsonb bind: write_anomaly_event must succeed for a record \
         with non-empty metadata. Got: {:?}. The fix is to bind \
         `event.metadata` as `serde_json::Value` (parsed) so tokio-postgres \
         serializes it as JSONB rather than TEXT. The earlier `$9::jsonb` \
         SQL cast does not work because tokio-postgres reads the parameter \
         type from the prepared statement, sees jsonb, and tries to \
         serialize a Rust String as jsonb — which fails before the query \
         is sent.",
        result.err()
    );
}

/// Race regression: writing an attachment row AFTER orphan-cleanup
/// has deleted the blob must NOT create a dangling row.
///
/// # The bug
///
/// `with_sha256_orphan_delete_lock` (postgres.rs:1759) takes
/// `pg_advisory_xact_lock(hashtext(sha256))`, counts attachment rows
/// for the sha, and if 0 deletes the blob. The contract docstring
/// (graph.rs FIND-6-F) claimed this serialised against concurrent
/// `write_attachment` for the same sha — but `write_attachment` did
/// not take the lock. Result: a writer arriving after the deleter
/// commits inserts a row referencing a blob that no longer exists.
///
/// # Reproduction (deterministic, no threads)
///
/// Run the operations in the order that the buggy interleaving
/// produces:
///   1. PUT blob to object store
///   2. orphan-delete via `with_sha256_orphan_delete_lock`
///      (sees count=0 → deletes blob)
///   3. write attachment row pointing at that sha
///
/// Post-condition: `count > 0 ⇒ blob exists`. Buggy code creates
/// `count == 1 ∧ ¬blob_exists` and the assertion fires.
///
/// # The fix
///
/// `write_attachment_with_blob_check` (graph.rs) takes the same
/// advisory lock and refuses the insert when the closure reports the
/// blob is gone. PostgresGraphStore overrides the default impl with
/// the lock-and-check logic; this test exercises the override path.
#[cfg(feature = "postgres-tests")]
#[test]
fn pg_write_attachment_after_orphan_delete_does_not_dangle() {
    use recondo_gateway::db::AttachmentRecord;
    use recondo_gateway::hash;
    use recondo_gateway::storage::graph::GraphStore;
    use recondo_gateway::storage::object::{LocalObjectStore, ObjectStore};
    use recondo_gateway::storage::postgres::PostgresGraphStore;
    use std::sync::Arc;

    let url = common::pg_container::url();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .unwrap();
    let _g = rt.enter();

    let pg = PostgresGraphStore::new(url).expect("pg connect");
    let tmp = TempDir::new().unwrap();
    let objects: Arc<dyn ObjectStore> = Arc::new(LocalObjectStore::new(tmp.path()));

    let stamp = uuid::Uuid::new_v4();
    // Compute sha from the actual bytes — LocalObjectStore verifies
    // that put(sha, bytes) matches sha(bytes) and rejects mismatches.
    let blob_bytes = format!("dangle-test-blob-{stamp}").into_bytes();
    let sha = hash::sha256_hex(&blob_bytes);
    let session_id = format!("dangle-sess-{stamp}");
    let turn_id = format!("dangle-turn-{stamp}");

    pg.write_session(&sample_session(&session_id))
        .expect("seed session");
    pg.write_turn(&sample_turn(&turn_id, &session_id, 1, "dangle"))
        .expect("seed turn");

    // Step 1: writer's first action — PUT the blob.
    objects
        .put("attachments", &sha, &blob_bytes)
        .expect("put blob");
    assert!(
        objects.exists("attachments", &sha).expect("exists check"),
        "blob must exist after PUT"
    );

    // Step 2: orphan-delete arrives BEFORE the writer's INSERT.
    // No attachment rows reference sha → deleter sees count=0 →
    // deletes the just-PUT blob.
    let deleted = pg
        .with_sha256_orphan_delete_lock(&sha, &mut || {
            objects
                .delete("attachments", &sha)
                .map(|_| ())
                .map_err(|e| anyhow::anyhow!("{}", e))
        })
        .expect("orphan-delete must succeed");
    assert!(deleted, "deleter must have deleted the blob");
    assert!(
        !objects.exists("attachments", &sha).expect("exists check"),
        "blob must be gone after orphan-delete"
    );

    // Step 3: writer commits its row. The race-safe API checks blob
    // existence under the same advisory-lock domain and must refuse
    // the insert because the blob is missing.
    let record = AttachmentRecord {
        id: format!("att-dangle-{stamp}"),
        turn_id: turn_id.clone(),
        session_id: session_id.clone(),
        sequence_num: 0,
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

    let objects_check = objects.clone();
    let sha_check = sha.clone();
    let _ = pg.write_attachment_with_blob_check(&record, &mut || {
        objects_check
            .exists("attachments", &sha_check)
            .map_err(|e| anyhow::anyhow!("{}", e))
    });

    // Post-condition: no dangling reference.
    let count = pg
        .attachment_sha256_reference_count(&sha)
        .expect("ref-count");
    let blob_exists = objects.exists("attachments", &sha).expect("exists check");
    assert!(
        count == 0 || blob_exists,
        "DANGLING ROW: {count} attachment row(s) reference sha {sha} but the blob is deleted. \
         The race-safe API must refuse the insert when the blob is missing."
    );
}
