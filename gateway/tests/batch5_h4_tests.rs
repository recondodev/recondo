//! Batch 5 — Audit follow-up H4 (externalize the hardcoded if-else cost-rate
//! table in `gateway/src/db/mod.rs::compute_cost_usd` to
//! `compliance/model-pricing.toml`, with longest-prefix-match + effective_from
//! temporal resolution + tier breaks + load-time validation).
//!
//! Audit reference: `docs/GATEWAY_AUDIT_2026_05_02.md` section H4.
//!
//! # What these tests guard
//!
//! - The on-disk pricing table `compliance/model-pricing.toml` exists and
//!   parses with the canonical loader.
//! - `gateway/src/db/model_pricing.rs` exposes `PricingTable`, `PricingEntry`,
//!   `TierEntry`, `load_from_toml`, and `resolve`.
//! - `compute_cost_usd` gains a `&OffsetDateTime` parameter and is no longer
//!   a hardcoded if-else chain (`starts_with(...)` patterns gone).
//! - **Billing-error guard:** `gpt-4o-mini-...` resolves to mini rates
//!   ($0.15/$0.60), NOT `gpt-4o` rates ($2.50/$10.00). The previous code
//!   relied on branch ordering — one wrong order is a 16× billing error.
//!   The new longest-prefix-match makes that class structurally impossible.
//! - **Cost regression:** for every one of the 19 currently-priced model
//!   prefixes, the externalized table produces the SAME cost the if-else
//!   chain produced on the same representative input.
//! - **Loader validation:** empty prefix is rejected; duplicate
//!   `(prefix, effective_from)` is rejected.
//! - **Temporal resolution:** two entries for the same prefix with different
//!   `effective_from` resolve correctly based on the query timestamp.
//! - **Tier-break:** `gemini-2.5-pro` over the 200K input-token threshold
//!   uses tier rates ($2.5/$15), not base rates ($1.25/$10).
//! - **Production wiring:** the four production call sites still produce a
//!   non-zero cost on a representative captured turn.
//!
//! These tests are written BEFORE the implementation. They MUST fail on
//! `main` today and pass after Batch 5 is implemented.

#![allow(clippy::float_cmp)]

use std::fs;
use std::path::{Path, PathBuf};

use recondo_gateway::db;
use recondo_gateway::db::model_pricing::{PricingTable, TierEntry};
use recondo_gateway::gateway;
use recondo_gateway::session::SessionManager;
use time::macros::datetime;
use time::OffsetDateTime;

mod common;
use common::pipeline::make_pipeline;

// ===========================================================================
// Helpers — paths and canonical pricing loader.
// ===========================================================================

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR is `<repo>/gateway` for this crate.
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("manifest dir has a parent (the repo root)")
        .to_path_buf()
}

fn compliance_pricing_path() -> PathBuf {
    repo_root().join("compliance").join("model-pricing.toml")
}

fn db_mod_source_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("db")
        .join("mod.rs")
}

fn read_to_string(p: &Path) -> String {
    fs::read_to_string(p).unwrap_or_else(|e| panic!("failed to read {}: {}", p.display(), e))
}

/// Load the canonical on-disk pricing table for tests. Tests use this rather
/// than reaching into a process-static `OnceCell` because we want a fresh
/// load (and a clear failure mode) per test.
fn load_canonical_pricing() -> PricingTable {
    let toml_str = read_to_string(&compliance_pricing_path());
    PricingTable::load_from_toml(&toml_str).unwrap_or_else(|e| {
        panic!(
            "canonical compliance/model-pricing.toml must load without error: {}",
            e
        )
    })
}

/// Default "now" used by cost-regression tests. Must be after every
/// `effective_from` for currently-priced models in the canonical table so
/// that resolution returns the live row.
fn now_for_tests() -> OffsetDateTime {
    datetime!(2026-05-02 00:00:00 UTC)
}

// ===========================================================================
// Section 1 — Source-level structural tests.
// ===========================================================================

/// Proves: `compliance/model-pricing.toml` exists on disk.
/// Anti-fake: tests cannot pass if the implementer "stubbed" the table only
/// in code without externalising it to the documented path.
#[test]
fn h4_compliance_pricing_toml_exists() {
    let p = compliance_pricing_path();
    assert!(
        p.exists(),
        "compliance/model-pricing.toml must exist at {} (Batch 5 H4 deliverable)",
        p.display()
    );
    let content = read_to_string(&p);
    assert!(
        content.contains("[[pricing]]"),
        "compliance/model-pricing.toml must contain [[pricing]] entries"
    );
    assert!(
        content.contains("effective_from"),
        "compliance/model-pricing.toml must contain effective_from on every entry"
    );
}

/// Proves: `gateway/src/db/model_pricing.rs` exists.
/// Anti-fake: a re-export shim alone (e.g. just adding pub use to db/mod.rs)
/// cannot satisfy this — the audit names the new module explicitly.
#[test]
fn h4_model_pricing_module_exists() {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("db")
        .join("model_pricing.rs");
    assert!(
        p.exists(),
        "gateway/src/db/model_pricing.rs must exist (Batch 5 H4 deliverable). \
         If the implementer chose a different file name, update this test."
    );
}

