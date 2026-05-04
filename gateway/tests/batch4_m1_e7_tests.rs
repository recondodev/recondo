//! Batch 4 — Audit follow-up M1 (`parse_errors` policy on provider sites)
//! and E7 (skip documented intentional fallback for the `unknown part type`
//! error-message scaffolding).
//!
//! These tests prove that the implementer has refactored the 8
//! `unwrap_or_default()` sites in `gateway/src/providers/` along the lines
//! of `docs/GATEWAY_AUDIT_2026_05_02.md` sections M1 and E7:
//!
//! - **7 sites are converted** to log a parse-drift error into a per-call
//!   `parse_errors: Option<Vec<String>>` field on the parsed-data struct.
//!   The parser proceeds with an empty array / empty string fallback so
//!   captures are never lost on schema changes — but the caller gets
//!   visibility into the mismatch.
//! - **1 site is the documented E7 carve-out** at `google.rs:536`. That
//!   `unwrap_or_default()` is itself defensive scaffolding for an error
//!   message that already lands in `parse_errors_list`. It stays, with a
//!   comment documenting the carve-out.
//!
//! The tests are organised into:
//!   1. Source-level grep tests (count of `unwrap_or_default()` drops from
//!      8 → 1).
//!   2. Source-level structure tests (each parsed-data struct gains
//!      `parse_errors: Option<Vec<String>>`).
//!   3. Source-level carve-out tests (the surviving `unwrap_or_default()` at
//!      `google.rs:536` retains a comment that documents the E7 carve-out).
//!   4. Behavioural happy-path tests — well-formed inputs yield
//!      `parse_errors == None` (no false positives).
//!   5. Behavioural drift-detection tests — schema-mismatched inputs yield
//!      `parse_errors == Some(vec![...])` with at least one entry naming
//!      the drifted path.

use std::fs;
use std::path::PathBuf;

use recondo_gateway::providers::generic::{
    GenericAdapter, RequestMapping, ResponseMapping, YamlAdapterConfig,
};
use recondo_gateway::providers::google::{
    parse_gemini_cli_request, parse_gemini_request_from_value,
};

mod common;

// ===========================================================================
// Helpers — source paths (resolved at runtime so the greps work whether the
// tests run from the repo root, from inside `gateway/`, or from a worktree).
// ===========================================================================

fn providers_dir() -> PathBuf {
    let manifest = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest).join("src").join("providers")
}

fn google_source() -> String {
    let p = providers_dir().join("google.rs");
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("failed to read {}: {}", p.display(), e))
}

fn generic_source() -> String {
    let p = providers_dir().join("generic.rs");
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("failed to read {}: {}", p.display(), e))
}

fn mod_source() -> String {
    let p = providers_dir().join("mod.rs");
    fs::read_to_string(&p).unwrap_or_else(|e| panic!("failed to read {}: {}", p.display(), e))
}

/// Walk every `*.rs` file directly under `gateway/src/providers/` and return
/// `(path, contents)` pairs. Used by the source-level count tests.
fn provider_sources() -> Vec<(PathBuf, String)> {
    let dir = providers_dir();
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).expect("providers/ exists") {
        let entry = entry.expect("readable dir entry");
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            let contents = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e));
            out.push((path, contents));
        }
    }
    out
}

/// Count `unwrap_or_default(` occurrences across `gateway/src/providers/`,
/// returning a list of `(path, line_number, line)` for each hit.
fn unwrap_or_default_hits() -> Vec<(PathBuf, usize, String)> {
    let mut hits = Vec::new();
    for (path, src) in provider_sources() {
        for (i, line) in src.lines().enumerate() {
            if line.contains("unwrap_or_default(") {
                hits.push((path.clone(), i + 1, line.to_string()));
            }
        }
    }
    hits
}

// ===========================================================================
// 1. Source-level grep tests — `unwrap_or_default()` count drops 8 → 1
//
// These FAIL on `main` today (8 hits) and PASS after the fix lands (1 hit:
// the E7 carve-out at google.rs:536).
// ===========================================================================

