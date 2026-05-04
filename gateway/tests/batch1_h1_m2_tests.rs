//! Behavioral tests for Batch 1 of the gateway audit follow-up.
//!
//! Two findings are addressed:
//!
//! - **H1** — `gateway/src/storage/pg_schema_ddl.rs` (the 198-LOC
//!   `PG_SCHEMA_DDL: &str` constant) is deleted. Sprint M2 made
//!   `api/migrations/*.sql` the single source of truth for the PG schema;
//!   the gateway must contain no PG DDL.
//! - **M2** — Two `bail!("...not yet supported...")` messages in the
//!   gateway source are rephrased so the literal substring `"not yet"`
//!   no longer appears (the `grep 'bail!.*not yet'` stub-detection sweep
//!   must return zero hits in `gateway/src/`). The bails must still fire
//!   on the same trigger conditions.

#![allow(dead_code)]

mod common;

use common::pg_migrations::pg_migration_sql;

fn read_gateway_source(relative_path: &str) -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest_dir).join(relative_path);
    std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "Failed to read source file {}: {}. \
             Tests inspect source code to verify invariants.",
            path.display(),
            e
        )
    })
}

fn all_gateway_src_rs_concatenated() -> String {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_root = std::path::Path::new(manifest_dir).join("src");
    let mut buf = String::new();
    walk_rs_into(&src_root, &mut buf);
    buf
}

fn walk_rs_into(dir: &std::path::Path, buf: &mut String) {
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

#[test]
fn h1_pg_schema_ddl_source_file_is_deleted() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let path = std::path::Path::new(manifest_dir).join("src/storage/pg_schema_ddl.rs");
    assert!(
        !path.exists(),
        "{} must NOT exist after H1.",
        path.display()
    );
}

#[test]
fn h1_no_gateway_src_file_references_pg_schema_ddl() {
    let all_src = all_gateway_src_rs_concatenated();
    assert!(
        !all_src.contains("PG_SCHEMA_DDL"),
        "Production source under gateway/src/ must not reference PG_SCHEMA_DDL"
    );
    assert!(
        !all_src.contains("pg_schema_ddl"),
        "Production source under gateway/src/ must not reference pg_schema_ddl"
    );
}

#[test]
fn h1_storage_mod_no_longer_carries_test_support_pg_stub() {
    let source = read_gateway_source("src/storage/mod.rs");
    assert!(
        !source.contains("pub mod postgres {"),
        "src/storage/mod.rs must not contain `pub mod postgres {{ ... }}` stub"
    );
    assert!(
        !source.contains("pg_schema_ddl"),
        "src/storage/mod.rs must not mention pg_schema_ddl"
    );
}

#[test]
fn h1_storage_postgres_no_longer_reexports_pg_schema_ddl() {
    let source = read_gateway_source("src/storage/postgres.rs");
    assert!(
        !source.contains("pg_schema_ddl::PG_SCHEMA_DDL"),
        "postgres.rs must not re-export PG_SCHEMA_DDL"
    );
    assert!(
        !source.contains("PG_SCHEMA_DDL"),
        "postgres.rs must not mention PG_SCHEMA_DDL anywhere"
    );
}

#[test]
fn h1_migration_helper_concatenates_all_core_tables() {
    let sql = pg_migration_sql();
    assert!(sql.len() > 1000, "got {} bytes", sql.len());
    for table in &["sessions", "turns", "tool_calls"] {
        let needle = format!("CREATE TABLE IF NOT EXISTS {}", table);
        assert!(sql.contains(&needle), "missing `{}`", needle);
    }
}

#[test]
fn h1_turns_user_request_text_column_present_in_migration_source() {
    let sql = pg_migration_sql();
    assert!(
        sql.contains("user_request_text"),
        "migrations must define user_request_text column"
    );
}

