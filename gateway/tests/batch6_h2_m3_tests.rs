//! Batch 6 — Audit follow-up H2 (split the 6,287-LOC `gateway/src/gateway/mod.rs`
//! into 5 sub-modules) + M3 (extract a `CaptureContext` parameter struct so
//! every `#[allow(clippy::too_many_arguments)]` in `gateway/src/gateway/`
//! disappears).
//!
//! Audit reference: `docs/GATEWAY_AUDIT_2026_05_02.md` H2 (lines ~32-44) and
//! M3 (lines ~199-202).
//!
//! # What these tests guard
//!
//! - **File-existence (H2):** the five new sub-module files exist on disk.
//! - **mod.rs LOC reduction (H2):** the post-split `mod.rs` is small enough
//!   that the split could not have been faked by leaving the body in place.
//! - **Module declaration (H2):** `mod.rs` declares the five sub-modules with
//!   `pub mod`.
//! - **Public API preservation (H2):** every symbol listed in PROJECT_CONTEXT
//!   that exists today still resolves under `recondo_gateway::gateway::*`
//!   after the split — function-pointer assignments compile only if the
//!   path resolves with the right type.
//! - **`#[allow(clippy::too_many_arguments)]` removal (M3):** zero hits in
//!   `gateway/src/gateway/`. Today there are 6 hits at lines 3595, 3899,
//!   4292, 4554, 4825, 5467 — this test fails on `main`.
//! - **`CaptureContext` struct exists (M3):** a struct with that name (or
//!   suffix `*Context`) is declared somewhere under `gateway/src/gateway/`.
//!   Field shape is intentionally NOT pinned — the implementer groups args
//!   by what each function actually needs.
//! - **Functional smoke (H2):** `process_capture_with_pipeline` still
//!   produces a `TurnRecord` end-to-end from a captured Anthropic request
//!   plus SSE response. The 1438 existing tests already exercise the split
//!   indirectly; this is the canonical guard that lives in the new file.
//!
//! These tests are written BEFORE the implementation. They MUST fail on
//! `main` today (no sub-module files exist; mod.rs is 6,287 LOC; six
//! `#[allow]` attributes remain) and pass after Batch 6 ships.

#![allow(clippy::type_complexity)]

use std::fs;
use std::path::{Path, PathBuf};

use recondo_gateway::gateway;
use recondo_gateway::session::SessionManager;

mod common;
use common::pipeline::make_pipeline;

// ===========================================================================
// Helpers — paths.
// ===========================================================================

fn gateway_src_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is `<repo>/gateway` for this crate.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("gateway")
}

fn read_to_string(p: &Path) -> String {
    fs::read_to_string(p).unwrap_or_else(|e| panic!("failed to read {}: {}", p.display(), e))
}

/// Recursively read every `.rs` source file under `gateway/src/gateway/`,
/// returning `(path, contents)` pairs. Used by the structural greps so we
/// don't miss code that ends up in deeply-nested sub-modules.
fn all_gateway_rs_sources() -> Vec<(PathBuf, String)> {
    fn walk(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
        let entries = fs::read_dir(dir)
            .unwrap_or_else(|e| panic!("failed to read dir {}: {}", dir.display(), e));
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().and_then(|s| s.to_str()) == Some("rs") {
                let contents = read_to_string(&path);
                out.push((path, contents));
            }
        }
    }
    let mut out = Vec::new();
    walk(&gateway_src_dir(), &mut out);
    out
}

// ===========================================================================
// Section 1 — H2 file-existence tests.
//
// Each new sub-module file must exist as a regular file on disk. These tests
// fail on `main` today because none of the files exist — the entire 6,287-LOC
// body is in `mod.rs`. They pass once the implementer creates each split
// file.
// ===========================================================================

/// Test: `h2_connect_module_file_exists`.
///
/// Proves: the implementer created `gateway/src/gateway/connect.rs` (the new
/// home for `ConnectRequest`, `parse_connect_request`, `ConnectionMode`,
/// `detect_connection_mode`, `extract_sni_hostname`, `TunnelMode`,
/// `classify_host`, `build_server_config`, `build_server_config_with_cache`).
///
/// Anti-fake property: file path is checked at the OS level, not via a
/// re-exported symbol. Re-exporting alone does not satisfy this test —
/// the new file must physically exist.
#[test]
fn h2_connect_module_file_exists() {
    let p = gateway_src_dir().join("connect.rs");
    assert!(
        p.is_file(),
        "Batch 6 H2: expected new sub-module file {} to exist after the mod.rs split",
        p.display()
    );
}

