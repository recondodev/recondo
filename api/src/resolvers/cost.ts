/**
 * Cost intelligence resolvers -- Sprint D4.3.
 *
 * Contains:
 *   Query.usageSummary   -- aggregated usage/cost metrics for a period
 *   Query.spendByProvider -- GROUP BY provider, SUM(cost_usd)
 *   Query.spendByModel   -- GROUP BY model, SUM(cost_usd)
 *   Query.spendByFramework -- GROUP BY framework, SUM(cost_usd)
 *   Query.dailySpend     -- GROUP BY date, SUM(cost_usd)
 *   Query.costProjections -- 3-month linear extrapolation
 *
 * Period handling:
 *   - period: "DAY_1", "DAY_7", "DAY_30", "DAY_90"
 *   - from/to: ISO 8601 DateTime strings for custom ranges
 *   - If both provided, from/to takes precedence
 *   - Default: DAY_30
 *
 * D4.5: Project scoping -- all resolvers now read ctx.apiKey.projectId and
 * add `AND s.project_id = $N` when the API key is scoped to a specific project.
 */

import { getPool } from "../db.js";
import type { GqlContext } from "../context.js";
import type { QueryResolvers } from "../generated/graphql.js";

/**
 * Convert period string to a date range [from, to].
 * If from/to are provided, they take precedence.
 * Default period is DAY_30.
 */
