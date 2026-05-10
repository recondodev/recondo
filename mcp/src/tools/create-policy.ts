/**
 * `recondo_create_policy` — action tool that inserts a new governance
 * policy row.
 *
 * Wraps the data-layer helper `createPolicy(apiKey, input, options)`.
 * `ctx.abortSignal` is threaded into `options.signal`.
 */

import { createPolicy } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ActionTool } from "../registry/types.js";
import { INJECTION_WARNING } from "../registry/warning.js";

const inputShape = {
  name: z.string(),
  type: z.string(),
  scope: z.string(),
  action: z.string(),
  project_id: z.string().optional(),
};

export const createPolicyInputSchema = z.object(inputShape);
export type CreatePolicyInput = z.infer<typeof createPolicyInputSchema>;

const DESCRIPTION =
  "Create a new governance policy (BLOCK / LIMIT / ALERT / MONITOR). " +
  "Inserts a row into the `policies` table with status=ACTIVE and " +
  "triggers_mtd=0. Returns the new PolicyRow. " +
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

export const createPolicyTool: ActionTool<CreatePolicyInput, unknown> = {
  name: "recondo_create_policy",
  description: DESCRIPTION,
  inputShape,
  inputSchema: createPolicyInputSchema,
  destructive: false,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    return createPolicy(
      apiKey,
      {
        name: input.name,
        type: input.type,
        scope: input.scope,
        action: input.action,
      },
      { signal: ctx.abortSignal },
    );
  },
};
