/**
 * Agent analytics resolvers -- Sprint D5.1.
 *
 * Contains:
 *   Query.agentSummary     -- aggregate agent metrics for a period
 *   Query.topDevelopers    -- developers ranked by cost
 *   Query.topRepositories  -- repositories ranked by session count
 *
 * D5: Project scoping -- all resolvers read ctx.apiKey.projectId.
 */

import { getPool } from "../db.js";
import type { GqlContext } from "../context.js";
import type { QueryResolvers } from "../generated/graphql.js";
import { resolveDateRange } from "./cost.js";
import { formatTimestamp } from "./mappers.js";

/**
 * Build project scoping condition and params.
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
 * D5.1: agentSummary resolver.
 *
 * Returns:
 *   activeAgents            -- COUNT(DISTINCT s.id) sessions with turns in period
 *   frameworkCount          -- COUNT(DISTINCT s.framework)
 *   totalSessions           -- COUNT(DISTINCT s.id) sessions started in period
 *   sessionsDelta           -- period-over-period percentage change
 *   averageTurnsPerSession   -- AVG(s.total_turns)
 *   medianTurnsPerSession    -- percentile_cont(0.5) on s.total_turns
 *   uniqueDevelopers         -- COUNT(DISTINCT s.account_uuid)
 */
const agentSummaryResolver: NonNullable<QueryResolvers["agentSummary"]> = async (
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

  // Build project scope
  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(ctx, scopeConditions, scopeParams, 3);
  const projectClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";
  // For subqueries that use a different table alias (s2), remap s.project_id -> s2.project_id
  const s2ProjectClause = projectClause.replace(/\bs\.project_id\b/g, "s2.project_id");

  // Prior period for sessionsDelta
  const priorRange = {
    from: new Date(new Date(range.from).getTime() - range.days * 86_400_000).toISOString(),
    to: range.from,
  };

  // W4: activeAgents counts sessions with at least one turn in the period (JOIN turns),
  // while totalSessions counts all sessions started in the period (no JOIN required).
  const [result, priorResult] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(DISTINCT s2.id)::int
          FROM sessions s2
          JOIN turns t ON t.session_id = s2.id
          WHERE s2.started_at::timestamptz >= $1::timestamptz AND s2.started_at::timestamptz <= $2::timestamptz${s2ProjectClause}
         ) AS active_agents,
         COUNT(DISTINCT s.framework) FILTER (WHERE s.framework IS NOT NULL)::int AS framework_count,
         COUNT(DISTINCT s.id)::int AS total_sessions,
         COUNT(DISTINCT s.account_uuid) FILTER (WHERE s.account_uuid IS NOT NULL)::int AS unique_developers,
         COALESCE(AVG(s.total_turns), 0)::float AS avg_turns,
         COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY s.total_turns), 0)::float AS median_turns
       FROM sessions s
       WHERE s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz <= $2::timestamptz${projectClause}`,
      [range.from, range.to, ...scopeParams]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT s.id)::int AS total_sessions
       FROM sessions s
       WHERE s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz < $2::timestamptz${projectClause}`,
      [priorRange.from, priorRange.to, ...scopeParams]
    ),
  ]);

  const row = result.rows[0];
  const currentSessions = (row.total_sessions as number) ?? 0;
  const priorSessions = (priorResult.rows[0]?.total_sessions as number) ?? 0;

  // sessionsDelta: percentage change, 0 if prior period had 0 sessions
  const sessionsDelta = priorSessions > 0
    ? ((currentSessions - priorSessions) / priorSessions) * 100
    : (currentSessions > 0 ? 100 : 0);

  return {
    activeAgents: (row.active_agents as number) ?? 0,
    frameworkCount: (row.framework_count as number) ?? 0,
    totalSessions: currentSessions,
    sessionsDelta: Math.round(sessionsDelta * 100) / 100,
    averageTurnsPerSession: (row.avg_turns as number) ?? 0,
    medianTurnsPerSession: (row.median_turns as number) ?? 0,
    uniqueDevelopers: (row.unique_developers as number) ?? 0,
  };
};

/**
 * D5.1: agentFrameworkDistribution resolver.
 *
 * Groups sessions by framework for the selected period so the dashboard can
 * render a real framework distribution chart even when sessions do not have
 * account_uuid values (for example Gemini CLI captures).
 */
const agentFrameworkDistributionResolver: NonNullable<QueryResolvers["agentFrameworkDistribution"]> = async (
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

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  addProjectScope(ctx, scopeConditions, scopeParams, 3);
  const projectClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const result = await pool.query(
    `WITH framework_usage AS (
       SELECT
         LOWER(NULLIF(s.framework, '')) AS name,
         COUNT(DISTINCT s.id)::int AS count,
         COALESCE(SUM(s.total_cost_usd), 0)::float AS cost_usd
       FROM sessions s
       WHERE NULLIF(s.framework, '') IS NOT NULL
         AND s.started_at::timestamptz >= $1::timestamptz
         AND s.started_at::timestamptz <= $2::timestamptz${projectClause}
       GROUP BY LOWER(NULLIF(s.framework, ''))
     ),
     totals AS (
       SELECT COALESCE(SUM(count), 0)::float AS total_count
       FROM framework_usage
     )
     SELECT
       framework_usage.name,
       framework_usage.cost_usd,
       framework_usage.count,
       CASE
         WHEN totals.total_count > 0
           THEN ROUND(
             (framework_usage.count::numeric * 100.0) / totals.total_count::numeric,
             2
           )::float
         ELSE 0::float
       END AS percentage
     FROM framework_usage
     CROSS JOIN totals
     ORDER BY framework_usage.count DESC, framework_usage.name ASC`,
    [range.from, range.to, ...scopeParams]
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    name: (row.name as string) ?? "unknown",
    costUsd: (row.cost_usd as number) ?? 0,
    percentage: (row.percentage as number) ?? 0,
    count: (row.count as number) ?? 0,
  }));
};

