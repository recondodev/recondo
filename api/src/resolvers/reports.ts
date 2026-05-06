/**
 * Reports resolvers — thin GraphQL adapters over @recondo/data.
 *
 * SQL bodies live in `packages/recondo-data/src/reports.ts`. This file
 * is responsible for:
 *   - mapping GraphQL args to the @recondo/data shape
 *   - binding the data layer's raw status string ("FINAL"|"DRAFT") to
 *     the GraphQL `ReportStatus` enum
 *   - re-shaping the reports envelope into the GraphQL connection shape
 *     (items/total/limit/offset)
 *   - re-shaping trend envelopes into bare GraphQL lists
 */

import {
  listReports,
  listReportCoverageTrend,
  listReportFindingsTrend,
  generateReport,
  type ReportRow,
} from "@recondo/data";
import { ReportStatus } from "../generated/graphql.js";
import type {
  QueryResolvers,
  MutationResolvers,
} from "../generated/graphql.js";

function mapToReportStatus(status: string): ReportStatus {
  switch (status) {
    case "FINAL":
      return ReportStatus.Final;
    case "DRAFT":
      return ReportStatus.Draft;
    default:
      throw new Error(`Unknown report status: '${status}'`);
  }
}

function shapeReport(row: ReportRow) {
  return { ...row, status: mapToReportStatus(row.status) };
}

const reportsResolver: NonNullable<QueryResolvers["reports"]> = async (_p, args, ctx) => {
  const env = await listReports(
    ctx.apiKey,
    {},
    { limit: args.limit ?? 50, offset: args.offset ?? 0 },
  );
  return {
    items: env.items.map(shapeReport),
    total: env.total,
    limit: env.limit,
    offset: env.offset,
  };
};

const reportCoverageTrendResolver: NonNullable<QueryResolvers["reportCoverageTrend"]> = async (
  _p,
  _a,
  ctx,
) => (await listReportCoverageTrend(ctx.apiKey)).items;

const reportFindingsTrendResolver: NonNullable<QueryResolvers["reportFindingsTrend"]> = async (
  _p,
  _a,
  ctx,
) => (await listReportFindingsTrend(ctx.apiKey)).items;

const generateReportMutation: NonNullable<MutationResolvers["generateReport"]> = async (
  _p,
  args,
  ctx,
) => {
  const payload = await generateReport(ctx.apiKey, {
    framework: args.input.framework as string,
    periodStart: args.input.periodStart as string,
    periodEnd: args.input.periodEnd as string,
  });
  return {
    report: payload.report ? shapeReport(payload.report) : null,
    errors: payload.errors,
  };
};

export const reportResolvers = {
  Query: {
    reports: reportsResolver,
    reportCoverageTrend: reportCoverageTrendResolver,
    reportFindingsTrend: reportFindingsTrendResolver,
  },
  Mutation: {
    generateReport: generateReportMutation,
  },
};
