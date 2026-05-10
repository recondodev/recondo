/**
 * D-C7-2 (integration) — End-to-end `recondo_agent_framework_distribution`.
 *
 * Spawn the binary, seed sessions across different frameworks, then
 * call `tools/call recondo_agent_framework_distribution` and assert
 * the response is a 5-key list envelope with at least one usage row.
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

describeIfReady("D-C7-2 recondo_agent_framework_distribution schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with >=50 char description", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>(
      "tools/list",
    );
    const tool = result.tools.find(
      (t) => t.name === "recondo_agent_framework_distribution",
    );
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
    expect(tool!.inputSchema?.type).toBe("object");
  });
});

describeIfReady("D-C7-2 recondo_agent_framework_distribution integration — list envelope", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
    const sessionId = randomUUID();
    const turnId = randomUUID();
    seeded = await seedTestDb({
      sessions: [
        {
          id: sessionId,
          framework: "claude-code",
          totalCostUsd: 1.23,
        },
      ],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
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

  it("returns the 5-key list envelope with a `claude-code` usage row", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_agent_framework_distribution",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);

    expect(JSON.stringify(env)).toContain("claude-code");
  });
});
