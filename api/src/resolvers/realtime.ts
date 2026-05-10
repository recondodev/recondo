/**
 * Realtime resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies (and the Prometheus latency fallback fetch) live in
 * `packages/recondo-data/src/realtime.ts`. This file is responsible for:
 *   - mapping GraphQL args to the @recondo/data shape
 *   - binding the data layer's raw `latencySource` string to the
 *     GraphQL `RealtimeLatencySource` enum
 *   - materialising the realtime feed AsyncIterable into the array
 *     shape the GraphQL list field expects
 */

import {
  getRealtimeStats,
  listRealtimeFeed,
  getGatewayStatus,
  type RealtimeLatencySourceString,
} from "@recondo/data";
import { RealtimeLatencySource, type QueryResolvers } from "../generated/graphql.js";

const LATENCY_SOURCE_TO_ENUM: Record<RealtimeLatencySourceString, RealtimeLatencySource> = {
  TURN_DURATION_MS: RealtimeLatencySource.TurnDurationMs,
  GATEWAY_CAPTURE_HISTOGRAM: RealtimeLatencySource.GatewayCaptureHistogram,
  NONE: RealtimeLatencySource.None,
};

const realtimeStatsResolver: NonNullable<QueryResolvers["realtimeStats"]> = async (
  _p,
  _a,
  ctx,
) => {
  const stats = await getRealtimeStats(ctx.apiKey);
  return {
    ...stats,
    latencySource: LATENCY_SOURCE_TO_ENUM[stats.latencySource] ?? RealtimeLatencySource.None,
  };
};

const realtimeFeedResolver: NonNullable<QueryResolvers["realtimeFeed"]> = async (
  _p,
  args,
  ctx,
) => {
  const items: unknown[] = [];
  for await (const item of listRealtimeFeed(
    ctx.apiKey,
    { provider: args.provider ?? undefined, since: args.since ?? undefined },
    { limit: args.limit ?? 20 },
  )) {
    items.push(item);
  }
  return items as never;
};

const gatewayStatusResolver: NonNullable<QueryResolvers["gatewayStatus"]> = (
  _p,
  _a,
  ctx,
) => getGatewayStatus(ctx.apiKey);

export const realtimeResolvers = {
  Query: {
    realtimeStats: realtimeStatsResolver,
    realtimeFeed: realtimeFeedResolver,
    gatewayStatus: gatewayStatusResolver,
  },
};
