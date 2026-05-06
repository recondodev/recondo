/**
 * Cross-turn comparison — produce side-by-side aspect rows for a set of turns.
 *
 * Public surface:
 *   - compareTurns(turn_ids, options?) -> CompareTurnsResult
 *
 * Decisions baked into the contract:
 *
 *  1. Default `aspects` is exactly:
 *       ["prompt", "response", "tools", "cost", "tokens", "model"]
 *     in that order. Result rows preserve that order. When the caller
 *     supplies a subset, the result rows reflect the caller's order.
 *
 *  2. Per-aspect value semantics:
 *       - "prompt"   → turns.user_request_text (string | null)
 *       - "response" → turns.response_text     (string | null)
 *       - "model"    → turns.model             (string | null)
 *       - "cost"     → turns.cost_usd          (number | null)
 *       - "tokens"   → input_tokens + output_tokens — a single scalar per
 *                      turn (the "total tokens" view).
 *       - "tools"    → derived via LEFT JOIN tool_calls + array_agg(tool_name
 *                      ORDER BY tool_calls.id). Turns with zero tool calls
 *                      surface as `[]` (Postgres returns NULL for empty
 *                      array_agg; we COALESCE to '{}'::text[]).
 *
 *  3. Delta:
 *       - "cost"   → max - min across the per-turn scalars (null cost
 *                    treated as 0 for the comparison since DB DOUBLE
 *                    PRECISION nulls would short-circuit Math.max).
 *       - "tokens" → max - min across the per-turn totals.
 *       - "prompt", "response", "model", "tools" → null.
 *     The implementation does NOT hardcode delta=0 anywhere; it always
 *     derives from the underlying scalars.
 *     Numeric aspects: a turn whose column is NULL is treated as 0 for
 *     the delta computation. Untested by D-CT3 (all seeded turns have
 *     non-null cost_usd / token totals); behavior is documented contract,
 *     not regression-guarded.
 *
 *  4. Caller `turn_ids` order is preserved in:
 *       - `result.turn_ids`           (echoed verbatim)
 *       - each row's `values` keys    (insertion order matches caller order)
 *     turn_ids may NOT contain duplicates. Behavior on duplicates is
 *     undefined: result.turn_ids echoes verbatim, but each row's values
 *     map collapses duplicates to a single key. Callers should dedupe
 *     upstream.
 *
 *  5. Empty `turn_ids` array throws SYNCHRONOUSLY (matches the C1
 *     getTurnRawChunk pattern: outer regular function validates +
 *     delegates to inner async helper).
 *     `aspects: []` is treated as "use defaults" (NOT "no aspects"). Pass
 *     undefined to opt into defaults; pass an explicit non-empty list to
 *     narrow.
 *
 *  6. Missing turn id (provided id without a row in `turns`) → reject
 *     with an Error whose message contains every missing id.
 *
 *  7. Pre-aborted signal → AbortError BEFORE any pool.query call. The
 *     `throwIfAborted` invocation is the FIRST executable statement of
 *     the async helper.
 *
 * Schema column reality (right-column names ONLY — see CLAUDE.md):
 *   - turns.user_request_text   (NOT prompt_text)
 *   - turns.response_text       (NOT response_content)
 *   - turns.cost_usd            (NOT token_cost)
 *   - turns.input_tokens, turns.output_tokens
 *   - turns.model
 *   - tool_calls.tool_name, tool_calls.turn_id, tool_calls.id
 *   - turns.id is TEXT (not UUID); the SQL casts the parameter as text[].
 */

import { getPool } from "./pool.js";

export type CompareAspect =
  | "prompt"
  | "response"
  | "tools"
  | "cost"
  | "tokens"
  | "model";

export interface CompareTurnsRow {
  aspect: CompareAspect;
  /**
   * Per-turn value, keyed by turn_id. Iteration order matches the caller's
   * `turn_ids` input order — D-CT5 verifies `Object.keys(values)`.
   */
  values: Record<string, unknown>;
  /** max - min for numeric aspects; null otherwise. */
  delta: number | null;
}

export interface CompareTurnsResult {
  /** Echoed in caller-specified order. */
  turn_ids: string[];
  rows: CompareTurnsRow[];
}

const DEFAULT_ASPECTS: readonly CompareAspect[] = [
  "prompt",
  "response",
  "tools",
  "cost",
  "tokens",
  "model",
] as const;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

interface TurnComparisonRow {
  id: string;
  user_request_text: string | null;
  response_text: string | null;
  model: string | null;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  tool_names: string[];
}

/**
 * Synchronous wrapper: validates `turn_ids` synchronously (empty array
 * throws immediately), then delegates to the async helper. D-CT6 calls
 * this without `await` and asserts the throw is observable on the call
 * expression itself — making this `async` would convert the throw into
 * a Promise rejection and the test would fail.
 */
