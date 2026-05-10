/**
 * D-C9-1 (integration) — End-to-end `recondo_policies`.
 *
 * Insert a row into `policies` directly (the captured-table append-only
 * trigger does not apply to governance metadata tables), then call
 * `tools/call recondo_policies` and assert the canonical 5-key list
 * envelope contains the row.
 *
 * A second test seeds a `policy_triggers` row and calls with
 * `include: ["trigger_history"]` to verify the merge wires through the
 * binary.
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

describeIfReady("D-C9-1 recondo_policies schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("appears in tools/list with description >= 50 chars", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_policies");
    expect(tool).toBeDefined();
    expect(typeof tool!.description).toBe("string");
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
  });
});

describeIfReady("D-C9-1 recondo_policies integration", () => {
  let mcp: SpawnedMcp;
  const policyId = `pol-${randomUUID()}`;
  const policyName = `Test Policy ${policyId}`;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO policies (id, project_id, name, type, scope, action, triggers_mtd, status)
       VALUES ($1, 'default', $2, 'BLOCK', 'global', 'deny', 0, 'ACTIVE')`,
      [policyId, policyName],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("returns a 5-key envelope referencing the seeded policy", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_policies",
      arguments: {},
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    expect(JSON.stringify(env)).toContain(policyId);
    expect(JSON.stringify(env)).toContain(policyName);
  });
});

describeIfReady("D-C9-1 recondo_policies include=trigger_history", () => {
  let mcp: SpawnedMcp;
  const policyId = `pol-${randomUUID()}`;
  const policyName = `Trend Policy ${policyId}`;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    await pool.query(
      `INSERT INTO policies (id, project_id, name, type, scope, action, triggers_mtd, status)
       VALUES ($1, 'default', $2, 'ALERT', 'global', 'log', 5, 'ACTIVE')`,
      [policyId, policyName],
    );
    // Seed a few trigger events so the trend has at least one data point.
    await pool.query(
      `INSERT INTO policy_triggers (policy_id, triggered_at, details)
       VALUES ($1, now(), 'seed-1'), ($1, now() - interval '1 day', 'seed-2')`,
      [policyId],
    );
  });

  afterAll(async () => {
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      // policy_triggers cascades when the policy row is deleted.
      await pool.query(`DELETE FROM policies WHERE id = $1`, [policyId]);
    } catch {
      // pool may already be closed
    }
    await mcp?.close();
  });

  it("merges trigger_history onto each policy row when include=['trigger_history']", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_policies",
      arguments: { include: ["trigger_history"] },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);
    expectListEnvelope(env);
    const items = env.items as Array<Record<string, unknown>>;
    const seeded = items.find((p) => (p.id as string) === policyId);
    expect(seeded, `seeded policy ${policyId} not in response`).toBeDefined();
    // Accept either snake_case or camelCase merge key.
    const trend = (seeded as Record<string, unknown>).triggerHistory ??
      (seeded as Record<string, unknown>).trigger_history;
    expect(
      trend,
      `trigger_history not merged onto policy ${policyId}; row=${JSON.stringify(seeded)}`,
    ).toBeDefined();
  });
});
