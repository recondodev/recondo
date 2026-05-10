/**
 * D-C8-3 (integration) — End-to-end `recondo_compliance`.
 *
 * Tests ALL THREE views: summary, frameworks, audit_log.
 *
 * - `frameworks` relies on the seed migration (004_compliance.sql) which
 *   already inserts SOC 2 / ISO 42001 / NIST AI RMF / GDPR rows; we don't
 *   need to seed anything extra to assert "frameworks returns rows".
 * - `summary` depends on aggregates over those frameworks + over
 *   `turns`/`sessions`/`anomaly_events`; we seed a minimal session/turn
 *   so the integrity calc is well-defined and assert the single-record
 *   shape.
 * - `audit_log` reads `compliance_audit_log` (control-status mutation
 *   history), which is DISTINCT from the per-call MCP `audit_log` table
 *   written by `insertAuditLog` (C13-7 covers the latter). We INSERT a
 *   row into `compliance_audit_log` directly under GDPR bypass NOT
 *   required (it is not part of the captured-tables append-only set).
 *
 * Also confirms the restored `recondo_insights` tool appears in
 * `tools/list`; the detailed insight behavior lives in the dedicated
 * insights tests.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";
import { seedTestDb, truncateCapturedTables } from "../helpers/seed.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function extractEnvelope(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  if (result.content && result.content.length > 0) {
    const first = result.content[0];
    if (first?.type === "text" && typeof first.text === "string") {
      return JSON.parse(first.text) as Record<string, unknown>;
    }
  }
  throw new Error(
    `tool result missing envelope payload: ${JSON.stringify(result).slice(0, 400)}`,
  );
}

function expectListEnvelope(env: Record<string, unknown>): void {
  expect(env).toHaveProperty("items");
  expect(env).toHaveProperty("next_offset");
  expect(env).toHaveProperty("truncated");
  expect(env).toHaveProperty("stream_id");
  expect(env).toHaveProperty("is_final");
  expect(env.is_final).toBe(true);
  expect(env.stream_id).toBeNull();
  expect(Array.isArray(env.items)).toBe(true);
}

describeIfReady("D-C8-3 recondo_compliance schema discovery + insights registration", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the 3-member view enum", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_compliance");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const props = (tool!.inputSchema?.properties ?? {}) as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(props.view).toBeDefined();
    if (Array.isArray(props.view?.enum)) {
      const members = props.view.enum.slice().sort();
      expect(members).toEqual(["audit_log", "frameworks", "summary"]);
    }
  });

  it("advertises the restored `recondo_insights` tool", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_insights");
    expect(tool).toBeDefined();
    expect((tool?.description ?? "").length).toBeGreaterThanOrEqual(50);
  });
});

describeIfReady("D-C8-3 recondo_compliance integration — all 3 views", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;
  const auditId = `audit-${randomUUID()}`;
  const controlId = `ctrl-${randomUUID()}`;
  const sessionId = randomUUID();

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          sessionId,
          sequenceNum: 1,
          httpStatus: 200,
          captureComplete: true,
        },
      ],
    });

    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO compliance_audit_log (id, control_id, old_status, new_status, changed_by, changed_at, reason)
       VALUES ($1, $2, $3, $4, $5, now(), $6)`,
      [auditId, controlId, "IN_PROGRESS", "MET", "test-user", "evidence reviewed"],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM compliance_audit_log WHERE id = $1`, [auditId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
    if (seeded) await seeded.cleanup();
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed
    }
  });

  it("view=summary returns a single record (NOT a list envelope)", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_compliance",
      arguments: { view: "summary" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    // Single-record shape.
    expect(env).not.toHaveProperty("items");
    expect(env).toHaveProperty("overallScore");
    expect(env).toHaveProperty("captureIntegrity");
    expect(env).toHaveProperty("findingsBySeverity");
  });

  it("view=frameworks returns a 5-key list envelope with seed frameworks", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_compliance",
      arguments: { view: "frameworks" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    // Migration 004 seeds at least SOC 2 Type II.
    expect(JSON.stringify(env)).toContain("SOC 2 Type II");
  });

  it("view=audit_log returns a 5-key list envelope reading `compliance_audit_log`", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_compliance",
      arguments: { view: "audit_log" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    // Our inserted control-status mutation should appear.
    expect(JSON.stringify(env)).toContain(auditId);
    expect(JSON.stringify(env)).toContain(controlId);
  });

  it("rejects bogus view values at the schema layer", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_compliance",
        arguments: { view: "findings" },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/(?:Invalid|validation|view)/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });
});
