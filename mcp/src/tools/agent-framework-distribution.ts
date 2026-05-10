/**
 * `recondo_agent_framework_distribution` — paginated framework usage
 * mix across the selected period.
 *
 * Wraps the data-layer `listAgentFrameworkDistribution(apiKey, args,
 * options)` and returns the canonical 5-key list envelope of
 * `AgentFrameworkUsage` rows (name / costUsd / percentage / count).
 * The data layer already returns the canonical envelope; this handler
 * re-runs the items through `enforceListBudget` so an oversize page
 * collapses into a `truncated:true` slice.
 *
 * Period translation: the MCP surface exposes day/week/month/quarter
 * and translates to the data-layer `DAY_<n>` token via
 * `toDataLayerPeriod`.
 *
 * `ctx.abortSignal` is threaded into the data-layer options bag.
 */

import { listAgentFrameworkDistribution } from "@recondo/data";
import type {
  AgentFrameworkUsage,
  AgentQueryArgs,
  ApiKeyInfo,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import { toDataLayerPeriod, type McpPeriod } from "../period.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  period: z.enum(["day", "week", "month", "quarter"]).optional(),
  project_id: z.string().optional(),
};

export const agentFrameworkDistributionInputSchema = z.object(inputShape);
export type AgentFrameworkDistributionInput = z.infer<
  typeof agentFrameworkDistributionInputSchema
>;

const DESCRIPTION =
  "Paginated agent framework usage mix across the selected period. " +
  "Returns the canonical 5-key list envelope of usage rows (name, " +
  "costUsd, percentage, count). `period` is the human-readable enum " +
  "(day / week / month / quarter). Use this to chart which agent " +
  "frameworks are dominant in the captured traffic.";

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

export const agentFrameworkDistributionTool: ReadTool<
  AgentFrameworkDistributionInput,
  unknown
> = {
  name: "recondo_agent_framework_distribution",
  description: DESCRIPTION,
  inputShape,
  inputSchema: agentFrameworkDistributionInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    const args: AgentQueryArgs = {};
    const translated = toDataLayerPeriod(input.period as McpPeriod | undefined);
    if (translated !== undefined) args.period = translated;

    const envelope = await listAgentFrameworkDistribution(apiKey, args, {
      signal: ctx.abortSignal,
    });

    const items: AgentFrameworkUsage[] = envelope.items;
    const budget = enforceListBudget(items, 0, JSON.stringify);
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
