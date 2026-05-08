/**
 * D-C5-2 (integration) — End-to-end `recondo_find_similar_prompts`.
 *
 * Spawn the binary, drive it via line-delimited JSON-RPC over stdio,
 * seed two turns whose `user_request_text` is byte-identical (so their
 * md5 hashes match), then assert the tool returns the OTHER turn as a
 * match (self-exclusion when input is a turn id).
 *
 * Also exercises the `{text}` shape: pass the literal user_request_text
 * value and assert at least one matching turn is returned.
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

describeIfReady("D-C5-2 recondo_find_similar_prompts end-to-end", () => {
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

  it("turn_id input: returns the byte-identical peer (self-excluded)", async () => {
    const sessionId = randomUUID();
    const turnA = randomUUID();
    const turnB = randomUUID();
    // Distinct tag per run so the byte-identical match is unambiguous.
    const sharedPrompt = `find-me-twin-token-${randomUUID()}`;

    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnA,
          sessionId,
          sequenceNum: 1,
          userRequestText: sharedPrompt,
          responseText: "first reply",
        },
        {
          id: turnB,
          sessionId,
          sequenceNum: 2,
          userRequestText: sharedPrompt,
          responseText: "second reply",
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_find_similar_prompts",
      arguments: { turn_id: turnA, limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // 5-key list envelope.
    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("next_offset");
    expect(env).toHaveProperty("truncated");
    expect(env).toHaveProperty("stream_id");
    expect(env).toHaveProperty("is_final");
    expect(env.is_final).toBe(true);

    const items = env.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    const wholeJson = JSON.stringify(env);
    // The peer turn surfaces; the self turn is excluded.
    expect(wholeJson).toContain(turnB);
    // Self-exclusion: turnA's id should NOT appear as a `from_turn_id`
    // value (it could appear elsewhere — only assert it isn't a match
    // by checking it doesn't appear under a `from_turn_id` field).
    const matchTurnIds = items
      .map((i) => i.from_turn_id ?? i.turn_id)
      .filter((v) => typeof v === "string");
    expect(matchTurnIds).not.toContain(turnA);

    // Captured wrapping.
    expect(wholeJson).toContain("<captured_user_message>");
    expect(wholeJson).toContain(sharedPrompt);
  });

  it("text input: returns turns whose md5(user_request_text) matches the literal", async () => {
    const sessionId = randomUUID();
    const turnA = randomUUID();
    const literal = `text-shape-token-${randomUUID()}`;

    if (seeded) await seeded.cleanup();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnA,
          sessionId,
          userRequestText: literal,
          responseText: "ack",
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_find_similar_prompts",
      arguments: { text: literal, limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    const items = env.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    const wholeJson = JSON.stringify(env);
    expect(wholeJson).toContain(turnA);
    expect(wholeJson).toContain(literal);
    expect(wholeJson).toContain("<captured_user_message>");
  });

  it("rejects when both turn_id AND text are supplied (XOR)", async () => {
    // SDK turns input-validation failures into a CallToolResult with
    // isError:true (or a JSON-RPC error). Either is acceptable.
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_find_similar_prompts",
        arguments: { turn_id: "t-1", text: "hello" },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/Invalid|validation|turn_id|text/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });

  it("rejects when neither turn_id NOR text is supplied", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_find_similar_prompts",
        arguments: {},
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/Invalid|validation|turn_id|text/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });

  it("returns a usable next_offset that advances to new similar prompts", async () => {
    const sessionId = randomUUID();
    const sharedPrompt = `similar-cursor-token-${randomUUID()}`;
    const turnIds = Array.from({ length: 8 }, () => randomUUID());

    if (seeded) await seeded.cleanup();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: turnIds.map((id, i) => ({
        id,
        sessionId,
        sequenceNum: i + 1,
        userRequestText: sharedPrompt,
        responseText: `ack ${i}`,
      })),
    });

    const first = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_find_similar_prompts",
      arguments: { turn_id: turnIds[0], limit: 2 },
    });
    expect(first.isError).not.toBe(true);
    const env1 = extractEnvelope(first);
    expect(env1.next_offset).toBe(2);
    expect(env1.truncated).toBe(true);

    const second = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_find_similar_prompts",
      arguments: { turn_id: turnIds[0], limit: 2, offset: 2 },
    });
    expect(second.isError).not.toBe(true);
    const env2 = extractEnvelope(second);
    const firstIds = new Set(
      (env1.items as Array<{ turn_id: string }>).map((item) => item.turn_id),
    );
    const secondIds = (env2.items as Array<{ turn_id: string }>).map(
      (item) => item.turn_id,
    );
    expect(secondIds.some((id) => firstIds.has(id))).toBe(false);

    const final = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_find_similar_prompts",
      arguments: { turn_id: turnIds[0], limit: 2, offset: 6 },
    });
    expect(final.isError).not.toBe(true);
    const env3 = extractEnvelope(final);
    expect((env3.items as unknown[]).length).toBe(1);
    expect(env3.next_offset).toBeNull();
    expect(env3.truncated).toBe(false);
  });
});
