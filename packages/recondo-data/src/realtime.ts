/**
 * Realtime telemetry primitives.
 *
 * Hoisted from `api/src/resolvers/realtime.ts` as part of C7. SQL
 * bodies preserved byte-for-byte; transport-shape concerns
 * (RealtimeLatencySource enum binding, attachment masking) stay in
 * api/.
 *
 * Public surface:
 *   - getRealtimeStats(apiKey, options)        -> RealtimeStatsRow
 *   - listRealtimeFeed(apiKey, args, options)  -> AsyncIterable<RealtimeFeedItem>
 *   - getGatewayStatus(apiKey, options)        -> GatewayStatusRow
 *   - buildGroupingCTEs(sessionFilterSql)      -> string  (shared SQL helper)
 *   - EXCLUDE_PURE_PREFLIGHT_SQL                          (shared SQL fragment)
 *
 * Contracts:
 *   - options.signal aborted BEFORE the SQL is issued throws AbortError.
 *   - listRealtimeFeed accepts EITHER an opaque base64url since cursor
 *     OR a raw ISO 8601 timestamp, mirroring listAuditEvents/listAnomalies.
 *   - The Prometheus latency fallback fetches GATEWAY_METRICS_URL with
 *     a hard 500ms timeout. Network/parse failures degrade gracefully.
 *   - buildGroupingCTEs and EXCLUDE_PURE_PREFLIGHT_SQL are exported so
 *     api/ resolvers and future callers (Session live feed, etc.) share
 *     a single SQL definition.
 */

import { getPool } from "./pool.js";
import { abortableIterable } from "./async-iter.js";
import { decodeSinceCursor } from "./envelope.js";
import { formatTimestamp } from "./mappers.js";
import { maskPlaceholderPaths } from "./redaction/index.js";
import type { ApiKeyInfo, ListOptions, QueryOptions, SinceCursor } from "./types.js";

const HEARTBEAT_LIVE_GRACE_SECONDS = 180;
const TURN_ACTIVITY_LIVE_GRACE_SECONDS = 180;
const GATEWAY_METRICS_URL =
  process.env.GATEWAY_METRICS_URL ?? "http://127.0.0.1:8443/metrics";
const GATEWAY_METRICS_TIMEOUT_MS = 500;

/**
 * SQL fragment that excludes "pure preflight" turns — wire-level
 * metadata calls (quota probes, etc.) that have no HTTP status, no
 * completed capture, and no token accounting. These should be hidden
 * from user-facing metrics and the live feed.
 *
 * Negated form so it AND-composes into any turn query without
 * parentheses surprises.
 */
export const EXCLUDE_PURE_PREFLIGHT_SQL =
  "NOT (t.http_status IS NULL AND t.capture_complete = false AND (t.input_tokens + t.output_tokens) = 0)";

export type RealtimeLatencySourceString =
  | "TURN_DURATION_MS"
  | "GATEWAY_CAPTURE_HISTOGRAM"
  | "NONE";

export interface RealtimeStatsRow {
  requestsPerMinute: number;
  userTurnsPerMinute: number;
  activeSessions: number;
  activeProviderCount: number;
  tokensLastHour: number;
  cacheReadTokensLastHour: number;
  costLastHour: number;
  costProjectedToday: number;
  latencyP50Ms: number | null;
  latencyP99Ms: number | null;
  latencySampleCount: number;
  latencySource: RealtimeLatencySourceString;
}

export interface RealtimeFeedArgs {
  provider?: string | null;
  /** Raw ISO timestamp OR an opaque base64url since cursor. */
  since?: string | null;
}

export interface RealtimeFeedItem {
  timestamp: string;
  provider: string;
  model: string | null;
  framework: string | null;
  intent: string | null;
  totalTokens: number;
  costUsd: number;
  httpStatus: number | null;
  captureComplete: boolean;
  sessionId: string;
  subCallCount: number;
  toolCallCount: number;
  attachmentCount: number;
  durationMs: number | null;
  userTurnId: string;
}

