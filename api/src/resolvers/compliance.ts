/**
 * Compliance resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies live in `packages/recondo-data/src/compliance.ts`. The
 * data layer returns raw status strings; this file binds them to the
 * GraphQL `ControlStatus` enum and re-shapes envelopes.
 */

import {
  getComplianceSummary,
  listComplianceFrameworks,
  listComplianceAuditLog,
  updateControlStatus,
} from "@recondo/data";
import { ControlStatus } from "../generated/graphql.js";
import type {
  QueryResolvers,
  MutationResolvers,
} from "../generated/graphql.js";

function mapToControlStatus(status: string): ControlStatus {
  switch (status) {
    case "MET":
      return ControlStatus.Met;
    case "IN_PROGRESS":
      return ControlStatus.InProgress;
    case "NOT_MET":
      return ControlStatus.NotMet;
    case "PLANNED":
      return ControlStatus.Planned;
    default:
      throw new Error(`Unknown control status: ${status}`);
  }
}

const complianceSummaryResolver: NonNullable<QueryResolvers["complianceSummary"]> = (
  _p,
  _a,
  ctx,
) => getComplianceSummary(ctx.apiKey);

const complianceFrameworksResolver: NonNullable<QueryResolvers["complianceFrameworks"]> = async (
  _p,
  _a,
  ctx,
) => {
  const env = await listComplianceFrameworks(ctx.apiKey);
  return env.items.map((fw) => ({
    ...fw,
    controls: fw.controls.map((c) => ({
      ...c,
      status: mapToControlStatus(c.status),
    })),
  }));
};

const complianceAuditLogResolver: NonNullable<QueryResolvers["complianceAuditLog"]> = async (
  _p,
  args,
  ctx,
) => {
  const env = await listComplianceAuditLog(
    ctx.apiKey,
    { controlId: args.controlId ?? undefined },
    { limit: args.limit ?? 50, offset: args.offset ?? 0 },
  );
  return { items: env.items, total: env.total, limit: env.limit, offset: env.offset };
};

const updateControlStatusMutation: NonNullable<MutationResolvers["updateControlStatus"]> = async (
  _p,
  args,
  ctx,
) => {
  const payload = await updateControlStatus(ctx.apiKey, {
    controlId: args.controlId,
    status: args.input.status as string,
    reason: args.input.reason,
  });
  return {
    control: payload.control
      ? { ...payload.control, status: mapToControlStatus(payload.control.status) }
      : null,
    errors: payload.errors,
  };
};

export const complianceResolvers = {
  Query: {
    complianceSummary: complianceSummaryResolver,
    complianceFrameworks: complianceFrameworksResolver,
    complianceAuditLog: complianceAuditLogResolver,
  },
  Mutation: {
    updateControlStatus: updateControlStatusMutation,
  },
};
