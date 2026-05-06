/**
 * Sprint 6 Deliverable 4: Basic Usage Dashboard API
 *
 * Endpoints:
 * - GET /v1/usage/token-spend   — org-wide token spend over time
 * - GET /v1/usage/model-distribution — which models, relative cost
 * - GET /v1/usage/active-agents  — distinct agents and session counts
 * - GET /v1/usage/cost-trend     — cost over time with model breakdown
 *
 * N1: Architectural decision — these endpoints query raw tables (turns, sessions) for
 * real-time accuracy. Materialized views (mv_usage_hourly, mv_usage_daily, etc.) are
 * available for performance-optimized reads when data staleness is acceptable (e.g.,
 * executive dashboards, periodic reports). Clients requiring sub-second freshness
 * should use these endpoints; clients tolerating minutes/hours of lag may query MVs.
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";
import { VALID_PERIODS, dateTruncExpr } from "./utils.js";

/**
 * GET /v1/usage/token-spend
 * Returns org-wide token spend over time, grouped by period.
 */
export async function handleTokenSpend(
  apiKey: ApiKeyInfo,
  period?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Validate period
  const effectivePeriod = period ?? "daily";
  if (!VALID_PERIODS.has(effectivePeriod)) {
    return { status: 400, body: { error: `Invalid period: ${period}. Must be one of: daily, weekly, monthly` } };
  }

  const pool = getPool();
  const truncExpr = dateTruncExpr(effectivePeriod);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // W1 fix: Add LIMIT to prevent unbounded result sets
  const QUERY_LIMIT = 10000;
  const result = await pool.query(`
    SELECT
      ${truncExpr} AS period_start,
      SUM(t.input_tokens) AS total_input_tokens,
      SUM(t.output_tokens) AS total_output_tokens,
      SUM(t.input_tokens + t.output_tokens) AS total_tokens,
      SUM(t.cost_usd) AS total_cost_usd
    FROM turns t
    JOIN sessions s ON t.session_id = s.id
    ${where}
    GROUP BY ${truncExpr}
    ORDER BY period_start ASC
    LIMIT ${QUERY_LIMIT}
  `, params);

  const truncated = result.rows.length >= QUERY_LIMIT;

  const datapoints = result.rows.map((row: Record<string, unknown>) => ({
    periodStart: row.period_start instanceof Date
      ? row.period_start.toISOString()
      : String(row.period_start),
    totalInputTokens: Number(row.total_input_tokens) || 0,
    totalOutputTokens: Number(row.total_output_tokens) || 0,
    totalTokens: Number(row.total_tokens) || 0,
    totalCostUsd: Number(Number(row.total_cost_usd || 0).toFixed(6)),
  }));

  return { status: 200, body: { datapoints, truncated } };
}

/**
 * GET /v1/usage/model-distribution
 * Returns model distribution with relative cost percentages.
 */
export async function handleModelDistribution(
  apiKey: ApiKeyInfo,
  period?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const effectivePeriod = period ?? "daily";
  if (period && !VALID_PERIODS.has(effectivePeriod)) {
    return { status: 400, body: { error: `Invalid period: ${period}. Must be one of: daily, weekly, monthly` } };
  }

  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // W1 fix: Add LIMIT to prevent unbounded result sets
  const QUERY_LIMIT = 10000;
  const result = await pool.query(`
    SELECT
      t.model,
      COALESCE(t.provider, s.provider) AS provider,
      SUM(t.cost_usd) AS total_cost_usd,
      SUM(t.input_tokens + t.output_tokens) AS total_tokens,
      COUNT(t.id) AS turn_count
    FROM turns t
    JOIN sessions s ON t.session_id = s.id
    ${where}
    GROUP BY t.model, COALESCE(t.provider, s.provider)
    ORDER BY total_cost_usd DESC
    LIMIT ${QUERY_LIMIT}
  `, params);

  const truncated = result.rows.length >= QUERY_LIMIT;

  // Calculate total cost for percentages
  const totalCost = result.rows.reduce(
    (sum: number, row: Record<string, unknown>) => sum + Number(row.total_cost_usd || 0), 0
  );

  const models = result.rows.map((row: Record<string, unknown>) => {
    const modelCost = Number(row.total_cost_usd || 0);
    return {
      model: row.model,
      provider: row.provider,
      totalCostUsd: Number(modelCost.toFixed(6)),
      totalTokens: Number(row.total_tokens) || 0,
      turnCount: Number(row.turn_count) || 0,
      percentage: totalCost > 0
        ? Number(((modelCost / totalCost) * 100).toFixed(2))
        : 0,
    };
  });

  return { status: 200, body: { models, truncated } };
}

