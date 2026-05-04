/**
 * Sprint 7 Deliverable: AnomalyEvent FLAGGED_BY Edges
 *
 * Tests for bidirectional relationships between Turns and AnomalyEvents:
 * - Turn.anomalies resolver (Turn -> [AnomalyEvent])
 * - AnomalyEvent.turn resolver (AnomalyEvent -> Turn)
 * - AnomalyEvent.session resolver (AnomalyEvent -> Session)
 * - Anomaly query filter improvements (by type, severity, date range)
 *
 * These tests WILL FAIL until the implementation agent builds the resolvers.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  graphql,
  IDS,
  API_KEYS,
  API_BASE_URL,
} from "./setup.js";

// ---------------------------------------------------------------------------
// Extended fixture data for FLAGGED_BY edge tests
// ---------------------------------------------------------------------------

const FLAGGED_IDS = {
  // Anomaly linked to turnA1_1 (alpha project, session alpha1)
  anomalyOnTurnA1_1: "ff100000-0000-4000-8000-000000000001",
  // Second anomaly on the same turn (turnA1_1) — tests multiple anomalies
  anomalyOnTurnA1_1b: "ff100000-0000-4000-8000-000000000002",
  // Anomaly on turnA1_2 (alpha project, session alpha1)
  anomalyOnTurnA1_2: "ff100000-0000-4000-8000-000000000003",
  // Anomaly on beta session turn (for cross-project scoping test)
  anomalyOnTurnB1_1: "ff100000-0000-4000-8000-000000000004",
} as const;

async function seedFlaggedByFixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3600_000);
  const twoHoursAgo = new Date(now.getTime() - 7200_000);
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400_000);

  await p.query(`
    INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity,
                                description, metadata, detected_at) VALUES
      ('${FLAGGED_IDS.anomalyOnTurnA1_1}', '${IDS.sessionAlpha1}', '${IDS.turnA1_1}',
       'system_prompt_drift', 'warning',
       'System prompt changed between turns 1 and 2',
       '{"old_hash": "abc123", "new_hash": "def456"}'::jsonb,
       '${twoHoursAgo.toISOString()}'),
      ('${FLAGGED_IDS.anomalyOnTurnA1_1b}', '${IDS.sessionAlpha1}', '${IDS.turnA1_1}',
       'latency_spike', 'info',
       'Turn latency exceeded 5s threshold',
       '{"latency_ms": 6200}'::jsonb,
       '${hourAgo.toISOString()}'),
      ('${FLAGGED_IDS.anomalyOnTurnA1_2}', '${IDS.sessionAlpha1}', '${IDS.turnA1_2}',
       'tool_definition_drift', 'critical',
       'Tool definitions changed mid-session',
       '{"tool_name": "Edit", "change": "schema_modified"}'::jsonb,
       '${twoHoursAgo.toISOString()}'),
      ('${FLAGGED_IDS.anomalyOnTurnB1_1}', '${IDS.sessionBeta1}', '${IDS.turnB1_1}',
       'system_prompt_drift', 'warning',
       'System prompt drift in beta session',
       '{}'::jsonb,
       '${threeDaysAgo.toISOString()}')
    ON CONFLICT (id) DO NOTHING;
  `);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await setupDatabase();
  await seedFlaggedByFixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// Turn.anomalies resolver — Turn -> [AnomalyEvent]
// =========================================================================

describe("Turn.anomalies resolver", () => {
  it("returns anomaly events linked to a turn", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) {
            id
            anomalies {
              id
              anomalyType
              severity
              description
              detectedAt
            }
          }
        }
      `,
      variables: { id: IDS.turnA1_1 },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const turn = body.data!.turn as Record<string, unknown>;
    expect(turn).not.toBeNull();
    expect(turn.id).toBe(IDS.turnA1_1);

    const anomalies = turn.anomalies as Array<Record<string, unknown>>;
    expect(anomalies).toBeDefined();
    // turnA1_1 has 2 anomalies from our fixtures PLUS anomaly2 from base setup
    // (anomaly2 is on turnA1_3, not turnA1_1 — so just 2 from our fixtures)
    expect(anomalies).toHaveLength(2);

    const ids = anomalies.map((a) => a.id);
    expect(ids).toContain(FLAGGED_IDS.anomalyOnTurnA1_1);
    expect(ids).toContain(FLAGGED_IDS.anomalyOnTurnA1_1b);

    // Verify field mapping
    const driftAnomaly = anomalies.find(
      (a) => a.id === FLAGGED_IDS.anomalyOnTurnA1_1
    )!;
    expect(driftAnomaly.anomalyType).toBe("system_prompt_drift");
    expect(driftAnomaly.severity).toBe("warning");
    expect(driftAnomaly.description).toBe(
      "System prompt changed between turns 1 and 2"
    );
    expect(driftAnomaly.detectedAt).toBeDefined();
  });

  it("returns empty array for turn with no anomaly events", async () => {
    // turnA2_1 has no anomalies linked to it
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) {
            id
            anomalies {
              id
            }
          }
        }
      `,
      variables: { id: IDS.turnA2_1 },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const turn = body.data!.turn as Record<string, unknown>;
    expect(turn).not.toBeNull();
    expect(turn.anomalies).toEqual([]);
  });

  it("returns multiple anomalies on one turn all returned", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) {
            id
            anomalies {
              id
              anomalyType
            }
          }
        }
      `,
      variables: { id: IDS.turnA1_1 },
    });

    const turn = body.data!.turn as Record<string, unknown>;
    const anomalies = turn.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBe(2);

    const types = anomalies.map((a) => a.anomalyType);
    expect(types).toContain("system_prompt_drift");
    expect(types).toContain("latency_spike");
  });

  it("rejects Turn.anomalies query without auth (401)", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($id: ID!) { turn(id: $id) { id anomalies { id } } }`,
        variables: { id: IDS.turnA1_1 },
      }),
    });

    expect(response.status).toBe(401);
  });

  it("project-scoped key cannot see other project's anomalies via Turn", async () => {
    // Alpha key tries to access a turn in beta project — should return null turn
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) {
            id
            anomalies {
              id
            }
          }
        }
      `,
      variables: { id: IDS.turnB1_1 },
    });

    // Turn itself should be null (project scoping), so anomalies are not accessible
    expect(body.data!.turn).toBeNull();
  });
});

// =========================================================================
// AnomalyEvent.turn resolver — AnomalyEvent -> Turn
// =========================================================================

describe("AnomalyEvent.turn resolver", () => {
  it("anomaly event includes turn data when queried", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) {
            id
            turnId
            turn {
              id
              sequenceNum
              inputTokens
              outputTokens
              model
            }
          }
        }
      `,
      variables: { filter: { anomalyType: "system_prompt_drift" } },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    // Alpha key should see only its own project's anomalies
    expect(anomalies.length).toBeGreaterThanOrEqual(1);

    const driftAnomaly = anomalies.find(
      (a) => a.id === FLAGGED_IDS.anomalyOnTurnA1_1
    );
    expect(driftAnomaly).toBeDefined();

    const turn = driftAnomaly!.turn as Record<string, unknown>;
    expect(turn).not.toBeNull();
    expect(turn.id).toBe(IDS.turnA1_1);
    expect(turn.sequenceNum).toBe(1);
    expect(turn.inputTokens).toBe(1000);
    expect(turn.outputTokens).toBe(500);
    expect(turn.model).toBe("claude-sonnet-4-20250514");
  });

  it("anomaly event with null turn_id returns null turn", async () => {
    // anomaly1 from base fixtures has turn_id = NULL
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) {
            id
            turnId
            turn {
              id
            }
          }
        }
      `,
      variables: { filter: { anomalyType: "dropped_event" } },
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    const droppedAnomaly = anomalies.find((a) => a.id === IDS.anomaly1);
    expect(droppedAnomaly).toBeDefined();
    expect(droppedAnomaly!.turnId).toBeNull();
    expect(droppedAnomaly!.turn).toBeNull();
  });
});

// =========================================================================
// AnomalyEvent.session resolver — AnomalyEvent -> Session
// =========================================================================

describe("AnomalyEvent.session resolver", () => {
  it("anomaly event includes session data when queried", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) {
            id
            sessionId
            session {
              id
              provider
              model
              initialIntent
              totalTurns
            }
          }
        }
      `,
      variables: { filter: { sessionId: IDS.sessionAlpha1 } },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);

    // Pick any anomaly linked to sessionAlpha1
    const anomaly = anomalies[0];
    expect(anomaly.sessionId).toBe(IDS.sessionAlpha1);

    const session = anomaly.session as Record<string, unknown>;
    expect(session).not.toBeNull();
    expect(session.id).toBe(IDS.sessionAlpha1);
    expect(session.provider).toBe("anthropic");
    expect(session.model).toBe("claude-sonnet-4-20250514");
    expect(session.initialIntent).toBe("Refactor authentication module");
    expect(session.totalTurns).toBe(3);
  });

  it("anomaly event with null session_id returns null session", async () => {
    // Insert a session-less anomaly for this test
    const p = getPool();
    const orphanId = "ff200000-0000-4000-8000-000000000001";
    await p.query(`
      INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity, description)
      VALUES ('${orphanId}', NULL, NULL, 'orphan_test', 'info', 'No session')
      ON CONFLICT (id) DO NOTHING;
    `);

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) {
            id
            sessionId
            session {
              id
            }
          }
        }
      `,
      variables: { filter: { anomalyType: "orphan_test" } },
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    const orphan = anomalies.find((a) => a.id === orphanId);
    expect(orphan).toBeDefined();
    expect(orphan!.sessionId).toBeNull();
    expect(orphan!.session).toBeNull();
  });
});

// =========================================================================
// Nested Turn -> anomalies within session query (depth = 3)
// =========================================================================

describe("session -> turns -> anomalies nested query", () => {
  it("session query with nested turns and anomalies returns FLAGGED_BY data", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          session(id: $id) {
            id
            turns {
              id
              sequenceNum
              anomalies {
                id
                anomalyType
                severity
              }
            }
          }
        }
      `,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const session = body.data!.session as Record<string, unknown>;
    expect(session).not.toBeNull();

    const turns = session.turns as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(3);

    // Turn 1 (turnA1_1) should have 2 anomalies
    const turn1 = turns.find((t) => t.sequenceNum === 1)!;
    const turn1Anomalies = turn1.anomalies as Array<Record<string, unknown>>;
    expect(turn1Anomalies).toHaveLength(2);

    // Turn 2 (turnA1_2) should have 1 anomaly
    const turn2 = turns.find((t) => t.sequenceNum === 2)!;
    const turn2Anomalies = turn2.anomalies as Array<Record<string, unknown>>;
    expect(turn2Anomalies).toHaveLength(1);
    expect(turn2Anomalies[0].anomalyType).toBe("tool_definition_drift");

    // Turn 3 (turnA1_3) has the base-fixture anomaly2 (hash_mismatch)
    const turn3 = turns.find((t) => t.sequenceNum === 3)!;
    const turn3Anomalies = turn3.anomalies as Array<Record<string, unknown>>;
    expect(turn3Anomalies).toHaveLength(1);
    expect(turn3Anomalies[0].id).toBe(IDS.anomaly2);
    expect(turn3Anomalies[0].anomalyType).toBe("hash_mismatch");
  });
});

// =========================================================================
// Anomaly query filter improvements
// =========================================================================

describe("anomaly query filter improvements", () => {
  it("filters anomalies by anomaly_type", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) {
            id
            anomalyType
          }
        }
      `,
      variables: { filter: { anomalyType: "system_prompt_drift" } },
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(2);
    for (const a of anomalies) {
      expect(a.anomalyType).toBe("system_prompt_drift");
    }
  });

  it("filters anomalies by severity", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) {
            id
            severity
          }
        }
      `,
      variables: { filter: { severity: "critical" } },
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    for (const a of anomalies) {
      expect(a.severity).toBe("critical");
    }
    // Should include anomaly2 (hash_mismatch, critical) and anomalyOnTurnA1_2 (tool_definition_drift, critical)
    const ids = anomalies.map((a) => a.id);
    expect(ids).toContain(IDS.anomaly2);
    expect(ids).toContain(FLAGGED_IDS.anomalyOnTurnA1_2);
  });

  it("filters anomalies by date range (since parameter)", async () => {
    // Only anomalies created in the last 2 hours
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) {
            id
            detectedAt
          }
        }
      `,
      variables: { filter: { since: twoHoursAgo } },
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    // All returned anomalies should be recent (within last 2 hours)
    for (const a of anomalies) {
      const detectedAt = new Date(a.detectedAt as string);
      expect(detectedAt.getTime()).toBeGreaterThanOrEqual(
        new Date(twoHoursAgo).getTime()
      );
    }
    // Should NOT include the 3-day-old beta anomaly
    const ids = anomalies.map((a) => a.id);
    expect(ids).not.toContain(FLAGGED_IDS.anomalyOnTurnB1_1);
  });
});
