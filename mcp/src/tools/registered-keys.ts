/**
 * `recondo_registered_keys` — paginated managed-LLM-provider key list.
 *
 * Reads the `registered_keys` table (the registry of managed LLM
 * provider keys — Anthropic, OpenAI, Gemini, etc.) via the data-layer
 * helper `listApiKeys(apiKey, filter, options)`. NOT the gateway
 * `api_keys` table (auth tokens). The two tables are intentionally
 * distinct (see packages/recondo-data/src/keys.ts).
 *
 * Returns the canonical 5-key list envelope of `ApiKeyRecord` (id /
 * name / provider / fingerprint / agentCount / lastUsed /
 * monthlyCostUsd / status) plus total / limit / offset paging
 * metadata.
 *
 * `ctx.abortSignal` is threaded into `options.signal`.
 */

import { listApiKeys } from "@recondo/data";
import type {
  ApiKeyInfo,
  ApiKeyRecord,
  ListEnvelope,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  project_id: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
};

export const registeredKeysInputSchema = z.object(inputShape);
export type RegisteredKeysInput = z.infer<typeof registeredKeysInputSchema>;

const DESCRIPTION =
  "Paginated list of managed LLM provider keys (the `registered_keys` " +
  "table — Anthropic, OpenAI, Gemini, etc.). Distinct from the " +
  "gateway auth `api_keys` table. Each row carries id, name, " +
  "provider, fingerprint, agentCount, lastUsed, monthlyCostUsd, and " +
  "status. Scoped by project via `project_id` (overrides the auth " +
  "context default). Returns the canonical 5-key list envelope plus " +
  "total / limit / offset paging metadata; pages are clamped to the " +
  "32 KB response budget.";

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

type RegisteredKeysEnvelope = ListEnvelope<ApiKeyRecord> & {
  total: number;
  limit: number;
  offset: number;
};

export const registeredKeysTool: ReadTool<RegisteredKeysInput, unknown> = {
  name: "recondo_registered_keys",
  description: DESCRIPTION,
  inputShape,
  inputSchema: registeredKeysInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);

    const listOptions: {
      signal?: AbortSignal;
      limit?: number;
      offset?: number;
    } = { signal: ctx.abortSignal };
    if (input.limit !== undefined) listOptions.limit = input.limit;
    if (input.offset !== undefined) listOptions.offset = input.offset;

    const envelope: RegisteredKeysEnvelope = await listApiKeys(
      apiKey,
      {},
      listOptions,
    );

    const offset = envelope.offset;
    const budget = enforceListBudget(envelope.items, offset, JSON.stringify);
    if (!budget.truncated) {
      return envelope;
    }
    return buildListEnvelope({
      items: budget.items,
      nextOffset: budget.nextOffset,
      truncated: true,
    });
  },
};
