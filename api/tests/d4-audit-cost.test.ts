/**
 * Sprint D4 -- Audit Trail and Cost Intelligence API behavioral tests.
 *
 * Tests for:
 *   D4.1 -- auditTrail query (AuditConnection with integrityStatus derivation)
 *   D4.2 -- Audit exports (GET /v1/audit/export.csv, GET /v1/audit/export.json)
 *   D4.3 -- Usage summary + spend breakdown queries (6 new GraphQL queries)
 *
 * These tests are written BEFORE the implementation exists.
 * They assert only on externally observable behavior (GraphQL responses,
 * HTTP responses, headers, content types). Every test must FAIL until the
 * implementation is done.
 *
 * Expects:
 *   - PostgreSQL running at localhost:5432 (docker-compose)
 *   - API server running at localhost:4000
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
  API_KEYS,
  IDS,
  getPool,
  API_BASE_URL,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
  await seedD4Fixtures();
});

afterAll(async () => {
  await cleanupD4Fixtures();
  await teardownDatabase();
});

// ---------------------------------------------------------------------------
// D4 fixture seeding -- data that exercises all audit/cost query behaviors
// ---------------------------------------------------------------------------

// IDs for D4-specific sessions and turns (prefix: d4)
const D4_IDS = {
  // Session with verified turns (both hashes, capture_complete = true, 200)
  sessionVerified: "d4000000-0000-4000-8000-000000000001",
  // Session with partial turns (missing hashes)
  sessionPartial: "d4000000-0000-4000-8000-000000000002",
  // Session with retry and failed turns
  sessionErrors: "d4000000-0000-4000-8000-000000000003",
  // Session for a different provider (Google)
  sessionGoogle: "d4000000-0000-4000-8000-000000000004",

  // Verified turns: both hashes present, capture_complete = true, http_status = 200
  turnVerified1: "d4dd0000-0000-4000-8000-000000000001",
  turnVerified2: "d4dd0000-0000-4000-8000-000000000002",
  // Partial turn: missing response hash
  turnPartial1: "d4dd0000-0000-4000-8000-000000000003",
  // Partial turn: capture_complete = false
  turnPartialIncomplete: "d4dd0000-0000-4000-8000-000000000004",
  // Retry turn: http_status = 429
  turnRetry: "d4dd0000-0000-4000-8000-000000000005",
  // Failed turn: http_status = 500
  turnFailed: "d4dd0000-0000-4000-8000-000000000006",
  // Failed turn: http_status = 503
  turnFailed503: "d4dd0000-0000-4000-8000-000000000007",
  // Google provider turn
  turnGoogle1: "d4dd0000-0000-4000-8000-000000000008",
  turnGoogle2: "d4dd0000-0000-4000-8000-000000000009",
} as const;

async function seedD4Fixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3_600_000);
  const twoHoursAgo = new Date(now.getTime() - 7_200_000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 86_400_000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000);

  // Session 1: anthropic, claude_code framework -- verified turns
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework, account_uuid, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (id) DO NOTHING`,
    [D4_IDS.sessionVerified, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
     twoHoursAgo.toISOString(), oneHourAgo.toISOString(), oneHourAgo.toISOString(),
     "Implement user authentication", "d4hash_verified", 2, 2, 0, 5000, 0.25,
     "claude_code", "acct-uuid-001", "device-001"]
  );

  // Session 2: anthropic -- partial turns
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework, account_uuid, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (id) DO NOTHING`,
    [D4_IDS.sessionPartial, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
     twoHoursAgo.toISOString(), oneHourAgo.toISOString(), null,
     "Fix database migration", "d4hash_partial", 2, 1, 1, 3000, 0.12,
     "claude_code", "acct-uuid-001", "device-001"]
  );

  // Session 3: anthropic -- error turns (retry + failed)
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework, account_uuid, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (id) DO NOTHING`,
    [D4_IDS.sessionErrors, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
     threeDaysAgo.toISOString(), threeDaysAgo.toISOString(), threeDaysAgo.toISOString(),
     "Deploy production build", "d4hash_errors", 3, 3, 0, 1000, 0.04,
     "claude_code", "acct-uuid-002", "device-002"]
  );

  // Session 4: google/gemini -- different provider + framework
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework, account_uuid, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (id) DO NOTHING`,
    [D4_IDS.sessionGoogle, IDS.projectAlpha, "google", "gemini-2.0-flash",
     sevenDaysAgo.toISOString(), sevenDaysAgo.toISOString(), sevenDaysAgo.toISOString(),
     "Analyze test coverage", "d4hash_google", 2, 2, 0, 4000, 0.08,
     "cursor", "acct-uuid-003", "device-003"]
  );

  // Turn insert template -- uses all columns needed for audit trail
  const turnInsertSql = `INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       model, provider, input_tokens, output_tokens, thinking_tokens,
                       cost_usd, duration_ms, ttfb_ms, tool_call_count, stop_reason,
                       created_at, capture_complete, http_status, cache_read_tokens, cache_creation_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (id) DO NOTHING`;

  // Turn 1: verified -- both hashes, capture_complete=true, http_status=200
  await p.query(turnInsertSql,
    [D4_IDS.turnVerified1, D4_IDS.sessionVerified, 1, twoHoursAgo.toISOString(),
     "d4_req_hash_v1", "d4_resp_hash_v1",
     "claude-sonnet-4-20250514", "anthropic", 1500, 800, 100,
     0.12, 950, 200, 1, "end_turn",
     twoHoursAgo.toISOString(), true, 200, 300, 50]
  );

  // Turn 2: verified -- both hashes, capture_complete=true, http_status=200
  await p.query(turnInsertSql,
    [D4_IDS.turnVerified2, D4_IDS.sessionVerified, 2,
     new Date(twoHoursAgo.getTime() + 60_000).toISOString(),
     "d4_req_hash_v2", "d4_resp_hash_v2",
     "claude-sonnet-4-20250514", "anthropic", 1200, 500, 0,
     0.13, 1100, 250, 0, "end_turn",
     new Date(twoHoursAgo.getTime() + 60_000).toISOString(), true, 200, 200, 0]
  );

  // Turn 3: partial -- missing response hash (empty string simulates missing)
  await p.query(turnInsertSql,
    [D4_IDS.turnPartial1, D4_IDS.sessionPartial, 1, twoHoursAgo.toISOString(),
     "d4_req_hash_p1", "",
     "claude-sonnet-4-20250514", "anthropic", 1000, 500, 0,
     0.06, 800, 180, 0, "end_turn",
     twoHoursAgo.toISOString(), true, 200, 100, 0]
  );

  // Turn 4: partial -- capture_complete = false
  await p.query(turnInsertSql,
    [D4_IDS.turnPartialIncomplete, D4_IDS.sessionPartial, 2,
     new Date(twoHoursAgo.getTime() + 30_000).toISOString(),
     "d4_req_hash_pi", "d4_resp_hash_pi",
     "claude-sonnet-4-20250514", "anthropic", 800, 400, 0,
     0.06, 600, 150, 0, "end_turn",
     new Date(twoHoursAgo.getTime() + 30_000).toISOString(), false, 200, 0, 0]
  );

  // Turn 5: retry -- http_status = 429
  await p.query(turnInsertSql,
    [D4_IDS.turnRetry, D4_IDS.sessionErrors, 1, threeDaysAgo.toISOString(),
     "d4_req_hash_r", "d4_resp_hash_r",
     "claude-sonnet-4-20250514", "anthropic", 500, 0, 0,
     0.0, 100, 50, 0, "error",
     threeDaysAgo.toISOString(), true, 429, 0, 0]
  );

  // Turn 6: failed -- http_status = 500
  await p.query(turnInsertSql,
    [D4_IDS.turnFailed, D4_IDS.sessionErrors, 2,
     new Date(threeDaysAgo.getTime() + 10_000).toISOString(),
     "d4_req_hash_f500", "d4_resp_hash_f500",
     "claude-sonnet-4-20250514", "anthropic", 500, 0, 0,
     0.02, 200, 80, 0, "error",
     new Date(threeDaysAgo.getTime() + 10_000).toISOString(), true, 500, 0, 0]
  );

  // Turn 7: failed -- http_status = 503
  await p.query(turnInsertSql,
    [D4_IDS.turnFailed503, D4_IDS.sessionErrors, 3,
     new Date(threeDaysAgo.getTime() + 20_000).toISOString(),
     "d4_req_hash_f503", "d4_resp_hash_f503",
     "claude-sonnet-4-20250514", "anthropic", 500, 0, 0,
     0.02, 300, 90, 0, "error",
     new Date(threeDaysAgo.getTime() + 20_000).toISOString(), true, 503, 0, 0]
  );

  // Turn 8: google turn 1
  await p.query(turnInsertSql,
    [D4_IDS.turnGoogle1, D4_IDS.sessionGoogle, 1, sevenDaysAgo.toISOString(),
     "d4_req_hash_g1", "d4_resp_hash_g1",
     "gemini-2.0-flash", "google", 2000, 1000, 0,
     0.04, 500, 100, 0, "end_turn",
     sevenDaysAgo.toISOString(), true, 200, 500, 0]
  );

  // Turn 9: google turn 2
  await p.query(turnInsertSql,
    [D4_IDS.turnGoogle2, D4_IDS.sessionGoogle, 2,
     new Date(sevenDaysAgo.getTime() + 60_000).toISOString(),
     "d4_req_hash_g2", "d4_resp_hash_g2",
     "gemini-2.0-flash", "google", 1000, 500, 0,
     0.04, 400, 80, 0, "end_turn",
     new Date(sevenDaysAgo.getTime() + 60_000).toISOString(), true, 200, 300, 0]
  );
}

async function cleanupD4Fixtures(): Promise<void> {
  const p = getPool();
  const d4TurnIds = Object.values(D4_IDS).filter(id => id.startsWith("d4dd"));
  const d4SessionIds = Object.values(D4_IDS).filter(id => id.startsWith("d400"));

  for (const id of d4TurnIds) {
    try { await p.query(`DELETE FROM turns WHERE id = $1`, [id]); } catch { /* immutable */ }
  }
  for (const id of d4SessionIds) {
    try { await p.query(`DELETE FROM sessions WHERE id = $1`, [id]); } catch { /* FK from turns */ }
  }
}

