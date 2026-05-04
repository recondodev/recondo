//! Batch 8 — Audit follow-up M4: xtask `syn`-based driver-discipline check.
//!
//! Audit reference: `docs/GATEWAY_AUDIT_2026_05_02.md` M4 (lines ~150-160).
//!
//! # What these tests guard
//!
//! Recondo's gateway is structured around a driver/use-case boundary.
//! Driver modules are the only places allowed to import async runtimes,
//! TLS stacks, HTTP clients, and CLI parsers (`tokio`, `tokio_postgres`,
//! `rustls`, `clap`, `reqwest`, `aws_sdk_s3`, `aws_config`). Use-case
//! modules — the bulk of the gateway business logic — must remain pure
//! enough to test without spinning up a runtime.
//!
//! M4 introduces an `xtask` crate with a `lint-arch` subcommand that
//! enforces this rule by parsing every `.rs` file under `gateway/src/`
//! with `syn` and rejecting forbidden imports in use-case files. CI runs
//! it via `just lint-arch`.
//!
//! These tests are written BEFORE the implementation. They MUST fail on
//! `main` today (no root `Cargo.toml` workspace, no `xtask/`, no
//! `lint-arch` recipe) and pass after Batch 8 ships.
//!
//! # Categories
//!
//! 1. Source-level structural tests — root workspace, xtask crate,
//!    justfile target, CLAUDE.md docs.
//! 2. `syn`-based — confirm the implementation parses with `syn`, not
//!    a regex grep.
//! 3. Behavioral (clean state) — invoke xtask against the live tree,
//!    assert exit 0.
//! 4. Behavioral (violation detection) — invoke xtask against a
//!    synthetic tree with a forbidden import, assert non-zero exit and
//!    diagnostic output.

#![allow(clippy::needless_collect)]

use serial_test::serial;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// CARGO_MANIFEST_DIR points at `<repo>/gateway`. Strip the trailing
/// segment to reach the repo root, where the workspace `Cargo.toml`
/// and the `xtask/` crate live.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("gateway crate dir must have a parent (repo root)")
        .to_path_buf()
}

fn read_repo_file(rel: &str) -> String {
    let path = repo_root().join(rel);
    fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {}: {}", path.display(), e))
}

/// Return the path to the pre-built xtask binary.
///
/// Tests in this file invoke xtask many times across many test
/// binaries running in parallel. Building it on-demand via
/// `cargo build --package xtask` from inside the tests was flaky:
/// concurrent `cargo` invocations serialised on the package-cache
/// lock and occasionally returned success while the on-disk binary
/// was being shuffled by a parallel build, surfacing as
/// `spawn xtask: NotFound` or empty-output assertions.
///
/// Instead, the binary is built ONCE before nextest runs — the
/// `just` recipes (`test`, `test-pg`, `test-s3`, `ci`, `ci-full`)
/// chain `cargo build --package xtask` first. This helper just
/// returns the path; tests fail with a clear "run cargo build
/// --package xtask" message if it doesn't exist.
fn xtask_binary() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let target_dir = std::env::var("CARGO_TARGET_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| repo_root().join("target"));
        let bin = target_dir.join("debug").join("xtask");
        if !bin.exists() {
            panic!(
                "xtask binary not found at {}. Run `cargo build --package \
                 xtask` (or use `just test`/`just test-pg`/`just test-s3` \
                 which build it for you).",
                bin.display()
            );
        }
        bin
    })
    .as_path()
}

fn try_read_repo_file(rel: &str) -> Option<String> {
    fs::read_to_string(repo_root().join(rel)).ok()
}

// ---------------------------------------------------------------------------
// 1. Source-level structural tests
// ---------------------------------------------------------------------------

