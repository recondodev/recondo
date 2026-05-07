/**
 * `recondo_generate_report` — action tool that produces a compliance
 * report row.
 *
 * Wraps the data-layer helper `generateReport(apiKey, input, options)`.
 * Maps the MCP-facing `period_start` / `period_end` snake_case fields
 * onto the data-layer's `periodStart` / `periodEnd` camelCase shape.
 * `ctx.abortSignal` is threaded into `options.signal`.
 */

import { generateReport } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ActionTool } from "../registry/types.js";
import { INJECTION_WARNING } from "../registry/warning.js";

const inputShape = {
  framework: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  project_id: z.string().optional(),
};

export const generateReportInputSchema = z.object(inputShape);
export type GenerateReportInput = z.infer<typeof generateReportInputSchema>;

const DESCRIPTION =
  "Generate a compliance report (e.g. soc2, iso42001) for a given " +
  "period. Inserts a new row into the `reports` table summarising " +
  "captures + findings for the window. Returns `{ report, errors }`. " +
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
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    return generateReport(
      apiKey,
      {
        framework: input.framework,
        periodStart: input.period_start,
        periodEnd: input.period_end,
      },
      { signal: ctx.abortSignal },
    );
  },
};
