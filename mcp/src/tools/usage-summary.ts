/**
 * `recondo_usage_summary` — structured usage + spend summary.
 *
 * Wraps the data-layer `getUsageSummary(apiKey, args, options)` and
 * returns the structured `UsageSummary` record verbatim (single record
 * — NO list envelope wrapping). Subject to the 32 KB single-record
 * budget; oversized records surface a `response_too_large` envelope.
 *
 * Period translation: the MCP surface exposes day/week/month/quarter
 * and translates to the data-layer `DAY_<n>` tokens at the boundary
 * via `toDataLayerPeriod`. Default period is `week` (= `DAY_7`).
 *
 * `ctx.abortSignal` is threaded into the data-layer options.
 */

import { getUsageSummary } from "@recondo/data";
import type { ApiKeyInfo, CostQueryArgs } from "@recondo/data";
import { z } from "zod";

import { enforceSingleRecordBudget } from "../envelope/truncate.js";
import { toDataLayerPeriod, type McpPeriod } from "../period.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  period: z
    .enum(["day", "week", "month", "quarter"])
    .default("week"),
  project_id: z.string().optional(),
};

export const usageSummaryInputSchema = z.object(inputShape);
export type UsageSummaryInput = z.infer<typeof usageSummaryInputSchema>;

const DESCRIPTION =
  "Structured usage + spend summary across the selected period. Returns " +
  "a single record with `totalCostUsd`, `projectedMonthlyCostUsd`, " +
  "`totalTokens`, cache-read tokens + percentage, average cost per " +
  "session (with delta vs the prior period), cache hit rate, cache " +
  "savings, cost per developer per day, and developer count. `period` " +
  "is the human-readable enum (day / week / month / quarter), default " +
  "`week`. Subject to the 32 KB budget.";

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

export const usageSummaryTool: ReadTool<UsageSummaryInput, unknown> = {
  name: "recondo_usage_summary",
  description: DESCRIPTION,
  inputShape,
  inputSchema: usageSummaryInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    const args: CostQueryArgs = {};
    // The Zod schema defaults `period` to `"week"`, but the handler is
    // also driven directly from unit tests that bypass schema parsing,
    // so we apply the same default defensively here.
    const period = (input.period as McpPeriod | undefined) ?? "week";
    const translated = toDataLayerPeriod(period);
    if (translated !== undefined) args.period = translated;

    const summary = await getUsageSummary(apiKey, args, {
      signal: ctx.abortSignal,
    });
    return enforceSingleRecordBudget(summary, JSON.stringify);
  },
};
