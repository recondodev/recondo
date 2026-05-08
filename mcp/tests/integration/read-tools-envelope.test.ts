/**
 * D-C13-4 (integration) — Captured-content envelope wrapping.
 *
 * For each read tool that surfaces captured prompt / response / thinking
 * text, seed a turn with a unique sentinel string and assert the
 * sentinel appears INSIDE a `<captured_*>...</captured_*>` wrapper.
 *
 * The enumerated tools (per Plan D §C13-4):
 *
 *   Wrapping read tools (assert sentinel inside wrapper):
 *     - recondo_get_turn               <captured_user_message> + <captured_assistant_message>
 *     - recondo_search                 <captured_user_message> or <captured_assistant_message>
 *     - recondo_find_similar_prompts   <captured_user_message>
 *     - recondo_related_turns          <captured_user_message>
 *     - recondo_realtime_feed          <captured_user_message>
 *     - recondo_compare_turns          <captured_user_message>
 *
 *   Session-level read tools (do NOT carry captured text — assert
 *   neither the sentinel NOR an un-wrapped payload appears):
 *     - recondo_list_sessions
 *     - recondo_get_session
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

/**
 * Assert that every occurrence of `sentinel` in `body` lies INSIDE
 * a matching `<captured_*>...</captured_*>` wrapper. This is the
 * load-bearing assertion for D-C13-4: text MUST NOT leak outside
 * the wrapper, ever.
 */
function expectSentinelOnlyInsideWrapper(body: string, sentinel: string): void {
  // Find all wrapper text-content regions. Wrapper tags are one of:
  //   captured_user_message, captured_assistant_message,
  //   captured_assistant_thinking, captured_tool_use, captured_tool_result.
  const wrapperRe =
    /<captured_(?:user_message|assistant_message|assistant_thinking|tool_use|tool_result)>([\s\S]*?)<\/captured_(?:user_message|assistant_message|assistant_thinking|tool_use|tool_result)>/g;
  const insideRegions: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = wrapperRe.exec(body)) !== null) {
    const start = match.index + match[0].indexOf(match[1]);
    const end = start + match[1].length;
    insideRegions.push([start, end]);
  }

  // Find every literal occurrence of the sentinel and check each is in
  // an `insideRegions` interval.
  let from = 0;
  let occurrenceCount = 0;
  while (true) {
    const at = body.indexOf(sentinel, from);
    if (at === -1) break;
    occurrenceCount++;
    const inside = insideRegions.some(([s, e]) => at >= s && at + sentinel.length <= e);
    expect(
      inside,
      `sentinel "${sentinel}" at index ${at} is OUTSIDE every captured_* wrapper`,
    ).toBe(true);
    from = at + sentinel.length;
  }
  // Sanity: we should have matched at least once if the test seeded
  // text the tool was meant to surface — otherwise the assertion
  // vacuously passes.
  expect(occurrenceCount).toBeGreaterThanOrEqual(1);
}

describeIfReady("D-C13-4 captured-content envelope wrapping", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const peerTurnId = randomUUID();
  const userSentinel = `c13-user-sentinel-${randomUUID()}`;
  const assistantSentinel = `c13-asst-sentinel-${randomUUID()}`;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
          userRequestText: userSentinel,
          responseText: assistantSentinel,
        },
        // Peer with byte-identical user_request_text so
        // find_similar_prompts + related_turns surface a match.
        {
          id: peerTurnId,
          sessionId,
          sequenceNum: 2,
          userRequestText: userSentinel,
          responseText: "peer-reply",
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

  it("recondo_get_turn wraps userRequestText + responseText", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_get_turn",
      arguments: { turn_id: turnId },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const body = JSON.stringify(env);
    expect(body).toContain("<captured_user_message>");
    expect(body).toContain("<captured_assistant_message>");
    expectSentinelOnlyInsideWrapper(body, userSentinel);
    expectSentinelOnlyInsideWrapper(body, assistantSentinel);
  });

  it("recondo_search wraps the matched snippet", async () => {
    // Search for the user sentinel; scope=prompt surfaces the user
    // wrapper (the search tool's scope enum is prompt|response|tool_call;
    // `prompt` maps onto user_request_text).
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_search",
      arguments: { query: userSentinel, scope: "prompt", limit: 10 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const body = JSON.stringify(env);
    expect(body).toContain("<captured_user_message>");
    expectSentinelOnlyInsideWrapper(body, userSentinel);
  });

  it("recondo_find_similar_prompts wraps user_request_text", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_find_similar_prompts",
      arguments: { turn_id: turnId, limit: 10 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const body = JSON.stringify(env);
    expect(body).toContain("<captured_user_message>");
    expectSentinelOnlyInsideWrapper(body, userSentinel);
  });

  it("recondo_related_turns wraps user_request_text", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_related_turns",
      arguments: { turn_id: turnId, relation: "same_session", limit: 10 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const body = JSON.stringify(env);
    expect(body).toContain("<captured_user_message>");
    expectSentinelOnlyInsideWrapper(body, userSentinel);
  });

  it("recondo_realtime_feed wraps the captured intent", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_realtime_feed",
      arguments: { limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const body = JSON.stringify(env);
    expect(body).toContain("<captured_user_message>");
    expectSentinelOnlyInsideWrapper(body, userSentinel);
  });

  it("recondo_compare_turns wraps both turns' captured text", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_compare_turns",
      arguments: { turn_ids: [turnId, peerTurnId] },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const body = JSON.stringify(env);
    expect(body).toContain("<captured_user_message>");
    expectSentinelOnlyInsideWrapper(body, userSentinel);
  });

  it("recondo_list_sessions does NOT leak captured text outside any wrapper", async () => {
    // list_sessions does not surface captured text; if the seeded
    // sentinel text appears at all, it must be inside a wrapper. In
    // practice, it should not appear at all — assert absence.
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_list_sessions",
      arguments: { limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const body = JSON.stringify(env);
    expect(body.includes(userSentinel)).toBe(false);
    expect(body.includes(assistantSentinel)).toBe(false);
  });

  it("recondo_get_session does NOT leak captured text outside any wrapper", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_get_session",
      arguments: { session_id: sessionId },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    const body = JSON.stringify(env);
    expect(body.includes(userSentinel)).toBe(false);
    expect(body.includes(assistantSentinel)).toBe(false);
  });
});
