/**
 * Registered keys resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies live in `packages/recondo-data/src/keys.ts`. The package
 * exports use the names listApiKeys / createApiKey / revokeApiKey per the
 * deliverables doc; the GraphQL operation names registeredKeys /
 * registerKey / deleteKey are unchanged so the dashboard schema stays
 * stable.
 */

import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  type ApiKeyRecord,
} from "@recondo/data";
import { KeyStatus } from "../generated/graphql.js";
import type { QueryResolvers, MutationResolvers } from "../generated/graphql.js";

const STATUS_MAP: Record<string, KeyStatus> = {
  active: KeyStatus.Active, inactive: KeyStatus.Inactive,
};

function shapeKey(row: ApiKeyRecord) {
  const status = STATUS_MAP[row.status];
  if (!status) throw new Error(`Unknown key status: '${row.status}'`);
  return { ...row, status };
}

const registeredKeysResolver: NonNullable<QueryResolvers["registeredKeys"]> = async (
  _p, args, ctx,
) => {
  const env = await listApiKeys(
    ctx.apiKey, {},
    { limit: args.limit ?? 50, offset: args.offset ?? 0 },
  );
  return {
    items: env.items.map(shapeKey),
    total: env.total, limit: env.limit, offset: env.offset,
  };
};

const registerKeyMutation: NonNullable<MutationResolvers["registerKey"]> = async (
  _p, args, ctx,
) => {
  const row = await createApiKey(ctx.apiKey, {
    name: args.input.name as string,
    provider: args.input.provider as string,
    fingerprint: args.input.fingerprint as string,
  });
  if (row === null) {
    return {
      key: null,
      errors: [{
        field: "fingerprint",
        code: "DUPLICATE",
        message: `A key with fingerprint '${args.input.fingerprint}' is already registered`,
      }],
    };
  }
  return { key: shapeKey(row), errors: [] };
};

const deleteKeyMutation: NonNullable<MutationResolvers["deleteKey"]> = async (
  _p, args, ctx,
) => {
  const result = await revokeApiKey(ctx.apiKey, args.id);
  if (result === null) {
    return {
      success: false,
      errors: [{
        field: "id",
        code: "NOT_FOUND",
        message: `Key with id '${args.id}' not found`,
      }],
    };
  }
  return { success: true, errors: [] };
};

export const keyResolvers = {
  Query: { registeredKeys: registeredKeysResolver },
  Mutation: {
    registerKey: registerKeyMutation,
    deleteKey: deleteKeyMutation,
  },
};
