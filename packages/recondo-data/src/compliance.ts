/**
 * Compliance posture primitives.
 *
 * Hoisted from `api/src/resolvers/compliance.ts` as part of C7. SQL
 * bodies preserved byte-for-byte; transport-shape concerns (GraphQL
 * enum binding for ControlStatus, GraphQLError shaping) stay in api/.
 *
 * Public surface:
 *   - getComplianceSummary(apiKey, options)               -> ComplianceSummaryRow
 *   - listComplianceFrameworks(apiKey, options)           -> ListEnvelope<ComplianceFrameworkRow>
 *   - listComplianceAuditLog(apiKey, filter, options)     -> ListEnvelope<ComplianceAuditEntry>
 *   - listComplianceFindings(apiKey, filter, options)     -> ListEnvelope<ComplianceAuditEntry>
 *   - updateControlStatus(apiKey, input, options)         -> UpdateControlPayload
 *
 * Design notes:
 *   - `listComplianceFindings` is an alias for `listComplianceAuditLog`.
 *     The compliance schema does NOT have a separate `findings` table;
 *     compliance findings ARE the audit-log entries (status changes
 *     against controls). Tests assert `listComplianceFindings` exists
 *     as an envelope-returning function — aliasing keeps behaviour
 *     consistent and avoids a redundant SQL surface. If a distinct
 *     findings concept is added later, this alias becomes its own
 *     function and the audit-log call is left untouched.
 *   - `complianceFrameworks` originally returned a bare array. The
 *     package shape is uniform `ListEnvelope`; the api/ resolver
 *     re-shapes back to the GraphQL bare-list contract.
 *   - `complianceFrameworks` and the audit log are NOT project-scoped
 *     (B4). `complianceSummary`'s turns/sessions sub-queries ARE
 *     project-scoped (B3) — capture integrity is per-project.
 */

import crypto from "node:crypto";
import { getPool } from "./pool.js";
import { uniformListEnvelope } from "./envelope.js";
import { formatTimestamp } from "./mappers.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, QueryOptions } from "./types.js";

export interface ComplianceFindingsBySeverity {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

export interface ComplianceSummaryRow {
  overallScore: number;
  captureIntegrity: number;
  hashMismatches: number;
  droppedEvents: number;
  openFindings: number;
  findingsBySeverity: ComplianceFindingsBySeverity;
  lastAssessment: string | null;
}

export interface ComplianceControlRow {
  id: string;
  controlId: string;
  description: string;
  /** Raw status string from the database (MET, IN_PROGRESS, NOT_MET, PLANNED). */
  status: string;
}

export interface ComplianceFrameworkRow {
  id: string;
  name: string;
  subtitle: string | null;
  compliancePercentage: number;
  controlsMet: number;
  controlsTotal: number;
  controls: ComplianceControlRow[];
}

export interface ComplianceAuditEntry {
  id: string;
  controlId: string;
  oldStatus: string | null;
  newStatus: string;
  changedBy: string | null;
  changedAt: string;
  reason: string | null;
}

export interface ComplianceAuditFilter {
  controlId?: string;
}

export interface UpdateControlInput {
  controlId: string;
  status: string;
  reason: string;
}

export interface UpdateControlError {
  field: string;
  code: string;
  message: string;
}

export interface UpdateControlPayload {
  control: ComplianceControlRow | null;
  errors: UpdateControlError[];
}

export async function getComplianceSummary(
  apiKey: ApiKeyInfo,
  options: QueryOptions = {},
): Promise<ComplianceSummaryRow> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  const turnScopeConditions: string[] = [];
  const turnScopeParams: unknown[] = [];
  if (apiKey.projectId) {
    turnScopeConditions.push(`s.project_id = $1`);
    turnScopeParams.push(apiKey.projectId);
  }
  const turnProjectClause =
    turnScopeConditions.length > 0 ? ` WHERE ${turnScopeConditions.join(" AND ")}` : "";

