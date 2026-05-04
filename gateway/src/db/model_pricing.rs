//! Externalized model pricing table (Batch 5 H4).
//!
//! Replaces the hardcoded if-else cost-rate chain previously embedded in
//! `compute_cost_usd`. The canonical source is `compliance/model-pricing.toml`,
//! embedded into the binary at compile time via `include_str!` and parsed
//! once per process (`OnceLock`).
//!
//! ## Resolution semantics
//!
//! `PricingTable::resolve(model, at)` returns the entry whose `prefix` is the
//! longest match against `model` AND whose `effective_from` is the greatest
//! value ≤ `at`. This guarantees:
//!   * `gpt-4o-mini-...` resolves to the `gpt-4o-mini` entry (NOT `gpt-4o`)
//!     — closing the historical 16× billing-error class (R1-12).
//!   * Historical replays via `recovery.rs` use the rates that were in effect
//!     at the original capture timestamp.
//!
//! Entries are sorted at load time by `(prefix.len() DESC, effective_from
//! DESC)`. Resolution is a linear scan that picks the first entry where
//! `model.starts_with(prefix) && effective_from ≤ at`.
//!
//! ## Validation rules
//!
//! At load time the parser rejects:
//!   * Empty `prefix = ""`.
//!   * Duplicate `(prefix, effective_from)` tuples.
//!
//! Overlapping prefixes with the same `effective_from` (e.g. `claude-opus-4-6`
//! vs `claude-opus-4`) are intentionally allowed — longest-prefix-match
//! disambiguates them at resolve time.

use std::sync::OnceLock;

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// One row in the pricing table.
#[derive(Debug, Clone)]
pub struct PricingEntry {
    pub prefix: String,
    pub effective_from: OffsetDateTime,
    pub input_per_m: f64,
    pub output_per_m: f64,
    pub cache_create_per_m: f64,
    pub cache_read_per_m: f64,
    pub tiers: Vec<TierEntry>,
}

/// A tier-break override of the entry-level input/output rates above a
/// token-count threshold.
///
/// # Predicate semantics (FIND-1-4)
///
/// The tier applies when `input_tokens > threshold_input_tokens` — strict
/// greater-than. At exactly `input_tokens == threshold_input_tokens` the
/// entry-level base rates apply, NOT this tier. Google's published policy
/// for Gemini 2.5 Pro reads "for prompts longer than 200,000 tokens",
/// which is consistent with strict `>`. Any future provider that publishes
/// `>=` semantics for a tier break needs a separate field (or one less
/// than the published threshold encoded here).
///
/// # Cache rates are NOT tier-overridden (FIND-1-6)
///
/// `TierEntry` only overrides `input_per_m` and `output_per_m`. The
/// per-entry `cache_create_per_m` and `cache_read_per_m` rates always
/// apply regardless of `input_tokens` — there is no per-tier cache
/// override in the schema today. For Gemini 2.5 Pro, this means a turn
/// over the 200K threshold with cache reads is billed at the entry-level
/// cache rate, not a (hypothetical) tiered cache rate. If a future
/// provider's tier pricing changes cache rates, extend this struct with
/// optional `cache_create_per_m` / `cache_read_per_m` fields.
#[derive(Debug, Clone, Deserialize)]
pub struct TierEntry {
    /// Strict `>` threshold (see struct-level docs). Tier applies only
    /// when `input_tokens > threshold_input_tokens`; exactly-at-threshold
    /// uses entry-level base rates.
    pub threshold_input_tokens: i64,
    pub input_per_m: f64,
    pub output_per_m: f64,
}

/// The canonical pricing table.
///
/// Entries are kept sorted by `(prefix.len() DESC, effective_from DESC)` so
/// `resolve` is a linear scan returning the first match. Tables are typically
/// small (~30 rows), so the linear scan is faster than any indexed structure.
#[derive(Debug, Clone, Default)]
pub struct PricingTable {
    entries: Vec<PricingEntry>,
}

#[derive(Deserialize)]
struct RawTable {
    #[serde(default)]
    pricing: Vec<RawEntry>,
}

