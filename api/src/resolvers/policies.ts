/**
 * Policies resolvers — thin GraphQL adapters over @recondo/data.
 * SQL bodies live in `packages/recondo-data/src/policies.ts`; this file
 * binds raw enum strings to GraphQL enums and re-shapes payloads
 * ({policy,errors}/{success,errors} for mutations, bare lists for trends).
 */

import {
  listPolicies,
  listPolicyTriggerHistory,
  createPolicy,
  updatePolicy,
  deletePolicy,
  type PolicyRow,
} from "@recondo/data";
import { PolicyStatus, PolicyType } from "../generated/graphql.js";
import type { QueryResolvers, MutationResolvers } from "../generated/graphql.js";

const TYPE_MAP: Record<string, PolicyType> = {
  BLOCK: PolicyType.Block, LIMIT: PolicyType.Limit,
  ALERT: PolicyType.Alert, MONITOR: PolicyType.Monitor,
};
const STATUS_MAP: Record<string, PolicyStatus> = {
  ACTIVE: PolicyStatus.Active, INACTIVE: PolicyStatus.Inactive,
};

function shapePolicy(row: PolicyRow) {
  const type = TYPE_MAP[row.type];
  const status = STATUS_MAP[row.status];
  if (!type) throw new Error(`Unknown policy type: '${row.type}'`);
  if (!status) throw new Error(`Unknown policy status: '${row.status}'`);
  return { ...row, type, status };
}

const notFound = (id: string) => ({
  field: "id", code: "NOT_FOUND", message: `Policy with id '${id}' not found`,
});

const policiesResolver: NonNullable<QueryResolvers["policies"]> = async (_p, args, ctx) => {
  const env = await listPolicies(
    ctx.apiKey, {},
    { limit: args.limit ?? 50, offset: args.offset ?? 0 },
  );
  return {
    items: env.items.map(shapePolicy),
    total: env.total, limit: env.limit, offset: env.offset,
  };
};

const policyTriggerHistoryResolver: NonNullable<
  QueryResolvers["policyTriggerHistory"]
> = async (_p, args, ctx) =>
  (await listPolicyTriggerHistory(ctx.apiKey, { days: args.days ?? 30 })).items;

const createPolicyMutation: NonNullable<MutationResolvers["createPolicy"]> = async (
  _p, args, ctx,
) => {
  const row = await createPolicy(ctx.apiKey, {
    name: args.input.name as string,
    type: args.input.type as string,
    scope: args.input.scope as string,
    action: args.input.action as string,
  });
  return { policy: shapePolicy(row), errors: [] };
};

const updatePolicyMutation: NonNullable<MutationResolvers["updatePolicy"]> = async (
  _p, args, ctx,
) => {
  const row = await updatePolicy(ctx.apiKey, args.id, {
    name: args.input.name as string | undefined,
    scope: args.input.scope as string | undefined,
    action: args.input.action as string | undefined,
    status: args.input.status as string | undefined,
  });
  if (row === null) return { policy: null, errors: [notFound(args.id)] };
  return { policy: shapePolicy(row), errors: [] };
};

const deletePolicyMutation: NonNullable<MutationResolvers["deletePolicy"]> = async (
  _p, args, ctx,
) => {
  const result = await deletePolicy(ctx.apiKey, args.id);
  if (result === null) return { success: false, errors: [notFound(args.id)] };
  return { success: true, errors: [] };
};

export const policyResolvers = {
  Query: {
    policies: policiesResolver,
    policyTriggerHistory: policyTriggerHistoryResolver,
  },
  Mutation: {
    createPolicy: createPolicyMutation,
    updatePolicy: updatePolicyMutation,
    deletePolicy: deletePolicyMutation,
  },
};