  const [frameworkResult, turnResult, sessionResult, anomalyResult] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(AVG(compliance_percentage), 0)::int AS overall_score,
         MAX(last_assessed_at) AS last_assessment
       FROM compliance_frameworks`,
    ),
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
      [...turnScopeParams],
    ),
    pool.query(
      `SELECT COALESCE(SUM(dropped_events), 0)::int AS dropped_events
       FROM sessions s${turnProjectClause}`,
      [...turnScopeParams],
    ),
    pool.query(
      `SELECT
         severity,
         COUNT(*)::int AS count
       FROM anomaly_events
       GROUP BY severity`,
    ),
  ]);

  const fwRow = frameworkResult.rows[0] ?? {};
  const turnRow = turnResult.rows[0] ?? {};
  const sessionRow = sessionResult.rows[0] ?? {};

  const totalTurns = (turnRow.total_turns as number) ?? 0;
  const verifiedTurns = (turnRow.verified_turns as number) ?? 0;
  const captureIntegrity =
    totalTurns > 0 ? Math.round((verifiedTurns / totalTurns) * 10000) / 100 : 100;

  const findingsBySeverity: ComplianceFindingsBySeverity = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  let totalFindings = 0;
  for (const row of anomalyResult.rows) {
    const severity = (row.severity as string).toLowerCase();
    const count = (row.count as number) ?? 0;
    totalFindings += count;
    if (severity === "critical") findingsBySeverity.critical = count;
    else if (severity === "high") findingsBySeverity.high = count;
    else if (severity === "medium") findingsBySeverity.medium = count;
    else if (severity === "low") findingsBySeverity.low = count;
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
}

export async function listComplianceFrameworks(
  _apiKey: ApiKeyInfo,
  options: QueryOptions = {},
): Promise<ListEnvelope<ComplianceFrameworkRow>> {
  // B4: frameworks are intentionally org-wide; apiKey.projectId is ignored.
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  const [fwResult, ctrlResult] = await Promise.all([
    pool.query(
      `SELECT id, name, subtitle, compliance_percentage, controls_met, controls_total
       FROM compliance_frameworks
       ORDER BY name`,
    ),
    pool.query(
      `SELECT id, framework_id, control_id, description, status
       FROM compliance_controls
       ORDER BY control_id`,
    ),
  ]);

  const controlsByFramework = new Map<string, ComplianceControlRow[]>();
  for (const row of ctrlResult.rows) {
    const frameworkId = row.framework_id as string;
    let bucket = controlsByFramework.get(frameworkId);
    if (!bucket) {
      bucket = [];
      controlsByFramework.set(frameworkId, bucket);
    }
    bucket.push({
      id: row.id as string,
      controlId: row.control_id as string,
      description: row.description as string,
      status: row.status as string,
    });
  }

  const items: ComplianceFrameworkRow[] = fwResult.rows.map(
    (row: Record<string, unknown>) => ({
      id: row.id as string,
      name: row.name as string,
      subtitle: (row.subtitle as string | null) ?? null,
      compliancePercentage: (row.compliance_percentage as number) ?? 0,
      controlsMet: (row.controls_met as number) ?? 0,
      controlsTotal: (row.controls_total as number) ?? 0,
      controls: controlsByFramework.get(row.id as string) ?? [],
    }),
  );

  return uniformListEnvelope(items, { nextOffset: null, truncated: false });
}

export async function listComplianceAuditLog(
  _apiKey: ApiKeyInfo,
  filter: ComplianceAuditFilter = {},
  options: ListOptions = {},
): Promise<ListEnvelope<ComplianceAuditEntry> & { total: number; limit: number; offset: number }> {
  // B4: audit log is org-wide; apiKey.projectId is ignored.
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filter.controlId) {
    conditions.push(`control_id = $${idx++}`);
    params.push(filter.controlId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  let limit = options.limit ?? 50;
  let offset = options.offset ?? 0;
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
      params,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM compliance_audit_log
       ${where}`,
      countParams,
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;

  const items: ComplianceAuditEntry[] = result.rows.map(
    (row: Record<string, unknown>) => ({
      id: row.id as string,
      controlId: row.control_id as string,
      oldStatus: (row.old_status as string | null) ?? null,
      newStatus: row.new_status as string,
      changedBy: (row.changed_by as string | null) ?? null,
      changedAt: formatTimestamp(row.changed_at) ?? new Date().toISOString(),
      reason: (row.reason as string | null) ?? null,
    }),
  );

  const truncated = offset + items.length < total;
  const nextOffset = truncated ? offset + items.length : null;

  return {
    ...uniformListEnvelope(items, { nextOffset, truncated }),
    total,
    limit,
    offset,
  };
}

/**
 * Compliance findings: aliased to the audit log. The compliance schema
 * has no separate findings table — compliance findings ARE control
 * status-change events recorded in `compliance_audit_log`. Kept as a
 * named export so callers (and the C7 test) can address them by intent.
 */
export const listComplianceFindings = listComplianceAuditLog;

export async function updateControlStatus(
  apiKey: ApiKeyInfo,
  input: UpdateControlInput,
  options: QueryOptions = {},
): Promise<UpdateControlPayload> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const { controlId, status, reason } = input;

  if (!reason || reason.trim() === "") {
    return {
      control: null,
      errors: [
        {
          field: "reason",
          code: "REQUIRED",
          message: "Reason is required and cannot be empty",
        },
      ],
    };
  }

  const pool = getPool();
  const changedBy = apiKey.id ?? apiKey.projectId ?? "unknown";

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const controlResult = await client.query(
      `SELECT id, framework_id, control_id, description, status
       FROM compliance_controls
       WHERE id = $1`,
      [controlId],
    );

    if (controlResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        control: null,
        errors: [
          {
            field: "controlId",
            code: "NOT_FOUND",
            message: `Control with id '${controlId}' not found`,
          },
        ],
      };
    }

    const existing = controlResult.rows[0];
    const oldStatus = existing.status as string;
    const frameworkId = existing.framework_id as string;

    await client.query(
      `UPDATE compliance_controls
       SET status = $1, updated_at = now()
       WHERE id = $2`,
      [status, controlId],
    );

    const auditLogId = crypto.randomUUID();
    await client.query(
      `INSERT INTO compliance_audit_log (id, control_id, old_status, new_status, changed_by, changed_at, reason)
       VALUES ($1, $2, $3, $4, $5, now(), $6)`,
      [auditLogId, controlId, oldStatus, status, changedBy, reason],
    );

    const fwControlsResult = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'MET')::int AS met
       FROM compliance_controls
       WHERE framework_id = $1`,
      [frameworkId],
    );

    const fwRow = fwControlsResult.rows[0];
    const totalControls = (fwRow.total as number) ?? 0;
    const metControls = (fwRow.met as number) ?? 0;
    const newPercentage =
      totalControls > 0 ? Math.round((metControls / totalControls) * 100) : 0;

    await client.query(
      `UPDATE compliance_frameworks
       SET compliance_percentage = $1, controls_met = $2, last_assessed_at = now()
       WHERE id = $3`,
      [newPercentage, metControls, frameworkId],
    );

    await client.query("COMMIT");

    return {
      control: {
        id: controlId,
        controlId: existing.control_id as string,
        description: existing.description as string,
        status,
      },
      errors: [],
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