export interface GatewayStatusRow {
  status: "live" | "offline" | "unknown";
  uptimeSeconds: number | null;
  lastHeartbeat: string | null;
}

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
    .filter((b): b is { upperBoundSeconds: number; cumulativeCount: number } =>
      b !== null && Number.isFinite(b.upperBoundSeconds) && Number.isFinite(b.cumulativeCount),
    )
    .sort((a, b) => a.upperBoundSeconds - b.upperBoundSeconds);

  if (buckets.length === 0) return null;

  const totalCount = buckets[buckets.length - 1].cumulativeCount;
  if (totalCount <= 0) return null;

  const targetCount = totalCount * quantile;
  let prevUpper = 0;
  let prevCumulative = 0;

  for (const bucket of buckets) {
    if (bucket.cumulativeCount >= targetCount) {
      const bucketCount = bucket.cumulativeCount - prevCumulative;
      if (bucketCount <= 0) return Math.round(bucket.upperBoundSeconds * 1000);
      const positionWithinBucket = (targetCount - prevCumulative) / bucketCount;
      const estimateSeconds =
        prevUpper + (bucket.upperBoundSeconds - prevUpper) * positionWithinBucket;
      return Math.round(estimateSeconds * 1000);
    }
    prevUpper = bucket.upperBoundSeconds;
    prevCumulative = bucket.cumulativeCount;
  }
  return Math.round(buckets[buckets.length - 1].upperBoundSeconds * 1000);
}

function parseHistogramObservationCount(rendered: string, metricName: string): number {
  const match = rendered.match(
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
    const rendered = await response.text();
    return {
      p50: estimateHistogramQuantileMs(rendered, "recondo_capture_latency_seconds", 0.5),
      p99: estimateHistogramQuantileMs(rendered, "recondo_capture_latency_seconds", 0.99),
      count: parseHistogramObservationCount(rendered, "recondo_capture_latency_seconds"),
    };
  } catch {
    return { p50: null, p99: null, count: 0 };
  } finally {
    clearTimeout(timeout);
  }
}

function truncateIntent(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const codePoints = Array.from(raw);
  if (codePoints.length > 60) return codePoints.slice(0, 57).join("") + "...";
  return raw;
}

/**
 * Grouping CTEs: collapse contiguous same-`user_request_text` wire
 * turns into one logical turn. Emitted as a template literal fragment
 * because the realtime feed AND any future Session live-feed reuse the
 * same grouping logic scoped to a session filter.
 *
 * Heuristic: within a session ordered by (sequence_num, timestamp),
 * start a new group whenever `user_request_text` changes vs. the
 * previous row.
 *
 * Primary model: prefer the largest non-haiku model in the group.
 *
 * Pure-preflight drop: groups where every sub-call is HTTP-less,
 * incomplete, and token-less are hidden entirely.
 */
