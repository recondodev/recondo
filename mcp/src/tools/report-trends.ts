/**
 * `recondo_report_trends` — compliance-report trend rollup dispatched
 * on the required `metric` enum (2 values):
 *
 *   - "coverage" → `listReportCoverageTrend(apiKey, args, options)`
 *                  Time-series of coverage % from `report_coverage`.
 *   - "findings" → `listReportFindingsTrend(apiKey, args, options)`
 *                  Per-report findings totals from `reports`.
 *
 * Both helpers return `ListEnvelope<TrendPoint>` (label + value);
 * the MCP surface forwards the envelope verbatim and does not page —
 * trend series are bounded by the migration-seeded row count.
 *
 * `ctx.abortSignal` is threaded into the dispatched call.
 */

import {
  listReportCoverageTrend,
  listReportFindingsTrend,
} from "@recondo/data";
import type {
  ApiKeyInfo,
  ListEnvelope,
  TrendPoint,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  metric: z.enum(["coverage", "findings"]),
  project_id: z.string().optional(),
};

export const reportTrendsInputSchema = z.object(inputShape);
export type ReportTrendsInput = z.infer<typeof reportTrendsInputSchema>;

const DESCRIPTION =
  "Compliance-report trend rollup. Dispatches on the required " +
  "`metric` enum (coverage | findings). `coverage` returns the " +
  "historical coverage-% time-series from `report_coverage`. " +
  "`findings` returns per-report findings totals from `reports`. " +
  "Both branches return the canonical 5-key list envelope of " +
  "`TrendPoint` (label + value).";

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

type TrendDispatcher = (
  apiKey: ApiKeyInfo,
  args: Record<string, never>,
  options: { signal?: AbortSignal },
) => Promise<ListEnvelope<TrendPoint>>;

function pickDispatcher(metric: ReportTrendsInput["metric"]): TrendDispatcher {
  switch (metric) {
    case "coverage":
      return listReportCoverageTrend;
    case "findings":
      return listReportFindingsTrend;
  }
}

export const reportTrendsTool: ReadTool<ReportTrendsInput, unknown> = {
  name: "recondo_report_trends",
  description: DESCRIPTION,
  inputShape,
  inputSchema: reportTrendsInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);

    const dispatch = pickDispatcher(input.metric);
    const envelope = await dispatch(
      apiKey,
      {},
      { signal: ctx.abortSignal },
    );

    const budget = enforceListBudget(envelope.items, 0, JSON.stringify);
    if (!budget.truncated) {
      return envelope;
    }
    return buildListEnvelope({
      items: budget.items,
      nextOffset: budget.nextOffset,
      truncated: true,
    });
  },
};
