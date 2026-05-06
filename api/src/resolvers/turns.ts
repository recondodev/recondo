/**
 * Turn resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies live in `packages/recondo-data/src/turns.ts`. This file
 * maps GraphQL args to the package surface, materialises the search
 * AsyncIterable, and converts DataValidationError to GraphQLError.
 */

import { GraphQLError } from "graphql";
import {
  DataValidationError,
  getTurn,
  searchTurns,
  verifyIntegrity,
} from "@recondo/data";
import type { QueryResolvers, TurnResolvers } from "../generated/graphql.js";

function toGraphQL(err: unknown): never {
  if (err instanceof DataValidationError) {
    throw new GraphQLError(err.message, { extensions: { code: err.code } });
  }
  throw err;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const turnResolver: NonNullable<QueryResolvers["turn"]> = async (_p, args, ctx) => {
  try {
    return (await getTurn(ctx.apiKey, args.id)) as never;
  } catch (err) { toGraphQL(err); }
};

const searchResolver: NonNullable<QueryResolvers["search"]> = async (_p, args, ctx) => {
  try {
    return (await collect(
      searchTurns(ctx.apiKey, args.query, args.projectId ?? null, { limit: 100 }),
    )) as never;
  } catch (err) { toGraphQL(err); }
};

const verifyIntegrityResolver: NonNullable<QueryResolvers["verifyIntegrity"]> = async (
  _p, args, ctx,
) => {
  try {
    return (await verifyIntegrity(ctx.apiKey, args.sessionId)) as never;
  } catch (err) { toGraphQL(err); }
};

const toolCallsResolver: NonNullable<TurnResolvers["toolCalls"]> = async (p, _a, ctx) =>
  ctx.loaders.toolCallsByTurnId.load(p.id);
const anomaliesResolver: NonNullable<TurnResolvers["anomalies"]> = async (p, _a, ctx) =>
  ctx.loaders.anomaliesByTurnId.load(p.id);
const attachmentsResolver: NonNullable<TurnResolvers["attachments"]> = async (p, _a, ctx) =>
  ctx.loaders.attachmentsByTurnId.load(p.id);
const attachmentCountResolver: NonNullable<TurnResolvers["attachmentCount"]> = async (p, _a, ctx) =>
  (await ctx.loaders.attachmentsByTurnId.load(p.id)).length;

export const turnResolvers = {
  Query: { turn: turnResolver, search: searchResolver, verifyIntegrity: verifyIntegrityResolver },
  Turn: {
    toolCalls: toolCallsResolver,
    anomalies: anomaliesResolver,
    attachments: attachmentsResolver,
    attachmentCount: attachmentCountResolver,
  },
};
