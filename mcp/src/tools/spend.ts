/**
 * `recondo_spend` — paginated spend rollup grouped by provider, model,
 * framework, or daily bucket.
 *
 * Dispatches on the required `group_by` enum to one of four data-layer
 * helpers:
 *
 *   - "provider"  → `listSpendByProvider`
 *   - "model"     → `listSpendByModel`
 *   - "framework" → `listSpendByFramework`
 *   - "daily"     → `listDailySpend`
 *
 * Each helper already returns the canonical 5-key list envelope; this
 * handler re-runs the items through `enforceListBudget` so an oversize
 * page collapses into a `truncated:true` slice.
 *
 * Period translation: optional `period` is translated from the MCP
 * human-readable enum to the data-layer `DAY_<n>` token via
 * `toDataLayerPeriod`. `daily` ignores `period` (its window is fixed
 * at 14 days unless `args.days` is overridden, which is not on the
 * MCP surface — see `cost.ts:listDailySpend`).
 *
 * `ctx.abortSignal` is threaded into the dispatched call.
 */

import {
  listSpendByProvider,
  listSpendByModel,
  listSpendByFramework,
  listDailySpend,
} from "@recondo/data";
import type {
  ApiKeyInfo,
  CostQueryArgs,
  ListEnvelope,
  SpendBucket,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import { toDataLayerPeriod, type McpPeriod } from "../period.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  group_by: z.enum(["provider", "model", "framework", "daily"]),
  period: z.enum(["day", "week", "month", "quarter"]).optional(),
  project_id: z.string().optional(),
};

export const spendInputSchema = z.object(inputShape);
export type SpendInput = z.infer<typeof spendInputSchema>;

const DESCRIPTION =
  "Paginated spend rollup grouped by provider, model, framework, or " +
  "daily bucket. Dispatches on the required `group_by` enum (4 values) " +
  "to the matching `listSpendBy*` data-layer helper and returns the " +
  "canonical 5-key list envelope of `SpendBucket` rows (name / " +
  "costUsd / percentage / count). Optional `period` (day / week / " +
  "month / quarter) narrows the time range; `daily` uses a fixed " +
  "14-day window.";

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

type SpendDispatcher = (
  apiKey: ApiKeyInfo,
  args: CostQueryArgs,
  options: { signal?: AbortSignal },
) => Promise<ListEnvelope<SpendBucket>>;

function pickDispatcher(groupBy: SpendInput["group_by"]): SpendDispatcher {
  switch (groupBy) {
    case "provider":
      return listSpendByProvider;
    case "model":
      return listSpendByModel;
    case "framework":
      return listSpendByFramework;
    case "daily":
      return listDailySpend;
  }
}

export const spendTool: ReadTool<SpendInput, unknown> = {
  name: "recondo_spend",
  description: DESCRIPTION,
  inputShape,
  inputSchema: spendInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    const args: CostQueryArgs = {};
    const translated = toDataLayerPeriod(input.period as McpPeriod | undefined);
    if (translated !== undefined) args.period = translated;

    const dispatch = pickDispatcher(input.group_by);
    const envelope = await dispatch(apiKey, args, { signal: ctx.abortSignal });

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
