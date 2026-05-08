import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface CallToolResult {
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

describeIfReady("D-HARD recondo_insights integration", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list and returns the structured insights shape", async () => {
    const listed = await mcp.request<{
      tools: Array<{ name: string; description?: string }>;
    }>("tools/list");
    const tool = listed.tools.find((t) => t.name === "recondo_insights");
    expect(tool).toBeDefined();
    expect((tool?.description ?? "").length).toBeGreaterThanOrEqual(50);

    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_insights",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as { insights?: unknown[] };
    expect(Array.isArray(structured.insights)).toBe(true);
  });
});
