/**
 * D-C7-3 (integration) — End-to-end `recondo_top`.
 *
 * Seed a session + turn with account_uuid + git_repo set, then call
 * `tools/call recondo_top` for both `dimension` values and assert the
 * 5-key list envelope contains a row reflecting the seeded data.
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

describeIfReady("D-C7-3 recondo_top schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with the 2-member dimension enum", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>(
      "tools/list",
    );
    const tool = result.tools.find((t) => t.name === "recondo_top");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);

    const props = (tool!.inputSchema?.properties ?? {}) as Record<
      string,
      { enum?: unknown[] }
    >;
    expect(props.dimension).toBeDefined();
    if (Array.isArray(props.dimension?.enum)) {
      const members = props.dimension.enum.slice().sort();
      expect(members).toEqual(["developer", "repository"]);
    }
  });
});

describeIfReady("D-C7-3 recondo_top integration — both dimensions dispatch", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;
  const accountUuid = "uuid-top-developer";
  const repoName = "github.com/example/recondo-top-test";

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
    const sessionId = randomUUID();
    const turnId = randomUUID();
    seeded = await seedTestDb({
      sessions: [
        {
          id: sessionId,
          framework: "claude-code",
          accountUuid,
          // Seeded via raw SQL — `seedTestDb` doesn't expose `git_repo`,
          // but the schema column exists. We patch via the cleanup
          // hook + a follow-up update to keep the helper minimal.
        },
      ],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
          httpStatus: 200,
          captureComplete: true,
          costUsd: 1.23,
        },
      ],
    });

    // Patch git_repo onto the seeded session under GDPR bypass — the
    // helper doesn't expose this fixture knob and the dimension test
    // for `repository` needs a non-NULL repo.
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL recondo.gdpr_bypass = 'true'");
      await client.query(
        "UPDATE sessions SET git_repo = $1, git_branch = $2 WHERE id = $3",
        [repoName, "main", sessionId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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

  it("dimension=developer returns a row referencing the seeded account_uuid", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_top",
      arguments: { dimension: "developer" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(accountUuid);
  });

  it("dimension=repository returns a row referencing the seeded git_repo", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_top",
      arguments: { dimension: "repository" },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(repoName);
  });

  it("rejects bogus dimension values at the schema layer", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_top",
        arguments: { dimension: "framework" },
      })
      .catch((err: unknown) => err);
    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/(?:Invalid|validation|dimension)/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });
});