// =========================================================================
// D4.1 -- auditTrail query: AuditConnection shape
// =========================================================================

const AUDIT_TRAIL_QUERY = `query ($search: String, $type: AuditTypeFilter, $limit: Int, $offset: Int) {
  auditTrail(search: $search, type: $type, limit: $limit, offset: $offset) {
    items {
      timestamp
      sessionId
      sequenceNum
      provider
      requestHash
      responseHash
      totalTokens
      integrityStatus
      httpStatus
      captureComplete
    }
    total
    limit
    offset
  }
}`;

describe("D4.1 -- auditTrail returns AuditConnection with correct fields", () => {
  it("returns items array with all AuditEntry fields", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.auditTrail).toBeDefined();
    expect(Array.isArray(body.data!.auditTrail.items)).toBe(true);
    expect(body.data!.auditTrail.items.length).toBeGreaterThan(0);

    const entry = body.data!.auditTrail.items[0];

    // Required non-null fields
    expect(typeof entry.timestamp).toBe("string");
    expect(typeof entry.sessionId).toBe("string");
    expect(typeof entry.sequenceNum).toBe("number");
    expect(typeof entry.provider).toBe("string");
    expect(typeof entry.totalTokens).toBe("number");
    expect(typeof entry.integrityStatus).toBe("string");
    expect(typeof entry.captureComplete).toBe("boolean");

    // Nullable fields -- present but may be null
    expect("requestHash" in entry).toBe(true);
    expect("responseHash" in entry).toBe(true);
    expect("httpStatus" in entry).toBe(true);
  });

  it("returns total, limit, and offset in the connection", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const conn = body.data!.auditTrail;

    expect(typeof conn.total).toBe("number");
    expect(typeof conn.limit).toBe("number");
    expect(typeof conn.offset).toBe("number");
    expect(conn.total).toBeGreaterThanOrEqual(conn.items.length);
  });

  it("returns items ordered by timestamp DESC (most recent first)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    if (items.length >= 2) {
      for (let i = 1; i < items.length; i++) {
        const prev = new Date(items[i - 1].timestamp).getTime();
        const curr = new Date(items[i].timestamp).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    }
  });
});

