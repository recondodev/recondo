/**
 * Agent analytics resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies live in `packages/recondo-data/src/agents.ts`. This file
 * is responsible for:
 *   - mapping GraphQL args (period, from, to, limit, offset) to the
 *     @recondo/data shape
 *   - re-shaping the framework-distribution envelope into a bare list
 *   - re-shaping the developer/repository envelopes into the GraphQL
 *     connection shape (items/total/limit/offset)
 */

import {
  getAgentSummary,
  listAgentFrameworkDistribution,
  listTopDevelopers,
  listTopRepositories,
} from "@recondo/data";
import type { QueryResolvers } from "../generated/graphql.js";

const agentSummaryResolver: NonNullable<QueryResolvers["agentSummary"]> = (_p, args, ctx) =>
  getAgentSummary(ctx.apiKey, {
    period: (args.period as string | null | undefined) ?? undefined,
    from: (args.from as string | null | undefined) ?? undefined,
    to: (args.to as string | null | undefined) ?? undefined,
  });

const agentFrameworkDistributionResolver: NonNullable<
  QueryResolvers["agentFrameworkDistribution"]
> = async (_p, args, ctx) => {
  const env = await listAgentFrameworkDistribution(ctx.apiKey, {
    period: (args.period as string | null | undefined) ?? undefined,
    from: (args.from as string | null | undefined) ?? undefined,
    to: (args.to as string | null | undefined) ?? undefined,
  });
  return env.items;
};

const topDevelopersResolver: NonNullable<QueryResolvers["topDevelopers"]> = async (
  _p,
  args,
  ctx,
) => {
  const env = await listTopDevelopers(
    ctx.apiKey,
    { period: (args.period as string | null | undefined) ?? undefined },
    { limit: args.limit ?? 20, offset: args.offset ?? 0 },
  );
  return { items: env.items, total: env.total, limit: env.limit, offset: env.offset };
};

const topRepositoriesResolver: NonNullable<QueryResolvers["topRepositories"]> = async (
  _p,
  args,
  ctx,
) => {
  const env = await listTopRepositories(
    ctx.apiKey,
    { period: (args.period as string | null | undefined) ?? undefined },
    { limit: args.limit ?? 20, offset: args.offset ?? 0 },
  );
  return { items: env.items, total: env.total, limit: env.limit, offset: env.offset };
};

export const agentResolvers = {
  Query: {
    agentSummary: agentSummaryResolver,
    agentFrameworkDistribution: agentFrameworkDistributionResolver,
    topDevelopers: topDevelopersResolver,
    topRepositories: topRepositoriesResolver,
  },
};
