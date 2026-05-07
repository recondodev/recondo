/**
 * D-C6-3 (integration) — End-to-end `recondo_usage_summary`.
 *
 * Spawn the binary, seed a session + turn with cost data, call
 * `tools/call recondo_usage_summary`, and assert the structured summary
 * record reflects the seeded values.
 *
 * Also covers `tools/list` discovery: the tool's input schema exposes
 * `period` (enum, default "week") and the description >= 50 chars.
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * + the mcp build is fresh (`pnpm --filter recondo-mcp run build`).
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

describeIfReady("D-C6-3 recondo_usage_summary schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with `period` enum default `week`", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_usage_summary");
    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const schema = tool!.inputSchema ?? {};
    const props = (schema.properties ?? {}) as Record<
      string,
      { type?: unknown; default?: unknown; enum?: unknown[] }
    >;
    expect(props.period).toBeDefined();
    expect(props.period?.default).toBe("week");
    if (Array.isArray(props.period?.enum)) {
      expect(props.period.enum).toContain("week");
      expect(props.period.enum).toContain("day");
      expect(props.period.enum).toContain("month");
    }
  });
});

describeIfReady("D-C6-3 recondo_usage_summary integration", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
    if (seeded) await seeded.cleanup();
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed
    }
  });

  it("returns the structured summary record reflecting seeded cost", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: 1.23,
          httpStatus: 200,
          captureComplete: true,
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_usage_summary",
      arguments: { period: "week" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // Single-record shape (NOT a list envelope).
    expect(env).not.toHaveProperty("items");
    expect(env).not.toHaveProperty("stream_id");

    // Pull totalCostUsd in either snake_case or camelCase form.
    const totalCost = env.totalCostUsd ?? env.total_cost_usd;
    expect(typeof totalCost).toBe("number");
    expect(totalCost as number).toBeGreaterThanOrEqual(1.23 - 1e-9);
  });

  it("default period (omitted) returns a valid summary", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_usage_summary",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expect(typeof env).toBe("object");
    // Some recognisable summary field is present.
    const hasSummaryField =
      "totalCostUsd" in env ||
      "total_cost_usd" in env ||
      "developerCount" in env ||
      "developer_count" in env;
    expect(hasSummaryField).toBe(true);
  });

  it("rejects bogus period values at the schema layer", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_usage_summary",
        arguments: { period: "BOGUS" },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/(?:Invalid|validation|period)/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });
});
