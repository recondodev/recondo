/**
 * Sprint 9 Deliverable 1: Continuous Monitoring Dashboard API (ISO 42001 Cl.9.1)
 *
 * GET /v1/dashboards/monitoring
 *
 * Real-time operational metrics:
 * - activeSessions: count of sessions active in last 24h
 * - turnsCaptured: { total, last24h, last7d }
 * - driftEvents: { systemPrompt, toolDefinition }
 * - toolDistribution: [{ tool, count, percentage }]
 * - tokenTrends: [{ period, inputTokens, outputTokens }]
 * - anomalyRate: { last30d, resolved, unresolved }
 *
 * Filterable by: agent, model, projectId
 * Returns the full monitoring dashboard for an authenticated key
 */

import { getPool } from "../db.js";
import type { ApiKeyInfo } from "../context.js";

interface MonitoringQuery {
  projectId?: string;
  agent?: string;
  model?: string;
}

export async function handleMonitoringDashboard(
  apiKey: ApiKeyInfo,
  query: MonitoringQuery
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();

  // Determine effective project: use API key's project if set, else query param
  const effectiveProjectId = apiKey.projectId ?? query.projectId;

  if (!effectiveProjectId) {
    return { status: 400, body: { error: "Missing required query parameter: projectId" } };
  }

  // C2 fix: If API key is project-scoped and differs from requested projectId, return 403
  if (apiKey.projectId && query.projectId && apiKey.projectId !== query.projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  // Build session filters
  const sessionConditions: string[] = ["s.project_id = $1"];
  const sessionParams: unknown[] = [effectiveProjectId];
  let paramIdx = 2;

  if (query.agent) {
    sessionConditions.push(`s.agent_id = $${paramIdx++}`);
    sessionParams.push(query.agent);
  }
  if (query.model) {
    sessionConditions.push(`s.model = $${paramIdx++}`);
    sessionParams.push(query.model);
  }

  const sessionWhere = sessionConditions.join(" AND ");

  // --- activeSessions: sessions with last_active_at within 24h ---
  const activeResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM sessions s
     WHERE ${sessionWhere}
       AND s.last_active_at::TIMESTAMPTZ >= NOW() - INTERVAL '24 hours'`,
    sessionParams
  );
  const activeSessions = activeResult.rows[0]?.cnt ?? 0;

  // --- turnsCaptured ---
  const turnsTotal = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE ${sessionWhere}`,
    sessionParams
  );
  const turnsLast24h = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE ${sessionWhere}
       AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '24 hours'`,
    sessionParams
  );
  const turnsLast7d = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE ${sessionWhere}
       AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '7 days'`,
    sessionParams
  );

  const turnsCaptured = {
    total: turnsTotal.rows[0]?.cnt ?? 0,
    last24h: turnsLast24h.rows[0]?.cnt ?? 0,
    last7d: turnsLast7d.rows[0]?.cnt ?? 0,
  };

  // --- driftEvents ---
  // System prompt drift: count distinct system_prompt_hash values > 1 for the project
  const promptDriftResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM (
       SELECT system_prompt_hash FROM sessions s
       WHERE ${sessionWhere}
       GROUP BY system_prompt_hash
     ) sub`,
    sessionParams
  );
  // The number of distinct hashes minus 1 = drift events (first hash is baseline)
  const distinctHashes = promptDriftResult.rows[0]?.cnt ?? 0;
  const systemPromptDrift = Math.max(0, distinctHashes - 1);

  // H4 fix: Query anomaly_events for tool_definition_drift events instead of hardcoding 0
  // Also applies agent/model filtering (M3) by joining through sessions
  const toolDriftResult = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM anomaly_events ae
     JOIN sessions s ON ae.session_id = s.id
     WHERE ${sessionWhere}
       AND ae.anomaly_type = 'tool_definition_drift'`,
    sessionParams
  );
  const toolDefinitionDrift = toolDriftResult.rows[0]?.cnt ?? 0;

  const driftEvents = {
    systemPrompt: systemPromptDrift,
    toolDefinition: toolDefinitionDrift,
  };

  // --- toolDistribution ---
  const toolResult = await pool.query(
    `SELECT tc.tool_name AS tool, COUNT(*)::int AS count
     FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE ${sessionWhere}
     GROUP BY tc.tool_name
     ORDER BY count DESC
     LIMIT 100`,
    sessionParams
  );

  const totalToolCalls = toolResult.rows.reduce(
    (sum: number, r: Record<string, unknown>) => sum + Number(r.count), 0
  );
  const toolDistribution = toolResult.rows.map((r: Record<string, unknown>) => ({
    tool: r.tool as string,
    count: Number(r.count),
    percentage: totalToolCalls > 0
      ? Number((Number(r.count) / totalToolCalls).toFixed(4))
      : 0,
  }));

  // --- tokenTrends: daily aggregation for last 30 days ---
  const tokenTrendsResult = await pool.query(
    `SELECT
       DATE_TRUNC('day', t.timestamp::TIMESTAMPTZ)::DATE AS period,
       SUM(t.input_tokens)::bigint AS input_tokens,
       SUM(t.output_tokens)::bigint AS output_tokens
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE ${sessionWhere}
       AND t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '30 days'
     GROUP BY DATE_TRUNC('day', t.timestamp::TIMESTAMPTZ)::DATE
     ORDER BY period ASC`,
    sessionParams
  );

  const tokenTrends = tokenTrendsResult.rows.map((r: Record<string, unknown>) => ({
    period: r.period instanceof Date ? r.period.toISOString().split("T")[0] : String(r.period),
    inputTokens: Number(r.input_tokens) || 0,
    outputTokens: Number(r.output_tokens) || 0,
  }));

  // --- anomalyRate ---
  // M3 fix: Add agent/model filtering to anomaly queries, matching the pattern used for other metrics
  const anomalyConditions: string[] = ["s.project_id = $1"];
  const anomalyParams: unknown[] = [effectiveProjectId];
  let anomalyParamIdx = 2;

  if (query.agent) {
    anomalyConditions.push(`s.agent_id = $${anomalyParamIdx++}`);
    anomalyParams.push(query.agent);
  }
  if (query.model) {
    anomalyConditions.push(`s.model = $${anomalyParamIdx++}`);
    anomalyParams.push(query.model);
  }

  const anomalyWhere = anomalyConditions.join(" AND ");

  const anomalyLast30d = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM anomaly_events ae
     JOIN sessions s ON ae.session_id = s.id
     WHERE ${anomalyWhere}
       AND ae.detected_at::TIMESTAMPTZ >= NOW() - INTERVAL '30 days'`,
    anomalyParams
  );

  const anomalyResolved = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM anomaly_events ae
     JOIN sessions s ON ae.session_id = s.id
     WHERE ${anomalyWhere}
       AND ae.resolved_at IS NOT NULL`,
    anomalyParams
  );

  const anomalyUnresolved = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM anomaly_events ae
     JOIN sessions s ON ae.session_id = s.id
     WHERE ${anomalyWhere}
       AND ae.resolved_at IS NULL`,
    anomalyParams
  );

  const anomalyRate = {
    last30d: anomalyLast30d.rows[0]?.cnt ?? 0,
    resolved: anomalyResolved.rows[0]?.cnt ?? 0,
    unresolved: anomalyUnresolved.rows[0]?.cnt ?? 0,
  };

  return {
    status: 200,
    body: {
      activeSessions,
      turnsCaptured,
      driftEvents,
      toolDistribution,
      tokenTrends,
      anomalyRate,
    },
  };
}
