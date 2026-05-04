/**
 * Realtime resolvers -- Sprint D2 Batch A.
 *
 * Contains Query.realtimeStats, Query.realtimeFeed, and Query.gatewayStatus.
 *
 * D2.1: realtimeStats -- aggregated dashboard metrics from turns/sessions.
 * D2.2: realtimeFeed -- recent turns with provider/limit/since filters.
 * D2.3: gatewayStatus -- gateway health derived from heartbeats table.
 *
 * B1: Timestamp comparison contract --
 *   Turns and sessions store timestamps as TEXT in ISO 8601 format with a Z
 *   suffix (e.g. "2025-01-15T12:34:56.789Z"). Heartbeats use TIMESTAMPTZ.
 *   TEXT comparison with ISO 8601 + Z suffix is safe because:
 *   - All values are UTC (Z suffix), so no timezone offset variance.
 *   - ISO 8601 format is lexicographically sortable ("2025-01-..." < "2025-02-...").
 *   - The gateway enforces this format on write; no other formats appear in the DB.
 *   If the gateway ever writes non-ISO-8601 timestamps, these queries will break.
 */

import { getPool } from "../db.js";
import { RealtimeLatencySource, type QueryResolvers } from "../generated/graphql.js";
import { formatTimestamp } from "./mappers.js";
import { maskPlaceholderPaths } from "../placeholder-mask.js";

// The operator emits heartbeats every 60 seconds by default. Treating a
// heartbeat as stale at the exact 60-second mark causes flapping around
// scheduler jitter, DB write latency, and poll timing, so allow 3 intervals.
const HEARTBEAT_LIVE_GRACE_SECONDS = 180;
const TURN_ACTIVITY_LIVE_GRACE_SECONDS = 180;
const GATEWAY_METRICS_URL = process.env.GATEWAY_METRICS_URL ?? "http://127.0.0.1:8443/metrics";
const GATEWAY_METRICS_TIMEOUT_MS = 500;

// Matches the dashboard's UI-level "preflight" definition: rows with no HTTP
// status, no completed capture, and no token accounting are gateway-only
// metadata calls (quota checks, etc.) and should be hidden from user-facing
// metrics and the live feed. Kept as a negated fragment so it can be ANDed
// into any turn query without parentheses surprises.
export const EXCLUDE_PURE_PREFLIGHT_SQL =
  "NOT (t.http_status IS NULL AND t.capture_complete = false AND (t.input_tokens + t.output_tokens) = 0)";

interface GatewayLatencySnapshot {
  p50: number | null;
  p99: number | null;
  count: number;
}

function estimateHistogramQuantileMs(
  renderedMetrics: string,
  metricName: string,
  quantile: number,
): number | null {
  const buckets = renderedMetrics
    .split("\n")
    .map((line) => {
      const match = line.match(
        new RegExp(`^${metricName}_bucket\\{le="([^"]+)"\\}\\s+(\\d+(?:\\.\\d+)?)$`),
      );
      if (!match || match[1] === "+Inf") return null;
      return {
        upperBoundSeconds: Number(match[1]),
        cumulativeCount: Number(match[2]),
      };
    })
    .filter((bucket): bucket is { upperBoundSeconds: number; cumulativeCount: number } => (
      bucket !== null && Number.isFinite(bucket.upperBoundSeconds) && Number.isFinite(bucket.cumulativeCount)
    ))
    .sort((a, b) => a.upperBoundSeconds - b.upperBoundSeconds);

  if (buckets.length === 0) return null;

  const totalCount = buckets[buckets.length - 1].cumulativeCount;
  if (totalCount <= 0) return null;

  const targetCount = totalCount * quantile;
  let previousUpperBoundSeconds = 0;
  let previousCumulativeCount = 0;

  for (const bucket of buckets) {
    if (bucket.cumulativeCount >= targetCount) {
      const bucketCount = bucket.cumulativeCount - previousCumulativeCount;
      if (bucketCount <= 0) {
        return Math.round(bucket.upperBoundSeconds * 1000);
      }

      const positionWithinBucket = (targetCount - previousCumulativeCount) / bucketCount;
      const estimateSeconds = previousUpperBoundSeconds + (
        (bucket.upperBoundSeconds - previousUpperBoundSeconds) * positionWithinBucket
      );
      return Math.round(estimateSeconds * 1000);
    }

    previousUpperBoundSeconds = bucket.upperBoundSeconds;
    previousCumulativeCount = bucket.cumulativeCount;
  }

  return Math.round(buckets[buckets.length - 1].upperBoundSeconds * 1000);
}

