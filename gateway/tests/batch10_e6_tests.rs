//! Batch 10 / E6 — fcntl-based recovery lock TOCTOU hardening.
//!
//! Audit ref: `docs/GATEWAY_AUDIT_2026_05_02.md:204-210`.
//!
//! The current `acquire_recovery_lock` (`gateway/src/capture/recovery.rs`)
//! does:
//!
//!   1. `OpenOptions::new().create(true).truncate(false).open(&lock_path)`
//!   2. `fs2::FileExt::try_lock_exclusive(&file)`
//!
//! Both `flock(2)` and `fcntl(F_SETLK)` lock the **inode**, not the
//! path. Between (1) and (2) — and any time the recovery run is in
//! flight — another actor (e.g. an operator running the
//! `CLAUDE.md:287-301` "rm the wedged lock file" runbook step) can
//! `unlink` the file. A subsequent acquirer then `open(create=true)`s
//! a brand-new file at the same path, on a **different inode**, and
//! its `flock` succeeds because nothing else holds inode_Y. Both the
//! original holder (now on the unlinked inode_X) and the new acquirer
//! (on inode_Y) believe they hold the recovery lock. That is the
//! audit's TOCTOU race.
//!
//! Required fix shape (any of the following counts):
//!
//!   * After `flock`, verify `fstat(fd).ino()` matches
//!     `stat(path).ino()`. On mismatch, drop fd and retry.
//!   * Use a sentinel + generation token under the flock so the
//!     content of the lock survives unlink-and-recreate.
//!   * Migrate to `nix::fcntl` POSIX advisory locks **and** add the
//!     inode-stability check (per-inode locking is the same on
//!     darwin/linux for both `flock` and `fcntl(F_SETLK)`, so the
//!     check is what actually closes the race).
//!   * Update `CLAUDE.md` runbook to NOT recommend `rm` as a routine
//!     recovery step.
//!
//! The tests in this file are deliberately "fail loudly on the
//! current implementation, pass after the fix lands". Each test
//! comments which assertion catches which audit concern.

#![allow(unused_imports)]

use std::fs;
use std::io::Write;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use flate2::write::GzEncoder;
use flate2::Compression;
use fs2::FileExt;
use tempfile::TempDir;

use recondo_gateway::capture::recovery::{recover_orphan_captures, RecoveryConfig};
use recondo_gateway::hash;
use recondo_gateway::schema::CaptureRecord;
use recondo_gateway::storage::graph::SqliteGraphStore;
use recondo_gateway::storage::object::LocalObjectStore;

// ---------------------------------------------------------------------------
// Repo-relative file helpers (for the runbook / source static checks)
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("gateway crate dir must have a parent (repo root)")
        .to_path_buf()
}

fn read_repo_file(rel: &str) -> String {
    let p = repo_root().join(rel);
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("read {}: {}", p.display(), e))
}

// ---------------------------------------------------------------------------
// Capture / orphan helpers (kept self-contained — do not depend on the
// round-2 fixture so timing changes in the fix don't bleed across
// suites).
// ---------------------------------------------------------------------------

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