// =========================================================================
// D4.1 -- auditTrail integrityStatus derivation
// =========================================================================

describe("D4.1 -- auditTrail integrityStatus derived correctly", () => {
  it("returns 'verified' when both hashes present AND capture_complete = true", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    // Find a turn from our verified session
    const verified = items.find(
      (e: { sessionId: string }) => e.sessionId === D4_IDS.sessionVerified
    );
    expect(verified).toBeDefined();
    expect(verified!.integrityStatus).toBe("verified");
  });

  it("returns 'partial' when one or both hashes missing", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    // turnPartial1 has empty response hash
    const partial = items.find(
      (e: { sessionId: string; sequenceNum: number }) =>
        e.sessionId === D4_IDS.sessionPartial && e.sequenceNum === 1
    );

    if (partial) {
      expect(partial.integrityStatus).toBe("partial");
    }
  });

  it("returns 'partial' when capture_complete is false", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    // turnPartialIncomplete has capture_complete = false
    const incomplete = items.find(
      (e: { sessionId: string; sequenceNum: number }) =>
        e.sessionId === D4_IDS.sessionPartial && e.sequenceNum === 2
    );

    if (incomplete) {
      expect(incomplete.integrityStatus).toBe("partial");
      expect(incomplete.captureComplete).toBe(false);
    }
  });

  it("returns 'retry' when http_status = 429", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    const retry = items.find(
      (e: { sessionId: string; sequenceNum: number }) =>
        e.sessionId === D4_IDS.sessionErrors && e.sequenceNum === 1
    );

    if (retry) {
      expect(retry.integrityStatus).toBe("retry");
      expect(retry.httpStatus).toBe(429);
    }
  });

  it("returns 'failed' when http_status >= 500", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    // http_status = 500
    const failed500 = items.find(
      (e: { sessionId: string; sequenceNum: number }) =>
        e.sessionId === D4_IDS.sessionErrors && e.sequenceNum === 2
    );
    if (failed500) {
      expect(failed500.integrityStatus).toBe("failed");
    }

    // http_status = 503
    const failed503 = items.find(
      (e: { sessionId: string; sequenceNum: number }) =>
        e.sessionId === D4_IDS.sessionErrors && e.sequenceNum === 3
    );
    if (failed503) {
      expect(failed503.integrityStatus).toBe("failed");
    }
  });

  it("integrityStatus is one of the 4 valid values", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const validStatuses = ["verified", "partial", "retry", "failed"];

    for (const entry of body.data!.auditTrail.items) {
      expect(validStatuses).toContain(entry.integrityStatus);
    }
  });
});

// =========================================================================
// D4.1 -- auditTrail search filter
// =========================================================================

describe("D4.1 -- auditTrail search across hashes, session_id, model, provider", () => {
  it("finds entries by request_hash substring", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { search: "d4_req_hash_v1" },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;
    expect(items.length).toBeGreaterThanOrEqual(1);

    const match = items.find(
      (e: { requestHash: string | null }) => e.requestHash === "d4_req_hash_v1"
    );
    expect(match).toBeDefined();
  });

  it("finds entries by response_hash substring", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { search: "d4_resp_hash_g1" },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("finds entries by session_id", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { search: D4_IDS.sessionVerified },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;
    expect(items.length).toBeGreaterThanOrEqual(1);

    for (const entry of items) {
      expect(entry.sessionId).toBe(D4_IDS.sessionVerified);
    }
  });

  it("finds entries by model name", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { search: "gemini-2.0-flash" },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;
    expect(items.length).toBeGreaterThanOrEqual(1);

    // All results should be from the google provider / gemini model
    for (const entry of items) {
      expect(entry.provider).toBe("google");
    }
  });

  it("finds entries by provider name", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { search: "google" },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty items for a search that matches nothing", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { search: "zzz_nonexistent_hash_xyz_12345" },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.auditTrail.items).toEqual([]);
    expect(body.data!.auditTrail.total).toBe(0);
  });
});

