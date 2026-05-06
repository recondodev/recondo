/**
 * Sprint 7: MiFID II Export
 *
 * POST /v1/exports/mifid-ii
 *
 * Generates a JSON evidence package for MiFID II compliance
 * (algorithmic trading / financial services AI governance).
 * 
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

export async function handleMifidIIExport(
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

  // Session/turn summary
  const summaryResult = await pool.query(
    `SELECT COUNT(DISTINCT s.id) AS total_sessions,
            COUNT(t.id) AS total_decisions,
            SUM(t.input_tokens + t.output_tokens) AS total_tokens,
            SUM(t.cost_usd) AS total_cost
     FROM sessions s
     JOIN turns t ON t.session_id = s.id
     WHERE s.project_id = $1
       AND ($2::TEXT IS NULL OR t.timestamp::timestamptz >= $2::timestamptz)
       AND ($3::TEXT IS NULL OR t.timestamp::timestamptz <= $3::timestamptz)`,
    [effectiveProjectId, startDate ?? null, endDate ?? null]
  );

  const totalSessions = Number(summaryResult.rows[0]?.total_sessions ?? 0);
  const totalDecisions = Number(summaryResult.rows[0]?.total_decisions ?? 0);
  const totalTokens = Number(summaryResult.rows[0]?.total_tokens ?? 0);
  const totalCost = Number(summaryResult.rows[0]?.total_cost ?? 0);

  return {
    status: 200,
    body: {
      regulation: "MiFID II / RTS 6",
      algorithmicTradingEvidence: {
        totalSessions,
        totalDecisions,
        totalTokens,
        totalCostUsd: totalCost,
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
