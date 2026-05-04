//! Sprint 5: Artifact tracking and SUPERSEDES chain resolution.
//!
//! This module extracts artifact information from tool call inputs and provides
//! a resolver for walking SUPERSEDES chains in the turn history.

use crate::hash;
use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// Information about an artifact produced by a tool call.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ArtifactInfo {
    /// The file path of the artifact.
    pub path: String,
    /// SHA-256 hash of the file path (not the file content).
    pub hash: String,
}

/// Extract artifacts from a tool call based on tool name and input JSON.
///
/// Supported tools:
/// - `Write`: looks for `file_path` or `path` keys
/// - `Edit`: looks for `file_path` or `file` keys
/// - `Bash`: regex scan for `>`, `>>`, `tee`, `cp`, `mv` patterns
///
/// Returns an empty Vec for unknown tools or malformed input (never panics).
pub fn extract_artifacts(tool_name: &str, tool_input: &str) -> Vec<ArtifactInfo> {
    match tool_name {
        "Write" => extract_write_artifacts(tool_input),
        "Edit" => extract_edit_artifacts(tool_input),
        "Bash" => extract_bash_artifacts(tool_input),
        _ => Vec::new(),
    }
}

/// Extract artifacts from a Write tool call.
/// Looks for `file_path` or `path` keys in the JSON input.
fn extract_write_artifacts(tool_input: &str) -> Vec<ArtifactInfo> {
    let parsed: serde_json::Value = match serde_json::from_str(tool_input) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let path = parsed
        .get("file_path")
        .and_then(|v| v.as_str())
        .or_else(|| parsed.get("path").and_then(|v| v.as_str()));

    match path {
        Some(p) => vec![ArtifactInfo {
            hash: hash::sha256_hex(p.as_bytes()),
            path: p.to_string(),
        }],
        None => Vec::new(),
    }
}

/// Extract artifacts from an Edit tool call.
/// Looks for `file_path` or `file` keys in the JSON input.
fn extract_edit_artifacts(tool_input: &str) -> Vec<ArtifactInfo> {
    let parsed: serde_json::Value = match serde_json::from_str(tool_input) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let path = parsed
        .get("file_path")
        .and_then(|v| v.as_str())
        .or_else(|| parsed.get("file").and_then(|v| v.as_str()));

    match path {
        Some(p) => vec![ArtifactInfo {
            hash: hash::sha256_hex(p.as_bytes()),
            path: p.to_string(),
        }],
        None => Vec::new(),
    }
}

/// Extract artifacts from a Bash tool call.
/// Scans the command string for file-writing patterns:
/// - `>` or `>>` redirect operators
/// - `tee` command
/// - `cp` command (destination)
/// - `mv` command (destination)
fn extract_bash_artifacts(tool_input: &str) -> Vec<ArtifactInfo> {
    let parsed: serde_json::Value = match serde_json::from_str(tool_input) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let command = match parsed.get("command").and_then(|v| v.as_str()) {
        Some(c) => c,
        None => return Vec::new(),
    };

    let mut artifacts = Vec::new();
    let mut seen_paths = std::collections::HashSet::new();

    // Detect redirect operators: > and >>
    // Match patterns like: > /path/to/file or >> /path/to/file
    for cap in regex_find_redirect_targets(command) {
        if seen_paths.insert(cap.clone()) {
            artifacts.push(ArtifactInfo {
                hash: hash::sha256_hex(cap.as_bytes()),
                path: cap,
            });
        }
    }

    // Detect tee command: tee /path/to/file
    for cap in regex_find_tee_targets(command) {
        if seen_paths.insert(cap.clone()) {
            artifacts.push(ArtifactInfo {
                hash: hash::sha256_hex(cap.as_bytes()),
                path: cap,
            });
        }
    }

    // Detect cp command: cp source destination
    for cap in regex_find_cp_targets(command) {
        if seen_paths.insert(cap.clone()) {
            artifacts.push(ArtifactInfo {
                hash: hash::sha256_hex(cap.as_bytes()),
                path: cap,
            });
        }
    }

    // Detect mv command: mv source destination
    for cap in regex_find_mv_targets(command) {
        if seen_paths.insert(cap.clone()) {
            artifacts.push(ArtifactInfo {
                hash: hash::sha256_hex(cap.as_bytes()),
                path: cap,
            });
        }
    }

    artifacts
}

/// Find redirect targets (> or >>) in a bash command.
/// Returns the file paths that follow redirect operators.
fn regex_find_redirect_targets(command: &str) -> Vec<String> {
    let mut results = Vec::new();
    // Split into tokens and find > or >> followed by a path
    let chars: Vec<char> = command.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '>' {
            // Skip >> or >
            if i + 1 < len && chars[i + 1] == '>' {
                i += 2;
            } else {
                i += 1;
            }
            // Skip whitespace
            while i < len && chars[i] == ' ' {
                i += 1;
            }
            // Collect the path
            let start = i;
            while i < len
                && chars[i] != ' '
                && chars[i] != '\n'
                && chars[i] != ';'
                && chars[i] != '|'
            {
                i += 1;
            }
            if i > start {
                let path: String = chars[start..i].iter().collect();
                if path.contains('/') {
                    results.push(path);
                }
            }
        } else {
            i += 1;
        }
    }

    results
}

