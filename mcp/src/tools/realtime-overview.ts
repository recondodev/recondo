/**
 * `recondo_realtime_overview` — composite real-time snapshot.
 *
 * Returns a single record `{ stats, gateway_status }` composed from
 * TWO data-layer calls executed in PARALLEL via `Promise.all`:
 *
 *   - `getRealtimeStats(apiKey, options)` → `RealtimeStatsRow`
 *   - `getGatewayStatus(apiKey, options)` → `GatewayStatusRow`
 *
 * Plan D §D-C6-1 pins parallelism so the response surfaces both
 * snapshots in a single round-trip; sequential awaits would double
 * the wall-clock latency on a hot path the dashboard polls. The unit
 * test enforces parallelism by asserting the second call begins
 * BEFORE the first promise resolves.
 *
 * Subject to the 32 KB single-record budget — both snapshots are
 * tiny, but the budget enforcement keeps the contract uniform across
 * single-record tools.
 *
 * `ctx.abortSignal` is threaded into BOTH options bags so a client
 * cancellation aborts both queries.
 */

import { getRealtimeStats, getGatewayStatus } from "@recondo/data";
import type { ApiKeyInfo } from "@recondo/data";
import { z } from "zod";

import { enforceSingleRecordBudget } from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  project_id: z.string().optional(),
};

export const realtimeOverviewInputSchema = z.object(inputShape);
export type RealtimeOverviewInput = z.infer<typeof realtimeOverviewInputSchema>;

const DESCRIPTION =
  "Real-time overview snapshot composing two data-layer calls in " +
  "parallel: `getRealtimeStats` (requests/turns per minute, active " +
  "sessions, hourly token + cost rollups, latency p50/p99) and " +
  "`getGatewayStatus` (live/offline/unknown + uptime + last heartbeat). " +
  "Returns a single record `{ stats, gateway_status }`. Optional " +
  "`project_id` scopes both queries to a single project.";

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

export const realtimeOverviewTool: ReadTool<RealtimeOverviewInput, unknown> = {
  name: "recondo_realtime_overview",
  description: DESCRIPTION,
  inputShape,
  inputSchema: realtimeOverviewInputSchema,
  handler: async (input, ctx) => {
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);
    const [stats, gatewayStatus] = await Promise.all([
      getRealtimeStats(apiKey, { signal: ctx.abortSignal }),
      getGatewayStatus(apiKey, { signal: ctx.abortSignal }),
    ]);
    const record = { stats, gateway_status: gatewayStatus };
    return enforceSingleRecordBudget(record, JSON.stringify);
  },
};
