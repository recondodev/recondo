/**
 * `recondo_reports` — paginated compliance-report list.
 *
 * Wraps the data-layer helper `listReports(apiKey, filter, options)`
 * (the `filter` slot is currently a placeholder — the data layer
 * scopes by `apiKey.projectId` only). Returns the canonical 5-key
 * list envelope of `ReportRow` (id / name / framework / period /
 * captureCount / findings / hash / status / generatedAt) plus
 * `total / limit / offset` paging metadata.
 *
 * `ctx.abortSignal` is threaded into `options.signal`.
 */

import { listReports } from "@recondo/data";
import type {
  ApiKeyInfo,
  ListEnvelope,
  ReportRow,
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

export const reportsInputSchema = z.object(inputShape);
export type ReportsInput = z.infer<typeof reportsInputSchema>;

const DESCRIPTION =
  "Paginated compliance-report list. Each row carries id, name, " +
  "framework, periodStart / periodEnd, captureCount, findings " +
  "(critical / high / medium / low), hash, status, and generatedAt. " +
  "Scoped by project via `project_id` (overrides the auth context " +
  "default). Returns the canonical 5-key list envelope plus " +
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

type ReportsEnvelope = ListEnvelope<ReportRow> & {
  total: number;
  limit: number;
  offset: number;
};

export const reportsTool: ReadTool<ReportsInput, unknown> = {
  name: "recondo_reports",
  description: DESCRIPTION,
  inputShape,
  inputSchema: reportsInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);

    const listOptions: {
      signal?: AbortSignal;
      limit?: number;
      offset?: number;
    } = { signal: ctx.abortSignal };
    if (input.limit !== undefined) listOptions.limit = input.limit;
    if (input.offset !== undefined) listOptions.offset = input.offset;

    const envelope: ReportsEnvelope = await listReports(
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
