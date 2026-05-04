//! xtask — Recondo workspace tasks.
//!
//! Subcommands:
//!   lint-arch [--root <path>]   Forbid driver-crate imports in use-case modules.
//!
//! M4 of the 2026-05-02 gateway audit: enforces the driver/use-case boundary
//! by parsing every `.rs` file under `<root>/gateway/src/` with `syn` and
//! rejecting both `use <forbidden_crate>::...;` statements AND qualified
//! path expressions like `reqwest::Client::builder()` in non-driver files.

use anyhow::{anyhow, bail, Context, Result};
use std::path::{Path, PathBuf};
use syn::spanned::Spanned;
use syn::visit::Visit;
use walkdir::WalkDir;

/// Crates that may only be imported from driver modules.
const FORBIDDEN_CRATES: &[&str] = &[
    "tokio",
    "tokio_postgres",
    "rustls",
    "clap",
    "reqwest",
    "aws_sdk_s3",
    "aws_config",
];

/// Driver paths (relative to `gateway/src/`). Files matching one of these
/// paths, or living under a directory entry (trailing `/`), are drivers
/// and may import any crate. Everything else is a use-case module.
///
/// Note: `capture/attachments.rs` is a driver because it makes external
/// HTTP fetches (timeout, redirect policy, SSRF guards) using `reqwest`
/// via qualified-path expressions. It owns I/O, so it lives in the
/// driver layer despite sitting under `capture/`.
const DRIVER_PATHS: &[&str] = &[
    "main.rs",
    "gateway/",
    "storage/postgres.rs",
    "storage/pipeline.rs",
    "storage/pool.rs",
    "storage/object.rs",
    "storage/mod.rs",
    "providers/mock.rs",
    "capture/attachments.rs",
    "alerts/",
    "health/",
    "metrics/",
    "operator/",
];

fn is_driver_path(rel: &Path) -> bool {
    let s = rel.to_string_lossy().replace('\\', "/");
    DRIVER_PATHS
        .iter()
        .any(|p| s == *p || (p.ends_with('/') && s.starts_with(p)))
}

fn first_path_segment(tree: &syn::UseTree) -> Option<&syn::Ident> {
    match tree {
        syn::UseTree::Path(p) => Some(&p.ident),
        syn::UseTree::Name(n) => Some(&n.ident),
        syn::UseTree::Rename(r) => Some(&r.ident),
        // Group/Glob at the top level of a `use` is not valid Rust.
        syn::UseTree::Group(_) | syn::UseTree::Glob(_) => None,
    }
}

struct UseCaseImportVisitor<'a> {
    rel_path: &'a Path,
    violations: Vec<String>,
}

impl UseCaseImportVisitor<'_> {
    /// Check the first segment of a qualified path (e.g. `reqwest::Client`)
    /// against the forbidden-crate list. Catches qualified-path expressions
    /// and types that bypass `use` statements.
    fn check_path_segments(&mut self, path: &syn::Path) {
        if let Some(first) = path.segments.first() {
            let name = first.ident.to_string();
            if FORBIDDEN_CRATES.iter().any(|c| *c == name) {
                self.violations.push(format!(
                    "{}:{}: forbidden qualified path '{}::*' in use-case module",
                    self.rel_path.display(),
                    first.ident.span().start().line,
                    name,
                ));
            }
        }
    }
}

impl<'ast> Visit<'ast> for UseCaseImportVisitor<'_> {
    fn visit_item_use(&mut self, node: &'ast syn::ItemUse) {
        if let Some(ident) = first_path_segment(&node.tree) {
            let name = ident.to_string();
            if FORBIDDEN_CRATES.iter().any(|c| *c == name) {
                self.violations.push(format!(
                    "{}:{}: forbidden import '{}' in use-case module",
                    self.rel_path.display(),
                    node.use_token.span().start().line,
                    name,
                ));
            }
        }
        syn::visit::visit_item_use(self, node);
    }

    fn visit_expr_path(&mut self, node: &'ast syn::ExprPath) {
        self.check_path_segments(&node.path);
        syn::visit::visit_expr_path(self, node);
    }

    fn visit_type_path(&mut self, node: &'ast syn::TypePath) {
        self.check_path_segments(&node.path);
        syn::visit::visit_type_path(self, node);
    }
}

/// Extract `(path, line)` from a violation string of the shape
/// `"path/to/file.rs:LINE: forbidden ..."`. Used as the sort key so
/// line numbers compare numerically rather than lexicographically.
/// Falls back to `(full_string, 0)` on parse failure, which still
/// yields a stable total order.
fn parse_violation_key(v: &str) -> (&str, u32) {
    let mut parts = v.splitn(3, ':');
    let path = parts.next().unwrap_or("");
    let line: u32 = parts.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    (path, line)
}

fn lint_arch(root: &Path) -> Result<()> {
    let src_root = root.join("gateway").join("src");
    if !src_root.exists() {
        bail!("gateway/src not found at {}", src_root.display());
    }

    let mut violations: Vec<String> = Vec::new();

    for entry in WalkDir::new(&src_root).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("rs") {
            continue;
        }

        let rel = path.strip_prefix(&src_root)?;
        if is_driver_path(rel) {
            continue;
        }

        let source =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let parsed =
            syn::parse_file(&source).with_context(|| format!("parse {}", path.display()))?;

        let mut visitor = UseCaseImportVisitor {
            rel_path: rel,
            violations: Vec::new(),
        };
        visitor.visit_file(&parsed);

        violations.extend(visitor.violations);
    }

    // Sort for deterministic output across OSes / fs revisions — keeps
    // CI logs reproducible and diff-friendly. Parse `path:line:` at sort
    // time so line numbers compare numerically (`:2` < `:10`) instead of
    // lexicographically (`:10` < `:2`).
    violations.sort_by(|a, b| {
        let (a_path, a_line) = parse_violation_key(a);
        let (b_path, b_line) = parse_violation_key(b);
        (a_path, a_line).cmp(&(b_path, b_line))
    });

    if !violations.is_empty() {
        for v in &violations {
            eprintln!("{}", v);
        }
        bail!(
            "lint-arch: {} violation(s) — driver crates imported in use-case modules",
            violations.len()
        );
    }

    println!("lint-arch: clean — no driver crates imported in use-case modules");
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("");

    let mut root = std::env::current_dir()?;
    if let Some(idx) = args.iter().position(|a| a == "--root") {
        let path = args
            .get(idx + 1)
            .ok_or_else(|| anyhow!("--root requires a path argument"))?;
        root = PathBuf::from(path);
    }

    match cmd {
        "lint-arch" => lint_arch(&root),
        "" | "--help" | "-h" => {
            println!("xtask <subcommand>");
            println!("  lint-arch [--root <path>]   Run the architecture-discipline lint");
            Ok(())
        }
        other => bail!("unknown subcommand: {}", other),
    }
}
