/**
 * `recondo_delete_key` — DESTRUCTIVE action tool that revokes (deletes)
 * a managed LLM provider key.
 *
 * Wraps the data-layer helper `revokeApiKey(apiKey, id, options)`. The
 * MCP tool surface keeps the LEFT-column historical name
 * (`delete_key`); the data-layer binding is the RIGHT-column name
 * `revokeApiKey`. Operates on the `registered_keys` table (managed LLM
 * provider keys), NOT the gateway auth `api_keys` table.
 *
 * `ctx.abortSignal` is threaded into `options.signal`. Gated behind
 * the `--allow-destructive` CLI flag.
 */

import { revokeApiKey } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ActionTool } from "../registry/types.js";
import { INJECTION_WARNING } from "../registry/warning.js";

const inputShape = {
  key_id: z.string(),
  project_id: z.string().optional(),
};

export const deleteKeyInputSchema = z.object(inputShape);
export type DeleteKeyInput = z.infer<typeof deleteKeyInputSchema>;

const DESCRIPTION =
  "DESTRUCTIVE — permanently revoke a managed LLM provider key from " +
  "the `registered_keys` table. Distinct from the gateway auth " +
  "`api_keys` table. Returns `{ id }` on success, null when the key " +
  "does not exist (or is out of project scope). " +
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

export const deleteKeyTool: ActionTool<DeleteKeyInput, unknown> = {
  name: "recondo_delete_key",
  description: DESCRIPTION,
  inputShape,
  inputSchema: deleteKeyInputSchema,
  destructive: true,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    return revokeApiKey(apiKey, input.key_id, { signal: ctx.abortSignal });
  },
};
