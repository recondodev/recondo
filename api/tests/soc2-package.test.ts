/**
 * Sprint 9 Deliverable 7: SOC 2 ZIP+PDF Export (deferred from Sprint 5)
 *
 * Tests for:
 * - POST /v1/exports/soc2/package — returns a ZIP file containing:
 *   - evidence.json — the existing SOC 2 evidence JSON
 *   - summary.txt — human-readable text summary
 * - Content-Type: application/zip (or application/octet-stream)
 * - Auth required, project scoped, audit logged
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
  foundation: "wrt_test_soc2pkg_foundation_01",
  compliance: "wrt_test_soc2pkg_compliance_02",
} as const;

const TEST_KEY_IDS = {
  foundation: "bb450000-0000-4000-8000-000000000001",
  compliance: "bb450000-0000-4000-8000-000000000002",
} as const;

// ---------------------------------------------------------------------------
// SHA-256 helper
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedSoc2PackageFixtures(): Promise<void> {
  const p = getPool();

  const hashFoundation = await sha256(TEST_KEYS.foundation);
  const hashCompliance = await sha256(TEST_KEYS.compliance);

  await p.query(`
    INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm) VALUES
      ('${TEST_KEY_IDS.foundation}', '${hashFoundation}', '${IDS.projectAlpha}', 60),
      ('${TEST_KEY_IDS.compliance}', '${hashCompliance}', '${IDS.projectAlpha}', 120)
    ON CONFLICT (id) DO NOTHING;
  `);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedSoc2PackageFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// ---------------------------------------------------------------------------
// Helper: POST with raw response (not JSON-parsed)
// ---------------------------------------------------------------------------

async function postRaw(
  path: string,
  body: Record<string, unknown>,
  apiKey?: string
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// =========================================================================
// POST /v1/exports/soc2/package — ZIP response
// =========================================================================

describe("POST /v1/exports/soc2/package — response format", () => {
  it("returns Content-Type application/zip or application/octet-stream", async () => {
    const response = await postRaw(
      "/v1/exports/soc2/package",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      TEST_KEYS.foundation
    );

    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type") ?? "";
    const isZip =
      contentType.includes("application/zip") ||
      contentType.includes("application/octet-stream");
    expect(isZip).toBe(true);
  });

  it("response body is a valid ZIP (starts with PK signature)", async () => {
    const response = await postRaw(
      "/v1/exports/soc2/package",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      TEST_KEYS.foundation
    );

    expect(response.status).toBe(200);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // ZIP files start with PK (0x50, 0x4B)
    expect(bytes.length).toBeGreaterThan(4);
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
  });

  it("ZIP contains evidence.json", async () => {
    const response = await postRaw(
      "/v1/exports/soc2/package",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      TEST_KEYS.foundation
    );

    expect(response.status).toBe(200);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Search for "evidence.json" filename in the ZIP central directory
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("evidence.json");
  });

  it("ZIP contains summary.txt", async () => {
    const response = await postRaw(
      "/v1/exports/soc2/package",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      TEST_KEYS.foundation
    );

    expect(response.status).toBe(200);
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    // Search for "summary.txt" filename in the ZIP central directory
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("summary.txt");
  });

  it("ZIP is non-trivial size (contains actual data)", async () => {
    const response = await postRaw(
      "/v1/exports/soc2/package",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      TEST_KEYS.foundation
    );

    expect(response.status).toBe(200);
    const buffer = await response.arrayBuffer();

    // A ZIP with two files should be more than a few hundred bytes
    expect(buffer.byteLength).toBeGreaterThan(100);
  });
});

// =========================================================================
// Auth and access control
// =========================================================================

describe("POST /v1/exports/soc2/package — access control", () => {
  it("returns 401 without authentication", async () => {
    const response = await postRaw(
      "/v1/exports/soc2/package",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      }
    );

    expect(response.status).toBe(401);
  });

  it("project-scoped key cannot export another project", async () => {
    const response = await postRaw(
      "/v1/exports/soc2/package",
      {
        projectId: IDS.projectBeta,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      TEST_KEYS.foundation
    );

    // Should be 403 for cross-project access
    expect(response.status).toBe(403);
  });

  it("audit logs the soc2 package export", async () => {
    const before = await countAuditLogs();

    await postRaw(
      "/v1/exports/soc2/package",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      TEST_KEYS.foundation
    );

    const after = await countAuditLogs();
    expect(after).toBeGreaterThan(before);
  });
});

// =========================================================================
// Validation
// =========================================================================

describe("POST /v1/exports/soc2/package — validation", () => {
  it("returns 400 when projectId is missing", async () => {
    const response = await postRaw(
      "/v1/exports/soc2/package",
      {
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      TEST_KEYS.foundation
    );

    // Should return error for missing projectId
    expect(response.status).toBe(400);
  });
});