/// Find tee command targets.
fn regex_find_tee_targets(command: &str) -> Vec<String> {
    let mut results = Vec::new();

    // Find "tee" followed by optional flags then a path
    let parts: Vec<&str> = command.split_whitespace().collect();
    for (idx, part) in parts.iter().enumerate() {
        if *part == "tee" {
            // Look at following tokens, skip flags (starting with -)
            for &next in &parts[idx + 1..] {
                if next.starts_with('-') {
                    continue;
                }
                if next.contains('/') {
                    results.push(next.to_string());
                }
                break;
            }
        }
    }

    results
}

/// Find cp command destination (last argument).
fn regex_find_cp_targets(command: &str) -> Vec<String> {
    let mut results = Vec::new();

    let parts: Vec<&str> = command.split_whitespace().collect();
    for (idx, part) in parts.iter().enumerate() {
        if *part == "cp" {
            // Collect non-flag arguments after cp
            let args: Vec<&str> = parts[idx + 1..]
                .iter()
                .filter(|p| !p.starts_with('-'))
                .copied()
                .collect();
            // Destination is the last argument
            if args.len() >= 2 {
                let dest = args[args.len() - 1];
                if dest.contains('/') {
                    results.push(dest.to_string());
                }
            }
        }
    }

    results
}

/// Find mv command destination (last argument).
fn regex_find_mv_targets(command: &str) -> Vec<String> {
    let mut results = Vec::new();

    let parts: Vec<&str> = command.split_whitespace().collect();
    for (idx, part) in parts.iter().enumerate() {
        if *part == "mv" {
            // Collect non-flag arguments after mv
            let args: Vec<&str> = parts[idx + 1..]
                .iter()
                .filter(|p| !p.starts_with('-'))
                .copied()
                .collect();
            // Destination is the last argument
            if args.len() >= 2 {
                let dest = args[args.len() - 1];
                if dest.contains('/') {
                    results.push(dest.to_string());
                }
            }
        }
    }

    results
}

// =============================================================================
// SupersedesResolver
// =============================================================================

/// Resolves SUPERSEDES chains by walking the `supersedes_turn_id` links.
pub struct SupersedesResolver<'a> {
    conn: &'a Connection,
}

impl<'a> SupersedesResolver<'a> {
    /// Create a new resolver with a database connection.
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Find the most recent turn in the given session that touched any of the
    /// specified artifact paths. Returns the turn_id if found.
    ///
    /// This queries tool_calls with non-empty artifacts_created that overlap
    /// with the provided paths, ordered by the turn's sequence_num descending.
    pub fn find_supersedes_for_session(
        &self,
        session_id: &str,
        artifact_paths: &[&str],
    ) -> Result<Option<String>> {
        if artifact_paths.is_empty() {
            return Ok(None);
        }

        // Query all tool calls in this session that have artifacts_created
        let mut stmt = self.conn.prepare(
            "SELECT tc.turn_id, tc.artifacts_created
             FROM tool_calls tc
             JOIN turns t ON tc.turn_id = t.id
             WHERE t.session_id = ?1
               AND tc.artifacts_created IS NOT NULL
               AND tc.artifacts_created != '[]'
             ORDER BY t.sequence_num DESC",
        )?;

        let rows = stmt.query_map(rusqlite::params![session_id], |row| {
            let turn_id: String = row.get(0)?;
            let artifacts_json: String = row.get(1)?;
            Ok((turn_id, artifacts_json))
        })?;

        for row_result in rows {
            let (turn_id, artifacts_json) = row_result?;
            // Parse the artifacts_created JSON array
            if let Ok(paths) = serde_json::from_str::<Vec<String>>(&artifacts_json) {
                // Check if any of the provided paths overlap
                for path in artifact_paths {
                    if paths.iter().any(|p| p == path) {
                        return Ok(Some(turn_id));
                    }
                }
            }
        }

        Ok(None)
    }

    /// Walk the full SUPERSEDES chain starting from the given turn_id.
    ///
    /// Returns a Vec of TurnRecords from most recent (the starting turn) to
    /// the root (the turn with no supersedes_turn_id).
    pub fn resolve_chain(&self, turn_id: &str) -> Result<Vec<crate::db::TurnRecord>> {
        let mut chain = Vec::new();
        let mut current_id = turn_id.to_string();
        // W7 fix: Cycle detection via visited set. Break immediately if we
        // encounter a turn_id we have already seen, preventing infinite loops
        // from corrupted data (circular SUPERSEDES references).
        let mut visited = std::collections::HashSet::new();

        // Safety limit to prevent infinite loops in case of data corruption
        let max_depth = 1000;

        for _ in 0..max_depth {
            if !visited.insert(current_id.clone()) {
                // Cycle detected — stop walking
                break;
            }
            let turn = crate::db::get_turn(self.conn, &current_id)?;
            match turn {
                Some(t) => {
                    let next_id = t.supersedes_turn_id.clone();
                    chain.push(t);
                    match next_id {
                        Some(nid) => current_id = nid,
                        None => break,
                    }
                }
                None => break,
            }
        }

        Ok(chain)
    }
}