function parseHistogramObservationCount(renderedMetrics: string, metricName: string): number {
  const match = renderedMetrics.match(
    new RegExp(`^${metricName}_count\\s+(\\d+(?:\\.\\d+)?)$`, "m"),
  );
  if (!match) return 0;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
}

async function fetchGatewayLatencyPercentiles(): Promise<GatewayLatencySnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GATEWAY_METRICS_TIMEOUT_MS);

  try {
    const response = await fetch(GATEWAY_METRICS_URL, { signal: controller.signal });
    if (!response.ok) {
      return { p50: null, p99: null, count: 0 };
    }

    const renderedMetrics = await response.text();
    return {
      p50: estimateHistogramQuantileMs(renderedMetrics, "recondo_capture_latency_seconds", 0.5),
      p99: estimateHistogramQuantileMs(renderedMetrics, "recondo_capture_latency_seconds", 0.99),
      count: parseHistogramObservationCount(renderedMetrics, "recondo_capture_latency_seconds"),
    };
  } catch {
    return { p50: null, p99: null, count: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * D2.1: realtimeStats resolver.
 *
 * Aggregates metrics from turns and sessions tables:
 * - requestsPerMinute: COUNT of turns with timestamp within last 60 seconds
 * - activeSessions: COUNT of sessions with ended_at IS NULL and last_active_at within 5 minutes
 * - activeProviderCount: COUNT DISTINCT provider from turns in last hour
 * - tokensLastHour: SUM(input_tokens + output_tokens) from turns in last hour
 * - cacheReadTokensLastHour: SUM(cache_read_tokens) from turns in last hour
 * - costLastHour: SUM(cost_usd) from turns in last hour
 * - costProjectedToday: costLastHour * 24 (linear extrapolation, not a forecast)
 * - latencyP50Ms / latencyP99Ms: percentile_cont on duration_ms from turns in last hour
 * - latencySampleCount / latencySource: explains whether latency comes from
 *   stored per-turn durations or the gateway histogram fallback
 *
 * W1: Uses Promise.allSettled so that a single failed sub-query does not
 * discard all results. Failed queries fall back to safe defaults (0, null).
 */
const realtimeStatsResolver: NonNullable<QueryResolvers["realtimeStats"]> = async () => {
  const pool = getPool();
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const fiveMinutesAgo = new Date(now.getTime() - 300_000).toISOString();
  const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();

  // W1: Run all aggregation queries in parallel with Promise.allSettled.
  // If any individual query fails, the others still return valid results.
  //
  // Two counters run here:
  //   requestsPerMinute (wire-level): every captured API call including
  //     preflight/title-gen/tool-loop sub-calls. Intended for gateway load.
  //   userTurnsPerMinute (logical): distinct user prompts (grouped) after
  //     preflight exclusion. Intended for user-facing activity metrics.
  const [
    requestsOutcome,
    userTurnsOutcome,
    activeSessionsOutcome,
    hourlyStatsOutcome,
    latencyOutcome,
  ] = await Promise.allSettled([
    // Wire-level request count: keep including preflight so ops can see
    // raw load on the gateway.
    pool.query(
      `SELECT COUNT(*)::int AS count FROM turns WHERE timestamp::timestamptz > $1::timestamptz`,
      [oneMinuteAgo]
    ),
    // Logical-turn count: group contiguous same-user_request_text turns
    // within each session, drop pure-preflight groups, count what's left.
    pool.query(
      `WITH candidate AS (
         SELECT t.session_id, t.sequence_num, t.timestamp, t.user_request_text,
                t.input_tokens, t.output_tokens, t.http_status, t.capture_complete
         FROM turns t
         WHERE t.timestamp::timestamptz > $1::timestamptz
       ),
       lagged AS (
         SELECT c.*,
           LAG(user_request_text) OVER (PARTITION BY session_id ORDER BY sequence_num, timestamp) AS prev_user_request_text
         FROM candidate c
       ),
       labeled AS (
         SELECT l.*,
           SUM(CASE
             WHEN prev_user_request_text IS DISTINCT FROM user_request_text
             THEN 1 ELSE 0
           END) OVER (PARTITION BY session_id ORDER BY sequence_num, timestamp) AS group_idx
         FROM lagged l
       ),
       grouped AS (
         SELECT session_id, group_idx,
           BOOL_AND(http_status IS NULL AND capture_complete = false
                    AND (input_tokens + output_tokens) = 0) AS all_preflight
         FROM labeled
         GROUP BY session_id, group_idx
       )
       SELECT COUNT(*)::int AS count FROM grouped WHERE NOT all_preflight`,
      [oneMinuteAgo]
    ),
    // COUNT active sessions (no ended_at, last_active_at within 5 minutes).
    // Cast to TIMESTAMPTZ: the gateway writes last_active_at via NOW() which
    // produces PG display format ("2026-03-24 14:28:36+00") while JS produces
    // ISO 8601 ("2026-03-24T14:28:36Z"). TEXT comparison fails (space < T).
    //
    // Require at least one non-preflight turn so quota-check-only sessions
    // (the gateway opened a session for a lone quota probe that never became
    // a real LLM turn) do not inflate the "active" count.
    pool.query(
      `SELECT COUNT(*)::int AS count FROM sessions s
       WHERE s.ended_at IS NULL
         AND s.last_active_at::timestamptz > $1::timestamptz
         AND EXISTS (
           SELECT 1 FROM turns t
           WHERE t.session_id = s.id
             AND ${EXCLUDE_PURE_PREFLIGHT_SQL}
         )`,
      [fiveMinutesAgo]
    ),
    // Aggregate tokens, cost, distinct providers from turns in last hour.
    // Token/cost sums are unchanged by preflight exclusion (preflight has 0
    // tokens and 0 cost by definition), but the provider count can be inflated
    // by a session whose only turn is a quota probe — so we filter.
    pool.query(
      `SELECT
         COALESCE(SUM(input_tokens + output_tokens), 0)::float AS tokens_last_hour,
         COALESCE(SUM(cache_read_tokens), 0)::float AS cache_read_tokens_last_hour,
         COALESCE(SUM(cost_usd), 0)::float AS cost_last_hour,
         COUNT(DISTINCT provider)::int AS active_provider_count
       FROM turns t
       WHERE t.timestamp::timestamptz > $1::timestamptz
         AND ${EXCLUDE_PURE_PREFLIGHT_SQL}`,
      [oneHourAgo]
    ),
    // Latency percentiles from turns in last hour. Preflight rows usually lack
    // duration_ms anyway so the filter is belt-and-suspenders.
    pool.query(
      `SELECT
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
         PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
         COUNT(duration_ms)::int AS sample_count
       FROM turns t
       WHERE t.timestamp::timestamptz > $1::timestamptz
         AND duration_ms IS NOT NULL
         AND ${EXCLUDE_PURE_PREFLIGHT_SQL}`,
      [oneHourAgo]
    ),
  ]);

  // W1: Extract results individually -- use defaults (0, null) for failed sub-queries.
  // Log errors for observability.
  let requestsPerMinute = 0;
  if (requestsOutcome.status === "fulfilled") {
    requestsPerMinute = (requestsOutcome.value.rows[0]?.count as number) ?? 0;
  } else {
    console.error("[realtimeStats] requestsPerMinute query failed:", requestsOutcome.reason);
  }

  let userTurnsPerMinute = 0;
  if (userTurnsOutcome.status === "fulfilled") {
    userTurnsPerMinute = (userTurnsOutcome.value.rows[0]?.count as number) ?? 0;
  } else {
    console.error("[realtimeStats] userTurnsPerMinute query failed:", userTurnsOutcome.reason);
  }

  let activeSessions = 0;
  if (activeSessionsOutcome.status === "fulfilled") {
    activeSessions = (activeSessionsOutcome.value.rows[0]?.count as number) ?? 0;
  } else {
    console.error("[realtimeStats] activeSessions query failed:", activeSessionsOutcome.reason);
  }

  let tokensLastHour = 0;
  let cacheReadTokensLastHour = 0;
  let costLastHour = 0;
  let activeProviderCount = 0;
  if (hourlyStatsOutcome.status === "fulfilled") {
    tokensLastHour = (hourlyStatsOutcome.value.rows[0]?.tokens_last_hour as number) ?? 0;
    cacheReadTokensLastHour = (hourlyStatsOutcome.value.rows[0]?.cache_read_tokens_last_hour as number) ?? 0;
    costLastHour = (hourlyStatsOutcome.value.rows[0]?.cost_last_hour as number) ?? 0;
    activeProviderCount = (hourlyStatsOutcome.value.rows[0]?.active_provider_count as number) ?? 0;
  } else {
    console.error("[realtimeStats] hourlyStats query failed:", hourlyStatsOutcome.reason);
  }

  let latencyP50Ms: number | null = null;
  let latencyP99Ms: number | null = null;
  let latencySampleCount = 0;
  let latencySource = RealtimeLatencySource.None;
  if (latencyOutcome.status === "fulfilled") {
    const p50Raw = latencyOutcome.value.rows[0]?.p50;
    const p99Raw = latencyOutcome.value.rows[0]?.p99;
    const sampleCountRaw = latencyOutcome.value.rows[0]?.sample_count;
    latencyP50Ms = p50Raw !== null && p50Raw !== undefined ? Math.round(Number(p50Raw)) : null;
    latencyP99Ms = p99Raw !== null && p99Raw !== undefined ? Math.round(Number(p99Raw)) : null;
    latencySampleCount = sampleCountRaw !== null && sampleCountRaw !== undefined
      ? Math.max(0, Math.round(Number(sampleCountRaw)))
      : 0;
    if (latencySampleCount > 0) {
      latencySource = RealtimeLatencySource.TurnDurationMs;
    }
  } else {
    console.error("[realtimeStats] latency query failed:", latencyOutcome.reason);
  }

  // Live installs may not persist duration_ms/ttfb_ms yet. When the DB has no
  // latency samples, fall back to the gateway's Prometheus capture histogram.
  if (latencySampleCount === 0) {
    const gatewayLatency = await fetchGatewayLatencyPercentiles();
    if (gatewayLatency.count > 0) {
      latencyP50Ms = gatewayLatency.p50;
      latencyP99Ms = gatewayLatency.p99;
      latencySampleCount = gatewayLatency.count;
      latencySource = RealtimeLatencySource.GatewayCaptureHistogram;
    }
  }

  return {
    requestsPerMinute,
    userTurnsPerMinute,
    activeSessions,
    activeProviderCount,
    tokensLastHour,
    cacheReadTokensLastHour,
    costLastHour,
    // W2: Linear extrapolation (costLastHour * 24). Not a forecast -- assumes
    // the current hour's spend rate continues unchanged for the remaining 23 hours.
    costProjectedToday: costLastHour * 24,
    latencyP50Ms,
    latencyP99Ms,
    latencySampleCount,
    latencySource,
  };
};

/**
 * D2.2: realtimeFeed resolver.
 *
 * Returns recent turns joined with sessions for live traffic table display.
 * Supports optional provider, limit, and since filters.
 * Intent is derived from user_request_text (turn) or initial_intent (session),
 * truncated to 60 characters with ellipsis for overflow.
 *
 * N2: Intentionally no project filter -- realtime feed shows all traffic
 * for the authenticated user's scope. Per-project filtering is deferred
 * to the sessions query which already supports projectId.
 *
 * N5: Inner JOIN intentionally excludes orphaned turns (turns without a
 * matching session). These should not appear in the dashboard feed.
 */
// Truncate a string to 60 code points with an ellipsis if longer. Uses
// Array.from so surrogate pairs (emoji, CJK) don't split mid-codepoint.
function truncateIntent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const codePoints = Array.from(raw);
  if (codePoints.length > 60) {
    return codePoints.slice(0, 57).join("") + "...";
  }
  return raw;
}

/**
 * Grouping CTEs: collapse contiguous same-`user_request_text` wire turns into
 * one logical turn. Emitted as a template literal fragment because the Session
 * resolver reuses the same grouping logic scoped to a single session.
 *
 * Grouping heuristic: within a session ordered by (sequence_num, timestamp),
 * start a new group whenever `user_request_text` changes vs. the previous row.
 * Known limitation: if a user types the same text twice in a row (separated by
 * agent activity), both land in the same group. Phase 2 will add an
 * is_continuation flag at capture time to distinguish tool_result continuations
 * from net-new user text.
 *
 * Primary model: prefer the largest non-haiku model in the group. When the
 * agent runs a haiku title-gen + classifier preflight + opus real turn, opus
 * wins and the row reads as "opus" to the user.
 *
 * Pure-preflight drop: groups where every sub-call is HTTP-less, incomplete,
 * and token-less are hidden entirely (quota checks, orphaned preflights).
 */
// FIND-6-K: removed unused `paramIndexStart` parameter — no caller
// ever set it to anything other than `1`, and the CTE body never
// referenced it.
function buildGroupingCTEs(sessionFilterSql: string): string {
  return `
    candidate AS (
      SELECT
        t.id,
        t.session_id,
        t.sequence_num,
        t.timestamp,
        t.provider,
        t.model,
        t.user_request_text,
        t.input_tokens,
        t.output_tokens,
        t.cost_usd,
        t.cache_read_tokens,
        t.cache_creation_tokens,
        t.http_status,
        t.capture_complete,
        t.tool_call_count,
        -- FIND-4-E: read attachment_count from the truth source
        -- (the attachments table) rather than the denormalised
        -- turns.attachment_count column. The denormalised column
        -- can drift when the FIND-1-K reconciliation DLQs (turn row
        -- still over-counts on disk; reconciliation failed). Reading
        -- truth here keeps the realtime feed consistent with
        -- Turn.attachmentCount (which is dataloader-fed from the same
        -- table) and prevents drift from surfacing to compliance
        -- dashboards. The COUNT(*) is bounded by idx_attachments_turn
        -- (one B-tree lookup per turn) so the cost is a small constant.
        COALESCE(
          (SELECT COUNT(*)::int FROM attachments a WHERE a.turn_id = t.id),
          0
        ) AS attachment_count,
        s.framework,
        s.initial_intent,
        s.model AS session_model,
        (t.http_status IS NULL
         AND t.capture_complete = false
         AND (t.input_tokens + t.output_tokens) = 0) AS is_pure_preflight
      FROM turns t
      JOIN sessions s ON t.session_id = s.id
      ${sessionFilterSql}
    ),
    -- Split into two window-function layers: PG refuses LAG nested inside
    -- SUM() OVER. First layer computes the previous row's user_request_text,
    -- second layer computes the cumulative "changes so far" count that is
    -- our group id.
    lagged AS (
      SELECT c.*,
        LAG(user_request_text) OVER (PARTITION BY session_id ORDER BY sequence_num, timestamp) AS prev_user_request_text
      FROM candidate c
    ),
    labeled AS (
      SELECT l.*,
        SUM(CASE
          WHEN prev_user_request_text IS DISTINCT FROM user_request_text
          THEN 1 ELSE 0
        END) OVER (PARTITION BY session_id ORDER BY sequence_num, timestamp) AS group_idx
      FROM lagged l
    ),
    grouped AS (
      SELECT
        session_id,
        group_idx,
        MIN(timestamp::timestamptz) AS start_ts,
        MAX(timestamp::timestamptz) AS end_ts,
        EXTRACT(EPOCH FROM (MAX(timestamp::timestamptz) - MIN(timestamp::timestamptz))) * 1000 AS duration_ms,
        MIN(user_request_text) AS user_request_text,
        MIN(provider) AS provider,
        MIN(framework) AS framework,
        MIN(initial_intent) AS initial_intent,
        MIN(session_model) AS session_model,
        COALESCE(
          MAX(model) FILTER (WHERE model IS NOT NULL AND model <> '' AND LOWER(model) NOT LIKE '%haiku%'),
          MAX(model) FILTER (WHERE model IS NOT NULL AND model <> '')
        ) AS primary_model,
        SUM(COALESCE(input_tokens, 0))::bigint AS input_tokens,
        SUM(COALESCE(output_tokens, 0))::bigint AS output_tokens,
        SUM(COALESCE(cache_read_tokens, 0))::bigint AS cache_read_tokens,
        SUM(COALESCE(cache_creation_tokens, 0))::bigint AS cache_creation_tokens,
        SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0))::bigint AS total_tokens,
        SUM(COALESCE(cost_usd, 0))::float AS cost_usd,
        SUM(COALESCE(tool_call_count, 0))::int AS tool_call_count,
        SUM(COALESCE(attachment_count, 0))::int AS attachment_count,
        COUNT(*)::int AS sub_call_count,
        MAX(http_status) AS worst_http_status,
        BOOL_AND(capture_complete) AS all_complete,
        BOOL_AND(is_pure_preflight) AS all_preflight,
        ARRAY_AGG(id ORDER BY sequence_num, timestamp) AS turn_ids
      FROM labeled
      GROUP BY session_id, group_idx
    )
  `;
}

// Intentionally referenced by external code (Session resolver) — exported so
// the grouping logic stays in one place.
export { buildGroupingCTEs };

const realtimeFeedResolver: NonNullable<QueryResolvers["realtimeFeed"]> = async (
  _parent,
  args
) => {
  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (args.provider) {
    conditions.push(`t.provider = $${idx++}`);
    params.push(args.provider);
  }

  if (args.since) {
    conditions.push(`t.timestamp::timestamptz > $${idx++}::timestamptz`);
    params.push(args.since);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // W5: Treat negative or zero limit same as default (20).
  let limit = args.limit ?? 20;
  if (limit <= 0) limit = 20;
  if (limit > 100) limit = 100;
  params.push(limit);
  const limitIdx = idx++;

  const result = await pool.query(
    `WITH ${buildGroupingCTEs(where)}
     SELECT
       g.session_id,
       g.group_idx,
       g.start_ts,
       g.end_ts,
       g.duration_ms,
       g.user_request_text,
       g.provider,
       g.framework,
       g.initial_intent,
       g.session_model,
       COALESCE(g.primary_model, g.session_model) AS model,
       g.total_tokens,
       g.cost_usd,
       g.tool_call_count,
       g.attachment_count,
       g.sub_call_count,
       g.worst_http_status,
       g.all_complete
     FROM grouped g
     WHERE NOT g.all_preflight
     ORDER BY g.end_ts DESC
     LIMIT $${limitIdx}`,
    params
  );

  return result.rows.map((row: Record<string, unknown>) => {
    // FIND-1-M: mask `[Image: source: /path]` placeholders from the
    // user-visible intent before truncation. Prevents local filesystem
    // paths from leaking into the realtime feed.
    const intentRaw = maskPlaceholderPaths(
      (row.user_request_text as string | null) ||
        (row.initial_intent as string | null) ||
        null,
    );
    const endTs = row.end_ts as Date | string | null;
    const timestamp = endTs
      ? (endTs instanceof Date ? endTs.toISOString() : formatTimestamp(endTs) ?? new Date().toISOString())
      : new Date().toISOString();
    const durationRaw = row.duration_ms;
    const durationMs = durationRaw !== null && durationRaw !== undefined
      ? Math.max(0, Math.round(Number(durationRaw)))
      : null;

    return {
      timestamp,
      provider: (row.provider as string) ?? "unknown",
      model: (row.model as string) ?? null,
      framework: (row.framework as string) ?? null,
      intent: truncateIntent(intentRaw),
      totalTokens: Number(row.total_tokens ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      httpStatus: row.worst_http_status !== null && row.worst_http_status !== undefined
        ? Number(row.worst_http_status)
        : null,
      captureComplete: Boolean(row.all_complete),
      sessionId: (row.session_id as string) ?? "",
      subCallCount: Number(row.sub_call_count ?? 1),
      toolCallCount: Number(row.tool_call_count ?? 0),
      attachmentCount: Number(row.attachment_count ?? 0),
      durationMs,
      userTurnId: `${row.session_id}:${row.group_idx}`,
    };
  });
};

/**
 * D2.3: gatewayStatus resolver.
 *
 * Derives gateway health from heartbeats with a turn-activity fallback:
 * - Recent heartbeat (≤180s): status = "live" with uptimeSeconds from first heartbeat
 * - No recent heartbeat, recent turns (≤180s): status = "live" — turns prove the gateway
 *   is actively processing requests even if heartbeats are slow or idle
 * - Stale heartbeat/turns (>180s): status = "offline"
 * - No heartbeats and no turns: status = "unknown"
 *
 * The turn-activity fallback exists because heartbeats are only emitted during idle
 * periods; the gateway's primary evidence of liveness is the turns it produces.
 *
 * W6: uptimeSeconds = seconds since the first heartbeat recorded, not continuous
 * uptime. Only computed when a heartbeat path is taken; null via turn fallback.
 *
 * W4: Both queries are wrapped in try/catch — returns "unknown" on DB error.
 */
const gatewayStatusResolver: NonNullable<QueryResolvers["gatewayStatus"]> = async () => {
  const pool = getPool();

  // Derive gateway health purely from the heartbeats table.
  // Returns 'unknown' when no heartbeats exist, 'live' when the most recent
  // heartbeat is within the grace window, and 'offline' when stale.
  try {
    const hbResult = await pool.query(
      `SELECT
         MAX(timestamp) AS last_heartbeat,
         MIN(timestamp) AS first_heartbeat
       FROM heartbeats`
    );

    const lastHbRaw = hbResult.rows[0]?.last_heartbeat;
    if (lastHbRaw) {
      const lastHbDate = new Date(lastHbRaw as string);
      const firstHbDate = new Date(hbResult.rows[0].first_heartbeat as string);
      const now = new Date();
      const ageSeconds = (now.getTime() - lastHbDate.getTime()) / 1000;
      return {
        status: ageSeconds <= HEARTBEAT_LIVE_GRACE_SECONDS ? "live" : "offline",
        uptimeSeconds: Math.round((now.getTime() - firstHbDate.getTime()) / 1000),
        lastHeartbeat: lastHbDate.toISOString(),
      };
    }
  } catch (err) {
    console.error("[gatewayStatus] heartbeats query failed:", err);
  }

  // No heartbeats — fall back to recent turn activity as a proxy for gateway liveness.
  // If the gateway is actively processing requests, turns prove it's running even when
  // heartbeats are slow or during high-traffic periods (no idle time to heartbeat).
  try {
    const turnResult = await pool.query(
      `SELECT MAX(timestamp) AS last_turn FROM turns`
    );
    const lastTurnRaw = turnResult.rows[0]?.last_turn;
    if (lastTurnRaw) {
      const lastTurnDate = new Date(lastTurnRaw as string);
      const now = new Date();
      const ageSeconds = (now.getTime() - lastTurnDate.getTime()) / 1000;
      return {
        status: ageSeconds <= TURN_ACTIVITY_LIVE_GRACE_SECONDS ? "live" : "offline",
        uptimeSeconds: null,
        lastHeartbeat: lastTurnDate.toISOString(),
      };
    }
  } catch {
    // turns table may not exist yet
  }

  return { status: "unknown", uptimeSeconds: null, lastHeartbeat: null };
};

export const realtimeResolvers = {
  Query: {
    realtimeStats: realtimeStatsResolver,
    realtimeFeed: realtimeFeedResolver,
    gatewayStatus: gatewayStatusResolver,
  },
};