export function buildGroupingCTEs(sessionFilterSql: string): string {
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

export async function getRealtimeStats(
  _apiKey: ApiKeyInfo,
  options: QueryOptions = {},
): Promise<RealtimeStatsRow> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const now = new Date();
  const oneMinuteAgo = new Date(now.getTime() - 60_000).toISOString();
  const fiveMinutesAgo = new Date(now.getTime() - 300_000).toISOString();
  const oneHourAgo = new Date(now.getTime() - 3_600_000).toISOString();

  const [
    requestsOutcome,
    userTurnsOutcome,
    activeSessionsOutcome,
    hourlyStatsOutcome,
    latencyOutcome,
  ] = await Promise.allSettled([
    pool.query(
      `SELECT COUNT(*)::int AS count FROM turns WHERE timestamp::timestamptz > $1::timestamptz`,
      [oneMinuteAgo],
    ),
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
      [oneMinuteAgo],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM sessions s
       WHERE s.ended_at IS NULL
         AND s.last_active_at::timestamptz > $1::timestamptz
         AND EXISTS (
           SELECT 1 FROM turns t
           WHERE t.session_id = s.id
             AND ${EXCLUDE_PURE_PREFLIGHT_SQL}
         )`,
      [fiveMinutesAgo],
    ),
    pool.query(
      `SELECT
         COALESCE(SUM(input_tokens + output_tokens), 0)::float AS tokens_last_hour,
         COALESCE(SUM(cache_read_tokens), 0)::float AS cache_read_tokens_last_hour,
         COALESCE(SUM(cost_usd), 0)::float AS cost_last_hour,
         COUNT(DISTINCT provider)::int AS active_provider_count
       FROM turns t
       WHERE t.timestamp::timestamptz > $1::timestamptz
         AND ${EXCLUDE_PURE_PREFLIGHT_SQL}`,
      [oneHourAgo],
    ),
    pool.query(
      `SELECT
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
         PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
         COUNT(duration_ms)::int AS sample_count
       FROM turns t
       WHERE t.timestamp::timestamptz > $1::timestamptz
         AND duration_ms IS NOT NULL
         AND ${EXCLUDE_PURE_PREFLIGHT_SQL}`,
      [oneHourAgo],
    ),
  ]);

  let requestsPerMinute = 0;
  if (requestsOutcome.status === "fulfilled") {
    requestsPerMinute = (requestsOutcome.value.rows[0]?.count as number) ?? 0;
  } else {
    console.error("[getRealtimeStats] requestsPerMinute query failed:", requestsOutcome.reason);
  }

  let userTurnsPerMinute = 0;
  if (userTurnsOutcome.status === "fulfilled") {
    userTurnsPerMinute = (userTurnsOutcome.value.rows[0]?.count as number) ?? 0;
  } else {
    console.error("[getRealtimeStats] userTurnsPerMinute query failed:", userTurnsOutcome.reason);
  }

  let activeSessions = 0;
  if (activeSessionsOutcome.status === "fulfilled") {
    activeSessions = (activeSessionsOutcome.value.rows[0]?.count as number) ?? 0;
  } else {
    console.error("[getRealtimeStats] activeSessions query failed:", activeSessionsOutcome.reason);
  }

  let tokensLastHour = 0;
  let cacheReadTokensLastHour = 0;
  let costLastHour = 0;
  let activeProviderCount = 0;
  if (hourlyStatsOutcome.status === "fulfilled") {
    const row = hourlyStatsOutcome.value.rows[0] ?? {};
    tokensLastHour = (row.tokens_last_hour as number) ?? 0;
    cacheReadTokensLastHour = (row.cache_read_tokens_last_hour as number) ?? 0;
    costLastHour = (row.cost_last_hour as number) ?? 0;
    activeProviderCount = (row.active_provider_count as number) ?? 0;
  } else {
    console.error("[getRealtimeStats] hourlyStats query failed:", hourlyStatsOutcome.reason);
  }

  let latencyP50Ms: number | null = null;
  let latencyP99Ms: number | null = null;
  let latencySampleCount = 0;
  let latencySource: RealtimeLatencySourceString = "NONE";
  if (latencyOutcome.status === "fulfilled") {
    const row = latencyOutcome.value.rows[0] ?? {};
    const p50Raw = row.p50;
    const p99Raw = row.p99;
    const sampleCountRaw = row.sample_count;
    latencyP50Ms = p50Raw !== null && p50Raw !== undefined ? Math.round(Number(p50Raw)) : null;
    latencyP99Ms = p99Raw !== null && p99Raw !== undefined ? Math.round(Number(p99Raw)) : null;
    latencySampleCount =
      sampleCountRaw !== null && sampleCountRaw !== undefined
        ? Math.max(0, Math.round(Number(sampleCountRaw)))
        : 0;
    if (latencySampleCount > 0) latencySource = "TURN_DURATION_MS";
  } else {
    console.error("[getRealtimeStats] latency query failed:", latencyOutcome.reason);
  }

  if (latencySampleCount === 0) {
    const gatewayLatency = await fetchGatewayLatencyPercentiles();
    if (gatewayLatency.count > 0) {
      latencyP50Ms = gatewayLatency.p50;
      latencyP99Ms = gatewayLatency.p99;
      latencySampleCount = gatewayLatency.count;
      latencySource = "GATEWAY_CAPTURE_HISTOGRAM";
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
    costProjectedToday: costLastHour * 24,
    latencyP50Ms,
    latencyP99Ms,
    latencySampleCount,
    latencySource,
  };
}

export function listRealtimeFeed(
  _apiKey: ApiKeyInfo,
  args: RealtimeFeedArgs = {},
  options: ListOptions = {},
): AsyncIterable<RealtimeFeedItem> {
  const inner = (async function* (): AsyncIterable<RealtimeFeedItem> {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const pool = getPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (args.provider) {
      conditions.push(`t.provider = $${idx++}`);
      params.push(args.provider);
    }

    if (args.since) {
      let ts: string;
      try {
        const decoded = decodeSinceCursor(args.since as SinceCursor);
        ts = decoded.ts;
      } catch {
        ts = args.since;
      }
      conditions.push(`t.timestamp::timestamptz > $${idx++}::timestamptz`);
      params.push(ts);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    let limit = options.limit ?? 20;
    if (limit <= 0) limit = 20;
    if (limit > 1000) limit = 1000;
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
      params,
    );

    for (const row of result.rows as Record<string, unknown>[]) {
      const intentRaw = maskPlaceholderPaths(
        (row.user_request_text as string | null) ||
          (row.initial_intent as string | null) ||
          null,
      );
      const endTs = row.end_ts as Date | string | null;
      const timestamp = endTs
        ? endTs instanceof Date
          ? endTs.toISOString()
          : formatTimestamp(endTs) ?? new Date().toISOString()
        : new Date().toISOString();
      const durationRaw = row.duration_ms;
      const durationMs =
        durationRaw !== null && durationRaw !== undefined
          ? Math.max(0, Math.round(Number(durationRaw)))
          : null;

      yield {
        timestamp,
        provider: (row.provider as string) ?? "unknown",
        model: (row.model as string | null) ?? null,
        framework: (row.framework as string | null) ?? null,
        intent: truncateIntent(intentRaw),
        totalTokens: Number(row.total_tokens ?? 0),
        costUsd: Number(row.cost_usd ?? 0),
        httpStatus:
          row.worst_http_status !== null && row.worst_http_status !== undefined
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
    }
  })();

  return abortableIterable(inner, options.signal);
}

export async function getGatewayStatus(
  _apiKey: ApiKeyInfo,
  options: QueryOptions = {},
): Promise<GatewayStatusRow> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  try {
    const hbResult = await pool.query(
      `SELECT
         MAX(timestamp) AS last_heartbeat,
         MIN(timestamp) AS first_heartbeat
       FROM heartbeats`,
    );
    const lastHbRaw = hbResult.rows[0]?.last_heartbeat;
    if (lastHbRaw) {
      const lastHb = new Date(lastHbRaw as string);
      const firstHb = new Date(hbResult.rows[0].first_heartbeat as string);
      const now = new Date();
      const ageSeconds = (now.getTime() - lastHb.getTime()) / 1000;
      return {
        status: ageSeconds <= HEARTBEAT_LIVE_GRACE_SECONDS ? "live" : "offline",
        uptimeSeconds: Math.round((now.getTime() - firstHb.getTime()) / 1000),
        lastHeartbeat: lastHb.toISOString(),
      };
    }
  } catch (err) {
    console.error("[getGatewayStatus] heartbeats query failed:", err);
  }

  try {
    const turnResult = await pool.query(`SELECT MAX(timestamp) AS last_turn FROM turns`);
    const lastTurnRaw = turnResult.rows[0]?.last_turn;
    if (lastTurnRaw) {
      const lastTurn = new Date(lastTurnRaw as string);
      const now = new Date();
      const ageSeconds = (now.getTime() - lastTurn.getTime()) / 1000;
      return {
        status: ageSeconds <= TURN_ACTIVITY_LIVE_GRACE_SECONDS ? "live" : "offline",
        uptimeSeconds: null,
        lastHeartbeat: lastTurn.toISOString(),
      };
    }
  } catch {
    // turns table may not exist yet
  }

  return { status: "unknown", uptimeSeconds: null, lastHeartbeat: null };
}
