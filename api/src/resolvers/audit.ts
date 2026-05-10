/**
 * Audit trail resolver — thin GraphQL adapter over @recondo/data.
 *
 * SQL bodies live in `packages/recondo-data/src/audit.ts`. The data
 * layer returns `integrityStatus` as a plain string; this file binds
 * it to the GraphQL `IntegrityStatus` enum for the schema contract.
 */

import { listAuditEvents } from "@recondo/data";
import { IntegrityStatus } from "../generated/graphql.js";
import type { QueryResolvers } from "../generated/graphql.js";

const STATUS_TO_ENUM: Record<string, IntegrityStatus> = {
  verified: IntegrityStatus.Verified,
  partial: IntegrityStatus.Partial,
  retry: IntegrityStatus.Retry,
  failed: IntegrityStatus.Failed,
};

const auditTrailResolver: NonNullable<QueryResolvers["auditTrail"]> = async (
  _parent,
  args,
  ctx,
) => {
  const env = await listAuditEvents(
    ctx.apiKey,
    {
      search: args.search ?? undefined,
      type: (args.type as string | null | undefined) ?? undefined,
      period: (args.period as string | null | undefined) ?? undefined,
      from: (args.from as string | null | undefined) ?? undefined,
      to: (args.to as string | null | undefined) ?? undefined,
    },
    { limit: args.limit ?? 50, offset: args.offset ?? 0 },
  );
  return {
    items: env.items.map((e) => ({
      ...e,
      integrityStatus: STATUS_TO_ENUM[e.integrityStatus] ?? IntegrityStatus.Partial,
    })),
    total: env.total,
    limit: env.limit,
    offset: env.offset,
  };
};

export const auditResolvers = {
  Query: {
    auditTrail: auditTrailResolver,
  },
};