/// Proves: `compute_cost_usd` gains a `&OffsetDateTime` argument.
/// Anti-fake: a callable named `compute_cost_usd` could keep the old
/// signature; this test inspects the source for the new parameter shape.
#[test]
fn h4_compute_cost_usd_signature_includes_offset_datetime() {
    let src = read_to_string(&db_mod_source_path());
    let needle = "pub fn compute_cost_usd(";
    let idx = src
        .find(needle)
        .expect("compute_cost_usd must remain a pub fn in db/mod.rs");
    let body_end = src[idx..]
        .find(") -> f64")
        .expect("compute_cost_usd must still return f64");
    let signature = &src[idx..idx + body_end];

    assert!(
        signature.contains("OffsetDateTime"),
        "compute_cost_usd signature must reference OffsetDateTime (the new \
         `at: &OffsetDateTime` parameter). Found:\n{}",
        signature
    );
    assert!(
        signature.contains("PricingTable"),
        "compute_cost_usd signature must take a `&PricingTable` (no more \
         hardcoded if-else chain). Found:\n{}",
        signature
    );
}

/// Proves: the prior hardcoded if-else chain in `compute_cost_usd` is gone.
/// Anti-fake: a wrapper that delegates to the old chain still leaves the
/// `lower.starts_with("claude-...")` branches in place. This test counts
/// them and requires they all be deleted.
#[test]
fn h4_if_else_chain_removed_from_compute_cost_usd() {
    let src = read_to_string(&db_mod_source_path());

    // Locate the function body.
    let start = src
        .find("pub fn compute_cost_usd(")
        .expect("compute_cost_usd must remain in db/mod.rs");
    // The function ends at the next top-level `pub fn` / `// ----` block.
    // We just scan a generous window forward.
    let window = &src[start..start.saturating_add(8_000).min(src.len())];

    let starts_with_count = window.matches("lower.starts_with(\"").count();
    assert_eq!(
        starts_with_count, 0,
        "compute_cost_usd must no longer use a hardcoded `lower.starts_with(\"...\")` \
         chain — the table must drive resolution via PricingTable. Found {} occurrences.",
        starts_with_count
    );

    // Defensive: the previous magic numbers (e.g. `(15.0, 75.0`) for Opus 4
    // should also be gone from the function body. The implementer can keep
    // them in the TOML, but not embedded in code.
    assert!(
        !window.contains("(15.0, 75.0"),
        "compute_cost_usd must not contain hardcoded `(15.0, 75.0, ...)` rate tuples"
    );
}

/// Proves: `PricingTable`, `PricingEntry`, `TierEntry`, `load_from_toml`,
/// and `resolve` are all reachable from the public API.
/// Anti-fake: source-grep-only tests can be satisfied by name without a
/// real type — this test references the actual symbols, so a missing or
/// mis-named symbol produces a compile error.
#[test]
fn h4_public_surface_exists() {
    // Touch each symbol so a missing/renamed one fails to compile.
    let _t: Option<&PricingTable> = None;
    let _e: Option<&db::model_pricing::PricingEntry> = None;
    let _r: Option<&TierEntry> = None;

    // Construct the empty case and check resolve returns None — no
    // assertions on internal layout.
    let empty = PricingTable::load_from_toml("").expect("empty TOML must load to an empty table");
    assert!(
        empty.resolve("anything", &now_for_tests()).is_none(),
        "empty PricingTable must resolve nothing"
    );
}

// ===========================================================================
// Section 2 — Loader validation tests.
// ===========================================================================

/// Proves: a well-formed TOML loads.
/// Anti-fake: this is the happy path; a loader that always errors would fail.
#[test]
fn h4_loader_accepts_valid_toml() {
    let toml = r#"
[[pricing]]
prefix = "claude-opus-4-6"
effective_from = "2026-04-01T00:00:00Z"
input_per_m = 5.0
output_per_m = 25.0
cache_create_per_m = 6.25
cache_read_per_m = 0.50
"#;
    PricingTable::load_from_toml(toml).expect("well-formed TOML must load");
}

/// Proves: the canonical `compliance/model-pricing.toml` loads without error.
/// Anti-fake: the canonical file is the production artifact; if it doesn't
/// load, no model gets priced in production.
#[test]
fn h4_canonical_compliance_toml_loads() {
    let _ = load_canonical_pricing();
}

/// Proves: empty `prefix=""` is rejected at load time (audit requirement).
/// Anti-fake: a permissive loader would happily accept an empty prefix and
/// then match every model — a silent overcharge / undercharge.
#[test]
fn h4_loader_rejects_empty_prefix() {
    let toml = r#"
[[pricing]]
prefix = ""
effective_from = "2026-04-01T00:00:00Z"
input_per_m = 5.0
output_per_m = 25.0
cache_create_per_m = 6.25
cache_read_per_m = 0.50
"#;
    let result = PricingTable::load_from_toml(toml);
    assert!(
        result.is_err(),
        "loader must reject empty prefix= (audit H4 requirement)"
    );
    let err = format!("{:?}", result.unwrap_err()).to_ascii_lowercase();
    assert!(
        err.contains("prefix") || err.contains("empty"),
        "loader error must clearly name the empty-prefix problem: got {}",
        err
    );
}

