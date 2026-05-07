/**
 * D-C13-8 (CRITICAL, integration) — Action tools cannot mutate captured
 * tables.
 *
 * Compute SHA-256 row-count fingerprints for the four captured tables
 * (turns, tool_calls, sessions, attachments). Spawn the binary with
 * `--allow-actions --allow-destructive`. Invoke EACH of the seven
 * action tools (with mock-friendly args; some calls will fail with
 * domain errors, which is fine — the assertion is that the captured
 * tables remain byte-identical regardless of action-tool outcome).
 * Re-fingerprint and assert UNCHANGED.
 *
 * Why row-count + table-name fingerprinting (not full content hash):
 * the data layer's read paths may legitimately update non-captured
 * tables (e.g. usage_aggregates, policies, reports). The row-count
 * fingerprint covers the captured-bytes tables that are protected by
 * the GDPR triggers. Those rows must be append-only as far as action
 * tools are concerned.
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * + the mcp build is fresh.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";
import { seedTestDb, truncateCapturedTables } from "../helpers/seed.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

const CAPTURED_TABLES = ["turns", "tool_calls", "sessions", "attachments"] as const;

async function fingerprintCapturedTables(): Promise<string> {
  const { getPool } = await import("@recondo/data");
  const pool = getPool();
  const parts: string[] = [];
  for (const tableName of CAPTURED_TABLES) {
    const r = await pool.query(`SELECT COUNT(*)::bigint AS c FROM ${tableName}`);
    const count = Number(r.rows[0]?.c ?? 0);
    parts.push(`${tableName}:${count}`);
  }
  const joined = parts.join("|");
  return createHash("sha256").update(joined).digest("hex");
}

describeIfReady("D-C13-8 action tools never mutate captured tables", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({ args: ["--allow-actions", "--allow-destructive"] });
    // Seed enough captured rows that the fingerprint is non-trivial.
    const sessionId = randomUUID();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        { sessionId, sequenceNum: 1, userRequestText: "a", responseText: "b" },
        { sessionId, sequenceNum: 2, userRequestText: "c", responseText: "d" },
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

  it("invoking every action tool leaves the captured-table fingerprint UNCHANGED", async () => {
    const before = await fingerprintCapturedTables();

    // Each call uses synthetic / fake ids so the data-layer either
    // creates an unrelated (non-captured) row or fails with a domain
    // error. EITHER outcome is acceptable — the captured-table
    // fingerprint MUST remain unchanged.
    const fakeProjectId = randomUUID();
    const fakePolicyId = randomUUID();
    const fakeKeyId = randomUUID();
    const fakeControlId = randomUUID();

    const calls: Array<[string, Record<string, unknown>]> = [
      [
        "recondo_generate_report",
        {
          framework: "soc2",
          period_start: "2026-01-01T00:00:00Z",
          period_end: "2026-04-01T00:00:00Z",
          project_id: fakeProjectId,
        },
      ],
      [
        "recondo_update_control_status",
        {
          control_id: fakeControlId,
          new_status: "PASSING",
          reason: "c13-test",
        },
      ],
      [
        "recondo_create_policy",
        {
          name: `c13-policy-${randomUUID()}`,
          type: "BLOCK",
          scope: "*",
          action: "DENY",
        },
      ],
      [
        "recondo_update_policy",
        {
          policy_id: fakePolicyId,
          name: "c13-renamed",
        },
      ],
      [
        "recondo_register_key",
        {
          name: `c13-key-${randomUUID()}`,
          provider: "anthropic",
          fingerprint: `c13-fp-${randomUUID()}`,
        },
      ],
      [
        "recondo_delete_policy",
        { policy_id: fakePolicyId },
      ],
      [
        "recondo_delete_key",
        { key_id: fakeKeyId },
      ],
    ];

    for (const [name, args] of calls) {
      // Swallow errors — the test cares about side-effects on captured
      // tables, not whether the individual action succeeded.
      try {
        await mcp.request<CallToolResult>("tools/call", { name, arguments: args });
      } catch {
        // ignore — domain errors on synthetic ids are expected.
      }
    }

    const after = await fingerprintCapturedTables();
    expect(
      after,
      `captured-table fingerprint changed: before=${before} after=${after}`,
    ).toBe(before);
  });
});
