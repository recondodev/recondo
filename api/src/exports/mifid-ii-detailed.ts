/**
 * Sprint 11 Deliverable 1: MiFID II Detailed Export with Article Mapping
 *
 * POST /v1/exports/mifid-ii/detailed
 *
 * Enhanced MiFID II export mapping evidence to specific articles:
 * - Article 17: Algorithmic Trading
 * - Article 25: Investment Decision Record-Keeping
 * - Article 16: Organisational Requirements
 * - Article 48: Risk Controls
 *
 * Auth required, project scoped.
 */

import { getPool, maskPlaceholderPaths } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

const QUERY_LIMIT = 10000;

export async function handleMifidIIDetailed(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const startDate = body.startDate as string | undefined;
  const endDate = body.endDate as string | undefined;
  const modelId = body.modelId as string | undefined;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const pool = getPool();

  // ----------------------------------------------------------
  // Article 17: Algorithmic Trading — algorithmDescription + tradingDecisions
  // ----------------------------------------------------------

  // algorithmDescription: get model, provider, systemPromptHash from sessions
  const algDescResult = await pool.query(
    `SELECT model, provider, system_prompt_hash, COUNT(*)::int AS session_count
     FROM sessions
     WHERE project_id = $1
       AND ($2::TEXT IS NULL OR started_at::timestamptz >= $2::timestamptz)
       AND ($3::TEXT IS NULL OR started_at::timestamptz <= $3::timestamptz)
       AND ($4::TEXT IS NULL OR model = $4)
     GROUP BY model, provider, system_prompt_hash
     ORDER BY session_count DESC
     LIMIT 1`,
    [projectId, startDate ?? null, endDate ?? null, modelId ?? null]
  );

  const algRow = algDescResult.rows[0];
  const algorithmDescription = {
    model: algRow?.model ?? null,
    provider: algRow?.provider ?? null,
    systemPromptHash: algRow?.system_prompt_hash ?? null,
    sessionCount: algRow ? Number(algRow.session_count) : 0,
  };

  // tradingDecisions: sessions with turn counts and tool call counts
  const tradingDecisionsResult = await pool.query(
    `SELECT s.id AS session_id, s.initial_intent,
            COUNT(t.id)::int AS turn_count,
            COALESCE(SUM(t.tool_call_count), 0)::int AS tool_calls
     FROM sessions s
     LEFT JOIN turns t ON t.session_id = s.id
       AND ($2::TEXT IS NULL OR t.timestamp::timestamptz >= $2::timestamptz)
       AND ($3::TEXT IS NULL OR t.timestamp::timestamptz <= $3::timestamptz)
       AND ($4::TEXT IS NULL OR t.model = $4)
     WHERE s.project_id = $1
       AND ($2::TEXT IS NULL OR s.started_at::timestamptz >= $2::timestamptz)
       AND ($3::TEXT IS NULL OR s.started_at::timestamptz <= $3::timestamptz)
       AND ($4::TEXT IS NULL OR s.model = $4)
     GROUP BY s.id, s.initial_intent
     ORDER BY s.started_at DESC
     LIMIT $5`,
    [projectId, startDate ?? null, endDate ?? null, modelId ?? null, QUERY_LIMIT]
  );

  // FIND-1-M re-open: MiFID II exports are delivered to REGULATORS.
  // A placeholder path (`[Image: source: /Users/.../N.png]`) leaking
  // into an `intent` field of a regulator-facing export is the worst
  // case. Run every user-visible text field through
  // `maskPlaceholderPaths` before serialisation. Raw DB storage stays
  // byte-complete for the compliance audit trail; only the exported
  // view is sanitised.
  const tradingDecisions = tradingDecisionsResult.rows.map((r) => ({
    sessionId: r.session_id,
    intent: maskPlaceholderPaths(r.initial_intent as string | null),
    turnCount: Number(r.turn_count),
    toolCalls: Number(r.tool_calls),
  }));

  // ----------------------------------------------------------
  // Article 25: Investment Decision Record-Keeping — decisionAuditTrail
  // ----------------------------------------------------------

  const auditTrailResult = await pool.query(
    `SELECT t.id AS turn_id, t.session_id, t.timestamp, t.model, t.response_text
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND ($2::TEXT IS NULL OR t.timestamp::timestamptz >= $2::timestamptz)
       AND ($3::TEXT IS NULL OR t.timestamp::timestamptz <= $3::timestamptz)
       AND ($4::TEXT IS NULL OR t.model = $4)
     ORDER BY t.timestamp ASC
     LIMIT $5`,
    [projectId, startDate ?? null, endDate ?? null, modelId ?? null, QUERY_LIMIT]
  );

  const decisionAuditTrail = auditTrailResult.rows.map((r) => ({
    sessionId: r.session_id,
    turnId: r.turn_id,
    timestamp: r.timestamp,
    model: r.model,
    // FIND-1-M re-open: response_text can echo the user's attached
    // path back in tool-result fan-out responses.
    responseText: maskPlaceholderPaths(r.response_text as string | null),
  }));

  const totalDecisions = decisionAuditTrail.length;

  // ----------------------------------------------------------
  // Article 16: Organisational Requirements — orderGenerationRecords
  // ----------------------------------------------------------

  const orderRecordsResult = await pool.query(
    `SELECT tc.turn_id, t.session_id, tc.tool_name, tc.tool_input
     FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND ($2::TEXT IS NULL OR t.timestamp::timestamptz >= $2::timestamptz)
       AND ($3::TEXT IS NULL OR t.timestamp::timestamptz <= $3::timestamptz)
       AND ($4::TEXT IS NULL OR t.model = $4)
     ORDER BY t.timestamp ASC
     LIMIT $5`,
    [projectId, startDate ?? null, endDate ?? null, modelId ?? null, QUERY_LIMIT]
  );

  const orderGenerationRecords = orderRecordsResult.rows.map((r) => ({
    sessionId: r.session_id,
    turnId: r.turn_id,
    toolName: r.tool_name,
    // FIND-1-M re-open: tool_input may carry an image-attach
    // placeholder when the caller attached an image to a tool result.
    toolInput: maskPlaceholderPaths(r.tool_input as string | null),
  }));

  const totalOrderEvents = orderGenerationRecords.length;

  // ----------------------------------------------------------
  // Article 48: Risk Controls — anomalyCount, anomalyByType, riskClassifications, monitoringActive
  // ----------------------------------------------------------

  // Anomaly counts by type
  const anomalyResult = await pool.query(
    `SELECT anomaly_type, COUNT(*)::int AS cnt
     FROM anomaly_events ae
     JOIN sessions s ON ae.session_id = s.id
     WHERE s.project_id = $1
       AND ($2::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ >= $2::TIMESTAMPTZ)
       AND ($3::TEXT IS NULL OR ae.detected_at::TIMESTAMPTZ <= $3::TIMESTAMPTZ)
     GROUP BY anomaly_type
     LIMIT $4`,
    [projectId, startDate ?? null, endDate ?? null, QUERY_LIMIT]
  );

  const anomalyByType: Record<string, number> = {};
  let anomalyCount = 0;
  for (const row of anomalyResult.rows) {
    anomalyByType[row.anomaly_type] = Number(row.cnt);
    anomalyCount += Number(row.cnt);
  }

  // Risk classifications from session_risk JOIN sessions
  // Gracefully handle case where session_risk table doesn't exist yet
  const riskClassifications: Record<string, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0,
  };
  try {
    const riskClassResult = await pool.query(
      `SELECT sr.risk_level, COUNT(*)::int AS cnt
       FROM session_risk sr
       JOIN sessions s ON sr.session_id = s.id
       WHERE s.project_id = $1
         AND ($2::TEXT IS NULL OR s.started_at::timestamptz >= $2::timestamptz)
         AND ($3::TEXT IS NULL OR s.started_at::timestamptz <= $3::timestamptz)
       GROUP BY sr.risk_level
       LIMIT $4`,
      [projectId, startDate ?? null, endDate ?? null, QUERY_LIMIT]
    );

    for (const row of riskClassResult.rows) {
      if (row.risk_level in riskClassifications) {
        riskClassifications[row.risk_level] = Number(row.cnt);
      }
    }
  } catch {
    // session_risk table may not exist yet — return zeros
  }

  // monitoringActive: true if there has been any session activity in the last 24 hours.
  // Intentionally NOT filtered by the report's startDate/endDate range — monitoring status
  // reflects current system health (is the system actively being monitored right now?),
  // not the historical period covered by the report.
  const activityResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt
     FROM sessions
     WHERE project_id = $1
       AND last_active_at::timestamptz >= $2::timestamptz`,
    [projectId, new Date(Date.now() - 86400_000).toISOString()]
  );
  const monitoringActive = Number(activityResult.rows[0]?.cnt ?? 0) > 0;

  // ----------------------------------------------------------
  // Compute metadata date range
  // ----------------------------------------------------------

  const dateRangeResult = await pool.query(
    `SELECT MIN(t.timestamp) AS min_ts, MAX(t.timestamp) AS max_ts
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND ($2::TEXT IS NULL OR t.timestamp::timestamptz >= $2::timestamptz)
       AND ($3::TEXT IS NULL OR t.timestamp::timestamptz <= $3::timestamptz)`,
    [projectId, startDate ?? null, endDate ?? null]
  );

  const dateRange = {
    start: dateRangeResult.rows[0]?.min_ts ?? startDate ?? null,
    end: dateRangeResult.rows[0]?.max_ts ?? endDate ?? null,
  };

  return {
    status: 200,
    body: {
      standard: "MiFID II / MiFIR",
      generatedAt: new Date().toISOString(),
      projectId,
      articles: {
        article_17: {
          title: "Algorithmic Trading",
          description:
            "Evidence of algorithmic trading system description, including model details and trading decisions made by AI agents.",
          evidence: {
            algorithmDescription,
            tradingDecisions,
          },
        },
        article_25: {
          title: "Investment Decision Record-Keeping",
          description:
            "Complete audit trail of investment decisions made by AI agents, including timestamps, models, and response text.",
          evidence: {
            decisionAuditTrail,
            totalDecisions,
          },
        },
        article_16: {
          title: "Organisational Requirements",
          description:
            "Records of order generation events triggered by AI tool calls, including tool names and inputs.",
          evidence: {
            orderGenerationRecords,
            totalOrderEvents,
          },
        },
        article_48: {
          title: "Risk Controls",
          description:
            "Risk monitoring evidence including anomaly detection counts, risk classifications, and monitoring status.",
          evidence: {
            anomalyCount,
            anomalyByType,
            riskClassifications,
            monitoringActive,
          },
        },
      },
      metadata: {
        dateRange,
        generatorVersion: "1.0.0",
      },
    },
  };
}