/// **Proves:** After M1, `gateway/src/providers/` contains exactly ONE
/// `unwrap_or_default()` call — the documented E7 carve-out at
/// `google.rs:536`.
///
/// **Anti-fake property:** Today the grep finds 8 hits across `google.rs`
/// (3) and `generic.rs` (5). The implementer must convert 7 of them to
/// parse-drift logging and leave the 1 carve-out. A "fix" that masks the
/// pattern by aliasing `unwrap_or_default` would still be visible to this
/// grep because we match the literal substring.
#[test]
fn m1_unwrap_or_default_count_in_providers_is_exactly_one() {
    let hits = unwrap_or_default_hits();
    assert_eq!(
        hits.len(),
        1,
        "M1 + E7 require exactly 1 `unwrap_or_default(` call in \
         gateway/src/providers/ (the E7 carve-out at google.rs:536). \
         Found {} occurrences:\n{}",
        hits.len(),
        hits.iter()
            .map(|(p, n, l)| format!("  {}:{}: {}", p.display(), n, l.trim()))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// **Proves:** The single surviving `unwrap_or_default()` in
/// `gateway/src/providers/` lives in `google.rs`. Pairs with the
/// carve-out-line test below to lock the location.
///
/// **Anti-fake property:** A regression that pushes the carve-out into a
/// different file would pass the count test but fail this one.
#[test]
fn m1_surviving_unwrap_or_default_is_in_google_rs() {
    let hits = unwrap_or_default_hits();
    assert_eq!(
        hits.len(),
        1,
        "precondition: see m1_unwrap_or_default_count_in_providers_is_exactly_one"
    );
    let (path, _line, _content) = &hits[0];
    let filename = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    assert_eq!(
        filename,
        "google.rs",
        "the surviving unwrap_or_default must be the E7 carve-out in google.rs, found in {}",
        path.display()
    );
}

/// **Proves:** `generic.rs` no longer contains *any* `unwrap_or_default()`
/// calls. All 5 sites (lines 90, 98, 106, 143, 152 on `main`) must be
/// converted to parse-drift logging.
///
/// **Anti-fake property:** A partial fix that converts only the array sites
/// (143, 152) and leaves the scalar sites (90, 98, 106) would still pass
/// the global count check if combined with an over-aggressive removal in
/// `google.rs`. This file-scoped check makes that bait-and-switch
/// impossible.
#[test]
fn m1_generic_rs_has_zero_unwrap_or_default() {
    let src = generic_source();
    let hits: Vec<(usize, &str)> = src
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains("unwrap_or_default("))
        .map(|(i, line)| (i + 1, line))
        .collect();
    assert!(
        hits.is_empty(),
        "M1 requires all 5 `unwrap_or_default()` sites in \
         gateway/src/providers/generic.rs to be converted to parse-drift \
         logging. Found {} occurrences:\n{}",
        hits.len(),
        hits.iter()
            .map(|(n, l)| format!("  line {}: {}", n, l.trim()))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// **Proves:** `google.rs` retains only ONE `unwrap_or_default()` call
/// (the E7 carve-out). The two request-parser sites (lines 91 and 154 on
/// `main`) must be gone.
///
/// **Anti-fake property:** Same logic as the previous test, scoped to
/// `google.rs`. A stub that converts the response-parser carve-out and
/// leaves either of the request-parser sites in place would slip past
/// the global count.
#[test]
fn m1_google_rs_has_exactly_one_unwrap_or_default() {
    let src = google_source();
    let hits: Vec<(usize, &str)> = src
        .lines()
        .enumerate()
        .filter(|(_, line)| line.contains("unwrap_or_default("))
        .map(|(i, line)| (i + 1, line))
        .collect();
    assert_eq!(
        hits.len(),
        1,
        "M1 + E7 require gateway/src/providers/google.rs to contain exactly \
         1 `unwrap_or_default(` call (the E7 carve-out). Found {} occurrences:\n{}",
        hits.len(),
        hits.iter()
            .map(|(n, l)| format!("  line {}: {}", n, l.trim()))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

// ===========================================================================
// 2. Source-level structure tests — `parse_errors: Option<Vec<String>>`
//    fields on each parsed-data struct.
//
// These FAIL on `main` today and PASS after the fix lands.
// ===========================================================================

/// Find the source span (substring) for `pub struct {name}` body, returning
/// the substring from the `{name}` declaration up to (but not including)
/// the next top-level `pub struct` / `pub fn` / `impl` keyword. Returns
/// `None` if the struct can't be found.
fn struct_body_substring<'a>(src: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("pub struct {} {{", name);
    let start = src.find(&needle)?;
    let after = &src[start..];
    let end = ["\npub struct ", "\npub fn ", "\nimpl ", "\nfn "]
        .iter()
        .filter_map(|sentinel| after.find(sentinel))
        .min()
        .unwrap_or(after.len());
    Some(&after[..end])
}

/// **Proves:** `GeminiCliRequestData` has a `parse_errors:
/// Option<Vec<String>>` field.
///
/// **Anti-fake property:** Today the struct lives in `google.rs:17-30` with
/// 6 fields and no `parse_errors`. The grep is keyed on
/// `parse_errors: Option<Vec<String>>` — a "fix" that adds `parse_errors:
/// Vec<String>` (no `Option`) would fail.
#[test]
fn m1_gemini_cli_request_data_has_parse_errors_field() {
    let src = google_source();
    let body = struct_body_substring(&src, "GeminiCliRequestData")
        .expect("GeminiCliRequestData struct must exist in google.rs");
    assert!(
        body.contains("parse_errors: Option<Vec<String>>"),
        "M1 requires `parse_errors: Option<Vec<String>>` field on \
         GeminiCliRequestData. Body:\n{}",
        body
    );
}

/// **Proves:** `GeminiRequestData` has a `parse_errors:
/// Option<Vec<String>>` field.
///
/// **Anti-fake property:** Same shape check as above, scoped to the
/// standard-API request struct.
#[test]
fn m1_gemini_request_data_has_parse_errors_field() {
    let src = google_source();
    let body = struct_body_substring(&src, "GeminiRequestData")
        .expect("GeminiRequestData struct must exist in google.rs");
    assert!(
        body.contains("parse_errors: Option<Vec<String>>"),
        "M1 requires `parse_errors: Option<Vec<String>>` field on \
         GeminiRequestData. Body:\n{}",
        body
    );
}

/// **Proves:** `GenericParsedRequest` (in `providers/mod.rs`) has a
/// `parse_errors: Option<Vec<String>>` field.
///
/// **Anti-fake property:** The struct currently has 5 fields; the new
/// field must be present alongside them.
#[test]
fn m1_generic_parsed_request_has_parse_errors_field() {
    let src = mod_source();
    let body = struct_body_substring(&src, "GenericParsedRequest")
        .expect("GenericParsedRequest struct must exist in providers/mod.rs");
    assert!(
        body.contains("parse_errors: Option<Vec<String>>"),
        "M1 requires `parse_errors: Option<Vec<String>>` field on \
         GenericParsedRequest. Body:\n{}",
        body
    );
}

/// **Proves:** `GenericParsedResponse` (in `providers/mod.rs`) has a
/// `parse_errors: Option<Vec<String>>` field.
///
/// **Anti-fake property:** The struct currently has 7 fields; the new
/// field must be present alongside them.
#[test]
fn m1_generic_parsed_response_has_parse_errors_field() {
    let src = mod_source();
    let body = struct_body_substring(&src, "GenericParsedResponse")
        .expect("GenericParsedResponse struct must exist in providers/mod.rs");
    assert!(
        body.contains("parse_errors: Option<Vec<String>>"),
        "M1 requires `parse_errors: Option<Vec<String>>` field on \
         GenericParsedResponse. Body:\n{}",
        body
    );
}

// ===========================================================================
// 3. Source-level carve-out test — `google.rs:536` retains
//    `unwrap_or_default()` AND a comment documenting the E7 carve-out.
// ===========================================================================

/// **Proves:** The single surviving `unwrap_or_default()` in `google.rs`
/// has a nearby comment that documents the E7 carve-out — so a future
/// reviewer can see *why* this site is exempt rather than guess.
///
/// **Anti-fake property:** "Nearby" = within 8 lines preceding the
/// `unwrap_or_default()` call. We require both:
///   1. The literal token "E7" in the comment block, AND
///   2. The phrase "carve-out" or "carveout" or "intentional" so the
///      comment actually explains intent rather than just citing the
///      audit ID.
///
/// A stub fix that leaves the unwrap unchanged but adds no comment would
/// fail. A stub that adds an unrelated comment ("// optimization") would
/// fail. A stub that mentions "E7" without explaining intent would fail.
#[test]
fn e7_surviving_unwrap_or_default_has_carve_out_comment() {
    let src = google_source();
    let lines: Vec<&str> = src.lines().collect();

    // Find the line(s) containing unwrap_or_default(.
    let unwrap_lines: Vec<usize> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| l.contains("unwrap_or_default("))
        .map(|(i, _)| i)
        .collect();

    assert_eq!(
        unwrap_lines.len(),
        1,
        "precondition: google.rs must have exactly 1 unwrap_or_default after M1+E7. \
         (See m1_google_rs_has_exactly_one_unwrap_or_default for diagnosis.) \
         Found {} occurrences.",
        unwrap_lines.len()
    );

    let target = unwrap_lines[0];
    let window_start = target.saturating_sub(8);
    let window: String = lines[window_start..=target].join("\n");

    assert!(
        window.contains("E7"),
        "E7 requires the surviving unwrap_or_default() in google.rs to be \
         documented as the E7 carve-out. Expected the literal token \"E7\" \
         within 8 lines preceding the call. Window:\n{}",
        window
    );

    let lower = window.to_ascii_lowercase();
    let documents_intent = lower.contains("carve-out")
        || lower.contains("carveout")
        || lower.contains("intentional")
        || lower.contains("defensive scaffolding");

    assert!(
        documents_intent,
        "E7 requires the carve-out comment to document INTENT (one of: \
         \"carve-out\", \"carveout\", \"intentional\", \"defensive scaffolding\"), \
         not just cite the audit ID. Window:\n{}",
        window
    );
}

// ===========================================================================
// 4. Behavioural happy-path tests — well-formed inputs yield
//    `parse_errors == None`. No false positives on valid inputs.
// ===========================================================================

const WELL_FORMED_GEMINI_CLI_REQUEST: &str = r#"{
    "model": "gemini-3-flash-preview",
    "project": "test-project",
    "user_prompt_id": "abc123",
    "request": {
        "session_id": "sess-1",
        "systemInstruction": {"parts": [{"text": "You are an assistant."}]},
        "contents": [
            {"role": "user", "parts": [{"text": "hello"}]}
        ]
    }
}"#;

const WELL_FORMED_GEMINI_STANDARD_REQUEST: &str = r#"{
    "systemInstruction": {"parts": [{"text": "You are an assistant."}]},
    "contents": [
        {"role": "user", "parts": [{"text": "hello"}]}
    ]
}"#;

/// Build the standard generic-adapter config used by the behavioural tests.
fn make_generic_adapter() -> GenericAdapter {
    let config = YamlAdapterConfig {
        provider_name: "test-provider".to_string(),
        detect_hosts: vec!["llm.internal.example.com".to_string()],
        request_mapping: RequestMapping {
            model_path: "model_name".to_string(),
            messages_path: Some("conversation".to_string()),
            max_tokens_path: Some("max_length".to_string()),
        },
        response_mapping: ResponseMapping {
            response_text_path: "output.text".to_string(),
            model_path: Some("output.model".to_string()),
            stop_reason_path: Some("output.stop_reason".to_string()),
            input_tokens_path: Some("usage.prompt_tokens".to_string()),
            output_tokens_path: Some("usage.completion_tokens".to_string()),
        },
    };
    GenericAdapter::new(config)
}

/// **Proves:** A well-formed Gemini CLI request yields
/// `parse_errors == None`. No drift logged on valid input.
///
/// **Anti-fake property:** A "fix" that always logs an error (e.g. logs the
/// happy-path branch by mistake) would pollute every TurnRecord with
/// false-positive drift. This is the no-false-positive guardrail.
#[test]
fn m1_gemini_cli_request_well_formed_yields_none_parse_errors() {
    let parsed = parse_gemini_cli_request(WELL_FORMED_GEMINI_CLI_REQUEST.as_bytes())
        .expect("well-formed request must parse");
    assert!(
        parsed.parse_errors.is_none(),
        "happy-path Gemini CLI request must yield parse_errors == None, got {:?}",
        parsed.parse_errors
    );
    // Sanity: messages was populated from contents.
    assert_eq!(parsed.messages.len(), 1);
}

/// **Proves:** A well-formed standard Gemini request yields
/// `parse_errors == None`.
///
/// **Anti-fake property:** Same false-positive guardrail, scoped to the
/// standard-API parser.
#[test]
fn m1_gemini_standard_request_well_formed_yields_none_parse_errors() {
    let v: serde_json::Value =
        serde_json::from_str(WELL_FORMED_GEMINI_STANDARD_REQUEST).expect("valid JSON");
    let parsed = parse_gemini_request_from_value(&v).expect("well-formed request must parse");
    assert!(
        parsed.parse_errors.is_none(),
        "happy-path standard Gemini request must yield parse_errors == None, got {:?}",
        parsed.parse_errors
    );
    assert_eq!(parsed.messages.len(), 1);
}

/// **Proves:** A well-formed generic-provider request yields
/// `parse_errors == None`.
///
/// **Anti-fake property:** Same false-positive guardrail, scoped to the
/// generic adapter request parser. All configured paths resolve, so no
/// drift is logged.
#[test]
fn m1_generic_request_well_formed_yields_none_parse_errors() {
    let adapter = make_generic_adapter();
    let body = br#"{
        "model_name": "test-model",
        "conversation": [{"role": "user", "content": "hi"}],
        "max_length": 1024
    }"#;
    let parsed = adapter
        .parse_request(body)
        .expect("well-formed request must parse");
    assert!(
        parsed.parse_errors.is_none(),
        "happy-path generic request must yield parse_errors == None, got {:?}",
        parsed.parse_errors
    );
    assert_eq!(parsed.model, "test-model");
    assert_eq!(parsed.messages.len(), 1);
}

