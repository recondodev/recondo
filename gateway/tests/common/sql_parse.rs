//! Shared SQL parsing helpers for migration-corpus integration tests.
//!
//! Two test crates (`batch1_h1_m2_tests` and `gap_fixes_phase2_tests`)
//! independently re-implemented the same statement-level structural
//! analysis of the migration corpus to prove the negative claim "no
//! `CREATE TRIGGER` targets the `sessions` table". FIND-2-1 (audit
//! round 2) consolidated those two implementations here so the next
//! strengthening (e.g. tagged dollar-quoting) updates one place.
//!
//! ## Dollar-quote support
//!
//! [`split_sql_statements`] handles the canonical `$$ ... $$` PL/pgSQL
//! body form ONLY. PostgreSQL also supports tagged dollar-quoting
//! (`$body$ ... $body$`, `$tag$ ... $tag$`, etc.) but the entire
//! migration corpus under `api/migrations/` uses `$$` exclusively. A
//! future migration introducing `$tag$ ... $tag$` would require
//! extending this parser; the failure mode would be benign (statement
//! splitting could miss a `;` inside the tagged body, causing the
//! trigger walker to see a malformed statement) but would surface at
//! code review of that migration.
//!
//! This is a deliberate scope decision per the project rule "Don't
//! design for hypothetical future requirements" (see CLAUDE.md). The
//! test corpus today uses only `$$`; adding speculative `$tag$`
//! support is out of scope for a test helper.

#![allow(dead_code)] // not every test binary uses every helper here

/// Returns CREATE TRIGGER statements in `sql` whose target table is
/// exactly `table` (matched on a word boundary so e.g.
/// `sessions_archive` is not flagged when looking for `sessions`).
///
/// `CREATE INDEX`, `CREATE TABLE`, and any other `CREATE ...`
/// statements are ignored regardless of the `ON` clause they may
/// carry — only `CREATE TRIGGER` matches.
///
/// Returned statements are owned, trimmed of leading whitespace, and
/// stripped of the terminating `;`.
pub fn trigger_statements_targeting(sql: &str, table: &str) -> Vec<String> {
    let statements = split_sql_statements(sql);
    let mut hits: Vec<String> = Vec::new();
    let on_table_lower = format!(" on {}", table.to_lowercase());
    for stmt in statements {
        let trimmed = stmt.trim_start();
        let lower = trimmed.to_lowercase();
        if !lower.starts_with("create trigger") {
            continue;
        }
        // Find ` on <table>` and require the next char to be a non-word
        // character (whitespace, `(`, `;`, end-of-string, etc.) so we
        // don't accidentally match a column or table name like
        // `sessions_id` or `sessions_archive`.
        let mut search_from = 0usize;
        while let Some(idx) = lower[search_from..].find(&on_table_lower) {
            let abs = search_from + idx;
            let end = abs + on_table_lower.len();
            let next_char = lower[end..].chars().next();
            let is_word = next_char.is_some_and(|c| c == '_' || c.is_ascii_alphanumeric());
            if !is_word {
                hits.push(trimmed.to_string());
                break;
            }
            search_from = end;
        }
    }
    hits
}

/// Splits a SQL corpus into statements by `;` while ignoring semicolons
/// that appear inside `$$ ... $$` dollar-quoted blocks (used by the
/// PL/pgSQL function bodies in migration 003).
///
/// Returned slices include surrounding whitespace but exclude the
/// terminating `;`. See module docs for the deliberate `$$`-only
/// scope.
pub fn split_sql_statements(sql: &str) -> Vec<&str> {
    let bytes = sql.as_bytes();
    let mut statements = Vec::new();
    let mut start = 0usize;
    let mut in_dollar = false;
    let mut i = 0usize;
    while i < bytes.len() {
        if i + 1 < bytes.len() && bytes[i] == b'$' && bytes[i + 1] == b'$' {
            in_dollar = !in_dollar;
            i += 2;
            continue;
        }
        if !in_dollar && bytes[i] == b';' {
            // Safe: byte indices here only land on char boundaries
            // because `;` and `$` are ASCII and we never index inside
            // a multi-byte UTF-8 sequence.
            statements.push(&sql[start..i]);
            start = i + 1;
        }
        i += 1;
    }
    if start < bytes.len() {
        statements.push(&sql[start..]);
    }
    statements
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Single consolidated self-test for `trigger_statements_targeting`.
    /// Covers all four anti-fake cases that the two prior per-crate
    /// self-tests covered (FIND-2-1 consolidation):
    ///
    /// 1. positive — `CREATE TRIGGER ... ON sessions` IS flagged
    /// 2. negative (index)         — `CREATE INDEX ... ON sessions(...)` is NOT flagged
    /// 3. negative (other table)   — `CREATE TRIGGER ... ON turns` is NOT flagged
    /// 4. negative (word boundary) — `CREATE TRIGGER ... ON sessions_archive` is NOT flagged
    #[test]
    fn trigger_extractor_distinguishes_index_from_trigger_and_respects_word_boundary() {
        let positive =
            "CREATE TRIGGER my_trig BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION foo();";
        let negative_index = "CREATE INDEX IF NOT EXISTS idx_x ON sessions(account_uuid);";
        let negative_other_table =
            "CREATE TRIGGER tr BEFORE UPDATE ON turns FOR EACH ROW EXECUTE FUNCTION f();";
        let negative_columnish =
            "CREATE TRIGGER tr2 BEFORE UPDATE ON sessions_archive FOR EACH ROW EXECUTE FUNCTION g();";

        assert_eq!(
            trigger_statements_targeting(positive, "sessions").len(),
            1,
            "positive case: CREATE TRIGGER ON sessions must be flagged"
        );
        assert_eq!(
            trigger_statements_targeting(negative_index, "sessions").len(),
            0,
            "CREATE INDEX ON sessions(...) must NOT be flagged"
        );
        assert_eq!(
            trigger_statements_targeting(negative_other_table, "sessions").len(),
            0,
            "CREATE TRIGGER ON turns must NOT be flagged when looking for sessions"
        );
        assert_eq!(
            trigger_statements_targeting(negative_columnish, "sessions").len(),
            0,
            "CREATE TRIGGER ON sessions_archive must NOT be flagged when looking for sessions \
             (word-boundary check)"
        );

        // Combined corpus: should still find exactly one offender.
        let combined = format!(
            "{}\n{}\n{}\n{}\n",
            positive, negative_index, negative_other_table, negative_columnish
        );
        let hits = trigger_statements_targeting(&combined, "sessions");
        assert_eq!(
            hits.len(),
            1,
            "expected exactly one offender across combined corpus, got {:?}",
            hits
        );
    }

    /// `split_sql_statements` must ignore `;` inside `$$ ... $$` blocks
    /// so PL/pgSQL function bodies (which contain semicolons between
    /// statements) parse as one statement, not many.
    #[test]
    fn split_sql_statements_ignores_semicolons_in_dollar_quotes() {
        let sql = "CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'no'; END; $$ LANGUAGE plpgsql; CREATE TRIGGER t BEFORE UPDATE ON turns FOR EACH ROW EXECUTE FUNCTION f();";
        let stmts = split_sql_statements(sql);
        assert_eq!(
            stmts.len(),
            2,
            "function body containing inner `;` must count as one statement, \
             then the trigger as a second. Got: {:#?}",
            stmts
        );
    }
}
