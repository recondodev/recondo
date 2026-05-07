/**
 * D-C6-4 (integration) — End-to-end `recondo_spend`.
 *
 * Spawn the binary, seed a session + turn with provider/model/framework
 * + cost, then call `tools/call recondo_spend` with each of the 4
 * group_by values. Each call returns a 5-key list envelope with at
 * least one bucket reflecting the seeded data.
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

describeIfReady("D-C6-4 recondo_spend schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the 4-member group_by enum", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_spend");
    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const schema = tool!.inputSchema ?? {};
    const props = (schema.properties ?? {}) as Record<
      string,
      { type?: unknown; enum?: unknown[] }
    >;
    expect(props.group_by).toBeDefined();
    if (Array.isArray(props.group_by?.enum)) {
      const members = props.group_by.enum.slice().sort();
      expect(members).toEqual(["daily", "framework", "model", "provider"]);
    }
  });
});

describeIfReady("D-C6-4 recondo_spend integration — dispatch under all 4 group_by values", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({});
    const sessionId = randomUUID();
    const turnId = randomUUID();
    seeded = await seedTestDb({
      sessions: [
        {
          id: sessionId,
          framework: "claude-code",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
        },
      ],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 1.5,
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

  it("group_by=provider returns a bucket for `anthropic`", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_spend",
      arguments: { group_by: "provider" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain("anthropic");
  });

  it("group_by=model returns a bucket for the seeded model", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_spend",
      arguments: { group_by: "model" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain("claude-sonnet-4-20250514");
  });

  it("group_by=framework returns a bucket for `claude-code`", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_spend",
      arguments: { group_by: "framework" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain("claude-code");
  });

  it("group_by=daily returns a bucket whose name is a YYYY-MM-DD day", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_spend",
      arguments: { group_by: "daily" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);

    const items = env.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    const dayName = items[0].name as string;
    expect(typeof dayName).toBe("string");
    expect(dayName).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("rejects bogus group_by values at the schema layer", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_spend",
        arguments: { group_by: "session" },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/(?:Invalid|validation|group_by)/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });
});