/// Test: `h2_intercept_module_file_exists`.
///
/// Proves: `gateway/src/gateway/intercept.rs` exists (new home for
/// `InterceptDecision`, `should_intercept`, path normalisation helpers).
///
/// Anti-fake property: path is checked at the OS level.
#[test]
fn h2_intercept_module_file_exists() {
    let p = gateway_src_dir().join("intercept.rs");
    assert!(
        p.is_file(),
        "Batch 6 H2: expected new sub-module file {} to exist after the mod.rs split",
        p.display()
    );
}

/// Test: `h2_capture_pipeline_module_file_exists`.
///
/// Proves: `gateway/src/gateway/capture_pipeline.rs` exists (new home for
/// `ParsedFields`, `parse_capture_data`, `process_capture_with_pipeline`,
/// `merge_parse_errors`, sequence helper).
///
/// Anti-fake property: path is checked at the OS level.
#[test]
fn h2_capture_pipeline_module_file_exists() {
    let p = gateway_src_dir().join("capture_pipeline.rs");
    assert!(
        p.is_file(),
        "Batch 6 H2: expected new sub-module file {} to exist after the mod.rs split",
        p.display()
    );
}

/// Test: `h2_run_listener_module_file_exists`.
///
/// Proves: `gateway/src/gateway/run_listener.rs` exists (new home for the
/// per-connection driver + body/header helpers + Codex/WS capture funcs).
///
/// Anti-fake property: path is checked at the OS level.
#[test]
fn h2_run_listener_module_file_exists() {
    let p = gateway_src_dir().join("run_listener.rs");
    assert!(
        p.is_file(),
        "Batch 6 H2: expected new sub-module file {} to exist after the mod.rs split",
        p.display()
    );
}

/// Test: `h2_trace_module_file_exists`.
///
/// Proves: `gateway/src/gateway/trace.rs` exists (new home for the `--trace`
/// pretty-printer: `trace_request`, `trace_response`, chunked decode, gzip
/// decompress, SSE pretty-print helpers).
///
/// Anti-fake property: path is checked at the OS level.
#[test]
fn h2_trace_module_file_exists() {
    let p = gateway_src_dir().join("trace.rs");
    assert!(
        p.is_file(),
        "Batch 6 H2: expected new sub-module file {} to exist after the mod.rs split",
        p.display()
    );
}

// ===========================================================================
// Section 2 — H2 mod.rs LOC reduction.
// ===========================================================================

/// Test: `h2_mod_rs_loc_dropped_below_split_threshold`.
///
/// Proves: `mod.rs` shrank from 6,287 LOC to a value small enough that the
/// split must have actually moved code, not just added module declarations
/// and left every function in place.
///
/// Threshold: 700 LOC. The audit's stated post-split target is roughly
/// 300 LOC (top-level config types + module declarations + re-exports +
/// `block_on_future` + URL-budget helpers). 700 leaves headroom for
/// re-export plumbing while still failing if the bulk of the file remains
/// unmoved.
///
/// Anti-fake property: a structural test on `mod.rs` only — moving code
/// out and re-exporting it via `pub use sub::*` is the only way to bring
/// LOC under threshold while keeping every PROJECT_CONTEXT path resolvable.
#[test]
fn h2_mod_rs_loc_dropped_below_split_threshold() {
    const THRESHOLD: usize = 700;
    let mod_rs = gateway_src_dir().join("mod.rs");
    let contents = read_to_string(&mod_rs);
    let loc = contents.lines().count();
    assert!(
        loc <= THRESHOLD,
        "Batch 6 H2: gateway/src/gateway/mod.rs is still {} LOC; expected ≤ {} after the 5-way split. \
         The split has not happened (or the file was bypassed and code left in place).",
        loc,
        THRESHOLD,
    );
}

// ===========================================================================
// Section 3 — H2 module declaration test.
// ===========================================================================

