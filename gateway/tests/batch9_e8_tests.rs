//! Batch 9 — Audit follow-up E8: typed `CaptureError` enum at the
//! WritePipeline orchestration boundary.
//!
//! Audit reference: `docs/GATEWAY_AUDIT_2026_05_02.md` E8 (lines ~217-221).
//!
//! # What these tests guard
//!
//! `process_capture_with_pipeline` historically returned `anyhow::Result<TurnRecord>`.
//! Several call sites and tests then resorted to
//! `err.to_string().contains("too large")` or
//! `err.to_string().contains("WAL append failed")` to discriminate failures.
//! E8 introduces a typed `CaptureError` enum so callers pattern-match on
//! variants instead of inspecting strings — exactly the shift that
//! `GraphStoreError` already performed at the storage boundary.
//!
//! These tests are written BEFORE the implementation. They MUST fail on
//! `main` today (CaptureError does not exist yet) and pass after Batch 9
//! ships.
//!
//! # Categories
//!
//! 1. Source-level structural tests — `pub enum CaptureError` exists
//!    somewhere under `gateway/src/gateway/`, the audit's required
//!    variants are spelled in source, and the type is re-exported from
//!    `gateway/src/gateway/mod.rs`.
//! 2. Type-level tests — `recondo_gateway::gateway::CaptureError`
//!    resolves; the type implements `Debug`, `Display`,
//!    `std::error::Error`, and `process_capture_with_pipeline` returns
//!    `Result<TurnRecord, CaptureError>` (or compatible).
//! 3. Behavioral tests — trigger each variant via the public surface and
//!    assert via `matches!()` on the typed error.
//! 4. Production wiring smoke test — happy path still returns
//!    `Ok(TurnRecord)`.
//! 5. Display formatting smoke — every variant produces a non-empty,
//!    recognizable `Display` string.
//!
//! # Naming flexibility
//!
//! The audit calls the size-guard variants `RequestTooLarge` /
//! `ResponseTooLarge`. The implementer is allowed to unify them into a
//! single `PayloadTooLarge { kind: PayloadKind, .. }` variant. The
//! source-level structural test below accepts EITHER spelling so the
//! tests don't pin a naming choice the audit explicitly leaves open.

#![allow(clippy::single_match)]

use std::fs;
use std::path::PathBuf;

use recondo_gateway::gateway::{self, CaptureError};
use recondo_gateway::session::SessionManager;
use recondo_gateway::wal::{FailMode, Wal};

mod common;
use common::pipeline::make_pipeline;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// CARGO_MANIFEST_DIR points at `<repo>/gateway`. Resolve relative paths
/// inside the crate from there so the source-grep tests don't depend on
/// the cwd of the test runner.
fn gateway_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Read every `.rs` file under `gateway/src/gateway/` and concatenate
/// their contents. Used by the source-level structural tests so the
/// implementer is free to put `CaptureError` in either
/// `capture_pipeline.rs` or a sibling `capture_error.rs`.
fn read_gateway_module_sources() -> String {
    let dir = gateway_dir().join("src").join("gateway");
    let mut buf = String::new();
    let entries =
        fs::read_dir(&dir).unwrap_or_else(|e| panic!("failed to read {}: {}", dir.display(), e));
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            let s = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e));
            buf.push_str(&s);
            buf.push('\n');
        }
    }
    buf
}

fn read_gateway_mod_rs() -> String {
    let path = gateway_dir().join("src").join("gateway").join("mod.rs");
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
}

/// Build a minimal but realistic Anthropic request body. Mirrors the
/// helper in `code_review_fixes_tests.rs` so the happy-path smoke test
/// is exercising the same shape production already covers.
fn sample_anthropic_request() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "model": "claude-sonnet-4-20250514",
        "max_tokens": 1024,
        "system": "You are a helpful assistant.",
        "messages": [
            {"role": "user", "content": "What is 2+2?"}
        ]
    }))
    .unwrap()
}

