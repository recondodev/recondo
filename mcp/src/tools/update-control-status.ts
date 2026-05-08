/**
 * `recondo_update_control_status` — action tool that transitions a
 * compliance control's status (compliant / non_compliant / in_review).
 *
 * Wraps the data-layer helper `updateControlStatus(apiKey, input,
 * options)`. Maps the MCP-facing `control_id` / `new_status` fields
 * onto the data-layer's `controlId` / `status` shape. `ctx.abortSignal`
 * is threaded into `options.signal`.
 */

import { updateControlStatus } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ActionTool } from "../registry/types.js";
import { INJECTION_WARNING } from "../registry/warning.js";

const inputShape = {
  control_id: z.string(),
  new_status: z.enum(["compliant", "non_compliant", "in_review"]),
  reason: z.string().optional(),
  project_id: z.string().optional(),
};

export const updateControlStatusInputSchema = z.object(inputShape);
export type UpdateControlStatusInput = z.infer<
  typeof updateControlStatusInputSchema
>;

const DESCRIPTION =
  "Transition a compliance control (e.g. CC1.1) to compliant, " +
  "non_compliant, or in_review with a human-readable reason. Records " +
  "an entry in the compliance audit log. Returns `{ control, errors }`. " +
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

export const updateControlStatusTool: ActionTool<
  UpdateControlStatusInput,
  unknown
> = {
  name: "recondo_update_control_status",
  description: DESCRIPTION,
  inputShape,
  inputSchema: updateControlStatusInputSchema,
  destructive: false,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    return updateControlStatus(
      apiKey,
      {
        controlId: input.control_id,
        status: input.new_status,
        reason: input.reason ?? "",
      },
      { signal: ctx.abortSignal },
    );
  },
};