/// **Proves:** A well-formed generic-provider response yields
/// `parse_errors == None`.
///
/// **Anti-fake property:** Same guardrail, scoped to the response path.
#[test]
fn m1_generic_response_well_formed_yields_none_parse_errors() {
    let adapter = make_generic_adapter();
    let body = br#"{
        "output": {
            "text": "the answer is 42",
            "model": "test-model",
            "stop_reason": "stop"
        },
        "usage": {"prompt_tokens": 10, "completion_tokens": 5}
    }"#;
    let parsed = adapter
        .parse_response(body)
        .expect("well-formed response must parse");
    assert!(
        parsed.parse_errors.is_none(),
        "happy-path generic response must yield parse_errors == None, got {:?}",
        parsed.parse_errors
    );
    assert_eq!(parsed.response_text, "the answer is 42");
    assert_eq!(parsed.model, "test-model");
}

// ===========================================================================
// 5. Behavioural drift-detection tests — schema-mismatched inputs yield
//    `parse_errors == Some(vec![...])` with at least one entry naming
//    the drifted path. One test per finding (array vs string).
// ===========================================================================

/// **Proves:** Gemini CLI request with `contents` as a string (not array)
/// logs a parse-drift error mentioning "contents".
///
/// **Anti-fake property:** Today this body silently produces an empty
/// `messages` Vec. After M1 the parser must populate `parse_errors` with
/// an entry that names the path. The test checks the path name appears in
/// SOME entry — a "fix" that logs `"drift detected"` with no path would
/// fail. The test does NOT pin the exact message format, only that the
/// path is identifiable.
#[test]
fn m1_gemini_cli_request_contents_as_string_records_parse_drift() {
    let body = r#"{
        "model": "gemini-3-flash-preview",
        "project": "test-project",
        "request": {
            "session_id": "sess-1",
            "contents": "this should be an array but is a string"
        }
    }"#;
    let parsed = parse_gemini_cli_request(body.as_bytes())
        .expect("malformed schema must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("parse_errors must be Some on contents-as-string drift");
    assert!(!errors.is_empty(), "parse_errors must be non-empty");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("contents"),
        "parse-drift entry must name the drifted path 'contents'. Got: {:?}",
        errors
    );
    // Behaviour preserved: messages still falls back to empty so capture
    // continues.
    assert!(
        parsed.messages.is_empty(),
        "messages must fall back to empty Vec on drift (capture must not be lost)"
    );
}