/// Proves: duplicate `(prefix, effective_from)` is rejected at load time.
/// Anti-fake: silent last-wins (which is the typical default for naive HashMaps)
/// is a documented audit anti-pattern — pricing changes accidentally clobbering
/// prior rows is a major audit-trail problem.
#[test]
fn h4_loader_rejects_duplicate_prefix_effective_from() {
    let toml = r#"
[[pricing]]
prefix = "claude-opus-4-6"
effective_from = "2026-04-01T00:00:00Z"
input_per_m = 5.0
output_per_m = 25.0
cache_create_per_m = 6.25
cache_read_per_m = 0.50

[[pricing]]
prefix = "claude-opus-4-6"
effective_from = "2026-04-01T00:00:00Z"
input_per_m = 7.0
output_per_m = 30.0
cache_create_per_m = 8.75
cache_read_per_m = 0.70
"#;
    let result = PricingTable::load_from_toml(toml);
    assert!(
        result.is_err(),
        "loader must reject duplicate (prefix, effective_from) tuples \
         (audit H4 requirement: NOT silent last-wins)"
    );
    let err = format!("{:?}", result.unwrap_err()).to_ascii_lowercase();
    assert!(
        err.contains("duplicate") || err.contains("conflict") || err.contains("dup"),
        "loader error must clearly name the duplicate problem: got {}",
        err
    );
}

/// FIND-1-3 (round 1 fix): a TOML row missing `cache_read_per_m` MUST fail
/// to load. The pre-fix loader synthesized a 0.0 default, which silently
/// undercharged every cache-read token while a missing `cache_create_per_m`
/// (always required) failed loudly. Asymmetric defaults are an audit
/// anti-pattern; both cache rates are now required.
#[test]
fn h4_loader_rejects_missing_cache_read_per_m() {
    let toml = r#"
[[pricing]]
prefix = "claude-opus-4-6"
effective_from = "2026-04-01T00:00:00Z"
input_per_m = 5.0
output_per_m = 25.0
cache_create_per_m = 6.25
"#;
    let result = PricingTable::load_from_toml(toml);
    assert!(
        result.is_err(),
        "loader must reject TOML rows missing `cache_read_per_m` \
         (FIND-1-3: silent zero-rate is a billing-error class)"
    );
    let err = format!("{:?}", result.unwrap_err()).to_ascii_lowercase();
    assert!(
        err.contains("cache_read_per_m") || err.contains("missing field"),
        "loader error must clearly name the missing cache_read_per_m field: got {}",
        err
    );
}

/// FIND-1-4 (round 1): pin the strict `>` semantics of
/// `TierEntry::threshold_input_tokens`. At exactly the threshold, the
/// entry-level base rates apply — NOT the tier rates. Google's published
/// policy ("longer than 200,000 tokens") matches strict `>`, but the
/// language is ambiguous, so the choice is now codified by both doc
/// comment and test.
#[test]
fn h4_tier_predicate_at_exact_threshold_uses_base() {
    let pricing = recondo_gateway::db::model_pricing::canonical();
    // gemini-2.5-pro: base $1.25 / $10 below threshold; tier $2.5 / $15 above.
    // At exactly 200_000 input tokens we expect base rates.
    let at = datetime!(2026-04-01 0:00 UTC);
    let cost_at_threshold = db::compute_cost_usd(pricing, "gemini-2.5-pro", 200_000, 0, 0, 0, &at);
    let expected_base = 200_000.0 * 1.25 / 1_000_000.0;
    assert!(
        (cost_at_threshold - expected_base).abs() < 1e-9,
        "at exactly threshold (200_000 tokens), base rate $1.25/M must apply, \
         not tier $2.5/M; got {}, expected {}",
        cost_at_threshold,
        expected_base
    );

    // Sanity: one token over threshold flips to tier rates.
    let cost_just_over = db::compute_cost_usd(pricing, "gemini-2.5-pro", 200_001, 0, 0, 0, &at);
    let expected_tier = 200_001.0 * 2.5 / 1_000_000.0;
    assert!(
        (cost_just_over - expected_tier).abs() < 1e-9,
        "at threshold+1, tier rate $2.5/M must apply; got {}, expected {}",
        cost_just_over,
        expected_tier
    );
}

/// Proves: the canonical TOML on disk covers every prefix the pre-fix
/// if-else chain handled.
/// Anti-fake: a partial migration that only ports, say, the Anthropic models
/// would silently zero-out billing for OpenAI / Gemini captures.
#[test]
fn h4_canonical_toml_covers_required_prefixes() {
    let canonical = read_to_string(&compliance_pricing_path());
    // Every prefix in the audit's coverage. Ordering matches the original
    // if-else chain in db/mod.rs so a reviewer can diff.
    let required_prefixes = [
        "claude-opus-4-6",
        "claude-opus-4-5",
        "claude-opus-4",
        "claude-3-opus",
        "claude-sonnet-4",
        "claude-3-sonnet",
        "claude-3-5-sonnet",
        "claude-haiku-4",
        "claude-haiku",
        "claude-3-haiku",
        "claude-3-5-haiku",
        "gpt-4o-mini",
        "gpt-4o",
        "o1-mini",
        "o3-mini",
        "o3",
        "o1",
        "gpt-4-turbo",
        "gpt-4",
        "gemini-2.5-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-3-flash",
        "gemini-3-pro",
    ];
    for prefix in &required_prefixes {
        let needle = format!("prefix = \"{}\"", prefix);
        assert!(
            canonical.contains(&needle),
            "compliance/model-pricing.toml must contain `{}` (full set of \
             currently-priced model prefixes — partial migration would \
             silently zero-out billing for the missing prefix)",
            needle
        );
    }
}

// ===========================================================================
// Section 3 — Resolution tests (longest-prefix-match + temporal resolution).
//
// These guard the highest-stakes property in H4: a wrong resolution silently
// 16×-overcharges (or 16×-undercharges) the customer.
// ===========================================================================

