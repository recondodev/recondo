/**
 * `recondo_list_sessions` — canonical read tool.
 *
 * Lists recently captured agent sessions, optionally narrowed by
 * framework / provider / model / status / project. Returns the
 * canonical 5-key envelope (`items`, `next_offset`, `truncated`,
 * `stream_id`, `is_final`) plus an optional `total` carried over
 * from the data layer.
 *
 * Implementation notes:
 *
 *   - The Zod input shape is exported BOTH as the raw shape (handed
 *     to the SDK's `registerTool`) and as a pre-wrapped
 *     `z.object(shape)` so unit tests can call `.parse(input)`
 *     without booting the SDK.
 *   - `listSessions(apiKey, filter, options)` already returns the
 *     5-key envelope; we re-run the items through `enforceListBudget`
 *     so the 32 KB response budget wins over the data-layer page
 *     size when a single page would blow past it.
 *   - The dev-bypass auth context maps onto the data layer's
 *     `ApiKeyInfo` shape (id / projectId / rateLimitRpm). Project
 *     scoping is handled by the data layer when `projectId !== null`.
 *   - `ctx.abortSignal` is threaded into `listSessions(..., { signal })`.
 */

import { listSessions } from "@recondo/data";
import type { ApiKeyInfo, SessionFilter } from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).optional(),
  since: z.string().optional(),
  framework: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(["ACTIVE", "COMPLETED"]).optional(),
  project_id: z.string().optional(),
};

export const listSessionsInputSchema = z.object(inputShape);
export type ListSessionsInput = z.infer<typeof listSessionsInputSchema>;

const DESCRIPTION =
  "List recently captured agent sessions, with optional filters by framework, " +
  "provider, model, status, and project. Returns a paginated envelope of " +
  "session summaries (id, framework, started_at, total_tokens, etc.). Use " +
  "`offset` for absolute pagination; the response includes `next_offset` and " +
  "`truncated:true` when results were capped by the 32 KB response budget.";

/**
 * Map the recondo-mcp `AuthContext` onto the data layer's `ApiKeyInfo`
 * shape. Project scoping (projectId !== null) is forwarded so the
 * data-layer SQL applies the correct `s.project_id = $...` clause.
 */
function authContextToApiKey(auth: AuthContext): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: auth.projectId,
    rateLimitRpm: 0,
  };
}

export const listSessionsTool: ReadTool<ListSessionsInput, unknown> = {
  name: "recondo_list_sessions",
  description: DESCRIPTION,
  inputShape,
  inputSchema: listSessionsInputSchema,
  handler: async (input, ctx) => {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 20;

    const filter: SessionFilter = {};
    if (input.framework !== undefined) filter.framework = input.framework;
    if (input.provider !== undefined) filter.provider = input.provider;
    if (input.model !== undefined) filter.model = input.model;
    if (input.status !== undefined) filter.status = input.status;
    if (input.project_id !== undefined) filter.projectId = input.project_id;

    const apiKey = authContextToApiKey(ctx.auth);

    // Note: `since` is reserved (Plan B parity) but the data-layer
    // signature does not yet plumb a since-cursor for sessions, so
    // we accept and ignore it for forward compatibility.
    const envelope = await listSessions(apiKey, filter, {
      limit,
      offset,
      signal: ctx.abortSignal,
    });

    const budget = enforceListBudget(envelope.items, offset, JSON.stringify);

    if (!budget.truncated) {
      // Pass through the data-layer envelope verbatim — preserves
      // `total` and any other forward-compatible keys.
      return envelope;
    }

    // Byte budget kicked in: rebuild the envelope with the truncated
    // item slice and the byte-truncation `next_offset`. We still
    // forward `total` for parity with the non-truncated path.
    return {
      ...buildListEnvelope({
        items: budget.items,
        nextOffset: budget.nextOffset,
        truncated: true,
      }),
      total: envelope.total,
    };
  },
};