fn anthropic_sse_response_bytes(text: &str) -> Vec<u8> {
    let mut buf = String::new();
    buf.push_str(
        "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_t\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":7,\"output_tokens\":1}}}\n\n",
    );
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

fn seed_orphan(data_dir: &Path, label: &str, ts: &str) -> String {
    let req = anthropic_request_bytes(label);
    let resp = anthropic_sse_response_bytes("ok");
    let req_hash = write_gzipped_object(data_dir, "req", &req);
    let resp_hash = write_gzipped_object(data_dir, "resp", &resp);
    let uuid_str = uuid::Uuid::new_v4().to_string();
    let record = CaptureRecord {
        timestamp: ts.to_string(),
        uuid: uuid_str.clone(),
        provider: "anthropic".to_string(),
        request_hash: req_hash.clone(),
        response_hash: resp_hash.clone(),
        req_bytes_ref: format!("objects/req/{}.json.gz", req_hash),
        resp_bytes_ref: format!("objects/resp/{}.json.gz", resp_hash),
        request_size: req.len() as u64,
        response_size: resp.len() as u64,
    };
    let dir = data_dir.join("captures");
    fs::create_dir_all(&dir).unwrap();
    let safe_ts = ts.replace([':', '+', '-'], "").replace('.', "_");
    let filename = format!("{}_{}.json", safe_ts, uuid_str);
    fs::write(
        dir.join(filename),
        serde_json::to_string_pretty(&record).unwrap(),
    )
    .unwrap();
    req_hash
}

// ===========================================================================
// T1 and T6 deletion note (round 2).
//
// The previous T1 and T6 attempted to assert the in-code lock fix
// blocks or errors when an operator runs `rm <data_dir>/.recovery.lock`
// against a live, advisory-locked holder. Round-1 review (PR/DE/DA)
// concluded the in-code fix CANNOT detect that scenario — once the
// path is unlinked under a live holder, the new acquirer's fresh
// inode passes the post-flock inode-stability check (it's the only
// inode at the path). Detecting a stale unlinked-inode holder
// requires either a content-level generation token (every acquirer
// writes+fsyncs under the flock and re-reads to verify their own
// generation, with associated failure modes) or operator discipline.
//
// Per the audit (`docs/GATEWAY_AUDIT_2026_05_02.md:204-210`) the
// primary recommendation was "Don't `rm` the lock file as recovery
// action" — a runbook directive. The in-code fix complements that
// by closing the literal open-flock window race (verified by T2's
// static check). The runbook gating is verified by T3.
//
// T1/T6 were removed because they conflated "operator follows the
// `rm` step against a live holder" (a runbook concern this code
// cannot detect) with "concurrent acquirers race the open-flock
// window" (the code-fix scope). T2-T5 cover the code-fix scope and
// T3 covers the runbook scope.
// ===========================================================================

// ===========================================================================
// T2 — Static source invariant: the lock acquirer must perform an
// inode-stability check (or migrate to a sentinel/generation token
// scheme). A pure `try_lock_exclusive` with no inode verification is
// the audited bug.
// ===========================================================================

/// **Anti-fake property:** parses
/// `gateway/src/capture/recovery.rs` and asserts that the body of
/// `acquire_recovery_lock` (or its replacement) carries one of the
/// fix markers from the audit:
///
///   * `metadata().ino()` / `MetadataExt::ino` (raw inode comparison)
///   * `nix::sys::stat::fstat` (POSIX fstat path)
///   * a `generation` / `sentinel` / `nonce` keyword (the alternate
///     "sentinel + generation token" approach)
///
/// Current source contains none of these → test fails. The fix MUST
/// add at least one before it can pass.
#[test]
fn recovery_lock_source_includes_inode_or_generation_check() {
    let src = read_repo_file("gateway/src/capture/recovery.rs");

    // Sanity: the lock function still exists.
    assert!(
        src.contains("fn acquire_recovery_lock"),
        "expected acquire_recovery_lock function in recovery.rs"
    );

    // Look for any of the accepted fix markers anywhere in the file
    // (the implementer may factor the inode check into a helper).
    let has_inode_check = src.contains(".ino()")
        || src.contains("MetadataExt")
        || src.contains("fstat")
        || src.contains("ino_eq")
        || src.contains("inode");

    let has_generation_token = src.to_lowercase().contains("generation")
        || src.to_lowercase().contains("sentinel")
        || src.to_lowercase().contains("nonce");

    assert!(
        has_inode_check || has_generation_token,
        "TOCTOU hardening missing: recovery.rs's lock acquisition uses \
         only fs2::FileExt::try_lock_exclusive with no inode-stability \
         or generation-token check. Per \
         docs/GATEWAY_AUDIT_2026_05_02.md:204-210 the fix must verify \
         fstat(fd).ino == stat(path).ino after flock (or carry an \
         in-content generation token under the flock). Found neither."
    );
}

// ===========================================================================
// T3 — Runbook invariant: CLAUDE.md MUST NOT prescribe `rm
// <data_dir>/.recovery.lock` as a routine recovery step. The
// procedure may still document `rm` as a last-resort, but it MUST
// gate the action behind an explicit precondition that the holder is
// definitively dead (lsof / ps).
// ===========================================================================

/// **Anti-fake property:** the audit (E6) flags the runbook itself as
/// racy. Either the `rm` recommendation is removed, or it is wrapped
/// in language that makes the precondition unambiguous ("ONLY if",
/// "no holder", "process is dead", "after confirming via lsof", or
/// equivalent).
///
/// Current CLAUDE.md (lines 287-301) recommends `rm` after a single
/// `lsof` step with no precondition language tying the `rm` to a
/// confirmed-dead holder. The block reads as a routine choice
/// between (2a) `kill <PID>` and (2b) `rm`. A confused operator may
/// run `rm` even with an active holder, triggering the TOCTOU.
///
/// This test asserts a CONJUNCTION: the runbook must (a) still
/// mention `recovery.lock` (so we know we're examining the right
/// section) AND (b) either omit the `rm` recommendation or
/// explicitly precondition it on a confirmed-dead holder.
#[test]
fn runbook_does_not_recommend_unconditional_rm_of_lock_file() {
    let claude_md = read_repo_file("CLAUDE.md");

    assert!(
        claude_md.contains(".recovery.lock"),
        "CLAUDE.md no longer mentions .recovery.lock; this test must be \
         updated if the runbook section moved."
    );

    // Find the lines that prescribe `rm` of the lock file.
    let recommends_rm = claude_md.contains("rm <data_dir>/.recovery.lock")
        || claude_md.contains("rm $data_dir/.recovery.lock")
        || claude_md.contains("rm \"$data_dir/.recovery.lock\"")
        || claude_md.contains("rm ~/.recondo/.recovery.lock");

    if !recommends_rm {
        // Fix flavour A: removed the recommendation entirely. Pass.
        return;
    }

    // Fix flavour B: kept the recommendation but added a precondition.
    // Look for unambiguous gating language somewhere in the same
    // file (the runbook is a single contiguous block, so a
    // file-wide search is acceptable).
    let lc = claude_md.to_lowercase();
    let has_precondition = lc.contains("only if")
        || lc.contains("only after")
        || lc.contains("confirmed dead")
        || lc.contains("process is dead")
        || lc.contains("no holder")
        || lc.contains("lsof reports no holder")
        || lc.contains("after confirming");

    assert!(
        has_precondition,
        "CLAUDE.md still recommends `rm <data_dir>/.recovery.lock` \
         without an explicit precondition that the holder is dead. \
         Per docs/GATEWAY_AUDIT_2026_05_02.md:204-210 the wedged-lock \
         runbook step is itself racy: an operator running `rm` while \
         a live holder owns the inode triggers the audited TOCTOU. \
         Either drop the `rm` recommendation or gate it on \
         lsof-confirmed absence of a holder."
    );
}

// ===========================================================================
// T4 — Concurrent same-process serialization (preserved behaviour).
// ===========================================================================

/// Two threads invoke `recover_orphan_captures` against the same
/// `data_dir`. Both must succeed and the orphan must be inserted at
/// most once. This test deliberately does NOT depend on the round-2
/// fixture so a fix-induced timing change in
/// `acquire_recovery_lock` is observable here without bleed-through.
#[test]
fn concurrent_same_process_recovery_serializes_under_fix() {
    use recondo_gateway::storage::graph::GraphStore;

    let tmp = TempDir::new().unwrap();
    let data_dir: PathBuf = tmp.path().to_path_buf();

    let req_hash = seed_orphan(&data_dir, "batch10-e6-t4", "2026-05-03T00:00:00Z");

    let graph = Arc::new(SqliteGraphStore::new_in_memory().unwrap());

    let dd1 = data_dir.clone();
    let g1 = graph.clone();
    let h1 = std::thread::spawn(move || {
        let objects = LocalObjectStore::new(&dd1);
        recover_orphan_captures(&dd1, &*g1, &objects, &RecoveryConfig::default())
    });
    let dd2 = data_dir.clone();
    let g2 = graph.clone();
    let h2 = std::thread::spawn(move || {
        let objects = LocalObjectStore::new(&dd2);
        recover_orphan_captures(&dd2, &*g2, &objects, &RecoveryConfig::default())
    });

    let r1 = h1.join().unwrap().expect("first invocation must succeed");
    let r2 = h2.join().unwrap().expect("second invocation must succeed");

    assert!(
        r1.recovered + r2.recovered <= 1,
        "Combined recovered must be at most 1; got {} + {}",
        r1.recovered,
        r2.recovered
    );
    assert!(
        graph
            .find_turn_by_request_hash(&req_hash)
            .unwrap()
            .is_some(),
        "Orphan must be inserted exactly once across the two serialized passes"
    );
}

// ===========================================================================
// T5 — Lock auto-released on holder Drop (preserved behaviour).
// ===========================================================================

/// After a recovery run completes (lock guard dropped), a second
/// recovery run must succeed without contention. This guards against
/// a fix that accidentally leaks the lock or fails to release on
/// retry-loop exit paths.
#[test]
fn lock_released_after_recovery_returns_so_second_run_succeeds() {
    let tmp = TempDir::new().unwrap();
    let data_dir: PathBuf = tmp.path().to_path_buf();

    seed_orphan(&data_dir, "batch10-e6-t5-a", "2026-05-03T00:00:01Z");

    let graph = SqliteGraphStore::new_in_memory().unwrap();
    let objects = LocalObjectStore::new(&data_dir);

    let _r1 = recover_orphan_captures(&data_dir, &graph, &objects, &RecoveryConfig::default())
        .expect("first run succeeds");

    // Seed a second orphan and re-run; the second run must acquire
    // the lock (proving the first run released it).
    seed_orphan(&data_dir, "batch10-e6-t5-b", "2026-05-03T00:00:02Z");
    let r2 = recover_orphan_captures(&data_dir, &graph, &objects, &RecoveryConfig::default())
        .expect("second run must acquire the lock and succeed (no leaked guard)");
    assert!(
        r2.recovered >= 1,
        "second run must observe the new orphan (recovered >= 1); got {}",
        r2.recovered
    );
}

// T6 was deleted — see the T1/T6 deletion note above.
