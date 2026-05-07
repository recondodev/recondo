/**
 * D-C2-3 / D-C2-4 / D-C2-5 — End-to-end `recondo_list_sessions`.
 *
 * Spawn the binary, drive it via line-delimited JSON-RPC over stdio,
 * and assert the tool:
 *
 *   D-C2-3 — appears in `tools/list` with the canonical schema
 *            (limit default 20 / max 100, offset >= 0, since string,
 *             description >= 50 chars, framework filter surfaced).
 *   D-C2-4 — `tools/call` returns the canonical 5-key envelope and
 *            picks up seeded rows.
 *   D-C2-5 — when the result exceeds the 32 KB budget, the envelope
 *            sets truncated:true with a usable next_offset.
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * (so audit_log + GDPR triggers exist) + the mcp build is fresh
 * (`pnpm --filter recondo-mcp run build`).
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

/**
 * Pull the parsed envelope out of a tools/call response. Accepts both
 * forms the SDK 1.29 may emit:
 *   - structuredContent: <envelope>
 *   - content: [{ type: "text", text: JSON.stringify(envelope) }]
 */
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

describeIfReady("D-C2-3 recondo_list_sessions schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the canonical input schema", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_list_sessions");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const schema = tool!.inputSchema ?? {};
    expect(schema.type).toBe("object");
    const props = (schema.properties ?? {}) as Record<
      string,
      { type?: unknown; default?: unknown; minimum?: number; maximum?: number }
    >;
    expect(props.limit).toBeDefined();
    // limit defaults and bounds.
    expect(props.limit?.default ?? 20).toBe(20);
    if (props.limit?.maximum !== undefined) {
      expect(props.limit.maximum).toBe(100);
    }
    if (props.limit?.minimum !== undefined) {
      expect(props.limit.minimum).toBeGreaterThanOrEqual(1);
    }
    expect(props.offset).toBeDefined();
    expect(props.since).toBeDefined();
    // Filter surface — at minimum framework should be exposed since
    // the data layer accepts it.
    expect(props.framework).toBeDefined();
  });
});

describeIfReady("D-C2-4 recondo_list_sessions integration", () => {
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

  it("returns the canonical 5-key envelope with seeded sessions", async () => {
    const idA = randomUUID();
    const idB = randomUUID();
    seeded = await seedTestDb({
      sessions: [
        { id: idA, framework: "claude-code" },
        { id: idB, framework: "claude-code" },
      ],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_list_sessions",
      arguments: { limit: 10 },
    });

    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // Canonical 5-key shape (envelope MAY have extra keys like `total`
    // because listSessions adds it; but the 5 anchors must be present).
    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("next_offset");
    expect(env).toHaveProperty("truncated");
    expect(env).toHaveProperty("stream_id");
    expect(env).toHaveProperty("is_final");
    expect(env.is_final).toBe(true);
    expect(env.stream_id).toBeNull();
    expect(env.truncated).toBe(false);
    expect(env.next_offset).toBeNull();

    expect(Array.isArray(env.items)).toBe(true);
    const items = env.items as Array<{ id: string }>;
    const seen = new Set(items.map((i) => i.id));
    expect(seen.has(idA)).toBe(true);
    expect(seen.has(idB)).toBe(true);
    expect(items.length).toBe(2);
  });
});

describeIfReady("D-C2-5 recondo_list_sessions truncation", () => {
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
      // pool already closed
    }
  });

  it("flips truncated:true and supplies next_offset when the page exceeds 32 KB", async () => {
    // Each session row is ~1 KB once mapped + JSON-stringified. 200
    // sessions blow well past the 32 KB budget; with limit=100 the
    // envelope must trigger truncation.
    const fatIntent = "x".repeat(800);
    const sessions = Array.from({ length: 200 }, () => ({
      id: randomUUID(),
      framework: "claude-code",
      initialIntent: fatIntent,
    }));
    seeded = await seedTestDb({ sessions });

    const first = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_list_sessions",
      arguments: { limit: 100 },
    });
    expect(first.isError).not.toBe(true);
    const env1 = extractEnvelope(first);
    expect(env1.truncated).toBe(true);
    expect(env1.next_offset).not.toBeNull();
    expect(typeof env1.next_offset).toBe("number");
    expect(env1.next_offset).toBeGreaterThan(0);
    expect(env1.next_offset).toBeLessThanOrEqual(100);
    const items1 = env1.items as unknown[];
    expect(items1.length).toBeGreaterThan(0);
    expect(items1.length).toBeLessThan(100);

    // Second page picks up where the first left off.
    const offset = env1.next_offset as number;
    const second = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_list_sessions",
      arguments: { limit: 100, offset },
    });
    expect(second.isError).not.toBe(true);
    const env2 = extractEnvelope(second);
    const items2 = env2.items as unknown[];
    expect(Array.isArray(items2)).toBe(true);
    expect(items2.length).toBeGreaterThan(0);
  });

  it("rejects limit > 100 at the schema layer", async () => {
    const bad = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_list_sessions",
      arguments: { limit: 101 },
    }).catch((err: unknown) => err);
    // The SDK turns input-validation errors into either a JSON-RPC
    // error or a CallToolResult with isError:true. Either is fine —
    // the contract is "this should NOT succeed".
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/(?:Invalid|validation|limit)/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });
});