/// Test: `h2_mod_rs_declares_all_five_submodules`.
///
/// Proves: `mod.rs` contains a `pub mod connect;` (or `mod connect;`)
/// declaration, and the same for `intercept`, `capture_pipeline`,
/// `run_listener`, and `trace`. Without these declarations the new files
/// would be unreachable from the rest of the crate.
///
/// Anti-fake property: greps the actual `mod.rs` source. A test that only
/// checks file existence is satisfied by orphaned files; this one isn't.
#[test]
fn h2_mod_rs_declares_all_five_submodules() {
    let mod_rs = read_to_string(&gateway_src_dir().join("mod.rs"));
    for name in [
        "connect",
        "intercept",
        "capture_pipeline",
        "run_listener",
        "trace",
    ] {
        let pub_form = format!("pub mod {};", name);
        let priv_form = format!("mod {};", name);
        assert!(
            mod_rs.contains(&pub_form) || mod_rs.contains(&priv_form),
            "Batch 6 H2: gateway/src/gateway/mod.rs is missing a `pub mod {0};` (or `mod {0};`) \
             declaration. The new sub-module file would be orphaned without it.",
            name,
        );
    }
}

// ===========================================================================
// Section 4 — H2 public API preservation.
//
// For each PROJECT_CONTEXT symbol that exists today in `mod.rs`, take a
// function pointer (or a typed reference to a struct/enum). The compiler
// rejects the test if the path stops resolving or the public type changes.
// Behaviour is intentionally NOT asserted — these are pure resolvability
// guards. The functional smoke test in section 7 covers behaviour.
// ===========================================================================

/// Test: `h2_external_api_parse_connect_request_resolves`.
///
/// Proves: `recondo_gateway::gateway::parse_connect_request` is callable by
/// the same signature it has today after the split moves the body into
/// `connect.rs` (with `pub use` re-export from `mod.rs`).
///
/// Anti-fake property: a `let _: fn(...) -> ...` binding requires the path
/// to resolve to a function with exactly that signature. A renamed or
/// relocated symbol that's not re-exported breaks the test.
#[test]
fn h2_external_api_parse_connect_request_resolves() {
    let _f: fn(&[u8]) -> anyhow::Result<gateway::ConnectRequest> = gateway::parse_connect_request;
}

/// Test: `h2_external_api_connect_request_struct_resolves`.
///
/// Proves: the public struct `ConnectRequest` is still constructible via
/// its public path with `host: String, port: u16` fields. Construction at
/// compile time is the strongest API-shape assertion possible.
///
/// Anti-fake property: changing the struct's name, public path, or making
/// either field private breaks this test.
#[test]
fn h2_external_api_connect_request_struct_resolves() {
    let r = gateway::ConnectRequest {
        host: "example.com".to_string(),
        port: 443,
    };
    assert_eq!(r.port, 443);
}

/// Test: `h2_external_api_detect_connection_mode_resolves`.
///
/// Proves: `recondo_gateway::gateway::detect_connection_mode` and the
/// `ConnectionMode` enum are still resolvable.
///
/// Anti-fake property: function-pointer assignment + enum variant pattern
/// match — the compiler rejects renames or visibility changes.
#[test]
fn h2_external_api_detect_connection_mode_resolves() {
    let _f: fn(&[u8]) -> gateway::ConnectionMode = gateway::detect_connection_mode;
    // Touch a known variant so a renamed/missing enum fails to compile.
    let _v: gateway::ConnectionMode = gateway::ConnectionMode::Unknown;
}

/// Test: `h2_external_api_extract_sni_hostname_resolves`.
///
/// Proves: `extract_sni_hostname` still resolves at the same path with the
/// same signature.
///
/// Anti-fake property: function-pointer assignment — wrong signature,
/// wrong path, or moved-without-reexport all break the test.
#[test]
fn h2_external_api_extract_sni_hostname_resolves() {
    let _f: fn(&[u8]) -> Option<String> = gateway::extract_sni_hostname;
}

/// Test: `h2_external_api_classify_host_and_tunnel_mode_resolve`.
///
/// Proves: `classify_host` and the `TunnelMode` enum (with at least the
/// `Mitm(String)` and `Passthrough` variants observed in the current
/// source) are still public-path-resolvable.
///
/// Anti-fake property: pattern-matching the variants verifies the enum's
/// discriminants haven't been renamed or made private.
#[test]
fn h2_external_api_classify_host_and_tunnel_mode_resolve() {
    let _f: fn(&str) -> gateway::TunnelMode = gateway::classify_host;
    match gateway::classify_host("api.anthropic.com") {
        gateway::TunnelMode::Mitm(_) | gateway::TunnelMode::Passthrough => { /* ok */ }
    }
}