#[test]
fn h1_immutability_triggers_present_in_migration_source() {
    let sql = pg_migration_sql();
    let lower = sql.to_lowercase();
    assert!(sql.contains("prevent_turn_mutation"));
    assert!(sql.contains("prevent_tool_call_mutation"));
    assert!(lower.contains("create trigger"));
    assert!(lower.contains("on turns"));
    assert!(lower.contains("on tool_calls"));
    assert!(lower.contains("raise exception"));
    assert!(lower.contains("immutable") || lower.contains("append-only"));
    assert!(lower.contains("before update or delete") || lower.contains("before delete or update"));

    // FIND-1-1 fix: structural matching, not substring splitting.
    //
    // The previous implementation split the corpus on the literal
    // "create trigger" and then checked the post-split blocks for
    // "on sessions". That is brittle: it conflates `CREATE TRIGGER ...
    // ON sessions` (which we forbid) with `CREATE INDEX ... ON
    // sessions(...)` (which is fine and present in migration 003).
    // The brittleness silently displaced into the migration file in
    // round 1 to make the test pass.
    //
    // The genuine fix walks the migration corpus statement-by-statement
    // (splitting on `;` outside `$$ ... $$` PL/pgSQL blocks), then for
    // each statement that begins with `CREATE TRIGGER` checks whether
    // the trigger body contains ` ON sessions` followed by a non-word
    // character (i.e., not `sessions_id` or similar). `CREATE INDEX`
    // statements are simply skipped — they cannot match.
    let offending = common::sql_parse::trigger_statements_targeting(sql, "sessions");
    assert!(
        offending.is_empty(),
        "no immutability trigger should target the sessions table — \
         sessions need UPDATE for counter fields. Offending statements: {:#?}",
        offending
    );
}

// FIND-2-1 (audit round 2): the local `trigger_statements_targeting`
// and `split_sql_statements` helpers — and their per-crate self-test —
// previously lived here. They were moved to
// `gateway/tests/common/sql_parse.rs` so the parallel implementation
// in `gap_fixes_phase2_tests` could share a single source of truth.
// Call sites here now use `common::sql_parse::trigger_statements_targeting`.
// The consolidated self-test lives in `sql_parse.rs::tests`.

#[test]
fn h1_migrated_tests_no_longer_import_pg_schema_ddl() {
    for path in &[
        "tests/d1_user_request_text_tests.rs",
        "tests/gap_fixes_phase2_tests.rs",
    ] {
        let source = read_gateway_source(path);
        assert!(
            !source.contains("PG_SCHEMA_DDL"),
            "{} must not reference PG_SCHEMA_DDL",
            path
        );
        assert!(
            !source.contains("pg_schema_ddl"),
            "{} must not reference pg_schema_ddl",
            path
        );
    }
}

#[test]
fn m2_no_gateway_src_line_contains_bail_with_not_yet() {
    // FIND-1-3 fix: strengthen the per-line walker. The previous
    // implementation only flagged single-line `bail!(... "not yet" ...)`
    // patterns. rustfmt frequently splits a long bail across lines:
    //
    //     bail!(
    //         "this feature is not yet supported with PostgreSQL"
    //     );
    //
    // Such formatting would slip past the original check. We now scan
    // the next 5 lines after any line containing `bail!` for "not yet"
    // before declaring that line clean.
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let src_root = std::path::Path::new(manifest_dir).join("src");
    let mut offending: Vec<String> = Vec::new();
    let mut walker: Vec<std::path::PathBuf> = vec![src_root];
    while let Some(dir) = walker.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walker.push(path);
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("rs") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(&path) {
                let lines: Vec<&str> = content.lines().collect();
                for (i, line) in lines.iter().enumerate() {
                    if !line.contains("bail!") {
                        continue;
                    }
                    // Same-line case.
                    if line.contains("not yet") {
                        offending.push(format!("{}:{}: {}", path.display(), i + 1, line.trim()));
                        continue;
                    }
                    // Multi-line case: scan up to 5 following lines for
                    // "not yet" before the closing `);` of the bail.
                    let look_end = (i + 6).min(lines.len());
                    for (j, next) in lines.iter().enumerate().take(look_end).skip(i + 1) {
                        if next.contains("not yet") {
                            offending.push(format!(
                                "{}:{}: bail!(... continued ...)\n  {}:{}: {}",
                                path.display(),
                                i + 1,
                                path.display(),
                                j + 1,
                                next.trim()
                            ));
                            break;
                        }
                        // Stop once we hit the closing `);` of the bail.
                        if next.contains(");") {
                            break;
                        }
                    }
                }
            }
        }
    }
    assert!(
        offending.is_empty(),
        "Found `bail!` invocations whose message contains \"not yet\":\n  {}",
        offending.join("\n  ")
    );
}

