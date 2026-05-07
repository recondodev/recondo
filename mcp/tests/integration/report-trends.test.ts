/**
 * D-C8-6 (integration) — End-to-end `recondo_report_trends`.
 *
 * Tests BOTH metrics: coverage and findings.
 *
 * - `coverage` reads `report_coverage`; we INSERT a labeled row.
 * - `findings` reads `reports` (label = report.name, value = sum of
 *   findings_* columns); we INSERT a labeled report.
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

describeIfReady("D-C8-6 recondo_report_trends schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the 2-member metric enum", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_report_trends");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const props = (tool!.inputSchema?.properties ?? {}) as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(props.metric).toBeDefined();
    if (Array.isArray(props.metric?.enum)) {
      const members = props.metric.enum.slice().sort();
      expect(members).toEqual(["coverage", "findings"]);
    }
  });
});

describeIfReady("D-C8-6 recondo_report_trends integration — both metrics", () => {
  let mcp: SpawnedMcp;
  const coverageLabel = `cov-${randomUUID()}`;
  const reportId = `rep-trend-${randomUUID()}`;
  const reportName = `Trend Report ${reportId}`;

  beforeAll(async () => {
    mcp = await spawnMcp({});
    const { getPool } = await import("@recondo/data");
    const pool = getPool();

    // report_coverage row for the coverage trend.
    await pool.query(
      `INSERT INTO report_coverage (id, report_id, label, value)
       VALUES ($1, NULL, $2, $3)`,
      [randomUUID(), coverageLabel, 87.5],
    );

    // A reports row for the findings trend (label is the report name).
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
        1,
        2,
        3,
        4,
        "trend-hash",
        "FINAL",
      ],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM report_coverage WHERE label = $1`, [coverageLabel]);
      await pool.query(`DELETE FROM reports WHERE id = $1`, [reportId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("metric=coverage returns a 5-key envelope referencing the seeded label", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_report_trends",
      arguments: { metric: "coverage" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(coverageLabel);
  });

  it("metric=findings returns a 5-key envelope referencing the seeded report", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_report_trends",
      arguments: { metric: "findings" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(reportName);
  });

  it("rejects bogus metric values at the schema layer", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_report_trends",
        arguments: { metric: "spend" },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/(?:Invalid|validation|metric)/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });
});
