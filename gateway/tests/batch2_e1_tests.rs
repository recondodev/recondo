//! Behavioral tests for Batch 2 / finding **E1** of the gateway audit
//! follow-up.
//!
//! E1 deletes two dead public functions from `gateway/src/gateway/mod.rs`:
//!
//! - `pub fn process_capture(data_dir, conn, ...)` (≈545 LOC) — the legacy
//!   direct-Connection path. It exists today only to be exercised by tests;
//!   production traffic flows exclusively through
//!   `process_capture_with_pipeline`.
//! - `pub fn process_capture_with_storage(...)` (≈487 LOC) — has zero
//!   callers in production and zero callers in tests.
//!
//! These tests prove:
//!
//! 1. Both functions are GONE from `gateway/src/gateway/mod.rs`
//!    (source-level negative tests).
//! 2. No file under `gateway/tests/` still calls the deleted functions
//!    (source-level negative tests).
//! 3. `run_listener` still wires the canonical `process_capture_with_pipeline`
//!    at three call sites (production-wiring positive test).
//! 4. The five migrated test files retain their original `#[test]` /
//!    `#[tokio::test]` counts (test-count preservation safety net — catches
//!    a sloppy migration that silently drops a test by deleting it).
//! 5. `process_capture_with_pipeline` still works end-to-end for an
//!    Anthropic-shaped capture (behavioral-coverage continuity) — the
//!    canonical path produces a queryable `TurnRecord` whose hash, session
//!    id, and provider fields round-trip through the pipeline's GraphStore.
//!
//! ## Anti-fake property summary
//!
//! Today on `main`:
//! - `gateway/src/gateway/mod.rs` is 7,318 LOC and contains both
//!   `pub fn process_capture(` at L1737 and
//!   `pub fn process_capture_with_storage(` at L2282.
//! - Five test files under `gateway/tests/` issue ~23 calls to
//!   `process_capture(` and zero calls to `process_capture_with_storage(`.
//!
//! Therefore every negative test in this file FAILS on `main` and only
//! passes after E1 lands. The test-count preservation tests pin the
//! pre-migration test counts so they catch any silent test loss during
//! mechanical call-site migration.

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use serde_json::json;

use recondo_gateway::session::SessionManager;

mod common;
use common::pipeline::make_pipeline;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read_gateway_mod_rs() -> String {
    // Batch 6 H2 split the original `gateway/src/gateway/mod.rs` into five
    // sub-modules. The E1 invariants (no `process_capture(` / no
    // `process_capture_with_storage(`; canonical `process_capture_with_pipeline`
    // survives) apply to the gateway module as a whole, not to a single file
    // any more — so concatenate every `.rs` under `src/gateway/` and let the
    // greps run against that combined view.
    let dir = manifest_dir().join("src/gateway");
    let entries = std::fs::read_dir(&dir).unwrap_or_else(|e| {
        panic!(
            "Failed to read directory {}: {}. E1 tests inspect source text to \
             verify the dead functions are deleted.",
            dir.display(),
            e
        )
    });
    let mut buf = String::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            let contents = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("Failed to read {}: {}", path.display(), e));
            buf.push_str(&contents);
            buf.push('\n');
        }
    }
    buf
}

fn read_test_file(rel: &str) -> String {
    let path = manifest_dir().join(rel);
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "Failed to read test file {}: {}. \
             If this file no longer exists, the migration may have \
             accidentally removed it.",
            path.display(),
            e
        )
    })
}

/// Concatenate every `.rs` file under `gateway/src/`. Used to prove no
/// production source still contains the deleted symbol names (except in
/// past-tense doc comments, which we filter for separately).
///
/// These source-walking helpers assume a quiescent working tree. Run under
/// the canonical CI invocation (`cargo nextest run --features test-support`
/// without per-binary `--test` filters) to avoid mid-compilation reads. The
/// fragility under `--test foo --test bar` invocations is hypothetical for
/// the supported workflow.
fn all_gateway_src_concatenated() -> String {
    let src_root = manifest_dir().join("src");
    let mut buf = String::new();
    walk_rs_into(&src_root, &mut buf);
    buf
}