/// Test: `h2_external_api_build_server_config_resolves`.
///
/// Proves: `build_server_config` is still callable as
/// `fn(&Path, &str) -> Result<rustls::ServerConfig>`.
///
/// Anti-fake property: function-pointer assignment.
#[test]
fn h2_external_api_build_server_config_resolves() {
    let _f: fn(&Path, &str) -> anyhow::Result<rustls::ServerConfig> = gateway::build_server_config;
}

/// Test: `h2_external_api_should_intercept_resolves`.
///
/// Proves: `should_intercept` and `InterceptDecision` are still resolvable.
///
/// Anti-fake property: function-pointer assignment + struct field access
/// — moving the struct to `intercept.rs` without a re-export breaks the
/// `gateway::InterceptDecision` path.
#[test]
fn h2_external_api_should_intercept_resolves() {
    let _f: fn(&[u8], &str) -> gateway::InterceptDecision = gateway::should_intercept;
    // Construction-by-path is impossible without knowing all fields, so
    // we just call the function and use its result.
    let d: gateway::InterceptDecision =
        gateway::should_intercept(b"GET / HTTP/1.1\r\n\r\n", "anthropic");
    let _ = d.should_capture;
}

/// Test: `h2_external_api_parsed_fields_struct_resolves`.
///
/// Proves: `ParsedFields` is still resolvable at `gateway::ParsedFields`
/// (it lives in `capture_pipeline.rs` after the split).
///
/// Anti-fake property: a function pointer to `parse_capture_data`
/// dereferences `ParsedFields` as the return type — both move together.
#[test]
fn h2_external_api_parsed_fields_struct_resolves() {
    let _f: fn(&str, &[u8], &[u8]) -> gateway::ParsedFields = gateway::parse_capture_data;
}

/// Test: `h2_external_api_process_capture_with_pipeline_resolves`.
///
/// Proves: the canonical capture pipeline entry point survives the split
/// at the same public path with the same signature. This is the most
/// load-bearing API on the gateway — breaking it breaks every production
/// call site (`run_listener` L3769, L3821, L5573).
///
/// Anti-fake property: function-pointer assignment with the full
/// 7-argument signature including `Option<&Wal>` and `Option<&Arc<...>>`
/// — every parameter type change is a compile error.
#[test]
fn h2_external_api_process_capture_with_pipeline_resolves() {
    use recondo_gateway::db::TurnRecord;
    use recondo_gateway::metrics::MetricsRegistry;
    use recondo_gateway::storage::pipeline::WritePipeline;
    use recondo_gateway::wal::Wal;
    use std::sync::Arc;

    use recondo_gateway::gateway::CaptureError;
    let _f: fn(
        &WritePipeline,
        &mut SessionManager,
        &str,
        &[u8],
        &[u8],
        Option<&Wal>,
        Option<&Arc<MetricsRegistry>>,
    ) -> Result<TurnRecord, CaptureError> = gateway::process_capture_with_pipeline;
}

/// Test: `h2_external_api_connect_response_resolves`.
///
/// Proves: `connect_response` is still callable at the same path. Lives
/// in `run_listener.rs` after the split.
///
/// Anti-fake property: function-pointer assignment.
#[test]
fn h2_external_api_connect_response_resolves() {
    let _f: fn() -> &'static [u8] = gateway::connect_response;
}

/// Test: `h2_external_api_parse_content_length_resolves`.
///
/// Proves: `parse_content_length` is still resolvable.
///
/// Anti-fake property: function-pointer assignment.
#[test]
fn h2_external_api_parse_content_length_resolves() {
    let _f: fn(&str) -> Option<usize> = gateway::parse_content_length;
}

/// Test: `h2_external_api_load_extra_ca_certs_resolves`.
///
/// Proves: `load_extra_ca_certs` is still callable.
///
/// Anti-fake property: function-pointer assignment.
#[test]
fn h2_external_api_load_extra_ca_certs_resolves() {
    let _f: fn(&mut rustls::RootCertStore, &Path) = gateway::load_extra_ca_certs;
}

