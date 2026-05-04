//! Sprint 7: System Prompt Drift Detection (ISO 42001 Cl.9.1 Monitoring).
//!
//! Detects when a session's system prompt changes between turns, creating
//! anomaly events that are persisted to the `anomaly_events` table for
//! compliance auditing and security alerting.

use anyhow::Result;
use rusqlite::Connection;

use crate::db::{self, AnomalyEventRecord};

/// Detect system prompt drift by comparing the current system prompt hash
/// against the session's stored baseline hash.
///
/// - If `sequence_num == 1` (first turn), this is the baseline being set — no drift.
/// - If the session has an empty `system_prompt_hash` (legacy data) and this is
///   the first turn, no drift.
/// - If `current_system_prompt_hash` matches the session's stored hash, no drift.
/// - If they differ: creates an `AnomalyEventRecord` and updates the session's
///   `system_prompt_hash` to the new value so that subsequent turns compare
///   against the latest baseline.
///
/// W1 fix: The function now inserts the anomaly event internally (consistent
/// with the GraphStore path in `detect_drift_via_graph`). Both paths are now
/// symmetric: detect → insert anomaly → update hash → return. If the anomaly
/// INSERT fails, the session hash is NOT updated, so the drift will be
/// re-detected on the next turn (no silent loss).
///
/// Returns `Ok(Some(event))` when drift is detected and persisted,
/// `Ok(None)` when no drift, or `Err` on DB failures.
pub fn detect_system_prompt_drift(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
    current_system_prompt_hash: &str,
    sequence_num: i64,
) -> Result<Option<AnomalyEventRecord>> {
    // First turn: baseline being established, no comparison to make.
    if sequence_num <= 1 {
        return Ok(None);
    }

    // Look up the session to get the stored system_prompt_hash.
    let session = db::get_session(conn, session_id)?;
    let session = match session {
        Some(s) => s,
        None => {
            // Session not found — cannot compare. No anomaly.
            return Ok(None);
        }
    };

    let old_hash = &session.system_prompt_hash;

    // If the session has an empty hash (legacy data with no baseline), no drift.
    if old_hash.is_empty() {
        return Ok(None);
    }

    // Same hash — no drift.
    if old_hash == current_system_prompt_hash {
        return Ok(None);
    }

    // Drift detected: build the anomaly event.
    let now = time::OffsetDateTime::now_utc();
    let detected_at = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

    let metadata = serde_json::json!({
        "old_hash": old_hash,
        "new_hash": current_system_prompt_hash,
        "turn_sequence_num": sequence_num,
    });

    let event = AnomalyEventRecord {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        anomaly_type: "system_prompt_drift".to_string(),
        severity: "warning".to_string(),
        description: format!(
            "System prompt hash changed from {} to {}",
            old_hash, current_system_prompt_hash
        ),
        detected_at,
        resolved_at: None,
        metadata: metadata.to_string(),
    };

    // W1 fix: Insert the anomaly event internally before updating the session
    // hash. This makes the SQLite path symmetric with the GraphStore path —
    // both detect, insert anomaly, and update hash in a single function call.
    // If the anomaly INSERT fails, the session hash is NOT updated (baseline
    // not moved forward), so the drift will be re-detected on the next turn.
    db::insert_anomaly_event(conn, &event)?;

    // Update the session's system_prompt_hash to the new baseline so that
    // subsequent drift checks compare against the latest value.
    db::update_session_system_prompt_hash(conn, session_id, current_system_prompt_hash)?;

    Ok(Some(event))
}

/// Detect tool definition drift by comparing the current tool definitions hash
/// against the session's stored baseline hash.
///
/// Same logic as `detect_system_prompt_drift` but for tool definitions:
/// - If `sequence_num <= 1` (first turn), this is the baseline being set — no drift.
/// - If the session has an empty `tool_definitions_hash` (legacy data), no drift.
/// - If `current_tool_hash` matches the session's stored hash, no drift.
/// - If they differ: creates an `AnomalyEventRecord` with anomaly_type "tool_definition_drift",
///   inserts the anomaly event, updates the session baseline, and returns the event.
pub fn detect_tool_definition_drift(
    conn: &Connection,
    session_id: &str,
    turn_id: &str,
    current_tool_hash: &str,
    sequence_num: i64,
) -> Result<Option<AnomalyEventRecord>> {
    // First turn: baseline being established, no comparison to make.
    if sequence_num <= 1 {
        return Ok(None);
    }

    // Look up the session to get the stored tool_definitions_hash.
    let session = db::get_session(conn, session_id)?;
    let session = match session {
        Some(s) => s,
        None => {
            // Session not found — cannot compare. No anomaly.
            return Ok(None);
        }
    };

    let old_hash = &session.tool_definitions_hash;

    // If the session has an empty hash (legacy data with no baseline), no drift.
    if old_hash.is_empty() {
        return Ok(None);
    }

    // Same hash — no drift.
    if old_hash == current_tool_hash {
        return Ok(None);
    }

    // Drift detected: build the anomaly event.
    let now = time::OffsetDateTime::now_utc();
    let detected_at = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

    let metadata = serde_json::json!({
        "old_hash": old_hash,
        "new_hash": current_tool_hash,
        "turn_sequence_num": sequence_num,
    });

    let event = AnomalyEventRecord {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        anomaly_type: "tool_definition_drift".to_string(),
        severity: "warning".to_string(),
        description: format!(
            "Tool definitions hash changed from {} to {}",
            old_hash, current_tool_hash
        ),
        detected_at,
        resolved_at: None,
        metadata: metadata.to_string(),
    };

    // Insert the anomaly event before updating the session hash.
    // If the anomaly INSERT fails, the session hash is NOT updated (baseline
    // not moved forward), so the drift will be re-detected on the next turn.
    db::insert_anomaly_event(conn, &event)?;

    // Update the session's tool_definitions_hash to the new baseline.
    db::update_session_tool_definitions_hash(conn, session_id, current_tool_hash)?;

    Ok(Some(event))
}