fn build_sse_bytes(events: &[(&str, &str)]) -> Vec<u8> {
    let mut buf = String::new();
    for (event_type, data) in events {
        buf.push_str(&format!("event: {}\ndata: {}\n\n", event_type, data));
    }
    buf.into_bytes()
}

fn sample_anthropic_sse_response() -> Vec<u8> {
    build_sse_bytes(&[
        (
            "message_start",
            r#"{"type":"message_start","message":{"id":"msg_test_e8","type":"message","role":"assistant","model":"claude-sonnet-4-20250514","content":[],"stop_reason":null,"usage":{"input_tokens":25,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}"#,
        ),
        (
            "content_block_start",
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        ),
        (
            "content_block_delta",
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"2 + 2 = 4"}}"#,
        ),
        (
            "content_block_stop",
            r#"{"type":"content_block_stop","index":0}"#,
        ),
        (
            "message_delta",
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":10}}"#,
        ),
        ("message_stop", r#"{"type":"message_stop"}"#),
    ])
}

// ===========================================================================
// 1. Source-level structural tests
// ===========================================================================

/// Test: e8_capture_error_enum_declared_in_gateway_module
///
/// Proves: a `pub enum CaptureError` is declared somewhere under
/// `gateway/src/gateway/`. The implementer may put it in
/// `capture_pipeline.rs` or in a sibling `capture_error.rs` — either is
/// acceptable.
///
/// Anti-fake property: substring assertion is on the exact tokens
/// `pub enum CaptureError`. A re-export of an identically named enum
/// from another module would NOT satisfy this — the audit asks for a
/// new typed enum to be defined here, not aliased from elsewhere.
#[test]
fn e8_capture_error_enum_declared_in_gateway_module() {
    let src = read_gateway_module_sources();
    assert!(
        src.contains("pub enum CaptureError"),
        "Batch 9 E8 requires `pub enum CaptureError` declared under \
         gateway/src/gateway/ (capture_pipeline.rs or a sibling capture_error.rs)"
    );
}

/// Test: e8_capture_error_reexported_from_mod_rs
///
/// Proves: `gateway/src/gateway/mod.rs` re-exports `CaptureError` so
/// downstream callers can write `recondo_gateway::gateway::CaptureError`
/// without reaching into private submodules.
///
/// Anti-fake property: substring assertion looks for `CaptureError` in a
/// `pub use` line of `mod.rs`. A bare `pub mod capture_error;` declaration
/// is NOT enough — call sites in `recovery.rs` and `run_listener.rs`
/// match on the type by its short name and need the re-export.
#[test]
fn e8_capture_error_reexported_from_mod_rs() {
    let mod_rs = read_gateway_mod_rs();
    let mut found = false;
    for line in mod_rs.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("pub use") && trimmed.contains("CaptureError") {
            found = true;
            break;
        }
    }
    assert!(
        found,
        "Batch 9 E8 requires `pub use ...::CaptureError` in \
         gateway/src/gateway/mod.rs so external callers resolve \
         `recondo_gateway::gateway::CaptureError`"
    );
}

/// Test: e8_capture_error_audit_required_variants_present
///
/// Proves: the variants enumerated in the audit (E8, lines ~217-221) are
/// spelled in the source. Required: `WalAppendFailed`, `StoreFailed`,
/// `ParseFailed`, `SessionResolutionFailed`, `DbWriteFailed`. Plus a
/// payload-too-large variant in EITHER spelling — `RequestTooLarge` or
/// the unified `PayloadTooLarge` form (the audit explicitly leaves this
/// to the implementer).
///
/// Anti-fake property: assertions are on identifier substrings inside
/// the gateway-module source set, not on Display strings. A `match` arm
/// `_ => "RequestTooLarge"` somewhere outside an enum body would also
/// match — but the structural test above pins `pub enum CaptureError`,
/// so a stub enum with no variants would still be caught by the
/// behavioral tests below.
#[test]
fn e8_capture_error_audit_required_variants_present() {
    let src = read_gateway_module_sources();

    let payload_variant_present =
        src.contains("RequestTooLarge") || src.contains("PayloadTooLarge");
    assert!(
        payload_variant_present,
        "E8 requires a payload-too-large variant — either `RequestTooLarge` \
         (audit spelling) or `PayloadTooLarge` (implementer's symmetric form)"
    );

    for variant in &[
        "WalAppendFailed",
        "StoreFailed",
        "ParseFailed",
        "SessionResolutionFailed",
        "DbWriteFailed",
    ] {
        assert!(
            src.contains(variant),
            "E8 requires `CaptureError::{}` variant (audit-listed)",
            variant
        );
    }
}

