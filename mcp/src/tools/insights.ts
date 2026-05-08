/**
 * `recondo_insights` — ranked operational findings with next-call hints.
 */

import { getInsights } from "@recondo/data";
import type { ApiKeyInfo, InsightsArgs } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  project_id: z.string().optional(),
  since: z.string().datetime().optional(),
};

export const insightsInputSchema = z.object(inputShape).strict();
export type InsightsInput = z.infer<typeof insightsInputSchema>;

const DESCRIPTION =
  "Return the top operational insights for the current project, ranked " +
  "by severity. Each insight includes `kind`, `severity`, a short " +
  "message, supporting `evidence`, and a `suggested_next_call` object " +
  "pointing to the MCP tool that can investigate the finding.";

function authContextToApiKey(auth: AuthContext): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: auth.projectId,
    rateLimitRpm: 0,
  };
}

export const insightsTool: ReadTool<InsightsInput, unknown> = {
  name: "recondo_insights",
  description: DESCRIPTION,
  inputShape,
  inputSchema: insightsInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth);
    const args: InsightsArgs = {};
    if (input.project_id) args.projectId = input.project_id;
    if (input.since) args.since = input.since;
    return getInsights(apiKey, args, { signal: ctx.abortSignal });
  },
};