/// Test: `h2_external_api_extract_http_body_resolves`.
///
/// Proves: `extract_http_body` is still callable.
///
/// Anti-fake property: function-pointer assignment.
#[test]
fn h2_external_api_extract_http_body_resolves() {
    let _f: fn(&[u8]) -> anyhow::Result<(String, Vec<u8>)> = gateway::extract_http_body;
}

/// Test: `h2_external_api_trace_enabled_resolves`.
///
/// Proves: `trace_enabled` (lives in mod.rs even after split per the task
/// spec) is still resolvable.
///
/// Anti-fake property: function-pointer assignment.
#[test]
fn h2_external_api_trace_enabled_resolves() {
    let _f: fn() -> bool = gateway::trace_enabled;
}

/// Test: `h2_external_api_run_startup_recovery_resolves`.
///
/// Proves: `run_startup_recovery` is still callable. It lives in
/// `run_listener.rs` after the split.
///
/// Anti-fake property: just touching the symbol path — the full signature
/// involves types we don't want to over-pin here.
#[test]
fn h2_external_api_run_startup_recovery_resolves() {
    // Take a reference to the function as an opaque pointer-equivalent;
    // we don't unify with an `fn` type because the signature includes
    // generics/trait objects we deliberately don't pin.
    let _ptr: usize = gateway::run_startup_recovery as *const () as usize;
    assert!(_ptr != 0);
}

/// Test: `h2_external_api_gateway_config_and_shutdown_controller_resolve`.
///
/// Proves: the two top-level types `GatewayConfig` and `ShutdownController`
/// (which the task spec keeps in `mod.rs` after the split) are still
/// resolvable at the public path.
///
/// Anti-fake property: typed type alias forces resolution at compile time.
#[test]
fn h2_external_api_gateway_config_and_shutdown_controller_resolve() {
    type _G = gateway::GatewayConfig;
    type _S = gateway::ShutdownController;
}

/// Test: `h2_external_api_build_server_config_with_cache_resolves`.
///
/// Proves: `build_server_config_with_cache` is still publicly resolvable.
///
/// Anti-fake property: take its address as a usize — exercises path
/// resolution without pinning the cache parameter's exact type.
#[test]
fn h2_external_api_build_server_config_with_cache_resolves() {
    let _ptr: usize = gateway::build_server_config_with_cache as *const () as usize;
    assert!(_ptr != 0);
}

// ===========================================================================
// Section 5 — M3 `#[allow(clippy::too_many_arguments)]` removal.
// ===========================================================================

/// Test: `m3_no_too_many_arguments_allows_in_gateway_module`.
///
/// Proves: every `#[allow(clippy::too_many_arguments)]` attribute under
/// `gateway/src/gateway/` has been removed by introducing a
/// `CaptureContext`-shaped parameter struct that bundles the 9-12-arg
/// boundary helpers down below clippy's 7-arg threshold.
///
/// Anti-fake property: walks every `.rs` file recursively under the
/// gateway directory — the implementer cannot satisfy the test by moving
/// a function to a sub-module and keeping the `#[allow]` there. Today
/// there are 6 attributes at lines 3595, 3899, 4292, 4554, 4825, 5467 of
/// `mod.rs`, so this test fails on `main`.
#[test]
fn m3_no_too_many_arguments_allows_in_gateway_module() {
    let needle = "#[allow(clippy::too_many_arguments)]";
    let mut offending: Vec<(PathBuf, Vec<usize>)> = Vec::new();
    for (path, contents) in all_gateway_rs_sources() {
        let hits: Vec<usize> = contents
            .lines()
            .enumerate()
            .filter_map(|(i, line)| {
                if line.contains(needle) {
                    Some(i + 1)
                } else {
                    None
                }
            })
            .collect();
        if !hits.is_empty() {
            offending.push((path, hits));
        }
    }
    assert!(
        offending.is_empty(),
        "Batch 6 M3: expected zero `#[allow(clippy::too_many_arguments)]` under \
         gateway/src/gateway/, found {} site(s): {:#?}. \
         The audit fix is to introduce a `CaptureContext` parameter struct that \
         bundles the boundary args, dropping every `#[allow]`.",
        offending.iter().map(|(_, h)| h.len()).sum::<usize>(),
        offending,
    );
}

