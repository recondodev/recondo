/**
 * D-C3-1 (integration) — End-to-end `recondo_get_session`.
 *
 * Spawn the binary, seed one session row, drive `tools/call
 * recondo_get_session {session_id}` and assert the response is the
 * session record verbatim (NOT wrapped in a list envelope).
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
    `tool result missing payload: ${JSON.stringify(result).slice(0, 400)}`,
  );
}

describeIfReady("D-C3-1 recondo_get_session integration", () => {
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

  it("returns the session record (not a list envelope) for a known id", async () => {
    const id = randomUUID();
    seeded = await seedTestDb({
      sessions: [{ id, framework: "claude-code" }],
    });

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_get_session",
      arguments: { session_id: id },
    });

    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // Single-record return — NOT a 5-key list envelope.
    expect(env).not.toHaveProperty("items");
    expect(env).not.toHaveProperty("stream_id");
    expect(env).not.toHaveProperty("is_final");

    // The session record's primary key surfaces verbatim. Field name
    // shape (camelCase from MappedSession vs snake_case) is the
    // implementer's choice — we assert via stringify so either form
    // passes.
    const wholeJson = JSON.stringify(env);
    expect(wholeJson).toContain(id);
    expect(wholeJson).toContain("claude-code");
  });

  it("appears in tools/list with the canonical input schema", async () => {
    interface ToolDefinition {
      name: string;
      description?: string;
      inputSchema?: {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      };
    }
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_get_session");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
    const schema = tool!.inputSchema ?? {};
    expect(schema.type).toBe("object");
    const required = (schema.required ?? []) as string[];
    expect(required).toContain("session_id");
  });
});