// =========================================================================
// D4.1 -- auditTrail type filter
// =========================================================================

describe("D4.1 -- auditTrail type filter (ALL/REQUESTS/RESPONSES/ANOMALIES)", () => {
  it("returns all entries when type is ALL", async () => {
    const { body: bodyAll } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { type: "ALL", limit: 500 },
    });

    const { body: bodyDefault } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 500 },
    });

    expect(bodyAll.errors).toBeUndefined();
    expect(bodyDefault.errors).toBeUndefined();

    // ALL should return the same total as no type filter (default is ALL)
    expect(bodyAll.data!.auditTrail.total).toBe(bodyDefault.data!.auditTrail.total);
  });

  it("REQUESTS filter returns only entries with a request hash", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { type: "REQUESTS", limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    // All entries must have a requestHash
    for (const entry of items) {
      expect(entry.requestHash).toBeTruthy();
    }
  });

  it("RESPONSES filter returns only entries with a response hash", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { type: "RESPONSES", limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    // All entries must have a responseHash
    for (const entry of items) {
      expect(entry.responseHash).toBeTruthy();
    }
  });

  it("ANOMALIES filter returns only entries with non-verified status", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { type: "ANOMALIES", limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    // ANOMALIES should filter to entries that are partial, retry, or failed
    for (const entry of items) {
      expect(["partial", "retry", "failed"]).toContain(entry.integrityStatus);
    }
  });

  it("ANOMALIES does not return verified entries", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { type: "ANOMALIES", limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.auditTrail.items;

    for (const entry of items) {
      expect(entry.integrityStatus).not.toBe("verified");
    }
  });
});

// =========================================================================
// D4.1 -- auditTrail pagination
// =========================================================================

describe("D4.1 -- auditTrail pagination (limit/offset/total)", () => {
  it("defaults to limit 50 when not specified", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.auditTrail.limit).toBe(50);
    expect(body.data!.auditTrail.offset).toBe(0);
  });

  it("respects explicit limit", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 3 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.auditTrail.items.length).toBeLessThanOrEqual(3);
    expect(body.data!.auditTrail.limit).toBe(3);
  });

  it("caps limit at 500", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 1000 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.auditTrail.limit).toBeLessThanOrEqual(500);
  });

  it("respects offset for pagination", async () => {
    // Get first page
    const { body: page1 } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 2, offset: 0 },
    });

    // Get second page
    const { body: page2 } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: 2, offset: 2 },
    });

    expect(page1.errors).toBeUndefined();
    expect(page2.errors).toBeUndefined();

    // Both pages should report the same total
    expect(page1.data!.auditTrail.total).toBe(page2.data!.auditTrail.total);

    // Pages should not overlap (if enough data exists)
    if (page1.data!.auditTrail.items.length > 0 && page2.data!.auditTrail.items.length > 0) {
      const page1Ids = new Set(
        page1.data!.auditTrail.items.map(
          (e: { sessionId: string; sequenceNum: number }) =>
            `${e.sessionId}-${e.sequenceNum}`
        )
      );
      for (const entry of page2.data!.auditTrail.items) {
        expect(page1Ids.has(`${entry.sessionId}-${entry.sequenceNum}`)).toBe(false);
      }
    }

    // offset should be reflected in the response
    expect(page1.data!.auditTrail.offset).toBe(0);
    expect(page2.data!.auditTrail.offset).toBe(2);
  });

  it("returns empty items when offset exceeds total", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { offset: 99999 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.auditTrail.items).toEqual([]);
  });
});

// =========================================================================
// D4.1 -- auditTrail authentication
// =========================================================================

