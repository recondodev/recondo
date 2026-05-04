/**
 * Sprint 6 Deliverable 5: Cost Allocation by Model and Provider
 *
 * GET /v1/usage/cost-allocation — token spend broken down by model and provider
 * Supports period filtering (daily/weekly/monthly) and date range filtering.
 */

import { getPool } from "../db.js";
import type { ApiKeyInfo } from "../context.js";
import { VALID_PERIODS, dateTruncExpr, DATE_FORMAT_RE } from "./utils.js";

/**
 * GET /v1/usage/cost-allocation
 * Returns cost breakdown by model and provider, with optional period grouping and date range.
 */
export async function handleCostAllocation(
  apiKey: ApiKeyInfo,
  period?: string,
  from?: string,
  to?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Validate period if provided
  if (period && !VALID_PERIODS.has(period)) {
    return { status: 400, body: { error: `Invalid period: ${period}. Must be one of: daily, weekly, monthly` } };
  }

  // W6 fix: Validate from/to date parameters against expected format
  if (from && !DATE_FORMAT_RE.test(from)) {
    return { status: 400, body: { error: `Invalid 'from' date format: ${from}. Expected YYYY-MM-DD` } };
  }
  if (to && !DATE_FORMAT_RE.test(to)) {
    return { status: 400, body: { error: `Invalid 'to' date format: ${to}. Expected YYYY-MM-DD` } };
  }

  const pool = getPool();
  const effectivePeriod = period ?? "daily";
  const truncExpr = dateTruncExpr(effectivePeriod);

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // Project scoping
  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }

  // Date range filtering
  if (from) {
    conditions.push(`t.timestamp::TIMESTAMPTZ >= $${idx++}::TIMESTAMPTZ`);
    params.push(from);
  }
  if (to) {
    // Add 1 day to 'to' date so the range is inclusive
    conditions.push(`t.timestamp::TIMESTAMPTZ < ($${idx++}::DATE + INTERVAL '1 day')::TIMESTAMPTZ`);
    params.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // W1 fix: Add LIMIT to prevent unbounded result sets
  const QUERY_LIMIT = 10000;

  // If period filtering is requested, include periodStart grouping
  if (period) {
    const result = await pool.query(`
      SELECT
        t.model,
        COALESCE(t.provider, s.provider) AS provider,
        ${truncExpr} AS period_start,
        SUM(t.cost_usd) AS total_cost_usd,
        SUM(t.input_tokens + t.output_tokens) AS total_tokens,
        COUNT(DISTINCT s.id) AS session_count,
        COUNT(t.id) AS turn_count
      FROM turns t
      JOIN sessions s ON t.session_id = s.id
      ${where}
      GROUP BY t.model, COALESCE(t.provider, s.provider), ${truncExpr}
      ORDER BY period_start ASC, total_cost_usd DESC
      LIMIT ${QUERY_LIMIT}
    `, params);

    const truncated = result.rows.length >= QUERY_LIMIT;

    const allocations = result.rows.map((row: Record<string, unknown>) => ({
      model: row.model,
      provider: row.provider,
      periodStart: row.period_start instanceof Date
        ? row.period_start.toISOString()
        : String(row.period_start),
      totalCostUsd: Number(Number(row.total_cost_usd || 0).toFixed(6)),
      totalTokens: Number(row.total_tokens) || 0,
      sessionCount: Number(row.session_count) || 0,
      turnCount: Number(row.turn_count) || 0,
    }));

    return { status: 200, body: { allocations, truncated } };
  }

  // No period grouping — aggregate across all time
  const result = await pool.query(`
    SELECT
      t.model,
      COALESCE(t.provider, s.provider) AS provider,
      SUM(t.cost_usd) AS total_cost_usd,
      SUM(t.input_tokens + t.output_tokens) AS total_tokens,
      COUNT(DISTINCT s.id) AS session_count,
      COUNT(t.id) AS turn_count
    FROM turns t
    JOIN sessions s ON t.session_id = s.id
    ${where}
    GROUP BY t.model, COALESCE(t.provider, s.provider)
    ORDER BY total_cost_usd DESC
    LIMIT ${QUERY_LIMIT}
  `, params);

  const truncated = result.rows.length >= QUERY_LIMIT;

  const allocations = result.rows.map((row: Record<string, unknown>) => ({
    model: row.model,
    provider: row.provider,
    totalCostUsd: Number(Number(row.total_cost_usd || 0).toFixed(6)),
    totalTokens: Number(row.total_tokens) || 0,
    sessionCount: Number(row.session_count) || 0,
    turnCount: Number(row.turn_count) || 0,
  }));

  return { status: 200, body: { allocations, truncated } };
}
