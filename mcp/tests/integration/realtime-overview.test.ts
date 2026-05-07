/**
 * D-C6-1 (integration) — End-to-end `recondo_realtime_overview`.
 *
 * Spawn the binary, drive it via line-delimited JSON-RPC over stdio,
 * call `tools/list` to assert the tool is registered with the canonical
 * empty-input schema + 50+ char description, then call `tools/call` and
 * assert the structural shape `{stats, gateway_status}`.
 *
 * The test runs against an empty DB — getRealtimeStats and
 * getGatewayStatus both gracefully degrade to zero / "unknown" instead
 * of failing. We assert the shape rather than the values.
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * + the mcp build is fresh (`pnpm --filter recondo-mcp run build`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";
import { truncateCapturedTables } from "../helpers/seed.js";

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

describeIfReady("D-C6-1 recondo_realtime_overview end-to-end", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed
    }
  });

  it("appears in tools/list with the canonical schema + >=50 char description", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_realtime_overview");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
    expect(tool!.inputSchema?.type).toBe("object");
  });

  it("returns single record { stats, gateway_status } on empty DB", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_realtime_overview",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    expect(env).toHaveProperty("stats");
    expect(env).toHaveProperty("gateway_status");

    // Empty DB: realtime stats degrade to zeros; gateway status is unknown.
    const stats = env.stats as Record<string, unknown>;
    const gateway = env.gateway_status as Record<string, unknown>;
    expect(typeof stats).toBe("object");
    expect(typeof gateway).toBe("object");
    expect(typeof stats.requestsPerMinute === "number" || typeof stats.requests_per_minute === "number").toBe(true);
    expect(typeof gateway.status).toBe("string");
  });

  it("does NOT carry list-envelope keys (single record, not paginated)", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_realtime_overview",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expect(env).not.toHaveProperty("items");
  });
});
