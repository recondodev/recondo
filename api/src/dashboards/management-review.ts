/**
 * Sprint 9 Deliverable 2: Management Review Dashboard API (ISO 42001 Cl.9.3)
 *
 * GET /v1/dashboards/management-review
 *
 * Executive-facing summary:
 * - governanceCoverage: { totalSessions, totalDecisions, totalArtifacts }
 * - compliancePosture: { soc2Completeness, iso42001EvidenceFreshness }
 * - anomalySummary: { total, bySeverity: { warning, critical }, resolutionRate }
 * - riskProfile: { low, medium, high, critical }
 * - frameworkChecklist: [{ clause, status, evidence }]
 *
 * Authenticated access required.
 */

import { getPool } from "../db.js";
import type { ApiKeyInfo } from "../context.js";
import { classifyRiskLevel } from "../risk/classification.js";
import { maskPlaceholderPaths } from "../placeholder-mask.js";

interface ManagementReviewQuery {
  projectId?: string;
}

export async function handleManagementReview(
  apiKey: ApiKeyInfo,
  query: ManagementReviewQuery
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();

  const effectiveProjectId = apiKey.projectId ?? query.projectId;

  if (!effectiveProjectId) {
    return { status: 400, body: { error: "Missing required query parameter: projectId" } };
  }

  // If API key is project-scoped, enforce it
  if (apiKey.projectId && query.projectId && apiKey.projectId !== query.projectId) {
    return { status: 403, body: { error: "Forbidden: cross-project access not allowed" } };
  }

  // --- governanceCoverage ---
  const sessionCount = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM sessions WHERE project_id = $1`,
    [effectiveProjectId]
  );

  const turnCount = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1`,
    [effectiveProjectId]
  );

  // Artifacts: count tool_calls with artifacts_created set
  const artifactCount = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND tc.artifacts_created IS NOT NULL
       AND tc.artifacts_created != ''`,
    [effectiveProjectId]
  );

  const governanceCoverage = {
    totalSessions: sessionCount.rows[0]?.cnt ?? 0,
    totalDecisions: turnCount.rows[0]?.cnt ?? 0,
    totalArtifacts: artifactCount.rows[0]?.cnt ?? 0,
  };

  // --- compliancePosture ---
  // SOC 2 completeness: percentage of sessions with turns_captured == total_turns
  const completenessResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE turns_captured >= total_turns AND dropped_events = 0)::int AS complete
     FROM sessions WHERE project_id = $1`,
    [effectiveProjectId]
  );
  const total = completenessResult.rows[0]?.total ?? 0;
  const complete = completenessResult.rows[0]?.complete ?? 0;
  const soc2Completeness = total > 0 ? Math.round((complete / total) * 100 * 100) / 100 : 100;

  // ISO 42001 evidence freshness: how many days since last session ended
  const freshnessResult = await pool.query(
    `SELECT MAX(last_active_at::TIMESTAMPTZ) AS latest FROM sessions WHERE project_id = $1`,
    [effectiveProjectId]
  );
  const latest = freshnessResult.rows[0]?.latest;
  const daysSinceLast = latest
    ? Math.floor((Date.now() - new Date(latest).getTime()) / 86400_000)
    : 999;
  // Freshness as a score 0-100 (100 = today, decreasing with age)
  const iso42001EvidenceFreshness = Math.max(0, Math.min(100, 100 - daysSinceLast));

  const compliancePosture = {
    soc2Completeness,
    iso42001EvidenceFreshness,
  };

  // --- anomalySummary ---
  const anomalyTotal = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM anomaly_events
     WHERE project_id = $1 OR session_id IN (SELECT id FROM sessions WHERE project_id = $1)`,
    [effectiveProjectId]
  );

  const anomalyBySeverity = await pool.query(
    `SELECT
       COALESCE(SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END), 0)::int AS warning,
       COALESCE(SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END), 0)::int AS critical
     FROM anomaly_events
     WHERE project_id = $1 OR session_id IN (SELECT id FROM sessions WHERE project_id = $1)`,
    [effectiveProjectId]
  );

  const anomalyResolved = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM anomaly_events
     WHERE (project_id = $1 OR session_id IN (SELECT id FROM sessions WHERE project_id = $1))
       AND resolved_at IS NOT NULL`,
    [effectiveProjectId]
  );

  const totalAnomalies = anomalyTotal.rows[0]?.cnt ?? 0;
  const resolvedAnomalies = anomalyResolved.rows[0]?.cnt ?? 0;
  const resolutionRate = totalAnomalies > 0
    ? Math.round((resolvedAnomalies / totalAnomalies) * 100 * 100) / 100
    : 0;

  const anomalySummary = {
    total: totalAnomalies,
    bySeverity: {
      warning: anomalyBySeverity.rows[0]?.warning ?? 0,
      critical: anomalyBySeverity.rows[0]?.critical ?? 0,
    },
    resolutionRate,
  };

  // --- riskProfile ---
  // Check if session_risk table exists, if not use keyword classification from sessions
  let riskProfile = { low: 0, medium: 0, high: 0, critical: 0 };
  try {
    const riskResult = await pool.query(
      `SELECT risk_level, COUNT(*)::int AS cnt FROM session_risk
       WHERE session_id IN (SELECT id FROM sessions WHERE project_id = $1)
       GROUP BY risk_level`,
      [effectiveProjectId]
    );
    for (const row of riskResult.rows) {
      const level = (row.risk_level as string).toLowerCase();
      if (level in riskProfile) {
        riskProfile[level as keyof typeof riskProfile] = row.cnt;
      }
    }
  } catch {
    // session_risk table doesn't exist yet; classify on the fly
    // H2 fix: Add LIMIT to prevent unbounded result sets
    const sessions = await pool.query(
      `SELECT initial_intent FROM sessions WHERE project_id = $1 LIMIT 10000`,
      [effectiveProjectId]
    );
    for (const row of sessions.rows) {
      // FIND-1-M re-open: sanitise the intent before classification
      // as defence-in-depth. Risk classification shouldn't key on a
      // `[Image: source: /path]` placeholder shape anyway; masking it
      // to `[attachment]` keeps the classifier consistent across
      // masked and raw rows.
      const rawIntent = (row.initial_intent as string | null) ?? "";
      const sanitized = maskPlaceholderPaths(rawIntent) ?? "";
      const level = classifyRiskLevel(sanitized);
      riskProfile[level as keyof typeof riskProfile]++;
    }
  }

  // --- frameworkChecklist ---
  const frameworkChecklist = buildFrameworkChecklist(governanceCoverage, compliancePosture, anomalySummary);

  return {
    status: 200,
    body: {
      governanceCoverage,
      compliancePosture,
      anomalySummary,
      riskProfile,
      frameworkChecklist,
    },
  };
}