/// Test: m4_root_cargo_toml_is_a_workspace
///
/// Proves: a `Cargo.toml` exists at the repo root and declares a
/// `[workspace]` containing the `gateway` and `xtask` members. The
/// xtask crate cannot be invoked via `cargo run --package xtask`
/// without this workspace wiring.
///
/// Anti-fake property: substring assertion is on the `[workspace]`
/// header AND both member names. A stub root Cargo.toml that only
/// contains `[package]` would not satisfy this test.
#[test]
fn m4_root_cargo_toml_is_a_workspace() {
    let path = repo_root().join("Cargo.toml");
    assert!(
        path.exists(),
        "Batch 8 / M4 requires a root Cargo.toml at {} that declares a \
         [workspace] containing 'gateway' and 'xtask'. None found.",
        path.display()
    );
    let src = read_repo_file("Cargo.toml");
    assert!(
        src.contains("[workspace]"),
        "Root Cargo.toml exists but does not contain a [workspace] table. \
         Got:\n{}",
        src
    );
    assert!(
        src.contains("\"gateway\""),
        "Root Cargo.toml [workspace] does not list 'gateway' as a member. \
         Got:\n{}",
        src
    );
    assert!(
        src.contains("\"xtask\""),
        "Root Cargo.toml [workspace] does not list 'xtask' as a member. \
         Got:\n{}",
        src
    );
}

/// Test: m4_root_workspace_uses_resolver_2
///
/// Proves: the root workspace declares `resolver = "2"`. Edition 2021
/// + workspace requires explicit resolver to avoid the resolver-1
///   feature unification footgun.
///
/// Anti-fake property: assertion is on the literal string `resolver = "2"`,
/// not just any mention of "resolver".
#[test]
fn m4_root_workspace_uses_resolver_2() {
    let src = read_repo_file("Cargo.toml");
    assert!(
        src.contains("resolver = \"2\""),
        "Root workspace Cargo.toml must declare resolver = \"2\". Got:\n{}",
        src
    );
}

/// Test: m4_xtask_cargo_toml_exists_with_syn_dep
///
/// Proves: `xtask/Cargo.toml` exists and declares `syn` as a
/// dependency. The implementation MUST use `syn` to parse Rust source,
/// not regex matching.
///
/// Anti-fake property: requires a `syn` dependency line — a regex-only
/// implementation would not pull `syn` in.
#[test]
fn m4_xtask_cargo_toml_exists_with_syn_dep() {
    let path = repo_root().join("xtask/Cargo.toml");
    assert!(
        path.exists(),
        "Batch 8 / M4 requires xtask/Cargo.toml at {}. None found.",
        path.display()
    );
    let src = read_repo_file("xtask/Cargo.toml");
    assert!(
        src.contains("name = \"xtask\""),
        "xtask/Cargo.toml must declare package name 'xtask'. Got:\n{}",
        src
    );
    assert!(
        src.contains("syn"),
        "xtask/Cargo.toml must depend on `syn` (the implementation parses \
         use statements with syn, not regex). Got:\n{}",
        src
    );
}

/// Test: m4_xtask_main_rs_exists
///
/// Proves: `xtask/src/main.rs` exists.
///
/// Anti-fake property: file existence + non-empty.
#[test]
fn m4_xtask_main_rs_exists() {
    let path = repo_root().join("xtask/src/main.rs");
    assert!(
        path.exists(),
        "Batch 8 / M4 requires xtask/src/main.rs at {}. None found.",
        path.display()
    );
    let src = read_repo_file("xtask/src/main.rs");
    assert!(
        !src.trim().is_empty(),
        "xtask/src/main.rs exists but is empty."
    );
}

/// Test: m4_xtask_uses_syn_not_regex
///
/// Proves: the xtask source imports the `syn` crate. The audit task
/// explicitly mandates `syn::parse_file` over regex matching because
/// regex on `use` statements has too many false positives/negatives
/// (multi-line use trees, `pub use`, nested groups, etc.).
///
/// Anti-fake property: substring grep on `syn::` (any path inside
/// the syn crate) catches an implementation that only declares syn
/// as a dependency but actually parses with regex.
#[test]
fn m4_xtask_uses_syn_not_regex() {
    let src = read_repo_file("xtask/src/main.rs");
    assert!(
        src.contains("syn::"),
        "xtask/src/main.rs must use `syn::` (e.g. syn::parse_file, \
         syn::Item::Use, syn::visit::Visit). The audit M4 mandates \
         AST parsing, not regex. Got:\n{}",
        src
    );
}

