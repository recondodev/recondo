/**
 * GraphQL query tests for Sprint 4 API.
 *
 * Covers:
 * - sessions list with filtering, pagination
 * - single session lookup (with nested turns)
 * - single turn lookup (with tool calls)
 * - search query
 * - integrity verification
 * - anomalies query
 * - negative cases: nonexistent IDs, empty results
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
  IDS,
  API_KEYS,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// sessions query
// =========================================================================

describe("sessions query", () => {
  it("returns all sessions for the authenticated project", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          sessions {
            items {
              id
              projectId
              provider
              model
              agentId
              startedAt
              initialIntent
              systemPromptHash
              totalTurns
              turnsCaptured
              droppedEvents
              totalTokens
              totalCostUsd
              complete
            }
          }
        }
      `,
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;

    // Alpha key should see only alpha project sessions (2)
    expect(sessions).toHaveLength(2);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain(IDS.sessionAlpha1);
    expect(ids).toContain(IDS.sessionAlpha2);
    // Must NOT contain beta session
    expect(ids).not.toContain(IDS.sessionBeta1);

    // Verify field mapping on one session
    const s1 = sessions.find((s) => s.id === IDS.sessionAlpha1)!;
    expect(s1.projectId).toBe(IDS.projectAlpha);
    expect(s1.provider).toBe("anthropic");
    expect(s1.model).toBe("claude-sonnet-4-20250514");
    expect(s1.agentId).toBe("claude-code");
    expect(s1.systemPromptHash).toBe("abc123def456");
    expect(s1.totalTurns).toBe(3);
    expect(s1.turnsCaptured).toBe(3);
    expect(s1.droppedEvents).toBe(0);
    expect(s1.totalTokens).toBe(15000);
    expect(s1.totalCostUsd).toBeCloseTo(0.45, 2);
    expect(s1.complete).toBe(true); // ended_at is set
    expect(s1.startedAt).toBeDefined();
    expect(s1.initialIntent).toBe("Refactor authentication module");
  });

  it("admin key sees sessions from ALL projects", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query { sessions { items { id projectId } } }`,
    });

    expect(response.status).toBe(200);
    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(3);

    const projectIds = new Set(sessions.map((s) => s.projectId));
    expect(projectIds).toContain(IDS.projectAlpha);
    expect(projectIds).toContain(IDS.projectBeta);
  });

  it("filters by provider", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: SessionFilter) {
          sessions(filter: $filter) { items { id provider } }
        }
      `,
      variables: { filter: { provider: "openai" } },
    });

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) {
      expect(s.provider).toBe("openai");
    }
  });

  it("filters by model", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: SessionFilter) {
          sessions(filter: $filter) { items { id model } }
        }
      `,
      variables: { filter: { model: "gpt-4o" } },
    });

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) {
      expect(s.model).toBe("gpt-4o");
    }
  });

  it("filters by projectId (admin key)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: SessionFilter) {
          sessions(filter: $filter) { items { id projectId } }
        }
      `,
      variables: { filter: { projectId: IDS.projectBeta } },
    });

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectId).toBe(IDS.projectBeta);
  });

  it("filters by startedAfter and startedBefore", async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 3600_000).toISOString();
    const ninetyMinAgo = new Date(Date.now() - 90 * 60_000).toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: SessionFilter) {
          sessions(filter: $filter) { items { id startedAt } }
        }
      `,
      variables: {
        filter: {
          startedAfter: threeHoursAgo,
          startedBefore: ninetyMinAgo,
        },
      },
    });

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    // Only sessionAlpha1 started ~2 hours ago — between 3h ago and 90min ago
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    for (const s of sessions) {
      const started = new Date(s.startedAt as string);
      expect(started.getTime()).toBeGreaterThanOrEqual(
        new Date(threeHoursAgo).getTime()
      );
      expect(started.getTime()).toBeLessThanOrEqual(
        new Date(ninetyMinAgo).getTime()
      );
    }
  });

  it("supports limit and offset pagination", async () => {
    const { body: page1 } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions(limit: 1, offset: 0) { items { id } } }`,
    });

    const { body: page2 } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions(limit: 1, offset: 1) { items { id } } }`,
    });

    const sessions1 = (page1.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const sessions2 = (page2.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;

    expect(sessions1).toHaveLength(1);
    expect(sessions2).toHaveLength(1);
    // The two pages must return different sessions
    expect(sessions1[0].id).not.toBe(sessions2[0].id);
  });

  it("returns empty list for project with no sessions", async () => {
    // Beta key only has 1 session, so offset=10 should be empty
    const { body } = await graphql({
      apiKey: API_KEYS.beta,
      query: `query { sessions(limit: 10, offset: 10) { items { id } } }`,
    });

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(0);
  });
});

// =========================================================================
// session (single) query
// =========================================================================

describe("session query", () => {
  it("returns a session by ID with nested turns", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          session(id: $id) {
            id
            totalTurns
            turns {
              id
              sequenceNum
              timestamp
              turnType
              inputTokens
              outputTokens
              costUsd
              durationMs
              captureComplete
              contentHashReq
              contentHashResp
              stopReason
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
    expect(session.id).toBe(IDS.sessionAlpha1);
    expect(session.totalTurns).toBe(3);

    const turns = session.turns as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(3);

    // Turns should be ordered by sequence_num
    expect(turns[0].sequenceNum).toBe(1);
    expect(turns[1].sequenceNum).toBe(2);
    expect(turns[2].sequenceNum).toBe(3);

    // Verify turn field mapping
    const t1 = turns[0];
    expect(t1.id).toBe(IDS.turnA1_1);
    expect(t1.inputTokens).toBe(1000);
    expect(t1.outputTokens).toBe(500);
    expect(t1.costUsd).toBeCloseTo(0.05, 2);
    expect(t1.durationMs).toBe(1200);
    // captureComplete: both req_bytes_ref and resp_bytes_ref are set
    expect(t1.captureComplete).toBe(true);
    expect(t1.contentHashReq).toBe("hash_req_a1_1");
    expect(t1.contentHashResp).toBe("hash_resp_a1_1");
  });

  it("returns null for nonexistent session ID", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          session(id: "00000000-0000-0000-0000-000000000000") { id }
        }
      `,
    });

    expect(response.status).toBe(200);
    expect(body.data!.session).toBeNull();
  });

  it("project-scoped key cannot access another project's session", async () => {
    // Alpha key tries to access beta session
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          session(id: $id) { id }
        }
      `,
      variables: { id: IDS.sessionBeta1 },
    });

    // Should return null (not found for this project), not an error
    expect(body.data!.session).toBeNull();
  });

  it("complete field is false when ended_at is null", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          session(id: $id) { id complete endedAt }
        }
      `,
      variables: { id: IDS.sessionAlpha2 },
    });

    const session = body.data!.session as Record<string, unknown>;
    expect(session.complete).toBe(false);
    expect(session.endedAt).toBeNull();
  });
});

// =========================================================================
// turn query
// =========================================================================

describe("turn query", () => {
  it("returns a single turn with tool calls", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) {
            id
            sessionId
            sequenceNum
            inputTokens
            outputTokens
            toolCalls {
              id
              name
              input
              inputHash
              result
              resultHash
              durationMs
            }
          }
        }
      `,
      variables: { id: IDS.turnA1_2 },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const turn = body.data!.turn as Record<string, unknown>;
    expect(turn).not.toBeNull();
    expect(turn.id).toBe(IDS.turnA1_2);
    expect(turn.sessionId).toBe(IDS.sessionAlpha1);
    expect(turn.sequenceNum).toBe(2);

    const toolCalls = turn.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(2);

    // Should include both Edit and Bash tool calls
    const names = toolCalls.map((tc) => tc.name);
    expect(names).toContain("Edit");
    expect(names).toContain("Bash");

    // Verify field mapping on one tool call
    const editCall = toolCalls.find((tc) => tc.name === "Edit")!;
    expect(editCall.inputHash).toBe("input_hash_tc2");
    expect(editCall.result).toBe("Applied 3 edits to auth.ts");
    expect(editCall.resultHash).toBe("output_hash_tc2");
    expect(editCall.durationMs).toBe(120);
  });

  it("returns null for nonexistent turn ID", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          turn(id: "00000000-0000-0000-0000-000000000000") { id }
        }
      `,
    });

    expect(body.data!.turn).toBeNull();
  });

  it("project-scoped key cannot access turn from another project", async () => {
    // Alpha key tries to access a turn in beta session
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) { id }
        }
      `,
      variables: { id: IDS.turnB1_1 },
    });

    expect(body.data!.turn).toBeNull();
  });

  it("turn with no tool calls returns empty array", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) { id toolCalls { id } }
        }
      `,
      variables: { id: IDS.turnA1_3 },
    });

    const turn = body.data!.turn as Record<string, unknown>;
    expect(turn).not.toBeNull();
    expect(turn.toolCalls).toEqual([]);
  });
});

// =========================================================================
// search query
// =========================================================================

describe("search query", () => {
  it("returns matching turns for a search query", async () => {
    // The search_vector was populated with role, model, provider
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($query: String!, $projectId: ID!) {
          search(query: $query, projectId: $projectId) {
            id
            sessionId
            sequenceNum
          }
        }
      `,
      variables: { query: "anthropic", projectId: IDS.projectAlpha },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const turns = body.data!.search as Array<Record<string, unknown>>;
    // Should find turns from the anthropic session in alpha
    expect(turns.length).toBeGreaterThanOrEqual(1);
    for (const t of turns) {
      // All returned turns must belong to a session in project alpha
      expect(t.sessionId).toBe(IDS.sessionAlpha1);
    }
  });

  it("project-scoped key cannot search another project", async () => {
    // Alpha key trying to search in beta project
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($query: String!, $projectId: ID!) {
          search(query: $query, projectId: $projectId) { id }
        }
      `,
      variables: { query: "anthropic", projectId: IDS.projectBeta },
    });

    // Should return either empty results or an authorization error
    if (body.errors) {
      // Authorization error is acceptable
      expect(response.status).toBe(200); // GraphQL returns 200 with errors
      expect(body.errors[0].message).toMatch(/unauthorized|forbidden|access/i);
    } else {
      // Or just empty results (filtered by project scope)
      const turns = body.data!.search as Array<Record<string, unknown>>;
      expect(turns).toHaveLength(0);
    }
  });

  it("returns empty array for query with no matches", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($query: String!, $projectId: ID!) {
          search(query: $query, projectId: $projectId) { id }
        }
      `,
      variables: {
        query: "zzz_nonexistent_term_zzz",
        projectId: IDS.projectAlpha,
      },
    });

    const turns = body.data!.search as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(0);
  });
});

// =========================================================================
// verifyIntegrity query
// =========================================================================

describe("verifyIntegrity query", () => {
  it("returns integrity report for a session", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($sessionId: ID!) {
          verifyIntegrity(sessionId: $sessionId) {
            sessionId
            totalTurns
            verifiedTurns
            failedTurns
            results {
              turnId
              sequenceNum
              reqHashMatch
              respHashMatch
              reqBytesPresent
              respBytesPresent
            }
          }
        }
      `,
      variables: { sessionId: IDS.sessionAlpha1 },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const report = body.data!.verifyIntegrity as Record<string, unknown>;
    expect(report.sessionId).toBe(IDS.sessionAlpha1);
    expect(report.totalTurns).toBe(3);

    const results = report.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);

    // Each result should have the expected fields
    for (const r of results) {
      expect(r.turnId).toBeDefined();
      expect(typeof r.sequenceNum).toBe("number");
      expect(typeof r.reqHashMatch).toBe("boolean");
      expect(typeof r.respHashMatch).toBe("boolean");
      expect(typeof r.reqBytesPresent).toBe("boolean");
      expect(typeof r.respBytesPresent).toBe("boolean");
    }

    // Results should be ordered by sequenceNum
    const seqNums = results.map((r) => r.sequenceNum as number);
    expect(seqNums).toEqual([1, 2, 3]);

    // All turns have req_bytes_ref and resp_bytes_ref set, so bytesPresent should be true
    for (const r of results) {
      expect(r.reqBytesPresent).toBe(true);
      expect(r.respBytesPresent).toBe(true);
    }

    // verifiedTurns + failedTurns should equal totalTurns
    expect(
      (report.verifiedTurns as number) + (report.failedTurns as number)
    ).toBe(report.totalTurns);
  });

  it("project-scoped key cannot verify another project's session", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($sessionId: ID!) {
          verifyIntegrity(sessionId: $sessionId) {
            sessionId
            totalTurns
          }
        }
      `,
      variables: { sessionId: IDS.sessionBeta1 },
    });

    // Should return error or null/empty report
    if (body.errors) {
      expect(body.errors[0].message).toMatch(
        /not found|unauthorized|forbidden|access/i
      );
    } else {
      const report = body.data!.verifyIntegrity as Record<string, unknown> | null;
      // If it returns a report, totalTurns should be 0 (no visible turns)
      if (report) {
        expect(report.totalTurns).toBe(0);
      }
    }
  });
});

// =========================================================================
// anomalies query
// =========================================================================

describe("anomalies query", () => {
  it("returns anomaly events visible to admin", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query {
          anomalies {
            id
            sessionId
            turnId
            anomalyType
            severity
            description
            detectedAt
          }
        }
      `,
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(2);

    const a1 = anomalies.find((a) => a.id === IDS.anomaly1);
    expect(a1).toBeDefined();
    expect(a1!.anomalyType).toBe("dropped_event");
    expect(a1!.severity).toBe("warning");
    expect(a1!.sessionId).toBe(IDS.sessionBeta1);

    const a2 = anomalies.find((a) => a.id === IDS.anomaly2);
    expect(a2).toBeDefined();
    expect(a2!.anomalyType).toBe("hash_mismatch");
    expect(a2!.severity).toBe("critical");
    expect(a2!.turnId).toBe(IDS.turnA1_3);
  });

  it("filters by severity", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) { id severity }
        }
      `,
      variables: { filter: { severity: "critical" } },
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    for (const a of anomalies) {
      expect(a.severity).toBe("critical");
    }
  });

  it("filters by sessionId", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) { id sessionId }
        }
      `,
      variables: { filter: { sessionId: IDS.sessionBeta1 } },
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    for (const a of anomalies) {
      expect(a.sessionId).toBe(IDS.sessionBeta1);
    }
  });

  it("filters by anomalyType", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) { id anomalyType }
        }
      `,
      variables: { filter: { anomalyType: "hash_mismatch" } },
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    for (const a of anomalies) {
      expect(a.anomalyType).toBe("hash_mismatch");
    }
  });

  it("project-scoped key only sees anomalies for own project", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { anomalies { id sessionId } }`,
    });

    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    // Alpha should see anomaly2 (sessionAlpha1) but NOT anomaly1 (sessionBeta1)
    const ids = anomalies.map((a) => a.id);
    expect(ids).toContain(IDS.anomaly2);
    expect(ids).not.toContain(IDS.anomaly1);
  });
});
