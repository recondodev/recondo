/**
 * Sprint D0 Batch A — Foundation behavioral tests.
 *
 * Tests for:
 *   D0.1 — Fastify router extraction (all existing endpoints respond identically)
 *   D0.2 — Auth security fix (3 REST endpoints protected with auth)
 *   D0.5 — Resolver domain splitting (GraphQL resolvers return identical data)
 *
 * These tests are written BEFORE the implementation exists.
 * They assert only on externally observable behavior (HTTP responses, headers,
 * GraphQL results). Every test must pass against both the old createServer code
 * AND the new Fastify implementation — zero behavior change.
 *
 * Expects:
 *   - PostgreSQL running at localhost:5432 (docker-compose)
 *   - API server running at localhost:4000
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
  httpGet,
  API_KEYS,
  IDS,
  API_BASE_URL,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// D0.1 — Fastify Router Extraction: Existing endpoints respond identically
// =========================================================================

describe("D0.1 — Fastify router: health check preserved", () => {
  it("GET /health returns 200 with status healthy", async () => {
    const { body, response } = await httpGet("/health");

    expect(response.status).toBe(200);
    const json = body as Record<string, unknown>;
    expect(json.status).toBe("healthy");
    expect(json.components).toBeDefined();
  });

  it("GET /health returns Content-Type application/json", async () => {
    const { response } = await httpGet("/health");

    const contentType = response.headers.get("content-type");
    expect(contentType).toMatch(/application\/json/);
  });

  it("GET /health does NOT require authentication", async () => {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
  });

  it("negative: GET /nonexistent returns 404", async () => {
    const response = await fetch(`${API_BASE_URL}/nonexistent`, {
      method: "GET",
    });

    // After Fastify migration, unknown routes must still return 404 (not crash)
    expect(response.status).toBe(404);
  });
});

describe("D0.1 — Fastify router: GraphQL endpoint preserved", () => {
  it("POST /graphql with valid auth returns 200 and data", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { items { id } } }`,
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();
    expect(body.data!.sessions).toBeDefined();
  });

  it("POST /graphql without auth returns 401", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { sessions { items { id } } }` }),
    });

    expect(response.status).toBe(401);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("POST /graphql Content-Type is application/json", async () => {
    const { response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { items { id } } }`,
    });

    const contentType = response.headers.get("content-type");
    expect(contentType).toMatch(/application\/json/);
  });

  it("negative: GET /graphql is not a valid method (should not return 200)", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
    });

    // GraphQL endpoint only accepts POST — should NOT return 200
    expect(response.status).not.toBe(200);
  });
});

describe("D0.1 — Fastify router: REST endpoints preserved", () => {
  it("GET /v1/sessions returns JSON array with valid auth", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "GET",
      headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
    });

    // After D0.2 fix, this endpoint requires auth — so with auth it should return 200
    expect(response.status).toBe(200);
    const json = (await response.json()) as unknown[];
    expect(Array.isArray(json)).toBe(true);
  });

  it("GET /v1/sessions supports limit and offset query params", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=1&offset=0`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as unknown[];
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeLessThanOrEqual(1);
  });

  it("GET /v1/sessions/:id returns session with turns (valid auth)", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/${IDS.sessionAlpha1}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.id).toBe(IDS.sessionAlpha1);
    // Session detail endpoint includes nested turns
    expect(json.turns).toBeDefined();
    expect(Array.isArray(json.turns)).toBe(true);
  });

  it("GET /v1/sessions/:id returns 404 for nonexistent session", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/00000000-0000-0000-0000-000000000000`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(404);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("GET /v1/turns/:id returns turn data (valid auth)", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/${IDS.turnA1_1}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.id).toBe(IDS.turnA1_1);
  });

  it("GET /v1/turns/:id returns 404 for nonexistent turn", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/00000000-0000-0000-0000-000000000000`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(404);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: POST /v1/sessions is not a valid method", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEYS.alpha}`,
      },
      body: JSON.stringify({}),
    });

    // Sessions list is GET-only — POST should not return 200
    expect(response.status).not.toBe(200);
  });
});

// =========================================================================
// D0.1 — CORS: Headers present on responses
// =========================================================================

describe("D0.1 — CORS configuration", () => {
  it("responses from localhost origin include Access-Control-Allow-Origin", async () => {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: "GET",
      headers: {
        Origin: "http://localhost:3000",
      },
    });

    expect(response.status).toBe(200);
    const acaoHeader = response.headers.get("access-control-allow-origin");
    expect(acaoHeader).toBe("http://localhost:3000");
  });

  it("CORS preflight (OPTIONS) returns 204", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Authorization",
      },
    });

    expect(response.status).toBe(204);
    const acaoHeader = response.headers.get("access-control-allow-origin");
    expect(acaoHeader).toBe("http://localhost:3000");
  });

  it("CORS allows GET, POST, and OPTIONS methods", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
      },
    });

    const methods = response.headers.get("access-control-allow-methods");
    expect(methods).toBeDefined();
    expect(methods).toMatch(/GET/);
    expect(methods).toMatch(/POST/);
    expect(methods).toMatch(/OPTIONS/);
  });

  it("CORS allows Content-Type and Authorization headers", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type, Authorization",
      },
    });

    const allowedHeaders = response.headers.get("access-control-allow-headers");
    expect(allowedHeaders).toBeDefined();
    expect(allowedHeaders!.toLowerCase()).toMatch(/content-type/);
    expect(allowedHeaders!.toLowerCase()).toMatch(/authorization/);
  });

  it("negative: non-localhost origin does not get CORS headers", async () => {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: "GET",
      headers: {
        Origin: "https://evil.example.com",
      },
    });

    // Non-localhost origins should NOT receive Access-Control-Allow-Origin
    // (or it should not match the evil origin)
    const acaoHeader = response.headers.get("access-control-allow-origin");
    if (acaoHeader !== null) {
      expect(acaoHeader).not.toBe("https://evil.example.com");
    }
  });
});

// =========================================================================
// D0.2 — Auth Security Fix: 3 REST endpoints require authentication
// =========================================================================

describe("D0.2 — /v1/sessions requires auth", () => {
  it("returns 401 without Authorization header", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "GET",
    });

    expect(response.status).toBe(401);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("returns 401 with invalid API key", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEYS.invalid}`,
      },
    });

    expect(response.status).toBe(401);
  });

  it("returns 401 with revoked API key", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEYS.revoked}`,
      },
    });

    expect(response.status).toBe(401);
  });

  it("returns 401 with malformed Authorization header (missing Bearer prefix)", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "GET",
      headers: {
        Authorization: API_KEYS.alpha,
      },
    });

    expect(response.status).toBe(401);
  });

  it("returns session data WITH valid auth token", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEYS.alpha}`,
      },
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as unknown[];
    expect(Array.isArray(json)).toBe(true);
    // With valid auth, we should get actual session data
    expect(json.length).toBeGreaterThanOrEqual(1);
  });

  it("returns JSON error body on 401", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "GET",
    });

    expect(response.status).toBe(401);
    const contentType = response.headers.get("content-type");
    expect(contentType).toMatch(/application\/json/);

    const json = (await response.json()) as Record<string, unknown>;
    const hasErrorField = json.error || json.errors || json.message;
    expect(hasErrorField).toBeTruthy();
  });
});

describe("D0.2 — /v1/sessions/:id requires auth", () => {
  it("returns 401 without Authorization header", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/${IDS.sessionAlpha1}`,
      {
        method: "GET",
      }
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 with invalid API key", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/${IDS.sessionAlpha1}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${API_KEYS.invalid}`,
        },
      }
    );

    expect(response.status).toBe(401);
  });

  it("returns session data WITH valid auth token", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/${IDS.sessionAlpha1}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${API_KEYS.alpha}`,
        },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.id).toBe(IDS.sessionAlpha1);
  });

  it("negative: valid auth but nonexistent session still returns 404 (not 401)", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/00000000-0000-0000-0000-000000000000`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${API_KEYS.alpha}`,
        },
      }
    );

    // Auth passes, but session does not exist — must be 404, not 401
    expect(response.status).toBe(404);
  });
});

describe("D0.2 — /v1/turns/:id requires auth", () => {
  it("returns 401 without Authorization header", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/${IDS.turnA1_1}`,
      {
        method: "GET",
      }
    );

    expect(response.status).toBe(401);
  });

  it("returns 401 with invalid API key", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/${IDS.turnA1_1}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${API_KEYS.invalid}`,
        },
      }
    );

    expect(response.status).toBe(401);
  });

  it("returns turn data WITH valid auth token", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/${IDS.turnA1_1}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${API_KEYS.alpha}`,
        },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.id).toBe(IDS.turnA1_1);
  });

  it("negative: valid auth but nonexistent turn still returns 404 (not 401)", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/00000000-0000-0000-0000-000000000000`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${API_KEYS.alpha}`,
        },
      }
    );

    // Auth passes, but turn does not exist — must be 404, not 401
    expect(response.status).toBe(404);
  });
});

describe("D0.2 — development mode auth bypass", () => {
  /**
   * In development mode (NODE_ENV=development and no RECONDO_DASHBOARD_API_KEY
   * set), the three REST endpoints should skip auth. Since the test server runs
   * with NODE_ENV=test or NODE_ENV=development, we test this by checking
   * that the server is consistent: either auth is enforced on ALL three
   * endpoints or bypassed on ALL three.
   *
   * When running with RECONDO_DASHBOARD_API_KEY set (production-like), all
   * three must require auth. The tests above cover the auth-required case.
   *
   * This test verifies the bypass-all-or-enforce-all consistency.
   */
  it("all three REST endpoints have consistent auth behavior", async () => {
    // Send unauthenticated requests to all three endpoints
    const [sessionsResp, sessionResp, turnResp] = await Promise.all([
      fetch(`${API_BASE_URL}/v1/sessions`, { method: "GET" }),
      fetch(`${API_BASE_URL}/v1/sessions/${IDS.sessionAlpha1}`, {
        method: "GET",
      }),
      fetch(`${API_BASE_URL}/v1/turns/${IDS.turnA1_1}`, { method: "GET" }),
    ]);

    // All three should respond with the SAME status (either all 401 or all 200)
    const statuses = [
      sessionsResp.status,
      sessionResp.status,
      turnResp.status,
    ];

    // They should all be the same class (all 4xx if auth enforced, all 2xx if bypassed)
    const allRequireAuth = statuses.every((s) => s === 401);
    const allBypassAuth = statuses.every((s) => s === 200 || s === 404);

    expect(allRequireAuth || allBypassAuth).toBe(true);
  });
});