/**
 * D5.1: topDevelopers resolver.
 *
 * Returns a paginated DeveloperConnection with developers ranked by totalCostUsd DESC.
 * Groups by account_uuid, aggregates session count, tokens, cost, and identifies favorite model.
 */
const topDevelopersResolver: NonNullable<QueryResolvers["topDevelopers"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const range = resolveDateRange(args.period as string | undefined, undefined, undefined);

  // Pagination
  let limit = args.limit ?? 20;
  let offset = args.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  if (offset < 0) offset = 0;

  // Build project scope
  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  let idx = addProjectScope(ctx, scopeConditions, scopeParams, 3);
  const projectClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT
         s.account_uuid,
         COUNT(DISTINCT s.id)::int AS session_count,
         COALESCE(SUM(t.input_tokens + t.output_tokens + t.thinking_tokens), 0)::float AS total_tokens,
         COALESCE(SUM(t.cost_usd), 0)::float AS total_cost_usd,
         MODE() WITHIN GROUP (ORDER BY t.model) AS favorite_model,
         MAX(s.last_active_at) AS last_active
       FROM sessions s
       JOIN turns t ON t.session_id = s.id
       WHERE s.account_uuid IS NOT NULL
         AND s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz <= $2::timestamptz${projectClause}
       GROUP BY s.account_uuid
       ORDER BY total_cost_usd DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [range.from, range.to, ...scopeParams, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT s.account_uuid)::int AS total
       FROM sessions s
       WHERE s.account_uuid IS NOT NULL
         AND s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz <= $2::timestamptz${projectClause}`,
      [range.from, range.to, ...scopeParams]
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;

  const items = result.rows.map((row: Record<string, unknown>) => ({
    accountUuid: row.account_uuid as string,
    sessionCount: (row.session_count as number) ?? 0,
    totalTokens: (row.total_tokens as number) ?? 0,
    totalCostUsd: (row.total_cost_usd as number) ?? 0,
    favoriteModel: (row.favorite_model as string) ?? null,
    lastActive: formatTimestamp(row.last_active) ?? null,
  }));

  return {
    items,
    total,
    limit,
    offset,
  };
};

/**
 * D5.1: topRepositories resolver.
 *
 * Returns a paginated RepositoryConnection with repositories ranked by sessionCount DESC.
 * Groups by git_repo, counts distinct branches, aggregates cost, identifies primary framework.
 */
const topRepositoriesResolver: NonNullable<QueryResolvers["topRepositories"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const range = resolveDateRange(args.period as string | undefined, undefined, undefined);

  // Pagination
  let limit = args.limit ?? 20;
  let offset = args.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  if (offset < 0) offset = 0;

  // Build project scope
  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  let idx = addProjectScope(ctx, scopeConditions, scopeParams, 3);
  const projectClause = scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  // W5: Use SUM(t.cost_usd) from turns for consistency with topDevelopers (more accurate).
  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT
         s.git_repo AS repository,
         COUNT(DISTINCT s.id)::int AS session_count,
         COUNT(DISTINCT s.git_branch) FILTER (WHERE s.git_branch IS NOT NULL)::int AS branch_count,
         COALESCE(SUM(t.cost_usd), 0)::float AS total_cost_usd,
         MODE() WITHIN GROUP (ORDER BY s.framework) AS primary_framework
       FROM sessions s
       JOIN turns t ON t.session_id = s.id
       WHERE s.git_repo IS NOT NULL
         AND s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz <= $2::timestamptz${projectClause}
       GROUP BY s.git_repo
       ORDER BY session_count DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [range.from, range.to, ...scopeParams, limit, offset]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT s.git_repo)::int AS total
       FROM sessions s
       WHERE s.git_repo IS NOT NULL
         AND s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz <= $2::timestamptz${projectClause}`,
      [range.from, range.to, ...scopeParams]
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;

  const items = result.rows.map((row: Record<string, unknown>) => ({
    repository: row.repository as string,
    sessionCount: (row.session_count as number) ?? 0,
    branchCount: (row.branch_count as number) ?? 0,
    totalCostUsd: (row.total_cost_usd as number) ?? 0,
    primaryFramework: (row.primary_framework as string) ?? null,
  }));

  return {
    items,
    total,
    limit,
    offset,
  };
};

export const agentResolvers = {
  Query: {
    agentSummary: agentSummaryResolver,
    agentFrameworkDistribution: agentFrameworkDistributionResolver,
    topDevelopers: topDevelopersResolver,
    topRepositories: topRepositoriesResolver,
  },
};
