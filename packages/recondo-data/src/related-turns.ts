/**
 * Related turns — Plan C, T6.
 *
 * Public surface:
 *   - relatedTurns(turnId, relation, options?) -> AsyncIterable<RelatedTurnsRow>
 *   - type Relation = "same_session" | "same_prompt_hash" | "retry_of"
 *   - interface RelatedTurnsRow
 *
 * Three relations, no more, no less:
 *
 *  1. `same_session` — turns sharing the input turn's `session_id`,
 *     EXCLUDING the input itself, ordered ASC by `timestamp`. Because
 *     `turns.timestamp` is TEXT (not timestamptz) the SQL casts via
 *     `timestamp::timestamptz` so ordering follows ISO chronology rather
 *     than lexicographic byte order on the TEXT column.
 *
 *  2. `same_prompt_hash` — turns whose `md5(user_request_text)` matches
 *     the input turn's `md5(user_request_text)`, EXCLUDING the input.
 *     There is NO `prompt_hash` column on `turns`; the hash is computed
 *     in-SQL via `md5(...)`. Cross-session matches are valid because the
 *     md5 space is global.
 *
 *  3. `retry_of` — chained in BOTH directions via `supersedes_turn_id`.
 *     The orchestration plan dropped the never-shipped `retry_of_turn_id`
 *     column; this relation is built ENTIRELY on top of
 *     `supersedes_turn_id`. The result set is:
 *       (a) every turn whose `supersedes_turn_id = $turnId` (turns that
 *           supersede the INPUT), PLUS
 *       (b) the turn referenced by the INPUT's own `supersedes_turn_id`
 *           (the parent the INPUT supersedes), if any.
 *     The input turn itself is excluded.
 *
 *     Mapping disclosure (D-RT7): `retry_of` -> `supersedes_turn_id`.
 *
 * Legacy relations DROPPED in v1: `caused_by` and `same_tool_chain`. Their
 * backing columns (`caused_by_turn_id`, `tool_chain_id`) do not exist on
 * `turns`, so they cannot be implemented honestly. Passing either string
 * literal (cast through `unknown`) throws a synchronous Error with the
 * exact message `unknown relation: <name>`.
 *
 * Iteration semantics (mirrors C1/C2/C3):
 *   - The OUTER `relatedTurns` function is NOT async. It validates the
 *     `relation` argument synchronously and returns the AsyncIterable so
 *     callers drive iteration with `for await`. No DB I/O happens until
 *     the first `next()` call.
 *   - Pre-aborted signal raises AbortError on the first iteration step.
 *   - Mid-iteration abort raises AbortError on the next yield.
 *
 * Schema column reality (right-column names ONLY — see CLAUDE.md):
 *   - turns.id                  (TEXT, primary key)
 *   - turns.session_id          (TEXT)
 *   - turns.timestamp           (TEXT, ISO; cast for ordering)
 *   - turns.user_request_text   (TEXT, NULLABLE)
 *   - turns.supersedes_turn_id  (TEXT, NULLABLE) — drives `retry_of`
 *   No `prompt_hash`, `retry_of_turn_id`, `caused_by_turn_id`, or
 *   `tool_chain_id` columns exist on `turns`.
 */

import { getPool } from "./pool.js";

export type Relation = "same_session" | "same_prompt_hash" | "retry_of";

export interface RelatedTurnsRow {
  turn_id: string;
  session_id: string;
  /** Raw TEXT from `turns.timestamp` (not parsed). */
  timestamp: string;
  user_request_text: string | null;
}

const DEFAULT_LIMIT = 50;

const ALLOWED_RELATIONS: ReadonlySet<string> = new Set([
  "same_session",
  "same_prompt_hash",
  "retry_of",
]);

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }
}

/**
 * Sync-callable entry point. Validates `relation` synchronously (so unknown
 * relations throw BEFORE the iterator is awaited) then returns an
 * AsyncIterable. The caller passes the result directly to `for await`.
 *
 * Mapping recap for the implementation: `retry_of` is built on top of
 * `supersedes_turn_id` (chained in both directions). See header docstring.
 */
