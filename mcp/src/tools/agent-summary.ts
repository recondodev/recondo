/**
 * `recondo_agent_summary` — structured agent analytics summary.
 *
 * Wraps the data-layer `getAgentSummary(apiKey, args, options)` and
 * returns the structured `AgentSummaryRow` record verbatim (single
 * record — NO list envelope wrapping). Subject to the 32 KB
 * single-record budget; oversized records surface a
 * `response_too_large` envelope.
 *
 * Period translation: the MCP surface exposes day/week/month/quarter
 * and translates to the data-layer `DAY_<n>` tokens at the boundary
 * via `toDataLayerPeriod`. When `period` is omitted the data layer
 * applies its own default window.
 *
 * `ctx.abortSignal` is threaded into the data-layer options.
 */

import { getAgentSummary } from "@recondo/data";
import type { AgentQueryArgs, ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import { enforceSingleRecordBudget } from "../envelope/truncate.js";
import { toDataLayerPeriod, type McpPeriod } from "../period.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  period: z.enum(["day", "week", "month", "quarter"]).optional(),
  project_id: z.string().optional(),
};

export const agentSummaryInputSchema = z.object(inputShape);
export type AgentSummaryInput = z.infer<typeof agentSummaryInputSchema>;

const DESCRIPTION =
  "Structured agent analytics summary across the selected period. " +
  "Returns a single record with `activeAgents`, `frameworkCount`, " +
  "`totalSessions`, `sessionsDelta` (% vs prior window), " +
  "`averageTurnsPerSession`, `medianTurnsPerSession`, and " +
  "`uniqueDevelopers`. `period` is the human-readable enum (day / " +
  "week / month / quarter); when omitted the data layer applies its " +
  "default window. Subject to the 32 KB single-record budget.";

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

export const agentSummaryTool: ReadTool<AgentSummaryInput, unknown> = {
  name: "recondo_agent_summary",
  description: DESCRIPTION,
  inputShape,
  inputSchema: agentSummaryInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    const args: AgentQueryArgs = {};
    const translated = toDataLayerPeriod(input.period as McpPeriod | undefined);
    if (translated !== undefined) args.period = translated;

    const summary = await getAgentSummary(apiKey, args, {
      signal: ctx.abortSignal,
    });
    return enforceSingleRecordBudget(summary, JSON.stringify);
  },
};