/// **CRITICAL anti-fake billing-error guard.**
///
/// Proves: `gpt-4o-mini-2024-07-18` resolves to `gpt-4o-mini` rates
/// ($0.15/$0.60), NOT `gpt-4o` rates ($2.50/$10.00).
///
/// Anti-fake: a naive map iterator with no longest-prefix-match would (a)
/// match the first entry, or (b) match `gpt-4o` (shorter prefix) and silently
/// overcharge by 16× exactly the documented R1-12 bug class.
#[test]
fn h4_gpt_4o_mini_resolves_to_mini_rates_not_gpt_4o() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();

    // Both prefixes MUST be present in the corpus for the test to be meaningful.
    let mini_only = pricing
        .resolve("gpt-4o-mini", &now)
        .expect("gpt-4o-mini prefix must be in the canonical table");
    assert_eq!(mini_only.prefix, "gpt-4o-mini");
    let gpt4o_only = pricing
        .resolve("gpt-4o-2024-08-06", &now)
        .expect("gpt-4o prefix must be in the canonical table");
    assert_eq!(
        gpt4o_only.prefix, "gpt-4o",
        "gpt-4o-2024-08-06 must resolve to the gpt-4o entry"
    );

    // The actual billing-error guard: a model that prefix-collides on `gpt-4o`
    // must be routed to `gpt-4o-mini`, not `gpt-4o`.
    let entry = pricing
        .resolve("gpt-4o-mini-2024-07-18", &now)
        .expect("gpt-4o-mini-2024-07-18 must resolve");
    assert_eq!(
        entry.prefix, "gpt-4o-mini",
        "longest-prefix-match must select 'gpt-4o-mini' (not 'gpt-4o' which \
         would be a 16× billing error — R1-12 bug class)"
    );
    assert!((entry.input_per_m - 0.15).abs() < 1e-9);
    assert!((entry.output_per_m - 0.60).abs() < 1e-9);
}

/// Proves: `claude-opus-4-6-20251101` resolves to `claude-opus-4-6`, not
/// `claude-opus-4` or `claude-3-opus`.
#[test]
fn h4_claude_opus_4_6_resolves_to_4_6_not_4_or_3() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();
    let entry = pricing
        .resolve("claude-opus-4-6-20251101", &now)
        .expect("claude-opus-4-6-20251101 must resolve");
    assert_eq!(
        entry.prefix, "claude-opus-4-6",
        "longest-prefix-match must select 'claude-opus-4-6' (Opus 4.6 is \
         3× cheaper than Opus 4 base; wrong selection is a 3× billing error)"
    );
    assert!((entry.input_per_m - 5.0).abs() < 1e-9);
    assert!((entry.output_per_m - 25.0).abs() < 1e-9);
}

/// Proves: `o1-mini-2024-09-12` resolves to `o1-mini`, not `o1`.
#[test]
fn h4_o1_mini_resolves_to_mini_not_o1() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();
    let entry = pricing
        .resolve("o1-mini-2024-09-12", &now)
        .expect("o1-mini must resolve");
    assert_eq!(
        entry.prefix, "o1-mini",
        "longest-prefix-match must select 'o1-mini' (not 'o1')"
    );
    assert!((entry.input_per_m - 3.0).abs() < 1e-9);
    assert!((entry.output_per_m - 12.0).abs() < 1e-9);
}

/// Proves: `gemini-2.5-flash-lite-001` resolves to `gemini-2.5-flash-lite`,
/// not `gemini-2.5-flash`.
#[test]
fn h4_gemini_flash_lite_resolves_to_lite_not_flash() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();
    let entry = pricing
        .resolve("gemini-2.5-flash-lite-001", &now)
        .expect("gemini-2.5-flash-lite must resolve");
    assert_eq!(entry.prefix, "gemini-2.5-flash-lite");
    assert!((entry.input_per_m - 0.075).abs() < 1e-9);
    assert!((entry.output_per_m - 0.30).abs() < 1e-9);
}

/// Proves: an unknown model returns None.
/// Anti-fake: a permissive loader / resolver that defaulted to the longest
/// known prefix would silently bill at the wrong rate.
#[test]
fn h4_unknown_model_returns_none() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();
    assert!(
        pricing
            .resolve("totally-made-up-model-name-xyz", &now)
            .is_none(),
        "unknown models must resolve to None (so compute_cost_usd returns 0.0)"
    );
}

/// Proves: temporal resolution picks the entry whose `effective_from` is the
/// greatest <= the query timestamp.
///
/// Anti-fake: a loader that ignored `effective_from` would always return the
/// last loaded row, breaking historical replay in `recovery.rs:686`.
#[test]
fn h4_effective_from_temporal_resolution() {
    let toml = r#"
[[pricing]]
prefix = "claude-opus-4-6"
effective_from = "2026-01-01T00:00:00Z"
input_per_m = 10.0
output_per_m = 50.0
cache_create_per_m = 12.5
cache_read_per_m = 1.0

[[pricing]]
prefix = "claude-opus-4-6"
effective_from = "2026-04-01T00:00:00Z"
input_per_m = 5.0
output_per_m = 25.0
cache_create_per_m = 6.25
cache_read_per_m = 0.50
"#;
    let pricing = PricingTable::load_from_toml(toml).expect("two-row TOML must load");

    let early = datetime!(2026-02-01 00:00:00 UTC);
    let entry_early = pricing
        .resolve("claude-opus-4-6", &early)
        .expect("must resolve at early timestamp");
    assert!(
        (entry_early.input_per_m - 10.0).abs() < 1e-9,
        "before 2026-04-01 the older effective_from row is current"
    );

    let late = datetime!(2026-05-01 00:00:00 UTC);
    let entry_late = pricing
        .resolve("claude-opus-4-6", &late)
        .expect("must resolve at late timestamp");
    assert!(
        (entry_late.input_per_m - 5.0).abs() < 1e-9,
        "after 2026-04-01 the newer effective_from row supersedes"
    );

    // Pre-history: a query before any effective_from row resolves to None.
    let prehistory = datetime!(2025-12-31 00:00:00 UTC);
    assert!(
        pricing.resolve("claude-opus-4-6", &prehistory).is_none(),
        "queries before any effective_from must resolve to None (no retroactive \
         pricing — historical replay correctness)"
    );
}