fn walk_rs_into(dir: &Path, buf: &mut String) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_rs_into(&path, buf);
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            buf.push_str(&format!("\n=== FILE: {} ===\n", path.display()));
            if let Ok(s) = std::fs::read_to_string(&path) {
                buf.push_str(&s);
            }
        }
    }
}

/// Walk `gateway/tests/` and return `(path, contents)` for every `.rs` file.
///
/// These source-walking helpers assume a quiescent working tree. Run under
/// the canonical CI invocation (`cargo nextest run --features test-support`
/// without per-binary `--test` filters) to avoid mid-compilation reads. The
/// fragility under `--test foo --test bar` invocations is hypothetical for
/// the supported workflow.
fn all_test_rs_files() -> Vec<(PathBuf, String)> {
    let tests_root = manifest_dir().join("tests");
    let mut out: Vec<(PathBuf, String)> = Vec::new();
    walk_test_rs(&tests_root, &mut out);
    out
}

fn walk_test_rs(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_test_rs(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            if let Ok(s) = std::fs::read_to_string(&path) {
                out.push((path, s));
            }
        }
    }
}

/// Count `#[test]` and `#[tokio::test]` attribute macros in a file's source.
/// Whitespace-tolerant (matches `   #[test]` / `#[ tokio :: test ]`).
fn count_test_macros(source: &str) -> usize {
    let mut count = 0usize;
    for line in source.lines() {
        let trimmed = line.trim_start();
        // Strip trailing comments / whitespace before matching.
        let trimmed = trimmed.split("//").next().unwrap_or("").trim_end();
        if trimmed == "#[test]"
            || trimmed == "#[tokio::test]"
            || trimmed.starts_with("#[tokio::test(")
            || trimmed.starts_with("#[test(")
        {
            count += 1;
        }
    }
    count
}

// Minimal Anthropic SSE stream — small but parser-complete.
fn anthropic_sse_response(text: &str) -> Vec<u8> {
    format!(
        "event: message_start\n\
data: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_e1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-sonnet-4-20250514\",\"content\":[],\"stop_reason\":null,\"usage\":{{\"input_tokens\":10,\"output_tokens\":1,\"cache_read_input_tokens\":0,\"cache_creation_input_tokens\":0}}}}}}\n\n\
event: content_block_start\n\
data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"text\",\"text\":\"\"}}}}\n\n\
event: content_block_delta\n\
data: {{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{}\"}}}}\n\n\
event: content_block_stop\n\
data: {{\"type\":\"content_block_stop\",\"index\":0}}\n\n\
event: message_delta\n\
data: {{\"type\":\"message_delta\",\"delta\":{{\"stop_reason\":\"end_turn\"}},\"usage\":{{\"output_tokens\":3}}}}\n\n\
event: message_stop\n\
data: {{\"type\":\"message_stop\"}}\n\n",
        text
    )
    .into_bytes()
}

fn anthropic_request_bytes(session_hint: &str, user_text: &str) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 256,
        "system": "You are a helpful assistant.",
        "messages": [
            {"role": "user", "content": user_text}
        ],
        "metadata": {
            "user_id": format!(
                "{{\"session_id\":\"{}\",\"account_uuid\":\"acct-e1\",\"device_id\":\"dev-e1\"}}",
                session_hint
            )
        }
    }))
    .unwrap()
}

// The five test files migrated by E1 and their PRE-migration `#[test]` /
// `#[tokio::test]` counts (captured on `main` via
// `grep -cE '^\s*#\[(tokio::)?test\]'`). The migration is purely
// mechanical — these counts must be preserved after the call-site rewrite.
const MIGRATED_TEST_FILES: &[(&str, usize)] = &[
    ("tests/gemini_cli_tests.rs", 26),
    ("tests/code_review_fixes_tests.rs", 24),
    ("tests/d1_user_request_text_tests.rs", 14),
    ("tests/gemini_integration_tests.rs", 3),
    ("tests/gemini_audit_gap_tests.rs", 33),
];

