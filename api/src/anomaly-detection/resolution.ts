/**
 * Sprint 8 Deliverable 4: Resolution Tracking API
 *
 * PATCH /v1/anomalies/:id/resolve — marks an anomaly as resolved
 *
 * Sets resolved_at and resolution_note on the anomaly_events record.
 * Project-scoped, authenticated, audit-logged. Admin can resolve any anomaly.
 */

import { getPool } from "../db.js";
import type { ApiKeyInfo } from "../context.js";
import { sanitizeAnomalyRow } from "../placeholder-mask.js";

// ---------------------------------------------------------------------------
// PATCH /v1/anomalies/:id/resolve
// ---------------------------------------------------------------------------

export async function handleResolveAnomaly(
  anomalyId: string,
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Table created by migration 006_runtime-tables.sql
  const pool = getPool();
  const resolutionNote = (body.resolutionNote as string) ?? null;

  // N2: Validate resolutionNote length
  if (resolutionNote && resolutionNote.length > 10000) {
    return {
      status: 400,
      body: { error: "resolutionNote must not exceed 10000 characters" },
    };
  }

  // Fetch the anomaly
  const existing = await pool.query(`
    SELECT ae.id, ae.session_id, ae.turn_id, ae.anomaly_type, ae.severity,
           ae.description, ae.metadata, ae.project_id, ae.score,
           ae.detected_at, ae.resolved_at, ae.resolution_note
    FROM anomaly_events ae
    WHERE ae.id = $1
  `, [anomalyId]);

  if (existing.rows.length === 0) {
    return {
      status: 404,
      body: { error: "Anomaly not found" },
    };
  }

  const anomaly = existing.rows[0];

  // Project scoping: non-admin keys can only resolve their own project's anomalies
  if (apiKey.projectId && anomaly.project_id !== apiKey.projectId) {
    return {
      status: 403,
      body: { error: "Forbidden: cannot resolve anomaly from another project" },
    };
  }

  // Update the anomaly
  const updated = await pool.query(`
    UPDATE anomaly_events
    SET resolved_at = NOW(), resolution_note = $2
    WHERE id = $1
    RETURNING *
  `, [anomalyId, resolutionNote]);

  const row = updated.rows[0];

  // FIND-8-A + FIND-9-J + FIND-10-E: sanitise via the
  // anomaly-aware helper that walks both top-level text columns
  // (ANOMALY_TEXT_FIELDS) AND `metadata` JSONB string values.
  // Round 9 used `sanitizeRowTextFields` here, which only masked
  // top-level columns; rows persisted by a pre-Round-9 gateway
  // (or a batch-imported anomaly) carried `metadata.toolName =
  // "[Image: source: /path]"`, leaking via this PATCH response
  // body.
  const sanitized = sanitizeAnomalyRow(row as Record<string, unknown>);
  return {
    status: 200,
    body: {
      anomaly: {
        id: sanitized.id,
        sessionId: sanitized.session_id,
        turnId: sanitized.turn_id,
        type: sanitized.anomaly_type,
        severity: sanitized.severity,
        description: sanitized.description,
        metadata: sanitized.metadata,
        projectId: sanitized.project_id,
        score: sanitized.score != null ? Number(sanitized.score) : null,
        createdAt: sanitized.detected_at,
        resolvedAt: sanitized.resolved_at,
        resolutionNote: sanitized.resolution_note ?? null,
      },
    },
  };
}
