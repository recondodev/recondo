/**
 * D-C5-3 (integration) — End-to-end `recondo_related_turns`.
 *
 * Spawn the binary, drive it over Streamable HTTP,
 * seed a session with three turns where turn 2 supersedes turn 1 (i.e.
 * `supersedesTurnId = turn1.id` — the `retry_of` relation maps to this
 * column per Plan C C4 / data-layer header docstring), then assert:
 *
 *   - relation = "retry_of": calling with turn1's id returns turn2.
 *   - relation = "same_session": calling with any turn id returns the
 *     other two turns in the session.
 *   - relation = "caused_by": SDK-level schema validation rejects this
 *     dropped relation (no call reaches the data layer).
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

describeIfReady("D-C5-3 recondo_related_turns end-to-end", () => {
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

  it("relation='retry_of' returns the superseding turn", async () => {
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
          userRequestText: "original prompt",
        },
        {
          id: turn2,
          sessionId,
          sequenceNum: 2,
          userRequestText: "retry of original",
          // turn2 supersedes turn1 — the retry_of relation pivots on this column.
          supersedesTurnId: turn1,
        },
        {
          id: turn3,
          sessionId,
          sequenceNum: 3,
          userRequestText: "unrelated",
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_related_turns",
      arguments: { turn_id: turn1, relation: "retry_of", limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // 5-key list envelope.
    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("is_final");
    expect(env.is_final).toBe(true);

    const wholeJson = JSON.stringify(env);
    // turn2 (the retry) surfaces.
    expect(wholeJson).toContain(turn2);
    // turn3 (unrelated) does NOT surface.
    expect(wholeJson).not.toContain(turn3);
    // Captured-message wrapping for the rendered user_request_text.
    expect(wholeJson).toContain("<captured_user_message>");
  });

  it("relation='same_session' returns peer turns in the same session", async () => {
    const sessionId = randomUUID();
    const turn1 = randomUUID();
    const turn2 = randomUUID();
    const turn3 = randomUUID();

    if (seeded) await seeded.cleanup();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        { id: turn1, sessionId, sequenceNum: 1, userRequestText: "one" },
        { id: turn2, sessionId, sequenceNum: 2, userRequestText: "two" },
        { id: turn3, sessionId, sequenceNum: 3, userRequestText: "three" },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_related_turns",
      arguments: { turn_id: turn1, relation: "same_session", limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    const wholeJson = JSON.stringify(env);
    // turn2 and turn3 surface; turn1 (the input) is excluded.
    expect(wholeJson).toContain(turn2);
    expect(wholeJson).toContain(turn3);
    const items = env.items as Array<Record<string, unknown>>;
    const matchTurnIds = items
      .map((i) => i.from_turn_id ?? i.turn_id)
      .filter((v) => typeof v === "string");
    expect(matchTurnIds).not.toContain(turn1);
  });

  it("rejects relation='caused_by' via SDK schema validation (dropped relation)", async () => {
    // SDK turns input-validation failures into a CallToolResult with
    // isError:true (or a JSON-RPC error). Either is acceptable.
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_related_turns",
        arguments: { turn_id: "any", relation: "caused_by" },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/Invalid|validation|relation/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });

  it("rejects relation='same_tool_chain' via SDK schema validation (dropped relation)", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_related_turns",
        arguments: { turn_id: "any", relation: "same_tool_chain" },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/Invalid|validation|relation/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });

  it("returns a usable next_offset that advances to new related turns", async () => {
    const sessionId = randomUUID();
    const turnIds = Array.from({ length: 8 }, () => randomUUID());

    if (seeded) await seeded.cleanup();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: turnIds.map((id, i) => ({
        id,
        sessionId,
        sequenceNum: i + 1,
        timestamp: `2026-05-07T00:00:0${i}.000Z`,
        userRequestText: `related cursor ${i}`,
      })),
    });

    const first = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_related_turns",
      arguments: {
        turn_id: turnIds[0],
        relation: "same_session",
        limit: 2,
      },
    });
    expect(first.isError).not.toBe(true);
    const env1 = extractEnvelope(first);
    expect(env1.next_offset).toBe(2);
    expect(env1.truncated).toBe(true);

    const second = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_related_turns",
      arguments: {
        turn_id: turnIds[0],
        relation: "same_session",
        limit: 2,
        offset: 2,
      },
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
      name: "recondo_related_turns",
      arguments: {
        turn_id: turnIds[0],
        relation: "same_session",
        limit: 2,
        offset: 6,
      },
    });
    expect(final.isError).not.toBe(true);
    const env3 = extractEnvelope(final);
    expect((env3.items as unknown[]).length).toBe(1);
    expect(env3.next_offset).toBeNull();
    expect(env3.truncated).toBe(false);
  });
});
