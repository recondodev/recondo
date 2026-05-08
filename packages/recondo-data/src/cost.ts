/**
 * Cost intelligence primitives.
 *
 * Hoisted from `api/src/resolvers/cost.ts` as part of C6. SQL bodies
 * preserved byte-for-byte; transport-shape concerns (GraphQLError
 * mapping) stay in api/.
 *
 * Public surface:
 *   - resolveDateRange(period, from, to) -> { from, to, days }
 *   - getUsageSummary(apiKey, args, options)        -> UsageSummary
 *   - listSpendByProvider(apiKey, args, options)    -> ListEnvelope<SpendBucket>
 *   - listSpendByModel(apiKey, args, options)       -> ListEnvelope<SpendBucket>
 *   - listSpendByFramework(apiKey, args, options)   -> ListEnvelope<SpendBucket>
 *   - listDailySpend(apiKey, args, options)         -> ListEnvelope<SpendBucket>
 *   - getCostProjections(apiKey, period, options)   -> CostProjection[]
 *
 * Contracts:
 *   - options.signal aborted BEFORE the SQL is issued throws AbortError.
 *   - Period handling: "DAY_1", "DAY_7", "DAY_30", "DAY_90". from/to,
 *     when both provided, take precedence over period. Default DAY_30.
 */

import { getPool } from "./pool.js";
import { uniformListEnvelope } from "./envelope.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, QueryOptions } from "./types.js";

export interface CostQueryArgs {
  period?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface SpendBucket {
  name: string;
  costUsd: number;
  percentage: number;
  count: number;
}

export interface UsageSummary {
  totalCostUsd: number;
  projectedMonthlyCostUsd: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheReadPercentage: number;
  averageCostPerSession: number;
  averageCostDelta: number;
  cacheHitRate: number;
  cacheSavingsUsd: number;
  costPerDeveloperPerDay: number;
  developerCount: number;
}

export interface CostProjection {
  month: string;
  projectedSessions: number;
  projectedTokens: number;
  projectedCostUsd: number;
  deltaVsCurrent: number;
  assumptions: string;
}

/**
 * Convert period string to a date range [from, to].
 * If from/to are provided, they take precedence.
 * Default period is DAY_30.
 */
export function resolveDateRange(
  period?: string | null,
  from?: string | null,
  to?: string | null,
): { from: string; to: string; days: number } {
  const now = new Date();
  const toDate = to ? new Date(to) : now;

  if (from && to) {
    const diffMs = toDate.getTime() - new Date(from).getTime();
    const days = Math.max(1, Math.ceil(diffMs / 86_400_000));
    return { from, to: toDate.toISOString(), days };
  }

  if (from) {
    const diffMs = now.getTime() - new Date(from).getTime();
    const days = Math.max(1, Math.ceil(diffMs / 86_400_000));
    return { from, to: now.toISOString(), days };
  }

  // Parse period
  let days = 30; // default
  if (period) {
    const match = period.match(/^DAY_(\d+)$/i);
    if (match) {
      days = parseInt(match[1], 10);
    }
  }

  const fromDate = new Date(now.getTime() - days * 86_400_000);
  return { from: fromDate.toISOString(), to: now.toISOString(), days };
}

/**
 * Build project scoping condition and params.
 * Returns the next param index after adding the condition (if any).
 */
function addProjectScope(
  apiKey: ApiKeyInfo,
  conditions: string[],
  params: unknown[],
  startIdx: number,
): number {
  if (apiKey.projectId) {
    conditions.push(`s.project_id = $${startIdx}`);
    params.push(apiKey.projectId);
    return startIdx + 1;
  }
  return startIdx;
}

export async function getUsageSummary(
  apiKey: ApiKeyInfo,
  args: CostQueryArgs = {},
  options: QueryOptions = {},
): Promise<UsageSummary> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const range = resolveDateRange(args.period, args.from, args.to);

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(apiKey, scopeConditions, scopeParams, 3);

  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const priorRange = {
    from: new Date(new Date(range.from).getTime() - range.days * 86_400_000).toISOString(),
    to: range.from,
  };

