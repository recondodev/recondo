/**
 * Compliance resolvers -- Sprint D5.2.
 *
 * Contains:
 *   Query.complianceSummary      -- aggregate compliance posture
 *   Query.complianceFrameworks   -- all frameworks with nested controls
 *   Query.complianceAuditLog     -- paginated change history
 *   Mutation.updateControlStatus -- update a control + write audit log
 *
 * Tables used:
 *   compliance_frameworks, compliance_controls, compliance_audit_log,
 *   turns, sessions, anomaly_events
 *
 * B4: compliance_frameworks, compliance_controls, and compliance_audit_log are
 * intentionally NOT project-scoped. Compliance posture is an org-wide concern --
 * a control is either MET or NOT_MET across the entire organization, not per-project.
 * However, complianceSummary's turns/sessions sub-queries ARE project-scoped (B3)
 * because capture integrity and dropped events are per-project metrics.
 */

import { getPool } from "../db.js";
import { ControlStatus } from "../generated/graphql.js";
import type { QueryResolvers, MutationResolvers } from "../generated/graphql.js";
import type { GqlContext } from "../context.js";
import { formatTimestamp } from "./mappers.js";
import crypto from "crypto";

/**
 * Map a database status string to the ControlStatus enum.
 * W3: Throws on unknown status rather than silently degrading to PLANNED.
 */
function mapToControlStatus(status: string): ControlStatus {
  switch (status) {
    case "MET": return ControlStatus.Met;
    case "IN_PROGRESS": return ControlStatus.InProgress;
    case "NOT_MET": return ControlStatus.NotMet;
    case "PLANNED": return ControlStatus.Planned;
    default: throw new Error(`Unknown control status: ${status}`);
  }
}

/**
 * B3: Build project scoping condition and params for turns/sessions sub-queries
 * in complianceSummary. Mirrors the addProjectScope helper from cost.ts.
 */
function addProjectScope(
  ctx: GqlContext,
  conditions: string[],
  params: unknown[],
  startIdx: number,
  alias: string = "s"
): number {
  if (ctx.apiKey.projectId) {
    conditions.push(`${alias}.project_id = $${startIdx}`);
    params.push(ctx.apiKey.projectId);
    return startIdx + 1;
  }
  return startIdx;
}

/**
 * D5.2: complianceSummary resolver.
 *
 * N1: ComplianceSummary intentionally queries all-time data for a comprehensive
 * compliance posture view. The overallScore, captureIntegrity, hashMismatches,
 * droppedEvents, and openFindings reflect the full history of the organization's
 * compliance posture rather than a windowed snapshot.
 *
 * Returns:
 *   overallScore       -- average of framework compliance_percentages (integer)
 *   captureIntegrity   -- percentage of turns with both hashes and capture_complete
 *   hashMismatches     -- count of turns with empty request or response hash
 *   droppedEvents      -- SUM(dropped_events) from sessions
 *   openFindings       -- count of anomaly_events
 *   findingsBySeverity -- breakdown of anomaly_events by severity
 *   lastAssessment     -- most recent framework last_assessed_at
 */