// M1 fix: classifyRiskLevel imported from canonical location (risk/classification.ts)

function buildFrameworkChecklist(
  governance: { totalSessions: number; totalDecisions: number; totalArtifacts: number },
  compliance: { soc2Completeness: number; iso42001EvidenceFreshness: number },
  anomaly: { total: number; resolutionRate: number }
): Array<{ clause: string; status: string; evidence: string }> {
  return [
    {
      clause: "ISO 42001 Cl.4 - Context of the Organization",
      status: governance.totalSessions > 0 ? "met" : "not_met",
      evidence: `${governance.totalSessions} AI sessions tracked across the organization`,
    },
    {
      clause: "ISO 42001 Cl.5 - Leadership",
      status: "met",
      evidence: "Management review dashboard available for governance oversight",
    },
    {
      clause: "ISO 42001 Cl.6 - Planning",
      status: governance.totalDecisions > 0 ? "met" : "not_met",
      evidence: `${governance.totalDecisions} AI decisions captured with full provenance`,
    },
    {
      clause: "ISO 42001 Cl.7 - Support",
      status: compliance.soc2Completeness > 90 ? "met" : "partial",
      evidence: `SOC 2 completeness at ${compliance.soc2Completeness}%`,
    },
    {
      clause: "ISO 42001 Cl.8 - Operation",
      // M2 fix: Changed from >= 0 (always true) to > 0 so it only shows "met" when artifacts exist
      status: governance.totalArtifacts > 0 ? "met" : "not_met",
      evidence: `${governance.totalArtifacts} artifacts produced with traceability`,
    },
    {
      clause: "ISO 42001 Cl.9 - Performance Evaluation",
      status: compliance.iso42001EvidenceFreshness >= 50 ? "met" : "partial",
      evidence: `Evidence freshness score: ${compliance.iso42001EvidenceFreshness}/100`,
    },
    {
      clause: "ISO 42001 Cl.10 - Improvement",
      status: anomaly.total > 0 && anomaly.resolutionRate >= 50 ? "met" : "partial",
      evidence: `${anomaly.total} anomalies detected, ${anomaly.resolutionRate}% resolution rate`,
    },
  ];
}