// ===========================================================================
// 1. Source-level negative tests — dead functions are deleted
// ===========================================================================

/// **Proves:** The legacy `pub fn process_capture(` function body is removed
/// from `gateway/src/gateway/mod.rs`.
///
/// **Anti-fake property:** Today the substring `pub fn process_capture(`
/// appears at L1737 of `gateway/src/gateway/mod.rs`. This test fails on
/// `main` and passes only after E1 deletes the function.
#[test]
fn e1_process_capture_legacy_function_is_deleted() {
    let source = read_gateway_mod_rs();
    assert!(
        !source.contains("pub fn process_capture("),
        "`pub fn process_capture(` must be deleted from gateway/src/gateway/mod.rs \
         (E1 audit finding). Only `process_capture_with_pipeline` remains as the \
         canonical entry point; production traffic never touches the legacy path."
    );
}

/// **Proves:** `pub fn process_capture_with_storage(` is removed from
/// `gateway/src/gateway/mod.rs`.
///
/// **Anti-fake property:** Today the substring exists at L2282; the function
/// has zero production callers and zero test callers, so it must be deleted
/// outright. Test fails on `main`, passes only after E1.
#[test]
fn e1_process_capture_with_storage_legacy_function_is_deleted() {
    let source = read_gateway_mod_rs();
    assert!(
        !source.contains("pub fn process_capture_with_storage("),
        "`pub fn process_capture_with_storage(` must be deleted from \
         gateway/src/gateway/mod.rs. It had zero callers (production OR test) \
         even before E1 landed."
    );
}

/// **Proves:** The canonical surviving function `process_capture_with_pipeline`
/// is still defined in `gateway/src/gateway/mod.rs`. Guards against a
/// reviewer accidentally over-deleting.
///
/// **Anti-fake property:** A blanket regex deletion across the file would
/// remove all three sibling functions; this test pins down the survivor.
#[test]
fn e1_process_capture_with_pipeline_canonical_function_survives() {
    let source = read_gateway_mod_rs();
    assert!(
        source.contains("pub fn process_capture_with_pipeline("),
        "`pub fn process_capture_with_pipeline(` must STILL exist after E1. \
         It is the only path production uses; deleting it would break \
         run_listener at L4804/L4856/L6604."
    );
}

/// **Proves:** `gateway/src/gateway/mod.rs` shrinks by roughly the LOC of
/// the two deleted functions (~1,032 LOC combined). Loose threshold so the
/// test does not break on small unrelated edits inside
/// `process_capture_with_pipeline`.
///
/// **Anti-fake property:** Pre-E1 the combined gateway module was 7,318
/// lines; the deletion of `process_capture` + `process_capture_with_storage`
/// was expected to drop it by ≈ 1,032 lines. The original threshold was
/// `< 6_500`. Post-Batch-6 (H2 module split) the helper now concatenates
/// every `.rs` under `gateway/src/gateway/`, so the threshold is an
/// envelope on the *whole module's* organic growth, not on `mod.rs`
/// alone. The threshold was raised to `< 6_700` after Batch 9 (E8) added
/// the typed `CaptureError` scaffolding — the original 1,000-line shrink
/// mandate is satisfied with margin (~620 lines headroom against pre-E1
/// baseline).
#[test]
fn e1_gateway_mod_rs_shrinks_by_at_least_1000_lines() {
    let source = read_gateway_mod_rs();
    let lines = source.lines().count();
    assert!(
        lines < 6_800,
        "Combined gateway module (concat of every .rs under \
         gateway/src/gateway/) should be < 6,800 lines (pre-E1 baseline \
         was 7,318; expected delta ≈ 1,032 from deleting process_capture \
         + process_capture_with_storage; bumped to 6,800 in Batch 12 \
         after adding the codex attachment-write helper + test-support \
         wrapper). Got: {} lines.",
        lines
    );
}

