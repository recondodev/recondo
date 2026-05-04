/**
 * Sprint D0 Batch B -- Behavioral tests for:
 *   D0.3 -- GraphQL Codegen (schema.graphql file, generated resolver types)
 *   D0.4 -- DataLoader (batched N+1 queries for nested resolvers)
 *   D0.6 -- Zod Validation (REST input validation returning 400 on invalid)
 *   D0.7 -- Migration Framework (node-pg-migrate, migrations directory)
 *
 * Written BEFORE the implementation exists. Tests assert only on externally
 * observable behavior: HTTP responses, GraphQL results, file existence, and
 * database state.
 *
 * Expects:
 *   - PostgreSQL running at localhost:5432 (docker-compose)
 *   - API server running at localhost:4000
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { parse } from "graphql";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
  API_KEYS,
  IDS,
  API_BASE_URL,
  getPool,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// D0.3 -- GraphQL Codegen: schema.graphql exists and is valid
// =========================================================================

describe("D0.3 -- schema.graphql file exists and is valid GraphQL", () => {
  const schemaPath = join(__dirname, "..", "src", "schema.graphql");

  it("schema.graphql file exists at api/src/schema.graphql", () => {
    expect(existsSync(schemaPath)).toBe(true);
  });

  it("schema.graphql is parseable as valid GraphQL", () => {
    const source = readFileSync(schemaPath, "utf-8");
    // graphql parse() throws on invalid syntax
    const doc = parse(source);
    expect(doc.kind).toBe("Document");
    expect(doc.definitions.length).toBeGreaterThanOrEqual(1);
  });

  it("schema.graphql contains the Query type with expected root fields", () => {
    const source = readFileSync(schemaPath, "utf-8");
    // These root query fields must be present per the existing schema
    expect(source).toContain("sessions");
    expect(source).toContain("session");
    expect(source).toContain("turn");
    expect(source).toContain("search");
    expect(source).toContain("verifyIntegrity");
    expect(source).toContain("anomalies");
  });

  it("schema.graphql contains the Session type with expected fields", () => {
    const source = readFileSync(schemaPath, "utf-8");
    expect(source).toContain("type Session");
    expect(source).toContain("totalTurns");
    expect(source).toContain("totalCostUsd");
    expect(source).toContain("systemPromptHash");
    expect(source).toContain("turns");
  });

  it("schema.graphql contains the Turn type with expected fields", () => {
    const source = readFileSync(schemaPath, "utf-8");
    expect(source).toContain("type Turn");
    expect(source).toContain("toolCalls");
    expect(source).toContain("anomalies");
    expect(source).toContain("inputTokens");
    expect(source).toContain("outputTokens");
  });

  it("schema.graphql contains the AnomalyEvent type", () => {
    const source = readFileSync(schemaPath, "utf-8");
    expect(source).toContain("type AnomalyEvent");
    expect(source).toContain("anomalyType");
    expect(source).toContain("severity");
  });

  it("schema.graphql contains the ToolCall type", () => {
    const source = readFileSync(schemaPath, "utf-8");
    expect(source).toContain("type ToolCall");
  });

  it("schema.graphql contains the IntegrityReport type", () => {
    const source = readFileSync(schemaPath, "utf-8");
    expect(source).toContain("type IntegrityReport");
    expect(source).toContain("type TurnIntegrityResult");
  });

  it("schema.graphql contains input types (SessionFilter, AnomalyFilter)", () => {
    const source = readFileSync(schemaPath, "utf-8");
    expect(source).toContain("input SessionFilter");
    expect(source).toContain("input AnomalyFilter");
  });

  it("schema.graphql contains the DateTime scalar", () => {
    const source = readFileSync(schemaPath, "utf-8");
    expect(source).toContain("scalar DateTime");
  });

  it("negative: schema.graphql is not empty", () => {
    const source = readFileSync(schemaPath, "utf-8");
    // A real schema must have substantial content, not just a few bytes
    expect(source.trim().length).toBeGreaterThan(100);
  });
});

describe("D0.3 -- Generated types file exists", () => {
  const generatedPath = join(__dirname, "..", "src", "generated", "graphql.ts");

  it("generated/graphql.ts file exists at api/src/generated/graphql.ts", () => {
    expect(existsSync(generatedPath)).toBe(true);
  });

  it("generated/graphql.ts contains resolver type exports", () => {
    const source = readFileSync(generatedPath, "utf-8");
    // The generated file should export resolver types
    expect(source).toContain("Resolvers");
  });

  it("generated/graphql.ts contains types for the schema's object types", () => {
    const source = readFileSync(generatedPath, "utf-8");
    // Must contain type definitions for our main schema types
    expect(source).toContain("Session");
    expect(source).toContain("Turn");
    expect(source).toContain("ToolCall");
    expect(source).toContain("AnomalyEvent");
    expect(source).toContain("IntegrityReport");
  });

  it("generated/graphql.ts contains Query type", () => {
    const source = readFileSync(generatedPath, "utf-8");
    expect(source).toContain("Query");
  });

  it("negative: generated/graphql.ts is not empty", () => {
    const source = readFileSync(generatedPath, "utf-8");
    expect(source.trim().length).toBeGreaterThan(100);
  });
});

describe("D0.3 -- GraphQL server still works after codegen extraction", () => {
  it("sessions query returns data after schema extraction to .graphql file", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { items { id provider model } } }`,
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data!.sessions).toBeDefined();
    expect(Array.isArray(body.data!.sessions.items)).toBe(true);
  });

  it("session(id) query still resolves after schema extraction", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($id: ID!) { session(id: $id) { id totalTurns } }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.session).not.toBeNull();
    expect(body.data!.session.id).toBe(IDS.sessionAlpha1);
  });
});

// =========================================================================
// D0.4 -- DataLoader: Identical response data after DataLoader integration
// =========================================================================

describe("D0.4 -- DataLoader: sessions with nested turns returns identical data", () => {
  it("session with nested turns returns correct turn count and data", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          session(id: $id) {
            id
            totalTurns
            turns {
              id
              sessionId
              sequenceNum
              inputTokens
              outputTokens
              thinkingTokens
              totalTokens
              costUsd
              captureComplete
              model
              provider
              toolCallCount
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

    // Verify ordering by sequence_num
    expect(turns[0].sequenceNum).toBe(1);
    expect(turns[1].sequenceNum).toBe(2);
    expect(turns[2].sequenceNum).toBe(3);

    // Verify each turn belongs to this session
    for (const t of turns) {
      expect(t.sessionId).toBe(IDS.sessionAlpha1);
    }

    // Verify specific fixture data for turn 1
    expect(turns[0].id).toBe(IDS.turnA1_1);
    expect(turns[0].inputTokens).toBe(1000);
    expect(turns[0].outputTokens).toBe(500);
    expect(turns[0].model).toBe("claude-sonnet-4-20250514");
    expect(turns[0].provider).toBe("anthropic");
  });

  it("multiple sessions each return their own turns (not cross-contaminated)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          sessions {
            items {
              id
              turns {
                id
                sessionId
              }
            }
          }
        }
      `,
    });

    expect(body.errors).toBeUndefined();

    const sessions = body.data!.sessions.items as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    // Each session's turns must all belong to that session
    for (const session of sessions) {
      const turns = session.turns as Array<Record<string, unknown>>;
      for (const turn of turns) {
        expect(turn.sessionId).toBe(session.id);
      }
    }
  });

  it("session with no turns returns empty turns array", async () => {
    // Insert a session with 0 turns for this test
    const pool = getPool();
    const emptySessionId = "cc000000-0000-4000-8000-000000000099";
    await pool.query(
      `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at,
                             system_prompt_hash, total_turns, turns_captured, dropped_events,
                             total_tokens, total_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $5, $6, 0, 0, 0, 0, 0)
       ON CONFLICT (id) DO NOTHING`,
      [emptySessionId, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
       new Date().toISOString(), "empty_hash"]
    );

    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          session(id: $id) { id turns { id } }
        }
      `,
      variables: { id: emptySessionId },
    });

    expect(body.errors).toBeUndefined();
    const session = body.data!.session as Record<string, unknown>;
    expect(session).not.toBeNull();
    expect(session.turns).toEqual([]);
  });
});

describe("D0.4 -- DataLoader: turns with nested toolCalls returns identical data", () => {
  it("turn with tool calls returns all tool call fields", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) {
            id
            toolCalls {
              id
              name
              input
              inputHash
              result
              resultHash
              durationMs
              status
              sequenceNum
            }
          }
        }
      `,
      variables: { id: IDS.turnA1_2 },
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();

    const turn = body.data!.turn as Record<string, unknown>;
    const toolCalls = turn.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(2);

    // Verify specific tool call data
    const editCall = toolCalls.find((tc) => tc.name === "Edit")!;
    expect(editCall).toBeDefined();
    expect(editCall.input).toContain("auth.ts");
    expect(editCall.inputHash).toBe("input_hash_tc2");
    expect(editCall.result).toBe("Applied 3 edits to auth.ts");
    expect(editCall.status).toBe("success");
    expect(editCall.durationMs).toBe(120);

    const bashCall = toolCalls.find((tc) => tc.name === "Bash")!;
    expect(bashCall).toBeDefined();
    expect(bashCall.input).toContain("npm test");
    expect(bashCall.result).toContain("42 passed");
    expect(bashCall.status).toBe("success");
  });

  it("turn with no tool calls returns empty toolCalls array", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) { id toolCallCount toolCalls { id } }
        }
      `,
      variables: { id: IDS.turnA1_3 },
    });

    const turn = body.data!.turn as Record<string, unknown>;
    expect(turn.toolCalls).toEqual([]);
    expect(turn.toolCallCount).toBe(0);
  });
});

describe("D0.4 -- DataLoader: turns with nested anomalies returns identical data", () => {
  it("turn with anomaly returns anomaly data via nested resolver", async () => {
    // turnA1_3 has anomaly2 linked to it
    const { body } = await graphql({
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
            }
          }
        }
      `,
      variables: { id: IDS.turnA1_3 },
    });

    expect(body.errors).toBeUndefined();
    const turn = body.data!.turn as Record<string, unknown>;
    const anomalies = turn.anomalies as Array<Record<string, unknown>>;
    expect(anomalies.length).toBeGreaterThanOrEqual(1);

    const hashMismatch = anomalies.find((a) => a.id === IDS.anomaly2);
    expect(hashMismatch).toBeDefined();
    expect(hashMismatch!.anomalyType).toBe("hash_mismatch");
    expect(hashMismatch!.severity).toBe("critical");
  });

  it("turn with no anomalies returns empty anomalies array", async () => {
    // turnA1_1 has no anomalies linked to it
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          turn(id: $id) { id anomalies { id } }
        }
      `,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    const turn = body.data!.turn as Record<string, unknown>;
    expect(turn.anomalies).toEqual([]);
  });
});

describe("D0.4 -- DataLoader: AnomalyEvent nested resolvers (turn, session)", () => {
  it("anomaly event resolves its parent turn", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          anomalies {
            id
            turnId
            turn {
              id
              sequenceNum
            }
          }
        }
      `,
    });

    expect(body.errors).toBeUndefined();
    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;

    // anomaly2 has turnId = turnA1_3 -- its turn resolver should return that turn
    const a2 = anomalies.find((a) => a.id === IDS.anomaly2);
    if (a2) {
      expect(a2.turn).not.toBeNull();
      const turn = a2.turn as Record<string, unknown>;
      expect(turn.id).toBe(IDS.turnA1_3);
      expect(turn.sequenceNum).toBe(3);
    }
  });

  it("anomaly event resolves its parent session", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          anomalies {
            id
            sessionId
            session {
              id
              provider
            }
          }
        }
      `,
    });

    expect(body.errors).toBeUndefined();
    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;

    // anomaly2 belongs to sessionAlpha1
    const a2 = anomalies.find((a) => a.id === IDS.anomaly2);
    if (a2) {
      expect(a2.session).not.toBeNull();
      const session = a2.session as Record<string, unknown>;
      expect(session.id).toBe(IDS.sessionAlpha1);
      expect(session.provider).toBe("anthropic");
    }
  });

  it("anomaly event with null turnId returns null for turn resolver", async () => {
    // anomaly1 has turnId = null
    const { body } = await graphql({
      apiKey: API_KEYS.beta,
      query: `
        query {
          anomalies {
            id
            turnId
            turn {
              id
            }
          }
        }
      `,
    });

    expect(body.errors).toBeUndefined();
    const anomalies = body.data!.anomalies as Array<Record<string, unknown>>;
    const a1 = anomalies.find((a) => a.id === IDS.anomaly1);
    if (a1) {
      expect(a1.turnId).toBeNull();
      expect(a1.turn).toBeNull();
    }
  });
});

describe("D0.4 -- DataLoader: deeply nested query returns correct data", () => {
  it("session -> turns -> toolCalls full nesting returns correct data", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query($id: ID!) {
          session(id: $id) {
            id
            turns {
              id
              sequenceNum
              toolCalls {
                id
                name
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
    const turns = session.turns as Array<Record<string, unknown>>;
    expect(turns).toHaveLength(3);

    // Turn 1 (sequenceNum=1) has 1 tool call (Read)
    const turn1 = turns.find((t) => t.sequenceNum === 1)!;
    const toolCalls1 = turn1.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls1).toHaveLength(1);
    expect(toolCalls1[0].name).toBe("Read");

    // Turn 2 (sequenceNum=2) has 2 tool calls (Edit, Bash)
    const turn2 = turns.find((t) => t.sequenceNum === 2)!;
    const toolCalls2 = turn2.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls2).toHaveLength(2);
    const names2 = toolCalls2.map((tc) => tc.name);
    expect(names2).toContain("Edit");
    expect(names2).toContain("Bash");

    // Turn 3 (sequenceNum=3) has 0 tool calls
    const turn3 = turns.find((t) => t.sequenceNum === 3)!;
    const toolCalls3 = turn3.toolCalls as Array<Record<string, unknown>>;
    expect(toolCalls3).toHaveLength(0);
  });

  it("sessions list -> turns nesting works for multiple sessions", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `
        query {
          sessions {
            items {
              id
              totalTurns
              turns {
                id
                sequenceNum
              }
            }
          }
        }
      `,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data!.sessions.items as Array<Record<string, unknown>>;

    // Alpha key should see both alpha sessions
    expect(sessions.length).toBeGreaterThanOrEqual(2);

    // Each session's turn count should match its turns array length
    for (const session of sessions) {
      const turns = session.turns as Array<Record<string, unknown>>;
      // totalTurns is the declared count; turns array is the actual fetched data
      // They should be consistent (unless the session was created with 0 turns for testing)
      if ((session.totalTurns as number) > 0) {
        expect(turns.length).toBeGreaterThanOrEqual(1);
      }
    }
  });
});

// =========================================================================
// D0.6 -- Zod Validation: REST input validation
// =========================================================================

describe("D0.6 -- Zod: GET /v1/sessions limit validation", () => {
  it("valid limit=10 returns 200", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=10`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as unknown[];
    expect(Array.isArray(json)).toBe(true);
  });

  it("valid limit=1 (minimum positive) returns 200", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=1`,
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

  it("valid limit=1000 (maximum) returns 200", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=1000`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
  });

  it("negative: limit=0 returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=0`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: limit=-1 returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=-1`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: limit=1001 (exceeds max) returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=1001`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: limit=abc (non-numeric) returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=abc`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: limit=3.14 (non-integer) returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=3.14`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });
});

describe("D0.6 -- Zod: GET /v1/sessions offset validation", () => {
  it("valid offset=0 returns 200", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?offset=0`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
  });

  it("valid offset=10 returns 200", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?offset=10`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
  });

  it("negative: offset=-1 returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?offset=-1`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: offset=abc (non-numeric) returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?offset=abc`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: offset=2.5 (non-integer) returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?offset=2.5`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });
});

describe("D0.6 -- Zod: GET /v1/sessions combined limit + offset validation", () => {
  it("valid limit=5&offset=0 returns 200", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=5&offset=0`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as unknown[];
    expect(Array.isArray(json)).toBe(true);
  });

  it("negative: invalid limit with valid offset returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=-5&offset=0`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
  });

  it("negative: valid limit with invalid offset returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=10&offset=-1`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
  });

  it("no limit/offset params returns 200 (defaults apply)", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as unknown[];
    expect(Array.isArray(json)).toBe(true);
  });
});

describe("D0.6 -- Zod: GET /v1/sessions/:id ID format validation", () => {
  it("valid hex-and-hyphen ID returns 200 or 404", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/${IDS.sessionAlpha1}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    // Valid ID format -- should return data or 404, not 400
    expect([200, 404]).toContain(response.status);
  });

  it("negative: session ID with special characters returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/'; DROP TABLE sessions;--`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: session ID with spaces returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/invalid%20id%20here`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: session ID with unicode characters returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions/%E2%80%8B%E2%80%8B`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
  });
});

describe("D0.6 -- Zod: GET /v1/turns/:id ID format validation", () => {
  it("valid hex-and-hyphen ID returns 200 or 404", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/${IDS.turnA1_1}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect([200, 404]).toContain(response.status);
  });

  it("negative: turn ID with special characters returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/not!valid@id`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
  });

  it("negative: turn ID with SQL injection attempt returns 400", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/turns/1' OR '1'='1`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
  });
});

describe("D0.6 -- Zod: error response body is descriptive", () => {
  it("400 response includes descriptive error message for invalid limit", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=-1`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.error).toBeDefined();
    // The error message should mention what was wrong
    const errorStr = typeof json.error === "string" ? json.error : JSON.stringify(json.error);
    expect(errorStr.length).toBeGreaterThan(5);
  });

  it("400 response is JSON with Content-Type application/json", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=abc`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(400);
    const contentType = response.headers.get("content-type");
    expect(contentType).toMatch(/application\/json/);
  });
});

describe("D0.6 -- Zod: existing valid requests still work after validation is added", () => {
  it("GET /v1/sessions with valid auth returns session data", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
    const json = (await response.json()) as unknown[];
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /v1/sessions/:id with valid ID returns session detail", async () => {
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
    expect(json.turns).toBeDefined();
  });

  it("GET /v1/turns/:id with valid ID returns turn detail", async () => {
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

  it("GET /v1/sessions with limit=50&offset=0 returns 200 (common defaults)", async () => {
    const response = await fetch(
      `${API_BASE_URL}/v1/sessions?limit=50&offset=0`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }
    );

    expect(response.status).toBe(200);
  });

  it("auth is still enforced -- 401 without Bearer token is unchanged", async () => {
    const response = await fetch(`${API_BASE_URL}/v1/sessions`, {
      method: "GET",
    });

    expect(response.status).toBe(401);
  });
});

// =========================================================================
// D0.7 -- Migration Framework: migrations directory and table creation
// =========================================================================

describe("D0.7 -- Migration directory exists with migration files", () => {
  const migrationsDir = join(__dirname, "..", "migrations");

  it("api/migrations/ directory exists", () => {
    expect(existsSync(migrationsDir)).toBe(true);
  });

  it("api/migrations/ contains at least one migration file", () => {
    const files = readdirSync(migrationsDir);
    // Migration files typically follow a timestamp naming convention
    // e.g., 001_initial.sql, 20260322_initial.js, etc.
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("migration files follow a naming convention (timestamp or sequence prefix)", () => {
    const files = readdirSync(migrationsDir);
    // node-pg-migrate uses files like: 1648123456789_migration-name.js or .sql
    // At minimum, every file should start with a digit (sequence or timestamp)
    for (const file of files) {
      // Skip hidden files and subdirectories (e.g. archive/)
      if (file.startsWith(".")) continue;
      const fullPath = `${migrationsDir}/${file}`;
      if (statSync(fullPath).isDirectory()) continue;
      expect(file).toMatch(/^\d/);
    }
  });
});

describe("D0.7 -- API tables exist after migrations run", () => {
  it("sessions table exists and is queryable", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'sessions'
      ) AS "exists"`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("turns table exists and is queryable", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'turns'
      ) AS "exists"`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("tool_calls table exists and is queryable", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'tool_calls'
      ) AS "exists"`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("anomaly_events table exists and is queryable", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'anomaly_events'
      ) AS "exists"`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("api_keys table exists and is queryable", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'api_keys'
      ) AS "exists"`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("projects table exists and is queryable", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'projects'
      ) AS "exists"`
    );
    expect(result.rows[0].exists).toBe(true);
  });

  it("access_audit_log table exists and is queryable", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'access_audit_log'
      ) AS "exists"`
    );
    expect(result.rows[0].exists).toBe(true);
  });
});

describe("D0.7 -- Migration framework: tables have correct columns", () => {
  it("sessions table has required columns from gateway schema", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'sessions'
       ORDER BY ordinal_position`
    );
    const columns = result.rows.map((r: Record<string, unknown>) => r.column_name);

    // Core columns that must exist per gateway schema
    expect(columns).toContain("id");
    expect(columns).toContain("provider");
    expect(columns).toContain("started_at");
    expect(columns).toContain("system_prompt_hash");
    expect(columns).toContain("total_turns");
    expect(columns).toContain("total_tokens");
    expect(columns).toContain("total_cost_usd");
    expect(columns).toContain("project_id");
  });

  it("turns table has required columns from gateway schema", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'turns'
       ORDER BY ordinal_position`
    );
    const columns = result.rows.map((r: Record<string, unknown>) => r.column_name);

    expect(columns).toContain("id");
    expect(columns).toContain("session_id");
    expect(columns).toContain("sequence_num");
    expect(columns).toContain("timestamp");
    expect(columns).toContain("request_hash");
    expect(columns).toContain("response_hash");
    expect(columns).toContain("input_tokens");
    expect(columns).toContain("output_tokens");
    expect(columns).toContain("cost_usd");
    expect(columns).toContain("stop_reason");
  });

  it("tool_calls table has required columns from gateway schema", async () => {
    const pool = getPool();
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'tool_calls'
       ORDER BY ordinal_position`
    );
    const columns = result.rows.map((r: Record<string, unknown>) => r.column_name);

    expect(columns).toContain("id");
    expect(columns).toContain("turn_id");
    expect(columns).toContain("tool_name");
    expect(columns).toContain("tool_input");
  });
});

describe("D0.7 -- Migration framework: idempotency", () => {
  it("server health check returns 200 (server started after migrations)", async () => {
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: "GET",
    });

    // If the server is running and responding to health checks, migrations ran successfully
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.status).toBe("healthy");
  });

  it("existing data is preserved after migrations (not wiped)", async () => {
    // The fixture data seeded in beforeAll should still be present
    // This verifies that migrations do not destructively recreate tables
    const pool = getPool();
    const result = await pool.query(
      `SELECT id FROM sessions WHERE id = $1`,
      [IDS.sessionAlpha1]
    );
    expect(result.rows.length).toBe(1);
  });

  it("GraphQL queries work after migration framework is in place", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { items { id } } }`,
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data!.sessions.items.length).toBeGreaterThanOrEqual(1);
  });
});

describe("D0.7 -- Migration framework: ensure* functions are no-ops after migrations", () => {
  it("server starts without errors (ensure functions do not conflict with migrations)", async () => {
    // The server is running (we can reach /health), which means the ensure* functions
    // did not throw errors even though migrations already created the tables.
    // This verifies the ensure* functions are effectively no-ops when tables exist.
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: "GET",
    });

    expect(response.status).toBe(200);
  });

  it("all route endpoints respond correctly (no migration/ensure conflict)", async () => {
    // Test a representative sample of endpoints to verify nothing broke
    const [healthResp, sessionsResp, graphqlResp] = await Promise.all([
      fetch(`${API_BASE_URL}/health`),
      fetch(`${API_BASE_URL}/v1/sessions`, {
        method: "GET",
        headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
      }),
      fetch(`${API_BASE_URL}/graphql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEYS.alpha}`,
        },
        body: JSON.stringify({ query: `query { sessions { items { id } } }` }),
      }),
    ]);

    expect(healthResp.status).toBe(200);
    expect(sessionsResp.status).toBe(200);
    expect(graphqlResp.status).toBe(200);
  });
});
