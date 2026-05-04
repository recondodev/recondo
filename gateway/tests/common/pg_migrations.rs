//! Shared helper for tests that need to inspect the PostgreSQL schema
//! defined by the canonical migration files in `api/migrations/`.
//!
//! Sprint M2 made `api/migrations/*.sql` the single source of truth for the
//! PG schema. After the H1 audit fix, the gateway no longer carries any
//! PostgreSQL DDL in source — the previously-used `PG_SCHEMA_DDL` constant
//! is gone. Tests that historically grepped that constant for invariants
//! (column presence, immutability triggers, etc.) now grep this concatenated
//! migration corpus instead, ensuring assertions track the source of truth
//! rather than a stale hand-maintained copy.

#![allow(dead_code)] // not every test binary uses this helper

pub fn pg_migration_sql() -> &'static str {
    // Concatenation order matches the natural numeric ordering of the
    // migration files on disk (001..012). This is the same order
    // `node-pg-migrate` applies them in production. Tests that need to
    // distinguish DDL constructs (e.g., CREATE TRIGGER vs CREATE INDEX)
    // must do so structurally, not by relying on concat ordering.
    concat!(
        include_str!("../../../api/migrations/001_core-tables.sql"),
        "\n",
        include_str!("../../../api/migrations/002_api-tables.sql"),
        "\n",
        include_str!("../../../api/migrations/003_triggers-indexes.sql"),
        "\n",
        include_str!("../../../api/migrations/004_compliance.sql"),
        "\n",
        include_str!("../../../api/migrations/005_reports-policies-keys.sql"),
        "\n",
        include_str!("../../../api/migrations/006_runtime-tables.sql"),
        "\n",
        include_str!("../../../api/migrations/007_fix-anomaly-events.sql"),
        "\n",
        include_str!("../../../api/migrations/008_turns-cache-defaults.sql"),
        "\n",
        include_str!("../../../api/migrations/009_heartbeats-id-default.sql"),
        "\n",
        include_str!("../../../api/migrations/010_materialized-views.sql"),
        "\n",
        include_str!("../../../api/migrations/011_attachments.sql"),
        "\n",
        include_str!("../../../api/migrations/012_turns-request-hash-index.sql"),
        "\n",
    )
}