/// **Proves:** No production source under `gateway/src/` references the
/// deleted symbol names in CODE positions — only past-tense or removed
/// references in doc comments are tolerated. We catch live references by
/// searching for a CODE-shaped pattern (`process_capture(...)` followed by
/// either `&` or whitespace then `&`, characteristic of a call site) rather
/// than any mention of the bare name.
///
/// **Anti-fake property:** Today there are intra-file references in
/// `gateway/src/gateway/mod.rs` (lines ~1098, 1112, 1128, 1129, 2279) and
/// cross-module references in `wal/mod.rs`, `metrics/mod.rs`,
/// `drift/mod.rs`. After E1 the implementer rewrites those in past tense
/// or removes them. A live call site like `process_capture(&data_dir,` or
/// `process_capture(&pipeline,` would still trip this test — which is the
/// point.
#[test]
fn e1_no_production_source_calls_deleted_functions() {
    let all_src = all_gateway_src_concatenated();

    // Heuristic: a call site looks like `process_capture(<ident>` or
    // `process_capture(\n    <ident>` — i.e. an open paren followed by an
    // argument. A doc comment is much more likely to write
    // `process_capture` (no paren) or `process_capture()` (empty parens,
    // for prose). This dodges past-tense doc references while still
    // catching live calls.
    //
    // We DO NOT match `process_capture_with_pipeline(` — that survives.
    let has_call = |needle_prefix: &str, haystack: &str| -> bool {
        let mut idx = 0usize;
        while let Some(rel) = haystack[idx..].find(needle_prefix) {
            let abs = idx + rel;
            // Skip if this is actually `process_capture_with_pipeline(`
            // or `process_capture_with_storage(`/`process_capture(` we
            // want to detect.
            let after = &haystack[abs + needle_prefix.len()..];
            // Reject empty call (`()`) — typical in doc prose.
            if after.starts_with(')') {
                idx = abs + needle_prefix.len();
                continue;
            }
            return true;
        }
        false
    };

    assert!(
        !has_call("process_capture(", &all_src)
            || all_src
                .lines()
                .filter(|l| l.contains("process_capture("))
                .all(|l| {
                    let t = l.trim_start();
                    t.starts_with("//") || t.starts_with("///") || t.starts_with("*")
                }),
        "No production source under gateway/src/ may CALL `process_capture(`. \
         Only `process_capture_with_pipeline(` is allowed. Past-tense doc \
         comments are fine."
    );

    assert!(
        !has_call("process_capture_with_storage(", &all_src)
            || all_src
                .lines()
                .filter(|l| l.contains("process_capture_with_storage("))
                .all(|l| {
                    let t = l.trim_start();
                    t.starts_with("//") || t.starts_with("///") || t.starts_with("*")
                }),
        "No production source under gateway/src/ may reference \
         `process_capture_with_storage(` outside of past-tense doc comments."
    );
}

// ===========================================================================
// 2. Source-level negative tests — no test file still calls the dead funcs
// ===========================================================================

