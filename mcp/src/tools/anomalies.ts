/**
 * `recondo_anomalies` — paginated anomaly feed (rate-limit, schema,
 * latency-spike, etc.) sourced from `anomaly_events`.
 *
 * Wraps the data-layer helper `listAnomalies(apiKey, filter, options)`,
 * which returns the canonical 5-key list envelope of `MappedAnomaly`
 * rows. The MCP surface forwards the envelope verbatim when the page
 * fits the 32 KB response budget; an oversize page is collapsed into
 * a `truncated:true` slice via `enforceListBudget`.
 *
 * `ctx.abortSignal` is threaded into `options.signal` so a cancelled
 * caller propagates to the underlying SQL query.
 */

import { listAnomalies } from "@recondo/data";
import type {
  AnomaliesFilter,
  ApiKeyInfo,
  ListEnvelope,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import { enforceListBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  severity: z.string().optional(),
  session_id: z.string().optional(),
  anomaly_type: z.string().optional(),
  since: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
};

export const anomaliesInputSchema = z.object(inputShape);
export type AnomaliesInput = z.infer<typeof anomaliesInputSchema>;

const DESCRIPTION =
  "Paginated anomaly feed sourced from `anomaly_events`. Each row " +
  "carries id, sessionId, turnId, anomalyType, severity, description, " +
  "detectedAt, and metadata. Filter with `severity`, `session_id`, " +
  "`anomaly_type`, and the `since` cursor (opaque or raw ISO 8601). " +
  "Returns the canonical 5-key list envelope; pages are clamped to " +
  "the 32 KB response budget.";

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

export const anomaliesTool: ReadTool<AnomaliesInput, unknown> = {
  name: "recondo_anomalies",
  description: DESCRIPTION,
  inputShape,
  inputSchema: anomaliesInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);

    const filter: AnomaliesFilter = {};
    if (input.severity !== undefined) filter.severity = input.severity;
    if (input.session_id !== undefined) filter.sessionId = input.session_id;
    if (input.anomaly_type !== undefined)
      filter.anomalyType = input.anomaly_type;
    if (input.since !== undefined) filter.since = input.since;

    const listOptions: {
      signal?: AbortSignal;
      limit?: number;
      offset?: number;
    } = { signal: ctx.abortSignal };
    if (input.limit !== undefined) listOptions.limit = input.limit;
    if (input.offset !== undefined) listOptions.offset = input.offset;

    const envelope: ListEnvelope<unknown> = await listAnomalies(
      apiKey,
      filter,
      listOptions,
    );

    const offset = input.offset ?? 0;
    const budget = enforceListBudget(
      envelope.items as unknown[],
      offset,
      JSON.stringify,
    );
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