  const [result, priorResult] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(SUM(t.cost_usd), 0)::float AS total_cost_usd,
         COALESCE(SUM(t.input_tokens + t.output_tokens + t.thinking_tokens), 0)::float AS total_tokens,
         COALESCE(SUM(t.cache_read_tokens), 0)::float AS cache_read_tokens,
         COUNT(DISTINCT s.id)::int AS session_count,
         COUNT(DISTINCT s.account_uuid) FILTER (WHERE s.account_uuid IS NOT NULL)::int AS developer_count,
         COUNT(t.id)::int AS turn_count,
         COUNT(t.id) FILTER (WHERE t.cache_read_tokens > 0)::int AS turns_with_cache
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE t.timestamp::timestamptz >= $1::timestamptz AND t.timestamp::timestamptz <= $2::timestamptz${projectClause}`,
      [range.from, range.to, ...scopeParams],
    ),
    pool.query(
      `SELECT COALESCE(SUM(t.cost_usd), 0)::float AS total_cost_usd,
              COUNT(DISTINCT s.id)::int AS session_count
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE t.timestamp::timestamptz >= $1::timestamptz AND t.timestamp::timestamptz < $2::timestamptz${projectClause}`,
      [priorRange.from, priorRange.to, ...scopeParams],
    ),
  ]);

  const row = result.rows[0];
  const totalCostUsd = (row.total_cost_usd as number) ?? 0;
  const totalTokens = (row.total_tokens as number) ?? 0;
  const cacheReadTokens = (row.cache_read_tokens as number) ?? 0;
  const sessionCount = (row.session_count as number) ?? 0;
  const developerCount = (row.developer_count as number) ?? 0;
  const turnCount = (row.turn_count as number) ?? 0;
  const turnsWithCache = (row.turns_with_cache as number) ?? 0;

  const costPerDay = range.days > 0 ? totalCostUsd / range.days : 0;
  const projectedMonthlyCostUsd = costPerDay * 30;

  const cacheReadPercentage =
    totalTokens > 0 ? Math.min(100, (cacheReadTokens / totalTokens) * 100) : 0;

  const averageCostPerSession = sessionCount > 0 ? totalCostUsd / sessionCount : 0;

  const priorCost = (priorResult.rows[0]?.total_cost_usd as number) ?? 0;
  const priorSessionCount = (priorResult.rows[0]?.session_count as number) ?? 0;
  const priorAvgCost = priorSessionCount > 0 ? priorCost / priorSessionCount : 0;

  const averageCostDelta = averageCostPerSession - priorAvgCost;

  const cacheHitRate =
    turnCount > 0 ? Math.min(100, (turnsWithCache / turnCount) * 100) : 0;

  const cacheSavingsUsd =
    totalTokens > 0 ? (cacheReadTokens / totalTokens) * totalCostUsd * 0.9 : 0;

  const costPerDeveloperPerDay =
    developerCount > 0 && range.days > 0 ? totalCostUsd / (developerCount * range.days) : 0;

  return {
    totalCostUsd,
    projectedMonthlyCostUsd,
    totalTokens,
    cacheReadTokens,
    cacheReadPercentage,
    averageCostPerSession,
    averageCostDelta,
    cacheHitRate,
    cacheSavingsUsd,
    costPerDeveloperPerDay,
    developerCount,
  };
}

const ALLOWED_GROUP_BY_COLUMNS = new Set(["provider", "model", "framework"]);

async function spendByCategory(
  apiKey: ApiKeyInfo,
  groupByColumn: string,
  columnSource: "turns" | "sessions",
  args: CostQueryArgs,
  options: QueryOptions,
): Promise<SpendBucket[]> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  if (!ALLOWED_GROUP_BY_COLUMNS.has(groupByColumn)) {
    throw new Error(`Invalid groupBy column: ${groupByColumn}`);
  }

  const pool = getPool();
  const range = resolveDateRange(args.period, args.from, args.to);

  const groupCol =
    columnSource === "sessions" ? `s.${groupByColumn}` : `t.${groupByColumn}`;
  const joinClause = "JOIN sessions s ON t.session_id = s.id";

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(apiKey, scopeConditions, scopeParams, 3);
  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT
       COALESCE(${groupCol}, 'unknown') AS name,
       COALESCE(SUM(t.cost_usd), 0)::float AS cost_usd,
       COUNT(t.id)::int AS count
     FROM turns t
     ${joinClause}
     WHERE t.timestamp::timestamptz >= $1::timestamptz AND t.timestamp::timestamptz <= $2::timestamptz
       AND ${groupCol} IS NOT NULL${projectClause}
     GROUP BY ${groupCol}
     ORDER BY cost_usd DESC`,
    [range.from, range.to, ...scopeParams],
  );

  const rows = result.rows as Array<{ name: string; cost_usd: number; count: number }>;
  const totalCost = rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  return rows.map((r) => ({
    name: r.name,
    costUsd: r.cost_usd ?? 0,
    percentage: totalCost > 0 ? ((r.cost_usd ?? 0) / totalCost) * 100 : 0,
    count: r.count ?? 0,
  }));
}

function normalizeListOptions(options: ListOptions): { limit: number; offset: number } {
  let limit = options.limit ?? 50;
  let offset = options.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;
  if (offset < 0) offset = 0;
  return { limit, offset };
}

function paginateSpendBuckets<T>(
  items: T[],
  options: ListOptions,
): ListEnvelope<T> & { total: number; limit: number; offset: number } {
  const { limit, offset } = normalizeListOptions(options);
  const page = items.slice(offset, offset + limit);
  const truncated = offset + page.length < items.length;
  const nextOffset = truncated ? offset + page.length : null;
  return {
    ...uniformListEnvelope(page, { nextOffset, truncated }),
    total: items.length,
    limit,
    offset,
  };
}