/// Test: m4_justfile_has_lint_arch_target
///
/// Proves: the root `justfile` defines a `lint-arch` recipe. The
/// recipe must invoke `cargo run` against the xtask package.
///
/// Anti-fake property: requires both the recipe header (`lint-arch:`)
/// AND a body that runs the xtask via cargo. A recipe that just
/// echoes "ok" would fail the cargo-invocation check.
#[test]
fn m4_justfile_has_lint_arch_target() {
    let src = read_repo_file("justfile");
    assert!(
        src.contains("lint-arch"),
        "justfile must define a `lint-arch` recipe. Got justfile:\n{}",
        src
    );
    // Recipe header is on its own line with a colon.
    let has_recipe = src.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with("lint-arch:") || t.starts_with("lint-arch ")
    });
    assert!(
        has_recipe,
        "justfile contains the string `lint-arch` but no recipe \
         header line `lint-arch:` was found. The recipe must be a \
         real just target so `just lint-arch` works."
    );
    assert!(
        src.contains("cargo run") && src.contains("xtask"),
        "justfile lint-arch recipe must invoke the xtask via \
         `cargo run ... --package xtask ... lint-arch` (or equivalent). \
         Got justfile:\n{}",
        src
    );
}

/// Test: m4_justfile_ci_runs_lint_arch
///
/// Proves: the `ci` recipe in `justfile` runs `lint-arch` so CI
/// catches violations. Without this, the lint exists but isn't
/// enforced.
///
/// Anti-fake property: greps the `ci` recipe specifically (not just
/// any occurrence of `lint-arch` in the file). An implementer who
/// only added the recipe but forgot to wire it into `ci` would fail
/// here.
#[test]
fn m4_justfile_ci_runs_lint_arch() {
    let src = read_repo_file("justfile");
    let mut in_ci = false;
    let mut ci_body = String::new();
    for line in src.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("ci:") || trimmed.starts_with("ci ") {
            in_ci = true;
            ci_body.push_str(line);
            ci_body.push('\n');
            continue;
        }
        if in_ci {
            // Recipe body lines are indented; a new top-level line
            // (no leading whitespace, contains a `:` or is a comment
            // header) ends the recipe.
            if line.is_empty() || line.starts_with(char::is_whitespace) {
                ci_body.push_str(line);
                ci_body.push('\n');
            } else {
                break;
            }
        }
    }
    assert!(
        !ci_body.is_empty(),
        "justfile has no `ci:` recipe; cannot verify lint-arch is wired \
         into CI."
    );
    assert!(
        ci_body.contains("lint-arch"),
        "justfile `ci` recipe does not invoke `lint-arch`. Without this \
         wiring the lint exists but CI does not run it. Got ci recipe:\n{}",
        ci_body
    );
}

/// Test: m4_claude_md_documents_driver_use_case_boundary
///
/// Proves: `CLAUDE.md` documents the driver/use-case boundary, the
/// forbidden imports list, and how to run the lint. The audit
/// deliverable explicitly calls for this so future contributors know
/// the rule.
///
/// Anti-fake property: requires evidence of both the *concept* (driver
/// vs use-case wording) and the *invocation* (`lint-arch`). Adding
/// only one of these would fail the test.
#[test]
fn m4_claude_md_documents_driver_use_case_boundary() {
    let src = read_repo_file("CLAUDE.md");
    let lower = src.to_lowercase();
    let concept_signals = ["driver", "use-case", "use case"];
    let concept_hit = concept_signals.iter().any(|s| lower.contains(s));
    assert!(
        concept_hit,
        "CLAUDE.md must document the driver/use-case boundary (none of \
         {:?} found).",
        concept_signals
    );
    assert!(
        src.contains("lint-arch"),
        "CLAUDE.md must mention the `lint-arch` command so contributors \
         know how to run the architecture check."
    );
}

