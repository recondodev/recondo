/**
 * D-C13-9 (integration) — List-shape envelope contract.
 *
 * For every list-shape read tool (those that internally call
 * `buildListEnvelope`), assert the returned envelope has the canonical
 * 5-key shape — and ONLY those 5 keys, modulo well-known additive
 * fields that the data layer carries through (`total`, `limit`,
 * `offset`, `dimension`, `group_by`).
 *
 * The 5 anchor keys (always present, exact values asserted):
 *   items: <array>
 *   next_offset: <null | number>
 *   truncated: <boolean>
 *   stream_id: null
 *   is_final: true
 *
 * Why "modulo additive fields": the data layer's existing list helpers
 * are documented to attach `total`/`limit`/`offset` to the envelope,
 * and this is part of the public contract — see
 * `packages/recondo-data/src/audit.ts` listAuditEvents which returns
 * `{ ...uniformListEnvelope, total, limit, offset }`. We reject any
 * key that ISN'T one of the 5 anchors OR one of these additive fields.
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * + the mcp build is fresh.
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

function expectFiveKeyEnvelope(env: Record<string, unknown>, toolName: string): void {
  // The 5 anchor keys MUST be present with exact values.
  expect(env).toHaveProperty("items");
  expect(Array.isArray(env.items), `${toolName}.items must be an array`).toBe(true);
  expect(env).toHaveProperty("next_offset");
  expect(env).toHaveProperty("truncated");
  expect(typeof env.truncated === "boolean", `${toolName}.truncated must be boolean`).toBe(
    true,
  );
  expect(env).toHaveProperty("stream_id");
  expect(env.stream_id, `${toolName}.stream_id must be null`).toBeNull();
  expect(env).toHaveProperty("is_final");
  expect(env.is_final, `${toolName}.is_final must be true`).toBe(true);
}

describeIfReady("D-C13-9 list-shape envelope contract", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const peerTurnId = randomUUID();
  const sharedPrompt = `c13-9-shared-${randomUUID()}`;

  beforeAll(async () => {
    mcp = await spawnMcp({});
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
          userRequestText: sharedPrompt,
          responseText: "r1",
        },
        {
          id: peerTurnId,
          sessionId,
          sequenceNum: 2,
          userRequestText: sharedPrompt,
          responseText: "r2",
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

  // Every list-shape read tool with concrete args. Source of truth:
  // every tool in mcp/src/tools/ that imports buildListEnvelope (or
  // wraps a data-layer function that returns the envelope).
  const LIST_SHAPE_CALLS: Array<[string, Record<string, unknown>]> = [
    ["recondo_list_sessions", { limit: 5 }],
    ["recondo_search", { query: sharedPrompt, scope: "prompt", limit: 5 }],
    [
      "recondo_find_similar_prompts",
      { turn_id: turnId, limit: 5 },
    ],
    [
      "recondo_related_turns",
      { turn_id: turnId, relation: "same_session", limit: 5 },
    ],
    ["recondo_realtime_feed", { limit: 5 }],
    [
      "recondo_spend",
      { group_by: "provider", period: "week" },
    ],
    [
      "recondo_top",
      { dimension: "developer", period: "week", limit: 5 },
    ],
    [
      "recondo_tool_call_stats",
      { group_by: "tool_name", period: "week", limit: 5 },
    ],
    ["recondo_agent_framework_distribution", { period: "week" }],
    ["recondo_audit_trail", { limit: 5 }],
    ["recondo_anomalies", { limit: 5 }],
    ["recondo_compliance", { view: "frameworks", limit: 5 }],
    ["recondo_reports", { limit: 5 }],
    ["recondo_report_trends", { metric: "coverage" }],
    ["recondo_policies", { limit: 5 }],
    ["recondo_registered_keys", { limit: 5 }],
  ];

  it.each(LIST_SHAPE_CALLS)(
    "%s returns the canonical 5-key envelope shape",
    async (toolName, args) => {
      const result = await mcp.request<CallToolResult>("tools/call", {
        name: toolName,
        arguments: args,
      });
      expect(result.isError, `${toolName} returned isError: ${JSON.stringify(result)}`).not.toBe(
        true,
      );
      const env = extractEnvelope(result);
      expectFiveKeyEnvelope(env, toolName);
    },
  );
});
