//! Shared helpers for gateway integration tests.
//!
//! Each Rust integration test in `gateway/tests/` is compiled as its own
//! binary. To share code across binaries we put it under `tests/common/`
//! and `mod common;` it from each test file that needs it. Cargo
//! deliberately treats `tests/common/mod.rs` as a non-binary module
//! (not as a test target), so the helpers are quietly available to
//! every `tests/*.rs` that opts in.
//!
//! Helpers here MUST gate themselves behind the same feature flags as
//! their callers — most of this module needs `postgres-tests` to even
//! compile, so the entire `pg_lock` submodule is `#[cfg]`-gated below.

#![allow(dead_code)] // not every test binary uses every helper

/// Ephemeral postgres container for integration tests. See
/// `pg_container.rs` for lifetime semantics. Replaces both the
/// previous "expect `RECONDO_DB_URL` env var" pattern and the
/// `pg_lock.rs` cross-process advisory-lock helper — both became
/// obsolete once each test process gets its own private DB.
#[cfg(feature = "postgres-tests")]
pub mod pg_container;

/// Ephemeral ministack container for S3-integration tests. Mirrors
/// `pg_container` — `OnceLock`-backed, container cleanup on test
/// binary exit.
#[cfg(feature = "s3-tests")]
pub mod s3_container;

/// `api/migrations/*.sql` concatenated into one `&'static str` via
/// `include_str!`. Used by tests that need to assert schema invariants
/// (column presence, immutability triggers, etc.) against the source of
/// truth rather than a stale hand-maintained DDL copy.
pub mod pg_migrations;

/// Statement-level SQL parsing for the migration corpus
/// (`trigger_statements_targeting`, `split_sql_statements`). Shared
/// across `batch1_h1_m2_tests` and `gap_fixes_phase2_tests` per
/// FIND-2-1 (audit round 2 consolidation).
pub mod sql_parse;

/// In-memory `WritePipeline` builder shared by the five capture-pipeline
/// integration tests migrated off the deleted `process_capture` helpers
/// in Batch 2. Consolidated here per FIND-1-DE-1 (audit round 1, fix
/// round 1) so the five byte-identical copies become one definition.
pub mod pipeline;