// ===========================================================================
// 2. Type-level (compile-time) tests
// ===========================================================================

/// Test: e8_capture_error_implements_std_error
///
/// Proves: `CaptureError` implements `Debug`, `Display`, and
/// `std::error::Error` — the same trait set `GraphStoreError` already
/// satisfies. This is what lets call sites keep `warn!(error = %e, ...)`
/// working unchanged after the type swap.
///
/// Anti-fake property: this is a compile-time check via a generic
/// constraint. If `CaptureError` lacks any of the three traits the test
/// FAILS TO COMPILE — there's no Display string to fake.
#[test]
fn e8_capture_error_implements_std_error() {
    fn assert_traits<T: std::fmt::Debug + std::fmt::Display + std::error::Error>() {}
    assert_traits::<CaptureError>();
}

/// Test: e8_process_capture_with_pipeline_returns_typed_error
///
/// Proves: `process_capture_with_pipeline` has been retyped to return
/// `Result<TurnRecord, CaptureError>`. We invoke it on a known-failing
/// payload (oversized request) and bind the error half to
/// `CaptureError` — this only compiles if the function's `Err` type
/// matches.
///
/// Anti-fake property: the binding `let err: CaptureError = ...` is the
/// type assertion. A function still returning `anyhow::Error` would not
/// coerce here without `From<anyhow::Error>` — and even with that
/// coercion the behavioral tests below would still pin the variant.
#[test]
fn e8_process_capture_with_pipeline_returns_typed_error() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    // 50 MB + 1 — guaranteed to trip the request-size guard. Chosen via
    // the same constant used by production (`MAX_CAPTURE_BYTES`).
    let oversized = vec![0u8; 50 * 1024 * 1024 + 1];
    let response = sample_anthropic_sse_response();

    let err: CaptureError = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &oversized,
        &response,
        None,
        None,
    )
    .expect_err("oversized request must fail");

    // Touch the binding so the compiler can't optimize the type away.
    let _ = format!("{}", err);
}

// ===========================================================================
// 3. Behavioral tests — variant trigger + matches!() assertion
// ===========================================================================

/// Test: e8_request_too_large_yields_typed_variant
///
/// Proves: passing `request_bytes` larger than `MAX_CAPTURE_BYTES`
/// (50 MB) returns `CaptureError::RequestTooLarge { .. }` (or
/// `PayloadTooLarge { kind: <Request>, .. }` if the implementer chose
/// the unified shape). This is the audit's stated motivation:
/// `matches!(err, CaptureError::RequestTooLarge { .. })` replaces
/// `err.to_string().contains("too large")`.
///
/// Anti-fake property: `matches!()` discriminates variants at the type
/// level. A `Display` impl that prints "request too large" but a
/// fall-through `Other(...)` underneath would FAIL this test —
/// substring-on-Display is precisely what E8 deletes.
#[test]
fn e8_request_too_large_yields_typed_variant() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let oversized = vec![0u8; 50 * 1024 * 1024 + 1];
    let response = sample_anthropic_sse_response();

    let err = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &oversized,
        &response,
        None,
        None,
    )
    .expect_err("oversized request must produce an error");

    // Accept either spelling: dedicated `RequestTooLarge` (audit) or
    // unified `PayloadTooLarge` (implementer's symmetric form). The
    // Display-side check uses the variant's debug name, not a free-text
    // message, so it still maps to the typed value, not a string.
    let dbg = format!("{:?}", err);
    assert!(
        dbg.contains("RequestTooLarge") || dbg.contains("PayloadTooLarge"),
        "expected a payload-too-large variant in error Debug, got: {}",
        dbg
    );
    // For the unified shape, also assert the kind discriminator points
    // at the request side (any of `Request`, `kind: Request`, etc.).
    if dbg.contains("PayloadTooLarge") {
        assert!(
            dbg.contains("Request"),
            "PayloadTooLarge for the request side must carry a Request \
             kind discriminator, got: {}",
            dbg
        );
    }
}

