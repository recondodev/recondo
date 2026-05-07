/**
 * D-C8-2 (integration) — End-to-end `recondo_anomalies`.
 *
 * Seed a session + a row in `anomaly_events` (the captured-tables seed
 * helper doesn't expose anomaly fixtures — we INSERT raw SQL under GDPR
 * bypass). Call `tools/call recondo_anomalies` and assert the canonical
 * 5-key list envelope contains the seeded row.
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

describeIfReady("D-C8-2 recondo_anomalies schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with description >= 50 chars", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_anomalies");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
  });
});

describeIfReady("D-C8-2 recondo_anomalies integration", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;
  const sessionId = randomUUID();
  const turnId = randomUUID();
  const anomalyId = `anom-${randomUUID()}`;

  beforeAll(async () => {
    mcp = await spawnMcp({});
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnId,
          sessionId,
          sequenceNum: 1,
          httpStatus: 429,
          captureComplete: false,
        },
      ],
    });

    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description, detected_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        anomalyId,
        sessionId,
        turnId,
        "rate_limit",
        "high",
        "rate limit exceeded",
        new Date().toISOString(),
        "{}",
      ],
    );
  });

  afterAll(async () => {
    // Wipe the anomaly row first (no GDPR bypass needed — anomaly_events
    // is not subject to the captured-tables append-only trigger).
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM anomaly_events WHERE id = $1`, [anomalyId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
    if (seeded) await seeded.cleanup();
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed
    }
  });

  it("returns a 5-key envelope referencing the seeded anomaly", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_anomalies",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(anomalyId);
  });
});
