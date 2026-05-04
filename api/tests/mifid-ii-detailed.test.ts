/**
 * Sprint 11 Deliverable 1: MiFID II Detailed Export with Article Mapping
 *
 * Tests for POST /v1/exports/mifid-ii/detailed endpoint.
 *
 * Enhanced MiFID II export that maps evidence to specific articles:
 * - Article 17: Algorithmic Trading (algorithm description, trading decisions)
 * - Article 25: Investment Decision Record-Keeping (decision audit trail)
 * - Article 16: Organisational Requirements (order generation records)
 * - Article 48: Risk Controls (anomaly counts, risk classifications)
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
  gdprBypassUpdate,
  API_KEYS,
  IDS,
  API_BASE_URL,
  countAuditLogs,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Test API keys
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_mifid2d_foundation_01",
  compliance: "wrt_test_mifid2d_compliance_02",
  enterprise: "wrt_test_mifid2d_enterprise_03",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb600000-0000-4000-8000-000000000001",
  compliance: "bb600000-0000-4000-8000-000000000002",
  enterprise: "bb600000-0000-4000-8000-000000000003",
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
// Fixtures
// ---------------------------------------------------------------------------

async function seedMifidDetailedFixtures(): Promise<void> {
  const p = getPool();

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

  // Seed response_text on existing turns so article_25 evidence has data
  await gdprBypassUpdate(p,
    `UPDATE turns SET response_text = 'Based on analysis, recommend buying AAPL at current price.' WHERE id = '${IDS.turnA1_1}'`);
  await gdprBypassUpdate(p,
    `UPDATE turns SET response_text = 'Risk assessment complete: portfolio exposure within limits.' WHERE id = '${IDS.turnA1_2}'`);

  // Seed tool_calls with trade-related tool names for article_16 evidence
  await gdprBypassUpdate(p,
    `UPDATE tool_calls SET tool_name = 'ExecuteTrade', tool_input = '{"symbol":"AAPL","quantity":100,"action":"buy"}' WHERE id = '${IDS.toolCall1}'`);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedMifidDetailedFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/exports/mifid-ii/detailed — Top-level structure
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — top-level structure", () => {
  it("returns standard, generatedAt, projectId, articles, and metadata", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(200);
    expect(body.standard).toBe("MiFID II / MiFIR");
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.generatedAt).toBe("string");
    expect(body.projectId).toBe(IDS.projectAlpha);
    expect(body.articles).toBeDefined();
    expect(body.metadata).toBeDefined();
  });

  it("returns all 4 articles (article_17, article_25, article_16, article_48)", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(200);

    const articles = body.articles as Record<string, unknown>;
    expect(articles).toBeDefined();
    expect(articles).toHaveProperty("article_17");
    expect(articles).toHaveProperty("article_25");
    expect(articles).toHaveProperty("article_16");
    expect(articles).toHaveProperty("article_48");
  });

  it("metadata contains dateRange and generatorVersion", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const metadata = body.metadata as Record<string, unknown>;
    expect(metadata).toBeDefined();
    expect(metadata.dateRange).toBeDefined();

    const dateRange = metadata.dateRange as Record<string, unknown>;
    expect(dateRange).toHaveProperty("start");
    expect(dateRange).toHaveProperty("end");

    expect(metadata.generatorVersion).toBeDefined();
    expect(typeof metadata.generatorVersion).toBe("string");
  });
});

// =========================================================================
// Article 17: Algorithmic Trading
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — Article 17", () => {
  it("article_17 has title, description, and evidence", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const a17 = articles.article_17;

    expect(a17.title).toBe("Algorithmic Trading");
    expect(typeof a17.description).toBe("string");
    expect(a17.evidence).toBeDefined();
  });

  it("article_17 evidence contains algorithmDescription with model, provider, systemPromptHash, sessionCount", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_17.evidence as Record<string, unknown>;
    const algDesc = evidence.algorithmDescription as Record<string, unknown>;

    expect(algDesc).toBeDefined();
    expect(algDesc).toHaveProperty("model");
    expect(algDesc).toHaveProperty("provider");
    expect(algDesc).toHaveProperty("systemPromptHash");
    expect(algDesc).toHaveProperty("sessionCount");
    expect(typeof algDesc.sessionCount).toBe("number");
  });

  it("article_17 evidence contains tradingDecisions array with sessionId, intent, turnCount, toolCalls", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_17.evidence as Record<string, unknown>;
    const decisions = evidence.tradingDecisions as Array<Record<string, unknown>>;

    expect(Array.isArray(decisions)).toBe(true);
    expect(decisions.length).toBeGreaterThanOrEqual(1);

    const d = decisions[0];
    expect(d).toHaveProperty("sessionId");
    expect(d).toHaveProperty("intent");
    expect(d).toHaveProperty("turnCount");
    expect(d).toHaveProperty("toolCalls");
    expect(typeof d.turnCount).toBe("number");
    expect(typeof d.toolCalls).toBe("number");
  });
});

// =========================================================================
// Article 25: Investment Decision Record-Keeping
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — Article 25", () => {
  it("article_25 has title, description, and evidence", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const a25 = articles.article_25;

    expect(a25.title).toBe("Investment Decision Record-Keeping");
    expect(typeof a25.description).toBe("string");
    expect(a25.evidence).toBeDefined();
  });

  it("article_25 evidence contains decisionAuditTrail array with required fields", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_25.evidence as Record<string, unknown>;
    const trail = evidence.decisionAuditTrail as Array<Record<string, unknown>>;

    expect(Array.isArray(trail)).toBe(true);
    expect(trail.length).toBeGreaterThanOrEqual(1);

    const entry = trail[0];
    expect(entry).toHaveProperty("sessionId");
    expect(entry).toHaveProperty("turnId");
    expect(entry).toHaveProperty("timestamp");
    expect(entry).toHaveProperty("model");
    expect(entry).toHaveProperty("responseText");
  });

  it("article_25 evidence contains totalDecisions as a number", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_25.evidence as Record<string, unknown>;

    expect(typeof evidence.totalDecisions).toBe("number");
    expect(evidence.totalDecisions).toBeGreaterThanOrEqual(0);
  });
});

// =========================================================================
// Article 16: Organisational Requirements
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — Article 16", () => {
  it("article_16 has title, description, and evidence", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const a16 = articles.article_16;

    expect(a16.title).toBe("Organisational Requirements");
    expect(typeof a16.description).toBe("string");
    expect(a16.evidence).toBeDefined();
  });

  it("article_16 evidence contains orderGenerationRecords with tool call data", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_16.evidence as Record<string, unknown>;
    const records = evidence.orderGenerationRecords as Array<Record<string, unknown>>;

    expect(Array.isArray(records)).toBe(true);

    // We seeded at least one tool call, so there should be entries
    if (records.length > 0) {
      const rec = records[0];
      expect(rec).toHaveProperty("sessionId");
      expect(rec).toHaveProperty("turnId");
      expect(rec).toHaveProperty("toolName");
      expect(rec).toHaveProperty("toolInput");
    }
  });

  it("article_16 evidence contains totalOrderEvents as a number", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_16.evidence as Record<string, unknown>;

    expect(typeof evidence.totalOrderEvents).toBe("number");
    expect(evidence.totalOrderEvents).toBeGreaterThanOrEqual(0);
  });
});

// =========================================================================
// Article 48: Risk Controls
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — Article 48", () => {
  it("article_48 has title, description, and evidence", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const a48 = articles.article_48;

    expect(a48.title).toBe("Risk Controls");
    expect(typeof a48.description).toBe("string");
    expect(a48.evidence).toBeDefined();
  });

  it("article_48 evidence contains anomalyCount and anomalyByType", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_48.evidence as Record<string, unknown>;

    expect(typeof evidence.anomalyCount).toBe("number");
    expect(evidence.anomalyByType).toBeDefined();
    expect(typeof evidence.anomalyByType).toBe("object");
  });

  it("article_48 evidence contains riskClassifications with 4 levels", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_48.evidence as Record<string, unknown>;
    const riskClass = evidence.riskClassifications as Record<string, number>;

    expect(riskClass).toBeDefined();
    expect(riskClass).toHaveProperty("low");
    expect(riskClass).toHaveProperty("medium");
    expect(riskClass).toHaveProperty("high");
    expect(riskClass).toHaveProperty("critical");
    expect(typeof riskClass.low).toBe("number");
    expect(typeof riskClass.medium).toBe("number");
    expect(typeof riskClass.high).toBe("number");
    expect(typeof riskClass.critical).toBe("number");
  });

  it("article_48 evidence contains monitoringActive boolean", async () => {
    const { body } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_48.evidence as Record<string, unknown>;

    expect(typeof evidence.monitoringActive).toBe("boolean");
  });
});

// =========================================================================
// Filtering
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — filtering", () => {
  it("date range filtering limits results", async () => {
    // Use a narrow date range that should produce fewer or no results
    const { body, response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01T00:00:00Z",
        endDate: "2020-01-02T00:00:00Z",
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(200);

    // With a past date range, decision trail should be empty or smaller
    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_25.evidence as Record<string, unknown>;
    const trail = evidence.decisionAuditTrail as Array<Record<string, unknown>>;
    expect(Array.isArray(trail)).toBe(true);
    expect(trail.length).toBe(0);
  });

  it("modelId filter restricts to specified model", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      {
        projectId: IDS.projectAlpha,
        modelId: "claude-sonnet-4-20250514",
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(200);

    // Only claude-sonnet-4-20250514 sessions/turns should appear in evidence
    const articles = body.articles as Record<string, Record<string, unknown>>;
    const evidence = articles.article_25.evidence as Record<string, unknown>;
    const trail = evidence.decisionAuditTrail as Array<Record<string, unknown>>;

    if (trail.length > 0) {
      for (const entry of trail) {
        expect(entry.model).toBe("claude-sonnet-4-20250514");
      }
    }
  });
});

// =========================================================================
// Input validation
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — input validation", () => {
  it("returns 400 when projectId is missing", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      {},
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });
});

// =========================================================================
// Authentication & Authorization
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — auth & gating", () => {
  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha }
    );

    expect(response.status).toBe(401);
  });

  it("authenticated key can access detailed export", async () => {
    const { response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(200);
  });

  it("admin key can access detailed export", async () => {
    const { response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      API_KEYS.admin
    );

    expect(response.status).toBe(200);
  });
});

// =========================================================================
// Project scoping
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — project scoping", () => {
  it("scoped key cannot access a different project", async () => {
    // Enterprise key is scoped to projectAlpha; requesting projectBeta should fail
    const { response } = await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectBeta },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(403);
  });
});

// =========================================================================
// Audit logging
// =========================================================================

describe("POST /v1/exports/mifid-ii/detailed — audit logging", () => {
  it("creates audit log entry for successful detailed export", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/exports/mifid-ii/detailed",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