/// **Proves:** Standard Gemini request with `contents` missing entirely
/// logs a parse-drift error mentioning "contents".
///
/// **Anti-fake property:** "missing" is distinct from "wrong type". A
/// helper that handles only `as_array() == None` for type mismatches but
/// not for `get(path) == None` would slip past the previous test (which
/// uses a string) and fail this one (which uses missing).
#[test]
fn m1_gemini_standard_request_missing_contents_records_parse_drift() {
    let body = r#"{
        "systemInstruction": {"parts": [{"text": "hi"}]}
    }"#;
    let v: serde_json::Value = serde_json::from_str(body).expect("valid JSON");
    let parsed = parse_gemini_request_from_value(&v)
        .expect("missing field must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("parse_errors must be Some on missing-contents drift");
    assert!(!errors.is_empty(), "parse_errors must be non-empty");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("contents"),
        "parse-drift entry must name 'contents'. Got: {:?}",
        errors
    );
    assert!(
        parsed.messages.is_empty(),
        "messages must fall back to empty Vec on drift"
    );
}

/// **Proves:** Generic-provider response whose body is missing the
/// configured `response_text_path` logs a parse-drift error naming the
/// path.
///
/// **Anti-fake property:** The configured path is `output.text`. The test
/// requires that string (or its segments) to appear in some
/// `parse_errors` entry — a generic "missing field" log would fail.
#[test]
fn m1_generic_response_missing_response_text_path_records_parse_drift() {
    let adapter = make_generic_adapter();
    // Body is valid JSON but lacks `output.text`.
    let body = br#"{
        "output": {"model": "test-model"},
        "usage": {"prompt_tokens": 1, "completion_tokens": 1}
    }"#;
    let parsed = adapter
        .parse_response(body)
        .expect("missing field must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("parse_errors must be Some when configured response_text_path is missing");
    assert!(!errors.is_empty(), "parse_errors must be non-empty");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("output.text") || joined.contains("response_text"),
        "parse-drift entry must name the configured path 'output.text' (or \
         the field name 'response_text'). Got: {:?}",
        errors
    );
    // Behaviour preserved: response_text falls back to empty string.
    assert_eq!(
        parsed.response_text, "",
        "response_text must fall back to empty string on drift"
    );
}