#[derive(Deserialize)]
struct RawEntry {
    prefix: String,
    effective_from: String,
    input_per_m: f64,
    output_per_m: f64,
    cache_create_per_m: f64,
    // FIND-1-3 (round 1 fix): required, NOT Option<f64>. The asymmetric
    // default (cache_read defaulting to 0.0 while cache_create was required)
    // meant a TOML row that forgot cache_read_per_m silently undercharged
    // every cache-read token while a missing cache_create_per_m failed to
    // load. Now both are required — silent zero-rate is impossible.
    cache_read_per_m: f64,
    #[serde(default)]
    tiers: Vec<TierEntry>,
}

impl PricingTable {
    /// Parse a TOML string into a validated `PricingTable`.
    ///
    /// Validation:
    ///   * Empty `prefix = ""` is rejected.
    ///   * Duplicate `(prefix, effective_from)` tuples are rejected.
    ///   * Missing `cache_read_per_m` causes a load-time error (FIND-1-3).
    ///     Both cache rates are required; silent zero-rate is impossible.
    pub fn load_from_toml(toml_str: &str) -> Result<Self> {
        let raw: RawTable =
            toml::from_str(toml_str).context("failed to parse model-pricing TOML")?;

        let mut entries: Vec<PricingEntry> = Vec::with_capacity(raw.pricing.len());

        for row in raw.pricing {
            if row.prefix.is_empty() {
                bail!("invalid pricing entry: prefix must not be empty");
            }

            let effective_from = OffsetDateTime::parse(&row.effective_from, &Rfc3339)
                .with_context(|| {
                    format!(
                        "invalid pricing entry: effective_from `{}` is not RFC3339",
                        row.effective_from
                    )
                })?;

            // Reject duplicate (prefix, effective_from) tuples — silent
            // last-wins semantics are an audit anti-pattern.
            if entries
                .iter()
                .any(|e| e.prefix == row.prefix && e.effective_from == effective_from)
            {
                return Err(anyhow!(
                    "duplicate pricing entry for prefix `{}` at effective_from `{}` \
                     (NOT silent last-wins; remove or distinguish the duplicate)",
                    row.prefix,
                    row.effective_from
                ));
            }

            entries.push(PricingEntry {
                prefix: row.prefix,
                effective_from,
                input_per_m: row.input_per_m,
                output_per_m: row.output_per_m,
                cache_create_per_m: row.cache_create_per_m,
                cache_read_per_m: row.cache_read_per_m,
                tiers: row.tiers,
            });
        }

        // Sort by (prefix.len() DESC, effective_from DESC) so that linear
        // scan in `resolve` produces longest-prefix + most-recent rates.
        entries.sort_by(|a, b| {
            b.prefix
                .len()
                .cmp(&a.prefix.len())
                .then_with(|| b.effective_from.cmp(&a.effective_from))
        });

        Ok(PricingTable { entries })
    }

    /// Resolve the pricing entry that applies to `model` at time `at`.
    ///
    /// Returns the entry with the longest `prefix` matching `model` AND the
    /// greatest `effective_from` ≤ `at`. Returns `None` if no entry matches
    /// (unknown model, or query before any `effective_from`).
    pub fn resolve(&self, model: &str, at: &OffsetDateTime) -> Option<&PricingEntry> {
        self.entries
            .iter()
            .find(|e| model.starts_with(&e.prefix) && e.effective_from <= *at)
    }

    /// Number of entries (for diagnostics).
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// True iff the table has no entries.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Embedded canonical TOML, baked at compile time.
const CANONICAL_TOML: &str = include_str!("../../../compliance/model-pricing.toml");

/// Process-wide canonical pricing table.
///
/// Loaded lazily on first call from the embedded TOML and cached for the
/// process lifetime. Panics if the canonical TOML fails to parse — this is
/// a build-time error caught by the test suite.
pub fn canonical() -> &'static PricingTable {
    static CANONICAL: OnceLock<PricingTable> = OnceLock::new();
    CANONICAL.get_or_init(|| {
        PricingTable::load_from_toml(CANONICAL_TOML)
            .expect("invalid canonical compliance/model-pricing.toml")
    })
}