// ===========================================================================
// Section 4 — Cost regression tests.
//
// For each currently-priced family, verify the externalized table produces
// the SAME cost as the pre-fix if-else chain on representative inputs.
// Expected values are computed by hand from the audit's pricing rules.
//
// All inputs use 1000 input + 500 output tokens, varying cache mix.
// Cache pricing semantics (per audit):
//   - Anthropic: cache_create at 1.25× input, cache_read at 0.10× input
//   - Gemini:    cache_create = 0; cache_read at 0.25× input
//   - OpenAI:    cache_create = 0; cache_read at 0.50× input
// These are encoded as ABSOLUTE per-million rates in the TOML, but the
// effective math is the same.
// ===========================================================================

fn approx_eq(a: f64, b: f64, tol: f64, label: &str) {
    assert!(
        (a - b).abs() < tol,
        "cost mismatch for {}: expected ${:.9}, got ${:.9}",
        label,
        b,
        a
    );
}

/// Proves: each Anthropic family computes the correct cost (with cache_create).
#[test]
fn h4_cost_regression_anthropic_with_cache_create() {
    let pricing = load_canonical_pricing();
    let at = now_for_tests();

    // (model, input_per_m, output_per_m)
    let cases = [
        ("claude-opus-4-6-20251101", 5.0, 25.0),
        ("claude-opus-4-5-20251101", 5.0, 25.0),
        ("claude-opus-4-20250514", 15.0, 75.0),
        ("claude-3-opus-20240229", 15.0, 75.0),
        ("claude-sonnet-4-20250514", 3.0, 15.0),
        ("claude-3-5-sonnet-20240620", 3.0, 15.0),
        ("claude-3-sonnet-20240229", 3.0, 15.0),
        ("claude-haiku-4-20251101", 1.0, 5.0),
        ("claude-3-5-haiku-20241022", 0.80, 4.0),
        ("claude-3-haiku-20240307", 0.80, 4.0),
    ];

    for (model, input_rate, output_rate) in cases {
        let cost = db::compute_cost_usd(&pricing, model, 1_000, 500, 2_000, 0, &at);
        let expected = (1_000.0 * input_rate + 500.0 * output_rate + 2_000.0 * input_rate * 1.25)
            / 1_000_000.0;
        approx_eq(cost, expected, 1e-9, model);
    }
}

/// Proves: each Anthropic family computes the correct cost (with cache_read).
#[test]
fn h4_cost_regression_anthropic_with_cache_read() {
    let pricing = load_canonical_pricing();
    let at = now_for_tests();

    let cases = [
        ("claude-opus-4-6-20251101", 5.0, 25.0),
        ("claude-opus-4-20250514", 15.0, 75.0),
        ("claude-sonnet-4-20250514", 3.0, 15.0),
        ("claude-haiku-4-20251101", 1.0, 5.0),
        ("claude-3-5-haiku-20241022", 0.80, 4.0),
    ];

    for (model, input_rate, output_rate) in cases {
        let cost = db::compute_cost_usd(&pricing, model, 1_000, 500, 0, 5_000, &at);
        let expected = (1_000.0 * input_rate + 500.0 * output_rate + 5_000.0 * input_rate * 0.10)
            / 1_000_000.0;
        approx_eq(cost, expected, 1e-9, model);
    }
}

/// Proves: each OpenAI family computes the correct cost (with cache_read).
#[test]
fn h4_cost_regression_openai() {
    let pricing = load_canonical_pricing();
    let at = now_for_tests();

    // (model, input_per_m, output_per_m)
    let cases = [
        ("gpt-4o-mini-2024-07-18", 0.15, 0.60),
        ("gpt-4o-2024-08-06", 2.50, 10.0),
        ("o1-mini-2024-09-12", 3.0, 12.0),
        ("o1-preview-2024-09-12", 15.0, 60.0),
        ("o3-mini-2025-01-31", 1.10, 4.40),
        ("o3-2025-04-16", 10.0, 40.0),
        ("gpt-4-turbo-2024-04-09", 10.0, 30.0),
        ("gpt-4-0613", 30.0, 60.0),
    ];

    for (model, input_rate, output_rate) in cases {
        // No cache.
        let cost_no_cache = db::compute_cost_usd(&pricing, model, 1_000, 500, 0, 0, &at);
        let expected_no_cache = (1_000.0 * input_rate + 500.0 * output_rate) / 1_000_000.0;
        approx_eq(cost_no_cache, expected_no_cache, 1e-9, model);

        // With cache_read at 0.50× input rate.
        let cost_cr = db::compute_cost_usd(&pricing, model, 1_000, 500, 0, 4_000, &at);
        let expected_cr =
            (1_000.0 * input_rate + 500.0 * output_rate + 4_000.0 * input_rate * 0.50)
                / 1_000_000.0;
        approx_eq(cost_cr, expected_cr, 1e-9, model);

        // OpenAI cache_create has no concept; passing tokens must NOT increase cost.
        let cost_cc = db::compute_cost_usd(&pricing, model, 1_000, 500, 99_999, 0, &at);
        approx_eq(cost_cc, expected_no_cache, 1e-9, model);
    }
}

