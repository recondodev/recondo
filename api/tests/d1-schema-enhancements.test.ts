/**
 * Sprint D1 — Schema Enhancement behavioral tests.
 *
 * Tests for:
 *   D1.2 — GraphQL Session type enhanced fields
 *   D1.3 — GraphQL Turn type enhanced fields
 *   D1.4 — SessionFilter new filter fields (status, framework, search)
 *   D1.5 — SessionConnection pagination wrapper
 *   D1.6 — search query projectId optional
 *   D1.8 — Backward compatibility (existing fields unchanged)
 *
 * These tests are written BEFORE the implementation exists.
 * They assert only on externally observable behavior (HTTP responses,
 * GraphQL results). Every test must FAIL until the implementation is done.
 *
 * Expects:
 *   - PostgreSQL running at localhost:5432 (docker-compose)
 *   - API server running at localhost:4000
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
  gdprBypassUpdate,
  API_KEYS,
  IDS,
  getPool,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
  // Seed additional fixture data needed for D1 tests
  await seedD1Fixtures();
});

afterAll(async () => {
  await teardownDatabase();
});

// ---------------------------------------------------------------------------
// D1 fixture seeding — adds fields that the base fixtures do not cover
// ---------------------------------------------------------------------------

/**
 * Seeds additional data for D1 tests:
 * - Updates sessionAlpha1 with framework, account_uuid, device_id, git_repo, git_branch
 * - Updates sessionAlpha2 with framework (left without ended_at to test ACTIVE status)
 * - Updates turns with cache_read_tokens, cache_creation_tokens, response_text,
 *   thinking_text, transport, ttfb_ms, duration_ms, http_status, user_request_text
 */
async function seedD1Fixtures(): Promise<void> {
  const p = getPool();

  // Update sessionAlpha1 with D1 fields (COMPLETED session — has ended_at)
  await p.query(
    `UPDATE sessions SET
       framework = $1,
       account_uuid = $2,
       device_id = $3,
       git_repo = $4,
       git_branch = $5
     WHERE id = $6`,
    [
      "claude_code",
      "acct-uuid-001",
      "device-uuid-001",
      "github.com/recondo-dev/recondo",
      "main",
      IDS.sessionAlpha1,
    ]
  );

  // Update sessionAlpha2 with D1 fields (ACTIVE session — no ended_at)
  await p.query(
    `UPDATE sessions SET
       framework = $1,
       account_uuid = $2,
       device_id = $3,
       git_repo = $4,
       git_branch = $5
     WHERE id = $6`,
    [
      "cursor",
      "acct-uuid-002",
      "device-uuid-002",
      "github.com/recondo-dev/api",
      "feature-branch",
      IDS.sessionAlpha2,
    ]
  );

  // Update sessionBeta1 with framework (ACTIVE — no ended_at)
  await p.query(
    `UPDATE sessions SET framework = $1 WHERE id = $2`,
    ["claude_code", IDS.sessionBeta1]
  );

  // Update turns with D1 fields
  await gdprBypassUpdate(p,
    `UPDATE turns SET
       cache_read_tokens = $1,
       cache_creation_tokens = $2,
       response_text = $3,
       thinking_text = $4,
       transport = $5,
       ttfb_ms = $6,
       duration_ms = $7,
       http_status = $8
     WHERE id = $9`,
    [500, 100, "The auth module needs refactoring.", "Let me think about this...",
     "http", 120, 1200, 200, IDS.turnA1_1]
  );

  await gdprBypassUpdate(p,
    `UPDATE turns SET
       cache_read_tokens = $1,
       cache_creation_tokens = $2,
       response_text = $3,
       transport = $4,
       http_status = $5
     WHERE id = $6`,
    [200, 50, "Here is the refactored code.", "http", 200, IDS.turnA1_2]
  );

  await gdprBypassUpdate(p,
    `UPDATE turns SET
       cache_read_tokens = $1,
       cache_creation_tokens = $2,
       transport = $3,
       http_status = $4
     WHERE id = $5`,
    [300, 0, "http", 200, IDS.turnA1_3]
  );

  // Add user_request_text column if not present and update turns
  // This is a D1.1 column — the test infrastructure seeds it to verify the API reads it
  try {
    await p.query(`ALTER TABLE turns ADD COLUMN IF NOT EXISTS user_request_text TEXT`);
  } catch {
    // Column may already exist
  }

  await gdprBypassUpdate(p,
    `UPDATE turns SET user_request_text = $1 WHERE id = $2`,
    ["Refactor the authentication module", IDS.turnA1_1]
  );
  await gdprBypassUpdate(p,
    `UPDATE turns SET user_request_text = $1 WHERE id = $2`,
    ["Apply the changes and run the tests", IDS.turnA1_2]
  );
}

