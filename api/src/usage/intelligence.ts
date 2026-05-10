/**
 * Sprint 9 Deliverable 5: Full Usage Intelligence
 *
 * 4 new endpoints:
 * - GET /v1/usage/cost-by-team    — cost by agent
 * - GET /v1/usage/developer-productivity — sessions/developer, turn counts
 * - GET /v1/usage/model-analysis  — model comparison (cost, tokens, latency per model)
 * - GET /v1/usage/tool-analytics  — tool call frequency, success rate, avg latency per tool
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

/**
 * GET /v1/usage/cost-by-team
 * Returns cost breakdown by agent_id.
 */
export async function handleCostByTeam(
  apiKey: ApiKeyInfo,
  query: { projectId?: string; period?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();
  const effectiveProjectId = apiKey.projectId ?? query.projectId;

  if (!effectiveProjectId) {
    return { status: 400, body: { error: "Missing required query parameter: projectId" } };
  }

  if (apiKey.projectId && query.projectId && apiKey.projectId !== query.projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  // H3 fix: Apply date filtering based on period parameter
  // daily = last 1 day, weekly = last 7 days, monthly = last 30 days
  const periodConditions: string[] = ["s.project_id = $1"];
  const periodParams: unknown[] = [effectiveProjectId];

  if (query.period === "daily") {
    periodConditions.push(`t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '1 day'`);
  } else if (query.period === "weekly") {
    periodConditions.push(`t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '7 days'`);
  } else if (query.period === "monthly") {
    periodConditions.push(`t.timestamp::TIMESTAMPTZ >= NOW() - INTERVAL '30 days'`);
  }

  const periodWhere = periodConditions.join(" AND ");

  // H2 fix: Add LIMIT to prevent unbounded result sets
  const result = await pool.query(
    `SELECT
       s.agent_id AS agent_id,
       COUNT(DISTINCT s.id)::int AS session_count,
       COUNT(t.id)::int AS turn_count,
       COALESCE(SUM(t.input_tokens + t.output_tokens), 0)::bigint AS total_tokens,
       COALESCE(SUM(t.cost_usd), 0) AS total_cost_usd
     FROM sessions s
     LEFT JOIN turns t ON t.session_id = s.id
     WHERE ${periodWhere}
     GROUP BY s.agent_id
     ORDER BY total_cost_usd DESC
     LIMIT 10000`,
    periodParams
  );

  const breakdown = result.rows.map((r: Record<string, unknown>) => ({
    agentId: r.agent_id as string,
    sessionCount: Number(r.session_count),
    turnCount: Number(r.turn_count),
    totalTokens: Number(r.total_tokens),
    totalCostUsd: Number(Number(r.total_cost_usd || 0).toFixed(6)),
  }));

  return {
    status: 200,
    body: { breakdown },
  };
}

/**
 * GET /v1/usage/developer-productivity
 * Returns per-developer (agent) metrics.
 */
export async function handleDeveloperProductivity(
  apiKey: ApiKeyInfo,
  query: { projectId?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();
  const effectiveProjectId = apiKey.projectId ?? query.projectId;

  if (!effectiveProjectId) {
    return { status: 400, body: { error: "Missing required query parameter: projectId" } };
  }

  if (apiKey.projectId && query.projectId && apiKey.projectId !== query.projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  // H2 fix: Add LIMIT to prevent unbounded result sets
  const result = await pool.query(
    `SELECT
       s.agent_id,
       COUNT(DISTINCT s.id)::int AS session_count,
       COUNT(t.id)::int AS turn_count,
       COALESCE(SUM(t.input_tokens + t.output_tokens), 0)::bigint AS total_tokens,
       COALESCE(SUM(t.cost_usd), 0) AS total_cost_usd,
       COALESCE(AVG(t.duration_ms), 0) AS avg_duration_ms
     FROM sessions s
     LEFT JOIN turns t ON t.session_id = s.id
     WHERE s.project_id = $1 AND s.agent_id IS NOT NULL
     GROUP BY s.agent_id
     ORDER BY session_count DESC
     LIMIT 10000`,
    [effectiveProjectId]
  );

  const developers = result.rows.map((r: Record<string, unknown>) => ({
    agentId: r.agent_id as string,
    sessionCount: Number(r.session_count),
    turnCount: Number(r.turn_count),
    totalTokens: Number(r.total_tokens),
    totalCostUsd: Number(Number(r.total_cost_usd || 0).toFixed(6)),
    avgDurationMs: Math.round(Number(r.avg_duration_ms || 0)),
  }));

  return {
    status: 200,
    body: { developers },
  };
}

/**
 * GET /v1/usage/model-analysis
 * Returns model comparison data.
 */
export async function handleModelAnalysis(
  apiKey: ApiKeyInfo,
  query: { projectId?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();
  const effectiveProjectId = apiKey.projectId ?? query.projectId;

  if (!effectiveProjectId) {
    return { status: 400, body: { error: "Missing required query parameter: projectId" } };
  }

  if (apiKey.projectId && query.projectId && apiKey.projectId !== query.projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  // H2 fix: Add LIMIT to prevent unbounded result sets
  const result = await pool.query(
    `SELECT
       t.model,
       COALESCE(t.provider, s.provider) AS provider,
       COUNT(t.id)::int AS turn_count,
       COALESCE(SUM(t.input_tokens + t.output_tokens), 0)::bigint AS total_tokens,
       COALESCE(SUM(t.cost_usd), 0) AS total_cost_usd,
       COALESCE(AVG(t.duration_ms), 0) AS avg_latency_ms
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
     GROUP BY t.model, COALESCE(t.provider, s.provider)
     ORDER BY total_cost_usd DESC
     LIMIT 10000`,
    [effectiveProjectId]
  );

  const models = result.rows.map((r: Record<string, unknown>) => ({
    model: r.model as string,
    provider: r.provider as string,
    turnCount: Number(r.turn_count),
    totalTokens: Number(r.total_tokens),
    totalCostUsd: Number(Number(r.total_cost_usd || 0).toFixed(6)),
    avgLatencyMs: Math.round(Number(r.avg_latency_ms || 0)),
  }));

  return {
    status: 200,
    body: { models },
  };
}

/**
 * GET /v1/usage/tool-analytics
 * Returns per-tool analytics with frequency, success rate, and avg latency.
 */
export async function handleToolAnalytics(
  apiKey: ApiKeyInfo,
  query: { projectId?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();
  const effectiveProjectId = apiKey.projectId ?? query.projectId;

  if (!effectiveProjectId) {
    return { status: 400, body: { error: "Missing required query parameter: projectId" } };
  }

  if (apiKey.projectId && query.projectId && apiKey.projectId !== query.projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  // H2 fix: Add LIMIT to prevent unbounded result sets
  const result = await pool.query(
    `SELECT
       tc.tool_name,
       COUNT(tc.id)::int AS count,
       COUNT(*) FILTER (WHERE tc.status = 'success')::int AS success_count,
       COALESCE(AVG(tc.duration_ms), 0) AS avg_duration_ms
     FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
     GROUP BY tc.tool_name
     ORDER BY count DESC
     LIMIT 10000`,
    [effectiveProjectId]
  );

  const tools = result.rows.map((r: Record<string, unknown>) => {
    const count = Number(r.count);
    const successCount = Number(r.success_count);
    return {
      toolName: r.tool_name as string,
      count,
      successRate: count > 0 ? Number((successCount / count).toFixed(4)) : 0,
      avgDurationMs: Math.round(Number(r.avg_duration_ms || 0)),
    };
  });

  return {
    status: 200,
    body: { tools },
  };
}
