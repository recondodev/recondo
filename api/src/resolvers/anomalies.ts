/**
 * Anomaly resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies live in `packages/recondo-data/src/anomalies.ts`. This file:
 *   - shuffles GraphQL args into the @recondo/data filter shape
 *   - exposes the `Query.anomalies` resolver and the `AnomalyEvent`
 *     nested DataLoader resolvers (per-request caches stay in api/)
 */

import { listAnomalies } from "@recondo/data";
import type { QueryResolvers, AnomalyEventResolvers } from "../generated/graphql.js";

const anomaliesResolver: NonNullable<QueryResolvers["anomalies"]> = async (
  _parent,
  args,
  ctx,
) => {
  const env = await listAnomalies(
    ctx.apiKey,
    {
      severity: args.filter?.severity ?? undefined,
      sessionId: args.filter?.sessionId ?? undefined,
      anomalyType: args.filter?.anomalyType ?? undefined,
      since: args.filter?.since ?? undefined,
    },
    { limit: args.limit ?? 100, offset: args.offset ?? 0 },
  );
  return env.items as never;
};

const turnResolver: NonNullable<AnomalyEventResolvers["turn"]> = async (parent, _a, ctx) => {
  if (!parent.turnId) return null;
  return ctx.loaders.turnById.load(parent.turnId);
};

const sessionResolver: NonNullable<AnomalyEventResolvers["session"]> = async (
  parent,
  _a,
  ctx,
) => {
  if (!parent.sessionId) return null;
  return ctx.loaders.sessionById.load(parent.sessionId);
};

export const anomalyResolvers = {
  Query: {
    anomalies: anomaliesResolver,
  },
  AnomalyEvent: {
    turn: turnResolver,
    session: sessionResolver,
  },
};