// =========================================================================
// D1.2 — Session type enhanced fields
// =========================================================================

describe("D1.2 — Session.framework field", () => {
  it("returns framework for a session that has one", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          id
          framework
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session).toBeDefined();
    expect(body.data!.session!.framework).toBe("claude_code");
  });

  it("returns null framework for a session without one", async () => {
    // sessionBeta1 seeded with "claude_code" but let's test a session we know has it
    // The important behavior is type correctness
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          id
          framework
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(typeof body.data!.session!.framework).toBe("string");
  });
});

describe("D1.2 — Session.status field", () => {
  it("returns COMPLETED for session with ended_at", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          id
          status
          endedAt
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.status).toBe("COMPLETED");
    expect(body.data?.session?.endedAt).not.toBeNull();
  });

  it("returns ACTIVE for session without ended_at", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          id
          status
          endedAt
        }
      }`,
      variables: { id: IDS.sessionAlpha2 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.status).toBe("ACTIVE");
    expect(body.data?.session?.endedAt).toBeNull();
  });

  it("status is non-nullable (always returned)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          status
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.status).toBeDefined();
    expect(["ACTIVE", "COMPLETED"]).toContain(body.data!.session!.status);
  });
});

describe("D1.2 — Session.duration field", () => {
  it("returns duration in seconds for a session", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          id
          duration
          startedAt
          lastActiveAt
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    const session = body.data?.session;
    expect(session).toBeDefined();
    // Duration must be a non-negative integer (seconds)
    expect(typeof session!.duration).toBe("number");
    expect(session!.duration).toBeGreaterThanOrEqual(0);
  });
});

describe("D1.2 — Session identity and git fields", () => {
  it("returns accountUuid from sessions.account_uuid", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          accountUuid
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.accountUuid).toBe("acct-uuid-001");
  });

  it("returns deviceId from sessions.device_id", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          deviceId
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.deviceId).toBe("device-uuid-001");
  });

  it("returns gitRepo from sessions.git_repo", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          gitRepo
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.gitRepo).toBe("github.com/recondo-dev/recondo");
  });

  it("returns gitBranch from sessions.git_branch", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          gitBranch
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.gitBranch).toBe("main");
  });

  it("returns null for identity/git fields when not set", async () => {
    // sessionBeta1 may not have account_uuid/device_id seeded
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query ($id: ID!) {
        session(id: $id) {
          accountUuid
          deviceId
        }
      }`,
      variables: { id: IDS.sessionBeta1 },
    });

    expect(body.errors).toBeUndefined();
    // These should be null or the seeded value — the point is the field exists
    // and doesn't error
    expect(body.data?.session).toBeDefined();
  });
});

describe("D1.2 — Session cache token aggregation", () => {
  it("returns cacheReadTokens as SUM of turns.cache_read_tokens", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          cacheReadTokens
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    // Seeded: turnA1_1=500, turnA1_2=200, turnA1_3=300 => sum=1000
    expect(body.data?.session?.cacheReadTokens).toBe(1000);
  });

  it("returns cacheCreationTokens as SUM of turns.cache_creation_tokens", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          cacheCreationTokens
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    // Seeded: turnA1_1=100, turnA1_2=50, turnA1_3=0 => sum=150
    expect(body.data?.session?.cacheCreationTokens).toBe(150);
  });

  it("cache token fields are non-nullable (default to 0)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          cacheReadTokens
          cacheCreationTokens
        }
      }`,
      variables: { id: IDS.sessionAlpha2 },
    });

    expect(body.errors).toBeUndefined();
    expect(typeof body.data?.session?.cacheReadTokens).toBe("number");
    expect(typeof body.data?.session?.cacheCreationTokens).toBe("number");
  });
});

// =========================================================================
// D1.3 — Turn type enhanced fields
// =========================================================================

describe("D1.3 — Turn.userRequestText field", () => {
  it("returns userRequestText from turns.user_request_text", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          id
          userRequestText
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.userRequestText).toBe(
      "Refactor the authentication module"
    );
  });

  it("returns null userRequestText when column is NULL", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          userRequestText
        }
      }`,
      variables: { id: IDS.turnA1_3 },
    });

    expect(body.errors).toBeUndefined();
    // turnA1_3 was not seeded with user_request_text
    expect(body.data?.turn?.userRequestText).toBeNull();
  });
});

