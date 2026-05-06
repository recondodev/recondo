/**
 * Session resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies live in `packages/recondo-data/src/sessions.ts`. This file
 * is responsible for:
 *   - mapping GraphQL args to @recondo/data filter shape
 *   - converting `DataValidationError` to `GraphQLError` with stable
 *     `extensions.code`
 *   - re-shaping the streaming-prep `ListEnvelope` into the GraphQL
 *     SessionConnection shape (items/total/limit/offset)
 *   - hosting per-request DataLoader resolvers (Session.turns, .title,
 *     UserTurn.turns)
 */

import { GraphQLError } from "graphql";
import { DataValidationError, listSessions, getSession, listUserTurns } from "@recondo/data";
import type { QueryResolvers, SessionResolvers, UserTurnResolvers } from "../generated/graphql.js";

function toGraphQL(err: unknown): never {
  if (err instanceof DataValidationError) {
    throw new GraphQLError(err.message, { extensions: { code: err.code } });
  }
  throw err;
}

const sessionsResolver: NonNullable<QueryResolvers["sessions"]> = async (_p, args, ctx) => {
  const limit = args.limit ?? 100;
  const offset = args.offset ?? 0;
  try {
    const env = await listSessions(
      ctx.apiKey,
      {
        provider: args.filter?.provider ?? undefined,
        model: args.filter?.model ?? undefined,
        projectId: args.filter?.projectId ?? undefined,
        startedAfter: args.filter?.startedAfter ?? undefined,
        startedBefore: args.filter?.startedBefore ?? undefined,
        status: (args.filter?.status as "ACTIVE" | "COMPLETED" | undefined) ?? undefined,
        framework: args.filter?.framework ?? undefined,
        hideNonLlm: args.filter?.hideNonLlm ?? undefined,
        search: args.filter?.search ?? undefined,
      },
      { limit, offset },
    );
    return {
      items: env.items as never,
      total: env.total ?? env.items.length,
      limit,
      offset,
    };
  } catch (err) {
    toGraphQL(err);
  }
};

const sessionResolver: NonNullable<QueryResolvers["session"]> = async (_p, args, ctx) => {
  try {
    return (await getSession(ctx.apiKey, args.id)) as never;
  } catch (err) {
    toGraphQL(err);
  }
};

// DataLoader-backed nested resolvers (per-request caches stay in api/).
const turnsResolver: NonNullable<SessionResolvers["turns"]> = async (parent, _a, ctx) =>
  ctx.loaders.turnsBySessionId.load(parent.id);

const titleResolver: NonNullable<SessionResolvers["title"]> = async (parent, _a, ctx) =>
  ctx.loaders.titleBySessionId.load(parent.id);

const userTurnsResolver: NonNullable<SessionResolvers["userTurns"]> = async (parent) => {
  try {
    return (await listUserTurns(parent.id)) as never;
  } catch (err) {
    toGraphQL(err);
  }
};

const userTurnChildrenResolver: NonNullable<UserTurnResolvers["turns"]> = async (
  parent,
  _a,
  ctx,
) => {
  const allTurns = await ctx.loaders.turnsBySessionId.load(parent.sessionId);
  const wanted = new Set(parent.turnIds);
  return allTurns.filter((t) => wanted.has(t.id));
};

export const sessionResolvers = {
  Query: {
    sessions: sessionsResolver,
    session: sessionResolver,
  },
  Session: {
    turns: turnsResolver,
    title: titleResolver,
    userTurns: userTurnsResolver,
  },
  UserTurn: {
    turns: userTurnChildrenResolver,
  },
};
