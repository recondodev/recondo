/**
 * Policy primitives.
 *
 * Hoisted from `api/src/resolvers/policies.ts` as part of C8. SQL bodies
 * preserved byte-for-byte; transport-shape concerns (GraphQL PolicyType /
 * PolicyStatus enums, GraphQLError shaping, mutation payload shape) stay
 * in api/.
 *
 * Public surface:
 *   - listPolicies(apiKey, filter, options)              -> ListEnvelope<PolicyRow>
 *   - getPolicy(apiKey, id, options)                     -> PolicyRow | null   (NEW)
 *   - createPolicy(apiKey, input, options)               -> PolicyRow
 *   - updatePolicy(apiKey, id, input, options)           -> PolicyRow | null
 *   - deletePolicy(apiKey, id, options)                  -> { id } | null
 *
 * Design notes:
 *   - `getPolicy(apiKey, id)` is a NEW function (no resolver originally
 *     surfaced a single-policy read). SQL: SELECT id, name, type, scope,
 *     action, triggers_mtd, status FROM policies WHERE id = $1, project-
 *     scoped when apiKey.projectId is set. Returns null when the row does
 *     not exist or is not in scope.
 *   - `type` and `status` are returned as raw strings ("BLOCK" | "LIMIT" |
 *     "ALERT" | "MONITOR" / "ACTIVE" | "INACTIVE"); the api/ resolver binds
 *     them to the GraphQL PolicyType / PolicyStatus enums.
 *   - updatePolicy / deletePolicy return null when the row is not found
 *     (or not in scope); the api/ resolver maps null to a {policy:null,
 *     errors:[NOT_FOUND]} / {success:false, errors:[NOT_FOUND]} payload.
 */

import crypto from "node:crypto";
import { getPool } from "./pool.js";
import { uniformListEnvelope } from "./envelope.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, QueryOptions } from "./types.js";

export interface PolicyRow {
  id: string;
  name: string;
  /** Raw type string ("BLOCK" | "LIMIT" | "ALERT" | "MONITOR"). */
  type: string;
  scope: string;
  action: string;
  triggersMtd: number;
  /** Raw status string ("ACTIVE" | "INACTIVE"). */
  status: string;
}

export interface PolicyFilter {
  // Placeholder for future filters; the policies list does not yet take any.
}

export interface PolicyTrendPoint {
  label: string;
  value: number;
}

export interface CreatePolicyInput {
  name: string;
  /** Raw type string from GraphQL PolicyType enum ("BLOCK"|"LIMIT"|"ALERT"|"MONITOR"). */
  type: string;
  scope: string;
  action: string;
}

export interface UpdatePolicyInput {
  name?: string;
  scope?: string;
  action?: string;
  /** Raw status string ("ACTIVE" | "INACTIVE"). */
  status?: string;
}

function mapPolicyRow(row: Record<string, unknown>): PolicyRow {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as string,
    scope: row.scope as string,
    action: row.action as string,
    triggersMtd: (row.triggers_mtd as number) ?? 0,
    status: row.status as string,
  };
}