/// Graph-store-aware variant of tool definition drift detection.
///
/// Same logic as `detect_tool_definition_drift` but reads/writes through the
/// `GraphStore` trait instead of a raw `rusqlite::Connection`.
pub fn detect_tool_drift_via_graph(
    graph_store: &dyn crate::storage::graph::GraphStore,
    session_id: &str,
    turn_id: &str,
    current_tool_hash: &str,
    sequence_num: i64,
) -> Result<Option<AnomalyEventRecord>> {
    if sequence_num <= 1 {
        return Ok(None);
    }

    let session = graph_store
        .get_session(session_id)
        .map_err(|e| anyhow::anyhow!("Failed to get session for tool drift check: {}", e))?;
    let session = match session {
        Some(s) => s,
        None => return Ok(None),
    };

    let old_hash = &session.tool_definitions_hash;

    if old_hash.is_empty() {
        return Ok(None);
    }

    if old_hash == current_tool_hash {
        return Ok(None);
    }

    let now = time::OffsetDateTime::now_utc();
    let detected_at = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

    let metadata = serde_json::json!({
        "old_hash": old_hash,
        "new_hash": current_tool_hash,
        "turn_sequence_num": sequence_num,
    });

    let event = AnomalyEventRecord {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        anomaly_type: "tool_definition_drift".to_string(),
        severity: "warning".to_string(),
        description: format!(
            "Tool definitions hash changed from {} to {}",
            old_hash, current_tool_hash
        ),
        detected_at,
        resolved_at: None,
        metadata: metadata.to_string(),
    };

    graph_store
        .record_tool_drift_event(&event, session_id, current_tool_hash)
        .map_err(|e| anyhow::anyhow!("Failed to record tool drift event: {}", e))?;

    Ok(Some(event))
}

/// Graph-store-aware variant of drift detection for use with `GraphStore` trait.
///
/// Same logic as `detect_system_prompt_drift` but reads/writes through the
/// `GraphStore` trait instead of a raw `rusqlite::Connection`. Used by
/// `process_capture_with_pipeline`.
pub fn detect_drift_via_graph(
    graph_store: &dyn crate::storage::graph::GraphStore,
    session_id: &str,
    turn_id: &str,
    current_system_prompt_hash: &str,
    sequence_num: i64,
) -> Result<Option<AnomalyEventRecord>> {
    // First turn: baseline being established, no comparison to make.
    if sequence_num <= 1 {
        return Ok(None);
    }

    // Look up the session to get the stored system_prompt_hash.
    let session = graph_store
        .get_session(session_id)
        .map_err(|e| anyhow::anyhow!("Failed to get session for drift check: {}", e))?;
    let session = match session {
        Some(s) => s,
        None => return Ok(None),
    };

    let old_hash = &session.system_prompt_hash;

    if old_hash.is_empty() {
        return Ok(None);
    }

    if old_hash == current_system_prompt_hash {
        return Ok(None);
    }

    // Drift detected.
    let now = time::OffsetDateTime::now_utc();
    let detected_at = now
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string());

    let metadata = serde_json::json!({
        "old_hash": old_hash,
        "new_hash": current_system_prompt_hash,
        "turn_sequence_num": sequence_num,
    });

    let event = AnomalyEventRecord {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: session_id.to_string(),
        turn_id: turn_id.to_string(),
        anomaly_type: "system_prompt_drift".to_string(),
        severity: "warning".to_string(),
        description: format!(
            "System prompt hash changed from {} to {}",
            old_hash, current_system_prompt_hash
        ),
        detected_at,
        resolved_at: None,
        metadata: metadata.to_string(),
    };

    // W2 fix: Persist anomaly and update session hash atomically via a single
    // graph store call. This ensures both writes succeed or fail together,
    // avoiding inconsistent state where one succeeds and the other fails.
    graph_store
        .record_drift_event(&event, session_id, current_system_prompt_hash)
        .map_err(|e| anyhow::anyhow!("Failed to record drift event: {}", e))?;

    Ok(Some(event))
}
