/**
 * Anomaly resolvers -- extracted from resolvers.ts as part of D0.5.
 *
 * Contains Query.anomalies and AnomalyEvent nested resolvers.
 *
 * B1 fix: Uses generated QueryResolvers and AnomalyEventResolvers types from codegen.
 */

import { getPool } from "../db.js";
import type { QueryResolvers, AnomalyEventResolvers } from "../generated/graphql.js";
import { mapAnomaly } from "./mappers.js";

// R2-N4: Added limit and offset pagination arguments
const anomaliesResolver: NonNullable<QueryResolvers["anomalies"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  // Project scoping: join with sessions to filter by project
  if (ctx.apiKey.projectId) {
    conditions.push(`s.project_id = $${idx++}`);
    params.push(ctx.apiKey.projectId);
  }

  if (args.filter?.severity) {
    conditions.push(`a.severity = $${idx++}`);
    params.push(args.filter.severity);
  }
  if (args.filter?.sessionId) {
    conditions.push(`a.session_id = $${idx++}`);
    params.push(args.filter.sessionId);
  }
  if (args.filter?.anomalyType) {
    conditions.push(`a.anomaly_type = $${idx++}`);
    params.push(args.filter.anomalyType);
  }
  if (args.filter?.since) {
    conditions.push(`a.detected_at::TIMESTAMPTZ >= $${idx++}`);
    params.push(args.filter.since);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // R2-N4: Cap limit to max 1000, offset to max 100000, validate non-negative
  let limit = args.limit ?? 100;
  let offset = args.offset ?? 0;
  if (limit < 0) limit = 0;
  if (limit > 1000) limit = 1000;
  if (offset < 0) offset = 0;
  if (offset > 100000) offset = 100000;

  params.push(limit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const result = await pool.query(
    `SELECT a.* FROM anomaly_events a
     LEFT JOIN sessions s ON a.session_id = s.id
     ${where}
     ORDER BY a.detected_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );

  return result.rows.map(mapAnomaly);
};

// D0.4: DataLoader replaces N+1 queries for AnomalyEvent nested resolvers
const turnResolver: NonNullable<AnomalyEventResolvers["turn"]> = async (
  parent,
  _args,
  ctx
) => {
  if (!parent.turnId) return null;
  return ctx.loaders.turnById.load(parent.turnId);
};

const sessionResolver: NonNullable<AnomalyEventResolvers["session"]> = async (
  parent,
  _args,
  ctx
) => {
  if (!parent.sessionId) return null;
  return ctx.loaders.sessionById.load(parent.sessionId);
};

export const anomalyResolvers = {
  Query: {
    anomalies: anomaliesResolver,
  },
  AnomalyEvent: {
    turn: turnResolver,
    session: sessionResolver,
  },
};