export async function listPolicies(
  apiKey: ApiKeyInfo,
  _filter: PolicyFilter = {},
  options: ListOptions = {},
): Promise<ListEnvelope<PolicyRow> & { total: number; limit: number; offset: number }> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  let limit = options.limit ?? 50;
  let offset = options.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;
  if (offset < 0) offset = 0;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (apiKey.projectId) {
    conditions.push(`project_id = $${idx++}`);
    params.push(apiKey.projectId);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countParams = [...params];

  params.push(limit);
  const limitIdx = idx++;
  params.push(offset);
  const offsetIdx = idx++;

  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT id, name, type, scope, action, triggers_mtd, status
       FROM policies
       ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM policies ${where}`,
      countParams,
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;
  const items = result.rows.map((row: Record<string, unknown>) => mapPolicyRow(row));
  const truncated = offset + items.length < total;
  const nextOffset = truncated ? offset + items.length : null;

  return {
    ...uniformListEnvelope(items, { nextOffset, truncated }),
    total,
    limit,
    offset,
  };
}

export async function listPolicyTriggerHistory(
  _apiKey: ApiKeyInfo,
  args: { days?: number } = {},
  options: QueryOptions = {},
): Promise<ListEnvelope<PolicyTrendPoint>> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  let days = args.days ?? 30;
  if (days < 1) days = 1;
  if (days > 365) days = 365;

  const result = await pool.query(
    `SELECT
       TO_CHAR(triggered_at::date, 'YYYY-MM-DD') AS label,
       COUNT(*)::int AS value
     FROM policy_triggers
     WHERE triggered_at >= NOW() - ($1 || ' days')::INTERVAL
     GROUP BY triggered_at::date
     ORDER BY triggered_at::date ASC`,
    [days],
  );

  const items: PolicyTrendPoint[] = result.rows.map(
    (row: Record<string, unknown>) => ({
      label: row.label as string,
      value: (row.value as number) ?? 0,
    }),
  );
  return uniformListEnvelope(items, { nextOffset: null, truncated: false });
}

export async function getPolicy(
  apiKey: ApiKeyInfo,
  id: string,
  options: QueryOptions = {},
): Promise<PolicyRow | null> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  const conditions = [`id = $1`];
  const params: unknown[] = [id];
  if (apiKey.projectId) {
    conditions.push(`project_id = $2`);
    params.push(apiKey.projectId);
  }

  const result = await pool.query(
    `SELECT id, name, type, scope, action, triggers_mtd, status
     FROM policies
     WHERE ${conditions.join(" AND ")}
     LIMIT 1`,
    params,
  );

  if (result.rows.length === 0) return null;
  return mapPolicyRow(result.rows[0]);
}

export async function createPolicy(
  apiKey: ApiKeyInfo,
  input: CreatePolicyInput,
  options: QueryOptions = {},
): Promise<PolicyRow> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const { name, type, scope, action } = input;

  const policyId = crypto.randomUUID();

  if (apiKey.projectId) {
    await pool.query(
      `INSERT INTO policies (id, project_id, name, type, scope, action, triggers_mtd, status)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'ACTIVE')`,
      [policyId, apiKey.projectId, name, type, scope, action],
    );
  } else {
    await pool.query(
      `INSERT INTO policies (id, name, type, scope, action, triggers_mtd, status)
       VALUES ($1, $2, $3, $4, $5, 0, 'ACTIVE')`,
      [policyId, name, type, scope, action],
    );
  }

  return {
    id: policyId,
    name,
    type,
    scope,
    action,
    triggersMtd: 0,
    status: "ACTIVE",
  };
}

export async function updatePolicy(
  apiKey: ApiKeyInfo,
  id: string,
  input: UpdatePolicyInput,
  options: QueryOptions = {},
): Promise<PolicyRow | null> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const { name, scope, action, status } = input;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const scopeConditions: string[] = ["id = $1"];
    const scopeParams: unknown[] = [id];
    if (apiKey.projectId) {
      scopeConditions.push("project_id = $2");
      scopeParams.push(apiKey.projectId);
    }

    const existing = await client.query(
      `SELECT id, name, type, scope, action, triggers_mtd, status
       FROM policies WHERE ${scopeConditions.join(" AND ")}`,
      scopeParams,
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const row = existing.rows[0];
    const updatedName = name ?? (row.name as string);
    const updatedScope = scope ?? (row.scope as string);
    const updatedAction = action ?? (row.action as string);
    const updatedStatus = status ?? (row.status as string);

    await client.query(
      `UPDATE policies
       SET name = $1, scope = $2, action = $3, status = $4, updated_at = now()
       WHERE id = $5`,
      [updatedName, updatedScope, updatedAction, updatedStatus, id],
    );

    await client.query("COMMIT");

    return {
      id: row.id as string,
      name: updatedName,
      type: row.type as string,
      scope: updatedScope,
      action: updatedAction,
      triggersMtd: (row.triggers_mtd as number) ?? 0,
      status: updatedStatus,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function deletePolicy(
  apiKey: ApiKeyInfo,
  id: string,
  options: QueryOptions = {},
): Promise<{ id: string } | null> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();

  const conditions: string[] = ["id = $1"];
  const params: unknown[] = [id];
  if (apiKey.projectId) {
    conditions.push("project_id = $2");
    params.push(apiKey.projectId);
  }

  const result = await pool.query(
    `DELETE FROM policies WHERE ${conditions.join(" AND ")} RETURNING id`,
    params,
  );

  if (result.rowCount === 0) return null;
  return { id: result.rows[0].id as string };
}