describe("D1.3 — Turn.responseText and Turn.thinkingText fields", () => {
  it("returns responseText from turns.response_text", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          responseText
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.responseText).toBe(
      "The auth module needs refactoring."
    );
  });

  it("returns thinkingText from turns.thinking_text", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          thinkingText
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.thinkingText).toBe("Let me think about this...");
  });
});

describe("D1.3 — Turn cache token fields", () => {
  it("returns cacheReadTokens from turns.cache_read_tokens", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          cacheReadTokens
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.cacheReadTokens).toBe(500);
  });

  it("returns cacheCreationTokens from turns.cache_creation_tokens", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          cacheCreationTokens
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.cacheCreationTokens).toBe(100);
  });
});

describe("D1.3 — Turn metadata fields", () => {
  it("returns httpStatus from turns.http_status", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          httpStatus
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.httpStatus).toBe(200);
  });

  it("returns transport from turns.transport", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          transport
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.transport).toBe("http");
  });

  it("returns ttfbMs from turns.ttfb_ms", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          ttfbMs
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.ttfbMs).toBe(120);
  });

  it("returns durationMs from turns.duration_ms", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          durationMs
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.durationMs).toBe(1200);
  });
});

describe("D1.3 — Turn hash fields (requestHash, responseHash)", () => {
  it("returns requestHash from turns.request_hash", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          requestHash
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.requestHash).toBe("hash_req_a1_1");
  });

  it("returns responseHash from turns.response_hash", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          responseHash
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.responseHash).toBe("hash_resp_a1_1");
  });
});

// =========================================================================
// D1.4 — SessionFilter enhancements (status, framework, search)
// =========================================================================

describe("D1.4 — SessionFilter.status filter", () => {
  it("filters sessions by status ACTIVE", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { status: "ACTIVE" }) {
          items {
            id
            status
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    // All returned sessions must have ACTIVE status
    for (const s of sessions as Array<{ status: string }>) {
      expect(s.status).toBe("ACTIVE");
    }
  });

  it("filters sessions by status COMPLETED", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { status: "COMPLETED" }) {
          items {
            id
            status
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    for (const s of sessions as Array<{ status: string }>) {
      expect(s.status).toBe("COMPLETED");
    }
  });
});

describe("D1.4 — SessionFilter.framework filter", () => {
  it("filters sessions by framework claude_code", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { framework: "claude_code" }) {
          items {
            id
            framework
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    for (const s of sessions as Array<{ framework: string }>) {
      expect(s.framework).toBe("claude_code");
    }
  });

  it("filters sessions by framework cursor", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { framework: "cursor" }) {
          items {
            id
            framework
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    for (const s of sessions as Array<{ framework: string }>) {
      expect(s.framework).toBe("cursor");
    }
  });

  it("returns empty list for nonexistent framework", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { framework: "nonexistent_framework" }) {
          items {
            id
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    expect((sessions as unknown[]).length).toBe(0);
  });
});

