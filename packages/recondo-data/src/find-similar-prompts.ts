/**
 * Find prompts byte-identical to a reference prompt — Plan C, T5.
 *
 * Public surface:
 *   - findSimilarPrompts(input, options?) -> AsyncIterable<SimilarPromptMatch>
 *
 * v1 limitations and design decisions:
 *
 *  1. v1 is HASH-ONLY / BYTE-IDENTICAL matching. Two prompts are considered
 *     similar iff `md5(turns.user_request_text)` is byte-for-byte equal.
 *     Whitespace differences, casing, or any other normalization do NOT match.
 *     A trailing space, tab, or newline produces a different hash and a
 *     non-match. This is intentional for v1 — semantic similarity (via
 *     embeddings) is on the future-work list, not in this deliverable.
 *
 *  2. PERFORMANCE: the SQL computes `md5(user_request_text)` on the fly,
 *     which forces a SEQUENTIAL SCAN of `turns` (no index can be used). At
 *     low row counts this is fine; at scale it is not. The v1.5 plan is to
 *     add a generated `prompt_hash` column on `turns` plus a B-tree index,
 *     which converts the lookup to an index probe. Until then, callers
 *     should treat this function as "best effort" against modest history.
 *
 *  3. INPUT SHAPES: two call shapes are supported.
 *       findSimilarPrompts(turnId)            — looks up the turn's
 *                                                user_request_text and uses
 *                                                its md5 as the search key.
 *       findSimilarPrompts({ text: "..." })   — uses the literal text.
 *     When given a turn id whose row is missing, the function throws an
 *     Error whose message names the missing id. When given a turn id whose
 *     `user_request_text` is NULL, the function yields nothing (vacuous —
 *     a NULL prompt has no peers under hash-equality).
 *
 *  4. ITERATION & LIMIT: returns an `AsyncIterable<SimilarPromptMatch>`. The
 *     outer function is sync-callable (NOT async): it returns the iterable
 *     immediately so callers can drive iteration with `for await`. Default
 *     limit is 50; callers can override via `options.limit`.
 *
 *  5. SELF-EXCLUSION: when the input is a turn id, that turn is excluded
 *     from the result set (`WHERE t.id != $turnId`). When the input is
 *     `{ text }`, no exclusion applies.
 *
 *  6. ABORT: pre-aborted signal raises AbortError on the first iteration
 *     step. Mid-iteration abort raises AbortError on the next yield. The
 *     thrown error is a real `Error` with `name === "AbortError"` so the
 *     standard `err.name === "AbortError"` branch works.
 *
 * Schema column reality (right-column names ONLY — see CLAUDE.md):
 *   - turns.id                  (TEXT, primary key)
 *   - turns.session_id          (TEXT)
 *   - turns.user_request_text   (TEXT, NULLABLE)
 *   There is NO `prompt_hash` column on `turns`. There is NO `prompt_text`
 *   column on `turns`. The hash is derived in-SQL via `md5(...)`.
 */

import { getPool } from "./pool.js";

export interface SimilarPromptMatch {
  turn_id: string;
  session_id: string;
  user_request_text: string;
}

export type FindSimilarPromptsInput = string | { text: string };

const DEFAULT_LIMIT = 50;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Sync-callable entry point. Returns an AsyncIterable so iteration is
 * driven by the caller; no DB I/O happens until the first `next()` call.
 *
 * NOTE: declared as a regular `function` (not async) so the returned value
 * is the iterable itself, not `Promise<AsyncIterable<...>>`. The caller
 * passes the result directly to `for await`.
 */
export function findSimilarPrompts(
  input: FindSimilarPromptsInput,
  options?: { limit?: number; signal?: AbortSignal },
): AsyncIterable<SimilarPromptMatch> {
  const limit =
    options?.limit !== undefined && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_LIMIT;
  const signal = options?.signal;
  return iterateSimilar(input, limit, signal);
}

async function* iterateSimilar(
  input: FindSimilarPromptsInput,
  limit: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<SimilarPromptMatch, void, void> {
  // Pre-iteration abort check — must fire before any DB I/O.
  throwIfAborted(signal);

  const pool = getPool();

  let rows: Array<{
    turn_id: string;
    session_id: string;
    user_request_text: string;
  }>;

  if (typeof input === "string") {
    // Path A: input is a turn id. Match against its md5(user_request_text)
    // and exclude the input row itself.
    const turnId = input;
    const result = await pool.query(
      `SELECT t.id AS turn_id,
              t.session_id,
              t.user_request_text
       FROM turns t
       WHERE md5(t.user_request_text) = (
         SELECT md5(user_request_text) FROM turns WHERE id = $1
       )
         AND t.id != $1
         AND t.user_request_text IS NOT NULL
       LIMIT $2`,
      [turnId, limit],
    );

    // If the input turn doesn't exist OR has NULL user_request_text, the
    // subquery yields NULL or empty. Differentiate: a missing row should
    // throw; a NULL prompt should yield nothing.
    if (result.rows.length === 0) {
      throwIfAborted(signal);
      const probe = await pool.query(
        `SELECT id, user_request_text FROM turns WHERE id = $1`,
        [turnId],
      );
      if (probe.rows.length === 0) {
        throw new Error(`findSimilarPrompts: turn id not found: ${turnId}`);
      }
      // Row exists but no peers (or null prompt) — vacuously empty.
      return;
    }

    rows = result.rows.map((r) => ({
      turn_id: String(r.turn_id),
      session_id: String(r.session_id),
      user_request_text: String(r.user_request_text),
    }));
  } else {
    // Path B: input is { text }. Use the literal directly.
    const text = input.text;
    const result = await pool.query(
      `SELECT t.id AS turn_id,
              t.session_id,
              t.user_request_text
       FROM turns t
       WHERE md5(t.user_request_text) = md5($1::text)
         AND t.user_request_text IS NOT NULL
       LIMIT $2`,
      [text, limit],
    );
    rows = result.rows.map((r) => ({
      turn_id: String(r.turn_id),
      session_id: String(r.session_id),
      user_request_text: String(r.user_request_text),
    }));
  }

  for (const row of rows) {
    // Per-yield abort check — mid-iteration abort raises on the next yield.
    throwIfAborted(signal);
    yield row;
  }
}
