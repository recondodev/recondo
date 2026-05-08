/**
 * D-C13-7 (integration) — Audit log row written on every tool call.
 *
 * Spawn the binary with dev-bypass, call `recondo_usage_summary`, and
 * verify the `audit_log` table has exactly ONE matching row with the
 * canonical fields:
 *
 *   - tool_name="recondo_usage_summary"
 *   - arguments JSONB matches the call args
 *   - response_bytes > 0
 *   - outcome="success"
 *   - error_message IS NULL
 *   - key_id="dev-bypass"
 *   - requested_at within the last 60 seconds
 *
 * The audit row uses a unique synthetic argument so the assertion can
 * isolate THIS call's row from any other audit_log activity in the DB.
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * + the mcp build is fresh.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

describeIfReady("D-C13-7 audit_log row written on tool call", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("recondo_usage_summary writes a single audit_log row with the expected fields", async () => {
    // Use the read-tool that has the smallest argument surface and
    // is well-defined across builds — usage_summary takes period as
    // an enum. We can't set a "synthetic argument" because the input
    // schema validates strictly, but we CAN identify the row by the
    // tool_name + the exact requested_at window. To make the test
    // robust against parallel test rows, we capture the count of rows
    // for this tool BEFORE the call and assert exactly one new row
    // appears AFTER.
    const { getPool } = await import("@recondo/data");
    const pool = getPool();

    const before = await pool.query(
      `SELECT COUNT(*)::bigint AS c FROM audit_log
       WHERE tool_name = $1`,
      ["recondo_usage_summary"],
    );
    const beforeCount = Number(before.rows[0]?.c ?? 0);

    const t0 = Date.now();
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_usage_summary",
      arguments: { period: "week" },
    });
    expect(result.isError).not.toBe(true);

    const after = await pool.query(
      `SELECT tool_name, arguments, response_bytes, key_id, requested_at, outcome, error_message
       FROM audit_log
       WHERE tool_name = $1
       ORDER BY requested_at DESC
       LIMIT 1`,
      ["recondo_usage_summary"],
    );

    const afterCount = await pool.query(
      `SELECT COUNT(*)::bigint AS c FROM audit_log
       WHERE tool_name = $1`,
      ["recondo_usage_summary"],
    );
    expect(Number(afterCount.rows[0]?.c ?? 0)).toBe(beforeCount + 1);

    expect(after.rows.length).toBe(1);
    const row = after.rows[0];
    expect(row.tool_name).toBe("recondo_usage_summary");
    expect(row.key_id).toBe("dev-bypass");
    expect(Number(row.response_bytes)).toBeGreaterThan(0);
    expect(row.outcome).toBe("success");
    expect(row.error_message).toBeNull();
    // arguments column is JSONB — node-postgres returns a JS object.
    // The shape MUST contain `period: "week"` (the request args we sent).
    // Defensive: the audit writer may receive the post-default-applied
    // args, so we accept either the raw shape or the schema-applied one.
    const args = row.arguments as Record<string, unknown>;
    expect(args).toBeDefined();
    expect(args.period).toBe("week");

    // requested_at within the last 60 seconds (and not in the future).
    const requestedAtMs = new Date(row.requested_at as string | Date).getTime();
    expect(requestedAtMs).toBeGreaterThan(t0 - 60_000);
    expect(requestedAtMs).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("read-tool handler failure writes an error audit_log row", async () => {
    const { getPool } = await import("@recondo/data");
    const pool = getPool();

    const before = await pool.query(
      `SELECT COUNT(*)::bigint AS c FROM audit_log
       WHERE tool_name = $1`,
      ["recondo_find_similar_prompts"],
    );
    const beforeCount = Number(before.rows[0]?.c ?? 0);

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_find_similar_prompts",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain(
      "exactly one of turn_id or text must be provided",
    );

    const after = await pool.query(
      `SELECT outcome, error_message, response_bytes
       FROM audit_log
       WHERE tool_name = $1
       ORDER BY requested_at DESC
       LIMIT 1`,
      ["recondo_find_similar_prompts"],
    );
    const afterCount = await pool.query(
      `SELECT COUNT(*)::bigint AS c FROM audit_log
       WHERE tool_name = $1`,
      ["recondo_find_similar_prompts"],
    );

    expect(Number(afterCount.rows[0]?.c ?? 0)).toBe(beforeCount + 1);
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].outcome).toBe("error");
    expect(after.rows[0].error_message).toContain(
      "exactly one of turn_id or text must be provided",
    );
    expect(Number(after.rows[0].response_bytes)).toBe(0);
  });
});
