import { getPool } from "./db.js";

export interface AuditEntry {
  apiKeyId: string;
  userId?: string | null;
  queryType: string;
  resourceIds?: string[];
  sourceIp: string;
  userAgent: string;
  responseStatus: number;
}

/**
 * Insert an audit log entry into the access_audit_log table.
 * This is append-only — the table has triggers preventing UPDATE/DELETE.
 *
 * W1: If the INSERT fails, we log a structured error AND write to stderr.
 * We do NOT fail the request (availability > audit logging), but the failure
 * is observable via stderr and structured logging.
 *
 * W2: source_ip is stored as TEXT (not INET) to avoid parse failures from
 * crafted X-Forwarded-For headers. The IP is validated before reaching here
 * but we store as TEXT for defense-in-depth.
 */
export async function logAuditEntry(entry: AuditEntry): Promise<void> {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO access_audit_log
        (api_key_id, user_id, query_type, resource_ids, source_ip, user_agent, response_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.apiKeyId,
        entry.userId ?? null,
        entry.queryType,
        entry.resourceIds ?? null,
        entry.sourceIp,
        entry.userAgent || null,
        entry.responseStatus,
      ]
    );
  } catch (err) {
    // W1: Structured error logging — ensure failure is observable
    const structured = {
      level: "error",
      component: "audit",
      message: "Failed to write audit log entry",
      apiKeyId: entry.apiKeyId,
      queryType: entry.queryType,
      responseStatus: entry.responseStatus,
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    };
    // Write structured JSON to stderr as a fallback
    process.stderr.write(JSON.stringify(structured) + "\n");
    // Also log via console.error for standard error stream
    console.error("AUDIT_LOG_INSERT_FAILURE:", structured);
  }
}
