/**
 * D-C6-2 (integration) — End-to-end `recondo_realtime_feed`.
 *
 * Spawn the binary, seed a session + a turn within the live window,
 * call `tools/call recondo_realtime_feed`, and assert the seeded turn
 * surfaces in the canonical 5-key list envelope. The grouping CTEs
 * collapse into 1 group per (session, distinct user_request_text).
 *
 * Also covers `tools/list` discovery: the tool's input schema exposes
 * `since` / `limit` / `offset`, the description >= 50 chars and
 * mentions the polling cadence ("30").
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

describeIfReady("D-C6-2 recondo_realtime_feed schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the canonical input schema + cadence in description", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_realtime_feed");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
    expect(tool!.description).toContain("30");

    const schema = tool!.inputSchema ?? {};
    const props = (schema.properties ?? {}) as Record<string, { type?: unknown }>;
    expect(props.since).toBeDefined();
    expect(props.since?.type).toBe("string");
    expect(props.limit).toBeDefined();
    expect(props.offset).toBeDefined();
  });
});

describeIfReady("D-C6-2 recondo_realtime_feed integration", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
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

  it("returns the seeded turn in a 5-key list envelope", async () => {
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const tag = `feed-token-${randomUUID()}`;

    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
          userRequestText: tag,
          responseText: "ack",
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.01,
          httpStatus: 200,
          captureComplete: true,
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_realtime_feed",
      arguments: { limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("next_offset");
    expect(env).toHaveProperty("truncated");
    expect(env).toHaveProperty("stream_id");
    expect(env).toHaveProperty("is_final");
    expect(env.is_final).toBe(true);
    expect(env.stream_id).toBeNull();

    const items = env.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    const wholeJson = JSON.stringify(env);
    // Seeded session shows up.
    expect(wholeJson).toContain(sessionId);
  });

  it("accepts a far-future `since` cursor and returns an empty page", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_realtime_feed",
      arguments: { since: "2099-01-01T00:00:00Z", limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expect(Array.isArray(env.items)).toBe(true);
    expect((env.items as unknown[]).length).toBe(0);
    expect(env.is_final).toBe(true);
  });

  it("returns a usable next_offset that advances to new feed rows", async () => {
    const sessionId = randomUUID();
    const turns = Array.from({ length: 7 }, (_, i) => ({
      id: randomUUID(),
      sessionId,
      sequenceNum: i + 1,
      timestamp: `2026-05-07T00:00:0${i}.000Z`,
      userRequestText: `feed cursor prompt ${i}`,
      responseText: "ack",
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01,
      httpStatus: 200,
      captureComplete: true,
    }));

    if (seeded) await seeded.cleanup();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns,
    });

    const first = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_realtime_feed",
      arguments: { limit: 2 },
    });
    expect(first.isError).not.toBe(true);
    const env1 = extractEnvelope(first);
    expect(env1.next_offset).toBe(2);
    expect(env1.truncated).toBe(true);

    const second = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_realtime_feed",
      arguments: { limit: 2, offset: 2 },
    });
    expect(second.isError).not.toBe(true);
    const env2 = extractEnvelope(second);
    const ids1 = new Set(
      (env1.items as Array<{ user_turn_id: string }>).map(
        (item) => item.user_turn_id,
      ),
    );
    const ids2 = (env2.items as Array<{ user_turn_id: string }>).map(
      (item) => item.user_turn_id,
    );
    expect(ids2.some((id) => ids1.has(id))).toBe(false);

    const final = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_realtime_feed",
      arguments: { limit: 2, offset: 6 },
    });
    expect(final.isError).not.toBe(true);
    const env3 = extractEnvelope(final);
    expect((env3.items as unknown[]).length).toBe(1);
    expect(env3.next_offset).toBeNull();
    expect(env3.truncated).toBe(false);
  });
});