/// **Proves:** Generic-provider request whose body is missing the
/// configured `model_path` (REQUIRED config) logs a parse-drift error
/// naming the path.
///
/// **Anti-fake property:** The configured path is `model_name`. We
/// require that string to appear in some `parse_errors` entry. This site
/// is a REQUIRED config (not optional), so the helper must always log
/// when the path doesn't resolve — distinct from the optional-config
/// behaviour tested elsewhere.
#[test]
fn m1_generic_request_missing_model_path_records_parse_drift() {
    let adapter = make_generic_adapter();
    // Body lacks `model_name`.
    let body = br#"{
        "conversation": [{"role": "user", "content": "hi"}]
    }"#;
    let parsed = adapter
        .parse_request(body)
        .expect("missing field must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("parse_errors must be Some when configured model_path is missing");
    assert!(!errors.is_empty(), "parse_errors must be non-empty");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("model_name") || joined.contains("model_path"),
        "parse-drift entry must name the configured path 'model_name' (or \
         the field name 'model_path'). Got: {:?}",
        errors
    );
    assert_eq!(
        parsed.model, "",
        "model must fall back to empty string on drift"
    );
}

/// **Proves:** Generic-provider request whose `messages_path` (OPTIONAL
/// config) is configured but resolves to a non-array logs a parse-drift
/// error.
///
/// **Anti-fake property:** This is the array-on-optional-config case. The
/// audit specifies: when the config DOES configure a path but resolution
/// fails, log a drift error. The configured path here is `conversation`,
/// but the body has `conversation` as a string. A "fix" that treats
/// optional configs as "no error ever" would fail.
#[test]
fn m1_generic_request_messages_path_as_string_records_parse_drift() {
    let adapter = make_generic_adapter();
    // Body has `model_name` (so model_path resolves) but `conversation`
    // is a string instead of an array.
    let body = br#"{
        "model_name": "test-model",
        "conversation": "this is not an array"
    }"#;
    let parsed = adapter
        .parse_request(body)
        .expect("malformed schema must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("parse_errors must be Some when configured messages_path is wrong type");
    assert!(!errors.is_empty(), "parse_errors must be non-empty");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("conversation") || joined.contains("messages_path"),
        "parse-drift entry must name the configured path 'conversation' \
         (or the field name 'messages_path'). Got: {:?}",
        errors
    );
    assert!(
        parsed.messages.is_empty(),
        "messages must fall back to empty Vec on drift"
    );
}

