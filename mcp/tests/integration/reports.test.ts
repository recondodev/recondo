/**
 * D-C8-5 (integration) — End-to-end `recondo_reports`.
 *
 * Insert a row into `reports` directly (no captured-table append-only
 * trigger applies), then call `tools/call recondo_reports` and assert
 * the canonical 5-key list envelope contains the row.
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

describeIfReady("D-C8-5 recondo_reports schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with description >= 50 chars", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_reports");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
  });
});

describeIfReady("D-C8-5 recondo_reports integration", () => {
  let mcp: SpawnedMcp;
  const reportId = `rep-${randomUUID()}`;
  const reportName = `Test Report ${reportId}`;

  beforeAll(async () => {
    mcp = await spawnMcp({});
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO reports (id, name, framework, period_start, period_end, capture_count,
                            findings_critical, findings_high, findings_medium, findings_low,
                            hash, status, generated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())`,
      [
        reportId,
        reportName,
        "SOC 2",
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        new Date().toISOString(),
        100,
        0,
        1,
        2,
        3,
        "test-hash",
        "FINAL",
      ],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM reports WHERE id = $1`, [reportId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("returns a 5-key envelope referencing the seeded report", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_reports",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(reportId);
    expect(JSON.stringify(env)).toContain(reportName);
  });
});