const complianceSummaryResolver: NonNullable<QueryResolvers["complianceSummary"]> = async (
  _parent,
  _args,
  ctx
) => {
  const pool = getPool();

  // B3: Build project scope for turns/sessions sub-queries
  const turnScopeConditions: string[] = [];
  const turnScopeParams: unknown[] = [];
  addProjectScope(ctx, turnScopeConditions, turnScopeParams, 1, "s");
  const turnProjectClause = turnScopeConditions.length > 0
    ? ` WHERE ${turnScopeConditions.join(" AND ")}`
    : "";


  const [frameworkResult, turnResult, sessionResult, anomalyResult] = await Promise.all([
    // Framework averages (org-wide, not project-scoped -- B4)
    pool.query(
      `SELECT
         COALESCE(AVG(compliance_percentage), 0)::int AS overall_score,
         MAX(last_assessed_at) AS last_assessment
       FROM compliance_frameworks`
    ),
    // Turn integrity metrics (B3: project-scoped via session join)
    pool.query(
      `SELECT
         COUNT(*)::int AS total_turns,
         COUNT(*) FILTER (
           WHERE t.request_hash != '' AND t.response_hash != '' AND t.capture_complete = TRUE
         )::int AS verified_turns,
         COUNT(*) FILTER (
           WHERE t.request_hash = '' OR t.response_hash = ''
         )::int AS hash_mismatches
       FROM turns t
       JOIN sessions s ON t.session_id = s.id${turnProjectClause}`,
      [...turnScopeParams]
    ),
    // Dropped events from sessions (B3: project-scoped)
    pool.query(
      `SELECT COALESCE(SUM(dropped_events), 0)::int AS dropped_events
       FROM sessions s${turnProjectClause}`,
      [...turnScopeParams]
    ),
    // Anomaly findings by severity (org-wide)
    pool.query(
      `SELECT
         severity,
         COUNT(*)::int AS count
       FROM anomaly_events
       GROUP BY severity`
    ),
  ]);

  const fwRow = frameworkResult.rows[0];
  const turnRow = turnResult.rows[0];
  const sessionRow = sessionResult.rows[0];

  const totalTurns = (turnRow.total_turns as number) ?? 0;
  const verifiedTurns = (turnRow.verified_turns as number) ?? 0;
  const captureIntegrity = totalTurns > 0
    ? Math.round((verifiedTurns / totalTurns) * 10000) / 100
    : 100;

  // Anomaly findings by severity
  const findingsBySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  let totalFindings = 0;
  for (const row of anomalyResult.rows) {
    const severity = (row.severity as string).toLowerCase();
    const count = (row.count as number) ?? 0;
    totalFindings += count;
    if (severity === "critical") findingsBySeverity.critical = count;
    else if (severity === "high") findingsBySeverity.high = count;
    else if (severity === "medium") findingsBySeverity.medium = count;
    else if (severity === "low") findingsBySeverity.low = count;
    // "info" and other severities count toward totalFindings but not the breakdown
  }

  return {
    overallScore: (fwRow.overall_score as number) ?? 0,
    captureIntegrity,
    hashMismatches: (turnRow.hash_mismatches as number) ?? 0,
    droppedEvents: (sessionRow.dropped_events as number) ?? 0,
    openFindings: totalFindings,
    findingsBySeverity,
    lastAssessment: formatTimestamp(fwRow.last_assessment) ?? null,
  };
};

/**
 * D5.2: complianceFrameworks resolver.
 *
 * Returns all compliance frameworks with nested controls.
 * B4: Compliance frameworks and controls are org-wide (not project-scoped).
 * Compliance posture applies across the entire organization.
 */
const complianceFrameworksResolver: NonNullable<QueryResolvers["complianceFrameworks"]> = async (
  _parent,
  _args,
  ctx
) => {
  // B4: ctx is accepted but not used for project scoping here.
  // Compliance frameworks are intentionally org-wide.
  void ctx;
  const pool = getPool();

  const [fwResult, ctrlResult] = await Promise.all([
    pool.query(
      `SELECT id, name, subtitle, compliance_percentage, controls_met, controls_total
       FROM compliance_frameworks
       ORDER BY name`
    ),
    pool.query(
      `SELECT id, framework_id, control_id, description, status
       FROM compliance_controls
       ORDER BY control_id`
    ),
  ]);

  // Group controls by framework
  const controlsByFramework = new Map<string, Array<{
    id: string;
    controlId: string;
    description: string;
    status: ControlStatus;
  }>>();

  for (const row of ctrlResult.rows) {
    const frameworkId = row.framework_id as string;
    if (!controlsByFramework.has(frameworkId)) {
      controlsByFramework.set(frameworkId, []);
    }
    controlsByFramework.get(frameworkId)!.push({
      id: row.id as string,
      controlId: row.control_id as string,
      description: row.description as string,
      status: mapToControlStatus(row.status as string),
    });
  }

  return fwResult.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    subtitle: (row.subtitle as string) ?? null,
    compliancePercentage: (row.compliance_percentage as number) ?? 0,
    controlsMet: (row.controls_met as number) ?? 0,
    controlsTotal: (row.controls_total as number) ?? 0,
    controls: controlsByFramework.get(row.id as string) ?? [],
  }));
};

/**
 * D5.2: complianceAuditLog resolver.
 *
 * Returns paginated compliance audit log entries, optionally filtered by controlId.
 * Sorted by changedAt DESC.
 * B4: The compliance_audit_log table is org-wide (not project-scoped).
 * Audit log entries track compliance posture changes across the entire organization.
 */
