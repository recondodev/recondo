/**
 * Agent analytics primitives.
 *
 * Hoisted from `api/src/resolvers/agents.ts` as part of C7. SQL bodies
 * preserved byte-for-byte; transport-shape concerns (GraphQL bare-list
 * vs. envelope, GraphQLError mapping) stay in api/.
 *
 * Public surface:
 *   - getAgentSummary(apiKey, args, options)                  -> AgentSummaryRow
 *   - listAgentFrameworkDistribution(apiKey, args, options)   -> ListEnvelope<AgentFrameworkUsage>
 *   - listTopDevelopers(apiKey, args, options)                -> ListEnvelope<DeveloperRow> + total/limit/offset
 *   - listTopRepositories(apiKey, args, options)              -> ListEnvelope<RepositoryRow> + total/limit/offset
 *   - listAgentActivity(apiKey, args, options)                -> ListEnvelope<AgentActivityRow>
 *
 * Design notes for `listAgentActivity`: there is NO dedicated
 * `agent_activity` table in the schema. The closest concept the
 * dashboard surfaces is "recent framework activity" — for each agent
 * framework that has run sessions in the period, return session count,
 * cost, and the most-recent activity timestamp. SQL groups sessions by
 * framework, ordered by last_active DESC. Project-scoped via
 * apiKey.projectId. If a real `agent_activity` events table is added
 * later, this function's body changes but the return shape stays.
 */

import { getPool } from "./pool.js";
import { uniformListEnvelope } from "./envelope.js";
import { formatTimestamp } from "./mappers.js";
import { resolveDateRange } from "./cost.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, QueryOptions } from "./types.js";

export interface AgentQueryArgs {
  period?: string | null;
  from?: string | null;
  to?: string | null;
}

export interface AgentSummaryRow {
  activeAgents: number;
  frameworkCount: number;
  totalSessions: number;
  sessionsDelta: number;
  averageTurnsPerSession: number;
  medianTurnsPerSession: number;
  uniqueDevelopers: number;
}

export interface AgentFrameworkUsage {
  name: string;
  costUsd: number;
  percentage: number;
  count: number;
}

export interface DeveloperRow {
  accountUuid: string;
  sessionCount: number;
  totalTokens: number;
  totalCostUsd: number;
  favoriteModel: string | null;
  lastActive: string | null;
}

export interface RepositoryRow {
  repository: string;
  sessionCount: number;
  branchCount: number;
  totalCostUsd: number;
  primaryFramework: string | null;
}

export interface AgentActivityRow {
  framework: string;
  sessionCount: number;
  totalCostUsd: number;
  lastActive: string | null;
}

export async function getAgentSummary(
  apiKey: ApiKeyInfo,
  args: AgentQueryArgs = {},
  options: QueryOptions = {},
): Promise<AgentSummaryRow> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const range = resolveDateRange(
    args.period ?? undefined,
    args.from ?? undefined,
    args.to ?? undefined,
  );

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  if (apiKey.projectId) {
    scopeConditions.push(`s.project_id = $3`);
    scopeParams.push(apiKey.projectId);
  }
  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";
  const s2ProjectClause = projectClause.replace(/\bs\.project_id\b/g, "s2.project_id");

  const priorRange = {
    from: new Date(new Date(range.from).getTime() - range.days * 86_400_000).toISOString(),
    to: range.from,
  };

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
      [range.from, range.to, ...scopeParams],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT s.id)::int AS total_sessions
       FROM sessions s
       WHERE s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz < $2::timestamptz${projectClause}`,
      [priorRange.from, priorRange.to, ...scopeParams],
    ),
  ]);

  const row = result.rows[0] ?? {};
  const currentSessions = (row.total_sessions as number) ?? 0;
  const priorSessions = (priorResult.rows[0]?.total_sessions as number) ?? 0;

  const sessionsDelta =
    priorSessions > 0
      ? ((currentSessions - priorSessions) / priorSessions) * 100
      : currentSessions > 0
        ? 100
        : 0;

  return {
    activeAgents: (row.active_agents as number) ?? 0,
    frameworkCount: (row.framework_count as number) ?? 0,
    totalSessions: currentSessions,
    sessionsDelta: Math.round(sessionsDelta * 100) / 100,
    averageTurnsPerSession: (row.avg_turns as number) ?? 0,
    medianTurnsPerSession: (row.median_turns as number) ?? 0,
    uniqueDevelopers: (row.unique_developers as number) ?? 0,
  };
}

export async function listAgentFrameworkDistribution(
  apiKey: ApiKeyInfo,
  args: AgentQueryArgs = {},
  options: QueryOptions = {},
): Promise<ListEnvelope<AgentFrameworkUsage>> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const range = resolveDateRange(
    args.period ?? undefined,
    args.from ?? undefined,
    args.to ?? undefined,
  );

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  if (apiKey.projectId) {
    scopeConditions.push(`s.project_id = $3`);
    scopeParams.push(apiKey.projectId);
  }
  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

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
    [range.from, range.to, ...scopeParams],
  );

  const items: AgentFrameworkUsage[] = result.rows.map((row: Record<string, unknown>) => ({
    name: (row.name as string) ?? "unknown",
    costUsd: (row.cost_usd as number) ?? 0,
    percentage: (row.percentage as number) ?? 0,
    count: (row.count as number) ?? 0,
  }));

  return uniformListEnvelope(items, { nextOffset: null, truncated: false });
}

export async function listTopDevelopers(
  apiKey: ApiKeyInfo,
  args: AgentQueryArgs = {},
  options: ListOptions = {},
): Promise<ListEnvelope<DeveloperRow> & { total: number; limit: number; offset: number }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const range = resolveDateRange(args.period ?? undefined, undefined, undefined);

  let limit = options.limit ?? 20;
  let offset = options.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  if (offset < 0) offset = 0;

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  let idx = 3;
  if (apiKey.projectId) {
    scopeConditions.push(`s.project_id = $${idx++}`);
    scopeParams.push(apiKey.projectId);
  }
  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

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
      [range.from, range.to, ...scopeParams, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT s.account_uuid)::int AS total
       FROM sessions s
       WHERE s.account_uuid IS NOT NULL
         AND s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz <= $2::timestamptz${projectClause}`,
      [range.from, range.to, ...scopeParams],
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;
  const items: DeveloperRow[] = result.rows.map((row: Record<string, unknown>) => ({
    accountUuid: row.account_uuid as string,
    sessionCount: (row.session_count as number) ?? 0,
    totalTokens: (row.total_tokens as number) ?? 0,
    totalCostUsd: (row.total_cost_usd as number) ?? 0,
    favoriteModel: (row.favorite_model as string | null) ?? null,
    lastActive: formatTimestamp(row.last_active) ?? null,
  }));

  const truncated = offset + items.length < total;
  const nextOffset = truncated ? offset + items.length : null;
  return {
    ...uniformListEnvelope(items, { nextOffset, truncated }),
    total,
    limit,
    offset,
  };
}