/**
 * GET /v1/usage/active-agents
 * Returns distinct agents and their session counts.
 */
export async function handleActiveAgents(
  apiKey: ApiKeyInfo,
  period?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  // N3 fix: Validate period parameter if provided
  if (period && !VALID_PERIODS.has(period)) {
    return { status: 400, body: { error: `Invalid period: ${period}. Must be one of: daily, weekly, monthly` } };
  }

  const pool = getPool();

  const conditions: string[] = ["s.agent_id IS NOT NULL"];
  const params: unknown[] = [];
  let idx = 1;

  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }

  // N3 fix: Use the period parameter to filter sessions by time range.
  // Maps period to a lookback window: daily=1 day, weekly=7 days, monthly=30 days.
  if (period) {
    const intervalMap: Record<string, string> = {
      daily: "1 day",
      weekly: "7 days",
      monthly: "30 days",
    };
    const interval = intervalMap[period] ?? "1 day";
    conditions.push(`s.created_at::TIMESTAMPTZ >= NOW() - INTERVAL '${interval}'`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  // W1 fix: Add LIMIT to prevent unbounded result sets
  const QUERY_LIMIT = 10000;
  const result = await pool.query(`
    SELECT
      s.agent_id,
      COUNT(DISTINCT s.id) AS session_count,
      SUM(s.total_cost_usd) AS total_cost_usd
    FROM sessions s
    ${where}
    GROUP BY s.agent_id
    ORDER BY session_count DESC
    LIMIT ${QUERY_LIMIT}
  `, params);

  const truncated = result.rows.length >= QUERY_LIMIT;

  const agents = result.rows.map((row: Record<string, unknown>) => ({
    agentId: row.agent_id,
    sessionCount: Number(row.session_count) || 0,
    totalCostUsd: Number(Number(row.total_cost_usd || 0).toFixed(6)),
  }));

  const totalAgents = agents.length;
  const totalSessions = agents.reduce((sum, a) => sum + a.sessionCount, 0);

  return { status: 200, body: { agents, totalAgents, totalSessions, truncated } };
}

/**
 * GET /v1/usage/cost-trend
 * Returns cost over time with model breakdown.
 */
export async function handleCostTrend(
  apiKey: ApiKeyInfo,
  period?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Validate period
  const effectivePeriod = period ?? "daily";
  if (!VALID_PERIODS.has(effectivePeriod)) {
    return { status: 400, body: { error: `Invalid period: ${period}. Must be one of: daily, weekly, monthly` } };
  }

  const pool = getPool();
  const truncExpr = dateTruncExpr(effectivePeriod);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // W1 fix: Add LIMIT to prevent unbounded result sets
  const QUERY_LIMIT = 10000;
  // Get cost per period per model
  const result = await pool.query(`
    SELECT
      ${truncExpr} AS period_start,
      t.model,
      SUM(t.cost_usd) AS cost_usd
    FROM turns t
    JOIN sessions s ON t.session_id = s.id
    ${where}
    GROUP BY ${truncExpr}, t.model
    ORDER BY period_start ASC, t.model ASC
    LIMIT ${QUERY_LIMIT}
  `, params);

  const truncated = result.rows.length >= QUERY_LIMIT;

  // Group by period, with model breakdown
  const periodMap = new Map<string, { totalCostUsd: number; models: Array<{ model: string; costUsd: number }> }>();

  for (const row of result.rows) {
    const periodStart = row.period_start instanceof Date
      ? row.period_start.toISOString()
      : String(row.period_start);
    const costUsd = Number(row.cost_usd || 0);

    if (!periodMap.has(periodStart)) {
      periodMap.set(periodStart, { totalCostUsd: 0, models: [] });
    }
    const entry = periodMap.get(periodStart)!;
    entry.totalCostUsd += costUsd;
    entry.models.push({
      model: String(row.model),
      costUsd: Number(costUsd.toFixed(6)),
    });
  }

  const datapoints = Array.from(periodMap.entries()).map(([periodStart, data]) => ({
    periodStart,
    totalCostUsd: Number(data.totalCostUsd.toFixed(6)),
    models: data.models,
  }));

  return { status: 200, body: { datapoints, truncated } };
}