/// Proves: each Gemini family computes the correct cost.
/// Note: gemini-2.5-pro is tested at sub-200K so the base rate applies.
/// The tier-break test below covers the >200K case.
#[test]
fn h4_cost_regression_gemini() {
    let pricing = load_canonical_pricing();
    let at = now_for_tests();

    let cases = [
        ("gemini-2.5-flash-lite-preview", 0.075, 0.30),
        ("gemini-2.5-flash-001", 0.15, 0.60),
        ("gemini-2.5-pro-002", 1.25, 10.0), // sub-200K input
        ("gemini-3-flash-preview", 0.15, 0.60),
        ("gemini-3-pro-preview", 1.25, 10.0),
    ];

    for (model, input_rate, output_rate) in cases {
        // No cache.
        let cost_no_cache = db::compute_cost_usd(&pricing, model, 1_000, 500, 0, 0, &at);
        let expected_no_cache = (1_000.0 * input_rate + 500.0 * output_rate) / 1_000_000.0;
        approx_eq(cost_no_cache, expected_no_cache, 1e-9, model);

        // Gemini cache_read at 0.25× input.
        let cost_cr = db::compute_cost_usd(&pricing, model, 1_000, 500, 0, 4_000, &at);
        let expected_cr =
            (1_000.0 * input_rate + 500.0 * output_rate + 4_000.0 * input_rate * 0.25)
                / 1_000_000.0;
        approx_eq(cost_cr, expected_cr, 1e-9, model);

        // Gemini has no cache_create concept; cache_create_tokens must NOT
        // increase cost.
        let cost_cc = db::compute_cost_usd(&pricing, model, 1_000, 500, 50_000, 0, &at);
        approx_eq(cost_cc, expected_no_cache, 1e-9, model);
    }
}

/// Proves: unknown models still return 0.0 (matches current fall-through).
#[test]
fn h4_unknown_model_compute_cost_returns_zero() {
    let pricing = load_canonical_pricing();
    let at = now_for_tests();
    let cost = db::compute_cost_usd(&pricing, "unknown-model-zzz", 1_000, 500, 0, 0, &at);
    assert_eq!(
        cost, 0.0,
        "unknown models must return 0.0 (preserve existing fall-through)"
    );
}

/// Proves: gpt-4o-mini at the cost level (not just resolution) is mini-priced.
/// Anti-fake: this asserts the actual dollar cost a billing pipeline would
/// compute, even if some intermediate refactor accidentally stripped the
/// resolve step.
#[test]
fn h4_cost_regression_gpt_4o_mini_is_16x_cheaper_than_gpt_4o() {
    let pricing = load_canonical_pricing();
    let at = now_for_tests();

    let cost_mini = db::compute_cost_usd(
        &pricing,
        "gpt-4o-mini-2024-07-18",
        1_000_000,
        1_000_000,
        0,
        0,
        &at,
    );
    let cost_full = db::compute_cost_usd(
        &pricing,
        "gpt-4o-2024-08-06",
        1_000_000,
        1_000_000,
        0,
        0,
        &at,
    );

    // mini: 0.15 + 0.60 = 0.75
    // 4o:   2.50 + 10.0 = 12.50
    approx_eq(cost_mini, 0.75, 1e-9, "gpt-4o-mini total");
    approx_eq(cost_full, 12.50, 1e-9, "gpt-4o total");
    assert!(
        cost_full > cost_mini * 15.0,
        "gpt-4o must be >15× more expensive than gpt-4o-mini at the cost level. \
         If this fails, a longest-prefix-match regression has reintroduced the \
         16× billing error class."
    );
}

// ===========================================================================
// Section 5 — Tier-break test.
// ===========================================================================

/// Proves: `gemini-2.5-pro` over the 200K input-token tier uses tier rates
/// ($2.50/$15.00), not base rates ($1.25/$10.00).
///
/// Anti-fake: an implementation that stored tiers but never consulted them
/// during cost computation would silently undercharge by 2× on long-context
/// Gemini turns.
#[test]
fn h4_gemini_2_5_pro_tier_break_above_200k() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();

    let entry = pricing
        .resolve("gemini-2.5-pro-002", &now)
        .expect("gemini-2.5-pro must resolve");
    assert!(
        !entry.tiers.is_empty(),
        "gemini-2.5-pro must have at least one tier-break entry (200K threshold)"
    );
    let tier: &TierEntry = entry
        .tiers
        .iter()
        .find(|t| t.threshold_input_tokens == 200_000)
        .expect("gemini-2.5-pro must declare a 200_000-token tier break");
    assert!((tier.input_per_m - 2.5).abs() < 1e-9);
    assert!((tier.output_per_m - 15.0).abs() < 1e-9);

    // Cost level: 300K input + 1K output. Above the 200K threshold the
    // tier rates apply for the whole turn (audit's tier semantics).
    let cost_above =
        db::compute_cost_usd(&pricing, "gemini-2.5-pro-002", 300_000, 1_000, 0, 0, &now);
    let expected_above = (300_000.0 * 2.5 + 1_000.0 * 15.0) / 1_000_000.0;
    approx_eq(
        cost_above,
        expected_above,
        1e-9,
        "gemini-2.5-pro >200K must use tier rates",
    );

    // Sanity: the same shape but at the base rate must produce a different
    // (lower) number, so the test would fail if tiers were ignored.
    let cost_at_base_rates = (300_000.0 * 1.25 + 1_000.0 * 10.0) / 1_000_000.0;
    assert!(
        cost_above > cost_at_base_rates,
        "tier-break must produce strictly higher cost than base rates at \
         300K input — got {} vs base-rate {}",
        cost_above,
        cost_at_base_rates
    );
}

