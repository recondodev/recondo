/**
 * `recondo_update_policy` — action tool that mutates an existing
 * governance policy row.
 *
 * Wraps the data-layer helper `updatePolicy(apiKey, id, input,
 * options)`. The MCP-facing `policy_id` is the positional `id` argument
 * — it MUST NOT bleed into the `UpdatePolicyInput` shape.
 * `ctx.abortSignal` is threaded into `options.signal`.
 */

import { updatePolicy } from "@recondo/data";
import type { ApiKeyInfo, UpdatePolicyInput } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ActionTool } from "../registry/types.js";
import { INJECTION_WARNING } from "../registry/warning.js";

const inputShape = {
  policy_id: z.string(),
  name: z.string().optional(),
  scope: z.string().optional(),
  action: z.string().optional(),
  status: z.string().optional(),
  project_id: z.string().optional(),
};

export const updatePolicyInputSchema = z.object(inputShape);
export type UpdatePolicyToolInput = z.infer<typeof updatePolicyInputSchema>;

const DESCRIPTION =
  "Update an existing governance policy's mutable fields (name, scope, " +
  "action, status). The policy `type` is immutable — recreate the " +
  "policy to change its type. Returns the updated PolicyRow, or null " +
  "when the policy does not exist (or is out of project scope). " +
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

export const updatePolicyTool: ActionTool<UpdatePolicyToolInput, unknown> = {
  name: "recondo_update_policy",
  description: DESCRIPTION,
  inputShape,
  inputSchema: updatePolicyInputSchema,
  destructive: false,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    const dataInput: UpdatePolicyInput = {};
    if (input.name !== undefined) dataInput.name = input.name;
    if (input.scope !== undefined) dataInput.scope = input.scope;
    if (input.action !== undefined) dataInput.action = input.action;
    if (input.status !== undefined) dataInput.status = input.status;
    return updatePolicy(apiKey, input.policy_id, dataInput, {
      signal: ctx.abortSignal,
    });
  },
};
