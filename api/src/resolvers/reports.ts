import {
  listReports,
  listReportCoverageTrend,
  listReportFindingsTrend,
  generateReport,
  type GenerateReportInput,
  type GenerateReportPeriod,
  type GenerateReportType,
  type ReportRow,
} from "@recondo/data";
import {
  GenerateReportPeriod as GraphqlGenerateReportPeriod,
  GenerateReportType as GraphqlGenerateReportType,
  ReportStatus,
} from "../generated/graphql.js";
import type { QueryResolvers, MutationResolvers } from "../generated/graphql.js";

const REPORT_STATUS_MAP: Record<string, ReportStatus> = {
  FINAL: ReportStatus.Final,
  DRAFT: ReportStatus.Draft,
};

function shapeReport(row: ReportRow) {
  const status = REPORT_STATUS_MAP[row.status];
  if (!status) throw new Error(`Unknown report status: '${row.status}'`);
  return { ...row, status };
}

const REPORT_TYPE_MAP: Record<GraphqlGenerateReportType, GenerateReportType> = {
  [GraphqlGenerateReportType.WeeklyCost]: "weekly_cost",
  [GraphqlGenerateReportType.Compliance]: "compliance",
  [GraphqlGenerateReportType.Anomaly]: "anomaly",
  [GraphqlGenerateReportType.Custom]: "custom",
};

const REPORT_PERIOD_MAP: Record<GraphqlGenerateReportPeriod, GenerateReportPeriod> = {
  [GraphqlGenerateReportPeriod.Week]: "week",
  [GraphqlGenerateReportPeriod.Month]: "month",
};

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
  const input: GenerateReportInput = {
    type: REPORT_TYPE_MAP[args.input.type],
    period: REPORT_PERIOD_MAP[args.input.period],
    from: args.input.from ?? undefined,
    to: args.input.to ?? undefined,
    params: args.input.params ?? undefined,
  };
  const payload = await generateReport(ctx.apiKey, input);
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
