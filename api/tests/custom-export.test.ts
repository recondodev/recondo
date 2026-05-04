/**
 * Sprint 10 Deliverable 3: Custom YAML-Defined Export Templates
 *
 * Tests for POST /v1/exports/custom endpoint.
 *
 * Accepts a template with sections, each containing a SQL SELECT query.
 * Runs queries against the project's data and returns structured results.
 *
 * Key behaviors:
 * - Only SELECT statements allowed (INSERT/UPDATE/DELETE/DROP rejected)
 * - Queries auto-scoped to project_id
 * - Multiple sections supported
 * - (not compliance)
 * - Auth required, audit logged
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
// Test API keys
// ---------------------------------------------------------------------------

const TEST_KEYS = {
  foundation: "wrt_test_custom_foundation_001",
  compliance: "wrt_test_custom_compliance_002",
  enterprise: "wrt_test_custom_enterprise_003",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb520000-0000-4000-8000-000000000001",
  compliance: "bb520000-0000-4000-8000-000000000002",
  enterprise: "bb520000-0000-4000-8000-000000000003",
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

async function seedCustomExportFixtures(): Promise<void> {
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
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedCustomExportFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/exports/custom — Valid queries
// =========================================================================

describe("POST /v1/exports/custom — valid SELECT queries", () => {
  it("returns data for a valid single-section template", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "AI System Inventory",
          sections: [
            {
              title: "Models Used",
              query: "SELECT DISTINCT model FROM sessions WHERE project_id = $project_id",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(200);
    expect(body.name).toBe("AI System Inventory");
    expect(body.generatedAt).toBeDefined();
    expect(typeof body.generatedAt).toBe("string");

    const sections = body.sections as Array<Record<string, unknown>>;
    expect(Array.isArray(sections)).toBe(true);
    expect(sections.length).toBe(1);

    const section = sections[0];
    expect(section.title).toBe("Models Used");

    const data = section.data as Array<Record<string, unknown>>;
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  it("supports multiple sections in a single template", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Multi-Section Report",
          sections: [
            {
              title: "Session Summary",
              query: "SELECT COUNT(*) AS total FROM sessions WHERE project_id = $project_id",
            },
            {
              title: "Turn Summary",
              query: "SELECT COUNT(*) AS total FROM turns t JOIN sessions s ON t.session_id = s.id WHERE s.project_id = $project_id",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(200);

    const sections = body.sections as Array<Record<string, unknown>>;
    expect(sections.length).toBe(2);
    expect(sections[0].title).toBe("Session Summary");
    expect(sections[1].title).toBe("Turn Summary");

    // Both should have data arrays
    expect(Array.isArray(sections[0].data)).toBe(true);
    expect(Array.isArray(sections[1].data)).toBe(true);
  });

  it("query returning no rows produces empty data array", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Empty Report",
          sections: [
            {
              title: "No Data",
              query: "SELECT * FROM sessions WHERE project_id = $project_id AND model = 'nonexistent-model-xyz'",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(200);

    const sections = body.sections as Array<Record<string, unknown>>;
    const data = sections[0].data as Array<Record<string, unknown>>;
    expect(data.length).toBe(0);
  });
});

// =========================================================================
// SQL injection protection
// =========================================================================

describe("POST /v1/exports/custom — SQL injection blocked", () => {
  it("rejects INSERT statements with 400", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Malicious",
          sections: [
            {
              title: "Injection",
              query: "INSERT INTO sessions (id, provider, started_at, last_active_at, system_prompt_hash, stop_reason) VALUES ('hacked', 'evil', now(), now(), 'x', 'x')",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("rejects UPDATE statements with 400", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Malicious",
          sections: [
            {
              title: "Injection",
              query: "UPDATE sessions SET model = 'hacked' WHERE 1=1",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("rejects DELETE statements with 400", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Malicious",
          sections: [
            {
              title: "Injection",
              query: "DELETE FROM sessions WHERE 1=1",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("rejects DROP statements with 400", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Malicious",
          sections: [
            {
              title: "Injection",
              query: "DROP TABLE sessions",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("rejects mixed SELECT;DROP via semicolon injection with 400", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Malicious",
          sections: [
            {
              title: "Injection",
              query: "SELECT 1; DROP TABLE sessions",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });
});

// =========================================================================
// Input validation
// =========================================================================

describe("POST /v1/exports/custom — input validation", () => {
  it("returns 400 when template is missing", async () => {
    const { response } = await postJSON(
      "/v1/exports/custom",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when projectId is missing", async () => {
    const { response } = await postJSON(
      "/v1/exports/custom",
      {
        template: {
          name: "Test",
          sections: [{ title: "X", query: "SELECT 1" }],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when template sections is empty array", async () => {
    const { response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Empty",
          sections: [],
        },
      },
      TEST_KEYS.enterprise
    );

    expect(response.status).toBe(400);
  });
});

// =========================================================================
// Authentication & Authorization
// =========================================================================

describe("POST /v1/exports/custom — auth & gating", () => {
  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Test",
          sections: [{ title: "X", query: "SELECT 1" }],
        },
      }
    );

    expect(response.status).toBe(401);
  });

});

// =========================================================================
// Audit logging
// =========================================================================

describe("POST /v1/exports/custom — audit logging", () => {
  it("creates audit log entry for successful custom export", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/exports/custom",
      {
        projectId: IDS.projectAlpha,
        template: {
          name: "Audit Test",
          sections: [
            {
              title: "Sessions",
              query: "SELECT COUNT(*) AS cnt FROM sessions WHERE project_id = $project_id",
            },
          ],
        },
      },
      TEST_KEYS.enterprise
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
