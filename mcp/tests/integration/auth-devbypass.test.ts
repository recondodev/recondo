/**
 * D-C13-1 (integration) — End-to-end dev-bypass auth path.
 *
 * Spawn the binary with `RECONDO_DEV_BYPASS=1`, no API key, and
 * `NODE_ENV=development`. The env loader allows dev-bypass under those
 * exact conditions; the auth resolver synthesizes an admin context
 * with `keyId="dev-bypass"` and `projectId=null`, and the read tools
 * become callable without touching the `api_keys` table.
 *
 * The assertion is observable AUTH state: `recondo_list_sessions`
 * returns a valid 5-key envelope when the captured tables are empty.
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

describeIfReady("D-C13-1 dev-bypass auth", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    // Pre-truncate so the empty-DB assertion is deterministic.
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed; not fatal — the spawn driver
      // will just observe whatever is in the DB.
    }
    // spawnMcp's defaults already inject RECONDO_DEV_BYPASS=1 and
    // NODE_ENV=development. We force-clear RECONDO_API_KEY to prove
    // dev-bypass works WITHOUT a key.
    mcp = await spawnMcp({
      env: {
        RECONDO_DEV_BYPASS: "1",
        NODE_ENV: "development",
        // Wipe any inherited key — the harness merges over baseEnv.
        RECONDO_API_KEY: "",
      },
    });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("recondo_list_sessions returns a valid 5-key envelope under dev-bypass", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_list_sessions",
      arguments: { limit: 10 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    // Canonical 5-key shape — items may be empty (post-truncate) or
    // contain whatever else is in the DB; the shape MUST hold either way.
    expect(env).toHaveProperty("items");
    expect(env).toHaveProperty("next_offset");
    expect(env).toHaveProperty("truncated");
    expect(env).toHaveProperty("stream_id");
    expect(env).toHaveProperty("is_final");
    expect(Array.isArray(env.items)).toBe(true);
    expect(env.is_final).toBe(true);
    expect(env.stream_id).toBeNull();
  });
});
