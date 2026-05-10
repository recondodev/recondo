/**
 * `recondo_delete_policy` — DESTRUCTIVE action tool that removes a
 * governance policy row.
 *
 * Wraps the data-layer helper `deletePolicy(apiKey, id, options)`.
 * `ctx.abortSignal` is threaded into `options.signal`. Gated behind
 * the `--allow-destructive` CLI flag.
 */

import { deletePolicy } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ActionTool } from "../registry/types.js";
import { INJECTION_WARNING } from "../registry/warning.js";

const inputShape = {
  policy_id: z.string(),
  project_id: z.string().optional(),
};

export const deletePolicyInputSchema = z.object(inputShape);
export type DeletePolicyInput = z.infer<typeof deletePolicyInputSchema>;

const DESCRIPTION =
  "DESTRUCTIVE — permanently delete a governance policy. The row is " +
  "removed from the `policies` table; downstream trigger history is " +
  "preserved in the audit log but the policy will no longer evaluate " +
  "incoming traffic. Returns `{ id }` on success, null when the " +
  "policy does not exist (or is out of project scope). " +
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

export const deletePolicyTool: ActionTool<DeletePolicyInput, unknown> = {
  name: "recondo_delete_policy",
  description: DESCRIPTION,
  inputShape,
  inputSchema: deletePolicyInputSchema,
  destructive: true,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    return deletePolicy(apiKey, input.policy_id, { signal: ctx.abortSignal });
  },
};
