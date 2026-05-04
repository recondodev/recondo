/**
 * Sprint 12 Deliverable: Structured Query Builder API
 *
 * Tests for POST /v1/query — structured query builder with:
 * - 8 query types: sessions, turns, anomalies, cost, tools, risk, compliance, provenance
 * - 6 shortcuts: session_complete, provenance_chain, recent_anomalies, management_review, top_spend_team, model_comparison
 * - 3 output formats: json, table, narrative
 * - Framework attribution on every response
 * - Full-text search via PostgreSQL tsvector
 * - Query safety: default limit 100, max 1000, project-scoped
 * - 
 *
 * These tests WILL FAIL until the implementation agent builds the endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  gdprBypassUpdate,
  API_KEYS,
  IDS,
  API_BASE_URL,
  countAuditLogs,
  clearAuditLog,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test API keys
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_qb_foundation_key_0001",
  compliance: "wrt_test_qb_compliance_key_0002",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb120000-0000-4000-8000-000000000001",
  compliance: "bb120000-0000-4000-8000-000000000002",
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

async function postQuery(
  body: Record<string, unknown>,
  apiKey?: string
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}/v1/query`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const responseBody = (await response.json()) as Record<string, unknown>;
  return { body: responseBody, response };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedQueryBuilderFixtures(): Promise<void> {
  const p = getPool();

  // Insert test API keys
  const hashFoundation = await sha256(TEST_KEYS.foundation);
  const hashCompliance = await sha256(TEST_KEYS.compliance);

  await p.query(`
    INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm) VALUES
      ('${TEST_KEY_IDS.foundation}', '${hashFoundation}', '${IDS.projectAlpha}', 60),
      ('${TEST_KEY_IDS.compliance}', '${hashCompliance}', '${IDS.projectAlpha}', 120)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Ensure search_vector is populated for full-text search tests
  // The base fixtures seed sessions with initial_intent values like
  // "Refactor authentication module" and "Write unit tests for payment service"
  // Update search_vector on turns to include session intent + response_text for searchability
  await gdprBypassUpdate(p, `
    UPDATE turns SET search_vector = to_tsvector('english',
      coalesce(model, '') || ' ' ||
      coalesce(provider, '') || ' ' ||
      coalesce(response_text, ''))
    WHERE search_vector IS NULL
  `);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedQueryBuilderFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// 1. Query type tests (24 tests — 3 per query type)
// =========================================================================

describe("POST /v1/query — query types", () => {
  // --- sessions ---
  describe("sessions queryType", () => {
    it("returns session data", async () => {
      const { body, response } = await postQuery(
        { queryType: "sessions" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("totalCount");
      expect(body).toHaveProperty("attribution");
      expect(Array.isArray(body.data)).toBe(true);
      expect((body.data as unknown[]).length).toBeGreaterThan(0);
    });

    it("filters by provider", async () => {
      const { body, response } = await postQuery(
        { queryType: "sessions", filters: { provider: "anthropic" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      expect(data.length).toBeGreaterThan(0);
      for (const row of data) {
        expect(row.provider).toBe("anthropic");
      }
    });

    it("filters by model", async () => {
      const { body, response } = await postQuery(
        { queryType: "sessions", filters: { model: "gpt-4o" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      expect(data.length).toBeGreaterThan(0);
      for (const row of data) {
        expect(row.model).toBe("gpt-4o");
      }
    });
  });

  // --- turns ---
  describe("turns queryType", () => {
    it("returns turn data", async () => {
      const { body, response } = await postQuery(
        { queryType: "turns" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("totalCount");
      expect(Array.isArray(body.data)).toBe(true);
      expect((body.data as unknown[]).length).toBeGreaterThan(0);
    });

    it("filters by sessionId", async () => {
      const { body, response } = await postQuery(
        { queryType: "turns", filters: { sessionId: IDS.sessionAlpha1 } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      expect(data.length).toBe(3); // sessionAlpha1 has 3 turns
    });

    it("filters by model", async () => {
      const { body, response } = await postQuery(
        { queryType: "turns", filters: { model: "claude-sonnet-4-20250514" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      expect(data.length).toBeGreaterThan(0);
      for (const row of data) {
        expect(row.model).toBe("claude-sonnet-4-20250514");
      }
    });
  });

  // --- anomalies ---
  describe("anomalies queryType", () => {
    it("returns anomaly data", async () => {
      const { body, response } = await postQuery(
        { queryType: "anomalies" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("totalCount");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("filters by severity", async () => {
      const { body, response } = await postQuery(
        { queryType: "anomalies", filters: { severity: "critical" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      // We have at least anomaly2 with severity "critical"
      for (const row of data) {
        expect(row.severity).toBe("critical");
      }
    });

    it("filters by anomalyType", async () => {
      const { body, response } = await postQuery(
        { queryType: "anomalies", filters: { anomalyType: "hash_mismatch" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      for (const row of data) {
        expect(row.anomaly_type).toBe("hash_mismatch");
      }
    });
  });

  // --- cost ---
  describe("cost queryType", () => {
    it("returns cost aggregation data", async () => {
      const { body, response } = await postQuery(
        { queryType: "cost" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("totalCount");
      expect(body).toHaveProperty("attribution");
    });

    it("groups by model", async () => {
      const { body, response } = await postQuery(
        { queryType: "cost", groupBy: "model" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      expect(data.length).toBeGreaterThan(0);
      // Each row should have a model field when grouped by model
      for (const row of data) {
        expect(row).toHaveProperty("model");
      }
    });

    it("groups by provider with daily period", async () => {
      const { body, response } = await postQuery(
        { queryType: "cost", groupBy: "provider", filters: { period: "daily" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      for (const row of data) {
        expect(row).toHaveProperty("provider");
      }
    });
  });

  // --- tools ---
  describe("tools queryType", () => {
    it("returns tool usage data", async () => {
      const { body, response } = await postQuery(
        { queryType: "tools" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("totalCount");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("filters by toolName", async () => {
      const { body, response } = await postQuery(
        { queryType: "tools", filters: { toolName: "Read" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      expect(data.length).toBeGreaterThan(0);
      for (const row of data) {
        expect(row.tool_name ?? row.toolName).toBe("Read");
      }
    });

    it("filters by agent", async () => {
      const { body, response } = await postQuery(
        { queryType: "tools", filters: { agent: "claude-code" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      const data = body.data as Record<string, unknown>[];
      for (const row of data) {
        expect(row.agent_id ?? row.agent).toBe("claude-code");
      }
    });
  });

  // --- risk ---
  describe("risk queryType", () => {
    it("returns risk classification data", async () => {
      const { body, response } = await postQuery(
        { queryType: "risk" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("totalCount");
      expect(body).toHaveProperty("attribution");
    });

    it("filters by riskLevel", async () => {
      const { body, response } = await postQuery(
        { queryType: "risk", filters: { riskLevel: "high" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      // Even if empty, the shape should be correct
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("filters by dateRange", async () => {
      const now = new Date();
      const weekAgo = new Date(now.getTime() - 7 * 24 * 3600_000);
      const { body, response } = await postQuery(
        {
          queryType: "risk",
          filters: {
            dateRange: { from: weekAgo.toISOString(), to: now.toISOString() },
          },
        },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // --- compliance ---
  describe("compliance queryType", () => {
    it("returns compliance status data", async () => {
      const { body, response } = await postQuery(
        { queryType: "compliance" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("totalCount");
      expect(body).toHaveProperty("attribution");
    });

    it("filters by framework", async () => {
      const { body, response } = await postQuery(
        { queryType: "compliance", filters: { framework: "soc2" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("filters by clause", async () => {
      const { body, response } = await postQuery(
        { queryType: "compliance", filters: { framework: "iso42001", clause: "9.3" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(body.data)).toBe(true);
    });
  });

  // --- provenance ---
  describe("provenance queryType", () => {
    it("returns provenance chain for artifact", async () => {
      const { body, response } = await postQuery(
        { queryType: "provenance", filters: { artifactPath: "auth.ts" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("totalCount");
      expect(body).toHaveProperty("attribution");
    });

    it("requires artifactPath filter", async () => {
      const { body, response } = await postQuery(
        { queryType: "provenance" },
        API_KEYS.alpha
      );

      // provenance without artifactPath should be an error
      expect(response.status).toBe(400);
      expect(body).toHaveProperty("error");
    });

    it("returns empty for nonexistent artifact", async () => {
      const { body, response } = await postQuery(
        { queryType: "provenance", filters: { artifactPath: "nonexistent_file_xyz.rs" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(Array.isArray(body.data)).toBe(true);
      expect((body.data as unknown[]).length).toBe(0);
    });
  });

  // --- invalid queryType ---
  it("returns 400 for unknown queryType", async () => {
    const { body, response } = await postQuery(
      { queryType: "foobar_invalid" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
    expect(body).toHaveProperty("error");
  });
});

// =========================================================================
// 2. Output format tests (6 tests)
// =========================================================================

describe("POST /v1/query — output formats", () => {
  it("json format returns { data, totalCount }", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions", format: "json" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("totalCount");
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.totalCount).toBe("number");
  });

  it("table format returns { columns, rows, totalCount }", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions", format: "table" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body).toHaveProperty("columns");
    expect(body).toHaveProperty("rows");
    expect(body).toHaveProperty("totalCount");
    expect(Array.isArray(body.columns)).toBe(true);
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.totalCount).toBe("number");
  });

  it("narrative format returns { text, attribution }", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions", format: "narrative" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body).toHaveProperty("text");
    expect(body).toHaveProperty("attribution");
    expect(typeof body.text).toBe("string");
    expect(typeof body.attribution).toBe("string");
    expect((body.text as string).length).toBeGreaterThan(0);
  });

  it("default format is json when omitted", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    // Default is json format: { data, totalCount }
    expect(body).toHaveProperty("data");
    expect(body).toHaveProperty("totalCount");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns 400 for invalid format", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions", format: "xml" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
    expect(body).toHaveProperty("error");
  });

  it("each format includes framework attribution", async () => {
    // json format
    const jsonResp = await postQuery(
      { queryType: "sessions", format: "json" },
      API_KEYS.alpha
    );
    expect(jsonResp.body).toHaveProperty("attribution");

    // table format
    const tableResp = await postQuery(
      { queryType: "sessions", format: "table" },
      API_KEYS.alpha
    );
    expect(tableResp.body).toHaveProperty("attribution");

    // narrative format
    const narrativeResp = await postQuery(
      { queryType: "sessions", format: "narrative" },
      API_KEYS.alpha
    );
    expect(narrativeResp.body).toHaveProperty("attribution");
  });
});

// =========================================================================
// 3. Shortcut tests (12 tests — 2 per shortcut)
// =========================================================================

describe("POST /v1/query — shortcuts", () => {
  // --- session_complete ---
  describe("session_complete shortcut", () => {
    it("returns session completeness status", async () => {
      const { body, response } = await postQuery(
        { shortcut: "session_complete", params: { sessionId: IDS.sessionAlpha1 } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("attribution");
    });

    it("returns 400 when sessionId param is missing", async () => {
      const { body, response } = await postQuery(
        { shortcut: "session_complete", params: {} },
        API_KEYS.alpha
      );

      expect(response.status).toBe(400);
      expect(body).toHaveProperty("error");
    });
  });

  // --- provenance_chain ---
  describe("provenance_chain shortcut", () => {
    it("returns provenance chain for artifact", async () => {
      const { body, response } = await postQuery(
        { shortcut: "provenance_chain", params: { artifactPath: "auth.ts" } },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("attribution");
    });

    it("returns 400 when artifactPath param is missing", async () => {
      const { body, response } = await postQuery(
        { shortcut: "provenance_chain", params: {} },
        API_KEYS.alpha
      );

      expect(response.status).toBe(400);
      expect(body).toHaveProperty("error");
    });
  });

  // --- recent_anomalies ---
  describe("recent_anomalies shortcut", () => {
    it("returns anomalies from last 90 days", async () => {
      const { body, response } = await postQuery(
        { shortcut: "recent_anomalies" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("attribution");
      expect(Array.isArray(body.data)).toBe(true);
    });

    it("works with no params", async () => {
      // recent_anomalies requires no params; passing empty params is fine
      const { body, response } = await postQuery(
        { shortcut: "recent_anomalies", params: {} },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
    });
  });

  // --- management_review ---
  describe("management_review shortcut", () => {
    it("returns ISO 42001 Cl.9.3 management review summary", async () => {
      const { body, response } = await postQuery(
        { shortcut: "management_review" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("attribution");
    });

    it("works with no params", async () => {
      const { body, response } = await postQuery(
        { shortcut: "management_review", params: {} },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
    });
  });

  // --- top_spend_team ---
  describe("top_spend_team shortcut", () => {
    it("returns the team with highest spend", async () => {
      const { body, response } = await postQuery(
        { shortcut: "top_spend_team" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("attribution");
    });

    it("works with no params", async () => {
      const { body, response } = await postQuery(
        { shortcut: "top_spend_team", params: {} },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
    });
  });

  // --- model_comparison ---
  describe("model_comparison shortcut", () => {
    it("returns model cost comparison data", async () => {
      const { body, response } = await postQuery(
        { shortcut: "model_comparison" },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
      expect(body).toHaveProperty("attribution");
      const data = body.data as Record<string, unknown>[];
      // Should have data for models present in fixtures (claude-sonnet-4-20250514, gpt-4o)
      expect(data.length).toBeGreaterThan(0);
    });

    it("works with no params", async () => {
      const { body, response } = await postQuery(
        { shortcut: "model_comparison", params: {} },
        API_KEYS.alpha
      );

      expect(response.status).toBe(200);
      expect(body).toHaveProperty("data");
    });
  });
});

// =========================================================================
// 4. Framework attribution tests (3 tests)
// =========================================================================

describe("POST /v1/query — framework attribution", () => {
  it("anomalies query has ISO 42001 Cl.9.1 attribution", async () => {
    const { body, response } = await postQuery(
      { queryType: "anomalies" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.attribution).toContain("ISO 42001");
    expect(body.attribution).toContain("Cl.9.1");
  });

  it("cost query has Usage Intelligence attribution", async () => {
    const { body, response } = await postQuery(
      { queryType: "cost" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.attribution).toContain("Usage Intelligence");
  });

  it("provenance query has SOC 2 PI1 attribution", async () => {
    const { body, response } = await postQuery(
      { queryType: "provenance", filters: { artifactPath: "auth.ts" } },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.attribution).toContain("SOC 2");
    expect(body.attribution).toContain("PI1");
  });
});

// =========================================================================
// 5. Query safety tests (5 tests)
// =========================================================================

describe("POST /v1/query — query safety", () => {
  it("default limit is 100", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    // With only 2 sessions in alpha, we can't verify the cap directly,
    // but the response should indicate the applied limit or totalCount
    expect(Array.isArray(body.data)).toBe(true);
    // The number of returned rows should not exceed 100
    expect((body.data as unknown[]).length).toBeLessThanOrEqual(100);
  });

  it("custom limit up to 1000 works", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions", limit: 500 },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    // Result count should not exceed the requested limit
    expect((body.data as unknown[]).length).toBeLessThanOrEqual(500);
  });

  it("limit > 1000 is capped to 1000", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions", limit: 5000 },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    // Should succeed but cap at 1000
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBeLessThanOrEqual(1000);
  });

  it("queries are project-scoped — beta key cannot see alpha sessions", async () => {
    // Alpha has 2 sessions (sessionAlpha1, sessionAlpha2)
    // Beta has 1 session (sessionBeta1)
    // Querying with alpha key should not return beta sessions
    const { body: alphaBody } = await postQuery(
      { queryType: "sessions" },
      API_KEYS.alpha
    );
    const { body: betaBody } = await postQuery(
      { queryType: "sessions" },
      API_KEYS.beta
    );

    expect(alphaBody).toHaveProperty("data");
    expect(betaBody).toHaveProperty("data");

    const alphaSessionIds = (alphaBody.data as Record<string, unknown>[]).map(
      (s) => s.id
    );
    const betaSessionIds = (betaBody.data as Record<string, unknown>[]).map(
      (s) => s.id
    );

    // Alpha should see alpha sessions, not beta
    expect(alphaSessionIds).not.toContain(IDS.sessionBeta1);
    // Beta should see beta sessions, not alpha
    expect(betaSessionIds).not.toContain(IDS.sessionAlpha1);
    expect(betaSessionIds).not.toContain(IDS.sessionAlpha2);
  });

  it("returns 401 without auth", async () => {
    const { response: noAuthResp } = await postQuery(
      { queryType: "sessions" }
    );
    expect(noAuthResp.status).toBe(401);
  });
});

// =========================================================================
// 6. Full-text search tests (2 tests)
// =========================================================================

describe("POST /v1/query — full-text search", () => {
  it("sessions with search filter returns matching sessions", async () => {
    // Fixture session initial_intent: "Refactor authentication module"
    const { body, response } = await postQuery(
      { queryType: "sessions", filters: { search: "authentication" } },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBeGreaterThan(0);
  });

  it("search with no matches returns empty data", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions", filters: { search: "xyznonexistentquerytermzzz" } },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect((body.data as unknown[]).length).toBe(0);
  });
});

// =========================================================================
// 7. Audit + misc tests (3 tests)
// =========================================================================

describe("POST /v1/query — audit and validation", () => {
  it("query is audit logged", async () => {
    await clearAuditLog();

    const countBefore = await countAuditLogs();

    await postQuery(
      { queryType: "sessions" },
      API_KEYS.alpha
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  it("returns 400 when both queryType and shortcut are provided", async () => {
    const { body, response } = await postQuery(
      { queryType: "sessions", shortcut: "recent_anomalies" },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
    expect(body).toHaveProperty("error");
  });

  it("returns 400 for empty body", async () => {
    const { body, response } = await postQuery(
      {},
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
    expect(body).toHaveProperty("error");
  });
});