export async function listSpendByProvider(
  apiKey: ApiKeyInfo,
  args: CostQueryArgs = {},
  options: ListOptions = {},
): Promise<ListEnvelope<SpendBucket> & { total: number; limit: number; offset: number }> {
  const items = await spendByCategory(apiKey, "provider", "turns", args, options);
  return paginateSpendBuckets(items, options);
}

export async function listSpendByModel(
  apiKey: ApiKeyInfo,
  args: CostQueryArgs = {},
  options: ListOptions = {},
): Promise<ListEnvelope<SpendBucket> & { total: number; limit: number; offset: number }> {
  const items = await spendByCategory(apiKey, "model", "turns", args, options);
  return paginateSpendBuckets(items, options);
}

export async function listSpendByFramework(
  apiKey: ApiKeyInfo,
  args: CostQueryArgs = {},
  options: ListOptions = {},
): Promise<ListEnvelope<SpendBucket> & { total: number; limit: number; offset: number }> {
  const items = await spendByCategory(apiKey, "framework", "sessions", args, options);
  return paginateSpendBuckets(items, options);
}

export async function listDailySpend(
  apiKey: ApiKeyInfo,
  args: CostQueryArgs & { days?: number | null } = {},
  options: ListOptions = {},
): Promise<ListEnvelope<SpendBucket> & { total: number; limit: number; offset: number }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  let days = args.days ?? 14;
  if (days < 1) days = 1;
  if (days > 365) days = 365;

  const fromDate = new Date(Date.now() - days * 86_400_000).toISOString();
  const toDate = new Date().toISOString();

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(apiKey, scopeConditions, scopeParams, 3);
  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT
       TO_CHAR(t.timestamp::timestamptz, 'YYYY-MM-DD') AS day,
       COALESCE(SUM(t.cost_usd), 0)::float AS cost_usd,
       COUNT(t.id)::int AS count
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE t.timestamp::timestamptz >= $1::timestamptz AND t.timestamp::timestamptz <= $2::timestamptz${projectClause}
     GROUP BY day
     ORDER BY day DESC`,
    [fromDate, toDate, ...scopeParams],
  );

  const rows = result.rows as Array<{ day: string; cost_usd: number; count: number }>;
  const totalCost = rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  const items = rows.slice(0, days).map((r) => ({
    name: r.day,
    costUsd: r.cost_usd ?? 0,
    percentage: totalCost > 0 ? ((r.cost_usd ?? 0) / totalCost) * 100 : 0,
    count: r.count ?? 0,
  }));
  return paginateSpendBuckets(items, options);
}

function projectionWindowDays(period?: string | null): number {
  if (!period) return 30;
  const match = period.match(/^DAY_(\d+)$/i);
  if (!match) return 30;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

export async function getCostProjections(
  apiKey: ApiKeyInfo,
  period?: string | null,
  options: QueryOptions = {},
): Promise<CostProjection[]> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const now = new Date();
  const windowDays = projectionWindowDays(period);

  const baselineStart = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const nowIso = now.toISOString();

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(apiKey, scopeConditions, scopeParams, 3);
  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const result = await pool.query(
    `SELECT
       COALESCE(SUM(t.cost_usd), 0)::float AS total_cost,
       COALESCE(SUM(t.input_tokens + t.output_tokens + t.thinking_tokens), 0)::float AS total_tokens,
       COUNT(DISTINCT s.id)::int AS session_count,
       COUNT(t.id)::int AS turn_count
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE t.timestamp::timestamptz >= $1::timestamptz AND t.timestamp::timestamptz <= $2::timestamptz${projectClause}`,
    [baselineStart, nowIso, ...scopeParams],
  );

  const row = result.rows[0];
  const totalCost = (row.total_cost as number) ?? 0;
  const totalTokens = (row.total_tokens as number) ?? 0;
  const sessionCount = (row.session_count as number) ?? 0;
  const scaleToMonthly = 30 / windowDays;

  const monthlyCost = totalCost * scaleToMonthly;
  const monthlyTokens = totalTokens * scaleToMonthly;
  const monthlySessions = sessionCount * scaleToMonthly;

  const projections: CostProjection[] = [];
  for (let i = 1; i <= 3; i++) {
    const projectionDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const monthStr = `${projectionDate.getFullYear()}-${String(projectionDate.getMonth() + 1).padStart(2, "0")}`;

    const growthFactor = Math.pow(1.05, i);
    const projectedCost = monthlyCost * growthFactor;
    const projectedTokens = monthlyTokens * growthFactor;
    const projectedSessions = Math.round(monthlySessions * growthFactor);

    const deltaVsCurrent =
      monthlyCost > 0 ? ((projectedCost - monthlyCost) / monthlyCost) * 100 : 0;

    projections.push({
      month: monthStr,
      projectedSessions,
      projectedTokens: Math.round(projectedTokens),
      projectedCostUsd: Math.round(projectedCost * 100) / 100,
      deltaVsCurrent: Math.round(deltaVsCurrent * 100) / 100,
      assumptions: `Assumed ${Math.round((growthFactor - 1) * 100)}% monthly growth rate applied to ${windowDays}-day baseline average scaled to a 30-day month.`,
    });
  }

  return projections;
}
