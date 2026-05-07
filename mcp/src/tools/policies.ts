/**
 * `recondo_policies` — paginated policy list with optional include flags.
 *
 * Wraps the data-layer helper `listPolicies(apiKey, filter, options)`,
 * scoped by `apiKey.projectId`. Returns the canonical 5-key list
 * envelope of `PolicyRow` (id / name / type / scope / action /
 * triggersMtd / status) plus `total / limit / offset` paging metadata.
 *
 * Optional `include` flags:
 *   - "trigger_history" : merges `triggerHistory` (the
 *     `listPolicyTriggerHistory` envelope, one call per policy) onto
 *     each row.
 *   - "effective_scope" : derives `effectiveScope` from the row's
 *     `scope` string (v1 mirrors `scope` verbatim; future revisions may
 *     fold project_id / inheritance into the derivation).
 *
 * `ctx.abortSignal` is threaded into every data-layer call.
 */

import { listPolicies, listPolicyTriggerHistory } from "@recondo/data";
import type {
  ApiKeyInfo,
  ListEnvelope,
  PolicyRow,
  PolicyTrendPoint,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  include: z
    .array(z.enum(["trigger_history", "effective_scope"]))
    .optional(),
  policy_id: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
};

export const policiesInputSchema = z.object(inputShape);
export type PoliciesInput = z.infer<typeof policiesInputSchema>;

const DESCRIPTION =
  "Paginated policy list. Each row carries id, name, type " +
  "(BLOCK / LIMIT / ALERT / MONITOR), scope, action, triggersMtd, and " +
  "status. Scoped by project via `project_id` (overrides the auth " +
  "context default). Optional `include` flags merge `triggerHistory` " +
  "(per-policy trend points) and/or `effectiveScope` onto each row. " +
  "Returns the canonical 5-key list envelope plus total / limit / " +
  "offset paging metadata; pages are clamped to the 32 KB response " +
  "budget.";

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

type PoliciesEnvelope = ListEnvelope<PolicyRow> & {
  total: number;
  limit: number;
  offset: number;
};

type EnrichedPolicy = PolicyRow & {
  triggerHistory?: ListEnvelope<PolicyTrendPoint>;
  effectiveScope?: string;
};

export const policiesTool: ReadTool<PoliciesInput, unknown> = {
  name: "recondo_policies",
  description: DESCRIPTION,
  inputShape,
  inputSchema: policiesInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);

    const listOptions: {
      signal?: AbortSignal;
      limit?: number;
      offset?: number;
    } = { signal: ctx.abortSignal };
    if (input.limit !== undefined) listOptions.limit = input.limit;
    if (input.offset !== undefined) listOptions.offset = input.offset;

    const envelope: PoliciesEnvelope = await listPolicies(
      apiKey,
      {},
      listOptions,
    );

    const include = input.include ?? [];
    const wantTriggerHistory = include.includes("trigger_history");
    const wantEffectiveScope = include.includes("effective_scope");

    let items: EnrichedPolicy[] = envelope.items as EnrichedPolicy[];

    if (wantTriggerHistory || wantEffectiveScope) {
      const enriched: EnrichedPolicy[] = [];
      for (const row of envelope.items) {
        const next: EnrichedPolicy = { ...row };
        if (wantTriggerHistory) {
          next.triggerHistory = await listPolicyTriggerHistory(
            apiKey,
            {},
            { signal: ctx.abortSignal },
          );
        }
        if (wantEffectiveScope) {
          next.effectiveScope = row.scope;
        }
        enriched.push(next);
      }
      items = enriched;
    }

    const offset = envelope.offset;
    const budget = enforceListBudget(items, offset, JSON.stringify);
    if (!budget.truncated) {
      return {
        ...envelope,
        items,
      };
    }
    return buildListEnvelope({
      items: budget.items,
      nextOffset: budget.nextOffset,
      truncated: true,
    });
  },
};
