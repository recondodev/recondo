/**
 * `recondo_audit_trail` — paginated audit-event feed derived from the
 * captured `turns` table joined to `sessions`.
 *
 * Wraps the data-layer helper `listAuditEvents(apiKey, filter, options)`,
 * which returns the canonical 5-key list envelope augmented with
 * `total / limit / offset` paging metadata. The MCP surface forwards
 * the envelope verbatim when the page fits the 32 KB response budget,
 * and re-runs the items through `enforceListBudget` to collapse
 * oversize pages into a `truncated:true` slice.
 *
 * `ctx.abortSignal` is threaded into `options.signal` so a cancelled
 * caller propagates through to the underlying SQL query.
 */

import { listAuditEvents } from "@recondo/data";
import type {
  ApiKeyInfo,
  AuditEntry,
  AuditEventsFilter,
  ListEnvelope,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  since: z.string().optional(),
  search: z.string().optional(),
  type: z.string().optional(),
  period: z.enum(["day", "week", "month", "quarter"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
};

export const auditTrailInputSchema = z.object(inputShape);
export type AuditTrailInput = z.infer<typeof auditTrailInputSchema>;

const DESCRIPTION =
  "Paginated audit-event feed derived from the captured `turns` table " +
  "joined to `sessions`. Each row carries timestamp, sessionId, " +
  "sequenceNum, provider, model, request/response hash, totalTokens, " +
  "integrityStatus, httpStatus, and captureComplete. Filter with " +
  "`search` (substring), `type` (ALL | REQUESTS | RESPONSES | " +
  "ANOMALIES), `period`, `from` / `to`, and the `since` cursor. " +
  "Returns the canonical 5-key list envelope plus total/limit/offset.";

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

type AuditEnvelope = ListEnvelope<AuditEntry> & {
  total: number;
  limit: number;
  offset: number;
};

export const auditTrailTool: ReadTool<AuditTrailInput, unknown> = {
  name: "recondo_audit_trail",
  description: DESCRIPTION,
  inputShape,
  inputSchema: auditTrailInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);

    const filter: AuditEventsFilter = {};
    if (input.since !== undefined) filter.since = input.since;
    if (input.search !== undefined) filter.search = input.search;
    if (input.type !== undefined) filter.type = input.type;
    if (input.period !== undefined) filter.period = input.period;
    if (input.from !== undefined) filter.from = input.from;
    if (input.to !== undefined) filter.to = input.to;

    const listOptions: {
      signal?: AbortSignal;
      limit?: number;
      offset?: number;
    } = { signal: ctx.abortSignal };
    if (input.limit !== undefined) listOptions.limit = input.limit;
    if (input.offset !== undefined) listOptions.offset = input.offset;

    const envelope: AuditEnvelope = await listAuditEvents(
      apiKey,
      filter,
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