export function relatedTurns(
  turnId: string,
  relation: Relation,
  options?: { limit?: number; signal?: AbortSignal },
): AsyncIterable<RelatedTurnsRow> {
  if (!ALLOWED_RELATIONS.has(relation as string)) {
    throw new Error(`unknown relation: ${relation as string}`);
  }
  const limit =
    options?.limit !== undefined && options.limit > 0
      ? Math.floor(options.limit)
      : DEFAULT_LIMIT;
  const signal = options?.signal;
  return iterateRelated(turnId, relation, limit, signal);
}

async function* iterateRelated(
  turnId: string,
  relation: Relation,
  limit: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<RelatedTurnsRow, void, void> {
  // Pre-iteration abort check — must fire before any DB I/O.
  throwIfAborted(signal);

  const pool = getPool();
  let sql: string;

  switch (relation) {
    case "same_session": {
      // Peers in the same session, excluding the input, ordered ASC by
      // timestamp. Cast TEXT -> timestamptz so chronological ordering wins
      // over lexicographic byte order.
      sql = `SELECT t.id            AS turn_id,
                    t.session_id,
                    t.timestamp,
                    t.user_request_text
             FROM turns t
             WHERE t.session_id = (
                     SELECT session_id FROM turns WHERE id = $1
                   )
               AND t.id != $1
             ORDER BY t.timestamp::timestamptz ASC
             LIMIT $2`;
      break;
    }
    case "same_prompt_hash": {
      // md5 is global — cross-session matches are valid. Exclude the
      // input itself and skip rows with NULL user_request_text (a NULL
      // prompt has no hash peers).
      sql = `SELECT t.id            AS turn_id,
                    t.session_id,
                    t.timestamp,
                    t.user_request_text
             FROM turns t
             WHERE md5(t.user_request_text) = (
                     SELECT md5(user_request_text) FROM turns WHERE id = $1
                   )
               AND t.id != $1
               AND t.user_request_text IS NOT NULL
             LIMIT $2`;
      break;
    }
    case "retry_of": {
      // Walk the supersedes chain in both directions so siblings (turns
      // that supersede the same parent) and the parent itself are all
      // surfaced. Specifically, a turn T is in the chain of input I when:
      //   (a) T.supersedes_turn_id = I            (children of the input)
      //   (b) T.id = I.supersedes_turn_id         (the parent of the input)
      //   (c) T.supersedes_turn_id IS NOT NULL
      //       AND T.supersedes_turn_id = I.supersedes_turn_id
      //                                           (siblings — share parent)
      // The input itself is excluded.
      sql = `SELECT t.id            AS turn_id,
                    t.session_id,
                    t.timestamp,
                    t.user_request_text
             FROM turns t
             WHERE t.id != $1
               AND (
                 t.supersedes_turn_id = $1
                 OR t.id = (
                   SELECT supersedes_turn_id FROM turns WHERE id = $1
                 )
                 OR (
                   t.supersedes_turn_id IS NOT NULL
                   AND t.supersedes_turn_id = (
                     SELECT supersedes_turn_id FROM turns WHERE id = $1
                   )
                 )
               )
             LIMIT $2`;
      break;
    }
    default: {
      // Unreachable — the outer function rejects unknown relations
      // synchronously. Kept as a defense-in-depth so a future case
      // addition without a matching arm fails loudly.
      throw new Error(`unknown relation: ${relation as string}`);
    }
  }

  const result = await pool.query(sql, [turnId, limit]);

  for (const row of result.rows) {
    // Per-yield abort check — mid-iteration abort raises on the next yield.
    throwIfAborted(signal);
    yield {
      turn_id: String(row.turn_id),
      session_id: String(row.session_id),
      timestamp: String(row.timestamp),
      user_request_text:
        row.user_request_text === null || row.user_request_text === undefined
          ? null
          : String(row.user_request_text),
    };
  }
}
