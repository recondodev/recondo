/**
 * Tool call stats — Plan C, T8 (Chunk 6).
 *
 * Public surface:
 *   - toolCallStats(options) -> AsyncIterable<ToolCallStatsRow>
 *   - type ToolCallGroupBy = "tool_name" | "session" | "framework"
 *   - type ToolCallPeriod  = "24h" | "7d" | "30d" | "all"
 *   - interface ToolCallStatsRow
 *
 * Yields one row per group, where the group is determined by `group_by`:
 *   - "tool_name" → `group_key` is `tool_calls.tool_name`.
 *   - "session"   → `group_key` is `turns.session_id` (joined via tool_calls.turn_id).
 *   - "framework" → `group_key` is `sessions.framework` (joined turns + sessions).
 *
 * Time window is selected by `period`:
 *   - "24h" → JOIN turns and filter `t.timestamp::timestamptz >= now() - '24 hours'::interval`.
 *   - "7d"  → ... `'7 days'::interval`.
 *   - "30d" → ... `'30 days'::interval`.
 *   - "all" → no time filter (turns are still joined when group_by needs them;
 *             we always join turns for consistency so the same SQL shape is
 *             reused across all periods).
 *
 * `turns.timestamp` is TEXT, so the predicate casts to timestamptz before
 * comparing against `now() - INTERVAL`.
 *
 * Aggregates (one SQL round-trip per call):
 *   - total_calls       = COUNT(*)
 *   - failure_rate      = COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'success')
 *                         / NULLIF(COUNT(*), 0)
 *     NULL `status` is treated as a FAILURE (because `NULL IS DISTINCT FROM 'success'`
 *     evaluates to TRUE). Only the explicit string 'success' counts as a
 *     non-failure. Coerced to 0 on empty groups (the GROUP BY guarantees no
 *     empty groups, but COALESCE shields against an unexpected zero count).
 *   - avg_latency_ms    = AVG(duration_ms)
 *     NULL durations are excluded by AVG (Postgres semantics). COALESCE to 0.
 *   - total_duration_ms = SUM(duration_ms)
 *     Replaces the legacy `token_cost_total` field — `tool_calls` has NO
 *     `token_cost` column, so duration is the honest scalar to surface.
 *     COALESCE to 0 when the group has no non-NULL durations.
 *
 * Iteration semantics:
 *   - The OUTER `toolCallStats` function is NOT async. It validates
 *     `group_by` and `period` synchronously (so unknown values throw BEFORE
 *     the iterator is awaited) and returns the AsyncIterable. No DB I/O
 *     happens until the first `next()` call.
 *   - Pre-aborted signal raises AbortError on the first iteration step.
 *   - Mid-iteration abort raises AbortError on the next yield.
 *
 * Schema column reality (right-column names ONLY — see CLAUDE.md):
 *   - tool_calls.tool_name    (TEXT NOT NULL)
 *   - tool_calls.input_hash   (TEXT)               // NOT args_hash
 *   - tool_calls.duration_ms  (BIGINT, NULLABLE)   // NOT latency_ms
 *   - tool_calls.status       (TEXT, NULLABLE)     // failure_rate driver; NO boolean `success`
 *   - tool_calls.turn_id      (TEXT NOT NULL)
 *   - turns.session_id        (TEXT NOT NULL)
 *   - turns.timestamp         (TEXT; cast to timestamptz at query time)
 *   - sessions.framework      (TEXT)               // NOT agent_framework
 */

import { getPool } from "./pool.js";

export type ToolCallGroupBy = "tool_name" | "session" | "framework";
export type ToolCallPeriod = "24h" | "7d" | "30d" | "all";

export interface ToolCallStatsRow {
  group_key: string;
  total_calls: number;
  failure_rate: number;
  avg_latency_ms: number;
  total_duration_ms: number;
}

const ALLOWED_GROUP_BY: ReadonlySet<string> = new Set([
  "tool_name",
  "session",
  "framework",
]);

const ALLOWED_PERIOD: ReadonlySet<string> = new Set([
  "24h",
  "7d",
  "30d",
  "all",
]);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Coerce a SQL numeric/bigint result (which `pg` returns as a string for
 * BIGINT and number for FLOAT) into a finite number. Falls back to 0 for
 * NULL / NaN / non-finite values so the public API never leaks NaN.
 */
function toFiniteNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Sync-callable entry point. Validates `group_by` and `period`
 * synchronously (so unknown values throw BEFORE the iterator is awaited)
 * then returns an AsyncIterable. The caller passes the result directly to
 * `for await`.
 */
export function toolCallStats(options: {
  group_by: ToolCallGroupBy;
  period: ToolCallPeriod;
  signal?: AbortSignal;
}): AsyncIterable<ToolCallStatsRow> {
  const { group_by, period, signal } = options;

  if (!ALLOWED_GROUP_BY.has(group_by as string)) {
    throw new Error(`unknown group_by: ${group_by as string}`);
  }
  if (!ALLOWED_PERIOD.has(period as string)) {
    throw new Error(`unknown period: ${period as string}`);
  }

  return iterateToolCallStats(group_by, period, signal);
}

/** Map period -> literal interval string used inside the SQL predicate. */
function periodIntervalLiteral(period: ToolCallPeriod): string | null {
  switch (period) {
    case "24h":
      return "24 hours";
    case "7d":
      return "7 days";
    case "30d":
      return "30 days";
    case "all":
      return null;
    default:
      // Unreachable — period is validated by the outer function.
      return null;
  }
}

/**
 * Build the per-group_by SQL. The shape is identical across group_by
 * variants except for:
 *   - the `<group_expr>` selected as `group_key`
 *   - whether sessions is JOINed (only required for group_by="framework")
 *   - the GROUP BY column
 *
 * Turns is always JOINed so the period predicate is uniformly applicable
 * (and so the SQL shape stays consistent). The period predicate is appended
 * conditionally based on `period`.
 */
function buildSql(group_by: ToolCallGroupBy, period: ToolCallPeriod): string {
  let groupExpr: string;
  let joinSessions = "";
  switch (group_by) {
    case "tool_name":
      groupExpr = "tc.tool_name";
      break;
    case "session":
      groupExpr = "t.session_id";
      break;
    case "framework":
      groupExpr = "s.framework";
      joinSessions = "JOIN sessions s ON s.id = t.session_id";
      break;
    default:
      // Unreachable — group_by is validated by the outer function.
      throw new Error(`unknown group_by: ${group_by as string}`);
  }

  const intervalLit = periodIntervalLiteral(period);
  const whereClause =
    intervalLit !== null
      ? `WHERE t.timestamp::timestamptz >= now() - '${intervalLit}'::interval`
      : "";

  return `
    SELECT
      ${groupExpr} AS group_key,
      COUNT(*)::bigint AS total_calls,
      COALESCE(
        COUNT(*) FILTER (WHERE tc.status IS DISTINCT FROM 'success')::float8 /
        NULLIF(COUNT(*)::float8, 0),
        0
      )::float8 AS failure_rate,
      COALESCE(AVG(tc.duration_ms)::float8, 0)::float8 AS avg_latency_ms,
      COALESCE(SUM(tc.duration_ms)::float8, 0)::float8 AS total_duration_ms
    FROM tool_calls tc
    JOIN turns t ON t.id = tc.turn_id
    ${joinSessions}
    ${whereClause}
    GROUP BY ${groupExpr}
  `;
}

async function* iterateToolCallStats(
  group_by: ToolCallGroupBy,
  period: ToolCallPeriod,
  signal: AbortSignal | undefined,
): AsyncGenerator<ToolCallStatsRow, void, void> {
  // Pre-iteration abort check — must fire before any DB I/O.
  throwIfAborted(signal);

  const pool = getPool();
  const sql = buildSql(group_by, period);
  const result = await pool.query(sql);

  for (const row of result.rows) {
    // Per-yield abort check — mid-iteration abort raises on the next yield.
    throwIfAborted(signal);
    yield {
      group_key:
        row.group_key === null || row.group_key === undefined
          ? ""
          : String(row.group_key),
      total_calls: toFiniteNumber(row.total_calls),
      failure_rate: toFiniteNumber(row.failure_rate),
      avg_latency_ms: toFiniteNumber(row.avg_latency_ms),
      total_duration_ms: toFiniteNumber(row.total_duration_ms),
    };
  }
}
