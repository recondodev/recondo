/**
 * Registered keys resolvers -- Sprint D6.3.
 *
 * Contains:
 *   Query.registeredKeys  -- paginated registered keys list
 *   Mutation.registerKey  -- register a new LLM API key
 *   Mutation.deleteKey    -- delete a registered key
 *
 * Tables used:
 *   registered_keys
 *
 * W3: Hard delete is intentional for registered keys -- these are configuration
 * entities, not audit records. Compliance audit log (compliance_audit_log)
 * preserves historical compliance changes.
 */

import { getPool } from "../db.js";
import { KeyStatus } from "../generated/graphql.js";
import type { QueryResolvers, MutationResolvers } from "../generated/graphql.js";
import type { GqlContext } from "../context.js";
import { formatTimestamp } from "./mappers.js";
import crypto from "crypto";

/**
 * Map a database key status string to the KeyStatus enum.
 * N4: Throws on unknown status rather than silently returning a default.
 */
function mapToKeyStatus(status: string): KeyStatus {
  switch (status) {
    case "active": return KeyStatus.Active;
    case "inactive": return KeyStatus.Inactive;
    default: throw new Error(`Unknown key status: '${status}'`);
  }
}

/**
 * B2: Build project scoping conditions for registered_keys queries.
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
 * D6.3: registeredKeys query resolver.
 * Returns paginated registered keys ordered by created_at DESC.
 * B2: Project-scoped when ctx.apiKey.projectId is set.
 */
const registeredKeysResolver: NonNullable<QueryResolvers["registeredKeys"]> = async (
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
      `SELECT id, name, provider, fingerprint, agent_count, last_used,
              monthly_cost_usd, status
       FROM registered_keys
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM registered_keys ${whereClause}`,
      params.slice(0, paramIdx - 1)
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;

  const items = result.rows.map((row: Record<string, unknown>) => ({
    id: row.id as string,
    name: row.name as string,
    provider: row.provider as string,
    fingerprint: row.fingerprint as string,
    agentCount: (row.agent_count as number) ?? 0,
    lastUsed: formatTimestamp(row.last_used),
    monthlyCostUsd: (row.monthly_cost_usd as number) ?? 0,
    status: mapToKeyStatus(row.status as string),
  }));

  return { items, total, limit, offset };
};

/**
 * D6.3: registerKey mutation resolver.
 * Registers a new LLM API key.
 *
 * B4: Uses INSERT ... ON CONFLICT (fingerprint) DO NOTHING + rowCount check
 * instead of SELECT-then-INSERT to eliminate TOCTOU race condition.
 * The UNIQUE constraint on fingerprint ensures atomicity.
 *
 * B2: Inserts project_id from ctx.apiKey.projectId when scoped.
 */
const registerKeyMutation: NonNullable<MutationResolvers["registerKey"]> = async (
  _parent,
  args,
  ctx
) => {
  const pool = getPool();
  const { name, provider, fingerprint } = args.input;

  const keyId = crypto.randomUUID();

  // B4: Atomic INSERT ... ON CONFLICT eliminates TOCTOU race.
  // If fingerprint already exists, rowCount will be 0.
  // B2: Include project_id in INSERT when scoped, omit for admin
  let result;
  if (ctx.apiKey.projectId) {
    result = await pool.query(
      `INSERT INTO registered_keys (id, project_id, name, provider, fingerprint, agent_count, last_used, monthly_cost_usd, status)
       VALUES ($1, $2, $3, $4, $5, 0, NULL, 0.0, 'active')
       ON CONFLICT (fingerprint) DO NOTHING`,
      [keyId, ctx.apiKey.projectId, name, provider, fingerprint]
    );
  } else {
    result = await pool.query(
      `INSERT INTO registered_keys (id, name, provider, fingerprint, agent_count, last_used, monthly_cost_usd, status)
       VALUES ($1, $2, $3, $4, 0, NULL, 0.0, 'active')
       ON CONFLICT (fingerprint) DO NOTHING`,
      [keyId, name, provider, fingerprint]
    );
  }

  if (result.rowCount === 0) {
    return {
      key: null,
      errors: [{
        field: "fingerprint",
        code: "DUPLICATE",
        message: `A key with fingerprint '${fingerprint}' is already registered`,
      }],
    };
  }

  return {
    key: {
      id: keyId,
      name: name as string,
      provider: provider as string,
      fingerprint: fingerprint as string,
      agentCount: 0,
      lastUsed: null,
      monthlyCostUsd: 0,
      status: KeyStatus.Active,
    },
    errors: [],
  };
};

/**
 * D6.3: deleteKey mutation resolver.
 * Deletes a registered key. Returns success: true or error if not found.
 *
 * W3: Hard delete is intentional for registered keys -- these are configuration
 * entities, not audit records. Compliance audit log (compliance_audit_log)
 * preserves historical compliance changes.
 *
 * B2: Scopes the DELETE to project_id when ctx.apiKey.projectId is set.
 */
const deleteKeyMutation: NonNullable<MutationResolvers["deleteKey"]> = async (
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
    `DELETE FROM registered_keys WHERE ${conditions.join(" AND ")} RETURNING id`,
    params
  );

  if (result.rowCount === 0) {
    return {
      success: false,
      errors: [{
        field: "id",
        code: "NOT_FOUND",
        message: `Key with id '${id}' not found`,
      }],
    };
  }

  return { success: true, errors: [] };
};

export const keyResolvers = {
  Query: {
    registeredKeys: registeredKeysResolver,
  },
  Mutation: {
    registerKey: registerKeyMutation,
    deleteKey: deleteKeyMutation,
  },
};