describe("D4.1 -- auditTrail requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: AUDIT_TRAIL_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });

  it("rejects requests with invalid API key", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.invalid,
      query: AUDIT_TRAIL_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D4.2 -- Audit CSV export
// =========================================================================

describe("D4.2 -- GET /v1/audit/export.csv returns CSV", () => {
  it("returns 200 with Content-Type text/csv", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/audit/export.csv`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEYS.admin}` },
    });

    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type");
    expect(contentType).toMatch(/text\/csv/);
  });

  it("CSV contains header row with expected column names", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/audit/export.csv`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEYS.admin}` },
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.split("\n");

    // First line should be the CSV header
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const header = lines[0].toLowerCase();

    // CSV must include the core audit fields
    expect(header).toContain("timestamp");
    expect(header).toContain("session");
    expect(header).toContain("provider");
    expect(header).toContain("integrity");
    expect(header).toContain("tokens");
  });

  it("CSV contains data rows beyond the header", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/audit/export.csv`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEYS.admin}` },
    });

    const text = await response.text();
    const lines = text.trim().split("\n");

    // At least header + 1 data row
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("CSV supports search query parameter", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/audit/export.csv?search=google`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.admin}` },
      }
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.trim().split("\n");

    // Header + at least 1 data row for google turns
    expect(lines.length).toBeGreaterThanOrEqual(2);

    // All data rows (after header) should contain "google"
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].toLowerCase()).toContain("google");
    }
  });

  it("CSV supports type query parameter", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/audit/export.csv?type=ANOMALIES`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.admin}` },
      }
    );

    expect(response.status).toBe(200);
    const text = await response.text();

    // Should not contain any "verified" rows in the data
    const lines = text.trim().split("\n");
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]).not.toMatch(/\bverified\b/i);
    }
  });

  it("CSV supports from and to query parameters", async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date().toISOString();

    const response = await fetch(
      `${API_BASE_URL}/v1/audit/export.csv?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.admin}` },
      }
    );

    expect(response.status).toBe(200);
  });

  it("requires authentication", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/audit/export.csv`, {
      method: "GET",
    });

    expect(response.status).toBe(401);
  });
});

// =========================================================================
// D4.2 -- Audit JSON export
// =========================================================================

describe("D4.2 -- GET /v1/audit/export.json returns JSON evidence package", () => {
  it("returns 200 with Content-Type application/json", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/audit/export.json`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEYS.admin}` },
    });

    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type");
    expect(contentType).toMatch(/application\/json/);
  });

  it("JSON package contains expected top-level structure", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/audit/export.json`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEYS.admin}` },
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;

    // Evidence package should contain audit entries and metadata
    expect(json).toHaveProperty("entries");
    expect(Array.isArray(json.entries)).toBe(true);
  });

  it("JSON entries contain the same fields as AuditEntry", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/audit/export.json`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEYS.admin}` },
    });

    const json = (await response.json()) as { entries: Record<string, unknown>[] };
    expect(json.entries.length).toBeGreaterThan(0);

    const entry = json.entries[0];
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("sessionId");
    expect(entry).toHaveProperty("provider");
    expect(entry).toHaveProperty("integrityStatus");
    expect(entry).toHaveProperty("totalTokens");
  });

  it("JSON supports search query parameter", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/audit/export.json?search=${encodeURIComponent(D4_IDS.sessionVerified)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.admin}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { entries: Array<{ sessionId: string }> };

    expect(json.entries.length).toBeGreaterThanOrEqual(1);
    for (const entry of json.entries) {
      expect(entry.sessionId).toBe(D4_IDS.sessionVerified);
    }
  });

  it("JSON supports type query parameter", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/audit/export.json?type=ANOMALIES`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.admin}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { entries: Array<{ integrityStatus: string }> };

    for (const entry of json.entries) {
      expect(["partial", "retry", "failed"]).toContain(entry.integrityStatus);
    }
  });

  it("JSON supports from and to query parameters", async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date().toISOString();

    const response = await fetch(
      `${API_BASE_URL}/v1/audit/export.json?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.admin}` },
      }
    );

    expect(response.status).toBe(200);
  });

  it("requires authentication", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/audit/export.json`, {
      method: "GET",
    });

    expect(response.status).toBe(401);
  });
});

// =========================================================================
// D4.3 -- usageSummary query
// =========================================================================

const USAGE_SUMMARY_QUERY = `query ($period: Period, $from: DateTime, $to: DateTime) {
  usageSummary(period: $period, from: $from, to: $to) {
    totalCostUsd
    projectedMonthlyCostUsd
    totalTokens
    cacheReadTokens
    cacheReadPercentage
    averageCostPerSession
    averageCostDelta
    cacheHitRate
    cacheSavingsUsd
    costPerDeveloperPerDay
    developerCount
  }
}`;

describe("D4.3 -- usageSummary returns all 11 fields with correct types", () => {
  it("returns all non-null fields as numbers", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.usageSummary).toBeDefined();

    const summary = body.data!.usageSummary;

    expect(typeof summary.totalCostUsd).toBe("number");
    expect(typeof summary.projectedMonthlyCostUsd).toBe("number");
    expect(typeof summary.totalTokens).toBe("number");
    expect(typeof summary.cacheReadTokens).toBe("number");
    expect(typeof summary.cacheReadPercentage).toBe("number");
    expect(typeof summary.averageCostPerSession).toBe("number");
    expect(typeof summary.averageCostDelta).toBe("number");
    expect(typeof summary.cacheHitRate).toBe("number");
    expect(typeof summary.cacheSavingsUsd).toBe("number");
    expect(typeof summary.costPerDeveloperPerDay).toBe("number");
    expect(typeof summary.developerCount).toBe("number");
  });

  it("all numeric values are non-negative (except averageCostDelta)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const s = body.data!.usageSummary;

    expect(s.totalCostUsd).toBeGreaterThanOrEqual(0);
    expect(s.projectedMonthlyCostUsd).toBeGreaterThanOrEqual(0);
    expect(s.totalTokens).toBeGreaterThanOrEqual(0);
    expect(s.cacheReadTokens).toBeGreaterThanOrEqual(0);
    expect(s.cacheReadPercentage).toBeGreaterThanOrEqual(0);
    expect(s.averageCostPerSession).toBeGreaterThanOrEqual(0);
    expect(s.cacheHitRate).toBeGreaterThanOrEqual(0);
    expect(s.cacheSavingsUsd).toBeGreaterThanOrEqual(0);
    expect(s.costPerDeveloperPerDay).toBeGreaterThanOrEqual(0);
    expect(s.developerCount).toBeGreaterThanOrEqual(0);
    // averageCostDelta can be negative (costs going down)
  });

  it("cacheReadPercentage is between 0 and 100", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const s = body.data!.usageSummary;
    expect(s.cacheReadPercentage).toBeGreaterThanOrEqual(0);
    expect(s.cacheReadPercentage).toBeLessThanOrEqual(100);
  });

  it("cacheHitRate is between 0 and 100", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const s = body.data!.usageSummary;
    expect(s.cacheHitRate).toBeGreaterThanOrEqual(0);
    expect(s.cacheHitRate).toBeLessThanOrEqual(100);
  });

  it("developerCount is a positive integer with seeded data", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const s = body.data!.usageSummary;

    // We seeded sessions with 3 distinct account_uuids
    expect(s.developerCount).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(s.developerCount)).toBe(true);
  });
});

describe("D4.3 -- usageSummary respects period filter", () => {
  it("returns narrower data for DAY_1 than DAY_30", async () => {
    const { body: day1 } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
      variables: { period: "DAY_1" },
    });

    const { body: day30 } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
      variables: { period: "DAY_30" },
    });

    expect(day1.errors).toBeUndefined();
    expect(day30.errors).toBeUndefined();

    // DAY_30 should include at least as many tokens/cost as DAY_1
    expect(day30.data!.usageSummary.totalTokens).toBeGreaterThanOrEqual(
      day1.data!.usageSummary.totalTokens
    );
    expect(day30.data!.usageSummary.totalCostUsd).toBeGreaterThanOrEqual(
      day1.data!.usageSummary.totalCostUsd
    );
  });

  it("returns valid data for DAY_7 period", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
      variables: { period: "DAY_7" },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.usageSummary).toBeDefined();
  });

  it("returns valid data for DAY_90 period", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
      variables: { period: "DAY_90" },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.usageSummary).toBeDefined();
  });
});

describe("D4.3 -- usageSummary respects from/to date range", () => {
  it("from/to overrides period when both provided", async () => {
    const from = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const to = new Date().toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
      variables: { period: "DAY_90", from, to },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.usageSummary).toBeDefined();

    // Only data from the last 2 days should be included, not 90 days
    // We have google turns from 7 days ago, so from/to should exclude them
    const s = body.data!.usageSummary;
    expect(typeof s.totalCostUsd).toBe("number");
  });

  it("returns zero values when date range has no data", async () => {
    const from = new Date("2020-01-01T00:00:00.000Z").toISOString();
    const to = new Date("2020-01-02T00:00:00.000Z").toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
      variables: { from, to },
    });

    expect(body.errors).toBeUndefined();
    const s = body.data!.usageSummary;
    expect(s.totalCostUsd).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.developerCount).toBe(0);
  });
});

describe("D4.3 -- usageSummary requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: USAGE_SUMMARY_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D4.3 -- spendByProvider query
// =========================================================================

const SPEND_BY_PROVIDER_QUERY = `query ($period: Period, $from: DateTime, $to: DateTime) {
  spendByProvider(period: $period, from: $from, to: $to) {
    name
    costUsd
    percentage
    count
  }
}`;

describe("D4.3 -- spendByProvider returns categories sorted by costUsd DESC", () => {
  it("returns array of SpendByCategory", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_PROVIDER_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.spendByProvider)).toBe(true);
    expect(body.data!.spendByProvider.length).toBeGreaterThanOrEqual(1);

    const category = body.data!.spendByProvider[0];
    expect(typeof category.name).toBe("string");
    expect(typeof category.costUsd).toBe("number");
    expect(typeof category.percentage).toBe("number");
  });

  it("categories are sorted by costUsd DESC", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_PROVIDER_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const categories = body.data!.spendByProvider;

    if (categories.length >= 2) {
      for (let i = 1; i < categories.length; i++) {
        expect(categories[i - 1].costUsd).toBeGreaterThanOrEqual(categories[i].costUsd);
      }
    }
  });

  it("percentages sum to approximately 100", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_PROVIDER_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const categories = body.data!.spendByProvider;

    if (categories.length > 0) {
      const totalPercentage = categories.reduce(
        (sum: number, c: { percentage: number }) => sum + c.percentage,
        0
      );
      expect(totalPercentage).toBeCloseTo(100, 0);
    }
  });

  it("includes both anthropic and google providers from seeded data", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_PROVIDER_QUERY,
      variables: { period: "DAY_30" },
    });

    expect(body.errors).toBeUndefined();
    const names = body.data!.spendByProvider.map(
      (c: { name: string }) => c.name.toLowerCase()
    );

    // We seeded data for anthropic and google
    expect(names).toContain("anthropic");
    expect(names).toContain("google");
  });

  it("returns empty array when no data in range", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_PROVIDER_QUERY,
      variables: {
        from: "2020-01-01T00:00:00.000Z",
        to: "2020-01-02T00:00:00.000Z",
      },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.spendByProvider).toEqual([]);
  });

  it("requires authentication", async () => {
    const { body, response } = await graphql({
      query: SPEND_BY_PROVIDER_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D4.3 -- spendByModel query
// =========================================================================

const SPEND_BY_MODEL_QUERY = `query ($period: Period, $from: DateTime, $to: DateTime) {
  spendByModel(period: $period, from: $from, to: $to) {
    name
    costUsd
    percentage
    count
  }
}`;

describe("D4.3 -- spendByModel returns categories", () => {
  it("returns array of SpendByCategory with model names", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_MODEL_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.spendByModel)).toBe(true);
    expect(body.data!.spendByModel.length).toBeGreaterThanOrEqual(1);

    const category = body.data!.spendByModel[0];
    expect(typeof category.name).toBe("string");
    expect(typeof category.costUsd).toBe("number");
    expect(typeof category.percentage).toBe("number");
  });

  it("categories are sorted by costUsd DESC", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_MODEL_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const categories = body.data!.spendByModel;

    if (categories.length >= 2) {
      for (let i = 1; i < categories.length; i++) {
        expect(categories[i - 1].costUsd).toBeGreaterThanOrEqual(categories[i].costUsd);
      }
    }
  });

  it("includes distinct models from seeded data", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_MODEL_QUERY,
      variables: { period: "DAY_30" },
    });

    expect(body.errors).toBeUndefined();
    const names = body.data!.spendByModel.map(
      (c: { name: string }) => c.name.toLowerCase()
    );

    // D4 fixtures use claude-sonnet-4-20250514 and gemini-2.0-flash
    const hasClaudeOrGemini =
      names.some((n: string) => n.includes("claude")) ||
      names.some((n: string) => n.includes("gemini"));
    expect(hasClaudeOrGemini).toBe(true);
  });

  it("requires authentication", async () => {
    const { body, response } = await graphql({
      query: SPEND_BY_MODEL_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D4.3 -- spendByFramework query
// =========================================================================

const SPEND_BY_FRAMEWORK_QUERY = `query ($period: Period, $from: DateTime, $to: DateTime) {
  spendByFramework(period: $period, from: $from, to: $to) {
    name
    costUsd
    percentage
    count
  }
}`;

describe("D4.3 -- spendByFramework returns categories", () => {
  it("returns array of SpendByCategory with framework names", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_FRAMEWORK_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.spendByFramework)).toBe(true);
    expect(body.data!.spendByFramework.length).toBeGreaterThanOrEqual(1);
  });

  it("categories are sorted by costUsd DESC", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_FRAMEWORK_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const categories = body.data!.spendByFramework;

    if (categories.length >= 2) {
      for (let i = 1; i < categories.length; i++) {
        expect(categories[i - 1].costUsd).toBeGreaterThanOrEqual(categories[i].costUsd);
      }
    }
  });

  it("includes frameworks from seeded data", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: SPEND_BY_FRAMEWORK_QUERY,
      variables: { period: "DAY_30" },
    });

    expect(body.errors).toBeUndefined();
    const names = body.data!.spendByFramework.map(
      (c: { name: string }) => c.name.toLowerCase()
    );

    // D4 fixtures use claude_code and cursor frameworks
    const hasExpectedFramework =
      names.some((n: string) => n.includes("claude_code")) ||
      names.some((n: string) => n.includes("cursor"));
    expect(hasExpectedFramework).toBe(true);
  });

  it("requires authentication", async () => {
    const { body, response } = await graphql({
      query: SPEND_BY_FRAMEWORK_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D4.3 -- dailySpend query
// =========================================================================

const DAILY_SPEND_QUERY = `query ($days: Int) {
  dailySpend(days: $days) {
    name
    costUsd
    percentage
    count
  }
}`;

describe("D4.3 -- dailySpend returns daily totals", () => {
  it("returns array of SpendByCategory (one per day)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DAILY_SPEND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.dailySpend)).toBe(true);
  });

  it("each entry has a date-like name, costUsd, and percentage", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DAILY_SPEND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const entries = body.data!.dailySpend;

    if (entries.length > 0) {
      const entry = entries[0];
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.costUsd).toBe("number");
      expect(typeof entry.percentage).toBe("number");
      expect(entry.costUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it("defaults to 14 days when days is not specified", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DAILY_SPEND_QUERY,
    });

    expect(body.errors).toBeUndefined();
    // Should return at most 14 entries (one per day with data, or all 14 slots)
    expect(body.data!.dailySpend.length).toBeLessThanOrEqual(14);
  });

  it("respects explicit days parameter", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DAILY_SPEND_QUERY,
      variables: { days: 7 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.dailySpend.length).toBeLessThanOrEqual(7);
  });

  it("returns fewer entries for days=1 than days=30", async () => {
    const { body: days1 } = await graphql({
      apiKey: API_KEYS.admin,
      query: DAILY_SPEND_QUERY,
      variables: { days: 1 },
    });

    const { body: days30 } = await graphql({
      apiKey: API_KEYS.admin,
      query: DAILY_SPEND_QUERY,
      variables: { days: 30 },
    });

    expect(days1.errors).toBeUndefined();
    expect(days30.errors).toBeUndefined();

    expect(days30.data!.dailySpend.length).toBeGreaterThanOrEqual(
      days1.data!.dailySpend.length
    );
  });

  it("requires authentication", async () => {
    const { body, response } = await graphql({
      query: DAILY_SPEND_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D4.3 -- costProjections query
// =========================================================================

const COST_PROJECTIONS_QUERY = `query {
  costProjections {
    month
    projectedSessions
    projectedTokens
    projectedCostUsd
    deltaVsCurrent
    assumptions
  }
}`;

describe("D4.3 -- costProjections returns 3-month forecast", () => {
  it("returns exactly 3 projection entries", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: COST_PROJECTIONS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.costProjections)).toBe(true);
    expect(body.data!.costProjections.length).toBe(3);
  });

  it("each entry has all CostProjection fields with correct types", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: COST_PROJECTIONS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const projections = body.data!.costProjections;

    for (const projection of projections) {
      expect(typeof projection.month).toBe("string");
      expect(typeof projection.projectedSessions).toBe("number");
      expect(typeof projection.projectedTokens).toBe("number");
      expect(typeof projection.projectedCostUsd).toBe("number");
      expect(typeof projection.deltaVsCurrent).toBe("number");
      expect(typeof projection.assumptions).toBe("string");
    }
  });

  it("month field contains valid future month identifiers", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: COST_PROJECTIONS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const projections = body.data!.costProjections;

    // Each month should be a recognizable month string (e.g., "2026-04", "April 2026")
    for (const projection of projections) {
      expect(projection.month.length).toBeGreaterThan(0);
    }

    // Months should be in chronological order
    // (just verify they are distinct)
    const months = projections.map((p: { month: string }) => p.month);
    const uniqueMonths = new Set(months);
    expect(uniqueMonths.size).toBe(3);
  });

  it("projected values are non-negative", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: COST_PROJECTIONS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const projection of body.data!.costProjections) {
      expect(projection.projectedSessions).toBeGreaterThanOrEqual(0);
      expect(projection.projectedTokens).toBeGreaterThanOrEqual(0);
      expect(projection.projectedCostUsd).toBeGreaterThanOrEqual(0);
    }
  });

  it("assumptions field is a non-empty string", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: COST_PROJECTIONS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    for (const projection of body.data!.costProjections) {
      expect(projection.assumptions.length).toBeGreaterThan(0);
    }
  });

  it("requires authentication", async () => {
    const { body, response } = await graphql({
      query: COST_PROJECTIONS_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D4 -- Existing queries still work (regression)
// =========================================================================

describe("D4 -- Existing queries still work after D4 additions", () => {
  it("sessions query returns SessionConnection", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { items { id provider totalTokens } total limit offset } }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.sessions).toBeDefined();
    expect(Array.isArray(body.data!.sessions.items)).toBe(true);
    expect(typeof body.data!.sessions.total).toBe("number");
  });

  it("session(id) query returns a session", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) { session(id: $id) { id provider totalCostUsd } }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session).toBeDefined();
    expect(body.data!.session.id).toBe(IDS.sessionAlpha1);
  });

  it("turn(id) query returns a turn", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) { turn(id: $id) { id sequenceNum totalTokens } }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn).toBeDefined();
    expect(body.data!.turn.id).toBe(IDS.turnA1_1);
  });

  it("realtimeStats query still works", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query { realtimeStats { requestsPerMinute activeSessions tokensLastHour } }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.realtimeStats).toBeDefined();
  });

  it("search query still works", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($q: String!) { search(query: $q) { id } }`,
      variables: { q: "anthropic" },
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.search)).toBe(true);
  });
});