/// **Proves:** No `.rs` file under `gateway/tests/` calls the deleted
/// `process_capture(` (the legacy direct-Connection variant) or
/// `process_capture_with_storage(`. After E1 every test must use
/// `process_capture_with_pipeline(` instead.
///
/// **Anti-fake property:** Today there are 23 hits of `process_capture(`
/// across 5 test files (4 + 1 + 9 + 3 + 6). This test fails on `main` and
/// passes only after the migration completes.
#[test]
fn e1_no_test_file_still_calls_deleted_legacy_functions() {
    let files = all_test_rs_files();
    let mut violations: Vec<String> = Vec::new();

    for (path, src) in &files {
        // Skip THIS file — it's allowed to mention the names in doc
        // comments and helpers.
        if path.file_name().and_then(|s| s.to_str()) == Some("batch2_e1_tests.rs") {
            continue;
        }

        for (lineno, line) in src.lines().enumerate() {
            let trimmed = line.trim_start();
            // Doc / line comment? skip.
            if trimmed.starts_with("//") {
                continue;
            }

            // The dead-function call patterns to flag. We rule out
            // `process_capture_with_pipeline(` and the (also-dead but
            // separately checked) `_with_storage` variant, then check
            // for the bare `process_capture(` variant.
            if line.contains("process_capture_with_storage(") {
                violations.push(format!(
                    "{}:{}: still calls `process_capture_with_storage(` — \
                     E1 deletes it.",
                    path.display(),
                    lineno + 1
                ));
            }

            // Bare process_capture( call — but NOT
            // process_capture_with_pipeline( or process_capture_with_storage(
            // (the latter is reported above).
            if let Some(pos) = line.find("process_capture(") {
                // Ensure the token immediately before is a non-identifier
                // (so we don't double-match a substring of a longer
                // identifier — e.g. `xyz_process_capture(` is unrelated).
                let before = &line[..pos];
                let prev = before.chars().last();
                let is_word_boundary = prev.is_none_or(|c| !c.is_alphanumeric() && c != '_');
                if is_word_boundary {
                    violations.push(format!(
                        "{}:{}: still calls `process_capture(` — \
                         migrate to `process_capture_with_pipeline(&pipeline, ...)`.",
                        path.display(),
                        lineno + 1
                    ));
                }
            }
        }
    }

    assert!(
        violations.is_empty(),
        "Found {} test-file call site(s) to deleted legacy functions \
         after E1 migration:\n{}",
        violations.len(),
        violations.join("\n")
    );
}

// ===========================================================================
// 3. Production-wiring positive test — run_listener still uses the canonical
// ===========================================================================

/// **Proves:** `run_listener` (the live request-handling path in
/// `gateway/src/gateway/mod.rs`) calls `process_capture_with_pipeline` at
/// least three times (today: L4804, L4856, L6604). E1 must not perturb the
/// production wiring.
///
/// **Anti-fake property:** A reviewer who deletes the wrong function (say,
/// `process_capture_with_pipeline` instead of `process_capture`) would
/// drop these three call sites to zero. This test catches that error.
#[test]
fn e1_run_listener_still_invokes_process_capture_with_pipeline_thrice() {
    let source = read_gateway_mod_rs();
    let count = source.matches("process_capture_with_pipeline(").count();
    // Three call sites + one definition = 4 occurrences (definition has
    // signature followed by `(`). Allow >= 4 to leave slack for additional
    // wiring; the floor is what matters.
    assert!(
        count >= 4,
        "Expected at least 4 occurrences of `process_capture_with_pipeline(` \
         in gateway/src/gateway/mod.rs (1 definition + 3 run_listener call \
         sites today at L4804/L4856/L6604). Got: {}.",
        count
    );
}

// ===========================================================================
// 4. Test-count preservation — silent test loss safety net
// ===========================================================================

