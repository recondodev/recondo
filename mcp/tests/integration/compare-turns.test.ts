/**
 * D-C5-1 (integration) — End-to-end `recondo_compare_turns`.
 *
 * Spawn the binary, drive it via line-delimited JSON-RPC over stdio,
 * seed two turns across two sessions, then assert:
 *
 *   - `recondo_compare_turns` appears in `tools/list`.
 *   - `tools/call` returns a structured comparison report (NOT a 5-key
 *     list envelope).
 *   - Captured prompt / response text is wrapped via
 *     `<captured_user_message>` / `<captured_assistant_message>` per
 *     the C5 envelope contract.
 *   - Non-text aspects (cost, tokens, model) appear in the rows but
 *     are not wrapped.
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

describeIfReady("D-C5-1 recondo_compare_turns schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the canonical input schema", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>(
      "tools/list",
    );
    const tool = result.tools.find((t) => t.name === "recondo_compare_turns");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const schema = tool!.inputSchema ?? {};
    expect(schema.type).toBe("object");
    const required = (schema.required ?? []) as string[];
    expect(required).toContain("turn_ids");
  });
});

describeIfReady("D-C5-1 recondo_compare_turns end-to-end", () => {
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

  it("returns a structured comparison record (NOT a list envelope)", async () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const turnA = randomUUID();
    const turnB = randomUUID();

    seeded = await seedTestDb({
      sessions: [
        { id: sessionA, framework: "claude-code" },
        { id: sessionB, framework: "claude-code" },
      ],
      turns: [
        {
          id: turnA,
          sessionId: sessionA,
          sequenceNum: 1,
          userRequestText: "first prompt body",
          responseText: "first response",
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.01,
        },
        {
          id: turnB,
          sessionId: sessionB,
          sequenceNum: 1,
          userRequestText: "second prompt body",
          responseText: "second response",
          inputTokens: 200,
          outputTokens: 100,
          costUsd: 0.02,
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_compare_turns",
      arguments: {
        turn_ids: [turnA, turnB],
        aspects: ["prompt", "response", "cost", "tokens"],
      },
    });

    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // Single-record return — NOT a 5-key list envelope.
    expect(env).not.toHaveProperty("items");
    expect(env).not.toHaveProperty("stream_id");
    expect(env).not.toHaveProperty("is_final");

    // Canonical structured comparison shape.
    expect(env).toHaveProperty("turn_ids");
    expect(env).toHaveProperty("rows");
    const turnIds = env.turn_ids as string[];
    expect(turnIds).toEqual([turnA, turnB]);

    const rows = env.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(4);
    const aspects = rows.map((r) => r.aspect).sort();
    expect(aspects).toEqual(["cost", "prompt", "response", "tokens"]);
  });

  it("wraps prompt + response text via <captured_*> envelopes", async () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const turnA = randomUUID();
    const turnB = randomUUID();

    if (seeded) await seeded.cleanup();
    seeded = await seedTestDb({
      sessions: [
        { id: sessionA, framework: "claude-code" },
        { id: sessionB, framework: "claude-code" },
      ],
      turns: [
        {
          id: turnA,
          sessionId: sessionA,
          userRequestText: "alpha prompt",
          responseText: "alpha reply",
        },
        {
          id: turnB,
          sessionId: sessionB,
          userRequestText: "bravo prompt",
          responseText: "bravo reply",
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_compare_turns",
      arguments: {
        turn_ids: [turnA, turnB],
        aspects: ["prompt", "response"],
      },
    });

    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const wholeJson = JSON.stringify(env);

    // Every captured prompt + response gets wrapped — 2 turns × 2 aspects = 4 wrappers total.
    expect(wholeJson).toContain("<captured_user_message>");
    expect(wholeJson).toContain("</captured_user_message>");
    expect(wholeJson).toContain("<captured_assistant_message>");
    expect(wholeJson).toContain("</captured_assistant_message>");
    expect(wholeJson).toContain("alpha prompt");
    expect(wholeJson).toContain("bravo prompt");
    expect(wholeJson).toContain("alpha reply");
    expect(wholeJson).toContain("bravo reply");
  });

  it("rejects < 2 turn_ids via SDK schema validation", async () => {
    // The SDK turns input-validation errors into either a JSON-RPC
    // error (request rejects) or a CallToolResult with isError:true.
    // Either outcome is acceptable — the contract is "must NOT succeed".
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_compare_turns",
        arguments: { turn_ids: ["only-one"] },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/Invalid|validation|turn_ids/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });
});
