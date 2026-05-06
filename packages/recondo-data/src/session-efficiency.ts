/**
 * Session efficiency — Plan C, T7 (Chunk 5).
 *
 * Public surface:
 *   - sessionEfficiency(sessionId, options?) -> Promise<SessionEfficiency>
 *   - interface SessionEfficiency
 *   - interface PercentileSummary { p50, p99, mean }
 *
 * The function returns a SCALAR aggregate (not an AsyncIterable) — it is
 * a single-row summary, per orchestration C7 D-CT-SCALAR.
 *
 * ALL metrics are computed in ONE SQL round-trip via CTEs / sub-selects.
 * D-SE6 verifies via `vi.spyOn(pool, "query").toHaveBeenCalledTimes(1)`.
 *
 * Metric definitions:
 *
 *   - cache_hit_rate = SUM(cache_read_tokens) / NULLIF(SUM(input_tokens), 0)
 *     coerced to 0 when the denominator is 0 (empty session) — never NaN.
 *     Right-column names: `cache_read_tokens`, `input_tokens`.
 *
 *   - prompt_token_reuse_ratio = (turns whose md5(user_request_text)
 *     appears in MORE than one turn within the session) / total turns.
 *     md5 is computed on-the-fly via SQL `md5(...)`; there is NO
 *     `prompt_hash` column on `turns`. Turns with NULL user_request_text
 *     count toward the denominator (total turns) but cannot match the
 *     numerator — they conservatively dilute the ratio.
 *
 *   - tokens_per_turn = { p50, p99, mean } over (input_tokens +
 *     output_tokens) per turn, using `percentile_disc(0.50/0.99) WITHIN
 *     GROUP (ORDER BY ...)` and AVG(...).
 *
 *   - redundant_tool_call_count = SUM over (tool_name, input_hash) groups
 *     with count > 1 of (count - 1). Right-column names: `tool_name`,
 *     `input_hash`.
 *
 *   - ttft_ms = { p50, p99, mean } over `ttfb_ms` (ignoring NULLs).
 *     Right-column name: `ttfb_ms` (NOT `time_to_first_token_ms`).
 *
 * Percentile semantic disclosure (D-SE9):
 *   The implementation uses PostgreSQL's `percentile_disc` (discrete
 *   percentile) ordered-set aggregate. For tiny samples (e.g. n = 3..5)
 *   `percentile_disc(0.99)` returns the maximum observed value — there
 *   is no interpolation — so callers should NOT be surprised when p99
 *   equals max on small samples. This is the intended behaviour: a
 *   discrete percentile snaps to an actually-observed value, which is
 *   exactly what auditors and operators want for billable / latency
 *   metrics. A continuous interpolated percentile would invent values
 *   that never occurred.
 *
 * Empty session → all metrics are 0 (no NaN, no division-by-zero, no
 * throw). The query uses NULLIF + COALESCE to neutralize empty inputs.
 *
 * AbortSignal honor (D-SE8):
 *   A pre-aborted signal raises an AbortError BEFORE the single
 *   `pool.query` call. The check is the first executable statement of
 *   the function body so no DB I/O leaks out under cancellation.
 *
 * Schema column reality (right-column names ONLY — see CLAUDE.md):
 *   - turns.session_id        (TEXT)
 *   - turns.input_tokens      (BIGINT NOT NULL)
 *   - turns.output_tokens     (BIGINT NOT NULL)
 *   - turns.cache_read_tokens (BIGINT NOT NULL)  // NOT cache_read_input_tokens
 *   - turns.user_request_text (TEXT, nullable)
 *   - turns.ttfb_ms           (BIGINT, nullable) // NOT time_to_first_token_ms
 *   - tool_calls.tool_name    (TEXT)
 *   - tool_calls.input_hash   (TEXT)             // NOT args_hash
 *   - tool_calls.turn_id      (TEXT NOT NULL)
 */

import { getPool } from "./pool.js";

export interface PercentileSummary {
  p50: number;
  p99: number;
  mean: number;
}

export interface SessionEfficiency {
  session_id: string;
  cache_hit_rate: number;
  prompt_token_reuse_ratio: number;
  tokens_per_turn: PercentileSummary;
  redundant_tool_call_count: number;
  ttft_ms: PercentileSummary;
}

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

