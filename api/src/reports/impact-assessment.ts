/**
 * Sprint 9 Deliverable 4: AI Impact Assessment Reports (ISO 42001 Cl.8.4)
 *
 * POST /v1/reports/impact-assessment
 *
 * Per-agent auto-generated report:
 * - agentId, agentDescription
 * - decisionVolume: { totalSessions, totalTurns, totalTokens, dateRange }
 * - artifactsProduced: { totalFiles, uniqueFiles }
 * - anomalyHistory: [{ type, severity, count, resolved, unresolved }]
 * - riskDistribution: { low, medium, high, critical }
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";
import { classifyRiskLevel } from "../risk/classification.js";

export async function handleImpactAssessment(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const agentId = body.agentId as string | undefined;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }
  if (!agentId) {
    return { status: 400, body: { error: "Missing required field: agentId" } };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden: cross-project access not allowed" } };
  }

  const effectiveProjectId = projectId;
  const pool = getPool();

  // --- decisionVolume ---
  const sessionResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt, MIN(started_at) AS earliest, MAX(last_active_at) AS latest,
            COALESCE(SUM(total_tokens), 0)::bigint AS total_tokens
     FROM sessions
     WHERE project_id = $1 AND agent_id = $2`,
    [effectiveProjectId, agentId]
  );

  const totalSessions = sessionResult.rows[0]?.cnt ?? 0;
  const totalTokens = Number(sessionResult.rows[0]?.total_tokens ?? 0);
  const earliest = sessionResult.rows[0]?.earliest;
  const latest = sessionResult.rows[0]?.latest;

  const turnResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1 AND s.agent_id = $2`,
    [effectiveProjectId, agentId]
  );
  const totalTurns = turnResult.rows[0]?.cnt ?? 0;

  const dateRange = {
    from: earliest ?? null,
    to: latest ?? null,
  };

  const decisionVolume = {
    totalSessions,
    totalTurns,
    totalTokens,
    dateRange,
  };

  // --- artifactsProduced ---
  // Count files from artifacts_created column (comma-separated file lists)
  // H2 fix: Add LIMIT to prevent unbounded result sets
  const artifactResult = await pool.query(
    `SELECT tc.artifacts_created FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1 AND s.agent_id = $2
       AND tc.artifacts_created IS NOT NULL
       AND tc.artifacts_created != ''
     LIMIT 10000`,
    [effectiveProjectId, agentId]
  );

  let totalFiles = 0;
  const uniqueFileSet = new Set<string>();
  for (const row of artifactResult.rows) {
    const files = (row.artifacts_created as string).split(",").map((f: string) => f.trim()).filter(Boolean);
    totalFiles += files.length;
    for (const file of files) {
      uniqueFileSet.add(file);
    }
  }

  const artifactsProduced = {
    totalFiles,
    uniqueFiles: uniqueFileSet.size,
  };

  // --- anomalyHistory ---
  const anomalyResult = await pool.query(
    `SELECT
       ae.anomaly_type AS type,
       ae.severity,
       COUNT(*)::int AS count,
       COUNT(*) FILTER (WHERE ae.resolved_at IS NOT NULL)::int AS resolved,
       COUNT(*) FILTER (WHERE ae.resolved_at IS NULL)::int AS unresolved
     FROM anomaly_events ae
     JOIN sessions s ON ae.session_id = s.id
     WHERE s.project_id = $1 AND s.agent_id = $2
     GROUP BY ae.anomaly_type, ae.severity
     ORDER BY count DESC`,
    [effectiveProjectId, agentId]
  );

  const anomalyHistory = anomalyResult.rows.map((r: Record<string, unknown>) => ({
    type: r.type as string,
    severity: r.severity as string,
    count: Number(r.count),
    resolved: Number(r.resolved),
    unresolved: Number(r.unresolved),
  }));

  // --- riskDistribution ---
  const riskProfile = { low: 0, medium: 0, high: 0, critical: 0 };

  try {
    const riskResult = await pool.query(
      `SELECT sr.risk_level, COUNT(*)::int AS cnt
       FROM session_risk sr
       JOIN sessions s ON sr.session_id = s.id
       WHERE s.project_id = $1 AND s.agent_id = $2
       GROUP BY sr.risk_level`,
      [effectiveProjectId, agentId]
    );

    for (const row of riskResult.rows) {
      const level = (row.risk_level as string).toLowerCase();
      if (level in riskProfile) {
        riskProfile[level as keyof typeof riskProfile] = row.cnt;
      }
    }
  } catch {
    // session_risk table may not exist yet; classify on the fly
    // H2 fix: Add LIMIT to prevent unbounded result sets
    const sessions = await pool.query(
      `SELECT initial_intent FROM sessions WHERE project_id = $1 AND agent_id = $2 LIMIT 10000`,
      [effectiveProjectId, agentId]
    );
    for (const row of sessions.rows) {
      const level = classifyRiskLevel(row.initial_intent ?? "");
      riskProfile[level as keyof typeof riskProfile]++;
    }
  }

  return {
    status: 200,
    body: {
      agentId,
      decisionVolume,
      artifactsProduced,
      anomalyHistory,
      riskDistribution: riskProfile,
    },
  };
}

// M1 fix: classifyRiskLevel imported from canonical location (risk/classification.ts)