/// FIND-1-3 fix: helper that returns the body of a top-level `fn <name>`
/// in `source`, sliced precisely from `fn <name>` to (but not including)
/// the next `fn ` declaration at the same nesting level. This eliminates
/// the round-1 brittleness where a fixed 1500-byte window spilled past
/// `cmd_search` into `cmd_stats`, accidentally testing both functions
/// at once and creating fragile transitive coverage.
fn slice_fn_body<'a>(source: &'a str, fn_name: &str) -> &'a str {
    let needle = format!("fn {}", fn_name);
    // FIND-2-3 fix: use `assert!` rather than `panic!`. The assertion
    // failure is reported through nextest's standard formatter (with a
    // friendlier message for the rename-this-fn case) and the
    // subsequent `.unwrap()` is provably safe — `contains` and `find`
    // share the same scan, so if the assert passes, find returns Some.
    assert!(
        source.contains(&needle),
        "`{}` must exist in source — was the function renamed?",
        needle
    );
    let start = source.find(&needle).unwrap();
    // Find the next `\nfn ` (same indentation level as a top-level fn);
    // fall back to end-of-source if this is the last fn in the file.
    let after = &source[start + needle.len()..];
    let end_rel = after.find("\nfn ").unwrap_or(after.len());
    let end = start + needle.len() + end_rel;
    &source[start..end]
}

#[test]
fn m2_main_rs_cmd_search_bail_message_does_not_contain_not_yet() {
    let source = read_gateway_source("src/main.rs");
    let body = slice_fn_body(&source, "cmd_search");
    assert!(
        body.contains("bail!"),
        "cmd_search must still bail when invoked against PostgreSQL.\n\
         Body inspected:\n{}",
        body
    );
    assert!(
        !body.contains("not yet"),
        "cmd_search bail must not contain \"not yet\".\n\
         Body inspected:\n{}",
        body
    );
}

#[test]
fn m2_main_rs_cmd_stats_bail_message_does_not_contain_not_yet() {
    // FIND-1-3 fix: parallel coverage for cmd_stats (the third site
    // discovered during round 1 — see FIND-1-4). Previously, cmd_stats
    // was covered only incidentally by spillover from cmd_search's
    // 1500-byte window. With precise slicing, each function gets its
    // own dedicated assertion.
    let source = read_gateway_source("src/main.rs");
    let body = slice_fn_body(&source, "cmd_stats");
    assert!(
        body.contains("bail!"),
        "cmd_stats must still bail when invoked against PostgreSQL.\n\
         Body inspected:\n{}",
        body
    );
    assert!(
        !body.contains("not yet"),
        "cmd_stats bail must not contain \"not yet\".\n\
         Body inspected:\n{}",
        body
    );
}

#[test]
fn m2_alerts_mod_https_webhook_bail_message_does_not_contain_not_yet() {
    let source = read_gateway_source("src/alerts/mod.rs");
    let guard_pos = source
        .find("starts_with(\"https://\")")
        .expect("alerts/mod.rs must still gate https:// URLs");
    let window_end = (guard_pos + 600).min(source.len());
    let window = &source[guard_pos..window_end];
    assert!(window.contains("bail!"), "guard must still bail!");
    assert!(
        !window.contains("not yet"),
        "https-webhook bail must not contain \"not yet\":\n{}",
        window
    );
}

#[tokio::test]
async fn m2_https_webhook_url_still_returns_error_after_rephrase() {
    use recondo_gateway::alerts::dispatch_anomaly_webhook;
    use recondo_gateway::db::AnomalyEventRecord;

    let anomaly = AnomalyEventRecord {
        id: "anomaly-batch1-m2".to_string(),
        session_id: "sess-batch1-m2".to_string(),
        turn_id: "turn-batch1-m2".to_string(),
        anomaly_type: "tool_definition_drift".to_string(),
        severity: "warning".to_string(),
        description: "M2 rephrase regression test".to_string(),
        detected_at: "2026-05-02T00:00:00Z".to_string(),
        resolved_at: None,
        metadata: r#"{"test":"m2_rephrase"}"#.to_string(),
    };
    let result = dispatch_anomaly_webhook(&anomaly, "https://example.invalid/hook").await;
    assert!(result.is_err(), "must still reject https://");
    let err_msg = format!("{}", result.unwrap_err());
    assert!(
        !err_msg.contains("not yet"),
        "runtime error must not contain \"not yet\". Got: {}",
        err_msg
    );
    // FIND-1-6 fix: tighten the assertion. The previous form
    // `contains("http") || contains("proxy")` was too permissive — it
    // would pass on any error message containing "https://", "HTTP/1.1",
    // or stray URLs. The test is supposed to enforce that the rephrased
    // bail message points the operator at the right remediation:
    //   1. switch to an `http://` webhook URL, OR
    //   2. configure a proxy.
    // We assert on the specific guidance phrases the rephrase chose,
    // not bare substrings of "http".
    let lower = err_msg.to_lowercase();
    assert!(
        lower.contains("http webhook") || lower.contains("http://") || lower.contains("proxy"),
        "runtime error should still point the operator at the correct remediation \
         (an `http://` webhook URL or a proxy). Got: {}",
        err_msg
    );
}