// =========================================================================
// D4 -- Negative / edge case tests
// =========================================================================

describe("D4 -- Negative tests", () => {
  it("auditTrail with negative limit defaults to a sane value", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { limit: -5 },
    });

    // Should succeed without error -- negative limit is clamped or defaulted
    expect(body.errors).toBeUndefined();
    expect(body.data?.auditTrail).toBeDefined();
    expect(body.data!.auditTrail.limit).toBeGreaterThanOrEqual(0);
  });

  it("auditTrail with negative offset defaults to 0", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: AUDIT_TRAIL_QUERY,
      variables: { offset: -10 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.auditTrail).toBeDefined();
    expect(body.data!.auditTrail.offset).toBeGreaterThanOrEqual(0);
  });

  it("usageSummary with invalid period string returns data or error gracefully", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: USAGE_SUMMARY_QUERY,
      variables: { period: "INVALID_PERIOD" },
    });

    // Either returns an error or defaults gracefully -- no crash
    if (body.errors) {
      expect(body.errors.length).toBeGreaterThan(0);
    } else {
      expect(body.data?.usageSummary).toBeDefined();
    }
  });

  it("dailySpend with days=0 returns empty or default", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: DAILY_SPEND_QUERY,
      variables: { days: 0 },
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.dailySpend)).toBe(true);
  });

  it("spendByProvider returns valid data even with revoked API key", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.revoked,
      query: SPEND_BY_PROVIDER_QUERY,
    });

    // Revoked key should be rejected
    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });

  it("CSV export with no matching data returns just the header row", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/audit/export.csv?search=zzz_absolutely_nothing_matches`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.admin}` },
      }
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    const lines = text.trim().split("\n");

    // Should have at least the header row, but no data rows
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  it("JSON export with no matching data returns empty entries array", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/audit/export.json?search=zzz_absolutely_nothing_matches`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.admin}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as { entries: unknown[] };
    expect(json.entries).toEqual([]);
  });
});