describe("D0.2 — GraphQL auth still enforced (existing behavior preserved)", () => {
  it("POST /graphql still returns 401 without auth", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query { sessions { items { id } } }` }),
    });

    expect(response.status).toBe(401);
  });

  it("POST /graphql still works with valid auth", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { items { id } } }`,
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data!.sessions).toBeDefined();
  });
});

// =========================================================================
// D0.5 — Resolver Domain Splitting: GraphQL resolvers return identical data
// =========================================================================

describe("D0.5 — sessions resolver: identical data after splitting", () => {
  it("sessions query returns correct fields with camelCase mapping", async () => {
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

    const sessions = body.data!.sessions.items as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(1);

    // Verify field types on first session
    const s = sessions[0];
    expect(typeof s.id).toBe("string");
    expect(typeof s.provider).toBe("string");
    expect(typeof s.startedAt).toBe("string");
    expect(typeof s.systemPromptHash).toBe("string");
    expect(typeof s.totalTurns).toBe("number");
    expect(typeof s.turnsCaptured).toBe("number");
    expect(typeof s.droppedEvents).toBe("number");
    expect(typeof s.totalTokens).toBe("number");
    expect(typeof s.totalCostUsd).toBe("number");
    expect(typeof s.complete).toBe("boolean");
  });

  it("sessions query with filter returns filtered results", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: SessionFilter) {
          sessions(filter: $filter) { items { id provider } }
        }
      `,
      variables: { filter: { provider: "anthropic" } },
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data!.sessions.items as Array<Record<string, unknown>>;
    for (const s of sessions) {
      expect(s.provider).toBe("anthropic");
    }
  });

  it("sessions query with pagination returns correct page", async () => {
    const { body: page1 } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions(limit: 1, offset: 0) { items { id } } }`,
    });
    const { body: page2 } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions(limit: 1, offset: 1) { items { id } } }`,
    });

    const s1 = page1.data!.sessions.items as Array<Record<string, unknown>>;
    const s2 = page2.data!.sessions.items as Array<Record<string, unknown>>;
    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    expect(s1[0].id).not.toBe(s2[0].id);
  });

  it("negative: sessions query with invalid filter type still returns 200 with error", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          sessions(filter: { provider: 12345 }) { items { id } }
        }
      `,
    });

    // GraphQL should report a validation error (200 with errors array)
    expect(response.status).toBe(200);
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThanOrEqual(1);
  });
});

