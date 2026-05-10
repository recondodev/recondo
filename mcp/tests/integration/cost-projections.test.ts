/**
 * D-C6-5 (integration) — End-to-end `recondo_cost_projections`.
 *
 * Spawn the binary, call `tools/call recondo_cost_projections`, and
 * assert the response carries the 3-element projection list (Jun/Jul/Aug
 * style — months are dynamic, but the count is fixed at 3 per
 * cost.ts:387).
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

function extractEnvelope(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  if (result.content && result.content.length > 0) {
    const first = result.content[0];
    if (first?.type === "text" && typeof first.text === "string") {
      return JSON.parse(first.text);
    }
  }
  throw new Error(
    `tool result missing payload: ${JSON.stringify(result).slice(0, 400)}`,
  );
}

describeIfReady("D-C6-5 recondo_cost_projections schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with optional `period` and >=50 char description", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_cost_projections");
    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const schema = tool!.inputSchema ?? {};
    const props = (schema.properties ?? {}) as Record<string, unknown>;
    // period is optional (NOT required).
    const required = schema.required ?? [];
    expect(Array.isArray(required)).toBe(true);
    expect(required as string[]).not.toContain("period");
    // Period field is exposed in the schema (even if optional).
    expect("period" in props).toBe(true);
  });
});

describeIfReady("D-C6-5 recondo_cost_projections integration", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
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
          costUsd: 1.0,
          httpStatus: 200,
          captureComplete: true,
        },
      ],
    });
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

  it("returns 3 projection rows on a seeded baseline", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_cost_projections",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const payload = extractEnvelope(result) as unknown;

    // Two acceptable shapes:
    //  (a) the array verbatim
    //  (b) { projections: [...] }
    const list = Array.isArray(payload)
      ? payload
      : ((payload as Record<string, unknown>).projections as unknown[]);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(3);

    const first = list[0] as Record<string, unknown>;
    expect(typeof first.month).toBe("string");
    expect(first.month as string).toMatch(/^\d{4}-\d{2}$/);
    // Either snake_case or camelCase form for the cost field.
    const projectedCost =
      (first.projectedCostUsd as number | undefined) ??
      (first.projected_cost_usd as number | undefined);
    expect(typeof projectedCost).toBe("number");
  });

  it("accepts `period` argument and still returns 3 projections", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_cost_projections",
      arguments: { period: "month" },
    });
    expect(result.isError).not.toBe(true);
    const payload = extractEnvelope(result) as unknown;
    const list = Array.isArray(payload)
      ? payload
      : ((payload as Record<string, unknown>).projections as unknown[]);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(3);
  });
});
