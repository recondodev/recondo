/**
 * Sprint 10 Deliverable 4: Scheduled Export Capability
 *
 * POST   /v1/exports/schedule          — create a schedule
 * GET    /v1/exports/schedules         — list schedules for project
 * DELETE /v1/exports/schedules/:id     — remove a schedule
 * POST   /v1/exports/schedules/evaluate — trigger due exports
 *
 * Table: export_schedules (id, project_id, export_type, frequency,
 *        delivery_method, last_run_at, next_run_at, created_at)
 */

import { getPool } from "../db.js";
import type { ApiKeyInfo } from "../context.js";

const VALID_FREQUENCIES = ["weekly", "monthly"] as const;
const VALID_EXPORT_TYPES = ["iso42001", "soc2", "supply-chain"] as const;

/**
 * Compute the next run time based on frequency.
 */
function computeNextRunAt(frequency: string, from?: Date): Date {
  const base = from ?? new Date();
  const next = new Date(base.getTime());

  if (frequency === "weekly") {
    next.setDate(next.getDate() + 7);
  } else if (frequency === "monthly") {
    next.setMonth(next.getMonth() + 1);
  }

  return next;
}

/**
 * POST /v1/exports/schedule — Create a new export schedule.
 */
export async function handleCreateSchedule(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const exportType = body.exportType as string | undefined;
  const frequency = body.frequency as string | undefined;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  if (!exportType || !VALID_EXPORT_TYPES.includes(exportType as typeof VALID_EXPORT_TYPES[number])) {
    return {
      status: 400,
      body: { error: `Invalid exportType. Must be one of: ${VALID_EXPORT_TYPES.join(", ")}` },
    };
  }

  if (!frequency || !VALID_FREQUENCIES.includes(frequency as typeof VALID_FREQUENCIES[number])) {
    return {
      status: 400,
      body: { error: `Invalid frequency. Must be one of: ${VALID_FREQUENCIES.join(", ")}` },
    };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const pool = getPool();
  const nextRunAt = computeNextRunAt(frequency);

  const result = await pool.query(
    `INSERT INTO export_schedules (project_id, export_type, frequency, delivery_method, next_run_at)
     VALUES ($1, $2, $3, 'api', $4)
     RETURNING id, project_id, export_type, frequency, delivery_method, last_run_at, next_run_at, created_at`,
    [projectId, exportType, frequency, nextRunAt.toISOString()]
  );

  const row = result.rows[0];

  return {
    status: 201,
    body: {
      id: row.id,
      projectId: row.project_id,
      exportType: row.export_type,
      frequency: row.frequency,
      deliveryMethod: row.delivery_method,
      lastRunAt: row.last_run_at ? (row.last_run_at instanceof Date ? row.last_run_at.toISOString() : String(row.last_run_at)) : null,
      nextRunAt: row.next_run_at instanceof Date ? row.next_run_at.toISOString() : String(row.next_run_at),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    },
  };
}

/**
 * GET /v1/exports/schedules — List schedules for a project.
 */
export async function handleListSchedules(
  apiKey: ApiKeyInfo,
  projectId?: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!projectId) {
    return { status: 400, body: { error: "Missing required query parameter: projectId" } };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const pool = getPool();
  const result = await pool.query(
    `SELECT id, project_id, export_type, frequency, delivery_method, last_run_at, next_run_at, created_at
     FROM export_schedules
     WHERE project_id = $1
     ORDER BY created_at DESC
     LIMIT 10000`,
    [projectId]
  );

  const schedules = result.rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    exportType: r.export_type,
    frequency: r.frequency,
    deliveryMethod: r.delivery_method,
    lastRunAt: r.last_run_at ? (r.last_run_at instanceof Date ? r.last_run_at.toISOString() : String(r.last_run_at)) : null,
    nextRunAt: r.next_run_at instanceof Date ? r.next_run_at.toISOString() : String(r.next_run_at),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));

  return {
    status: 200,
    body: { schedules },
  };
}

/**
 * DELETE /v1/exports/schedules/:id — Delete a schedule.
 */
export async function handleDeleteSchedule(
  scheduleId: string,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const pool = getPool();

  // First, find the schedule to check project ownership
  const findResult = await pool.query(
    `SELECT id, project_id FROM export_schedules WHERE id = $1`,
    [scheduleId]
  );

  if (findResult.rows.length === 0) {
    return { status: 404, body: { error: "Schedule not found" } };
  }

  const schedule = findResult.rows[0];

  // Project scoping: cannot delete another project's schedule
  if (apiKey.projectId && apiKey.projectId !== schedule.project_id) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  await pool.query(`DELETE FROM export_schedules WHERE id = $1`, [scheduleId]);

  return {
    status: 200,
    body: { deleted: true, id: scheduleId },
  };
}

/**
 * POST /v1/exports/schedules/evaluate — Trigger due exports.
 * Finds schedules where next_run_at <= now, updates last_run_at, computes next_run_at.
 *
 * Actual export delivery (email/S3) requires control plane (Sprint 14).
 * Currently: bookkeeping only — marks schedules as evaluated and advances next_run_at.
 */
export async function handleEvaluateSchedules(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const pool = getPool();
  const now = new Date();

  // Find due schedules
  const dueResult = await pool.query(
    `SELECT id, frequency, next_run_at
     FROM export_schedules
     WHERE project_id = $1
       AND next_run_at <= $2
     LIMIT 10000`,
    [projectId, now.toISOString()]
  );

  let evaluated = 0;

  for (const row of dueResult.rows) {
    const nextRunAt = computeNextRunAt(row.frequency, now);

    await pool.query(
      `UPDATE export_schedules
       SET last_run_at = $1, next_run_at = $2
       WHERE id = $3`,
      [now.toISOString(), nextRunAt.toISOString(), row.id]
    );

    evaluated += 1;
  }

  return {
    status: 200,
    body: { evaluated },
  };
}
