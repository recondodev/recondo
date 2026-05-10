/**
 * D-C5-4 (integration) — End-to-end `recondo_session_efficiency`.
 *
 * Spawn the binary, drive it over Streamable HTTP,
 * seed a session with multiple turns, then assert the tool returns a
 * structured efficiency record with the canonical fields:
 *
 *   {
 *     session_id,
 *     cache_hit_rate,
 *     prompt_token_reuse_ratio,
 *     tokens_per_turn: { p50, p99, mean },
 *     redundant_tool_call_count,
 *     ttft_ms: { p50, p99, mean },
 *   }
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

describeIfReady("D-C5-4 recondo_session_efficiency schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the canonical input schema", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>(
      "tools/list",
    );
    const tool = result.tools.find(
      (t) => t.name === "recondo_session_efficiency",
    );
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const schema = tool!.inputSchema ?? {};
    expect(schema.type).toBe("object");
    const required = (schema.required ?? []) as string[];
    expect(required).toContain("session_id");
  });
});

describeIfReady("D-C5-4 recondo_session_efficiency end-to-end", () => {
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

  it("returns the structured efficiency report (NOT a list envelope)", async () => {
    const sessionId = randomUUID();
    const turn1 = randomUUID();
    const turn2 = randomUUID();
    const turn3 = randomUUID();

    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turn1,
          sessionId,
          sequenceNum: 1,
          userRequestText: "first prompt",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 50,
          ttfbMs: 200,
        },
        {
          id: turn2,
          sessionId,
          sequenceNum: 2,
          // Same prompt as turn1 -> reused under hash.
          userRequestText: "first prompt",
          inputTokens: 200,
          outputTokens: 100,
          cacheReadTokens: 100,
          ttfbMs: 400,
        },
        {
          id: turn3,
          sessionId,
          sequenceNum: 3,
          userRequestText: "different prompt",
          inputTokens: 300,
          outputTokens: 150,
          cacheReadTokens: 0,
          ttfbMs: 800,
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_session_efficiency",
      arguments: { session_id: sessionId },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // Single-record return — NOT a 5-key list envelope.
    expect(env).not.toHaveProperty("items");
    expect(env).not.toHaveProperty("stream_id");
    expect(env).not.toHaveProperty("is_final");

    // Canonical efficiency shape.
    expect(env.session_id).toBe(sessionId);
    expect(typeof env.cache_hit_rate).toBe("number");
    expect(typeof env.prompt_token_reuse_ratio).toBe("number");
    expect(typeof env.redundant_tool_call_count).toBe("number");
    expect(env).toHaveProperty("tokens_per_turn");
    expect(env).toHaveProperty("ttft_ms");
    const tokensPerTurn = env.tokens_per_turn as Record<string, unknown>;
    expect(typeof tokensPerTurn.p50).toBe("number");
    expect(typeof tokensPerTurn.p99).toBe("number");
    expect(typeof tokensPerTurn.mean).toBe("number");
    const ttft = env.ttft_ms as Record<string, unknown>;
    expect(typeof ttft.p50).toBe("number");
    expect(typeof ttft.p99).toBe("number");
    expect(typeof ttft.mean).toBe("number");

    // Hash-equality reuse: 2 of 3 turns share md5(user_request_text) so
    // the reuse ratio is 2/3 ≈ 0.6667.
    expect(env.prompt_token_reuse_ratio as number).toBeGreaterThan(0);

    // Cache hit rate: SUM(cache_read_tokens)=150, SUM(input_tokens)=600
    // -> 0.25.
    expect(env.cache_hit_rate as number).toBeGreaterThan(0);
  });

  it("does NOT wrap any field in <captured_*> envelopes (metadata, not captured content)", async () => {
    const sessionId = randomUUID();
    const turn1 = randomUUID();

    if (seeded) await seeded.cleanup();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turn1,
          sessionId,
          userRequestText: "anything",
          inputTokens: 100,
          outputTokens: 50,
          ttfbMs: 250,
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_session_efficiency",
      arguments: { session_id: sessionId },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const wholeJson = JSON.stringify(env);

    expect(wholeJson).not.toContain("<captured_user_message>");
    expect(wholeJson).not.toContain("<captured_assistant_message>");
    expect(wholeJson).not.toContain("<captured_tool_use>");
  });
});
