/**
 * D-C1-8 (DB integration) — insertAuditLog round-trip + immutability.
 *
 * Preconditions:
 *   - `just dev-infra` running.
 *   - `just api-migrate` has applied migrations 013 and 016.
 *
 * Asserts:
 *   - INSERT round-trips a row.
 *   - UPDATE on `audit_log` raises (PI1 immutability trigger).
 *   - DELETE on `audit_log` raises.
 *
 * audit_log is observability (not GDPR-bypassed). Test uses a unique
 * tool_name so re-runs don't conflate rows.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const describeIfDb = HAVE_DB ? describe : describe.skip;

describeIfDb("D-C1-8 insertAuditLog DB integration", () => {
  let getPool: typeof import("@recondo/data").getPool;
  let closePool: typeof import("@recondo/data").closePool;
  let insertAuditLog: typeof import("@recondo/data").insertAuditLog;
  let toolName: string;

  beforeAll(async () => {
    const data = await import("@recondo/data");
    getPool = data.getPool;
    closePool = data.closePool;
    // insertAuditLog is being added in C1; the import will fail at
    // type-check + runtime until the export exists. That's the point —
    // this test goes red until C1 is implemented.
    insertAuditLog = (data as unknown as {
      insertAuditLog: typeof import("@recondo/data").insertAuditLog;
    }).insertAuditLog;
    toolName = `unit-test-${randomUUID()}`;
  });

  afterAll(async () => {
    if (closePool) await closePool();
  });

  it("INSERT round-trip: inserted row appears in audit_log", async () => {
    await insertAuditLog({
      toolName,
      arguments: { x: 1 },
      responseBytes: 42,
      clientName: "vitest",
      keyId: "dev-bypass",
    });

    const pool = getPool();
    const result = await pool.query(
      `SELECT tool_name, arguments, response_bytes, client_name, key_id, outcome, error_message
       FROM audit_log
       WHERE tool_name = $1
       ORDER BY requested_at DESC
       LIMIT 1`,
      [toolName],
    );
    expect(result.rows.length).toBe(1);
    const row = result.rows[0];
    expect(row.tool_name).toBe(toolName);
    expect(row.arguments).toEqual({ x: 1 });
    expect(Number(row.response_bytes)).toBe(42);
    expect(row.client_name).toBe("vitest");
    expect(row.key_id).toBe("dev-bypass");
    expect(row.outcome).toBe("success");
    expect(row.error_message).toBeNull();
  });

  it("INSERT round-trip: explicit error outcome appears in audit_log", async () => {
    const errorToolName = `${toolName}-error`;
    await insertAuditLog({
      toolName: errorToolName,
      arguments: { x: 2 },
      responseBytes: 0,
      clientName: "vitest",
      keyId: "dev-bypass",
      outcome: "error",
      errorMessage: "synthetic failure",
    });

    const pool = getPool();
    const result = await pool.query(
      `SELECT outcome, error_message, response_bytes
       FROM audit_log
       WHERE tool_name = $1
       ORDER BY requested_at DESC
       LIMIT 1`,
      [errorToolName],
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].outcome).toBe("error");
    expect(result.rows[0].error_message).toBe("synthetic failure");
    expect(Number(result.rows[0].response_bytes)).toBe(0);
  });

  it("UPDATE raises the immutability trigger", async () => {
    const pool = getPool();
    await expect(
      pool.query(`UPDATE audit_log SET tool_name = 'changed' WHERE tool_name = $1`, [
        toolName,
      ]),
    ).rejects.toThrow();
  });

  it("DELETE raises the immutability trigger", async () => {
    const pool = getPool();
    await expect(
      pool.query(`DELETE FROM audit_log WHERE tool_name = $1`, [toolName]),
    ).rejects.toThrow();
  });
});
