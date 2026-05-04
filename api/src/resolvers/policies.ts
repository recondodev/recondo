/**
 * Policies resolvers -- Sprint D6.2.
 *
 * Contains:
 *   Query.policies              -- paginated policies list
 *   Query.policyTriggerHistory  -- daily trigger counts as TrendPoint array
 *   Mutation.createPolicy       -- create a new policy
 *   Mutation.updatePolicy       -- update an existing policy
 *   Mutation.deletePolicy       -- delete a policy
 *
 * Tables used:
 *   policies, policy_triggers
 *
 * W3: Hard delete is intentional for policies -- these are configuration
 * entities, not audit records. Compliance audit log (compliance_audit_log)
 * preserves historical compliance changes.
 */

import { getPool } from "../db.js";
import { PolicyStatus, PolicyType } from "../generated/graphql.js";
import type { QueryResolvers, MutationResolvers } from "../generated/graphql.js";
import type { GqlContext } from "../context.js";
import crypto from "crypto";

/**
 * Map a database policy type string to the PolicyType enum.
 * N4: Throws on unknown type rather than silently returning a default.
 */
function mapToPolicyType(type: string): PolicyType {
  switch (type) {
    case "BLOCK": return PolicyType.Block;
    case "LIMIT": return PolicyType.Limit;
    case "ALERT": return PolicyType.Alert;
    case "MONITOR": return PolicyType.Monitor;
    default: throw new Error(`Unknown policy type: '${type}'`);
  }
}

/**
 * Map a database policy status string to the PolicyStatus enum.
 * N4: Throws on unknown status rather than silently returning a default.
 */
function mapToPolicyStatus(status: string): PolicyStatus {
  switch (status) {
    case "ACTIVE": return PolicyStatus.Active;
    case "INACTIVE": return PolicyStatus.Inactive;
    default: throw new Error(`Unknown policy status: '${status}'`);
  }
}

/**
 * B2: Build project scoping conditions for policies queries.
 * Only adds the condition when ctx.apiKey.projectId is set (non-admin).
 */
function addProjectScope(
  ctx: GqlContext,
  conditions: string[],
  params: unknown[],
  startIdx: number,
): number {
  if (ctx.apiKey.projectId) {
    conditions.push(`project_id = $${startIdx}`);
    params.push(ctx.apiKey.projectId);
    return startIdx + 1;
  }
  return startIdx;
}

/**
 * D6.2: policies query resolver.
 * Returns paginated policies ordered by created_at DESC.
 * B2: Project-scoped when ctx.apiKey.projectId is set.
 */
const policiesResolver: NonNullable<QueryResolvers["policies"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();

  let limit = args.limit ?? 50;
  let offset = args.offset ?? 0;
  if (limit < 1) limit = 1;
  if (limit > 500) limit = 500;
  if (offset < 0) offset = 0;

  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = addProjectScope(ctx, conditions, params, 1);

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  params.push(limit, offset);

  const [result, countResult] = await Promise.all([
    pool.query(
      `SELECT id, name, type, scope, action, triggers_mtd, status
       FROM policies
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM policies ${whereClause}`,
      params.slice(0, paramIdx - 1)
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;

  const items = result.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    type: mapToPolicyType(row.type as string),
    scope: row.scope as string,
    action: row.action as string,
    triggersMtd: (row.triggers_mtd as number) ?? 0,
    status: mapToPolicyStatus(row.status as string),
  }));

  return { items, total, limit, offset };
};

/**
 * D6.2: policyTriggerHistory query resolver.
 * Returns daily trigger counts for the last N days (default 30).
 * W5: Clamps days to [1, 365] to prevent unbounded queries.
 */
const policyTriggerHistoryResolver: NonNullable<QueryResolvers["policyTriggerHistory"]> = async (
  _parent,
  args,
  _ctx
) => {
  const pool = getPool();
  let days = args.days ?? 30;

  // W5: Clamp days to [1, 365]
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
    [days]
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    label: row.label as string,
    value: (row.value as number) ?? 0,
  }));
};

/**
 * D6.2: createPolicy mutation resolver.
 * Creates a new policy with ACTIVE status and 0 triggers_mtd.
 * B2: Inserts project_id from ctx.apiKey.projectId when scoped.
 */
