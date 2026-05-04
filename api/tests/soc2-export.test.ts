/**
 * Sprint 5 Deliverable 4: SOC 2 Evidence Package Export
 *
 * Tests for POST /v1/exports/soc2 endpoint.
 *
 * This endpoint generates a JSON evidence package containing:
 * - completeness: sessions with turns_captured, total_turns, dropped_events, %
 * - integrity: per-session hash verification summary
 * - accessLog: summary of access_audit_log entries
 * - availability: gateway heartbeat/uptime record
 * - processingIntegrity: hash verification statistics
 * - metadata: report generation info
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
// Sprint 5 fixture data: heartbeats table
// ---------------------------------------------------------------------------

async function seedSoc2Fixtures(): Promise<void> {
  const p = getPool();

  // Create heartbeats table (Sprint 5 addition)
  await p.query(`
    CREATE TABLE IF NOT EXISTS heartbeats (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      gateway_id      TEXT NOT NULL,
      timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata        JSONB DEFAULT '{}'::jsonb
    );

    CREATE INDEX IF NOT EXISTS idx_heartbeats_gateway ON heartbeats (gateway_id, timestamp);
  `);

  // Seed heartbeat records — one every 30 seconds for the past hour
  const now = new Date();
  const values: string[] = [];
  for (let i = 0; i < 120; i++) {
    const ts = new Date(now.getTime() - i * 30_000);
    values.push(`('gw-001', '${ts.toISOString()}', '{"version":"0.1.0"}')`);
  }

  await p.query(`
    INSERT INTO heartbeats (gateway_id, timestamp, metadata) VALUES
    ${values.join(",\n")}
    ON CONFLICT DO NOTHING;
  `);

  // Seed some access_audit_log entries (additional to any from setup)
  await p.query(`
    INSERT INTO access_audit_log (api_key_id, query_type, source_ip, user_agent, response_status)
    VALUES
      ('${IDS.keyAlpha}', 'sessions', '10.0.0.1', 'test-agent/1.0', 200),
      ('${IDS.keyAlpha}', 'session', '10.0.0.1', 'test-agent/1.0', 200),
      ('${IDS.keyAlpha}', 'verifyIntegrity', '10.0.0.1', 'test-agent/1.0', 200),
      ('${IDS.keyBeta}', 'sessions', '10.0.0.2', 'test-agent/2.0', 200),
      ('${IDS.keyBeta}', 'search', '10.0.0.2', 'test-agent/2.0', 200);
  `);
}

// ---------------------------------------------------------------------------
// Helper: POST to REST endpoints
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
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedSoc2Fixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// POST /v1/exports/soc2
// =========================================================================

describe("POST /v1/exports/soc2", () => {
  it("generates SOC 2 evidence package with all required sections", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    // ---- completeness section ----
    expect(body.completeness).toBeDefined();
    const completeness = body.completeness as Record<string, unknown>;
    const sessions = completeness.sessions as Array<Record<string, unknown>>;
    expect(sessions).toBeDefined();
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // Each session has turns_captured, total_turns, dropped_events, completeness %
    const firstSession = sessions[0];
    expect(firstSession.turnsCaptured).toBeDefined();
    expect(firstSession.totalTurns).toBeDefined();
    expect(firstSession.droppedEvents).toBeDefined();
    expect(firstSession.completenessPercentage).toBeDefined();
    expect(typeof firstSession.completenessPercentage).toBe("number");

    // ---- integrity section ----
    expect(body.integrity).toBeDefined();
    const integrity = body.integrity as Record<string, unknown>;
    expect(integrity.verifiedCount).toBeDefined();
    expect(integrity.failedCount).toBeDefined();
    expect(typeof integrity.verifiedCount).toBe("number");
    expect(typeof integrity.failedCount).toBe("number");

    // ---- accessLog section ----
    expect(body.accessLog).toBeDefined();
    const accessLog = body.accessLog as Record<string, unknown>;
    expect(accessLog.totalQueries).toBeDefined();
    expect(typeof accessLog.totalQueries).toBe("number");
    expect(accessLog.uniqueUsers).toBeDefined();
    expect(typeof accessLog.uniqueUsers).toBe("number");
    expect(accessLog.queryTypeBreakdown).toBeDefined();

    // ---- availability section ----
    expect(body.availability).toBeDefined();
    const availability = body.availability as Record<string, unknown>;
    expect(availability.heartbeatCount).toBeDefined();
    expect(typeof availability.heartbeatCount).toBe("number");
    expect(availability.gapCount).toBeDefined();
    expect(typeof availability.gapCount).toBe("number");
    expect(availability.availabilityPercentage).toBeDefined();
    expect(typeof availability.availabilityPercentage).toBe("number");

    // ---- processingIntegrity section ----
    expect(body.processingIntegrity).toBeDefined();
    const pi = body.processingIntegrity as Record<string, unknown>;
    expect(pi.statement).toBeDefined();
    expect(typeof pi.statement).toBe("string");

    // ---- metadata section ----
    expect(body.metadata).toBeDefined();
    const metadata = body.metadata as Record<string, unknown>;
    expect(metadata.generatedAt).toBeDefined();
    expect(metadata.startDate).toBe("2020-01-01");
    expect(metadata.endDate).toBe("2030-12-31");
    expect(metadata.projectId).toBe(IDS.projectAlpha);
    expect(metadata.generatorVersion).toBeDefined();
  });

  it("completeness shows 100% for sessions with no dropped events", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);

    const completeness = body.completeness as Record<string, unknown>;
    const sessions = completeness.sessions as Array<Record<string, unknown>>;

    // sessionAlpha1 has 3 turns captured, 3 total, 0 dropped
    const alpha1 = sessions.find(
      (s) => s.sessionId === IDS.sessionAlpha1
    );
    if (alpha1) {
      expect(alpha1.completenessPercentage).toBe(100);
    }
  });

  it("availability percentage is between 0 and 100", async () => {
    const { body } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      API_KEYS.alpha
    );

    const availability = body.availability as Record<string, unknown>;
    const pct = availability.availabilityPercentage as number;
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  });

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  it("returns 401 without API key", async () => {
    const { response } = await postJSON("/v1/exports/soc2", {
      projectId: IDS.projectAlpha,
      startDate: "2020-01-01",
      endDate: "2030-12-31",
    });

    expect(response.status).toBe(401);
  });

  it("returns 401 with invalid API key", async () => {
    const { response } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      API_KEYS.invalid
    );

    expect(response.status).toBe(401);
  });

  // -----------------------------------------------------------------------
  // Project scoping
  // -----------------------------------------------------------------------

  it("enforces project scoping: beta key only sees beta data", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectBeta,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      API_KEYS.beta
    );

    expect(response.status).toBe(200);

    const completeness = body.completeness as Record<string, unknown>;
    const sessions = completeness.sessions as Array<Record<string, unknown>>;

    // Beta key should only see beta sessions
    for (const session of sessions) {
      expect(session.sessionId).not.toBe(IDS.sessionAlpha1);
      expect(session.sessionId).not.toBe(IDS.sessionAlpha2);
    }
  });

  it("beta key cannot access alpha project SOC 2 report", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      API_KEYS.beta
    );

    // Either 403, or 200 with empty/scoped-to-beta data
    if (response.status === 200) {
      const completeness = body.completeness as Record<string, unknown>;
      const sessions = completeness.sessions as Array<Record<string, unknown>>;
      // Should not contain alpha sessions
      const hasAlpha = sessions.some(
        (s) =>
          s.sessionId === IDS.sessionAlpha1 ||
          s.sessionId === IDS.sessionAlpha2
      );
      expect(hasAlpha).toBe(false);
    } else {
      expect(response.status).toBe(403);
    }
  });

  // -----------------------------------------------------------------------
  // Audit logging
  // -----------------------------------------------------------------------

  it("logs SOC 2 export request in audit log", async () => {
    const countBefore = await countAuditLogs();

    await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      API_KEYS.alpha
    );

    const countAfter = await countAuditLogs();
    // SOC 2 export must produce an audit log entry
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  // -----------------------------------------------------------------------
  // Negative cases
  // -----------------------------------------------------------------------

  it("rejects invalid date range (start after end)", async () => {
    const { response } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
        startDate: "2030-01-01",
        endDate: "2020-01-01",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
  });

  it("rejects missing projectId", async () => {
    const { response } = await postJSON(
      "/v1/exports/soc2",
      {
        startDate: "2020-01-01",
        endDate: "2030-12-31",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
  });

  it("rejects missing date fields", async () => {
    const { response } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(400);
  });

  it("returns empty report for date range with no activity", async () => {
    const { body, response } = await postJSON(
      "/v1/exports/soc2",
      {
        projectId: IDS.projectAlpha,
        startDate: "2000-01-01",
        endDate: "2000-01-02",
      },
      API_KEYS.alpha
    );

    expect(response.status).toBe(200);
    const completeness = body.completeness as Record<string, unknown>;
    const sessions = completeness.sessions as Array<Record<string, unknown>>;
    expect(sessions.length).toBe(0);
  });
});