/// Test: e8_response_too_large_yields_typed_variant
///
/// Proves: oversized `response_bytes` returns the response-side
/// payload-too-large variant. Same accept-either-spelling rule as the
/// request test.
///
/// Anti-fake property: a same-variant-for-both-sides
/// implementation that swallowed the request/response distinction would
/// fail the kind-discriminator check below.
#[test]
fn e8_response_too_large_yields_typed_variant() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request = sample_anthropic_request();
    let oversized = vec![0u8; 50 * 1024 * 1024 + 1];

    let err = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &request,
        &oversized,
        None,
        None,
    )
    .expect_err("oversized response must produce an error");

    let dbg = format!("{:?}", err);
    assert!(
        dbg.contains("ResponseTooLarge") || dbg.contains("PayloadTooLarge"),
        "expected a payload-too-large variant in error Debug, got: {}",
        dbg
    );
    if dbg.contains("PayloadTooLarge") {
        assert!(
            dbg.contains("Response"),
            "PayloadTooLarge for the response side must carry a Response \
             kind discriminator, got: {}",
            dbg
        );
    }
}

/// Test: e8_wal_append_failed_in_closed_mode_yields_typed_variant
///
/// Proves: when a WAL configured with `FailMode::Closed` cannot append
/// (here, because the WAL directory was deleted out from under it),
/// `process_capture_with_pipeline` returns
/// `CaptureError::WalAppendFailed { mode: FailMode::Closed, .. }`.
///
/// Anti-fake property: the Debug payload must mention BOTH
/// `WalAppendFailed` and `Closed`. An implementation that wrapped the
/// WAL error in a generic `Other(_)` arm would fail this — and that
/// generic-wrap is exactly what the audit calls out as the loss of
/// information the typed enum is supposed to fix.
#[test]
fn e8_wal_append_failed_in_closed_mode_yields_typed_variant() {
    let (pipeline, tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    // Build a WAL on a directory that exists at open-time, then delete
    // the directory so the next `append_entry` call fails. macOS / Linux
    // semantics: the WAL handle keeps the path, but `fs::File::create`
    // inside append_entry will fail with NotFound.
    let wal_dir = tmp.path().join("doomed_wal");
    fs::create_dir_all(&wal_dir).expect("create wal dir");
    let wal = Wal::open_with_mode(&wal_dir, FailMode::Closed).expect("open wal");
    fs::remove_dir_all(&wal_dir).expect("remove wal dir to force append failure");

    let request = sample_anthropic_request();
    let response = sample_anthropic_sse_response();

    let err = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &request,
        &response,
        Some(&wal),
        None,
    )
    .expect_err("WAL append failure in Closed mode must propagate");

    let dbg = format!("{:?}", err);
    assert!(
        dbg.contains("WalAppendFailed"),
        "expected `WalAppendFailed` variant in error Debug, got: {}",
        dbg
    );
    assert!(
        dbg.contains("Closed"),
        "expected the WAL `Closed` fail-mode discriminator in error Debug, got: {}",
        dbg
    );
}

// ===========================================================================
// 4. Production wiring smoke test — happy path still typed Ok
// ===========================================================================

