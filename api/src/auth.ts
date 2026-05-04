import { createHash } from "crypto";
import { getPool } from "./db.js";
import type { ApiKeyInfo } from "./context.js";

/**
 * Extract and validate the API key from the Authorization header.
 *
 * Expected format: `Authorization: Bearer wrt_...`
 *
 * Returns the ApiKeyInfo if valid, or null if authentication fails.
 */
export async function authenticateRequest(
  authHeader: string | undefined | null
): Promise<ApiKeyInfo | null> {
  if (!authHeader) return null;

  // W8: Case-insensitive "Bearer " check
  if (!authHeader.toLowerCase().startsWith("bearer ")) return null;

  const token = authHeader.slice(7).trim();
  if (!token) return null;

  // Token must start with wrt_ prefix
  if (!token.startsWith("wrt_")) return null;

  // Hash the token to look up in the database
  const keyHash = createHash("sha256").update(token).digest("hex");

  const pool = getPool();
  const result = await pool.query(
    `SELECT id, project_id, rate_limit_rpm, revoked_at
     FROM api_keys
     WHERE key_hash = $1`,
    [keyHash]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];

  // Check if key is revoked
  if (row.revoked_at !== null) return null;

  return {
    id: row.id,
    projectId: row.project_id, // null for admin keys
    rateLimitRpm: row.rate_limit_rpm,
  };
}
