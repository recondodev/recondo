/**
 * `recondo_compare_turns` — cross-turn side-by-side comparison.
 *
 * Wraps the data-layer `compareTurns(turn_ids, options)` helper. The
 * data-layer signature does NOT take an apiKey first arg — per Plan C
 * the C5 analytical helpers run unscoped (project-scoping comes later).
 *
 * Returns the structured comparison record verbatim (NOT a 5-key list
 * envelope): `{ turn_ids, rows: [{ aspect, values, delta }] }`. For
 * the `prompt` and `response` aspects, the per-turn captured text in
 * each row's `values` map is replaced by a `MessageEnvelope` so an
 * adversarial closing tag in the captured prompt cannot break out of
 * `<captured_user_message>` / `<captured_assistant_message>`.
 *
 * The non-text aspects (`tools`, `cost`, `tokens`, `model`) pass
 * through unchanged.
 *
 * Subject to the 32 KB single-record budget — oversized comparisons
 * surface a `response_too_large` envelope that points the caller at
 * narrowing the `aspects` set or fetching individual turns via
 * `recondo_get_turn`.
 *
 * AbortSignal: `compareTurns` already throws AbortError synchronously
 * when `options.signal.aborted === true` BEFORE any pool query (see
 * `packages/recondo-data/src/compare-turns.ts:148`). We rely on that.
 */
import { compareTurns } from "@recondo/data";
import type { CompareAspect, CompareTurnsResult } from "@recondo/data";
import { z } from "zod";

import { buildMessageEnvelope } from "../envelope/messages.js";
import { enforceSingleRecordBudget } from "../envelope/truncate.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  turn_ids: z.array(z.string().min(1)).min(2).max(10),
  aspects: z
    .array(z.enum(["prompt", "response", "tools", "cost", "tokens", "model"]))
    .optional(),
};

export const compareTurnsInputSchema = z.object(inputShape);
export type CompareTurnsInput = z.infer<typeof compareTurnsInputSchema>;

const DESCRIPTION =
  "Compare 2..10 turns side-by-side across one or more aspects: prompt, " +
  "response, tools, cost, tokens, model. Returns a structured comparison " +
  "record `{ turn_ids, rows: [{ aspect, values, delta }] }` (NOT a list " +
  "envelope). Captured prompt / response text is wrapped in " +
  "`<captured_user_message>` / `<captured_assistant_message>` so " +
  "adversarial payloads cannot escape. Numeric aspects (cost, tokens) " +
  "carry a max-min `delta`. Subject to the 32 KB budget.";

/**
 * Walk the comparison result and replace `prompt` / `response` per-turn
 * string values with `MessageEnvelope` objects. Non-text aspects pass
 * through verbatim.
 */
function wrapCapturedAspects(
  result: CompareTurnsResult,
): CompareTurnsResult {
  const rows = result.rows.map((row) => {
    const aspect = row.aspect as CompareAspect;
    if (aspect !== "prompt" && aspect !== "response") {
      return row;
    }
    const role = aspect === "prompt" ? "user" : "assistant";
    const wrappedValues: Record<string, unknown> = {};
    for (const turnId of Object.keys(row.values)) {
      const raw = row.values[turnId];
      if (typeof raw === "string") {
        wrappedValues[turnId] = buildMessageEnvelope(
          role,
          // The data layer doesn't carry session_id back per turn in
          // CompareTurnsRow; the envelope wants a session id, so we
          // pass an empty string and rely on the turn id to disambiguate.
          // Consumers wiring back to a session do it via `recondo_get_turn`.
          "",
          turnId,
          raw,
        );
      } else {
        wrappedValues[turnId] = raw;
      }
    }
    return { ...row, values: wrappedValues };
  });
  return { turn_ids: result.turn_ids, rows };
}

export const compareTurnsTool: ReadTool<CompareTurnsInput, unknown> = {
  name: "recondo_compare_turns",
  description: DESCRIPTION,
  inputShape,
  inputSchema: compareTurnsInputSchema,
  handler: async (input, ctx) => {
    const opts: { aspects?: CompareAspect[]; signal?: AbortSignal } = {
      signal: ctx.abortSignal,
    };
    if (input.aspects !== undefined) {
      opts.aspects = input.aspects as CompareAspect[];
    }
    const result = await compareTurns(input.turn_ids, opts);
    const wrapped = wrapCapturedAspects(result);
    return enforceSingleRecordBudget(wrapped, JSON.stringify);
  },
};
