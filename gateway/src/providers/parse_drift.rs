//! Parse-drift helpers used by provider request/response parsers to record
//! schema mismatches into `parse_errors` instead of silently falling back.
//!
//! Audit reference: M1 + E7 in `docs/GATEWAY_AUDIT_2026_05_02.md`.
//!
//! The CLAUDE.md forbidden-patterns list reads:
//! *"Silent `unwrap_or_default` on parsed request fields that leak into
//! stored records (root cause of several past gap-fix bugs)."*
//!
//! These helpers replace the silent-fallback shape with a "log to
//! `parse_errors`, fall back, keep going" shape. Captures are never lost on
//! provider schema changes — the caller gets visibility into the mismatch
//! via the parsed-data struct's `parse_errors: Option<Vec<String>>` field.

use serde_json::Value;

/// Resolve a dot-separated path through a JSON value tree. Returns `None`
/// if any segment is missing.
///
/// Mirrors the `resolve_path` private helper inside `providers::generic` so
/// that this module can be self-contained.
fn resolve_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

/// Coerce a JSON value into a string (treating JSON numbers as their string
/// representation, matching the existing `providers::generic::resolve_path_str`
/// behaviour).
fn value_as_string_or_number(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        Some(s.to_string())
    } else if v.is_number() {
        Some(v.to_string())
    } else {
        None
    }
}

/// Render a JSON value (or the string `missing` if `None`) for inclusion in
/// a parse-drift error message. Truncates long values to keep `parse_errors`
/// log lines readable.
///
/// FIND-1-1 fix: truncation uses `chars().take(MAX)` (char-boundary safe) so
/// non-ASCII inputs cannot panic. `serde_json::Value::to_string` does not
/// escape non-ASCII bytes — they round-trip verbatim — so byte-index slicing
/// like `&s[..MAX]` panicked when MAX landed inside a multi-byte UTF-8
/// sequence. The replacement counts CHARACTERS, not bytes; the truncated
/// string may exceed MAX bytes for non-ASCII inputs but that is fine: the
/// goal is readability, not a hard byte budget.
fn render_observed(observed: Option<&Value>) -> String {
    match observed {
        None => "missing".to_string(),
        Some(v) => {
            let s = v.to_string();
            const MAX: usize = 120;
            // Cheap fast path: pure-ASCII strings (the common case) need no
            // char-boundary check because every byte is a char boundary.
            if s.len() <= MAX {
                s
            } else {
                let truncated: String = s.chars().take(MAX).collect();
                format!("{}…", truncated)
            }
        }
    }
}

/// Resolve a single-segment path via `Value::get` and extract as array. On
/// schema mismatch (segment missing, value not an array), record a
/// drift entry into `errors` and return an empty `Vec`.
///
/// Used by the Gemini request parsers in `providers::google` where the
/// contents field is a single segment off the request object.
pub(super) fn extract_array_or_record_drift(
    v: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> Vec<Value> {
    let observed = v.get(path);
    match observed.and_then(|x| x.as_array()).cloned() {
        Some(arr) => arr,
        None => {
            errors.push(format!(
                "expected array at .{}, got {}",
                path,
                render_observed(observed)
            ));
            Vec::new()
        }
    }
}

/// Resolve a dot-separated path and extract as array. On schema mismatch
/// (path missing, value not an array), record a drift entry into `errors`
/// and return an empty `Vec`.
///
/// Used by the YAML-configured generic adapter where `messages_path` may be
/// `"some.nested.field"`.
pub(super) fn extract_array_or_record_drift_dotted(
    v: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> Vec<Value> {
    let observed = resolve_path(v, path);
    match observed.and_then(|x| x.as_array()).cloned() {
        Some(arr) => arr,
        None => {
            errors.push(format!(
                "expected array at .{}, got {}",
                path,
                render_observed(observed)
            ));
            Vec::new()
        }
    }
}

/// Resolve a dot-separated path and extract as a string (or stringified
/// number, matching `providers::generic::resolve_path_str`). On schema
/// mismatch, record a drift entry into `errors` and return an empty
/// `String`.
///
/// FIND-1-4 fix: walks the path once. The previous implementation called
/// `resolve_path` twice on the error branch (once via the now-removed
/// `resolve_path_str` helper, once for `render_observed`).
pub(super) fn extract_string_or_record_drift_dotted(
    v: &Value,
    path: &str,
    errors: &mut Vec<String>,
) -> String {
    let observed = resolve_path(v, path);
    match observed.and_then(value_as_string_or_number) {
        Some(s) => s,
        None => {
            errors.push(format!(
                "expected string at .{}, got {}",
                path,
                render_observed(observed)
            ));
            String::new()
        }
    }
}
