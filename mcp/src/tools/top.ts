/**
 * `recondo_top` — paginated top-N rollup keyed by developer or
 * repository.
 *
 * Dispatches on the required `dimension` enum (2 values) to one of
 * two data-layer helpers:
 *
 *   - "developer"  → `listTopDevelopers(apiKey, args, options)`
 *   - "repository" → `listTopRepositories(apiKey, args, options)`
 *
 * Each helper already returns the canonical 5-key list envelope plus
 * `total / limit / offset` paging metadata; this handler re-runs the
 * items through `enforceListBudget` so an oversize page collapses
 * into a `truncated:true` slice while preserving the extra paging
 * keys when no truncation is needed.
 *
 * Period translation: the MCP surface exposes day/week/month/quarter
 * and translates to the data-layer `DAY_<n>` token via
 * `toDataLayerPeriod`.
 *
 * `ctx.abortSignal` is threaded into the dispatched call.
 */

import { listTopDevelopers, listTopRepositories } from "@recondo/data";
import type {
  AgentQueryArgs,
  ApiKeyInfo,
  DeveloperRow,
  ListEnvelope,
  RepositoryRow,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import { toDataLayerPeriod, type McpPeriod } from "../period.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  dimension: z.enum(["developer", "repository"]),
  period: z.enum(["day", "week", "month", "quarter"]).optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

export const topInputSchema = z.object(inputShape);
export type TopInput = z.infer<typeof topInputSchema>;

const DESCRIPTION =
  "Paginated top-N rollup keyed by developer (account_uuid) or " +
  "repository (git_repo). Dispatches on the required `dimension` " +
  "enum (developer | repository) to the matching `listTop*` " +
  "data-layer helper and returns the canonical 5-key list envelope " +
  "plus total / limit / offset paging metadata. Optional `period` " +
  "(day / week / month / quarter) narrows the time range. Use " +
  "`limit` (1..200) and `offset` to page.";

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

type TopEnvelope =
  | (ListEnvelope<DeveloperRow> & { total: number; limit: number; offset: number })
  | (ListEnvelope<RepositoryRow> & { total: number; limit: number; offset: number });

export const topTool: ReadTool<TopInput, unknown> = {
  name: "recondo_top",
  description: DESCRIPTION,
  inputShape,
  inputSchema: topInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    const args: AgentQueryArgs = {};
    const translated = toDataLayerPeriod(input.period as McpPeriod | undefined);
    if (translated !== undefined) args.period = translated;

    const listOptions: {
      signal?: AbortSignal;
      limit?: number;
      offset?: number;
    } = { signal: ctx.abortSignal };
    if (input.limit !== undefined) listOptions.limit = input.limit;
    if (input.offset !== undefined) listOptions.offset = input.offset;

    let envelope: TopEnvelope;
    if (input.dimension === "developer") {
      envelope = await listTopDevelopers(apiKey, args, listOptions);
    } else {
      envelope = await listTopRepositories(apiKey, args, listOptions);
    }

    const offset = envelope.offset;
    const items: ReadonlyArray<DeveloperRow | RepositoryRow> = envelope.items;
    const budget = enforceListBudget(
      items as Array<DeveloperRow | RepositoryRow>,
      offset,
      JSON.stringify,
    );
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