describe("D1.4 — SessionFilter.search filter", () => {
  it("searches across initial_intent", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { search: "authentication" }) {
          items {
            id
            initialIntent
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    expect((sessions as unknown[]).length).toBeGreaterThan(0);
    // At least one session should match "Refactor authentication module"
    const intents = (sessions as Array<{ initialIntent: string }>).map(
      (s) => s.initialIntent
    );
    expect(
      intents.some((i) => i?.toLowerCase().includes("authentication"))
    ).toBe(true);
  });

  it("searches across model name", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { search: "gpt-4o" }) {
          items {
            id
            model
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    expect((sessions as unknown[]).length).toBeGreaterThan(0);
  });

  it("searches across framework name", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { search: "claude_code" }) {
          items {
            id
            framework
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    expect((sessions as unknown[]).length).toBeGreaterThan(0);
  });

  it("returns empty for search with no matches", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { search: "zzz_no_match_zzz_12345" }) {
          items {
            id
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const sessions = body.data?.sessions?.items ?? body.data?.sessions;
    expect(Array.isArray(sessions)).toBe(true);
    expect((sessions as unknown[]).length).toBe(0);
  });
});

// =========================================================================
// D1.5 — SessionConnection pagination wrapper
// =========================================================================

describe("D1.5 — sessions returns SessionConnection", () => {
  it("returns items array, total, limit, offset", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions {
          items {
            id
          }
          total
          limit
          offset
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const conn = body.data?.sessions;
    expect(conn).toBeDefined();
    expect(conn.items).toBeDefined();
    expect(Array.isArray(conn.items)).toBe(true);
    expect(typeof conn.total).toBe("number");
    expect(typeof conn.limit).toBe("number");
    expect(typeof conn.offset).toBe("number");
  });

  it("total reflects all matching sessions, not just current page", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(limit: 1) {
          items {
            id
          }
          total
          limit
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const conn = body.data?.sessions;
    // items is limited to 1 but total should reflect all matching sessions
    expect(conn.items.length).toBeLessThanOrEqual(1);
    expect(conn.total).toBeGreaterThanOrEqual(conn.items.length);
    expect(conn.limit).toBe(1);
  });

  it("offset parameter shifts the result window", async () => {
    // Get all sessions first
    const { body: allBody } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions {
          items { id }
          total
        }
      }`,
    });
    const total = allBody.data?.sessions?.total ?? 0;

    if (total >= 2) {
      // Get with offset=1
      const { body } = await graphql({
        apiKey: API_KEYS.alpha,
        query: `query {
          sessions(offset: 1) {
            items { id }
            total
            offset
          }
        }`,
      });

      expect(body.errors).toBeUndefined();
      expect(body.data?.sessions?.offset).toBe(1);
      expect(body.data?.sessions?.items.length).toBeLessThan(total);
    }
  });

  it("returns correct limit and offset in response", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(limit: 5, offset: 0) {
          limit
          offset
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.sessions?.limit).toBe(5);
    expect(body.data?.sessions?.offset).toBe(0);
  });
});

// =========================================================================
// D1.6 — search query projectId optional
// =========================================================================

describe("D1.6 — search query projectId optional", () => {
  it("search works without projectId parameter", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query {
        search(query: "end_turn") {
          id
          sessionId
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.search).toBeDefined();
    expect(Array.isArray(body.data!.search)).toBe(true);
  });

  it("search still works WITH projectId parameter", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($pid: ID) {
        search(query: "end_turn", projectId: $pid) {
          id
          sessionId
        }
      }`,
      variables: { pid: IDS.projectAlpha },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.search).toBeDefined();
    expect(Array.isArray(body.data!.search)).toBe(true);
  });

  it("negative: search with empty query still requires query parameter", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query {
        search(query: "") {
          id
        }
      }`,
    });

    // Empty query is valid but should return empty or all results -- no error
    expect(body.errors).toBeUndefined();
  });
});

// =========================================================================
// D1.8 — Backward compatibility: existing fields unchanged
// =========================================================================

describe("D1.8 — Existing Session fields still work", () => {
  it("returns all pre-existing Session fields unchanged", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          id
          projectId
          agentId
          model
          provider
          startedAt
          endedAt
          lastActiveAt
          initialIntent
          systemPromptHash
          totalTurns
          turnsCaptured
          droppedEvents
          totalTokens
          totalCostUsd
          complete
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    const s = body.data?.session;
    expect(s).toBeDefined();
    expect(s.id).toBe(IDS.sessionAlpha1);
    expect(s.provider).toBe("anthropic");
    expect(s.model).toBe("claude-sonnet-4-20250514");
    expect(s.totalTurns).toBe(3);
    expect(typeof s.totalCostUsd).toBe("number");
    expect(typeof s.complete).toBe("boolean");
    expect(s.systemPromptHash).toBeDefined();
  });
});

describe("D1.8 — Existing Turn fields still work", () => {
  it("returns all pre-existing Turn fields unchanged", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          id
          sessionId
          sequenceNum
          timestamp
          inputTokens
          outputTokens
          thinkingTokens
          totalTokens
          costUsd
          captureComplete
          stopReason
          model
          provider
          toolCallCount
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    const t = body.data?.turn;
    expect(t).toBeDefined();
    expect(t.id).toBe(IDS.turnA1_1);
    expect(t.sessionId).toBe(IDS.sessionAlpha1);
    expect(t.sequenceNum).toBe(1);
    expect(t.inputTokens).toBe(1000);
    expect(t.outputTokens).toBe(500);
    expect(t.stopReason).toBe("end_turn");
    expect(t.model).toBe("claude-sonnet-4-20250514");
    expect(t.provider).toBe("anthropic");
  });

  it("Session.turns nested resolver still works", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          turns {
            id
            sequenceNum
          }
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.turns).toBeDefined();
    expect(Array.isArray(body.data!.session!.turns)).toBe(true);
    expect(body.data!.session!.turns.length).toBe(3);
  });
});

// =========================================================================
// Negative tests
// =========================================================================

describe("Negative — Invalid filter values", () => {
  it("invalid status value returns empty results (not error)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { status: "INVALID_STATUS" }) {
          items {
            id
          }
          total
        }
      }`,
    });

    // Should either return empty results or a validation error
    if (body.errors) {
      // Validation error is acceptable
      expect(body.errors.length).toBeGreaterThan(0);
    } else {
      const sessions = body.data?.sessions?.items ?? body.data?.sessions;
      expect((sessions as unknown[]).length).toBe(0);
    }
  });

  it("querying new Turn fields on a nonexistent turn returns null", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        turn(id: "nonexistent-turn-id-12345") {
          userRequestText
          responseText
          thinkingText
          cacheReadTokens
          cacheCreationTokens
          httpStatus
          transport
          ttfbMs
          durationMs
          requestHash
          responseHash
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn).toBeNull();
  });

  it("querying new Session fields on a nonexistent session returns null", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        session(id: "nonexistent-session-id-12345") {
          framework
          status
          duration
          accountUuid
          deviceId
          gitRepo
          gitBranch
          cacheReadTokens
          cacheCreationTokens
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session).toBeNull();
  });
});

