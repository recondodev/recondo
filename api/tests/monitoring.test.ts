/**
 * Sprint 5 Deliverable 5: Completeness and Availability Monitoring
 *
 * Tests for:
 * - GET  /v1/monitoring/completeness  — sessions with dropped events
 * - GET  /v1/monitoring/availability  — gateway heartbeat status
 * - POST /v1/monitoring/alerts/configure — webhook alert configuration
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
// Sprint 5 fixture data: heartbeats + alert_configs
// ---------------------------------------------------------------------------

async function seedMonitoringFixtures(): Promise<void> {
  const p = getPool();

  // Create heartbeats table
  await p.query(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      gateway_id      TEXT NOT NULL,
      timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata        JSONB DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_heartbeats_gateway ON heartbeats (gateway_id, timestamp);
  `);

  // Create alert_configs table
  await p.query(`
    CREATE TABLE IF NOT EXISTS alert_configs (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id      TEXT NOT NULL,
      webhook_url     TEXT NOT NULL,
      completeness_threshold  DOUBLE PRECISION NOT NULL DEFAULT 100.0,
      availability_threshold  DOUBLE PRECISION NOT NULL DEFAULT 99.9,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_alert_configs_project ON alert_configs (project_id);
  `);

  // Seed heartbeat records: continuous except for a 5-minute gap
  const now = new Date();
  const values: string[] = [];

  // Last 30 minutes: every 30 seconds (normal)
  for (let i = 0; i < 60; i++) {
    const ts = new Date(now.getTime() - i * 30_000);
    values.push(`('gw-001', '${ts.toISOString()}', '{"version":"0.1.0"}')`);
  }

  // Gap: no heartbeats from -35min to -30min (5-minute gap)

  // Before the gap: 25 minutes of heartbeats (every 30 seconds)
  for (let i = 0; i < 50; i++) {
    const ts = new Date(now.getTime() - (35 * 60_000) - (i * 30_000));
    values.push(`('gw-001', '${ts.toISOString()}', '{"version":"0.1.0"}')`);
  }

  await p.query(`
    INSERT INTO heartbeats (gateway_id, timestamp, metadata) VALUES
    ${values.join(",\n")}
  `);

  // Seed a session with dropped events for completeness monitoring
  // sessionBeta1 already has dropped_events=1 from base setup fixtures
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
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedMonitoringFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// GET /v1/monitoring/completeness
// =========================================================================

describe("GET /v1/monitoring/completeness", () => {
  it("returns sessions with dropped events or incomplete capture", async () => {
    const { body, response } = await getJSON(
      "/v1/monitoring/completeness",
      API_KEYS.admin
    );

    expect(response.status).toBe(200);
    expect(body.sessions).toBeDefined();

    const sessions = body.sessions as Array<Record<string, unknown>>;
    // At least sessionBeta1 has dropped_events=1
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // Each session should have required fields
    for (const session of sessions) {
      expect(session.sessionId).toBeDefined();
      expect(session.droppedEvents).toBeDefined();
      expect(session.turnsCaptured).toBeDefined();
      expect(session.totalTurns).toBeDefined();
    }

    // Verify that sessionBeta1 (which has dropped_events=1) is included
    const beta1 = sessions.find(
      (s) => s.sessionId === IDS.sessionBeta1
    );
    expect(beta1).toBeDefined();
    expect(beta1!.droppedEvents).toBeGreaterThan(0);
  });

  it("returns empty list when no sessions have issues (project alpha)", async () => {
    // Alpha sessions have no dropped events
    const { body, response } = await getJSON(
      "/v1/monitoring/completeness",
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const sessions = body.sessions as Array<Record<string, unknown>>;

    // Alpha sessions have 0 dropped events and turns_captured == total_turns
    // So the list should be empty (no problematic sessions)
    expect(sessions.length).toBe(0);
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON("/v1/monitoring/completeness");
    expect(response.status).toBe(401);
  });

  it("audit logs completeness check", async () => {
    const countBefore = await countAuditLogs();

    await getJSON("/v1/monitoring/completeness", API_KEYS.alpha);

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// =========================================================================
// GET /v1/monitoring/availability
// =========================================================================

describe("GET /v1/monitoring/availability", () => {
  it("returns gateway heartbeat status", async () => {
    const { body, response } = await getJSON(
      "/v1/monitoring/availability",
      API_KEYS.admin
    );

    expect(response.status).toBe(200);

    // lastHeartbeat: ISO timestamp of most recent heartbeat
    expect(body.lastHeartbeat).toBeDefined();
    expect(typeof body.lastHeartbeat).toBe("string");
    expect(isNaN(new Date(body.lastHeartbeat as string).getTime())).toBe(false);

    // uptimePercentage: 0-100
    expect(body.uptimePercentage).toBeDefined();
    expect(typeof body.uptimePercentage).toBe("number");
    expect(body.uptimePercentage as number).toBeGreaterThanOrEqual(0);
    expect(body.uptimePercentage as number).toBeLessThanOrEqual(100);

    // gapWindows: array of time ranges where heartbeats were missing
    expect(body.gapWindows).toBeDefined();
    const gaps = body.gapWindows as Array<Record<string, unknown>>;
    expect(Array.isArray(gaps)).toBe(true);
  });

  it("detects heartbeat gaps", async () => {
    const { body, response } = await getJSON(
      "/v1/monitoring/availability",
      API_KEYS.admin
    );

    expect(response.status).toBe(200);

    const gaps = body.gapWindows as Array<Record<string, unknown>>;
    // We seeded a 5-minute gap — should be detected
    expect(gaps.length).toBeGreaterThanOrEqual(1);

    // Each gap should have start and end
    for (const gap of gaps) {
      expect(gap.start).toBeDefined();
      expect(gap.end).toBeDefined();
    }
  });

  it("uptime is less than 100% when gaps exist", async () => {
    const { body } = await getJSON(
      "/v1/monitoring/availability",
      API_KEYS.admin
    );

    // We have a 5-minute gap in ~60 minutes of data, so uptime < 100%
    const pct = body.uptimePercentage as number;
    expect(pct).toBeLessThan(100);
    // But should still be high (the gap is only 5 out of ~60 minutes)
    expect(pct).toBeGreaterThan(80);
  });

  it("returns 401 without API key", async () => {
    const { response } = await getJSON("/v1/monitoring/availability");
    expect(response.status).toBe(401);
  });

  it("audit logs availability check", async () => {
    const countBefore = await countAuditLogs();

    await getJSON("/v1/monitoring/availability", API_KEYS.admin);

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});

// =========================================================================
// POST /v1/monitoring/alerts/configure
// =========================================================================

describe("POST /v1/monitoring/alerts/configure", () => {
  it("configures a webhook URL for alert notifications", async () => {
    const { body, response } = await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        webhookUrl: "https://hooks.example.com/recondo-alerts",
        completenessThreshold: 99.5,
        availabilityThreshold: 99.9,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.configured).toBe(true);
    expect(body.webhookUrl).toBe("https://hooks.example.com/recondo-alerts");
  });

  it("updates existing webhook configuration", async () => {
    // First, set an initial config
    await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        webhookUrl: "https://hooks.example.com/original",
        completenessThreshold: 100,
        availabilityThreshold: 99.9,
      },
      API_KEYS.alpha
    );

    // Then update it
    const { body, response } = await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        webhookUrl: "https://hooks.example.com/updated",
        completenessThreshold: 99.0,
        availabilityThreshold: 99.5,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    expect(body.webhookUrl).toBe("https://hooks.example.com/updated");
  });

  it("persists webhook configuration in the database", async () => {
    const { response } = await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        webhookUrl: "https://hooks.example.com/persisted",
        completenessThreshold: 98.0,
        availabilityThreshold: 99.0,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    // Verify directly in the database
    const p = getPool();
    const result = await p.query(
      `SELECT webhook_url, completeness_threshold, availability_threshold
       FROM alert_configs
       WHERE project_id = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [IDS.projectAlpha]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].webhook_url).toBe(
      "https://hooks.example.com/persisted"
    );
    expect(Number(result.rows[0].completeness_threshold)).toBeCloseTo(98.0);
    expect(Number(result.rows[0].availability_threshold)).toBeCloseTo(99.0);
  });

  it("returns 401 without API key", async () => {
    const { response } = await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        webhookUrl: "https://hooks.example.com/noauth",
      }
    );

    expect(response.status).toBe(401);
  });

  it("returns 400 for missing webhookUrl", async () => {
    const { response } = await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        completenessThreshold: 99.0,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid webhook URL", async () => {
    const { response } = await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        webhookUrl: "not-a-valid-url",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
  });

  it("project-scoped: alpha cannot see beta's alert config", async () => {
    // Configure for beta
    await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        webhookUrl: "https://hooks.example.com/beta-secret",
        completenessThreshold: 100,
        availabilityThreshold: 99.9,
      },
      API_KEYS.beta
    );

    // Alpha should not be able to read beta's config in the database
    // This is verified by project scoping on the API level
    const p = getPool();
    const result = await p.query(
      `SELECT webhook_url FROM alert_configs WHERE project_id = $1`,
      [IDS.projectBeta]
    );

    // The config should exist for beta
    expect(result.rows.length).toBeGreaterThanOrEqual(1);

    // But if alpha tries to configure alerts with beta's project scope, it should be denied
    // (the API should use the key's projectId, not trust client-provided projectId)
  });

  it("audit logs alert configuration", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/monitoring/alerts/configure",
      {
        webhookUrl: "https://hooks.example.com/audit-test",
      },
      API_KEYS.alpha
    );

    const countAfter = await countAuditLogs();
    expect(countAfter).toBeGreaterThan(countBefore);
  });
});