export function compareTurns(
  turn_ids: string[],
  options?: { aspects?: CompareAspect[]; signal?: AbortSignal },
): Promise<CompareTurnsResult> {
  if (!Array.isArray(turn_ids) || turn_ids.length === 0) {
    throw new Error("compareTurns: turn_ids must be a non-empty array");
  }
  return compareTurnsAsync(turn_ids, options?.aspects, options?.signal);
}

async function compareTurnsAsync(
  turn_ids: string[],
  aspectsOpt: CompareAspect[] | undefined,
  signal: AbortSignal | undefined,
): Promise<CompareTurnsResult> {
  // FIRST statement of the async path — before any DB I/O.
  // D-CT8 spies on pool.query and asserts it is never called.
  throwIfAborted(signal);

  const aspects: readonly CompareAspect[] =
    aspectsOpt && aspectsOpt.length > 0 ? aspectsOpt : DEFAULT_ASPECTS;

  const pool = getPool();
  const result = await pool.query(
    `SELECT t.id,
            t.user_request_text,
            t.response_text,
            t.model,
            t.cost_usd,
            t.input_tokens,
            t.output_tokens,
            COALESCE(tc.tool_names, '{}'::text[]) AS tool_names
     FROM turns t
     LEFT JOIN LATERAL (
       SELECT array_agg(tool_name ORDER BY id) AS tool_names
       FROM tool_calls
       WHERE turn_id = t.id
     ) tc ON true
     WHERE t.id = ANY($1::text[])`,
    [turn_ids],
  );
  // Re-check abort post-IO so a mid-flight cancel still surfaces.
  throwIfAborted(signal);

  const byId = new Map<string, TurnComparisonRow>();
  for (const raw of result.rows) {
    const r = raw as Record<string, unknown>;
    byId.set(r.id as string, {
      id: r.id as string,
      user_request_text: (r.user_request_text as string | null) ?? null,
      response_text: (r.response_text as string | null) ?? null,
      model: (r.model as string | null) ?? null,
      cost_usd: r.cost_usd === null || r.cost_usd === undefined
        ? null
        : Number(r.cost_usd),
      input_tokens: Number(r.input_tokens ?? 0),
      output_tokens: Number(r.output_tokens ?? 0),
      tool_names: Array.isArray(r.tool_names) ? (r.tool_names as string[]) : [],
    });
  }

  const missing = turn_ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(
      `compareTurns: turn id(s) not found: ${missing.join(", ")}`,
    );
  }

  // Build rows in the order requested by `aspects`. For each row,
  // populate `values` by inserting keys in caller `turn_ids` order
  // (modern JS preserves insertion order on plain objects).
  const rows: CompareTurnsRow[] = aspects.map((aspect) =>
    buildRow(aspect, turn_ids, byId),
  );

  return { turn_ids: [...turn_ids], rows };
}

function buildRow(
  aspect: CompareAspect,
  turn_ids: string[],
  byId: Map<string, TurnComparisonRow>,
): CompareTurnsRow {
  const values: Record<string, unknown> = {};
  for (const id of turn_ids) {
    const row = byId.get(id);
    // Existence is guaranteed by the missing-ids check above.
    values[id] = extractAspectValue(aspect, row!);
  }
  const delta = computeDelta(aspect, values);
  return { aspect, values, delta };
}

function extractAspectValue(
  aspect: CompareAspect,
  row: TurnComparisonRow,
): unknown {
  switch (aspect) {
    case "prompt":
      return row.user_request_text;
    case "response":
      return row.response_text;
    case "model":
      return row.model;
    case "cost":
      return row.cost_usd;
    case "tokens":
      return row.input_tokens + row.output_tokens;
    case "tools":
      return row.tool_names;
    default: {
      const exhaustive: never = aspect;
      throw new Error(`compareTurns: unknown aspect ${String(exhaustive)}`);
    }
  }
}

function computeDelta(
  aspect: CompareAspect,
  values: Record<string, unknown>,
): number | null {
  if (aspect !== "cost" && aspect !== "tokens") {
    return null;
  }
  const scalars: number[] = [];
  for (const v of Object.values(values)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      scalars.push(v);
    } else if (v === null || v === undefined) {
      // Treat null numerics as 0 so the delta still reflects the
      // observed range rather than collapsing to NaN.
      scalars.push(0);
    } else {
      const n = Number(v);
      scalars.push(Number.isFinite(n) ? n : 0);
    }
  }
  if (scalars.length === 0) {
    return null;
  }
  return Math.max(...scalars) - Math.min(...scalars);
}
