/**
 * Registered LLM API key primitives.
 *
 * Hoisted from `api/src/resolvers/keys.ts` as part of C8. SQL bodies
 * preserved byte-for-byte; transport-shape concerns (GraphQL KeyStatus
 * enum binding, GraphQLError shaping, mutation payload shape) stay in
 * api/.
 *
 * Naming: per the deliverables doc D-KE1, the package surface uses the
 * names `listApiKeys / createApiKey / revokeApiKey`. The api/ resolver
 * keeps its existing GraphQL operation names (registeredKeys, registerKey,
 * deleteKey) so the dashboard's GraphQL schema is unchanged.
 *
 * Data model: this module operates on the `registered_keys` table — the
 * registry of LLM provider keys (Anthropic, OpenAI, etc.) tracked by the
 * gateway. It is NOT the `api_keys` table (gateway auth tokens, owned by
 * auth.ts). The two tables are intentionally distinct.
 *
 * Soft-delete note: the Test Writer's reconnaissance suggested
 * `revokeApiKey` should `UPDATE api_keys SET revoked_at = NOW()` to
 * preserve audit trail. That guidance applies to `api_keys` (gateway auth
 * tokens), which has a `revoked_at` column. The `registered_keys` table
 * has no `revoked_at` column — it tracks LLM provider keys, not auth
 * tokens — and existing api/ integration tests (d6-reports-policies-keys)
 * assert that a deleted key is GONE from the table after revoke. Changing
 * to soft-delete here would break those tests AND require a migration to
 * add `revoked_at`. We preserve the existing hard-delete semantics; see
 * the implementation report for details.
 *
 * Public surface:
 *   - listApiKeys(apiKey, filter, options)              -> ListEnvelope<ApiKeyRecord>
 *   - createApiKey(apiKey, input, options)              -> ApiKeyRecord | null
 *       (null when fingerprint is already registered — UNIQUE conflict)
 *   - revokeApiKey(apiKey, id, options)                 -> { id } | null
 *       (null when the row does not exist or is out of project scope)
 */

import crypto from "node:crypto";
import { getPool } from "./pool.js";
import { uniformListEnvelope } from "./envelope.js";
import { formatTimestamp } from "./mappers.js";
import { insertAuditLog } from "./audit.js";
import type { ApiKeyInfo, ListEnvelope, ListOptions, QueryOptions } from "./types.js";

export interface ApiKeyRecord {
  id: string;
  name: string;
  provider: string;
  fingerprint: string;
  agentCount: number;
  lastUsed: string | null;
  monthlyCostUsd: number;
  /** Raw status string ("active" | "inactive"). */
  status: string;
}

export interface ApiKeyFilter {
  // Placeholder for future filters; the registered keys list does not yet take any.
}

export interface CreateApiKeyInput {
  name: string;
  provider: string;
  fingerprint: string;
}

export interface MintScopedKeyInput {
  projectId: string;
  name: string;
}

export interface MintScopedKeyResult {
  keyId: string;
  rawSecret: string;
  scopedProjectId: string;
  createdAt: Date;
}

function mapApiKeyRow(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: row.id as string,
    name: row.name as string,
    provider: row.provider as string,
    fingerprint: row.fingerprint as string,
    agentCount: (row.agent_count as number) ?? 0,
    lastUsed: formatTimestamp(row.last_used),
    monthlyCostUsd: (row.monthly_cost_usd as number) ?? 0,
    status: row.status as string,
  };
}

export async function listApiKeys(
  apiKey: ApiKeyInfo,
  _filter: ApiKeyFilter = {},
  options: ListOptions = {},
): Promise<ListEnvelope<ApiKeyRecord> & { total: number; limit: number; offset: number }> {
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
      `SELECT id, name, provider, fingerprint, agent_count, last_used,
              monthly_cost_usd, status
       FROM registered_keys
       ${where}
       ORDER BY created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM registered_keys ${where}`,
      countParams,
    ),
  ]);

  const total = (countResult.rows[0]?.total as number) ?? 0;
  const items = result.rows.map((row: Record<string, unknown>) => mapApiKeyRow(row));
  const truncated = offset + items.length < total;
  const nextOffset = truncated ? offset + items.length : null;

  return {
    ...uniformListEnvelope(items, { nextOffset, truncated }),
    total,
    limit,
    offset,
  };
}

export async function createApiKey(
  apiKey: ApiKeyInfo,
  input: CreateApiKeyInput,
  options: QueryOptions = {},
): Promise<ApiKeyRecord | null> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  const pool = getPool();
  const { name, provider, fingerprint } = input;

  const keyId = crypto.randomUUID();

  // Atomic INSERT ... ON CONFLICT eliminates TOCTOU race; the UNIQUE
  // constraint on fingerprint ensures atomicity. rowCount === 0 means the
  // fingerprint already exists.
  let result;
  if (apiKey.projectId) {
    result = await pool.query(
      `INSERT INTO registered_keys (id, project_id, name, provider, fingerprint, agent_count, last_used, monthly_cost_usd, status)
       VALUES ($1, $2, $3, $4, $5, 0, NULL, 0.0, 'active')
       ON CONFLICT (fingerprint) DO NOTHING`,
      [keyId, apiKey.projectId, name, provider, fingerprint],
    );
  } else {
    result = await pool.query(
      `INSERT INTO registered_keys (id, name, provider, fingerprint, agent_count, last_used, monthly_cost_usd, status)
       VALUES ($1, $2, $3, $4, 0, NULL, 0.0, 'active')
       ON CONFLICT (fingerprint) DO NOTHING`,
      [keyId, name, provider, fingerprint],
    );
  }

  if (result.rowCount === 0) return null;

  return {
    id: keyId,
    name,
    provider,
    fingerprint,
    agentCount: 0,
    lastUsed: null,
    monthlyCostUsd: 0,
    status: "active",
  };
}

export async function revokeApiKey(
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
    `DELETE FROM registered_keys WHERE ${conditions.join(" AND ")} RETURNING id`,
    params,
  );

  if (result.rowCount === 0) return null;
  return { id: result.rows[0].id as string };
}

export async function mintScopedKey(
  args: MintScopedKeyInput,
  options: QueryOptions = {},
): Promise<MintScopedKeyResult> {
  if (options.signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
  if (!args.projectId || args.projectId.trim().length === 0) {
    throw new Error("mintScopedKey: projectId is required");
  }
  if (!args.name || args.name.trim().length === 0) {
    throw new Error("mintScopedKey: name is required");
  }

  const pool = getPool();
  const keyId = crypto.randomUUID();
  const rawSecret = `wrt_${crypto.randomBytes(32).toString("base64url")}`;
  const keyHash = crypto.createHash("sha256").update(rawSecret).digest("hex");
  const createdAt = new Date();

  await pool.query(
    `INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm, name, scope, created_at)
     VALUES ($1, $2, $3, 60, $4, 'scoped', $5)`,
    [keyId, keyHash, args.projectId, args.name, createdAt],
  );

  await insertAuditLog(
    {
      toolName: "mintScopedKey",
      arguments: { projectId: args.projectId, name: args.name },
      responseBytes: 0,
      keyId,
      outcome: "success",
      errorMessage: null,
      requestedAt: createdAt,
    },
    options,
  );

  return {
    keyId,
    rawSecret,
    scopedProjectId: args.projectId,
    createdAt,
  };
}