describe("D0.5 — session resolver: single session lookup after splitting", () => {
  it("session(id) returns session with nested turns", async () => {
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
              inputTokens
              outputTokens
              costUsd
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
    // Turns ordered by sequence_num
    expect(turns[0].sequenceNum).toBe(1);
    expect(turns[1].sequenceNum).toBe(2);
    expect(turns[2].sequenceNum).toBe(3);
  });

  it("session(id) returns null for nonexistent session", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          session(id: "00000000-0000-0000-0000-000000000000") { id }
        }
      `,
    });

    expect(body.data!.session).toBeNull();
  });

  it("project scoping: alpha key cannot access beta session", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($id: ID!) { session(id: $id) { id } }`,
      variables: { id: IDS.sessionBeta1 },
    });

    expect(body.data!.session).toBeNull();
  });
});

describe("D0.5 — turns resolver: single turn lookup after splitting", () => {
  it("turn(id) returns turn with tool calls", async () => {
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

    const toolCalls = turn.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(2);
    const names = toolCalls.map((tc) => tc.name);
    expect(names).toContain("Edit");
    expect(names).toContain("Bash");
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

  it("project scoping: alpha key cannot access beta turn", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($id: ID!) { turn(id: $id) { id } }`,
      variables: { id: IDS.turnB1_1 },
    });

    expect(body.data!.turn).toBeNull();
  });

  it("turn(id) returns null for nonexistent turn", async () => {
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
});

describe("D0.5 — anomalies resolver: identical data after splitting", () => {
  it("anomalies query returns anomaly events with correct fields", async () => {
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

    // Verify known anomaly data is present
    const a1 = anomalies.find((a) => a.id === IDS.anomaly1);
    expect(a1).toBeDefined();
    expect(a1!.anomalyType).toBe("dropped_event");
    expect(a1!.severity).toBe("warning");

    const a2 = anomalies.find((a) => a.id === IDS.anomaly2);
    expect(a2).toBeDefined();
    expect(a2!.anomalyType).toBe("hash_mismatch");
    expect(a2!.severity).toBe("critical");
  });

  it("anomalies filter by severity works after splitting", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `
        query($filter: AnomalyFilter) {
          anomalies(filter: $filter) { id severity }
        }
      `,
      variables: { filter: { severity: "critical" } },
    });

    expect(body.errors).toBeUndefined();
    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);
    for (const a of anomalies) {
      expect(a.severity).toBe("critical");
    }
  });

  it("project scoping: alpha key only sees own project anomalies", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { anomalies { id sessionId } }`,
    });

    expect(body.errors).toBeUndefined();
    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    const ids = anomalies.map((a) => a.id);
    // Alpha should see anomaly2 (its own project) but NOT anomaly1 (beta project)
    expect(ids).toContain(IDS.anomaly2);
    expect(ids).not.toContain(IDS.anomaly1);
  });
});

