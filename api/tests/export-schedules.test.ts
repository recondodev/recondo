/**
 * Sprint 10 Deliverable 4: Scheduled Export Capability
 *
 * Tests for export scheduling endpoints:
 * - POST   /v1/exports/schedule        — create a schedule
 * - GET    /v1/exports/schedules        — list schedules for project
 * - DELETE /v1/exports/schedules/:id    — remove a schedule
 * - POST   /v1/exports/schedules/evaluate — trigger due exports
 *
 * Table: export_schedules (id, project_id, export_type, frequency,
 *        delivery_method, last_run_at, next_run_at, created_at)
 *
 * Auth required, project scoped, audit logged.
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
  foundation: "wrt_test_sched_foundation_001",
  compliance: "wrt_test_sched_compliance_002",
  complianceBeta: "wrt_test_sched_comp_beta_003",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb530000-0000-4000-8000-000000000001",
  compliance: "bb530000-0000-4000-8000-000000000002",
  complianceBeta: "bb530000-0000-4000-8000-000000000003",
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

async function deleteJSON(
  path: string,
  apiKey?: string
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "DELETE",
    headers,
  });

  const body = (await response.json()) as Record<string, unknown>;
  return { body, response };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedScheduleFixtures(): Promise<void> {
  const p = getPool();

  const hashFoundation = await sha256(TEST_KEYS.foundation);
  const hashCompliance = await sha256(TEST_KEYS.compliance);
  const hashComplianceBeta = await sha256(TEST_KEYS.complianceBeta);

  await p.query(`
    INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm) VALUES
      ('${TEST_KEY_IDS.foundation}', '${hashFoundation}', '${IDS.projectAlpha}', 60),
      ('${TEST_KEY_IDS.compliance}', '${hashCompliance}', '${IDS.projectAlpha}', 120),
      ('${TEST_KEY_IDS.complianceBeta}', '${hashComplianceBeta}', '${IDS.projectBeta}', 120)
    ON CONFLICT (id) DO NOTHING;
  `);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedScheduleFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/exports/schedule — Create schedule
// =========================================================================

describe("POST /v1/exports/schedule — create", () => {
  it("creates a weekly ISO 42001 export schedule", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "iso42001",
        frequency: "weekly",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(201);
    expect(body.id).toBeDefined();
    expect(typeof body.id).toBe("string");
    expect(body.projectId).toBe(IDS.projectAlpha);
    expect(body.exportType).toBe("iso42001");
    expect(body.frequency).toBe("weekly");
    expect(body.createdAt).toBeDefined();
    expect(body.nextRunAt).toBeDefined();
  });

  it("creates a monthly SOC 2 export schedule", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "soc2",
        frequency: "monthly",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(201);
    expect(body.exportType).toBe("soc2");
    expect(body.frequency).toBe("monthly");
  });

  it("creates a supply-chain export schedule", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "supply-chain",
        frequency: "weekly",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(201);
    expect(body.exportType).toBe("supply-chain");
  });

  it("defaults deliveryMethod to 'api'", async () => {
    const { body } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "iso42001",
        frequency: "weekly",
      },
      TEST_KEYS.compliance
    );

    expect(body.deliveryMethod).toBe("api");
  });
});

// =========================================================================
// Input validation
// =========================================================================

describe("POST /v1/exports/schedule — validation", () => {
  it("rejects invalid frequency with 400", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "iso42001",
        frequency: "daily",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("rejects invalid exportType with 400", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "invalid-type",
        frequency: "weekly",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(400);
    expect(body.error).toBeDefined();
  });

  it("rejects missing projectId with 400", async () => {
    const { response } = await postJSON(
      "/v1/exports/schedule",
      {
        exportType: "iso42001",
        frequency: "weekly",
      },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(400);
  });
});

// =========================================================================
// GET /v1/exports/schedules — List schedules
// =========================================================================

describe("GET /v1/exports/schedules — list", () => {
  it("lists schedules for the authenticated project", async () => {
    // First create a schedule to ensure there's at least one
    await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "soc2",
        frequency: "weekly",
      },
      TEST_KEYS.compliance
    );

    const { body, response } = await getJSON(
      `/v1/exports/schedules?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);

    const schedules = body.schedules as Array<Record<string, unknown>>;
    expect(Array.isArray(schedules)).toBe(true);
    expect(schedules.length).toBeGreaterThanOrEqual(1);

    const s = schedules[0];
    expect(s).toHaveProperty("id");
    expect(s).toHaveProperty("exportType");
    expect(s).toHaveProperty("frequency");
    expect(s).toHaveProperty("nextRunAt");
  });

  it("does not return schedules from other projects", async () => {
    // Create a schedule for beta project
    await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectBeta,
        exportType: "iso42001",
        frequency: "monthly",
      },
      TEST_KEYS.complianceBeta
    );

    // List as alpha project — should not see beta schedules
    const { body } = await getJSON(
      `/v1/exports/schedules?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const schedules = body.schedules as Array<Record<string, unknown>>;
    for (const s of schedules) {
      expect(s.projectId).not.toBe(IDS.projectBeta);
    }
  });
});

// =========================================================================
// DELETE /v1/exports/schedules/:id — Remove schedule
// =========================================================================

describe("DELETE /v1/exports/schedules/:id — remove", () => {
  it("deletes a schedule and returns 200", async () => {
    // Create a schedule first
    const { body: created } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "iso42001",
        frequency: "weekly",
      },
      TEST_KEYS.compliance
    );

    const scheduleId = created.id as string;
    expect(scheduleId).toBeDefined();

    // Delete it
    const { response } = await deleteJSON(
      `/v1/exports/schedules/${scheduleId}`,
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);

    // Verify it no longer appears in the list
    const { body: listed } = await getJSON(
      `/v1/exports/schedules?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const schedules = listed.schedules as Array<Record<string, unknown>>;
    const found = schedules.find((s) => s.id === scheduleId);
    expect(found).toBeUndefined();
  });

  it("cannot delete another project's schedule", async () => {
    // Create schedule for beta
    const { body: created } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectBeta,
        exportType: "soc2",
        frequency: "monthly",
      },
      TEST_KEYS.complianceBeta
    );

    const scheduleId = created.id as string;

    // Try to delete as alpha — should fail
    const { response } = await deleteJSON(
      `/v1/exports/schedules/${scheduleId}`,
      TEST_KEYS.compliance
    );

    // Should be 403 or 404 (schedule doesn't belong to alpha's project)
    expect([403, 404]).toContain(response.status);
  });
});

// =========================================================================
// POST /v1/exports/schedules/evaluate — Trigger due exports
// =========================================================================

describe("POST /v1/exports/schedules/evaluate — trigger due exports", () => {
  it("returns evaluation results", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/schedules/evaluate",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    expect(response.status).toBe(200);
    expect(body).toHaveProperty("evaluated");
    expect(typeof body.evaluated).toBe("number");
  });

  it("updates last_run_at when a schedule is triggered", async () => {
    const p = getPool();

    // Create a schedule with next_run_at in the past to make it "due"
    const { body: created } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "iso42001",
        frequency: "weekly",
      },
      TEST_KEYS.compliance
    );

    const scheduleId = created.id as string;

    // Force next_run_at to the past so evaluate picks it up
    await p.query(`
      UPDATE export_schedules SET next_run_at = NOW() - INTERVAL '1 day'
      WHERE id = $1
    `, [scheduleId]);

    // Evaluate
    await postJSON(
      "/v1/exports/schedules/evaluate",
      { projectId: IDS.projectAlpha },
      TEST_KEYS.compliance
    );

    // Check that last_run_at was updated
    const result = await p.query(`SELECT last_run_at, next_run_at FROM export_schedules WHERE id = $1`, [scheduleId]);
    if (result.rows.length > 0) {
      expect(result.rows[0].last_run_at).not.toBeNull();
    }
  });
});

// =========================================================================
// Authentication & Authorization
// =========================================================================

describe("Export schedules — auth & gating", () => {
  it("POST /v1/exports/schedule returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "iso42001",
        frequency: "weekly",
      }
    );

    expect(response.status).toBe(401);
  });

  it("GET /v1/exports/schedules returns 401 without API key", async () => {
    const { response } = await getJSON(
      `/v1/exports/schedules?projectId=${IDS.projectAlpha}`
    );

    expect(response.status).toBe(401);
  });

});

// =========================================================================
// Audit logging
// =========================================================================

describe("Export schedules — audit logging", () => {
  it("POST /v1/exports/schedule creates audit log entry", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/exports/schedule",
      {
        projectId: IDS.projectAlpha,
        exportType: "soc2",
        frequency: "monthly",
      },
      TEST_KEYS.compliance
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  it("GET /v1/exports/schedules creates audit log entry", async () => {
    const countBefore = await countAuditLogs();

    await getJSON(
      `/v1/exports/schedules?projectId=${IDS.projectAlpha}`,
      TEST_KEYS.compliance
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