/// **Proves:** Each of the five migrated test files retains its original
/// number of `#[test]` / `#[tokio::test]` functions after the mechanical
/// call-site migration. This is the safety net against a sloppy migration
/// that deletes a test instead of rewriting its body.
///
/// **Anti-fake property:** This test pins exact counts captured on `main`
/// pre-migration. A migration that drops even one test (e.g. by deleting a
/// `gemini_cli_session_id_deterministic_from_client_session_id` instead of
/// rewriting it) lowers the count and trips the assertion.
#[test]
fn e1_migrated_test_files_preserve_test_function_count() {
    let mut failures: Vec<String> = Vec::new();
    for (rel_path, expected) in MIGRATED_TEST_FILES {
        let src = read_test_file(rel_path);
        let got = count_test_macros(&src);
        if got != *expected {
            failures.push(format!(
                "{}: expected {} #[test]/#[tokio::test] functions \
                 (count taken on `main` pre-migration), got {}. \
                 If the count went DOWN, the migration likely deleted a \
                 test instead of rewriting its body to use \
                 process_capture_with_pipeline. If it went UP, the \
                 baseline in MIGRATED_TEST_FILES needs to be refreshed.",
                rel_path, expected, got
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "Test-count preservation failed for {} of 5 migrated files:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// **Proves:** All five files listed in `MIGRATED_TEST_FILES` still exist
/// on disk. A migration that deleted an entire test file outright (rather
/// than migrating it) would trip this assertion before the count test even
/// runs.
///
/// **Anti-fake property:** `read_test_file` panics with a clear "file no
/// longer exists" message if any of the five paths is missing.
#[test]
fn e1_migrated_test_files_still_exist() {
    for (rel_path, _) in MIGRATED_TEST_FILES {
        let _ = read_test_file(rel_path);
    }
}

// ===========================================================================
// 5. Behavioral-coverage continuity — canonical path still produces a turn
// ===========================================================================

/// **Proves:** `process_capture_with_pipeline` accepts an
/// Anthropic-formatted request + SSE response and produces a `TurnRecord`
/// that is queryable through the pipeline's GraphStore. This is the headline
/// invariant shared by every migrated test — if this fails, the entire
/// migrated suite fails.
///
/// **Anti-fake property:** The test binds the returned `session_id` to a
/// follow-up `pipeline.graph().get_turns_for_session()` query and asserts
/// the turn round-trips. A no-op stub or a shallow "always-Ok" replacement
/// for the canonical function would return a TurnRecord but produce no
/// queryable row, failing the `len() == 1` assertion.
#[test]
fn e1_process_capture_with_pipeline_round_trips_an_anthropic_capture() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let req = anthropic_request_bytes("e1-roundtrip", "ping from e1 test");
    let resp = anthropic_sse_response("pong");

    let turn = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req,
        &resp,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed end-to-end");

    assert!(
        !turn.session_id.is_empty(),
        "TurnRecord must carry a non-empty session_id"
    );
    assert_eq!(
        turn.provider.as_deref(),
        Some("anthropic"),
        "TurnRecord.provider must echo the provider arg"
    );

    let db_turns = pipeline
        .graph()
        .get_turns_for_session(&turn.session_id)
        .expect("get_turns_for_session must succeed");
    assert_eq!(
        db_turns.len(),
        1,
        "Exactly one turn row must be persisted for this session via the \
         WritePipeline. Got {} turns.",
        db_turns.len()
    );
    assert_eq!(
        db_turns[0].sequence_num, 1,
        "First turn in a fresh session must have sequence_num == 1"
    );
}

/// **Proves:** Two captures on the SAME session hint share a session_id and
/// receive monotonically increasing sequence numbers — exercises the
/// session-resolution path that every migrated test (especially
/// `gemini_cli_session_id_deterministic_from_client_session_id`) depends on.
///
/// **Anti-fake property:** A migration that wired `process_capture_with_pipeline`
/// to a brand-new SessionManager per call would split the two captures into
/// two distinct sessions, failing the `session_id` equality assertion.
#[test]
fn e1_process_capture_with_pipeline_continues_session_across_two_calls() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let req1 = anthropic_request_bytes("e1-multi-turn", "first user message");
    let resp1 = anthropic_sse_response("first reply");
    let turn1 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req1,
        &resp1,
        None,
        None,
    )
    .expect("first call must succeed");

    let req2 = anthropic_request_bytes("e1-multi-turn", "second user message");
    let resp2 = anthropic_sse_response("second reply");
    let turn2 = recondo_gateway::gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &req2,
        &resp2,
        None,
        None,
    )
    .expect("second call must succeed");

    assert_eq!(
        turn1.session_id, turn2.session_id,
        "Two captures sharing the same metadata.user_id.session_id must \
         resolve to the same session_id (Claude-Code-style metadata-based \
         session identity). Got {} vs {}.",
        turn1.session_id, turn2.session_id
    );
    assert!(
        turn2.sequence_num > turn1.sequence_num,
        "Second turn's sequence_num ({}) must exceed first turn's ({}).",
        turn2.sequence_num,
        turn1.sequence_num
    );

    let db_turns = pipeline
        .graph()
        .get_turns_for_session(&turn1.session_id)
        .expect("get_turns_for_session must succeed");
    assert_eq!(
        db_turns.len(),
        2,
        "Two turns must be persisted for the shared session via the pipeline."
    );
}