/// Proves: `gemini-2.5-pro` at sub-200K uses base rates (NOT tier).
#[test]
fn h4_gemini_2_5_pro_below_200k_uses_base_rates() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();

    let cost = db::compute_cost_usd(
        &pricing,
        "gemini-2.5-pro-002",
        100_000, // <200K
        1_000,
        0,
        0,
        &now,
    );
    let expected = (100_000.0 * 1.25 + 1_000.0 * 10.0) / 1_000_000.0;
    approx_eq(cost, expected, 1e-9, "gemini-2.5-pro at 100K = base rates");
}

// ===========================================================================
// Section 6 — Production wiring (hot path).
// ===========================================================================

/// Build a Gemini SSE response with the given model name.
fn build_gemini_sse(model: &str) -> Vec<u8> {
    let json = serde_json::json!({
        "candidates":[{"content":{"parts":[{"text":"Hi"}],"role":"model"},"finishReason":"STOP","index":0}],
        "usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8,"totalTokenCount":20},
        "modelVersion": model,
    });
    let line = format!("event: message\ndata: {}\n\n", json);
    line.into_bytes()
}

/// Build a minimal Gemini request body.
fn build_gemini_request() -> Vec<u8> {
    serde_json::to_vec(&serde_json::json!({
        "contents": [{"parts": [{"text": "Say hello"}]}]
    }))
    .unwrap()
}

/// Proves: the production hot path (`process_capture_with_pipeline`) still
/// produces a non-zero `cost_usd` after H4. This is the integration test that
/// the implementer wired the new `at: &OffsetDateTime` argument correctly at
/// the production call site (`gateway/src/gateway/mod.rs:1904`).
///
/// Anti-fake: if the implementer only updated the function signature but
/// forgot to thread the timestamp through, OR if they passed a `0` epoch
/// that landed before any `effective_from`, the resolved entry would be
/// None and `cost_usd` would be 0.0 — which this test rejects.
#[test]
fn h4_production_hot_path_gemini_yields_nonzero_cost() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    // `gemini-2.5-flash` is in the canonical table; small token counts
    // mean the cost will be tiny but strictly positive.
    let request_bytes = build_gemini_request();
    let response_bytes = build_gemini_sse("gemini-2.5-flash");

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        &request_bytes,
        &response_bytes,
        None, // no WAL
        None, // no metrics
    )
    .expect("process_capture_with_pipeline must succeed");

    let cost = turn
        .cost_usd
        .expect("cost_usd must be Some(_) when the model is in the pricing table");
    assert!(
        cost > 0.0,
        "cost_usd must be strictly positive on the hot path \
         (model=gemini-2.5-flash, 12 input + 8 output tokens). Got {}.\
         If this is 0.0, the production call site at gateway/src/gateway/mod.rs:1904 \
         likely failed to thread the OffsetDateTime through, or passed a \
         pre-effective_from timestamp.",
        cost
    );

    // Tighter sanity: 12 input × $0.15/M + 8 output × $0.60/M = 0.0000018 + 0.0000048
    let expected = (12.0 * 0.15 + 8.0 * 0.60) / 1_000_000.0;
    approx_eq(cost, expected, 1e-12, "hot-path gemini-2.5-flash");
}

/// Proves: an unknown model on the hot path still cleanly produces a
/// `cost_usd` of 0.0 (or None) without panicking.
#[test]
fn h4_production_hot_path_unknown_model_does_not_panic() {
    let (pipeline, _tmp) = make_pipeline();
    let mut session_mgr = SessionManager::new();

    let request_bytes = build_gemini_request();
    // Force an unknown model name in the response.
    let response_bytes = build_gemini_sse("not-a-real-model-2099");

    let turn = gateway::process_capture_with_pipeline(
        &pipeline,
        &mut session_mgr,
        "google",
        &request_bytes,
        &response_bytes,
        None,
        None,
    )
    .expect("process_capture_with_pipeline must succeed even for unknown models");

    match turn.cost_usd {
        None => { /* acceptable: model parsed but no pricing row → cost = None */ }
        Some(c) => assert_eq!(
            c, 0.0,
            "unknown models must produce cost_usd = 0.0 (matches pre-fix \
             fall-through), got {}",
            c
        ),
    }
}