const createPolicyMutation: NonNullable<MutationResolvers["createPolicy"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const { name, type, scope, action } = args.input;

  const policyId = crypto.randomUUID();

  // B2: Include project_id in INSERT when scoped, omit for admin
  if (ctx.apiKey.projectId) {
    await pool.query(
      `INSERT INTO policies (id, project_id, name, type, scope, action, triggers_mtd, status)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'ACTIVE')`,
      [policyId, ctx.apiKey.projectId, name, type, scope, action]
    );
  } else {
    await pool.query(
      `INSERT INTO policies (id, name, type, scope, action, triggers_mtd, status)
       VALUES ($1, $2, $3, $4, $5, 0, 'ACTIVE')`,
      [policyId, name, type, scope, action]
    );
  }

  return {
    policy: {
      id: policyId,
      name: name as string,
      type: mapToPolicyType(type as string),
      scope: scope as string,
      action: action as string,
      triggersMtd: 0,
      status: PolicyStatus.Active,
    },
    errors: [],
  };
};

/**
 * D6.2: updatePolicy mutation resolver.
 * Updates a policy's fields. Only provided fields are changed.
 * W1: Uses BEGIN/COMMIT/ROLLBACK for transactional integrity (SELECT + UPDATE).
 * B2: Scopes the SELECT to project_id when ctx.apiKey.projectId is set.
 */
const updatePolicyMutation: NonNullable<MutationResolvers["updatePolicy"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const { id } = args;
  const { name, scope, action, status } = args.input;

  // W1: Use a client from the pool for transactional integrity
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // B2: Project-scoped lookup
    const scopeConditions: string[] = ["id = $1"];
    const scopeParams: unknown[] = [id];
    if (ctx.apiKey.projectId) {
      scopeConditions.push("project_id = $2");
      scopeParams.push(ctx.apiKey.projectId);
    }

    const existing = await client.query(
      `SELECT id, name, type, scope, action, triggers_mtd, status
       FROM policies WHERE ${scopeConditions.join(" AND ")}`,
      scopeParams
    );

    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        policy: null,
        errors: [{
          field: "id",
          code: "NOT_FOUND",
          message: `Policy with id '${id}' not found`,
        }],
      };
    }

    const row = existing.rows[0];

    // Build update -- only update provided fields
    const updatedName = (name as string | undefined) ?? (row.name as string);
    const updatedScope = (scope as string | undefined) ?? (row.scope as string);
    const updatedAction = (action as string | undefined) ?? (row.action as string);
    const updatedStatus = (status as string | undefined) ?? (row.status as string);

    await client.query(
      `UPDATE policies
       SET name = $1, scope = $2, action = $3, status = $4, updated_at = now()
       WHERE id = $5`,
      [updatedName, updatedScope, updatedAction, updatedStatus, id]
    );

    await client.query("COMMIT");

    return {
      policy: {
        id: row.id as string,
        name: updatedName,
        type: mapToPolicyType(row.type as string),
        scope: updatedScope,
        action: updatedAction,
        triggersMtd: (row.triggers_mtd as number) ?? 0,
        status: mapToPolicyStatus(updatedStatus),
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

/**
 * D6.2: deletePolicy mutation resolver.
 * Deletes a policy. Returns success: true or error if not found.
 *
 * W3: Hard delete is intentional for policies -- these are configuration
 * entities, not audit records. Compliance audit log (compliance_audit_log)
 * preserves historical compliance changes.
 *
 * B2: Scopes the DELETE to project_id when ctx.apiKey.projectId is set.
 */
const deletePolicyMutation: NonNullable<MutationResolvers["deletePolicy"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const { id } = args;

  // B2: Project-scoped delete
  const conditions: string[] = ["id = $1"];
  const params: unknown[] = [id];
  if (ctx.apiKey.projectId) {
    conditions.push("project_id = $2");
    params.push(ctx.apiKey.projectId);
  }

  const result = await pool.query(
    `DELETE FROM policies WHERE ${conditions.join(" AND ")} RETURNING id`,
    params
  );

  if (result.rowCount === 0) {
    return {
      success: false,
      errors: [{
        field: "id",
        code: "NOT_FOUND",
        message: `Policy with id '${id}' not found`,
      }],
    };
  }

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