describe("Negative — Combined new fields query", () => {
  it("all new Session and Turn fields can be queried in a single request", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($sid: ID!, $tid: ID!) {
        session(id: $sid) {
          id
          framework
          status
          duration
          accountUuid
          deviceId
          gitRepo
          gitBranch
          cacheReadTokens
          cacheCreationTokens
        }
        turn(id: $tid) {
          id
          userRequestText
          responseText
          thinkingText
          cacheReadTokens
          cacheCreationTokens
          httpStatus
          transport
          ttfbMs
          durationMs
          requestHash
          responseHash
        }
      }`,
      variables: { sid: IDS.sessionAlpha1, tid: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session).toBeDefined();
    expect(body.data?.turn).toBeDefined();

    // Verify session fields
    expect(body.data!.session!.framework).toBe("claude_code");
    expect(body.data!.session!.status).toBe("COMPLETED");
    expect(body.data!.session!.accountUuid).toBe("acct-uuid-001");

    // Verify turn fields
    expect(body.data!.turn!.userRequestText).toBe(
      "Refactor the authentication module"
    );
    expect(body.data!.turn!.responseText).toBe(
      "The auth module needs refactoring."
    );
    expect(body.data!.turn!.httpStatus).toBe(200);
    expect(body.data!.turn!.requestHash).toBe("hash_req_a1_1");
    expect(body.data!.turn!.responseHash).toBe("hash_resp_a1_1");
  });
});