/// **Proves:** When the OPTIONAL `model_path` on a response is *not*
/// configured (config = None), no drift is logged for that field. That's
/// "the field is optional and not requested" — not drift.
///
/// **Anti-fake property:** A naive helper that always logs when
/// `unwrap_or_default()` falls back would log here too, producing a false
/// positive. The audit explicitly requires: "When the config is None
/// (no path configured), no error logged."
///
/// We construct an adapter with `model_path: None` and a body whose
/// other configured paths all resolve. We expect `parse_errors == None`.
#[test]
fn m1_generic_response_optional_unconfigured_field_does_not_log_drift() {
    let config = YamlAdapterConfig {
        provider_name: "minimal-provider".to_string(),
        detect_hosts: vec!["llm.internal.example.com".to_string()],
        request_mapping: RequestMapping {
            model_path: "model_name".to_string(),
            messages_path: None,
            max_tokens_path: None,
        },
        response_mapping: ResponseMapping {
            response_text_path: "output.text".to_string(),
            model_path: None,
            stop_reason_path: None,
            input_tokens_path: None,
            output_tokens_path: None,
        },
    };
    let adapter = GenericAdapter::new(config);
    let body = br#"{
        "output": {"text": "hello"}
    }"#;
    let parsed = adapter
        .parse_response(body)
        .expect("well-formed response must parse");
    assert!(
        parsed.parse_errors.is_none(),
        "unconfigured optional fields must NOT log drift. Got parse_errors: {:?}",
        parsed.parse_errors
    );
    assert_eq!(parsed.response_text, "hello");
}

// ===========================================================================
// 6. Round-1 audit follow-up — regression tests for FIND-1-1 (UTF-8 panic)
//    and FIND-1-2 (request-side parse_errors aggregation).
// ===========================================================================