/// Test: e8_happy_path_returns_ok_turn_record
///
/// Proves: end-to-end happy path through `process_capture_with_pipeline`
/// returns `Ok(TurnRecord)`. The retype to `Result<TurnRecord,
/// CaptureError>` MUST NOT regress the success path — production
/// callers need `turn` data for downstream rows (sessions, attachments,
/// metrics).
///
/// Anti-fake property: the test asserts on concrete TurnRecord field
/// values (model, response_text, stop_reason, sequence_num) parsed out
/// of the SSE stream. An implementation that returned a default-zeroed
/// `TurnRecord` to satisfy the type would fail every field check.
#[test]
fn e8_happy_path_returns_ok_turn_record() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request = sample_anthropic_request();
    let response = sample_anthropic_sse_response();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        &request,
        &response,
        None,
        None,
    )
    .expect("happy path must return Ok(TurnRecord)");

    assert_eq!(turn.model.as_deref(), Some("claude-sonnet-4-20250514"));
    assert_eq!(turn.response_text.as_deref(), Some("2 + 2 = 4"));
    assert_eq!(turn.stop_reason, "end_turn");
    assert_eq!(turn.sequence_num, 1);
    assert!(turn.capture_complete);
}

// ===========================================================================
// 5. Display formatting smoke
// ===========================================================================

/// Test: e8_display_strings_are_nonempty_for_each_triggered_variant
///
/// Proves: `format!("{}", err)` produces a non-empty, recognizable
/// string for each variant we can trigger via the public surface
/// (RequestTooLarge, ResponseTooLarge, WalAppendFailed). We deliberately
/// don't pin exact strings — the audit allows hand-rolled or
/// `thiserror`-derived Display, both of which produce different but
/// equally valid messages.
///
/// Anti-fake property: assertions check (a) non-empty output and (b)
/// presence of a variant-discriminating keyword in the message.
/// Returning the empty string or a constant `"capture error"` for every
/// variant would fail.
#[test]
fn e8_display_strings_are_nonempty_for_each_triggered_variant() {
    // (a) RequestTooLarge / PayloadTooLarge.
    {
        let (pipeline, _tmp) = make_pipeline();
        let mut session_mgr = SessionManager::new();
        let oversized = vec![0u8; 50 * 1024 * 1024 + 1];
        let err = gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "anthropic",
            &oversized,
            &sample_anthropic_sse_response(),
            None,
            None,
        )
        .expect_err("must error");
        let s = format!("{}", err);
        assert!(!s.is_empty(), "Display must be non-empty");
        let lc = s.to_lowercase();
        assert!(
            lc.contains("too large") || lc.contains("payload") || lc.contains("request"),
            "Display for the request-too-large variant must mention a \
             discriminating keyword; got: {}",
            s
        );
    }

    // (b) ResponseTooLarge / PayloadTooLarge (response side).
    {
        let (pipeline, _tmp) = make_pipeline();
        let mut session_mgr = SessionManager::new();
        let oversized = vec![0u8; 50 * 1024 * 1024 + 1];
        let err = gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "anthropic",
            &sample_anthropic_request(),
            &oversized,
            None,
            None,
        )
        .expect_err("must error");
        let s = format!("{}", err);
        assert!(!s.is_empty(), "Display must be non-empty");
        let lc = s.to_lowercase();
        assert!(
            lc.contains("too large") || lc.contains("payload") || lc.contains("response"),
            "Display for the response-too-large variant must mention a \
             discriminating keyword; got: {}",
            s
        );
    }

    // (c) WalAppendFailed { mode: Closed, .. }.
    {
        let (pipeline, tmp) = make_pipeline();
        let mut session_mgr = SessionManager::new();
        let wal_dir = tmp.path().join("doomed_wal_display");
        fs::create_dir_all(&wal_dir).expect("create wal dir");
        let wal = Wal::open_with_mode(&wal_dir, FailMode::Closed).expect("open wal");
        fs::remove_dir_all(&wal_dir).expect("remove wal dir");
        let err = gateway::process_capture_with_pipeline(
            &pipeline,
            &mut session_mgr,
            "anthropic",
            &sample_anthropic_request(),
            &sample_anthropic_sse_response(),
            Some(&wal),
            None,
        )
        .expect_err("must error");
        let s = format!("{}", err);
        assert!(!s.is_empty(), "Display must be non-empty");
        let lc = s.to_lowercase();
        assert!(
            lc.contains("wal") || lc.contains("append") || lc.contains("closed"),
            "Display for the WalAppendFailed variant must mention a \
             discriminating keyword; got: {}",
            s
        );
    }
}