describe("D0.5 — mappers: row mapping consistency after splitting", () => {
  it("session mapper produces complete=true when endedAt is set", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          session(id: $id) { id complete endedAt }
        }
      `,
      variables: { id: IDS.sessionAlpha1 },
    });

    const session = body.data!.session as Record<string, unknown>;
    expect(session.complete).toBe(true);
    expect(session.endedAt).toBeDefined();
    expect(session.endedAt).not.toBeNull();
  });

  it("session mapper produces complete=false when endedAt is null", async () => {
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

  it("turn mapper produces captureComplete correctly", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) { id captureComplete contentHashReq contentHashResp }
        }
      `,
      variables: { id: IDS.turnA1_1 },
    });

    const turn = body.data!.turn as Record<string, unknown>;
    expect(turn.captureComplete).toBe(true);
    expect(turn.contentHashReq).toBeDefined();
    expect(turn.contentHashResp).toBeDefined();
  });

  it("tool call mapper preserves all fields after splitting", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) {
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

    const turn = body.data!.turn as Record<string, unknown>;
    const toolCalls = turn.toolCalls as Array<Record<string, unknown>>;

    const editCall = toolCalls.find((tc) => tc.name === "Edit")!;
    expect(editCall).toBeDefined();
    expect(editCall.inputHash).toBe("input_hash_tc2");
    expect(editCall.result).toBe("Applied 3 edits to auth.ts");
    expect(editCall.resultHash).toBe("output_hash_tc2");
    expect(editCall.durationMs).toBe(120);
  });

  it("negative: resolver returns error for deeply nested query (depth limit preserved)", async () => {
    // The depth limit rule rejects queries deeper than 4 levels
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          sessions {
            items {
              turns {
                toolCalls {
                  id
                }
                anomalies {
                  turn {
                    toolCalls {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      `,
    });

    // This query is deeper than MAX_DEPTH=4, so it should be rejected
    expect(body.errors).toBeDefined();
    expect(body.errors!.length).toBeGreaterThanOrEqual(1);
    expect(body.errors![0].message).toMatch(/depth/i);
  });
});

// =========================================================================
// D0.5 — search & verifyIntegrity resolvers: identical data after splitting
// =========================================================================

describe("D0.5 — search resolver after splitting", () => {
  it("search returns matching turns", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($query: String!, $projectId: ID) {
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
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  it("search returns empty array for no matches", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($query: String!, $projectId: ID) {
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

describe("D0.5 — verifyIntegrity resolver after splitting", () => {
  it("returns integrity report with correct structure", async () => {
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

    // verifiedTurns + failedTurns = totalTurns
    expect(
      (report.verifiedTurns as number) + (report.failedTurns as number)
    ).toBe(report.totalTurns);
  });
});
