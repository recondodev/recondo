/**
 * Sprint 10 Deliverable 1: ISO 42001 Clause-by-Clause Evidence Export
 *
 * POST /v1/exports/iso42001/evidence
 *
 * Returns per-clause evidence for ISO/IEC 42001:2023 compliance:
 * - Cl.6.1: Risk Assessment
 * - Cl.8.4: AI Impact Assessment
 * - Cl.8.5: AI System Lifecycle
 * - Cl.9.1: Monitoring
 * - Cl.9.3: Management Review
 * - Cl.10:  Continual Improvement
 */

import { getPool, maskPlaceholderPaths } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

export async function handleIso42001Evidence(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const startDate = body.startDate as string | undefined;
  const endDate = body.endDate as string | undefined;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const pool = getPool();

  // -----------------------------------------------------------------------
  // Cl.6.1: Risk Assessment
  // -----------------------------------------------------------------------
  let riskClassifications: Record<string, number> = { low: 0, medium: 0, high: 0, critical: 0 };
  let classificationHistory: Array<Record<string, unknown>> = [];

  try {
    // D1 fix: session_risk has no project_id column — JOIN through sessions for project scoping
    const riskCountsResult = await pool.query(
      `SELECT sr.risk_level, COUNT(*)::int AS cnt
       FROM session_risk sr
       JOIN sessions s ON sr.session_id = s.id
       WHERE s.project_id = $1
         AND ($2::TEXT IS NULL OR sr.classified_at >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR sr.classified_at <= $3::TIMESTAMPTZ)
       GROUP BY sr.risk_level
       LIMIT 10000`,
      [projectId, startDate ?? null, endDate ?? null]
    );

    for (const row of riskCountsResult.rows) {
      const level = row.risk_level as string;
      if (level in riskClassifications) {
        riskClassifications[level] = row.cnt;
      }
    }

    // D1 fix: JOIN through sessions for project scoping (session_risk lacks project_id)
    const historyResult = await pool.query(
      `SELECT sr.session_id, s.initial_intent, sr.risk_level, sr.classified_at
       FROM session_risk sr
       JOIN sessions s ON sr.session_id = s.id
       WHERE s.project_id = $1
         AND ($2::TEXT IS NULL OR sr.classified_at >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR sr.classified_at <= $3::TIMESTAMPTZ)
       ORDER BY sr.classified_at DESC
       LIMIT 10000`,
      [projectId, startDate ?? null, endDate ?? null]
    );

    classificationHistory = historyResult.rows.map((r) => ({
      sessionId: r.session_id,
      // FIND-1-M re-open: ISO 42001 evidence is attestation-graded.
      // Mask placeholder paths out of `intent`.
      intent: maskPlaceholderPaths(r.initial_intent as string | null),
      riskLevel: r.risk_level,
      classifiedAt: r.classified_at instanceof Date ? r.classified_at.toISOString() : String(r.classified_at),
    }));
  } catch {
    // session_risk table may not exist
  }

  const cl61Status = classificationHistory.length > 0 ? "evidenced" : "no_data";

  // -----------------------------------------------------------------------
  // Cl.8.4: AI Impact Assessment
  // -----------------------------------------------------------------------
  let agentCount = 0;
  let assessments: Array<Record<string, unknown>> = [];

  try {
    const agentsResult = await pool.query(
      `SELECT
         COALESCE(s.agent_id, s.id) AS agent_id,
         COUNT(DISTINCT s.id)::int AS session_count,
         COALESCE(SUM(s.total_turns), 0)::int AS turn_count
       FROM sessions s
       WHERE s.project_id = $1
         AND ($2::TEXT IS NULL OR s.started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR s.started_at::timestamptz <= $3::timestamptz)
       GROUP BY COALESCE(s.agent_id, s.id)
       LIMIT 10000`,
      [projectId, startDate ?? null, endDate ?? null]
    );

    agentCount = agentsResult.rows.length;

    // TS3 fix (N+1): Aggregate anomaly counts per agent_id in a single query with GROUP BY
    // instead of one query per agent.
    const anomalyMap = new Map<string, number>();
    try {
      const anomalyResult = await pool.query(
        `SELECT COALESCE(s.agent_id, s.id) AS agent_id, COUNT(*)::int AS cnt
         FROM anomaly_events ae
         JOIN sessions s ON ae.session_id = s.id
         WHERE s.project_id = $1
           AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
           AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)
         GROUP BY COALESCE(s.agent_id, s.id)
         LIMIT 10000`,
        [projectId, startDate ?? null, endDate ?? null]
      );
      for (const row of anomalyResult.rows) {
        anomalyMap.set(row.agent_id as string, row.cnt as number);
      }
    } catch (err) {
      // TS3 fix: Log rather than silently swallow
      console.error("Failed to query anomaly counts per agent:", err instanceof Error ? err.message : err);
    }

    for (const row of agentsResult.rows) {
      assessments.push({
        agentId: row.agent_id,
        sessionCount: row.session_count,
        turnCount: row.turn_count,
        anomalyCount: anomalyMap.get(row.agent_id as string) ?? 0,
      });
    }
  } catch (err) {
    // TS3 fix: Log rather than silently swallow
    console.error("Failed to query agents for Cl.8.4:", err instanceof Error ? err.message : err);
  }

  const cl84Status = assessments.length > 0 ? "evidenced" : "no_data";

  // -----------------------------------------------------------------------
  // Cl.8.5: AI System Lifecycle
  // -----------------------------------------------------------------------
  let totalSessions = 0;
  let sessionsByModel: Array<Record<string, unknown>> = [];
  let dateRange: Record<string, string> = { earliest: "", latest: "" };

  try {
    const sessionCountResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM sessions
       WHERE project_id = $1
         AND ($2::TEXT IS NULL OR started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR started_at::timestamptz <= $3::timestamptz)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    totalSessions = sessionCountResult.rows[0]?.cnt ?? 0;

    const modelResult = await pool.query(
      `SELECT COALESCE(model, 'unknown') AS model, COUNT(*)::int AS count
       FROM sessions
       WHERE project_id = $1
         AND ($2::TEXT IS NULL OR started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR started_at::timestamptz <= $3::timestamptz)
       GROUP BY COALESCE(model, 'unknown')
       ORDER BY count DESC
       LIMIT 10000`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    sessionsByModel = modelResult.rows.map((r) => ({
      model: r.model,
      count: r.count,
    }));

    const rangeResult = await pool.query(
      `SELECT MIN(started_at) AS earliest, MAX(started_at) AS latest
       FROM sessions
       WHERE project_id = $1
         AND ($2::TEXT IS NULL OR started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR started_at::timestamptz <= $3::timestamptz)`,
      [projectId, startDate ?? null, endDate ?? null]
    );

    dateRange = {
      earliest: rangeResult.rows[0]?.earliest ?? "",
      latest: rangeResult.rows[0]?.latest ?? "",
    };
  } catch (err) {
    // TS3 fix: Log rather than silently swallow
    console.error("Failed to query Cl.8.5 lifecycle data:", err instanceof Error ? err.message : err);
  }

  const cl85Status = totalSessions > 0 ? "evidenced" : "no_data";

  // -----------------------------------------------------------------------
  // Cl.9.1: Monitoring
  // -----------------------------------------------------------------------
  let anomalyCount = 0;
  let anomalyByType: Record<string, number> = {};
  let driftEventCount = 0;

  try {
    const anomalyCountResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM anomaly_events ae
       WHERE ae.project_id = $1
         AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    anomalyCount = anomalyCountResult.rows[0]?.cnt ?? 0;

    const byTypeResult = await pool.query(
      `SELECT anomaly_type, COUNT(*)::int AS cnt
       FROM anomaly_events ae
       WHERE ae.project_id = $1
         AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)
       GROUP BY anomaly_type
       LIMIT 10000`,
      [projectId, startDate ?? null, endDate ?? null]
    );

    for (const row of byTypeResult.rows) {
      anomalyByType[row.anomaly_type] = row.cnt;
    }

    // Drift events are anomalies with "_drift" in the type
    const driftResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM anomaly_events ae
       WHERE ae.project_id = $1
         AND ae.anomaly_type LIKE '%drift%'
         AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    driftEventCount = driftResult.rows[0]?.cnt ?? 0;
  } catch (err) {
    // anomaly_events may not exist or lack project_id
    console.error("Cl.9.1 primary anomaly query failed, trying fallback:", err instanceof Error ? err.message : err);
    try {
      // Fallback: join through sessions
      const anomalyCountResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM anomaly_events ae
         JOIN sessions s ON ae.session_id = s.id
         WHERE s.project_id = $1
           AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
           AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
        [projectId, startDate ?? null, endDate ?? null]
      );
      anomalyCount = anomalyCountResult.rows[0]?.cnt ?? 0;

      const byTypeResult = await pool.query(
        `SELECT ae.anomaly_type, COUNT(*)::int AS cnt
         FROM anomaly_events ae
         JOIN sessions s ON ae.session_id = s.id
         WHERE s.project_id = $1
           AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
           AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)
         GROUP BY ae.anomaly_type
         LIMIT 10000`,
        [projectId, startDate ?? null, endDate ?? null]
      );

      for (const row of byTypeResult.rows) {
        anomalyByType[row.anomaly_type] = row.cnt;
      }

      const driftResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM anomaly_events ae
         JOIN sessions s ON ae.session_id = s.id
         WHERE s.project_id = $1
           AND ae.anomaly_type LIKE '%drift%'
           AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
           AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
        [projectId, startDate ?? null, endDate ?? null]
      );
      driftEventCount = driftResult.rows[0]?.cnt ?? 0;
    } catch (fallbackErr) {
      // TS3 fix: Log rather than silently swallow
      console.error("Cl.9.1 fallback anomaly query also failed:", fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
    }
  }

  // S2 fix: Compute monitoringActive from actual data — true if any sessions or turns
  // exist in the last 7 days for this project.
  let monitoringActive = false;
  try {
    const recentActivityResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM sessions
       WHERE project_id = $1 AND started_at::timestamptz >= NOW() - INTERVAL '7 days'
       LIMIT 1`,
      [projectId]
    );
    if ((recentActivityResult.rows[0]?.cnt ?? 0) > 0) {
      monitoringActive = true;
    } else {
      const recentTurnsResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM turns t
         JOIN sessions s ON t.session_id = s.id
         WHERE s.project_id = $1 AND t.timestamp::timestamptz >= NOW() - INTERVAL '7 days'
         LIMIT 1`,
        [projectId]
      );
      monitoringActive = (recentTurnsResult.rows[0]?.cnt ?? 0) > 0;
    }
  } catch (err) {
    console.error("Failed to compute monitoringActive:", err instanceof Error ? err.message : err);
  }

  const cl91Status = anomalyCount > 0 ? "evidenced" : "no_data";

  // -----------------------------------------------------------------------
  // Cl.9.3: Management Review
  // -----------------------------------------------------------------------
  let governanceCoverage: Record<string, number> = { sessions: 0, decisions: 0, artifacts: 0 };
  let compliancePosture: Record<string, unknown> = { soc2Completeness: 0, evidenceFreshness: 0 };

  try {
    // NEW-4 fix: Cl.9.3 queries now respect startDate/endDate like all other clauses
    // Sessions count
    const sessionsCountResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM sessions
       WHERE project_id = $1
         AND ($2::TEXT IS NULL OR started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR started_at::timestamptz <= $3::timestamptz)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    governanceCoverage.sessions = sessionsCountResult.rows[0]?.cnt ?? 0;

    // Decisions: count of turns (each turn is a decision point)
    const turnsCountResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE s.project_id = $1
         AND ($2::TEXT IS NULL OR s.started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR s.started_at::timestamptz <= $3::timestamptz)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    governanceCoverage.decisions = turnsCountResult.rows[0]?.cnt ?? 0;

    // Artifacts: count of tool_calls
    const artifactsCountResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM tool_calls tc
       JOIN turns t ON tc.turn_id = t.id
       JOIN sessions s ON t.session_id = s.id
       WHERE s.project_id = $1
         AND ($2::TEXT IS NULL OR s.started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR s.started_at::timestamptz <= $3::timestamptz)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    governanceCoverage.artifacts = artifactsCountResult.rows[0]?.cnt ?? 0;

    // SOC 2 completeness: percentage of sessions with all key fields
    const completeResult = await pool.query(
      `SELECT
         COUNT(*)::float AS total,
         COUNT(CASE WHEN system_prompt_hash IS NOT NULL AND model IS NOT NULL THEN 1 END)::float AS complete
       FROM sessions
       WHERE project_id = $1
         AND ($2::TEXT IS NULL OR started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR started_at::timestamptz <= $3::timestamptz)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    const total = completeResult.rows[0]?.total ?? 0;
    const complete = completeResult.rows[0]?.complete ?? 0;
    const soc2Completeness = total > 0 ? Math.round((complete / total) * 100) : 0;

    // Evidence freshness: days since most recent session
    const freshnessResult = await pool.query(
      `SELECT MAX(started_at) AS latest FROM sessions
       WHERE project_id = $1
         AND ($2::TEXT IS NULL OR started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR started_at::timestamptz <= $3::timestamptz)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    const latestStr = freshnessResult.rows[0]?.latest;
    let evidenceFreshness = 0;
    if (latestStr) {
      const latestDate = new Date(latestStr);
      const daysSince = Math.floor((Date.now() - latestDate.getTime()) / (1000 * 60 * 60 * 24));
      evidenceFreshness = daysSince;
    }

    compliancePosture = {
      soc2Completeness,
      evidenceFreshness,
    };
  } catch (err) {
    // TS3 fix: Log rather than silently swallow
    console.error("Failed to query Cl.9.3 management review data:", err instanceof Error ? err.message : err);
  }

  const cl93Status = governanceCoverage.sessions > 0 ? "evidenced" : "no_data";

  // -----------------------------------------------------------------------
  // Cl.10: Continual Improvement
  // -----------------------------------------------------------------------
  let totalAnomalies = 0;
  let resolvedAnomalies = 0;
  let resolutionRate = 0;
  let resolutionChain: Array<Record<string, unknown>> = [];

  try {
    const totalResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM anomaly_events
       WHERE project_id = $1
         AND ($2::TEXT IS NULL OR detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    totalAnomalies = totalResult.rows[0]?.cnt ?? 0;

    const resolvedResult = await pool.query(
      `SELECT COUNT(*)::int AS cnt
       FROM anomaly_events
       WHERE project_id = $1
         AND resolved_at IS NOT NULL
         AND ($2::TEXT IS NULL OR detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
      [projectId, startDate ?? null, endDate ?? null]
    );
    resolvedAnomalies = resolvedResult.rows[0]?.cnt ?? 0;

    resolutionRate = totalAnomalies > 0
      ? Math.round((resolvedAnomalies / totalAnomalies) * 100)
      : 0;

    // Resolution chain: resolved anomalies with details
    const chainResult = await pool.query(
      `SELECT id, anomaly_type, detected_at, resolved_at, resolution_note
       FROM anomaly_events
       WHERE project_id = $1
         AND resolved_at IS NOT NULL
         AND ($2::TEXT IS NULL OR detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
         AND ($3::TEXT IS NULL OR detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)
       ORDER BY resolved_at DESC
       LIMIT 10000`,
      [projectId, startDate ?? null, endDate ?? null]
    );

    resolutionChain = chainResult.rows.map((r) => ({
      anomalyId: r.id,
      type: r.anomaly_type,
      detectedAt: r.detected_at instanceof Date ? r.detected_at.toISOString() : String(r.detected_at),
      resolvedAt: r.resolved_at instanceof Date ? r.resolved_at.toISOString() : String(r.resolved_at),
      resolutionNote: r.resolution_note ?? null,
    }));
  } catch (err) {
    // Fallback: join through sessions
    console.error("Cl.10 primary query failed, trying fallback:", err instanceof Error ? err.message : err);
    try {
      const totalResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM anomaly_events ae
         JOIN sessions s ON ae.session_id = s.id
         WHERE s.project_id = $1
           AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
           AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
        [projectId, startDate ?? null, endDate ?? null]
      );
      totalAnomalies = totalResult.rows[0]?.cnt ?? 0;

      const resolvedResult = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM anomaly_events ae
         JOIN sessions s ON ae.session_id = s.id
         WHERE s.project_id = $1
           AND ae.resolved_at IS NOT NULL
           AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
           AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)`,
        [projectId, startDate ?? null, endDate ?? null]
      );
      resolvedAnomalies = resolvedResult.rows[0]?.cnt ?? 0;

      resolutionRate = totalAnomalies > 0
        ? Math.round((resolvedAnomalies / totalAnomalies) * 100)
        : 0;

      const chainResult = await pool.query(
        `SELECT ae.id, ae.anomaly_type, ae.detected_at, ae.resolved_at, ae.resolution_note
         FROM anomaly_events ae
         JOIN sessions s ON ae.session_id = s.id
         WHERE s.project_id = $1
           AND ae.resolved_at IS NOT NULL
           AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
           AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)
         ORDER BY ae.resolved_at DESC
         LIMIT 10000`,
        [projectId, startDate ?? null, endDate ?? null]
      );

      resolutionChain = chainResult.rows.map((r) => ({
        anomalyId: r.id,
        type: r.anomaly_type,
        detectedAt: r.detected_at instanceof Date ? r.detected_at.toISOString() : String(r.detected_at),
        resolvedAt: r.resolved_at instanceof Date ? r.resolved_at.toISOString() : String(r.resolved_at),
        resolutionNote: r.resolution_note ?? null,
      }));
    } catch (fallbackErr) {
      // TS3 fix: Log rather than silently swallow
      console.error("Cl.10 fallback query also failed:", fallbackErr instanceof Error ? fallbackErr.message : fallbackErr);
    }
  }

  const cl10Status = resolutionChain.length > 0 ? "evidenced" : "no_data";

  return {
    status: 200,
    body: {
      standard: "ISO/IEC 42001:2023",
      generatedAt: new Date().toISOString(),
      projectId,
      clauses: {
        cl_6_1: {
          title: "Risk Assessment",
          status: cl61Status,
          evidence: {
            riskClassifications,
            classificationHistory,
          },
        },
        cl_8_4: {
          title: "AI Impact Assessment",
          status: cl84Status,
          evidence: {
            agentCount,
            assessments,
          },
        },
        cl_8_5: {
          title: "AI System Lifecycle",
          status: cl85Status,
          evidence: {
            totalSessions,
            sessionsByModel,
            dateRange,
          },
        },
        cl_9_1: {
          title: "Monitoring",
          status: cl91Status,
          evidence: {
            anomalyCount,
            anomalyByType,
            driftEventCount,
            monitoringActive,
          },
        },
        cl_9_3: {
          title: "Management Review",
          status: cl93Status,
          evidence: {
            governanceCoverage,
            compliancePosture,
          },
        },
        cl_10: {
          title: "Continual Improvement",
          status: cl10Status,
          evidence: {
            totalAnomalies,
            resolvedAnomalies,
            resolutionRate,
            resolutionChain,
          },
        },
      },
    },
  };
}