/// **FIND-1-1 regression — BLOCKER (UTF-8 char-boundary panic).**
///
/// `render_observed` truncated long observed values with `&s[..MAX]` where
/// `MAX = 120`. `serde_json::Value::to_string` does NOT escape non-ASCII
/// bytes — they round-trip verbatim — so any drift trigger with a >120-byte
/// non-ASCII value panicked the capture thread:
///
///     byte index 120 is not a char boundary; it is inside 'é'
///
/// This test feeds a 200-character non-ASCII string ("é".repeat(200))
/// through every helper that calls `render_observed`:
///   1. Gemini CLI request parser (single-segment array drift via
///      `extract_array_or_record_drift`).
///   2. Standard Gemini request parser (single-segment array drift).
///   3. Generic adapter request parser, dotted string path
///      (`extract_string_or_record_drift_dotted`).
///   4. Generic adapter response parser, dotted array path
///      (`extract_array_or_record_drift_dotted`).
///
/// The test asserts:
///   - No panic. (Pre-fix: each helper panics on long non-ASCII observed
///     values.)
///   - The drift entry is recorded (helper still does its job).
///   - The drift entry contains the truncation marker `…` so we know
///     truncation actually happened (not a quiet sidestep that left a
///     200-char string in the log line).
///
/// **Anti-fake property:** A "fix" that disabled truncation entirely
/// (`format!("{}", s)` without the MAX cap) would pass the no-panic
/// assertion but fail the truncation-marker assertion.
#[test]
fn find_1_1_render_observed_does_not_panic_on_multibyte_utf8() {
    let big = "é".repeat(200); // 400 bytes, 200 chars; byte 120 is mid-char.

    // 1. Gemini CLI request — `request.contents` as a long non-ASCII string.
    let body = format!(
        r#"{{"model":"m","project":"p","request":{{"session_id":"s","contents":"{}"}}}}"#,
        big
    );
    let parsed = parse_gemini_cli_request(body.as_bytes())
        .expect("malformed schema must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("FIND-1-1: parse_errors must be Some on long-non-ASCII contents drift");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("contents"),
        "drift entry must name 'contents'. Got: {:?}",
        errors
    );
    assert!(
        joined.contains('…'),
        "FIND-1-1: long observed values must be truncated with the '…' \
         marker (truncation didn't run, or wasn't applied). Got: {:?}",
        errors
    );

    // 2. Standard Gemini request — `contents` as a long non-ASCII string.
    let body = format!(r#"{{"contents":"{}"}}"#, big);
    let v: serde_json::Value = serde_json::from_str(&body).expect("valid JSON");
    let parsed = parse_gemini_request_from_value(&v)
        .expect("malformed schema must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("FIND-1-1: parse_errors must be Some on long-non-ASCII contents drift");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("contents"),
        "drift entry must name 'contents'. Got: {:?}",
        errors
    );
    assert!(
        joined.contains('…'),
        "FIND-1-1: long observed values must be truncated. Got: {:?}",
        errors
    );

    // 3. Generic adapter request — `model_name` configured as REQUIRED
    // string path, but body has a non-string at a different shape that
    // the dotted helper renders. Use an object-valued `model_name` so the
    // observed renders as JSON > 120 bytes with non-ASCII content.
    let adapter = make_generic_adapter();
    let model_obj = format!(r#"{{"label":"{}"}}"#, big);
    let body = format!(
        r#"{{"model_name":{},"conversation":[{{"role":"user","content":"hi"}}]}}"#,
        model_obj
    );
    let parsed = adapter
        .parse_request(body.as_bytes())
        .expect("malformed schema must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("FIND-1-1: parse_errors must be Some when model_name is wrong type");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("model_name") || joined.contains("model_path"),
        "drift entry must name 'model_name'. Got: {:?}",
        errors
    );
    assert!(
        joined.contains('…'),
        "FIND-1-1: long observed values must be truncated. Got: {:?}",
        errors
    );

    // 4. Generic adapter request — `messages_path` (dotted-array helper)
    // pointed at a long non-ASCII string instead of an array.
    let body = format!(r#"{{"model_name":"m","conversation":"{}"}}"#, big);
    let parsed = adapter
        .parse_request(body.as_bytes())
        .expect("malformed schema must still parse — drift logged, not raised");
    let errors = parsed
        .parse_errors
        .as_ref()
        .expect("FIND-1-1: parse_errors must be Some on long-non-ASCII conversation drift");
    let joined = errors.join(" | ");
    assert!(
        joined.contains("conversation") || joined.contains("messages_path"),
        "drift entry must name 'conversation'. Got: {:?}",
        errors
    );
    assert!(
        joined.contains('…'),
        "FIND-1-1: long observed values must be truncated. Got: {:?}",
        errors
    );
}

/// **FIND-1-1 regression — boundary cases.**
///
/// Truncation must work cleanly when the byte that *would* land at index 120
/// is precisely inside a multi-byte sequence (the original panic site) AND
/// also when the input is long but pure-ASCII (the fast path).
#[test]
fn find_1_1_render_observed_boundary_cases() {
    let adapter = make_generic_adapter();

    // ASCII fast path: 200 ASCII chars at `model_name`. Truncation must
    // still fire (200 > 120) and not panic.
    let big_ascii = "x".repeat(200);
    let body = format!(
        r#"{{"model_name":{{"v":"{}"}},"conversation":[]}}"#,
        big_ascii
    );
    let parsed = adapter
        .parse_request(body.as_bytes())
        .expect("malformed schema must still parse");
    let joined = parsed
        .parse_errors
        .as_ref()
        .expect("must record drift")
        .join(" | ");
    assert!(joined.contains('…'), "ASCII truncation marker missing");

    // Non-ASCII near-boundary: a 4-byte char ('🔥' = 4 bytes) repeated until
    // total exceeds 120 bytes — guarantees byte 120 falls inside a
    // multi-byte sequence.
    let big_emoji = "🔥".repeat(40); // 160 bytes, 40 chars.
    let body = format!(
        r#"{{"model_name":{{"v":"{}"}},"conversation":[]}}"#,
        big_emoji
    );
    let parsed = adapter
        .parse_request(body.as_bytes())
        .expect("malformed schema must still parse — must NOT panic");
    let _ = parsed
        .parse_errors
        .as_ref()
        .expect("must record drift on wrong-type model_name");
}

// ===========================================================================
// 7. FIND-1-2 — end-to-end test that request-side parse_errors reaches
//    TurnRecord.parse_errors.
// ===========================================================================

use recondo_gateway::gateway;
use recondo_gateway::session::SessionManager;

use common::pipeline::make_pipeline;

/// Minimal Gemini CLI SSE response with one `[DONE]`-equivalent terminator.
/// Borrowed from gemini_cli_tests.rs but inlined to keep this test
/// self-contained.
fn minimal_gemini_cli_sse_bytes() -> Vec<u8> {
    // A single SSE event with finishReason set so capture_complete = true.
    let event = r#"{"response":{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP","index":0}],"modelVersion":"gemini-3-flash-preview","usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}"#;
    let body = format!("data: {}\n\n", event);
    let mut bytes = b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n".to_vec();
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

/// **FIND-1-2 regression — request-side parse_errors must reach
/// TurnRecord.parse_errors.**
///
/// Before the fix, the three aggregation sites in `gateway/src/gateway/mod.rs`
/// (Gemini CLI happy path, standard Gemini happy path, Generic adapter
/// happy path) all read only `parsed_resp.parse_errors`, dropping the new
/// request-side `parse_errors` populated by the parse-drift helpers. The
/// audit's "log to parse_errors, not silent fallback" intent was defeated —
/// request-side schema drift never reached the DB.
///
/// This test pushes a Gemini CLI request whose `request.contents` is a
/// string (not an array — schema drift) through the full pipeline and
/// asserts the resulting `TurnRecord.parse_errors` (a JSON-encoded
/// `Option<String>` on the row) contains the request-side drift entry.
///
/// **Anti-fake property:** A regression that drops the merge at one of the
/// three sites would fail this end-to-end check. A "fix" that quietly
/// suppressed the drift would also fail because the assertion looks for
/// the literal "contents" path token.
#[test]
fn find_1_2_request_side_parse_errors_reach_turn_record() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    // Gemini CLI request body with `request.contents` as a string. The
    // parser logs drift but proceeds with empty messages so capture is not
    // lost.
    let request_body = r#"{
        "model": "gemini-3-flash-preview",
        "project": "test-project",
        "request": {
            "session_id": "sess-find-1-2",
            "contents": "this should be an array but is a string"
        }
    }"#;
    // Wrap the body in HTTP headers so `strip_http_headers` finds it (the
    // gateway entry point expects raw HTTP-on-the-wire bytes).
    let mut request_bytes = b"POST /v1/cloudcode/generate HTTP/1.1\r\n\
Host: cloudcode-pa.googleapis.com\r\n\
Content-Type: application/json\r\n\r\n"
        .to_vec();
    request_bytes.extend_from_slice(request_body.as_bytes());

    let response_bytes = minimal_gemini_cli_sse_bytes();

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        &request_bytes,
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed even with request drift");

    // The TurnRecord.parse_errors field is a JSON-encoded Option<String>.
    let raw = turn
        .parse_errors
        .as_ref()
        .expect("FIND-1-2: TurnRecord.parse_errors must be Some when request side reports drift");
    assert!(
        raw.contains("contents"),
        "FIND-1-2: TurnRecord.parse_errors must include the request-side \
         drift entry naming 'contents'. Got: {}",
        raw
    );
}
