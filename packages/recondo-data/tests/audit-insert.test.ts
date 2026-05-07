/**
 * Unit tests for the new `insertAuditLog` export added to @recondo/data
 * as part of MCP v1 (D-C1-8 / D-C0-2).
 *
 * Mirrors the harness style of `audit.test.ts` (real pool, but spies on
 * pool.query to capture the SQL emitted). The integration test in
 * mcp/tests/integration/audit-log-table.test.ts asserts the live DB
 * round-trip; this file asserts the SQL shape and AbortSignal contract.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { insertAuditLog } from "../src/index.js";
import { getPool, closePool } from "../src/pool.js";

afterAll(async () => {
  await closePool();
});

describe("@recondo/data: insertAuditLog (D-C1-8)", () => {
  it("issues an INSERT INTO audit_log with the expected columns", async () => {
    const pool = getPool();
    const spy = vi
      .spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await insertAuditLog({
      toolName: "x",
      arguments: { a: 1 },
      responseBytes: 0,
      clientName: null,
      keyId: null,
    });
    const sqlStrings = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(sqlStrings).toMatch(/INSERT\s+INTO\s+audit_log/i);
    expect(sqlStrings).toMatch(/tool_name/);
    expect(sqlStrings).toMatch(/arguments/);
    expect(sqlStrings).toMatch(/response_bytes/);
    expect(sqlStrings).toMatch(/client_name/);
    expect(sqlStrings).toMatch(/key_id/);
    spy.mockRestore();
  });

  it("omits requested_at when not provided (lets the DB default fire)", async () => {
    const pool = getPool();
    const spy = vi
      .spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    await insertAuditLog({
      toolName: "x",
      arguments: {},
      responseBytes: 0,
    });
    const sql = spy.mock.calls.map((c) => String(c[0])).join("\n");
    // SQL does not mention requested_at when not provided — DB DEFAULT
    // now() fires server-side.
    expect(sql).not.toMatch(/requested_at/);
    spy.mockRestore();
  });

  it("includes requested_at when explicitly provided", async () => {
    const pool = getPool();
    const spy = vi
      .spyOn(pool, "query")
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    const ts = new Date("2026-05-07T12:00:00.000Z");
    await insertAuditLog({
      toolName: "x",
      arguments: {},
      responseBytes: 0,
      requestedAt: ts,
    });
    const sql = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(sql).toMatch(/requested_at/);
    const params = spy.mock.calls[0][1] as unknown[];
    expect(params).toContain(ts);
    spy.mockRestore();
  });

  it("honors options.signal — pre-aborted signal throws AbortError before DB call", async () => {
    const pool = getPool();
    const spy = vi.spyOn(pool, "query");
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      insertAuditLog(
        {
          toolName: "x",
          arguments: {},
          responseBytes: 0,
        },
        { signal: ctrl.signal },
      ),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
