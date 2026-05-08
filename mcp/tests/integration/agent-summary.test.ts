/**
 * D-C7-1 (integration) — End-to-end `recondo_agent_summary`.
 *
 * Spawn the binary, seed a session + turn, then call `tools/call
 * recondo_agent_summary` and assert the response is the structured
 * AgentSummary record.
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

describeIfReady("D-C7-1 recondo_agent_summary schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with >=50 char description", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>(
      "tools/list",
    );
    const tool = result.tools.find((t) => t.name === "recondo_agent_summary");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
    expect(tool!.inputSchema?.type).toBe("object");
  });
});

describeIfReady("D-C7-1 recondo_agent_summary integration — single record", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
    const sessionId = randomUUID();
    const turnId = randomUUID();
    seeded = await seedTestDb({
      sessions: [
        {
          id: sessionId,
          framework: "claude-code",
          accountUuid: "uuid-test-1",
          totalTurns: 1,
        },
      ],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
          httpStatus: 200,
          captureComplete: true,
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

  it("returns the AgentSummary structured record (NOT a list envelope)", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_agent_summary",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // Single record: no list-envelope keys.
    expect(env).not.toHaveProperty("items");

    // Canonical fields (camelCase per data-layer mapping). Tolerate
    // either camelCase or snake_case in case a future mapper renames.
    const totalSessions = env.totalSessions ?? env.total_sessions;
    expect(typeof totalSessions).toBe("number");
    expect(totalSessions as number).toBeGreaterThanOrEqual(1);

    const uniqueDevs = env.uniqueDevelopers ?? env.unique_developers;
    expect(typeof uniqueDevs).toBe("number");
    expect(uniqueDevs as number).toBeGreaterThanOrEqual(1);
  });
});
