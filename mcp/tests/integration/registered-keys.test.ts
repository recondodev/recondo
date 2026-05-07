/**
 * D-C9-2 (integration) — End-to-end `recondo_registered_keys`.
 *
 * Insert a row into `registered_keys` directly and call
 * `tools/call recondo_registered_keys`. Asserts the canonical 5-key
 * list envelope contains the row.
 *
 * IMPORTANT: this tool reads `registered_keys` (managed LLM provider
 * keys), NOT `api_keys` (gateway auth tokens). The two tables are
 * intentionally distinct (see packages/recondo-data/src/keys.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";

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

describeIfReady("D-C9-2 recondo_registered_keys schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with description >= 50 chars", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_registered_keys");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
  });
});

describeIfReady("D-C9-2 recondo_registered_keys integration", () => {
  let mcp: SpawnedMcp;
  const keyId = `key-${randomUUID()}`;
  const keyName = `Test Key ${keyId}`;
  // Fingerprint must be unique (UNIQUE constraint on registered_keys).
  const fingerprint = `fp-${randomUUID()}`;

  beforeAll(async () => {
    mcp = await spawnMcp({});
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO registered_keys
         (id, project_id, name, provider, fingerprint, agent_count,
          last_used, monthly_cost_usd, status)
       VALUES ($1, 'default', $2, 'anthropic', $3, 0, NULL, 0.0, 'active')`,
      [keyId, keyName, fingerprint],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM registered_keys WHERE id = $1`, [keyId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("returns a 5-key envelope referencing the seeded key", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_registered_keys",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(keyId);
    expect(JSON.stringify(env)).toContain(keyName);
    expect(JSON.stringify(env)).toContain(fingerprint);
  });
});