/// Proves: each of the four production call sites still references
/// `compute_cost_usd`. This is a structural guard — if the implementer
/// accidentally deleted (or renamed-without-replacing) one of the call
/// sites, this catches it before the integration test hides it.
///
/// The audit names the four sites:
///   - gateway/src/capture/recovery.rs (orphan replay)
///   - gateway/src/gateway/mod.rs (process_capture_with_pipeline)
///   - gateway/src/gateway/mod.rs (Codex / WS path)
///   - gateway/src/gateway/mod.rs (Codex / WS path 2)
#[test]
fn h4_all_four_production_call_sites_still_compute_cost() {
    let recovery = read_to_string(
        &PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("capture")
            .join("recovery.rs"),
    );
    assert!(
        recovery.contains("compute_cost_usd"),
        "capture/recovery.rs must still call compute_cost_usd (orphan replay site)"
    );

    // Batch 6 H2 split `gateway/src/gateway/mod.rs` into five sub-modules.
    // The compute_cost_usd call sites that were previously in mod.rs
    // (process_capture_with_pipeline + 2 WS/Codex paths) now live in
    // `capture_pipeline.rs` and `run_listener.rs`. Concatenate every
    // `.rs` file under `src/gateway/` so the call-count check still holds.
    let gateway_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("gateway");
    let mut gateway_src = String::new();
    for entry in fs::read_dir(&gateway_dir)
        .expect("read gateway dir")
        .flatten()
    {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            gateway_src.push_str(&read_to_string(&path));
            gateway_src.push('\n');
        }
    }
    let count = gateway_src.matches("compute_cost_usd").count();
    assert!(
        count >= 3,
        "gateway/* must contain at least 3 compute_cost_usd call sites \
         (process_capture_with_pipeline + 2 WS / Codex paths). Found {}.",
        count
    );

    // The new signature must thread through OffsetDateTime at every site.
    // We don't try to count exactly four — clippy or rustfmt could merge a
    // helper — but we verify both files mention OffsetDateTime alongside
    // compute_cost_usd, indicating the timestamp parameter is present.
    assert!(
        recovery.contains("OffsetDateTime") || recovery.contains("Rfc3339"),
        "capture/recovery.rs must reference OffsetDateTime (the original \
         record timestamp is load-bearing for historical replay correctness)"
    );
    assert!(
        gateway_src.contains("OffsetDateTime") || gateway_src.contains("now_utc"),
        "gateway/mod.rs must reference OffsetDateTime (production sites \
         must pass the timestamp into compute_cost_usd)"
    );
}

// ===========================================================================
// Section 7 — Cache pricing semantics preserved (provider-agnostic encoding).
//
// The audit requires cache pricing semantics to be preserved EXACTLY as the
// pre-fix code computed them, but encoded as ABSOLUTE per-million rates per
// entry, not multipliers. This section asserts the absolute rates land in
// the canonical TOML correctly for at least one model per provider family.
// ===========================================================================

/// Proves: Anthropic cache rates in the canonical table are encoded as
/// 1.25× (create) and 0.10× (read) of input rate.
#[test]
fn h4_anthropic_cache_rates_absolute_encoding() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();

    let entry = pricing
        .resolve("claude-opus-4-6-20251101", &now)
        .expect("claude-opus-4-6 must resolve");

    // Opus 4.6: input=$5/M, so cache_create=$6.25/M, cache_read=$0.50/M.
    assert!(
        (entry.cache_create_per_m - 6.25).abs() < 1e-9,
        "claude-opus-4-6 cache_create_per_m must be 6.25 (= 5.0 × 1.25), got {}",
        entry.cache_create_per_m
    );
    assert!(
        (entry.cache_read_per_m - 0.50).abs() < 1e-9,
        "claude-opus-4-6 cache_read_per_m must be 0.50 (= 5.0 × 0.10), got {}",
        entry.cache_read_per_m
    );
}

/// Proves: Gemini cache rates in the canonical table are encoded as
/// 0 (create) and 0.25× input (read).
#[test]
fn h4_gemini_cache_rates_absolute_encoding() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();

    let entry = pricing
        .resolve("gemini-2.5-flash-001", &now)
        .expect("gemini-2.5-flash must resolve");
    // Flash: input=$0.15/M → cache_create=0, cache_read=$0.0375/M
    assert!(
        entry.cache_create_per_m.abs() < 1e-9,
        "gemini-2.5-flash cache_create_per_m must be 0 (Gemini has no \
         cache-create concept), got {}",
        entry.cache_create_per_m
    );
    assert!(
        (entry.cache_read_per_m - 0.0375).abs() < 1e-9,
        "gemini-2.5-flash cache_read_per_m must be 0.0375 (= 0.15 × 0.25), got {}",
        entry.cache_read_per_m
    );
}

/// Proves: OpenAI cache rates in the canonical table are encoded as
/// 0 (create) and 0.50× input (read).
#[test]
fn h4_openai_cache_rates_absolute_encoding() {
    let pricing = load_canonical_pricing();
    let now = now_for_tests();

    let entry = pricing
        .resolve("gpt-4o-mini-2024-07-18", &now)
        .expect("gpt-4o-mini must resolve");
    // gpt-4o-mini: input=$0.15/M → cache_create=0, cache_read=$0.075/M
    assert!(
        entry.cache_create_per_m.abs() < 1e-9,
        "gpt-4o-mini cache_create_per_m must be 0 (OpenAI has no cache-create \
         concept), got {}",
        entry.cache_create_per_m
    );
    assert!(
        (entry.cache_read_per_m - 0.075).abs() < 1e-9,
        "gpt-4o-mini cache_read_per_m must be 0.075 (= 0.15 × 0.50), got {}",
        entry.cache_read_per_m
    );
}