const complianceAuditLogResolver: NonNullable<QueryResolvers["complianceAuditLog"]> = async (
  _parent,
  args,
  ctx
) => {
  // B4: ctx is accepted but not used for project scoping here.
  // Compliance audit log is intentionally org-wide.
  void ctx;
  const pool = getPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (args.controlId) {
    conditions.push(`control_id = $${idx++}`);
    params.push(args.controlId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // Pagination
  let limit = args.limit ?? 50;
  let offset = args.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;
  if (offset < 0) offset = 0;

  const countParams = [...params];
  params.push(limit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT id, control_id, old_status, new_status, changed_by, changed_at, reason
       FROM compliance_audit_log
       ${where}
       ORDER BY changed_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM compliance_audit_log
       ${where}`,
      countParams
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;

  const items = result.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    controlId: row.control_id as string,
    oldStatus: (row.old_status as string) ?? null,
    newStatus: row.new_status as string,
    changedBy: (row.changed_by as string) ?? null,
    changedAt: formatTimestamp(row.changed_at) ?? new Date().toISOString(),
    reason: (row.reason as string) ?? null,
  }));

  return {
    items,
    total,
    limit,
    offset,
  };
};

/**
 * D5.2: updateControlStatus mutation.
 *
 * Updates a compliance control's status, writes an audit log entry,
 * and recalculates the parent framework's compliance percentage.
 *
 * B1: All 4 operations (lookup, update, audit log insert, framework recalc)
 * are wrapped in a transaction with BEGIN/COMMIT/ROLLBACK.
 *
 * B2: changed_by is populated from ctx.apiKey.id (or projectId, or "unknown").
 *
 * N2: The error message for NOT_FOUND includes the user-supplied controlId.
 * This is acceptable because it is a GraphQL error message (not SQL), and the
 * controlId is a client-supplied UUID that the client already knows.
 *
 * Returns UpdateControlPayload with control (or null) and errors array.
 */
const updateControlStatusMutation: NonNullable<MutationResolvers["updateControlStatus"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const { controlId } = args;
  const { status, reason } = args.input;

  // Validate reason is non-empty
  if (!reason || reason.trim() === "") {
    return {
      control: null,
      errors: [{
        field: "reason",
        code: "REQUIRED",
        message: "Reason is required and cannot be empty",
      }],
    };
  }

  // B2: Derive changed_by from the authenticated context
  const changedBy = ctx.apiKey.id ?? ctx.apiKey.projectId ?? "unknown";

  // B1: Use a dedicated client for transactional operations
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Look up the control
    const controlResult = await client.query(
      `SELECT id, framework_id, control_id, description, status
       FROM compliance_controls
       WHERE id = $1`,
      [controlId]
    );

    if (controlResult.rows.length === 0) {
      await client.query("ROLLBACK");
      // N2: Error message includes user-supplied controlId. This is a GraphQL
      // error (not SQL), and the client already knows the controlId it sent.
      return {
        control: null,
        errors: [{
          field: "controlId",
          code: "NOT_FOUND",
          message: `Control with id '${controlId}' not found`,
        }],
      };
    }

    const existingControl = controlResult.rows[0];
    const oldStatus = existingControl.status as string;
    const frameworkId = existingControl.framework_id as string;

    // Update the control status
    await client.query(
      `UPDATE compliance_controls
       SET status = $1, updated_at = now()
       WHERE id = $2`,
      [status, controlId]
    );

    // Write audit log entry (B2: changed_by populated from ctx)
    const auditLogId = crypto.randomUUID();
    await client.query(
      `INSERT INTO compliance_audit_log (id, control_id, old_status, new_status, changed_by, changed_at, reason)
       VALUES ($1, $2, $3, $4, $5, now(), $6)`,
      [auditLogId, controlId, oldStatus, status, changedBy, reason]
    );

    // Recalculate framework compliance percentage
    const fwControlsResult = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'MET')::int AS met
       FROM compliance_controls
       WHERE framework_id = $1`,
      [frameworkId]
    );

    const fwRow = fwControlsResult.rows[0];
    const totalControls = (fwRow.total as number) ?? 0;
    const metControls = (fwRow.met as number) ?? 0;
    const newPercentage = totalControls > 0
      ? Math.round((metControls / totalControls) * 100)
      : 0;

    await client.query(
      `UPDATE compliance_frameworks
       SET compliance_percentage = $1, controls_met = $2, last_assessed_at = now()
       WHERE id = $3`,
      [newPercentage, metControls, frameworkId]
    );

    await client.query("COMMIT");

    return {
      control: {
        id: controlId as string,
        controlId: existingControl.control_id as string,
        description: existingControl.description as string,
        status: mapToControlStatus(status as string),
      },
      errors: [],
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
