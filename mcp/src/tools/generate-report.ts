/**
 * `recondo_generate_report` — action tool that produces a persisted
 * report row.
 *
 * Wraps the data-layer helper `generateReport(apiKey, input, options)`.
 * `ctx.abortSignal` is threaded into `options.signal`.
 */

import { generateReport } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ActionTool } from "../registry/types.js";
import { INJECTION_WARNING } from "../registry/warning.js";

const inputShape = {
  type: z.enum(["weekly_cost", "compliance", "anomaly", "custom"]),
  period: z.enum(["week", "month"]),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  params: z.record(z.unknown()).optional(),
  project_id: z.string().optional(),
};

export const generateReportInputSchema = z.object(inputShape).strict();
export type GenerateReportInput = z.infer<typeof generateReportInputSchema>;

const DESCRIPTION =
  "Generate a canonical, persisted report (weekly_cost, compliance, " +
  "anomaly, or custom) for a week or month window. Inserts a new row " +
  "into the `reports` table and returns `{ report, errors }`. " +
  INJECTION_WARNING;

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

export const generateReportTool: ActionTool<GenerateReportInput, unknown> = {
  name: "recondo_generate_report",
  description: DESCRIPTION,
  inputShape,
  inputSchema: generateReportInputSchema,
  destructive: false,
  handler: async (rawInput, ctx) => {
    const input = generateReportInputSchema.parse(rawInput);
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    return generateReport(
      apiKey,
      {
        type: input.type,
        period: input.period,
        from: input.from,
        to: input.to,
        params: input.params,
      },
      { signal: ctx.abortSignal },
    );
  },
};