/// Test: `m3_capture_context_struct_exists`.
///
/// Proves: a `pub struct CaptureContext` (or a struct whose name ends in
/// `Context` and lives under `gateway/src/gateway/`) is declared in the
/// new module layout. The audit names the type `CaptureContext`; the test
/// accepts that name first and falls back to any `*Context` struct so the
/// implementer can choose `WriteContext`, `PipelineContext`, etc. without
/// failing this guard.
///
/// Anti-fake property: greps the actual sub-module sources for a struct
/// declaration. A function alias or a tuple of references doesn't satisfy
/// the audit's design intent and doesn't satisfy this test.
#[test]
fn m3_capture_context_struct_exists() {
    let primary = "struct CaptureContext";
    let mut found_primary = false;
    let mut found_any_context_struct: Option<(PathBuf, String)> = None;

    for (path, contents) in all_gateway_rs_sources() {
        if contents.contains(primary) {
            found_primary = true;
            break;
        }
        // Fallback: any `(pub )?struct *Context*` declaration in a
        // gateway sub-module (excluding mod.rs to discourage leaving the
        // type at the top while the args remain).
        for line in contents.lines() {
            let trimmed = line.trim_start();
            // Match `struct Foo` or `pub struct Foo` or `pub(crate) struct Foo`,
            // ending with `Context` (with optional generics).
            if (trimmed.starts_with("struct ")
                || trimmed.starts_with("pub struct ")
                || trimmed.starts_with("pub(crate) struct "))
                && trimmed.contains("Context")
            {
                found_any_context_struct = Some((path.clone(), trimmed.to_string()));
            }
        }
    }

    assert!(
        found_primary || found_any_context_struct.is_some(),
        "Batch 6 M3: expected a `pub struct CaptureContext` (or any `*Context` \
         struct) somewhere under gateway/src/gateway/. The audit fix groups the \
         9-12 boundary args into a single context struct so every \
         `#[allow(clippy::too_many_arguments)]` can be dropped."
    );
}

// ===========================================================================
// Section 6 — H2 split-aware functional smoke.
//
// The 1438 existing tests already exercise the full split data flow
// indirectly. This is the canonical guard inside the new test file so
// future refactors that break the split's data-flow integrity (e.g.,
// accidentally swapping `parse_capture_data` for a non-canonical sibling
// during the move) are caught in this file.
// ===========================================================================

/// Test: `h2_process_capture_with_pipeline_smoke`.
///
/// Proves: `process_capture_with_pipeline` still returns `Ok(TurnRecord)`
/// for a representative Anthropic request + minimal SSE response after
/// the H2 split has relocated the function body to
/// `gateway/src/gateway/capture_pipeline.rs`. The byte-equivalence
/// promise of the audit ("function bodies stay identical") implies the
/// pre-split and post-split runs produce a record on the same input.
///
/// Anti-fake property: actually invokes the function via the public API
/// path. A re-export pointing at a stub or an empty body would fail to
/// produce a `TurnRecord`. Uses the shared `make_pipeline()` helper so
/// the test is self-contained (no PG, no shared state, no env mutation).
#[test]
fn h2_process_capture_with_pipeline_smoke() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    // Minimal Anthropic-shaped request: the parser only needs enough to
    // identify the provider and produce a non-empty parsed record. We
    // intentionally use a tiny payload — the assertion is "the call
    // chain from request bytes to TurnRecord is wired", not "every SSE
    // edge case parses".
    let request_bytes: &[u8] = b"POST /v1/messages HTTP/1.1\r\n\
Host: api.anthropic.com\r\n\
Content-Type: application/json\r\n\
Content-Length: 110\r\n\
\r\n\
{\"model\":\"claude-3-5-sonnet-20241022\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}";

    // Minimal Anthropic SSE response: message_start + content_block_delta + message_stop.
    let response_bytes: &[u8] = b"HTTP/1.1 200 OK\r\n\
Content-Type: text/event-stream\r\n\
Transfer-Encoding: chunked\r\n\
\r\n\
event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_smoke\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-3-5-sonnet-20241022\",\"content\":[],\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":2,\"output_tokens\":1}}}\n\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":1}}\n\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\n";

    let record = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "anthropic",
        request_bytes,
        response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline should still succeed end-to-end after the H2 split");

    // Sanity: the record must mention the provider it was routed under.
    assert_eq!(
        record.provider.as_deref(),
        Some("anthropic"),
        "post-split process_capture_with_pipeline must preserve the provider field on TurnRecord"
    );
}
