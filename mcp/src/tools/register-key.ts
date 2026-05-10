/**
 * `recondo_register_key` — action tool that registers a managed LLM
 * provider key.
 *
 * Wraps the data-layer helper `createApiKey(apiKey, input, options)`.
 * The MCP tool surface keeps the LEFT-column historical name
 * (`register_key`); the data-layer binding is the RIGHT-column name
 * `createApiKey`. Operates on the `registered_keys` table (managed LLM
 * provider keys), NOT the gateway auth `api_keys` table.
 *
 * `ctx.abortSignal` is threaded into `options.signal`.
 */

import { createApiKey } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import type { AuthContext } from "../auth/context.js";
import type { ActionTool } from "../registry/types.js";
import { INJECTION_WARNING } from "../registry/warning.js";

const inputShape = {
  name: z.string(),
  provider: z.string(),
  fingerprint: z.string(),
  project_id: z.string().optional(),
};

export const registerKeyInputSchema = z.object(inputShape);
export type RegisterKeyInput = z.infer<typeof registerKeyInputSchema>;

const DESCRIPTION =
  "Register a new managed LLM provider key (the `registered_keys` " +
  "table — Anthropic, OpenAI, Gemini, etc.). Distinct from the " +
  "gateway auth `api_keys` table. Returns the new ApiKeyRecord, or " +
  "null on UNIQUE-fingerprint conflict. " +
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

export const registerKeyTool: ActionTool<RegisterKeyInput, unknown> = {
  name: "recondo_register_key",
  description: DESCRIPTION,
  inputShape,
  inputSchema: registerKeyInputSchema,
  destructive: false,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    return createApiKey(
      apiKey,
      {
        name: input.name,
        provider: input.provider,
        fingerprint: input.fingerprint,
      },
      { signal: ctx.abortSignal },
    );
  },
};
