/**
 * Sprint 7: ISO 42001 (AI Management System) Export
 *
 * POST /v1/exports/iso42001
 *
 * Generates a JSON evidence package for ISO 42001 compliance.
 * 
 */

import { getPool } from "../db.js";
import type { ApiKeyInfo } from "../context.js";

export async function handleIso42001Export(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const startDate = body.startDate as string | undefined;
  const endDate = body.endDate as string | undefined;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  // ISSUE 9 fix: Validate projectId is a valid UUID format
  if (!/^[0-9a-f-]{36}$/i.test(projectId)) {
    return { status: 400, body: { error: "Invalid projectId format: must be a UUID" } };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const effectiveProjectId = projectId;
  const pool = getPool();

  // Session summary
  const sessionsResult = await pool.query(
    `SELECT COUNT(*) AS total_sessions,
            SUM(total_turns) AS total_turns,
            SUM(total_tokens) AS total_tokens,
            SUM(total_cost_usd) AS total_cost
     FROM sessions
     WHERE project_id = $1
       AND ($2::TEXT IS NULL OR started_at::timestamptz >= $2::timestamptz)
       AND ($3::TEXT IS NULL OR started_at::timestamptz <= $3::timestamptz)`,
    [effectiveProjectId, startDate ?? null, endDate ?? null]
  );

  const totalSessions = Number(sessionsResult.rows[0]?.total_sessions ?? 0);
  const totalTurns = Number(sessionsResult.rows[0]?.total_turns ?? 0);
  const totalTokens = Number(sessionsResult.rows[0]?.total_tokens ?? 0);
  const totalCost = Number(sessionsResult.rows[0]?.total_cost ?? 0);

  // Anomaly summary — ISSUE 7 fix: apply same date filters as session query
  let anomalyCount = 0;
  try {
    const anomalyResult = await pool.query(
      `SELECT COUNT(*) AS cnt
       FROM anomaly_events ae
       JOIN sessions s ON ae.session_id = s.id
       WHERE s.project_id = $1
         AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
      [effectiveProjectId, startDate ?? null, endDate ?? null]
    );
    anomalyCount = Number(anomalyResult.rows[0]?.cnt ?? 0);
  } catch {
    // anomaly_events may not exist
  }

  // Model inventory
  const modelsResult = await pool.query(
    `SELECT DISTINCT t.model, COALESCE(t.provider, s.provider) AS provider
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.model IS NOT NULL
     ORDER BY t.model`,
    [effectiveProjectId]
  );

  const models = modelsResult.rows.map((r) => ({
    model: r.model,
    provider: r.provider,
  }));

  return {
    status: 200,
    body: {
      standard: "ISO/IEC 42001:2023",
      aiManagementSystem: {
        totalSessions,
        totalTurns,
        totalTokens,
        totalCostUsd: totalCost,
        anomalyCount,
        modelInventory: models,
      },
      metadata: {
        generatedAt: new Date().toISOString(),
        projectId: effectiveProjectId,
        startDate: startDate ?? null,
        endDate: endDate ?? null,
      },
    },
  };
}
