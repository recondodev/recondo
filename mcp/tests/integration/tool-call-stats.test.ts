/**
 * D-C7-4 (integration) — End-to-end `recondo_tool_call_stats`.
 *
 * Seed a session + turn + tool_calls with `duration_ms` set (CRITICAL —
 * the field that backs `total_duration_ms`). Spawn the binary, call the
 * tool with each of the 3 group_by values, and assert:
 *
 *   1. The 5-key list envelope is returned.
 *   2. The seeded `tool_name` / `session_id` / `framework` is present
 *      in the corresponding response.
 *   3. `total_duration_ms` is preserved on the wire (Plan D drift pin).
 *   4. `token_cost_total` is NEVER on the wire (Plan D drift pin).
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

describeIfReady("D-C7-4 recondo_tool_call_stats schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the 3-member group_by enum", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>(
      "tools/list",
    );
    const tool = result.tools.find(
      (t) => t.name === "recondo_tool_call_stats",
    );
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const props = (tool!.inputSchema?.properties ?? {}) as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(props.group_by).toBeDefined();
    if (Array.isArray(props.group_by?.enum)) {
      const members = props.group_by.enum.slice().sort();
      expect(members).toEqual(["framework", "session", "tool_name"]);
    }
  });
});

describeIfReady("D-C7-4 recondo_tool_call_stats integration — all 3 group_by values", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const toolName = "ReadIntegration";

  beforeAll(async () => {
    mcp = await spawnMcp({});
    seeded = await seedTestDb({
      sessions: [
        {
          id: sessionId,
          framework: "claude-code",
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
      toolCalls: [
        {
          turnId,
          toolName,
          status: "success",
          durationMs: 250,
        },
        {
          turnId,
          toolName,
          status: "success",
          durationMs: 750,
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

  it("group_by=tool_name returns a row whose group_key is the seeded tool", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_tool_call_stats",
      arguments: { group_by: "tool_name" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(toolName);
  });

  it("group_by=session returns a row keyed by the seeded session id", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_tool_call_stats",
      arguments: { group_by: "session" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(sessionId);
  });

  it("group_by=framework returns a row keyed by the seeded framework", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_tool_call_stats",
      arguments: { group_by: "framework" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain("claude-code");
  });

  it("preserves `total_duration_ms` on the wire (Plan D drift pin)", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_tool_call_stats",
      arguments: { group_by: "tool_name" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const wholeJson = JSON.stringify(env);
    // The handler may camelCase or snake_case the field on the wire —
    // accept either form. The contract is "duration is surfaced".
    const hasDuration =
      /\btotal_duration_ms\b/.test(wholeJson) ||
      /\btotalDurationMs\b/.test(wholeJson);
    expect(hasDuration).toBe(true);

    // Sum of seeded durations is 250 + 750 = 1000ms. Pin the value.
    const items = env.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    const found = items.find((r) => {
      const dur = r.total_duration_ms ?? r.totalDurationMs;
      return Number(dur) === 1000;
    });
    expect(found, `expected a row with total_duration_ms === 1000`).toBeDefined();
  });

  it("NEVER emits `token_cost_total` on the wire (Plan D drift pin)", async () => {
    for (const group_by of ["tool_name", "session", "framework"] as const) {
      const result = await mcp.request<CallToolResult>("tools/call", {
        name: "recondo_tool_call_stats",
        arguments: { group_by },
      });
      expect(result.isError).not.toBe(true);
      const wholeJson = JSON.stringify(extractEnvelope(result));
      expect(wholeJson).not.toContain("token_cost_total");
    }
  });

  it("rejects bogus group_by values at the schema layer", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_tool_call_stats",
        arguments: { group_by: "developer" },
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