/// Test: m4_claude_md_lists_forbidden_imports
///
/// Proves: `CLAUDE.md` enumerates the forbidden-imports list so a
/// contributor reading the doc knows exactly which crates must not
/// appear in use-case modules.
///
/// Anti-fake property: requires at least 4 of the 7 forbidden-crate
/// names to appear in CLAUDE.md. A single mention of "tokio" in
/// passing isn't enough; the doc must enumerate enough of the list
/// to be useful.
#[test]
fn m4_claude_md_lists_forbidden_imports() {
    let src = read_repo_file("CLAUDE.md");
    let forbidden = [
        "tokio",
        "tokio_postgres",
        "rustls",
        "clap",
        "reqwest",
        "aws_sdk_s3",
        "aws_config",
    ];
    let hits: Vec<_> = forbidden.iter().filter(|c| src.contains(*c)).collect();
    assert!(
        hits.len() >= 4,
        "CLAUDE.md must enumerate the forbidden-imports list. Found only \
         {} of {} forbidden crate names: {:?}. Doc the rule fully so \
         contributors can self-check before pushing.",
        hits.len(),
        forbidden.len(),
        hits
    );
}

// ---------------------------------------------------------------------------
// 2. Behavioral test — clean-state run
// ---------------------------------------------------------------------------

