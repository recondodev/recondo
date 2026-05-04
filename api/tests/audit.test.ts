/**
 * Access audit logging tests for Sprint 4 API (SOC 2 CC6).
 *
 * Covers:
 * - Every successful GraphQL query creates an audit log entry
 * - Failed auth attempts are logged (api_key_id = 'anonymous')
 * - Audit log entry contains correct fields: api_key_id, query_type,
 *   resource_ids, response_status, source_ip, user_agent, timestamp
 * - Append-only enforcement: UPDATE/DELETE on access_audit_log raise exceptions
 * - Multiple queries create multiple log entries
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
  queryAuditLog,
  countAuditLogs,
  clearAuditLog,
  getPool,
  API_KEYS,
  IDS,
  API_BASE_URL,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await teardownDatabase();
});

beforeEach(async () => {
  await clearAuditLog();
});

// =========================================================================
// Audit log creation
// =========================================================================

describe("audit log creation", () => {
  it("creates an audit entry for a sessions query", async () => {
    const countBefore = await countAuditLogs();

    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
    });

    const countAfter = await countAuditLogs();
    expect(countAfter).toBe(countBefore + 1);

    const logs = await queryAuditLog({ api_key_id: IDS.keyAlpha });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const entry = logs[0];
    expect(entry.api_key_id).toBe(IDS.keyAlpha);
    expect(entry.query_type).toBe("sessions");
    expect(entry.response_status).toBe(200);
    expect(entry.timestamp).toBeDefined();
  });

  it("creates an audit entry for a single session query", async () => {
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($id: ID!) { session(id: $id) { id } }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    const logs = await queryAuditLog({
      api_key_id: IDS.keyAlpha,
      query_type: "session",
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const entry = logs[0];
    expect(entry.query_type).toBe("session");
    // resource_ids should contain the session ID
    const resourceIds = entry.resource_ids as string[];
    expect(resourceIds).toContain(IDS.sessionAlpha1);
  });

  it("creates an audit entry for a turn query", async () => {
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($id: ID!) { turn(id: $id) { id } }`,
      variables: { id: IDS.turnA1_1 },
    });

    const logs = await queryAuditLog({
      api_key_id: IDS.keyAlpha,
      query_type: "turn",
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const entry = logs[0];
    const resourceIds = entry.resource_ids as string[];
    expect(resourceIds).toContain(IDS.turnA1_1);
  });

  it("creates an audit entry for a search query", async () => {
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($q: String!, $pid: ID!) { search(query: $q, projectId: $pid) { id } }`,
      variables: { q: "anthropic", pid: IDS.projectAlpha },
    });

    const logs = await queryAuditLog({
      api_key_id: IDS.keyAlpha,
      query_type: "search",
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("creates an audit entry for verifyIntegrity query", async () => {
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($sid: ID!) { verifyIntegrity(sessionId: $sid) { sessionId totalTurns } }`,
      variables: { sid: IDS.sessionAlpha1 },
    });

    const logs = await queryAuditLog({
      api_key_id: IDS.keyAlpha,
      query_type: "verifyIntegrity",
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const entry = logs[0];
    const resourceIds = entry.resource_ids as string[];
    expect(resourceIds).toContain(IDS.sessionAlpha1);
  });

  it("creates an audit entry for anomalies query", async () => {
    await graphql({
      apiKey: API_KEYS.admin,
      query: `query { anomalies { id } }`,
    });

    const logs = await queryAuditLog({
      api_key_id: IDS.keyAdmin,
      query_type: "anomalies",
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// Audit log fields
// =========================================================================

describe("audit log field correctness", () => {
  it("records source_ip", async () => {
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
    });

    const logs = await queryAuditLog({ api_key_id: IDS.keyAlpha });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    // source_ip should be set (localhost variants: 127.0.0.1 or ::1 or ::ffff:127.0.0.1)
    const ip = logs[0].source_ip as string;
    expect(ip).toBeDefined();
    expect(ip).not.toBe("");
  });

  it("records user_agent when provided", async () => {
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
      headers: { "User-Agent": "recondo-test-suite/1.0" },
    });

    const logs = await queryAuditLog({ api_key_id: IDS.keyAlpha });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].user_agent).toBe("recondo-test-suite/1.0");
  });

  it("records timestamp as a valid ISO datetime", async () => {
    const before = new Date();

    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
    });

    const after = new Date();
    const logs = await queryAuditLog({ api_key_id: IDS.keyAlpha });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const ts = new Date(logs[0].timestamp as string);
    expect(ts.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(ts.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });

  it("has a unique UUID id for each entry", async () => {
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
    });
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
    });

    const logs = await queryAuditLog({ api_key_id: IDS.keyAlpha });
    expect(logs.length).toBeGreaterThanOrEqual(2);

    const ids = logs.map((l) => l.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });
});

// =========================================================================
// Failed auth logging
// =========================================================================

describe("failed auth audit logging", () => {
  it("logs failed auth attempt with api_key_id 'anonymous'", async () => {
    const countBefore = await countAuditLogs();

    await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEYS.invalid}`,
      },
      body: JSON.stringify({ query: `query { sessions { id } }` }),
    });

    const countAfter = await countAuditLogs();
    expect(countAfter).toBe(countBefore + 1);

    const logs = await queryAuditLog({ api_key_id: "anonymous" });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const entry = logs[0];
    expect(entry.api_key_id).toBe("anonymous");
    expect(entry.response_status).toBe(401);
  });

  it("logs missing auth header with api_key_id 'anonymous'", async () => {
    await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { sessions { id } }` }),
    });

    const logs = await queryAuditLog({
      api_key_id: "anonymous",
      response_status: 401,
    });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });
});

// =========================================================================
// Append-only enforcement
// =========================================================================

describe("append-only enforcement", () => {
  it("prevents UPDATE on access_audit_log", async () => {
    // First create an entry
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
    });

    const logs = await queryAuditLog({ api_key_id: IDS.keyAlpha });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const entryId = logs[0].id;

    // Try to UPDATE — should throw
    const pool = getPool();
    await expect(
      pool.query(
        `UPDATE access_audit_log SET query_type = 'tampered' WHERE id = $1`,
        [entryId]
      )
    ).rejects.toThrow(/append-only|immutable|not allowed/i);
  });

  it("prevents DELETE on access_audit_log", async () => {
    // First create an entry
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
    });

    const logs = await queryAuditLog({ api_key_id: IDS.keyAlpha });
    expect(logs.length).toBeGreaterThanOrEqual(1);

    const entryId = logs[0].id;

    // Try to DELETE — should throw
    const pool = getPool();
    await expect(
      pool.query(`DELETE FROM access_audit_log WHERE id = $1`, [entryId])
    ).rejects.toThrow(/append-only|immutable|not allowed/i);
  });

  it("allows INSERT (append) to access_audit_log", async () => {
    // Direct insert should work
    const pool = getPool();
    const result = await pool.query(
      `INSERT INTO access_audit_log (api_key_id, query_type, response_status)
       VALUES ('test-direct-insert', 'test', 200)
       RETURNING id`
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].id).toBeDefined();
  });
});

// =========================================================================
// Multiple queries → multiple log entries
// =========================================================================

describe("multiple queries logging", () => {
  it("creates one log entry per GraphQL request", async () => {
    const countBefore = await countAuditLogs();

    // Make 3 requests
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { id } }`,
    });
    await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($id: ID!) { session(id: $id) { id } }`,
      variables: { id: IDS.sessionAlpha1 },
    });
    await graphql({
      apiKey: API_KEYS.beta,
      query: `query { sessions { id } }`,
    });

    const countAfter = await countAuditLogs();
    expect(countAfter).toBe(countBefore + 3);
  });
});
