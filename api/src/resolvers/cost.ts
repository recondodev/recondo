/**
 * Cost intelligence resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies + period math live in `packages/recondo-data/src/cost.ts`.
 * This file maps GraphQL args (period, from, to) and returns the bare
 * arrays/objects the GraphQL schema expects.
 */

import {
  getUsageSummary,
  listSpendByProvider,
  listSpendByModel,
  listSpendByFramework,
  listDailySpend,
  getCostProjections,
} from "@recondo/data";
import type { QueryResolvers } from "../generated/graphql.js";

const usageSummaryResolver: NonNullable<QueryResolvers["usageSummary"]> = async (
  _p,
  args,
  ctx,
) =>
  getUsageSummary(ctx.apiKey, {
    period: args.period as string | undefined,
    from: args.from as string | undefined,
    to: args.to as string | undefined,
  });

const spendByProviderResolver: NonNullable<QueryResolvers["spendByProvider"]> = async (
  _p,
  args,
  ctx,
) => {
  const env = await listSpendByProvider(ctx.apiKey, {
    period: args.period as string | undefined,
    from: args.from as string | undefined,
    to: args.to as string | undefined,
  });
  return env.items as never;
};

const spendByModelResolver: NonNullable<QueryResolvers["spendByModel"]> = async (
  _p,
  args,
  ctx,
) => {
  const env = await listSpendByModel(ctx.apiKey, {
    period: args.period as string | undefined,
    from: args.from as string | undefined,
    to: args.to as string | undefined,
  });
  return env.items as never;
};

const spendByFrameworkResolver: NonNullable<QueryResolvers["spendByFramework"]> = async (
  _p,
  args,
  ctx,
) => {
  const env = await listSpendByFramework(ctx.apiKey, {
    period: args.period as string | undefined,
    from: args.from as string | undefined,
    to: args.to as string | undefined,
  });
  return env.items as never;
};

const dailySpendResolver: NonNullable<QueryResolvers["dailySpend"]> = async (_p, args, ctx) => {
  const env = await listDailySpend(ctx.apiKey, { days: args.days ?? undefined });
  return env.items as never;
};

const costProjectionsResolver: NonNullable<QueryResolvers["costProjections"]> = async (
  _p,
  _args,
  ctx,
) => getCostProjections(ctx.apiKey) as never;

export const costResolvers = {
  Query: {
    usageSummary: usageSummaryResolver,
    spendByProvider: spendByProviderResolver,
    spendByModel: spendByModelResolver,
    spendByFramework: spendByFrameworkResolver,
    dailySpend: dailySpendResolver,
    costProjections: costProjectionsResolver,
  },
};
