/**
 * D-C4-4 / D-C4-5 (integration) — End-to-end `recondo_verify_integrity`.
 *
 * Spawn the binary, drive it via line-delimited JSON-RPC over stdio,
 * seed a small session + turns, then assert:
 *
 *   D-C4-4 — `recondo_verify_integrity` appears in `tools/list` with a
 *            description containing both governance literals
 *            ("Expensive" and "only invoke when the user explicitly
 *            asks") plus a `session_id` requirement.
 *   D-C4-5 — `tools/call` against a seeded session returns a structured
 *            verification report (sessionId / totalTurns /
 *            verifiedTurns / failedTurns / verified / results[]).
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * + the mcp build is fresh (`pnpm --filter recondo-mcp run build`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { spawnMcp, RECONDO_MCP_BINARY, type SpawnedMcp } from "../helpers/spawnMcp.js";
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

describeIfReady("D-C4-4 recondo_verify_integrity schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the canonical input schema and governance literals", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_verify_integrity");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    // Both literal substrings MUST appear verbatim — these are
    // governance directives, not optional flavour text.
    expect(tool!.description!.includes("Expensive")).toBe(true);
    expect(
      tool!.description!.includes("only invoke when the user explicitly asks"),
    ).toBe(true);

    const required = (tool!.inputSchema?.required ?? []) as string[];
    expect(required).toContain("session_id");
  });
});

describeIfReady("D-C4-5 recondo_verify_integrity end-to-end", () => {
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

  it("returns a structured verification report for a seeded session", async () => {
    const sessionId = randomUUID();
    const turnA = randomUUID();
    const turnB = randomUUID();

    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnA,
          sessionId,
          sequenceNum: 1,
          requestHash: "req-hash-a",
          responseHash: "resp-hash-a",
          reqBytesRef: "req-ref-a",
          respBytesRef: "resp-ref-a",
        },
        {
          id: turnB,
          sessionId,
          sequenceNum: 2,
          requestHash: "req-hash-b",
          responseHash: "resp-hash-b",
          reqBytesRef: "req-ref-b",
          respBytesRef: "resp-ref-b",
        },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_verify_integrity",
      arguments: { session_id: sessionId },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // VerifyIntegrityResult shape pinned by packages/recondo-data/src/turns.ts.
    expect(env.sessionId).toBe(sessionId);
    expect(env.totalTurns).toBe(2);
    expect(typeof env.verifiedTurns).toBe("number");
    expect(typeof env.failedTurns).toBe("number");
    expect(typeof env.verified).toBe("boolean");
    expect(Array.isArray(env.results)).toBe(true);

    const results = env.results as Array<Record<string, unknown>>;
    expect(results.length).toBe(2);
    for (const r of results) {
      expect(typeof r.turnId).toBe("string");
      expect(typeof r.sequenceNum).toBe("number");
      expect(typeof r.reqHashMatch).toBe("boolean");
      expect(typeof r.respHashMatch).toBe("boolean");
      expect(typeof r.reqBytesPresent).toBe("boolean");
      expect(typeof r.respBytesPresent).toBe("boolean");
    }

    // No captured-message wrapping — the integrity report is metadata,
    // not captured content.
    const wholeJson = JSON.stringify(env);
    expect(wholeJson).not.toContain("<captured_user_message>");
    expect(wholeJson).not.toContain("<captured_assistant_message>");
  });

  it("returns an empty-shape report for a session that does not exist", async () => {
    const missing = randomUUID();
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_verify_integrity",
      arguments: { session_id: missing },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expect(env.sessionId).toBe(missing);
    expect(env.totalTurns).toBe(0);
    expect((env.results as unknown[]).length).toBe(0);
  });
});
