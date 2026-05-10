/**
 * D-C13-2 (integration) — End-to-end real-key project scoping.
 *
 * Seeds two projects (`scoped` + `other`), inserts an admin key + a
 * project-scoped key into `api_keys`, then spawns the binary with
 * `RECONDO_API_KEY=<scoped_key>` (no dev-bypass) and asserts that
 * `recondo_list_sessions` returns ONLY the scoped project's sessions.
 *
 * The auth context resolver maps `projectId !== null` → non-admin and
 * forwards `projectId` to the data layer; the data layer's `s.project_id
 * = $...` clause filters out the other project's rows.
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * + the mcp build is fresh (`pnpm --filter recondo-mcp run build`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";

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

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function rawSessionRequest(
  mcp: SpawnedMcp,
  method: "GET" | "POST" | "DELETE",
  bearerToken?: string,
): Promise<Response> {
  if (!mcp.sessionId) {
    throw new Error("MCP session was not initialized");
  }
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "MCP-Session-Id": mcp.sessionId,
    "MCP-Protocol-Version": "2025-11-25",
  };
  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }
  const init: RequestInit = { method, headers };
  if (method === "POST") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1001,
      method: "tools/list",
      params: {},
    });
  }
  return fetchWithTimeout(`${mcp.baseUrl}/mcp`, init);
}

describeIfReady("D-C13-2 real-key project scoping", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;
  const scopedProjectId = randomUUID();
  const otherProjectId = randomUUID();
  const scopedKeyId = randomUUID();
  const adminKeyId = randomUUID();
  const scopedToken = `wrt_test_scoped_${randomUUID().replace(/-/g, "")}`;
  const adminToken = `wrt_test_admin_${randomUUID().replace(/-/g, "")}`;
  const scopedSessionId = randomUUID();
  const otherSessionId = randomUUID();

  beforeAll(async () => {
    // Seed sessions in BOTH projects. seedTestDb truncates first, so we
    // must seed BEFORE inserting api_keys (api_keys is not in the
    // captured-tables truncate set, but we want consistent state).
    seeded = await seedTestDb({
      sessions: [
        {
          id: scopedSessionId,
          framework: "claude-code",
          projectId: scopedProjectId,
        },
        {
          id: otherSessionId,
          framework: "claude-code",
          projectId: otherProjectId,
        },
      ],
    });

    // Insert projects + api_keys directly. Use lazy-imported pool so we
    // reuse the test pool and don't dual-open a connection.
    const { getPool } = await import("@recondo/data");
    const pool = getPool();
    // Projects must exist before api_keys.project_id can FK them.
    await pool.query(
      `INSERT INTO projects (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [scopedProjectId, `scoped-${scopedProjectId}`],
    );
    await pool.query(
      `INSERT INTO projects (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [otherProjectId, `other-${otherProjectId}`],
    );

    const scopedHash = createHash("sha256").update(scopedToken).digest("hex");
    const adminHash = createHash("sha256").update(adminToken).digest("hex");

    await pool.query(
      `INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [scopedKeyId, scopedHash, scopedProjectId, 60],
    );
    await pool.query(
      `INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [adminKeyId, adminHash, null, 60],
    );

    // Update the seeded sessions' project_id values directly — seedTestDb's
    // INSERT does forward projectId, but we double-check it by re-confirming.
    // (defensive — if a future seedTestDb refactor drops projectId, the
    // second project assertion would fail without this guard.)
    await pool.query(
      `UPDATE sessions SET project_id = $1 WHERE id = $2`,
      [scopedProjectId, scopedSessionId],
    );
    await pool.query(
      `UPDATE sessions SET project_id = $1 WHERE id = $2`,
      [otherProjectId, otherSessionId],
    );

    // Spawn the binary without dev-bypass and send the scoped key as an
    // explicit bearer token so the production HTTP auth path is exercised.
    mcp = await spawnMcp({
      bearerToken: scopedToken,
      env: {
        RECONDO_OBJECT_STORE_PATH: "/tmp/recondo-objects",
        RECONDO_DEV_BYPASS: "",
        NODE_ENV: "production",
      },
    });
  });

  afterAll(async () => {
    await mcp?.close();
    // Clean up api_keys + projects we inserted. captured-table cleanup
    // wraps DELETEs in GDPR bypass.
    try {
      const { getPool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM api_keys WHERE id IN ($1, $2)`, [
        scopedKeyId,
        adminKeyId,
      ]);
    } catch {
      // pool may be closed
    }
    if (seeded) await seeded.cleanup();
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed
    }
    try {
      const { getPool, closePool } = await import("@recondo/data");
      const pool = getPool();
      await pool.query(`DELETE FROM projects WHERE id IN ($1, $2)`, [
        scopedProjectId,
        otherProjectId,
      ]);
      await closePool();
    } catch {
      // already closed
    }
  });

  it("returns ONLY the scoped project's sessions when called with a project-scoped key", async () => {
    const result = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_list_sessions",
      arguments: { limit: 50 },
    });
    expect(result.isError).not.toBe(true);
    const env = extractEnvelope(result);

    expect(Array.isArray(env.items)).toBe(true);
    const items = env.items as Array<{ id: string }>;
    const ids = new Set(items.map((i) => i.id));

    // The scoped session MUST appear; the other-project session MUST NOT.
    expect(ids.has(scopedSessionId)).toBe(true);
    expect(ids.has(otherSessionId)).toBe(false);
  });

  it("revalidates bearer auth on resumed session requests", async () => {
    const unauthPost = await rawSessionRequest(mcp, "POST");
    expect(unauthPost.status, await unauthPost.text()).toBe(401);

    const mismatchedPost = await rawSessionRequest(mcp, "POST", adminToken);
    expect(mismatchedPost.status, await mismatchedPost.text()).toBe(401);

    const unauthGet = await rawSessionRequest(mcp, "GET");
    expect(unauthGet.status, await unauthGet.text()).toBe(401);

    const unauthDelete = await rawSessionRequest(mcp, "DELETE");
    expect(unauthDelete.status, await unauthDelete.text()).toBe(401);

    const stillUsable = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_list_sessions",
      arguments: { limit: 1 },
    });
    expect(stillUsable.isError).not.toBe(true);

    const { getPool } = await import("@recondo/data");
    await getPool().query(`DELETE FROM api_keys WHERE id = $1`, [scopedKeyId]);

    const revokedPost = await rawSessionRequest(mcp, "POST", scopedToken);
    expect(revokedPost.status, await revokedPost.text()).toBe(401);
  });
});
