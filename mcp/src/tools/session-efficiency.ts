/**
 * `recondo_session_efficiency` — per-session efficiency aggregate.
 *
 * Wraps the data-layer `sessionEfficiency(sessionId, options)` helper.
 * Returns the structured `SessionEfficiency` record verbatim — this is
 * metadata about the session (rates, percentiles, counts), NOT
 * captured user/assistant content, so NO `<captured_*>` wrapping is
 * applied.
 *
 * Output shape:
 *   {
 *     session_id,
 *     cache_hit_rate,
 *     prompt_token_reuse_ratio,
 *     tokens_per_turn: { p50, p99, mean },
 *     redundant_tool_call_count,
 *     ttft_ms: { p50, p99, mean },
 *   }
 *
 * Subject to the 32 KB single-record budget — oversize records surface
 * a `response_too_large` envelope.
 *
 * AbortSignal: `sessionEfficiency` throws AbortError synchronously when
 * `options.signal.aborted === true` BEFORE any pool query (see
 * `packages/recondo-data/src/session-efficiency.ts:233`). We rely on
 * that data-layer pre-abort check.
 */
import { sessionEfficiency } from "@recondo/data";
import { z } from "zod";

import { enforceSingleRecordBudget } from "../envelope/truncate.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  session_id: z.string().min(1),
};

export const sessionEfficiencyInputSchema = z.object(inputShape);
export type SessionEfficiencyInput = z.infer<
  typeof sessionEfficiencyInputSchema
>;

const DESCRIPTION =
  "Compute the per-session efficiency aggregate for a given session in " +
  "a single SQL round-trip. Returns a structured record with " +
  "`cache_hit_rate`, `prompt_token_reuse_ratio` (md5-equality), " +
  "`tokens_per_turn` (p50/p99/mean), `redundant_tool_call_count`, and " +
  "`ttft_ms` (p50/p99/mean). The percentile fields use Postgres " +
  "`percentile_disc` (discrete) — on small samples p99 may equal max. " +
  "Output is metadata, not captured content — no envelope wrapping. " +
  "Subject to the 32 KB budget.";

export const sessionEfficiencyTool: ReadTool<
  SessionEfficiencyInput,
  unknown
> = {
  name: "recondo_session_efficiency",
  description: DESCRIPTION,
  inputShape,
  inputSchema: sessionEfficiencyInputSchema,
  handler: async (input, ctx) => {
    const result = await sessionEfficiency(input.session_id, {
      signal: ctx.abortSignal,
    });
    return enforceSingleRecordBudget(result, JSON.stringify);
  },
};
