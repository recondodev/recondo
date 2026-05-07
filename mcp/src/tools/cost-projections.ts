/**
 * `recondo_cost_projections` — 3-month forward cost projection.
 *
 * Wraps the data-layer `getCostProjections(apiKey, period, options)`.
 * NOTE: `period` is the SECOND POSITIONAL ARGUMENT — not nested in an
 * args bag, unlike the sibling `getUsageSummary` / `listSpendBy*`
 * helpers. See `packages/recondo-data/src/cost.ts:getCostProjections`.
 *
 * The data layer returns a fixed 3-element `CostProjection[]` (one
 * row per upcoming month). The MCP handler wraps it as
 * `{ projections: CostProjection[] }` to keep `structuredContent` shaped
 * as an object — this matches the convention used across recondo's
 * single-record read tools (not an SDK-mandated requirement).
 *
 * Period translation: optional `period` is translated from the MCP
 * human-readable enum to the data-layer `DAY_<n>` token via
 * `toDataLayerPeriod` and forwarded as the second positional arg.
 *
 * TODO(plan-e): the data layer (`packages/recondo-data/src/cost.ts`
 * `getCostProjections`) currently ignores its `_period` parameter and
 * always returns a 30-day-trend projection. Tracked for Plan E.
 * The MCP description below reflects the current behavior (period is
 * reserved / not yet honored) so we don't promise period-awareness we
 * cannot deliver.
 *
 * `ctx.abortSignal` is threaded into the data-layer options.
 */

import { getCostProjections } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import { toDataLayerPeriod, type McpPeriod } from "../period.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  period: z.enum(["day", "week", "month", "quarter"]).optional(),
  project_id: z.string().optional(),
};

export const costProjectionsInputSchema = z.object(inputShape);
export type CostProjectionsInput = z.infer<typeof costProjectionsInputSchema>;

const DESCRIPTION =
  "3-month forward cost projection based on the trailing 30-day " +
  "trend. Returns `{ projections: [...] }` with three rows (one per " +
  "upcoming month) carrying `month` (YYYY-MM), `projectedSessions`, " +
  "`projectedTokens`, `projectedCostUsd`, `deltaVsCurrent`, and a " +
  "human-readable `assumptions` string. v1: the optional `period` " +
  "(day / week / month / quarter) parameter is reserved — the current " +
  "data layer always projects from a 30-day trend window regardless " +
  "of the value supplied.";

function authContextToApiKey(
  auth: AuthContext,
  projectIdOverride?: string,
): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: projectIdOverride ?? auth.projectId,
    rateLimitRpm: 0,
  };
}

export const costProjectionsTool: ReadTool<CostProjectionsInput, unknown> = {
  name: "recondo_cost_projections",
  description: DESCRIPTION,
  inputShape,
  inputSchema: costProjectionsInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    const translated = toDataLayerPeriod(input.period as McpPeriod | undefined);

    const projections = await getCostProjections(apiKey, translated ?? null, {
      signal: ctx.abortSignal,
    });
    return { projections };
  },
};