// ---------------------------------------------------------------------------
// Single-round-trip aggregate query.
//
// Returns ONE row with eight numeric columns:
//   cache_hit_rate, prompt_token_reuse_ratio,
//   tokens_p50, tokens_p99, tokens_mean,
//   redundant_tool_call_count,
//   ttft_p50, ttft_p99, ttft_mean.
//
// All numerator/denominator pairs are guarded with NULLIF + COALESCE so an
// empty session (no turns) returns zeros across the board.
// ---------------------------------------------------------------------------
const SQL = `
WITH
  session_turns AS (
    SELECT
      id,
      input_tokens,
      output_tokens,
      cache_read_tokens,
      user_request_text,
      ttfb_ms,
      input_tokens + output_tokens AS total_tokens
    FROM turns
    WHERE session_id = $1
  ),
  cache_agg AS (
    SELECT
      COALESCE(
        SUM(cache_read_tokens)::float8 /
        NULLIF(SUM(input_tokens)::float8, 0),
        0
      ) AS cache_hit_rate
    FROM session_turns
  ),
  prompt_groups AS (
    SELECT md5(user_request_text) AS h, COUNT(*) AS cnt
    FROM session_turns
    WHERE user_request_text IS NOT NULL
    GROUP BY md5(user_request_text)
  ),
  reused_turns AS (
    SELECT t.id
    FROM session_turns t
    JOIN prompt_groups pg ON pg.h = md5(t.user_request_text)
    WHERE t.user_request_text IS NOT NULL
      AND pg.cnt > 1
  ),
  tokens_pct AS (
    SELECT
      COALESCE(
        percentile_disc(0.50) WITHIN GROUP (ORDER BY total_tokens),
        0
      )::float8 AS tokens_p50,
      COALESCE(
        percentile_disc(0.99) WITHIN GROUP (ORDER BY total_tokens),
        0
      )::float8 AS tokens_p99,
      COALESCE(AVG(total_tokens)::float8, 0) AS tokens_mean
    FROM session_turns
  ),
  ttft_pct AS (
    SELECT
      COALESCE(
        percentile_disc(0.50) WITHIN GROUP (ORDER BY ttfb_ms),
        0
      )::float8 AS ttft_p50,
      COALESCE(
        percentile_disc(0.99) WITHIN GROUP (ORDER BY ttfb_ms),
        0
      )::float8 AS ttft_p99,
      COALESCE(AVG(ttfb_ms)::float8, 0) AS ttft_mean
    FROM session_turns
    WHERE ttfb_ms IS NOT NULL
  ),
  tool_groups AS (
    SELECT tc.tool_name, tc.input_hash, COUNT(*) AS cnt
    FROM tool_calls tc
    JOIN session_turns t ON t.id = tc.turn_id
    GROUP BY tc.tool_name, tc.input_hash
  ),
  tool_agg AS (
    SELECT COALESCE(SUM(cnt - 1) FILTER (WHERE cnt > 1), 0)::bigint
             AS redundant_tool_call_count
    FROM tool_groups
  )
SELECT
  COALESCE(c.cache_hit_rate, 0)::float8 AS cache_hit_rate,
  COALESCE(
    (SELECT COUNT(*)::float8 FROM reused_turns) /
    NULLIF((SELECT COUNT(*)::float8 FROM session_turns), 0),
    0
  )::float8 AS prompt_token_reuse_ratio,
  COALESCE(t.tokens_p50, 0)::float8 AS tokens_p50,
  COALESCE(t.tokens_p99, 0)::float8 AS tokens_p99,
  COALESCE(t.tokens_mean, 0)::float8 AS tokens_mean,
  COALESCE(tg.redundant_tool_call_count, 0)::bigint AS redundant_tool_call_count,
  COALESCE(tt.ttft_p50, 0)::float8 AS ttft_p50,
  COALESCE(tt.ttft_p99, 0)::float8 AS ttft_p99,
  COALESCE(tt.ttft_mean, 0)::float8 AS ttft_mean
FROM cache_agg c
CROSS JOIN tokens_pct t
CROSS JOIN tool_agg tg
LEFT JOIN ttft_pct tt ON true
`;

/**
 * Compute the session efficiency aggregate for a single session in ONE
 * SQL round-trip.
 *
 * The percentile fields use PostgreSQL `percentile_disc` (discrete
 * percentile). On tiny samples (n = 3..5) `percentile_disc(0.99)` returns
 * the max observed value — there is no interpolation — so callers should
 * not be surprised when p99 == max on small samples. This is the
 * intended behaviour for audit / latency reporting: a discrete percentile
 * snaps to an actually-observed value rather than inventing one through
 * interpolation.
 */
export function sessionEfficiency(
  sessionId: string,
  options?: { signal?: AbortSignal },
): Promise<SessionEfficiency> {
  const signal = options?.signal;
  // Pre-query abort check — must fire BEFORE any DB I/O so a pre-aborted
  // signal results in zero pool.query calls (D-SE8). Run synchronously
  // before delegating to the async helper, so the AbortError is thrown
  // (not packaged in a rejected Promise that goes through pool.query).
  throwIfAborted(signal);

  return runSessionEfficiency(sessionId);
}

async function runSessionEfficiency(
  sessionId: string,
): Promise<SessionEfficiency> {
  const pool = getPool();
  const result = await pool.query(SQL, [sessionId]);

  // The query is constructed to always return exactly one row (the
  // aggregate row) even when the session has no turns. Defend anyway.
  const row = result.rows[0] ?? {};

  return {
    session_id: sessionId,
    cache_hit_rate: toFiniteNumber(row.cache_hit_rate),
    prompt_token_reuse_ratio: toFiniteNumber(row.prompt_token_reuse_ratio),
    tokens_per_turn: {
      p50: toFiniteNumber(row.tokens_p50),
      p99: toFiniteNumber(row.tokens_p99),
      mean: toFiniteNumber(row.tokens_mean),
    },
    redundant_tool_call_count: toFiniteNumber(row.redundant_tool_call_count),
    ttft_ms: {
      p50: toFiniteNumber(row.ttft_p50),
      p99: toFiniteNumber(row.ttft_p99),
      mean: toFiniteNumber(row.ttft_mean),
    },
  };
}
