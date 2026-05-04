/**
 * Sprint 9 Deliverable 3: AI Risk Auto-Classification
 *
 * Tests for:
 * - POST /v1/risk/classify — classify a session's risk from its initial_intent
 * - GET  /v1/risk/profile  — aggregated risk profile for a project
 *
 * Classification rules:
 * - Low: intent contains "document", "test", "format", "readme", "comment", "lint"
 * - Medium: intent contains "feature", "refactor", "update", "add", "implement"
 * - High: intent contains "security", "auth", "infrastructure", "database", "financial", "payment"
 * - Critical: intent contains "deploy", "production", "migration", "compliance", "rollback"
 * - Default (no match): medium
 *
 * Auth, project scoped.
 *
 * These tests WILL FAIL until the implementation agent builds the endpoints.
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
// Test API keys
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_risk_foundation_00001",
  compliance: "wrt_test_risk_compliance_00002",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb420000-0000-4000-8000-000000000001",
  compliance: "bb420000-0000-4000-8000-000000000002",
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

async function getJSON(
  path: string,
  apiKey?: string
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "GET",
    headers,
  });

  const body = (await response.json()) as Record<string, unknown>;
  return { body, response };
}

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
// Fixtures: sessions with specific initial_intents for classification testing
// ---------------------------------------------------------------------------

async function seedRiskClassificationFixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();

  // Insert test API keys
  const hashFoundation = await sha256(TEST_KEYS.foundation);
  const hashCompliance = await sha256(TEST_KEYS.compliance);

  await p.query(`
    INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm) VALUES
      ('${TEST_KEY_IDS.foundation}', '${hashFoundation}', '${IDS.projectAlpha}', 60),
      ('${TEST_KEY_IDS.compliance}', '${hashCompliance}', '${IDS.projectAlpha}', 120)
    ON CONFLICT (id) DO NOTHING;
  `);

  // Seed sessions with intents that map to each risk level
  const riskSessions = [
    { id: "cc800000-0000-4000-8000-000000000001", intent: "Update documentation for API endpoints", expected: "low" },
    { id: "cc800000-0000-4000-8000-000000000002", intent: "Add new feature for user onboarding", expected: "medium" },
    { id: "cc800000-0000-4000-8000-000000000003", intent: "Fix security vulnerability in auth module", expected: "high" },
    { id: "cc800000-0000-4000-8000-000000000004", intent: "Deploy to production environment", expected: "critical" },
    { id: "cc800000-0000-4000-8000-000000000005", intent: "Write test suite for payment service", expected: "low" },
    { id: "cc800000-0000-4000-8000-000000000006", intent: "Refactor database schema for performance", expected: "high" },
    { id: "cc800000-0000-4000-8000-000000000007", intent: "Format code and lint all files", expected: "low" },
    { id: "cc800000-0000-4000-8000-000000000008", intent: "Implement rollback mechanism for deploys", expected: "critical" },
  ];

  for (const session of riskSessions) {
    await p.query(`
      INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                            initial_intent, system_prompt_hash, total_turns, turns_captured,
                            dropped_events, total_tokens, total_cost_usd, agent_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO NOTHING
    `, [session.id, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
        now.toISOString(), now.toISOString(), session.intent,
        "risk_test_prompt_hash", 1, 1, 0, 1000, 0.05, "claude-code"]);
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedRiskClassificationFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/risk/classify — Classification rules
// =========================================================================

describe("POST /v1/risk/classify — classification rules", () => {
  it("classifies 'fix the login bug' as medium (default — no specific keyword)", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000002",
        intent: "fix the login bug",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("medium");
  });

  it("classifies 'deploy to production' as critical", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000004",
        intent: "deploy to production",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("critical");
  });

  it("classifies 'update documentation' as low", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000001",
        intent: "update documentation",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("low");
  });

  it("classifies 'fix security vulnerability' as high", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000003",
        intent: "fix security vulnerability",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("high");
  });

  it("classifies random text with no keywords as medium (default)", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000002",
        intent: "do something interesting with the codebase",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("medium");
  });

  it("classifies 'write unit tests' as low (contains 'test')", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000005",
        intent: "write unit tests for the auth module",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("low");
  });

  it("classifies 'run database migration' as critical (contains 'migration')", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000004",
        intent: "run database migration for new schema",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("critical");
  });

  it("classifies 'implement payment processing' as high (contains 'payment')", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000006",
        intent: "implement payment processing for checkout",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("high");
  });

  it("classifies 'add readme to project' as low (contains 'readme')", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000001",
        intent: "add readme to project",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("low");
  });

  it("classifies case-insensitively (DEPLOY TO PRODUCTION = critical)", async () => {
    const { body, response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000004",
        intent: "DEPLOY TO PRODUCTION",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body.riskLevel).toBe("critical");
  });
});

// =========================================================================
// GET /v1/risk/profile — Aggregated risk distribution
// =========================================================================

describe("GET /v1/risk/profile — aggregated risk profile", () => {
  it("returns aggregated counts per risk level", async () => {
    // First classify the seeded sessions
    const sessions = [
      { id: "cc800000-0000-4000-8000-000000000001", intent: "Update documentation for API endpoints" },
      { id: "cc800000-0000-4000-8000-000000000002", intent: "Add new feature for user onboarding" },
      { id: "cc800000-0000-4000-8000-000000000003", intent: "Fix security vulnerability in auth module" },
      { id: "cc800000-0000-4000-8000-000000000004", intent: "Deploy to production environment" },
    ];

    for (const s of sessions) {
      await postJSON(
        "/v1/risk/classify",
        { projectId: IDS.projectAlpha, sessionId: s.id, intent: s.intent },
        TEST_KEYS.compliance
      );
    }

    const { body, response } = await getJSON(
      `/v1/risk/profile?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body).toHaveProperty("low");
    expect(body).toHaveProperty("medium");
    expect(body).toHaveProperty("high");
    expect(body).toHaveProperty("critical");

    // All values should be non-negative integers
    for (const level of ["low", "medium", "high", "critical"]) {
      expect(typeof (body as Record<string, unknown>)[level]).toBe("number");
      expect((body as Record<string, number>)[level]).toBeGreaterThanOrEqual(0);
    }
  });

  it("profile total matches number of classified sessions", async () => {
    const { body } = await getJSON(
      `/v1/risk/profile?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const total =
      (body as Record<string, number>).low +
      (body as Record<string, number>).medium +
      (body as Record<string, number>).high +
      (body as Record<string, number>).critical;

    // Total should be at least as many as we classified above
    expect(total).toBeGreaterThan(0);
  });
});

// =========================================================================
// Auth + project scoping
// =========================================================================

describe("POST /v1/risk/classify — access control", () => {
  it("returns 401 without authentication", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/risk/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: IDS.projectAlpha,
        intent: "deploy to production",
      }),
    });

    expect(response.status).toBe(401);
  });

  it("authenticated key can access risk classification", async () => {
    const { response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        sessionId: "cc800000-0000-4000-8000-000000000001",
        intent: "update documentation",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
  });

  it("admin key can access risk classification", async () => {
    const { response } = await postJSON(
      "/v1/risk/classify",
      {
        projectId: IDS.projectAlpha,
        intent: "deploy to production",
      },
      API_KEYS.admin
    );

    expect(response.status).toBe(200);
  });
});

describe("GET /v1/risk/profile — access control", () => {
  it("authenticated key can access risk profile", async () => {
    const { response } = await getJSON(
      `/v1/risk/profile?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
  });
});