/// Test: m4_xtask_lint_arch_passes_on_current_tree
///
/// Proves: `cargo run --quiet --package xtask -- lint-arch` exits 0
/// against the current state of `gateway/src/`. This is the "happy
/// path" for the CI gate: today's code is supposed to be clean.
///
/// Anti-fake property: not just compilation — the xtask must actually
/// scan the tree and exit zero. Together with the negative test
/// `m4_xtask_lint_arch_detects_violation`, this proves the xtask
/// performs real classification (passes on clean, fails on dirty).
#[test]
#[serial]
fn m4_xtask_lint_arch_passes_on_current_tree() {
    // Skip gracefully if cargo isn't on PATH (rare in CI, common in
    // some sandboxed test runners). The other tests still cover the
    // structural pieces.
    if Command::new("cargo").arg("--version").output().is_err() {
        eprintln!("cargo not on PATH — skipping behavioral xtask run");
        return;
    }
    let output = Command::new(xtask_binary())
        .args(["lint-arch"])
        .current_dir(repo_root())
        .output()
        .expect("failed to spawn xtask lint-arch");
    assert!(
        output.status.success(),
        "`cargo run --package xtask -- lint-arch` failed on the current \
         tree (exit status {:?}).\nstdout:\n{}\nstderr:\n{}\n\nThe lint \
         is supposed to pass on `main` today; if it doesn't, either \
         (a) a real driver-discipline violation exists in gateway/src/ \
         that should be fixed first, or (b) the xtask classification \
         table is too strict and incorrectly flags a driver path as a \
         use-case path.",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

// ---------------------------------------------------------------------------
// 3. Behavioral test — violation detection
// ---------------------------------------------------------------------------

/// Test: m4_xtask_lint_arch_detects_violation
///
/// Proves: when the xtask is pointed at a synthetic tree containing a
/// use-case-shaped file (e.g. `gateway/src/db/forbidden.rs`) with a
/// forbidden `use tokio::...;` statement, it exits non-zero and the
/// diagnostic output names the offending crate AND the file path.
///
/// This is THE anti-fake guard for the entire batch: it rules out an
/// xtask that always exits 0 (a no-op lint that "passes" everything).
///
/// # How
///
/// The test creates a tempdir with this layout:
/// ```text
/// <tmp>/
///   gateway/src/db/violation.rs   (contains `use tokio::sync::Mutex;`)
/// ```
/// and invokes `cargo run --package xtask -- lint-arch --root <tmp>`.
/// The implementer is free to support the violation discovery via
/// either a `--root` flag (preferred, simplest) OR by accepting an
/// argument that points at a custom source root. Either way, this
/// test exercises the parser+classifier on real input.
///
/// If the implementation does NOT support a `--root` flag, the test
/// falls back to writing the violating file directly into
/// `gateway/src/db/_batch8_test_violation.rs`, running the xtask, and
/// then deleting the file. The fallback is guarded by a sentinel
/// filename so CI never persists it.
///
/// Anti-fake property: asserts both (a) non-zero exit AND (b) stdout
/// or stderr contains "tokio" AND the relative path of the violating
/// file. An xtask that exits non-zero but for an unrelated reason
/// (panic, missing arg) would have diagnostic output that doesn't
/// mention "tokio" — and would fail the substring assertion.
#[test]
#[serial]
fn m4_xtask_lint_arch_detects_violation() {
    if Command::new("cargo").arg("--version").output().is_err() {
        eprintln!("cargo not on PATH — skipping behavioral xtask run");
        return;
    }

    // First, try the --root flag path. This is the cleanest design
    // and avoids touching the live source tree.
    let tmp = tempfile::tempdir().expect("create tempdir");
    let synth_src = tmp.path().join("gateway/src/db");
    fs::create_dir_all(&synth_src).expect("mkdir -p synthetic gateway/src/db");
    let violating = synth_src.join("violation.rs");
    fs::write(
        &violating,
        "//! synthetic violation for batch8_m4_tests\n\
         use tokio::sync::Mutex;\n\
         \n\
         pub fn _noop() { let _: Option<Mutex<()>> = None; }\n",
    )
    .expect("write synthetic violation file");

    let with_root = Command::new(xtask_binary())
        .args(["lint-arch", "--root"])
        .arg(tmp.path())
        .current_dir(repo_root())
        .output();

    let (status, stdout, stderr, used_fallback) = match with_root {
        Ok(out) => {
            // Distinguish "the xtask understood --root and rejected
            // the violation" from "the xtask doesn't support --root
            // and exited with a usage error".
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let unrecognized = combined.contains("unexpected argument")
                || combined.contains("unrecognized argument")
                || combined.contains("Found argument '--root'")
                || combined.contains("unknown option")
                || combined.contains("USAGE:");
            if unrecognized {
                run_violation_fallback()
            } else {
                (
                    out.status.code(),
                    String::from_utf8_lossy(&out.stdout).into_owned(),
                    String::from_utf8_lossy(&out.stderr).into_owned(),
                    false,
                )
            }
        }
        Err(_) => run_violation_fallback(),
    };

    assert!(
        status != Some(0),
        "xtask lint-arch did not detect the synthetic violation \
         (exited 0). The xtask may be a no-op that always passes. \
         Used fallback: {}.\nstdout:\n{}\nstderr:\n{}",
        used_fallback,
        stdout,
        stderr
    );
    let combined = format!("{}{}", stdout, stderr);
    assert!(
        combined.contains("tokio"),
        "xtask exited non-zero but its diagnostic output does not \
         mention 'tokio'. The output should name the forbidden \
         crate so the contributor can find the offending line. \
         Used fallback: {}.\nstdout:\n{}\nstderr:\n{}",
        used_fallback,
        stdout,
        stderr
    );
    let path_hint = if used_fallback {
        "_batch8_test_violation"
    } else {
        "violation.rs"
    };
    assert!(
        combined.contains(path_hint),
        "xtask diagnostic output does not name the offending file \
         (looking for substring '{}'). It should print \
         `path:line: forbidden import ...` so the contributor can \
         jump straight to the violation. Used fallback: {}.\n\
         stdout:\n{}\nstderr:\n{}",
        path_hint,
        used_fallback,
        stdout,
        stderr
    );
}

/// Fallback path for violation detection when xtask does not support
/// `--root <path>`. Writes a synthetic violation under
/// `gateway/src/db/_batch8_test_violation.rs`, runs the xtask, then
/// removes the file. The sentinel filename ensures CI never persists
/// the test artifact even if the test panics mid-run (a Drop guard
/// performs cleanup).
fn run_violation_fallback() -> (Option<i32>, String, String, bool) {
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    let target = repo_root().join("gateway/src/db/_batch8_test_violation.rs");
    fs::write(
        &target,
        "//! synthetic violation injected by batch8_m4_tests; safe to \
         delete.\n\
         #![allow(unused_imports, dead_code)]\n\
         use tokio::sync::Mutex;\n\
         pub(crate) fn _batch8_test_noop() { \
             let _: Option<Mutex<()>> = None; \
         }\n",
    )
    .expect("write synthetic violation into gateway/src/db/");
    let _guard = Cleanup(target.clone());

    let out = Command::new(xtask_binary())
        .args(["lint-arch"])
        .current_dir(repo_root())
        .output()
        .expect("spawn xtask lint-arch");

    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
        true,
    )
}

// ---------------------------------------------------------------------------
// 4. Cross-cut: structural sanity
// ---------------------------------------------------------------------------

/// Test: m4_gateway_cargo_toml_unchanged_in_intent
///
/// Proves: the existing `gateway/Cargo.toml` continues to declare its
/// own `[package]` and `[dependencies]`. Converting the repo into a
/// workspace must not collapse the gateway crate's own manifest into
/// the root.
///
/// Anti-fake property: simple substring assertions on `[package]` and
/// `name = "recondo-gateway"` (or the existing crate name) — would
/// fail if the implementer accidentally moved gateway's contents into
/// the root Cargo.toml.
#[test]
fn m4_gateway_cargo_toml_unchanged_in_intent() {
    let path = repo_root().join("gateway/Cargo.toml");
    assert!(
        path.exists(),
        "gateway/Cargo.toml is missing. The workspace conversion must \
         keep gateway as a member crate, not collapse it into the root."
    );
    let src = read_repo_file("gateway/Cargo.toml");
    assert!(
        src.contains("[package]"),
        "gateway/Cargo.toml must still contain its own [package] table \
         after the workspace conversion. Got:\n{}",
        src
    );
    assert!(
        src.contains("[dependencies]"),
        "gateway/Cargo.toml must still contain its own [dependencies] \
         table after the workspace conversion. Got:\n{}",
        src
    );
}

/// Test: m4_xtask_classifies_known_driver_paths
///
/// Proves: the xtask source enumerates the known driver-path patterns
/// from the audit deliverable. The implementation can encode this as a
/// list, a match, a glob set, or any equivalent — but the path
/// strings must appear in the source so reviewers can confirm the
/// classification table at a glance.
///
/// Anti-fake property: requires the xtask source to contain literal
/// substrings for the canonical driver paths. An implementation that
/// silently treats every file as a driver (and so passes everything)
/// would not include strings like "src/gateway" or "src/storage/postgres.rs"
/// in its source, and would fail this test.
#[test]
fn m4_xtask_classifies_known_driver_paths() {
    let src = match try_read_repo_file("xtask/src/main.rs") {
        Some(s) => s,
        None => panic!(
            "xtask/src/main.rs missing — covered by \
             m4_xtask_main_rs_exists; skipping classifier check"
        ),
    };
    // Each marker is one of the canonical driver-path tokens from the
    // audit deliverable. The implementer can pick their own
    // representation (PathBuf, &str, glob), so we look for the
    // distinguishing substring of each path.
    let driver_markers = [
        "gateway",  // src/gateway/** sub-tree
        "storage",  // src/storage/postgres.rs etc
        "alerts",   // src/alerts/**
        "operator", // src/operator/**
    ];
    for marker in driver_markers {
        assert!(
            src.contains(marker),
            "xtask/src/main.rs does not mention driver-path token '{}'. \
             The classification table must list the canonical driver \
             paths from the audit deliverable so a reviewer can verify \
             coverage at a glance. Got source:\n{}",
            marker,
            src
        );
    }
}

/// Test: m4_xtask_catches_qualified_path_violation
///
/// Proves: the visitor rejects forbidden qualified-path expressions
/// (e.g. `reqwest::Client::builder()`) in use-case modules — not just
/// `use` statements. Round-1 review caught a bypass: the original
/// visitor only inspected `ItemUse` and missed
/// `gateway/src/capture/attachments.rs`'s direct `reqwest::*` calls.
///
/// Anti-fake property: synthesizes a use-case-shaped file containing
/// ONLY a qualified-path call (no `use` statement) and asserts the
/// xtask exits non-zero with a diagnostic that names `reqwest`.
#[test]
#[serial]
fn m4_xtask_catches_qualified_path_violation() {
    if Command::new("cargo").arg("--version").output().is_err() {
        eprintln!("cargo not on PATH — skipping behavioral xtask run");
        return;
    }

    let tmp = tempfile::tempdir().expect("create tempdir");
    let synth_src = tmp.path().join("gateway/src/db");
    fs::create_dir_all(&synth_src).expect("mkdir -p synthetic gateway/src/db");
    let violating = synth_src.join("qualified_violation.rs");
    fs::write(
        &violating,
        "//! synthetic qualified-path violation for batch8_m4_tests\n\
         pub fn fetch() {\n\
             let _ = reqwest::Client::builder().build();\n\
         }\n",
    )
    .expect("write synthetic qualified-path violation file");

    let output = Command::new(xtask_binary())
        .args(["lint-arch", "--root"])
        .arg(tmp.path())
        .current_dir(repo_root())
        .output()
        .expect("spawn xtask lint-arch");

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let combined = format!("{}{}", stdout, stderr);

    assert!(
        !output.status.success(),
        "xtask lint-arch did not detect the qualified-path violation \
         `reqwest::Client::builder()`. The visitor must catch qualified \
         paths, not just `use` statements.\nstdout:\n{}\nstderr:\n{}",
        stdout,
        stderr
    );
    assert!(
        combined.contains("reqwest"),
        "xtask diagnostic output does not mention 'reqwest' for a \
         qualified-path violation.\nstdout:\n{}\nstderr:\n{}",
        stdout,
        stderr
    );
    assert!(
        combined.contains("qualified_violation.rs"),
        "xtask diagnostic output does not name the offending file.\n\
         stdout:\n{}\nstderr:\n{}",
        stdout,
        stderr
    );
}

/// Test: m4_capture_attachments_classified_as_driver
///
/// Proves: `capture/attachments.rs` is listed in `DRIVER_PATHS`. It
/// owns external HTTP fetches via qualified `reqwest::*` paths and
/// must be exempt from the use-case rule. Round-1 review noted the
/// original DRIVER_PATHS missed this file, and the bug was masked by
/// a visitor that didn't inspect qualified paths.
///
/// Anti-fake property: substring grep on the xtask source for the
/// driver-path entry. A future contributor who reverts the
/// classification (e.g. by removing the line) will fail this test.
#[test]
fn m4_capture_attachments_classified_as_driver() {
    let src = read_repo_file("xtask/src/main.rs");
    assert!(
        src.contains("\"capture/attachments.rs\""),
        "xtask/src/main.rs DRIVER_PATHS must list \
         \"capture/attachments.rs\". This file uses `reqwest::*` \
         qualified paths for outbound HTTP and is structurally a \
         driver. Got source:\n{}",
        src
    );
}

/// Test: m4_xtask_lists_forbidden_crates
///
/// Proves: the xtask source enumerates every forbidden crate from the
/// audit deliverable. A reviewer must be able to confirm the
/// forbidden-list at a glance.
///
/// Anti-fake property: each forbidden crate must appear by name in
/// the xtask source. An implementation that only checks `tokio` (and
/// so misses `reqwest`/`rustls`/`clap`) would fail this test even if
/// the clean-state and violation-detection tests pass for tokio.
#[test]
fn m4_xtask_lists_forbidden_crates() {
    let src = match try_read_repo_file("xtask/src/main.rs") {
        Some(s) => s,
        None => panic!(
            "xtask/src/main.rs missing — covered by \
             m4_xtask_main_rs_exists; skipping forbidden-list check"
        ),
    };
    let forbidden = [
        "tokio",
        "tokio_postgres",
        "rustls",
        "clap",
        "reqwest",
        "aws_sdk_s3",
        "aws_config",
    ];
    for crate_name in forbidden {
        assert!(
            src.contains(crate_name),
            "xtask/src/main.rs does not mention forbidden crate '{}'. \
             The forbidden-imports list from the audit M4 deliverable \
             must be enumerated explicitly so reviewers can verify \
             coverage. Got source:\n{}",
            crate_name,
            src
        );
    }
}