export async function listTopRepositories(
  apiKey: ApiKeyInfo,
  args: AgentQueryArgs = {},
  options: ListOptions = {},
): Promise<ListEnvelope<RepositoryRow> & { total: number; limit: number; offset: number }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const range = resolveDateRange(args.period ?? undefined, undefined, undefined);

  let limit = options.limit ?? 20;
  let offset = options.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 200) limit = 200;
  if (offset < 0) offset = 0;

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  let idx = 3;
  if (apiKey.projectId) {
    scopeConditions.push(`s.project_id = $${idx++}`);
    scopeParams.push(apiKey.projectId);
  }
  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

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
      [range.from, range.to, ...scopeParams, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT s.git_repo)::int AS total
       FROM sessions s
       WHERE s.git_repo IS NOT NULL
         AND s.started_at::timestamptz >= $1::timestamptz AND s.started_at::timestamptz <= $2::timestamptz${projectClause}`,
      [range.from, range.to, ...scopeParams],
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;
  const items: RepositoryRow[] = result.rows.map((row: Record<string, unknown>) => ({
    repository: row.repository as string,
    sessionCount: (row.session_count as number) ?? 0,
    branchCount: (row.branch_count as number) ?? 0,
    totalCostUsd: (row.total_cost_usd as number) ?? 0,
    primaryFramework: (row.primary_framework as string | null) ?? null,
  }));

  const truncated = offset + items.length < total;
  const nextOffset = truncated ? offset + items.length : null;
  return {
    ...uniformListEnvelope(items, { nextOffset, truncated }),
    total,
    limit,
    offset,
  };
}

/**
 * Recent agent activity, grouped by framework. Returns one row per
 * framework that ran sessions in the period, with session count, total
 * cost, and most-recent activity timestamp.
 *
 * No dedicated `agent_activity` table exists; this query aggregates
 * over `sessions`. Project-scoped via apiKey.projectId.
 */
export async function listAgentActivity(
  apiKey: ApiKeyInfo,
  args: AgentQueryArgs = {},
  options: ListOptions = {},
): Promise<ListEnvelope<AgentActivityRow> & { total: number; limit: number; offset: number }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const range = resolveDateRange(
    args.period ?? undefined,
    args.from ?? undefined,
    args.to ?? undefined,
  );

  let limit = options.limit ?? 50;
  let offset = options.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;
  if (offset < 0) offset = 0;

  const scopeConditions: string[] = [];
  const scopeParams: unknown[] = [];
  let idx = 3;
  if (apiKey.projectId) {
    scopeConditions.push(`s.project_id = $${idx++}`);
    scopeParams.push(apiKey.projectId);
  }
  const projectClause =
    scopeConditions.length > 0 ? ` AND ${scopeConditions.join(" AND ")}` : "";

  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(NULLIF(s.framework, ''), 'unknown') AS framework,
         COUNT(DISTINCT s.id)::int AS session_count,
         COALESCE(SUM(s.total_cost_usd), 0)::float AS total_cost_usd,
         MAX(s.last_active_at) AS last_active
       FROM sessions s
       WHERE s.started_at::timestamptz >= $1::timestamptz
         AND s.started_at::timestamptz <= $2::timestamptz${projectClause}
       GROUP BY COALESCE(NULLIF(s.framework, ''), 'unknown')
       ORDER BY last_active DESC NULLS LAST
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [range.from, range.to, ...scopeParams, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(DISTINCT COALESCE(NULLIF(s.framework, ''), 'unknown'))::int AS total
       FROM sessions s
       WHERE s.started_at::timestamptz >= $1::timestamptz
         AND s.started_at::timestamptz <= $2::timestamptz${projectClause}`,
      [range.from, range.to, ...scopeParams],
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;
  const items: AgentActivityRow[] = result.rows.map((row: Record<string, unknown>) => ({
    framework: row.framework as string,
    sessionCount: (row.session_count as number) ?? 0,
    totalCostUsd: (row.total_cost_usd as number) ?? 0,
    lastActive: formatTimestamp(row.last_active) ?? null,
  }));

  const truncated = offset + items.length < total;
  const nextOffset = truncated ? offset + items.length : null;
  return {
    ...uniformListEnvelope(items, { nextOffset, truncated }),
    total,
    limit,
    offset,
  };
}
