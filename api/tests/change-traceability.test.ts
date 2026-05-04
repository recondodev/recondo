/**
 * Sprint 11 Deliverable 2: SUPERSEDES Chain Audit Export (Change Traceability)
 *
 * Tests for POST /v1/exports/change-traceability endpoint.
 *
 * Walks the supersedes_turn_id chain using a recursive CTE to build a
 * complete change history for any artifact (file path). Returns:
 * - changeHistory: ordered array of changes with turn/session/model/intent
 * - originatingIntent: the first session's initial_intent
 * - chainLength: number of changes
 * - contentHashes: first and latest SHA-256
 * - summary: human-readable description
 *
 * auth required, project scoped, audit logged.
 *
 * These tests WILL FAIL until the implementation agent builds the endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  API_KEYS,
  IDS,
  API_BASE_URL,
  countAuditLogs,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test API keys (unique prefix bb610 to avoid collisions)
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_chgtrace_foundation_1",
  compliance: "wrt_test_chgtrace_compliance_2",
  enterprise: "wrt_test_chgtrace_enterprise_3",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb610000-0000-4000-8000-000000000001",
  compliance: "bb610000-0000-4000-8000-000000000002",
  enterprise: "bb610000-0000-4000-8000-000000000003",
} as const;

// Extra turn IDs for the SUPERSEDES chain fixture (prefix: dd61)
const CHAIN_IDS = {
  turn_chain_1: "dd610000-0000-4000-8000-000000000001",
  turn_chain_2: "dd610000-0000-4000-8000-000000000002",
  turn_chain_3: "dd610000-0000-4000-8000-000000000003",
  tool_chain_1: "ee610000-0000-4000-8000-000000000001",
  tool_chain_2: "ee610000-0000-4000-8000-000000000002",
  tool_chain_3: "ee610000-0000-4000-8000-000000000003",
  session_chain: "cc610000-0000-4000-8000-000000000001",
} as const;

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function postJSON(
  path: string,
  body: Record<string, unknown>,
  apiKey?: string
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const responseBody = (await response.json()) as Record<string, unknown>;
  return { body: responseBody, response };
}

// ---------------------------------------------------------------------------
// Fixtures: SUPERSEDES chain for "src/auth.ts"
// ---------------------------------------------------------------------------

async function seedChangeTraceabilityFixtures(): Promise<void> {
  const p = getPool();

  // Insert test API keys
  const hashFoundation = await sha256(TEST_KEYS.foundation);
  const hashCompliance = await sha256(TEST_KEYS.compliance);
  const hashEnterprise = await sha256(TEST_KEYS.enterprise);

  await p.query(`
    INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm) VALUES
      ('${TEST_KEY_IDS.foundation}', '${hashFoundation}', '${IDS.projectAlpha}', 60),
      ('${TEST_KEY_IDS.compliance}', '${hashCompliance}', '${IDS.projectAlpha}', 120),
      ('${TEST_KEY_IDS.enterprise}', '${hashEnterprise}', '${IDS.projectAlpha}', 1000)
    ON CONFLICT (id) DO NOTHING;
  `);

  const now = new Date();
  const threeHoursAgo = new Date(now.getTime() - 10800_000);
  const twoHoursAgo = new Date(now.getTime() - 7200_000);
  const oneHourAgo = new Date(now.getTime() - 3600_000);

  // Create a dedicated session for the SUPERSEDES chain
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (id) DO NOTHING`,
    [CHAIN_IDS.session_chain, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
     threeHoursAgo.toISOString(), oneHourAgo.toISOString(),
     "Fix the login bug in auth.ts", "chain_prompt_hash", 3, 3, 0, 9000, 0.30, "claude-code"]
  );

  // Turn 1: original creation of src/auth.ts (no supersedes)
  const turnInsertSql = `INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       model, provider, input_tokens, output_tokens, cost_usd,
                       duration_ms, tool_call_count, stop_reason, created_at, supersedes_turn_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON CONFLICT (id) DO NOTHING`;

  await p.query(turnInsertSql,
    [CHAIN_IDS.turn_chain_1, CHAIN_IDS.session_chain, 1, threeHoursAgo.toISOString(),
     "hash_req_ch1", "hash_resp_ch1", "claude-sonnet-4-20250514", "anthropic",
     1000, 500, 0.05, 1200, 1, "end_turn", threeHoursAgo.toISOString(), null]
  );

  // Turn 2: first edit to src/auth.ts, supersedes turn 1
  await p.query(turnInsertSql,
    [CHAIN_IDS.turn_chain_2, CHAIN_IDS.session_chain, 2, twoHoursAgo.toISOString(),
     "hash_req_ch2", "hash_resp_ch2", "claude-sonnet-4-20250514", "anthropic",
     1500, 800, 0.08, 1500, 1, "end_turn", twoHoursAgo.toISOString(), CHAIN_IDS.turn_chain_1]
  );

  // Turn 3: second edit to src/auth.ts, supersedes turn 2
  await p.query(turnInsertSql,
    [CHAIN_IDS.turn_chain_3, CHAIN_IDS.session_chain, 3, oneHourAgo.toISOString(),
     "hash_req_ch3", "hash_resp_ch3", "claude-sonnet-4-20250514", "anthropic",
     2000, 1000, 0.10, 1800, 1, "end_turn", oneHourAgo.toISOString(), CHAIN_IDS.turn_chain_2]
  );

  // Tool calls with artifacts_created pointing to src/auth.ts
  const toolInsertSql = `INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                          output, status, artifacts_created, artifact_hashes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`;

  await p.query(toolInsertSql,
    [CHAIN_IDS.tool_chain_1, CHAIN_IDS.turn_chain_1, "Write",
     '{"file_path":"src/auth.ts","content":"v1"}', "input_hash_ch1", 0,
     "Created src/auth.ts", "success",
     '["src/auth.ts"]', '["sha256_first_version"]']
  );

  await p.query(toolInsertSql,
    [CHAIN_IDS.tool_chain_2, CHAIN_IDS.turn_chain_2, "Write",
     '{"file_path":"src/auth.ts","content":"v2"}', "input_hash_ch2", 0,
     "Updated src/auth.ts", "success",
     '["src/auth.ts"]', '["sha256_second_version"]']
  );

  await p.query(toolInsertSql,
    [CHAIN_IDS.tool_chain_3, CHAIN_IDS.turn_chain_3, "Write",
     '{"file_path":"src/auth.ts","content":"v3"}', "input_hash_ch3", 0,
     "Updated src/auth.ts", "success",
     '["src/auth.ts"]', '["sha256_latest_version"]']
  );
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedChangeTraceabilityFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/exports/change-traceability — Top-level structure
// =========================================================================

describe("POST /v1/exports/change-traceability — top-level structure", () => {
  it("returns generatedAt, projectId, artifactPath, changeHistory, originatingIntent, chainLength, contentHashes, summary", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.generatedAt).toBe("string");
    expect(body.projectId).toBe(IDS.projectAlpha);
    expect(body.artifactPath).toBe("src/auth.ts");
    expect(body.changeHistory).toBeDefined();
    expect(body.originatingIntent).toBeDefined();
    expect(body.chainLength).toBeDefined();
    expect(body.contentHashes).toBeDefined();
    expect(body.summary).toBeDefined();
  });
});

// =========================================================================
// changeHistory
// =========================================================================

describe("POST /v1/exports/change-traceability — changeHistory", () => {
  it("returns changeHistory array for known artifact", async () => {
    const { body } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    const history = body.changeHistory as Array<Record<string, unknown>>;
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it("each entry has turnId, sessionId, timestamp, model, intent, toolName, supersedes", async () => {
    const { body } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    const history = body.changeHistory as Array<Record<string, unknown>>;
    expect(history.length).toBeGreaterThanOrEqual(1);

    for (const entry of history) {
      expect(entry).toHaveProperty("turnId");
      expect(entry).toHaveProperty("sessionId");
      expect(entry).toHaveProperty("timestamp");
      expect(entry).toHaveProperty("model");
      expect(entry).toHaveProperty("intent");
      expect(entry).toHaveProperty("toolName");
      expect(entry).toHaveProperty("supersedes");
    }
  });

  it("multiple changes to same file produce ordered chain", async () => {
    const { body } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    const history = body.changeHistory as Array<Record<string, unknown>>;
    // We seeded 3 turns in a chain, so expect 3 entries
    expect(history.length).toBe(3);

    // First entry should have no supersedes (it is the origin)
    expect(history[0].supersedes).toBeNull();

    // Second entry supersedes first
    expect(history[1].supersedes).toBe(history[0].turnId);

    // Third entry supersedes second
    expect(history[2].supersedes).toBe(history[1].turnId);
  });

  it("all entries have toolName of Write", async () => {
    const { body } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    const history = body.changeHistory as Array<Record<string, unknown>>;
    for (const entry of history) {
      expect(entry.toolName).toBe("Write");
    }
  });
});

// =========================================================================
// originatingIntent
// =========================================================================

describe("POST /v1/exports/change-traceability — originatingIntent", () => {
  it("originatingIntent matches the first session's initial_intent", async () => {
    const { body } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    expect(body.originatingIntent).toBe("Fix the login bug in auth.ts");
  });
});

// =========================================================================
// chainLength
// =========================================================================

describe("POST /v1/exports/change-traceability — chainLength", () => {
  it("chainLength matches changeHistory array length", async () => {
    const { body } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    const history = body.changeHistory as Array<Record<string, unknown>>;
    expect(body.chainLength).toBe(history.length);
    expect(body.chainLength).toBe(3);
  });
});

// =========================================================================
// contentHashes
// =========================================================================

describe("POST /v1/exports/change-traceability — contentHashes", () => {
  it("contentHashes has first and latest keys", async () => {
    const { body } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    const hashes = body.contentHashes as Record<string, string>;
    expect(hashes).toBeDefined();
    expect(hashes).toHaveProperty("first");
    expect(hashes).toHaveProperty("latest");
    expect(typeof hashes.first).toBe("string");
    expect(typeof hashes.latest).toBe("string");
  });
});

// =========================================================================
// summary
// =========================================================================

describe("POST /v1/exports/change-traceability — summary", () => {
  it("summary is a non-empty string", async () => {
    const { body } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    expect(typeof body.summary).toBe("string");
    expect((body.summary as string).length).toBeGreaterThan(0);
  });
});

// =========================================================================
// Unknown artifact
// =========================================================================

describe("POST /v1/exports/change-traceability — unknown artifact", () => {
  it("unknown artifact returns empty changeHistory with chainLength 0", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/nonexistent-file.ts" },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);

    const history = body.changeHistory as Array<Record<string, unknown>>;
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBe(0);
    expect(body.chainLength).toBe(0);
  });
});

// =========================================================================
// Input validation
// =========================================================================

describe("POST /v1/exports/change-traceability — input validation", () => {
  it("returns 400 when artifactPath is missing", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("returns 400 when projectId is missing", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/change-traceability",
      { artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });
});

// =========================================================================
// Authentication & Authorization
// =========================================================================

describe("POST /v1/exports/change-traceability — auth & gating", () => {
  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" }
    );

    expect(response.status).toBe(401);
  });

  it("authenticated key can access change traceability", async () => {
    const { response } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
  });

  it("admin key can access change traceability", async () => {
    const { response } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      API_KEYS.admin
    );

    expect(response.status).toBe(200);
  });
});

// =========================================================================
// Project scoping
// =========================================================================

describe("POST /v1/exports/change-traceability — project scoping", () => {
  it("scoped key cannot access a different project", async () => {
    const { response } = await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectBeta, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(403);
  });
});

// =========================================================================
// Audit logging
// =========================================================================

describe("POST /v1/exports/change-traceability — audit logging", () => {
  it("creates audit log entry for successful change-traceability export", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/exports/change-traceability",
      { projectId: IDS.projectAlpha, artifactPath: "src/auth.ts" },
      TEST_KEYS.compliance
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