export function resolveDateRange(
  period?: string | null,
  from?: string | null,
  to?: string | null
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
 * D4.5: Build project scoping condition and params.
 * Returns the next param index after adding the condition (if any).
 */
function addProjectScope(
  ctx: GqlContext,
  conditions: string[],
  params: unknown[],
  startIdx: number
): number {
  if (ctx.apiKey.projectId) {
    conditions.push(`s.project_id = $${startIdx}`);
    params.push(ctx.apiKey.projectId);
    return startIdx + 1;
  }
  return startIdx;
}

/**
 * D4.3: usageSummary resolver.
 *
 * Aggregates from turns + sessions for the given period:
 * - totalCostUsd: SUM(cost_usd) from turns
 * - projectedMonthlyCostUsd: linear extrapolation to 30 days
 * - totalTokens: SUM(input_tokens + output_tokens + thinking_tokens)
 * - cacheReadTokens: SUM(cache_read_tokens)
 * - cacheReadPercentage: (cacheReadTokens / totalTokens) * 100
 * - averageCostPerSession: totalCostUsd / session_count
 * - averageCostDelta: comparison vs prior period
 * - cacheHitRate: percentage of turns with cache_read_tokens > 0
 * - cacheSavingsUsd: estimated savings from cache hits
 * - costPerDeveloperPerDay: totalCostUsd / (unique developers * days)
 * - developerCount: COUNT(DISTINCT account_uuid) from sessions
 *
 * D4.5: Project scoping via ctx.apiKey.projectId.
 */
const usageSummaryResolver: NonNullable<QueryResolvers["usageSummary"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const range = resolveDateRange(
    args.period as string | undefined,
    args.from as string | undefined,
    args.to as string | undefined
  );

  // D4.5: Build project scope condition
  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(ctx, scopeConditions, scopeParams, 3);

  const projectClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  // W5: Run main query and prior-period query in parallel with Promise.all
  // Average cost delta: compare to the prior equivalent period
  // W8: Prior period uses strict `<` for the upper bound to prevent boundary overlap
  const priorRange = {
    from: new Date(new Date(range.from).getTime() - range.days * 86_400_000).toISOString(),
    to: range.from,
  };

  // N4: JOIN sessions acts as existence filter -- excludes orphan turns without a parent session.
  const [result, priorResult] = await Promise.all([
    // Main aggregation from turns joined with sessions
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
      [range.from, range.to, ...scopeParams]
    ),
    // W8: Prior period query uses `<` for upper bound to avoid boundary overlap with current period
    pool.query(
      `SELECT COALESCE(SUM(t.cost_usd), 0)::float AS total_cost_usd,
              COUNT(DISTINCT s.id)::int AS session_count
       FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE t.timestamp::timestamptz >= $1::timestamptz AND t.timestamp::timestamptz < $2::timestamptz${projectClause}`,
      [priorRange.from, priorRange.to, ...scopeParams]
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

  // Projected monthly cost: linear extrapolation from current period to 30 days
  const costPerDay = range.days > 0 ? totalCostUsd / range.days : 0;
  const projectedMonthlyCostUsd = costPerDay * 30;

  // Cache read percentage (of total tokens)
  const cacheReadPercentage = totalTokens > 0
    ? Math.min(100, (cacheReadTokens / totalTokens) * 100)
    : 0;

  // Average cost per session
  const averageCostPerSession = sessionCount > 0 ? totalCostUsd / sessionCount : 0;

  const priorCost = (priorResult.rows[0]?.total_cost_usd as number) ?? 0;
  const priorSessionCount = (priorResult.rows[0]?.session_count as number) ?? 0;
  const priorAvgCost = priorSessionCount > 0 ? priorCost / priorSessionCount : 0;

  // Delta: positive means costs went up, negative means down
  const averageCostDelta = averageCostPerSession - priorAvgCost;

  // Cache hit rate: percentage of turns that used cache
  const cacheHitRate = turnCount > 0
    ? Math.min(100, (turnsWithCache / turnCount) * 100)
    : 0;

  // Cache savings: estimate based on cache read tokens (rough: input token cost avoidance)
  // Approximate: cache reads cost ~10% of input tokens, so savings = 90% of what would have been spent
  // Using a simple heuristic: cacheSavingsUsd = (cacheReadTokens / totalTokens) * totalCostUsd * 0.9
  const cacheSavingsUsd = totalTokens > 0
    ? (cacheReadTokens / totalTokens) * totalCostUsd * 0.9
    : 0;

  // Cost per developer per day
  const costPerDeveloperPerDay = (developerCount > 0 && range.days > 0)
    ? totalCostUsd / (developerCount * range.days)
    : 0;

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
};

/**
 * Generic spend-by-category resolver factory.
 * Groups by a given column, sums cost_usd, computes percentages.
 *
 * D4.5: Project scoping via ctx.apiKey.projectId.
 */
/**
 * B1: Allowlist of valid groupBy columns to prevent SQL column injection.
 * Only these column names are permitted in the dynamic GROUP BY clause.
 */
const ALLOWED_GROUP_BY_COLUMNS = new Set(["provider", "model", "framework"]);

async function spendByCategory(
  groupByColumn: string,
  columnSource: "turns" | "sessions",
  ctx: GqlContext,
  period?: string | null,
  from?: string | null,
  to?: string | null
): Promise<Array<{ name: string; costUsd: number; percentage: number; count: number }>> {
  // B1: Validate groupByColumn against allowlist before using in SQL
  if (!ALLOWED_GROUP_BY_COLUMNS.has(groupByColumn)) {
    throw new Error(`Invalid groupBy column: ${groupByColumn}`);
  }

  const pool = getPool();
  const range = resolveDateRange(period, from, to);

  let groupCol: string;
  // N4: JOIN sessions acts as existence filter -- excludes orphan turns without a parent session.
  const joinClause = "JOIN sessions s ON t.session_id = s.id";

  if (columnSource === "sessions") {
    groupCol = `s.${groupByColumn}`;
  } else {
    groupCol = `t.${groupByColumn}`;
  }

  // D4.5: Build project scope condition
  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(ctx, scopeConditions, scopeParams, 3);
  const projectClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

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
     ORDER BY cost_usd DESC
     LIMIT 100`,
    [range.from, range.to, ...scopeParams]
  );

  const rows = result.rows as Array<{ name: string; cost_usd: number; count: number }>;

  // Compute total for percentage calculation
  const totalCost = rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  return rows.map((r) => ({
    name: r.name,
    costUsd: r.cost_usd ?? 0,
    percentage: totalCost > 0 ? ((r.cost_usd ?? 0) / totalCost) * 100 : 0,
    count: r.count ?? 0,
  }));
}

const spendByProviderResolver: NonNullable<QueryResolvers["spendByProvider"]> = async (
  _parent,
  args,
  ctx
) => {
  return spendByCategory(
    "provider",
    "turns",
    ctx,
    args.period as string | undefined,
    args.from as string | undefined,
    args.to as string | undefined
  );
};

const spendByModelResolver: NonNullable<QueryResolvers["spendByModel"]> = async (
  _parent,
  args,
  ctx
) => {
  return spendByCategory(
    "model",
    "turns",
    ctx,
    args.period as string | undefined,
    args.from as string | undefined,
    args.to as string | undefined
  );
};

const spendByFrameworkResolver: NonNullable<QueryResolvers["spendByFramework"]> = async (
  _parent,
  args,
  ctx
) => {
  return spendByCategory(
    "framework",
    "sessions",
    ctx,
    args.period as string | undefined,
    args.from as string | undefined,
    args.to as string | undefined
  );
};

/**
 * D4.3: dailySpend resolver.
 *
 * Returns one SpendByCategory entry per day with data.
 * Name is a date string (YYYY-MM-DD), costUsd is the day's total.
 * Default: last 14 days, capped at the explicit days parameter.
 *
 * D4.5: Project scoping via ctx.apiKey.projectId.
 */
const dailySpendResolver: NonNullable<QueryResolvers["dailySpend"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();

  let days = args.days ?? 14;
  if (days < 1) days = 1;
  if (days > 365) days = 365;

  const fromDate = new Date(Date.now() - days * 86_400_000).toISOString();
  const toDate = new Date().toISOString();

  // D4.5: Build project scope condition
  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(ctx, scopeConditions, scopeParams, 3);
  const projectClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

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
    [fromDate, toDate, ...scopeParams]
  );

  const rows = result.rows as Array<{ day: string; cost_usd: number; count: number }>;
  const totalCost = rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);

  // Only return entries up to the days limit
  const limited = rows.slice(0, days);

  return limited.map((r) => ({
    name: r.day,
    costUsd: r.cost_usd ?? 0,
    percentage: totalCost > 0 ? ((r.cost_usd ?? 0) / totalCost) * 100 : 0,
    count: r.count ?? 0,
  }));
};

/**
 * D4.3: costProjections resolver.
 *
 * Returns exactly 3 monthly projections based on linear extrapolation
 * from the last 30 days of data.
 *
 * Each projection contains:
 * - month: "YYYY-MM" format for the projected month
 * - projectedSessions: estimated session count
 * - projectedTokens: estimated token usage
 * - projectedCostUsd: estimated cost
 * - deltaVsCurrent: change vs current month's run rate
 * - assumptions: description of the projection methodology
 *
 * D4.5: Project scoping via ctx.apiKey.projectId.
 */
const costProjectionsResolver: NonNullable<QueryResolvers["costProjections"]> = async (
  _parent,
  _args,
  ctx
) => {
  const pool = getPool();
  const now = new Date();

  // Get the last 30 days of data for the baseline
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  // W6: Add upper time bound to prevent including future-dated data
  const nowIso = now.toISOString();

  // D4.5: Build project scope condition
  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(ctx, scopeConditions, scopeParams, 3);
  const projectClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  // N4: JOIN sessions acts as existence filter -- excludes orphan turns without a parent session.
  const result = await pool.query(
    `SELECT
       COALESCE(SUM(t.cost_usd), 0)::float AS total_cost,
       COALESCE(SUM(t.input_tokens + t.output_tokens + t.thinking_tokens), 0)::float AS total_tokens,
       COUNT(DISTINCT s.id)::int AS session_count,
       COUNT(t.id)::int AS turn_count
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE t.timestamp::timestamptz >= $1::timestamptz AND t.timestamp::timestamptz <= $2::timestamptz${projectClause}`,
    [thirtyDaysAgo, nowIso, ...scopeParams]
  );

  const row = result.rows[0];
  const totalCost30d = (row.total_cost as number) ?? 0;
  const totalTokens30d = (row.total_tokens as number) ?? 0;
  const sessionCount30d = (row.session_count as number) ?? 0;

  // Monthly run rate = 30-day total (linear extrapolation to 30 days is 1:1)
  const monthlyCost = totalCost30d;
  const monthlyTokens = totalTokens30d;
  const monthlySessions = sessionCount30d;

  // Generate next 3 months
  const projections = [];
  for (let i = 1; i <= 3; i++) {
    const projectionDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const monthStr = `${projectionDate.getFullYear()}-${String(projectionDate.getMonth() + 1).padStart(2, "0")}`;

    // Simple linear extrapolation: same rate as last 30 days
    // Apply a small growth factor for future months (5% per month)
    const growthFactor = Math.pow(1.05, i);
    const projectedCost = monthlyCost * growthFactor;
    const projectedTokens = monthlyTokens * growthFactor;
    const projectedSessions = Math.round(monthlySessions * growthFactor);

    // Delta vs current (month 0 run rate)
    const deltaVsCurrent = monthlyCost > 0
      ? ((projectedCost - monthlyCost) / monthlyCost) * 100
      : 0;

    projections.push({
      month: monthStr,
      projectedSessions,
      projectedTokens: Math.round(projectedTokens),
      projectedCostUsd: Math.round(projectedCost * 100) / 100,
      deltaVsCurrent: Math.round(deltaVsCurrent * 100) / 100,
      // W7: Honest labeling -- the 5% growth rate is an assumption, not derived from historical data
      assumptions: `Assumed ${Math.round((growthFactor - 1) * 100)}% monthly growth rate applied to 30-day baseline average.`,
    });
  }

  return projections;
};

export const costResolvers = {
  Query: {
    usageSummary: usageSummaryResolver,
    spendByProvider: spendByProviderResolver,
    spendByModel: spendByModelResolver,
    spendByFramework: spendByFrameworkResolver,
    dailySpend: dailySpendResolver,
    costProjections: costProjectionsResolver,
  },
};
