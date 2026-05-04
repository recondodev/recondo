/**
 * Sprint D2 Batch A -- Realtime queries behavioral tests.
 *
 * Tests for:
 *   D2.1 -- realtimeStats query (aggregated metrics)
 *   D2.2 -- realtimeFeed query (live traffic table)
 *   D2.3 -- gatewayStatus query (heartbeat-derived health)
 *
 * These tests are written BEFORE the implementation exists.
 * They assert only on externally observable behavior (GraphQL responses).
 * Every test must FAIL until the implementation is done.
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
  API_KEYS,
  IDS,
  getPool,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
  await seedD2Fixtures();
});

afterAll(async () => {
  await cleanupD2Fixtures();
  await teardownDatabase();
});

// ---------------------------------------------------------------------------
// D2 fixture seeding -- fresh data that exercises realtime queries
// ---------------------------------------------------------------------------

// IDs for D2-specific sessions and turns (prefix: d2)
const D2_IDS = {
  // Session that is "active" right now (no ended_at, last_active_at = recently)
  sessionRecentActive: "d2000000-0000-4000-8000-000000000001",
  // Session that ended 10 minutes ago (completed, still within 1 hour)
  sessionRecentCompleted: "d2000000-0000-4000-8000-000000000002",
  // Session that is old (ended 3 hours ago -- outside 1-hour window)
  sessionOld: "d2000000-0000-4000-8000-000000000003",

  // Turns within the last minute (for requestsPerMinute)
  turnRecent1: "d2dd0000-0000-4000-8000-000000000001",
  turnRecent2: "d2dd0000-0000-4000-8000-000000000002",
  // Turns within the last hour but NOT the last minute
  turnHourAgo1: "d2dd0000-0000-4000-8000-000000000003",
  turnHourAgo2: "d2dd0000-0000-4000-8000-000000000004",
  // Turn from a different provider (Google) for distinct provider counting
  turnGoogle: "d2dd0000-0000-4000-8000-000000000005",
  // Turn from outside 1-hour window
  turnOld: "d2dd0000-0000-4000-8000-000000000006",
} as const;

async function seedD2Fixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();
  const thirtySecondsAgo = new Date(now.getTime() - 30_000);
  const tenMinutesAgo = new Date(now.getTime() - 600_000);
  const thirtyMinutesAgo = new Date(now.getTime() - 1_800_000);
  const threeHoursAgo = new Date(now.getTime() - 10_800_000);
  const fourHoursAgo = new Date(now.getTime() - 14_400_000);
  const twoMinutesAgo = new Date(now.getTime() - 120_000);

  // Session 1: active right now (no ended_at, last_active_at = 30 seconds ago)
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [D2_IDS.sessionRecentActive, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
     tenMinutesAgo.toISOString(), thirtySecondsAgo.toISOString(), null,
     "Building a realtime dashboard", "d2hash1", 3, 3, 0, 5000, 0.15, "claude_code"]
  );

  // Session 2: completed 10 minutes ago (within 1 hour)
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [D2_IDS.sessionRecentCompleted, IDS.projectAlpha, "google", "gemini-2.0-flash",
     thirtyMinutesAgo.toISOString(), tenMinutesAgo.toISOString(), tenMinutesAgo.toISOString(),
     "Analyzing code quality metrics for the frontend application in production", "d2hash2",
     2, 2, 0, 3000, 0.08, "cursor"]
  );

  // Session 3: old (ended 3 hours ago, outside 1-hour window)
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [D2_IDS.sessionOld, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
     fourHoursAgo.toISOString(), threeHoursAgo.toISOString(), threeHoursAgo.toISOString(),
     "Old session for testing", "d2hash3", 1, 1, 0, 1000, 0.03, "claude_code"]
  );

  // Turn insert template
  const turnInsertSql = `INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       model, provider, input_tokens, output_tokens, thinking_tokens,
                       cost_usd, duration_ms, ttfb_ms, tool_call_count, stop_reason,
                       created_at, user_request_text, http_status, cache_read_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT (id) DO NOTHING`;

  // Turn 1: 30 seconds ago (within last minute) -- anthropic
  await p.query(turnInsertSql,
    [D2_IDS.turnRecent1, D2_IDS.sessionRecentActive, 1, thirtySecondsAgo.toISOString(),
     "d2_req_hash_1", "d2_resp_hash_1",
     "claude-sonnet-4-20250514", "anthropic", 1000, 500, 0,
     0.05, 800, 200, 0, "end_turn",
     thirtySecondsAgo.toISOString(), "Build the dashboard component", 200, 100]
  );

  // Turn 2: 30 seconds ago (within last minute) -- anthropic (same session)
  await p.query(turnInsertSql,
    [D2_IDS.turnRecent2, D2_IDS.sessionRecentActive, 2, thirtySecondsAgo.toISOString(),
     "d2_req_hash_2", "d2_resp_hash_2",
     "claude-sonnet-4-20250514", "anthropic", 800, 400, 0,
     0.04, 600, 150, 1, "end_turn",
     thirtySecondsAgo.toISOString(), "Add error handling to the API", 200, 50]
  );

  // Turn 3: 30 minutes ago (within last hour, outside last minute) -- anthropic
  await p.query(turnInsertSql,
    [D2_IDS.turnHourAgo1, D2_IDS.sessionRecentActive, 3, thirtyMinutesAgo.toISOString(),
     "d2_req_hash_3", "d2_resp_hash_3",
     "claude-sonnet-4-20250514", "anthropic", 2000, 1000, 0,
     0.10, 1200, 300, 0, "end_turn",
     thirtyMinutesAgo.toISOString(), "Set up the project structure", 200, 200]
  );

  // Turn 4: 10 minutes ago (within last hour) -- google/gemini
  await p.query(turnInsertSql,
    [D2_IDS.turnHourAgo2, D2_IDS.sessionRecentCompleted, 1, tenMinutesAgo.toISOString(),
     "d2_req_hash_4", "d2_resp_hash_4",
     "gemini-2.0-flash", "google", 1500, 800, 0,
     0.06, 400, 100, 0, "end_turn",
     tenMinutesAgo.toISOString(), "Analyze code quality", 200, 0]
  );

  // Turn 5: 10 minutes ago (within last hour) -- google/gemini (same session)
  await p.query(turnInsertSql,
    [D2_IDS.turnGoogle, D2_IDS.sessionRecentCompleted, 2, tenMinutesAgo.toISOString(),
     "d2_req_hash_5", "d2_resp_hash_5",
     "gemini-2.0-flash", "google", 700, 300, 0,
     0.02, 350, 80, 0, "end_turn",
     tenMinutesAgo.toISOString(), "Summarize findings", 200, 0]
  );

  // Turn 6: 3 hours ago (outside 1-hour window)
  await p.query(turnInsertSql,
    [D2_IDS.turnOld, D2_IDS.sessionOld, 1, threeHoursAgo.toISOString(),
     "d2_req_hash_6", "d2_resp_hash_6",
     "claude-sonnet-4-20250514", "anthropic", 1000, 500, 0,
     0.03, 900, 250, 0, "end_turn",
     threeHoursAgo.toISOString(), "Old turn outside window", 200, 0]
  );
}

async function cleanupD2Fixtures(): Promise<void> {
  const p = getPool();
  const d2TurnIds = Object.values(D2_IDS).filter(id => id.startsWith("d2dd"));
  const d2SessionIds = Object.values(D2_IDS).filter(id => id.startsWith("d200"));

  for (const id of d2TurnIds) {
    try { await p.query(`DELETE FROM turns WHERE id = $1`, [id]); } catch { /* immutable */ }
  }
  for (const id of d2SessionIds) {
    try { await p.query(`DELETE FROM sessions WHERE id = $1`, [id]); } catch { /* FK from turns */ }
  }
  await p.query(`DELETE FROM heartbeats`);
}

// =========================================================================
// D2.1 -- realtimeStats query
// =========================================================================

const REALTIME_STATS_QUERY = `query {
  realtimeStats {
    requestsPerMinute
    activeSessions
    activeProviderCount
    tokensLastHour
    cacheReadTokensLastHour
    costLastHour
    costProjectedToday
    latencyP50Ms
    latencyP99Ms
    latencySampleCount
    latencySource
  }
}`;

describe("D2.1 -- realtimeStats returns all 11 fields with correct types", () => {
  it("returns all required fields as non-null", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.realtimeStats).toBeDefined();

    const stats = body.data!.realtimeStats;

    // All non-nullable Int! / Float! fields must be present and typed correctly
    expect(typeof stats.requestsPerMinute).toBe("number");
    expect(typeof stats.activeSessions).toBe("number");
    expect(typeof stats.activeProviderCount).toBe("number");
    expect(typeof stats.tokensLastHour).toBe("number");
    expect(typeof stats.cacheReadTokensLastHour).toBe("number");
    expect(typeof stats.costLastHour).toBe("number");
    expect(typeof stats.costProjectedToday).toBe("number");
    expect(typeof stats.latencySampleCount).toBe("number");
    expect(typeof stats.latencySource).toBe("string");

    // Nullable Int fields -- may be null or number
    if (stats.latencyP50Ms !== null) {
      expect(typeof stats.latencyP50Ms).toBe("number");
    }
    if (stats.latencyP99Ms !== null) {
      expect(typeof stats.latencyP99Ms).toBe("number");
    }
  });
});

describe("D2.1 -- realtimeStats values are non-negative", () => {
  it("all numeric fields are >= 0", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    expect(stats.requestsPerMinute).toBeGreaterThanOrEqual(0);
    expect(stats.activeSessions).toBeGreaterThanOrEqual(0);
    expect(stats.activeProviderCount).toBeGreaterThanOrEqual(0);
    expect(stats.tokensLastHour).toBeGreaterThanOrEqual(0);
    expect(stats.cacheReadTokensLastHour).toBeGreaterThanOrEqual(0);
    expect(stats.costLastHour).toBeGreaterThanOrEqual(0);
    expect(stats.costProjectedToday).toBeGreaterThanOrEqual(0);
    expect(stats.latencySampleCount).toBeGreaterThanOrEqual(0);
    expect(["turn_duration_ms", "gateway_capture_histogram", "none"]).toContain(stats.latencySource);

    if (stats.latencyP50Ms !== null) {
      expect(stats.latencyP50Ms).toBeGreaterThanOrEqual(0);
    }
    if (stats.latencyP99Ms !== null) {
      expect(stats.latencyP99Ms).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("D2.1 -- realtimeStats requestsPerMinute counts recent turns", () => {
  it("counts turns with timestamp within the last minute", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // We seeded 2 turns within the last minute (turnRecent1, turnRecent2).
    // The base fixtures may also contribute turns within the last minute
    // depending on timing, but we know at least 2 are there.
    expect(stats.requestsPerMinute).toBeGreaterThanOrEqual(2);
  });
});

describe("D2.1 -- realtimeStats activeSessions counts non-ended recent sessions", () => {
  it("counts sessions with no ended_at and recent last_active_at", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // sessionRecentActive has no ended_at and last_active_at = 30 seconds ago.
    // Base fixtures: sessionAlpha2 and sessionBeta1 have no ended_at but
    // last_active_at = hourAgo (outside 5-minute window).
    // So at minimum 1 active session from D2 fixtures.
    expect(stats.activeSessions).toBeGreaterThanOrEqual(1);
  });
});

describe("D2.1 -- realtimeStats activeProviderCount counts distinct providers", () => {
  it("counts distinct providers from turns in the last hour", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // D2 fixtures have "anthropic" and "google" turns within the last hour.
    // Base fixtures also have anthropic and openai turns near the 1-hour boundary.
    // At minimum 2 distinct providers from D2 data.
    expect(stats.activeProviderCount).toBeGreaterThanOrEqual(2);
  });
});

describe("D2.1 -- realtimeStats tokensLastHour aggregates correctly", () => {
  it("sums input_tokens + output_tokens from the last hour", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // D2 turns within last hour:
    //   turnRecent1: 1000 + 500 = 1500
    //   turnRecent2: 800 + 400 = 1200
    //   turnHourAgo1: 2000 + 1000 = 3000
    //   turnHourAgo2: 1500 + 800 = 2300
    //   turnGoogle: 700 + 300 = 1000
    //   Total from D2: 9000
    // turnOld is outside the window. Base fixtures may contribute too.
    expect(stats.tokensLastHour).toBeGreaterThanOrEqual(9000);
  });
});

describe("D2.1 -- realtimeStats cacheReadTokensLastHour aggregates correctly", () => {
  it("sums cache_read_tokens from turns in the last hour", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // D2 turns within last hour cache_read_tokens:
    //   turnRecent1: 100, turnRecent2: 50, turnHourAgo1: 200
    //   turnHourAgo2: 0, turnGoogle: 0
    //   Total from D2: 350
    expect(stats.cacheReadTokensLastHour).toBeGreaterThanOrEqual(350);
  });
});

describe("D2.1 -- realtimeStats costLastHour aggregates correctly", () => {
  it("sums cost_usd from turns in the last hour", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // D2 turns within last hour cost_usd:
    //   turnRecent1: 0.05, turnRecent2: 0.04, turnHourAgo1: 0.10
    //   turnHourAgo2: 0.06, turnGoogle: 0.02
    //   Total from D2: 0.27
    expect(stats.costLastHour).toBeGreaterThanOrEqual(0.27);
  });
});

describe("D2.1 -- realtimeStats costProjectedToday = costLastHour * 24", () => {
  it("projects daily cost from hourly cost", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // costProjectedToday should be costLastHour * 24
    const expected = stats.costLastHour * 24;
    // Allow small floating-point tolerance
    expect(stats.costProjectedToday).toBeCloseTo(expected, 2);
  });
});

describe("D2.1 -- realtimeStats latency percentiles", () => {
  it("returns latencyP50Ms <= latencyP99Ms when both are present", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // When both percentiles are computed, p50 must be <= p99
    if (stats.latencyP50Ms !== null && stats.latencyP99Ms !== null) {
      expect(stats.latencyP50Ms).toBeLessThanOrEqual(stats.latencyP99Ms);
    }
  });

  it("returns latency percentiles from duration_ms of recent turns", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_STATS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const stats = body.data!.realtimeStats;

    // We have turns with duration_ms values: 800, 600, 1200, 400, 350
    // At least one non-null percentile is expected when data exists
    if (stats.latencyP50Ms !== null) {
      expect(stats.latencyP50Ms).toBeGreaterThan(0);
    }
  });
});

describe("D2.1 -- realtimeStats requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: REALTIME_STATS_QUERY,
      // No apiKey
    });

    // Either a GraphQL error or an HTTP-level rejection
    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });

  it("rejects requests with invalid API key", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.invalid,
      query: REALTIME_STATS_QUERY,
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D2.2 -- realtimeFeed query
// =========================================================================

const REALTIME_FEED_QUERY = `query ($provider: String, $limit: Int, $since: DateTime) {
  realtimeFeed(provider: $provider, limit: $limit, since: $since) {
    timestamp
    provider
    model
    framework
    intent
    totalTokens
    costUsd
    httpStatus
    sessionId
  }
}`;

describe("D2.2 -- realtimeFeed returns array of FeedItem with correct fields", () => {
  it("returns an array with all expected fields", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.realtimeFeed).toBeDefined();
    expect(Array.isArray(body.data!.realtimeFeed)).toBe(true);

    // With seeded data, we should have results
    expect(body.data!.realtimeFeed.length).toBeGreaterThan(0);

    const item = body.data!.realtimeFeed[0];

    // Required fields
    expect(typeof item.timestamp).toBe("string");
    expect(typeof item.provider).toBe("string");
    expect(typeof item.totalTokens).toBe("number");
    expect(typeof item.costUsd).toBe("number");
    expect(typeof item.sessionId).toBe("string");

    // Nullable fields -- present but may be null
    expect("model" in item).toBe(true);
    expect("framework" in item).toBe(true);
    expect("intent" in item).toBe(true);
    expect("httpStatus" in item).toBe(true);
  });

  it("returns items ordered by timestamp DESC (most recent first)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    if (items.length >= 2) {
      for (let i = 1; i < items.length; i++) {
        const prev = new Date(items[i - 1].timestamp).getTime();
        const curr = new Date(items[i].timestamp).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    }
  });
});

describe("D2.2 -- realtimeFeed respects provider filter", () => {
  it("returns only turns from the specified provider", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { provider: "google" },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    // We seeded 2 google turns (turnHourAgo2, turnGoogle)
    expect(items.length).toBeGreaterThanOrEqual(1);

    // Every item must be from the google provider
    for (const item of items) {
      expect(item.provider).toBe("google");
    }
  });

  it("returns no anthropic turns when filtering for google", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { provider: "google" },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    for (const item of items) {
      expect(item.provider).not.toBe("anthropic");
    }
  });

  it("returns empty array for a provider with no turns", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { provider: "nonexistent-provider" },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.realtimeFeed).toEqual([]);
  });
});

describe("D2.2 -- realtimeFeed respects limit", () => {
  it("defaults to 20 items when limit is not specified", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
    });

    expect(body.errors).toBeUndefined();
    // With our fixtures we have fewer than 20 total turns, so this tests
    // that the query works without a limit. The max returned should not
    // exceed 20 by default.
    expect(body.data!.realtimeFeed.length).toBeLessThanOrEqual(20);
  });

  it("respects explicit limit of 2", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { limit: 2 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.realtimeFeed.length).toBeLessThanOrEqual(2);
  });

  it("caps limit at 100 even if a larger value is requested", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { limit: 500 },
    });

    expect(body.errors).toBeUndefined();
    // We cannot test exact capping with few rows, but the query must succeed
    // and not return more than 100
    expect(body.data!.realtimeFeed.length).toBeLessThanOrEqual(100);
  });

  it("returns 1 item when limit is 1", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { limit: 1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.realtimeFeed.length).toBe(1);
  });
});

describe("D2.2 -- realtimeFeed respects since filter", () => {
  it("returns only turns after the since timestamp", async () => {
    // Set since to 5 minutes ago -- should exclude turns older than that
    const fiveMinutesAgo = new Date(Date.now() - 300_000).toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { since: fiveMinutesAgo },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    // turnRecent1 and turnRecent2 (30 seconds ago) should be included.
    // turnHourAgo1, turnHourAgo2, turnGoogle (10-30 min ago) should be excluded.
    for (const item of items) {
      const itemTime = new Date(item.timestamp).getTime();
      const sinceTime = new Date(fiveMinutesAgo).getTime();
      expect(itemTime).toBeGreaterThan(sinceTime);
    }
  });

  it("returns empty array when since is in the future", async () => {
    const futureDate = new Date(Date.now() + 3_600_000).toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { since: futureDate },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.realtimeFeed).toEqual([]);
  });
});

describe("D2.2 -- realtimeFeed returns empty array when no matching data", () => {
  it("returns [] not null when no data matches", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { provider: "zzz-does-not-exist" },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.realtimeFeed).toBeDefined();
    expect(body.data!.realtimeFeed).not.toBeNull();
    expect(Array.isArray(body.data!.realtimeFeed)).toBe(true);
    expect(body.data!.realtimeFeed).toEqual([]);
  });
});

describe("D2.2 -- realtimeFeed intent field truncation", () => {
  it("truncates intent to 60 characters", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    for (const item of items) {
      if (item.intent !== null) {
        expect(item.intent.length).toBeLessThanOrEqual(60);
      }
    }
  });

  it("truncates long intent text", async () => {
    // sessionRecentCompleted has initial_intent =
    // "Analyzing code quality metrics for the frontend application in production"
    // which is 75 chars, should be truncated to 60
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { provider: "google" },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    for (const item of items) {
      if (item.intent !== null) {
        expect(item.intent.length).toBeLessThanOrEqual(60);
      }
    }
  });
});

describe("D2.2 -- realtimeFeed framework field from session", () => {
  it("includes framework from the associated session", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { provider: "anthropic", limit: 5 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    // D2 anthropic turns belong to sessionRecentActive which has framework="claude_code"
    const d2Items = items.filter(
      (i: { sessionId: string }) => i.sessionId === D2_IDS.sessionRecentActive
    );

    for (const item of d2Items) {
      expect(item.framework).toBe("claude_code");
    }
  });
});

describe("D2.2 -- realtimeFeed combined filters", () => {
  it("applies provider and since together", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 300_000).toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { provider: "anthropic", since: fiveMinutesAgo },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    for (const item of items) {
      expect(item.provider).toBe("anthropic");
      const itemTime = new Date(item.timestamp).getTime();
      expect(itemTime).toBeGreaterThan(new Date(fiveMinutesAgo).getTime());
    }
  });

  it("applies provider, since, and limit together", async () => {
    const oneHourAgo = new Date(Date.now() - 3_600_000).toISOString();

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: REALTIME_FEED_QUERY,
      variables: { provider: "anthropic", since: oneHourAgo, limit: 1 },
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed;

    expect(items.length).toBeLessThanOrEqual(1);
    for (const item of items) {
      expect(item.provider).toBe("anthropic");
    }
  });
});

describe("D2.2 -- realtimeFeed requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: REALTIME_FEED_QUERY,
      // No apiKey
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D2.3 -- gatewayStatus query
// =========================================================================

const GATEWAY_STATUS_QUERY = `query {
  gatewayStatus {
    status
    uptimeSeconds
    lastHeartbeat
  }
}`;

describe("D2.3 -- gatewayStatus returns live from recent turn activity when no heartbeats", () => {
  it("returns live when recent turns exist but heartbeats are absent", async () => {
    // D2 fixtures include turns from 30 seconds ago. The resolver uses turn activity
    // as a fallback liveness signal — if the gateway is processing turns, it's running,
    // regardless of whether heartbeats have been emitted (heartbeats are only sent during
    // idle periods or at a fixed interval that may lag behind active traffic).
    const p = getPool();
    await p.query(`DELETE FROM heartbeats`);

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GATEWAY_STATUS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.gatewayStatus).toBeDefined();

    const status = body.data!.gatewayStatus;
    expect(status.status).toBe("live");
    // uptimeSeconds is null when derived from turns (only computed from heartbeats)
    expect(status.uptimeSeconds).toBeNull();
    // lastHeartbeat is set to the most recent turn timestamp as the activity proxy
    expect(status.lastHeartbeat).not.toBeNull();
  });
});

describe("D2.3 -- gatewayStatus returns live when recent heartbeat exists", () => {
  it("returns status live when heartbeat is within the 3-minute grace window", async () => {
    const p = getPool();
    await p.query(`DELETE FROM heartbeats`);

    // Insert a heartbeat from 2 minutes ago. This is older than the default
    // 60-second operator interval but still within the API grace window.
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    await p.query(
      `INSERT INTO heartbeats (timestamp, gateway_id, status) VALUES ($1, $2, $3)`,
      [twoMinutesAgo.toISOString(), "gateway-1", "ok"]
    );

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GATEWAY_STATUS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const status = body.data!.gatewayStatus;

    expect(status.status).toBe("live");
    expect(status.lastHeartbeat).not.toBeNull();
  });
});

describe("D2.3 -- gatewayStatus returns offline when heartbeat is stale", () => {
  it("returns status offline when most recent heartbeat is older than the 3-minute grace window", async () => {
    const p = getPool();
    await p.query(`DELETE FROM heartbeats`);

    // Insert a heartbeat from 4 minutes ago (> 180 seconds)
    const fourMinutesAgo = new Date(Date.now() - 240_000);
    await p.query(
      `INSERT INTO heartbeats (timestamp, gateway_id, status) VALUES ($1, $2, $3)`,
      [fourMinutesAgo.toISOString(), "gateway-1", "ok"]
    );

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GATEWAY_STATUS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const status = body.data!.gatewayStatus;

    expect(status.status).toBe("offline");
    expect(status.lastHeartbeat).not.toBeNull();
  });
});

describe("D2.3 -- gatewayStatus uptimeSeconds computed correctly", () => {
  it("computes uptime from first heartbeat to now", async () => {
    const p = getPool();
    await p.query(`DELETE FROM heartbeats`);

    // Insert first heartbeat 5 minutes ago
    const fiveMinutesAgo = new Date(Date.now() - 300_000);
    await p.query(
      `INSERT INTO heartbeats (timestamp, gateway_id, status) VALUES ($1, $2, $3)`,
      [fiveMinutesAgo.toISOString(), "gateway-1", "ok"]
    );

    // Insert recent heartbeat (10 seconds ago) to keep status "live"
    const tenSecondsAgo = new Date(Date.now() - 10_000);
    await p.query(
      `INSERT INTO heartbeats (timestamp, gateway_id, status) VALUES ($1, $2, $3)`,
      [tenSecondsAgo.toISOString(), "gateway-1", "ok"]
    );

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GATEWAY_STATUS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const status = body.data!.gatewayStatus;

    expect(status.uptimeSeconds).not.toBeNull();
    expect(typeof status.uptimeSeconds).toBe("number");
    // Uptime should be approximately 300 seconds (5 minutes).
    // Allow 30-second tolerance for test execution time.
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(270);
    expect(status.uptimeSeconds).toBeLessThanOrEqual(360);
  });

  it("returns null uptimeSeconds when no heartbeats exist", async () => {
    const p = getPool();
    await p.query(`DELETE FROM heartbeats`);

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GATEWAY_STATUS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.gatewayStatus.uptimeSeconds).toBeNull();
  });
});

describe("D2.3 -- gatewayStatus lastHeartbeat field", () => {
  it("returns ISO timestamp of the most recent heartbeat", async () => {
    const p = getPool();
    await p.query(`DELETE FROM heartbeats`);

    const recent = new Date(Date.now() - 5_000);
    await p.query(
      `INSERT INTO heartbeats (timestamp, gateway_id, status) VALUES ($1, $2, $3)`,
      [recent.toISOString(), "gateway-1", "ok"]
    );

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GATEWAY_STATUS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    const status = body.data!.gatewayStatus;

    expect(status.lastHeartbeat).not.toBeNull();
    // Should be a parseable date string
    const parsed = new Date(status.lastHeartbeat);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

describe("D2.3 -- gatewayStatus uses most recent heartbeat for status", () => {
  it("old heartbeat does not override newer one for status", async () => {
    const p = getPool();
    await p.query(`DELETE FROM heartbeats`);

    // Insert old heartbeat (5 minutes ago -- would be "offline")
    const fiveMinAgo = new Date(Date.now() - 300_000);
    await p.query(
      `INSERT INTO heartbeats (timestamp, gateway_id, status) VALUES ($1, $2, $3)`,
      [fiveMinAgo.toISOString(), "gateway-1", "ok"]
    );

    // Insert recent heartbeat (5 seconds ago -- should make status "live")
    const fiveSecAgo = new Date(Date.now() - 5_000);
    await p.query(
      `INSERT INTO heartbeats (timestamp, gateway_id, status) VALUES ($1, $2, $3)`,
      [fiveSecAgo.toISOString(), "gateway-1", "ok"]
    );

    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: GATEWAY_STATUS_QUERY,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data!.gatewayStatus.status).toBe("live");
  });
});

describe("D2.3 -- gatewayStatus requires authentication", () => {
  it("rejects unauthenticated requests", async () => {
    const { body, response } = await graphql({
      query: GATEWAY_STATUS_QUERY,
      // No apiKey
    });

    const hasError =
      (body.errors && body.errors.length > 0) || response.status === 401;
    expect(hasError).toBe(true);
  });
});

// =========================================================================
// D2 -- Backward compatibility: existing queries still work
// =========================================================================

describe("D2 -- Existing queries still work after adding new ones", () => {
  it("sessions query still returns data", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query {
        sessions {
          items {
            id
            provider
            status
          }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.sessions).toBeDefined();
    expect(body.data!.sessions.items.length).toBeGreaterThan(0);
  });

  it("session query still works by ID", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        session(id: $id) {
          id
          provider
        }
      }`,
      variables: { id: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.session?.id).toBe(IDS.sessionAlpha1);
  });

  it("turn query still works by ID", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($id: ID!) {
        turn(id: $id) {
          id
          sessionId
        }
      }`,
      variables: { id: IDS.turnA1_1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.turn?.id).toBe(IDS.turnA1_1);
  });

  it("verifyIntegrity query still works", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($sessionId: ID!) {
        verifyIntegrity(sessionId: $sessionId) {
          sessionId
          totalTurns
          verified
        }
      }`,
      variables: { sessionId: IDS.sessionAlpha1 },
    });

    expect(body.errors).toBeUndefined();
    expect(body.data?.verifyIntegrity?.sessionId).toBe(IDS.sessionAlpha1);
  });

  it("search query still works", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query ($q: String!) {
        search(query: $q) {
          id
        }
      }`,
      variables: { q: "anthropic" },
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.search)).toBe(true);
  });

  it("anomalies query still works", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query {
        anomalies {
          id
          anomalyType
          severity
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    expect(Array.isArray(body.data?.anomalies)).toBe(true);
  });
});

// =========================================================================
// D2 -- Schema introspection: new types are queryable
// =========================================================================

describe("D2 -- Schema exposes new types via introspection", () => {
  it("RealtimeStats type exists in schema", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query {
        __type(name: "RealtimeStats") {
          name
          fields {
            name
            type {
              kind
              name
              ofType { kind name }
            }
          }
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const type = body.data?.__type;
    expect(type).not.toBeNull();
    expect(type?.name).toBe("RealtimeStats");

    const fieldNames = type?.fields?.map((f: { name: string }) => f.name) ?? [];
    expect(fieldNames).toContain("requestsPerMinute");
    expect(fieldNames).toContain("activeSessions");
    expect(fieldNames).toContain("activeProviderCount");
    expect(fieldNames).toContain("tokensLastHour");
    expect(fieldNames).toContain("cacheReadTokensLastHour");
    expect(fieldNames).toContain("costLastHour");
    expect(fieldNames).toContain("costProjectedToday");
    expect(fieldNames).toContain("latencyP50Ms");
    expect(fieldNames).toContain("latencyP99Ms");
    expect(fieldNames).toContain("latencySampleCount");
    expect(fieldNames).toContain("latencySource");
  });

  it("FeedItem type exists in schema", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query {
        __type(name: "FeedItem") {
          name
          fields {
            name
          }
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const type = body.data?.__type;
    expect(type).not.toBeNull();
    expect(type?.name).toBe("FeedItem");

    const fieldNames = type?.fields?.map((f: { name: string }) => f.name) ?? [];
    expect(fieldNames).toContain("timestamp");
    expect(fieldNames).toContain("provider");
    expect(fieldNames).toContain("model");
    expect(fieldNames).toContain("framework");
    expect(fieldNames).toContain("intent");
    expect(fieldNames).toContain("totalTokens");
    expect(fieldNames).toContain("costUsd");
    expect(fieldNames).toContain("httpStatus");
    expect(fieldNames).toContain("sessionId");
  });

  it("GatewayStatus type exists in schema", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query {
        __type(name: "GatewayStatus") {
          name
          fields {
            name
          }
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const type = body.data?.__type;
    expect(type).not.toBeNull();
    expect(type?.name).toBe("GatewayStatus");

    const fieldNames = type?.fields?.map((f: { name: string }) => f.name) ?? [];
    expect(fieldNames).toContain("status");
    expect(fieldNames).toContain("uptimeSeconds");
    expect(fieldNames).toContain("lastHeartbeat");
  });
});

// =========================================================================
// Phase 1 -- Logical user-turn grouping (preflight/title-gen/tool-loop)
// =========================================================================
//
// These tests exercise the realtimeFeed + realtimeStats + Session.userTurns
// grouping behavior introduced in Phase 1. The fixtures simulate the three
// noise sources users saw as separate rows in the live feed:
//   1. pure preflight (quota check — no tokens, no http_status)
//   2. haiku title-generation ({"title": "…"} response)
//   3. tool-use loop iterations (N wire turns with same user_request_text)
// A grouped realtimeFeed collapses 2+3 into a single logical turn and hides
// 1 entirely.

// IDs for Phase 1 grouping fixtures (prefix: p1 so cleanup is easy)
const P1_IDS = {
  sessionPreflightOnly: "p1000000-0000-4000-8000-000000000001",
  sessionGrouped: "p1000000-0000-4000-8000-000000000002",
  sessionTwoPrompts: "p1000000-0000-4000-8000-000000000003",

  turnQuotaProbe: "p1dd0000-0000-4000-8000-000000000001",
  turnTitleGenHaiku: "p1dd0000-0000-4000-8000-000000000002",
  turnOpusMain: "p1dd0000-0000-4000-8000-000000000003",
  turnToolCall1: "p1dd0000-0000-4000-8000-000000000004",
  turnToolCall2: "p1dd0000-0000-4000-8000-000000000005",
  turnFirstPrompt: "p1dd0000-0000-4000-8000-000000000006",
  turnSecondPrompt: "p1dd0000-0000-4000-8000-000000000007",
} as const;

async function seedP1Fixtures(): Promise<void> {
  const p = getPool();
  const now = new Date();
  // Spread the fixtures across the last ~30 seconds so they land inside
  // both the 1-minute (requestsPerMinute / userTurnsPerMinute) and 1-hour
  // (tokens / cost / latency) windows used by realtimeStats. Leave a
  // ~5-second tail before "now" so the test isn't racing a just-crossed
  // second boundary while the tests run.
  const t0 = new Date(now.getTime() - 35_000);
  const t1 = new Date(now.getTime() - 30_000);
  const t2 = new Date(now.getTime() - 25_000);
  const t3 = new Date(now.getTime() - 20_000);
  const t4 = new Date(now.getTime() - 15_000);
  const t5 = new Date(now.getTime() - 12_000);
  const t6 = new Date(now.getTime() - 9_000);

  // Session with a lone quota probe — no real LLM work. Should be fully
  // hidden from realtimeFeed and excluded from activeSessions.
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at,
                           last_active_at, ended_at, initial_intent,
                           system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [P1_IDS.sessionPreflightOnly, IDS.projectAlpha, "anthropic", null,
     t0.toISOString(), t0.toISOString(), null,
     null, "p1hash1", 1, 1, 0, 0, 0, "claude_code"]
  );

  // Session that exercises the full grouping flow: quota preflight + haiku
  // title-gen + opus real turn + two tool-result continuations (same
  // user_request_text). Expect realtimeFeed to return one row with
  // subCallCount = 4 (the preflight row drops out but the other four —
  // haiku, opus, two continuations — all share the same user_request_text
  // and collapse into one logical turn; the preflight is its own group).
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at,
                           last_active_at, ended_at, initial_intent,
                           system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [P1_IDS.sessionGrouped, IDS.projectAlpha, "anthropic", "claude-opus-4-7",
     t1.toISOString(), t5.toISOString(), null,
     "Debug flaky tests", "p1hash2", 4, 4, 0, 800, 0.05, "claude_code"]
  );

  // Session with two distinct user prompts. Grouping should produce two
  // separate UserTurns.
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at,
                           last_active_at, ended_at, initial_intent,
                           system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [P1_IDS.sessionTwoPrompts, IDS.projectAlpha, "anthropic", "claude-opus-4-7",
     t2.toISOString(), t6.toISOString(), null,
     "First ask", "p1hash3", 2, 2, 0, 500, 0.03, "claude_code"]
  );

  // Turn insert template — full column set so we can control every field
  // the grouping logic inspects.
  const turnInsertSql = `INSERT INTO turns (id, session_id, sequence_num, timestamp,
                       request_hash, response_hash,
                       model, provider,
                       input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
                       cost_usd, duration_ms, tool_call_count, stop_reason,
                       created_at, user_request_text, response_text,
                       http_status, capture_complete)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     ON CONFLICT (id) DO NOTHING`;

  // Pure quota probe — http_status NULL, capture_complete false, tokens 0.
  // Matches the gateway's signature for an account-quota preflight that
  // never became a real LLM call.
  await p.query(turnInsertSql,
    [P1_IDS.turnQuotaProbe, P1_IDS.sessionPreflightOnly, 1, t0.toISOString(),
     "p1_req_quota", "p1_resp_quota",
     null, "anthropic",
     0, 0, 0, 0,
     null, null, 0, "",
     t0.toISOString(), "quota", null,
     null, false]
  );

  // Haiku title-gen turn. Response is the JSON title envelope. Same
  // user_request_text as the opus turn that follows so the two collapse.
  await p.query(turnInsertSql,
    [P1_IDS.turnTitleGenHaiku, P1_IDS.sessionGrouped, 1, t1.toISOString(),
     "p1_req_title", "p1_resp_title",
     "claude-haiku-4-5-20251001", "anthropic",
     150, 12, 0, 0,
     0.001, 300, 0, "end_turn",
     t1.toISOString(), "Debug flaky tests",
     '{"title": "Debug flaky integration tests"}',
     200, true]
  );

  // Opus main turn for the user prompt "Debug flaky tests".
  await p.query(turnInsertSql,
    [P1_IDS.turnOpusMain, P1_IDS.sessionGrouped, 2, t2.toISOString(),
     "p1_req_main", "p1_resp_main",
     "claude-opus-4-7", "anthropic",
     200, 300, 0, 0,
     0.03, 1200, 2, "tool_use",
     t2.toISOString(), "Debug flaky tests", "Thinking…",
     200, true]
  );

  // Two tool-result continuations — same user_request_text, so they
  // collapse into the same logical turn as the opus main.
  await p.query(turnInsertSql,
    [P1_IDS.turnToolCall1, P1_IDS.sessionGrouped, 3, t3.toISOString(),
     "p1_req_tc1", "p1_resp_tc1",
     "claude-opus-4-7", "anthropic",
     120, 80, 0, 0,
     0.008, 900, 1, "tool_use",
     t3.toISOString(), "Debug flaky tests", "Another tool call",
     200, true]
  );
  await p.query(turnInsertSql,
    [P1_IDS.turnToolCall2, P1_IDS.sessionGrouped, 4, t4.toISOString(),
     "p1_req_tc2", "p1_resp_tc2",
     "claude-opus-4-7", "anthropic",
     100, 60, 0, 0,
     0.006, 800, 0, "end_turn",
     t4.toISOString(), "Debug flaky tests", "Final answer",
     200, true]
  );

  // Two distinct prompts — should produce two logical turns in userTurns.
  await p.query(turnInsertSql,
    [P1_IDS.turnFirstPrompt, P1_IDS.sessionTwoPrompts, 1, t5.toISOString(),
     "p1_req_p1", "p1_resp_p1",
     "claude-opus-4-7", "anthropic",
     100, 50, 0, 0,
     0.005, 500, 0, "end_turn",
     t5.toISOString(), "First ask", "first response",
     200, true]
  );
  await p.query(turnInsertSql,
    [P1_IDS.turnSecondPrompt, P1_IDS.sessionTwoPrompts, 2, t6.toISOString(),
     "p1_req_p2", "p1_resp_p2",
     "claude-opus-4-7", "anthropic",
     150, 100, 0, 0,
     0.008, 600, 0, "end_turn",
     t6.toISOString(), "Second ask", "second response",
     200, true]
  );
}

async function cleanupP1Fixtures(): Promise<void> {
  const p = getPool();
  const turnIds = Object.values(P1_IDS).filter((id) => id.startsWith("p1dd"));
  const sessionIds = Object.values(P1_IDS).filter((id) => id.startsWith("p100"));
  for (const id of turnIds) {
    try { await p.query(`DELETE FROM turns WHERE id = $1`, [id]); } catch { /* immutable */ }
  }
  for (const id of sessionIds) {
    try { await p.query(`DELETE FROM sessions WHERE id = $1`, [id]); } catch { /* FK */ }
  }
}

describe("Phase 1 -- realtimeFeed groups wire turns into logical user turns", () => {
  beforeAll(async () => {
    await seedP1Fixtures();
  });
  afterAll(async () => {
    await cleanupP1Fixtures();
  });

  const FEED_Q = `query ($limit: Int) {
    realtimeFeed(limit: $limit) {
      sessionId
      intent
      model
      totalTokens
      costUsd
      subCallCount
      toolCallCount
      durationMs
      captureComplete
    }
  }`;

  it("hides pure-preflight quota rows from the feed entirely", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: FEED_Q,
      variables: { limit: 100 },
    });
    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed as Array<{ sessionId: string; intent: string | null }>;
    const preflightRows = items.filter((i) => i.sessionId === P1_IDS.sessionPreflightOnly);
    expect(preflightRows).toHaveLength(0);
    const quotaIntentRows = items.filter((i) => (i.intent ?? "") === "quota");
    expect(quotaIntentRows).toHaveLength(0);
  });

  it("collapses title-gen + tool-loop into one row with subCallCount=4", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: FEED_Q,
      variables: { limit: 100 },
    });
    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed as Array<{
      sessionId: string; intent: string | null; model: string | null;
      totalTokens: number; subCallCount: number; toolCallCount: number;
    }>;
    const grouped = items.filter((i) => i.sessionId === P1_IDS.sessionGrouped);
    expect(grouped).toHaveLength(1);
    const row = grouped[0];
    expect(row.subCallCount).toBe(4);
    expect(row.model).toContain("opus");
    expect(row.model).not.toContain("haiku");
    expect(row.totalTokens).toBe(150 + 12 + 200 + 300 + 120 + 80 + 100 + 60);
    expect(row.toolCallCount).toBe(3);
    expect(row.intent).toBe("Debug flaky tests");
  });

  it("returns two rows for a session with two distinct user prompts", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: FEED_Q,
      variables: { limit: 100 },
    });
    expect(body.errors).toBeUndefined();
    const items = body.data!.realtimeFeed as Array<{ sessionId: string; intent: string | null }>;
    const two = items.filter((i) => i.sessionId === P1_IDS.sessionTwoPrompts);
    expect(two.length).toBe(2);
    const intents = new Set(two.map((i) => i.intent));
    expect(intents.has("First ask")).toBe(true);
    expect(intents.has("Second ask")).toBe(true);
  });
});

describe("Phase 1 -- realtimeStats separates wire-level and logical counters", () => {
  beforeAll(async () => { await seedP1Fixtures(); });
  afterAll(async () => { await cleanupP1Fixtures(); });

  const STATS_Q = `query {
    realtimeStats {
      requestsPerMinute
      userTurnsPerMinute
      activeSessions
      activeProviderCount
    }
  }`;

  it("counts wire-level requestsPerMinute higher than userTurnsPerMinute for tool-loops", async () => {
    const { body } = await graphql({ apiKey: API_KEYS.admin, query: STATS_Q });
    expect(body.errors).toBeUndefined();
    const s = body.data!.realtimeStats as {
      requestsPerMinute: number; userTurnsPerMinute: number;
    };
    // Wire count sees every sub-call; logical count collapses them. With
    // the grouping-session fixture contributing 4 wire turns but 1 logical
    // turn, the wire count must strictly exceed the logical count across
    // the whole test DB (unless no grouping happens anywhere, which would
    // be a regression).
    expect(s.requestsPerMinute).toBeGreaterThan(s.userTurnsPerMinute);
  });

  it("does not count a preflight-only session as active", async () => {
    const { body } = await graphql({ apiKey: API_KEYS.admin, query: STATS_Q });
    expect(body.errors).toBeUndefined();
    const s = body.data!.realtimeStats as { activeSessions: number };
    // We can't assert the absolute number because other fixtures add
    // active sessions, but we can verify the preflight-only session is NOT
    // included by re-counting via a direct DB query. This check is
    // self-validating: if the preflight filter stops working, the count
    // will include sessionPreflightOnly and fail parity with the direct
    // query.
    const p = getPool();
    const { rows } = await p.query(
      `SELECT COUNT(*)::int AS c FROM sessions s
       WHERE s.ended_at IS NULL
         AND s.last_active_at::timestamptz > (NOW() - INTERVAL '5 minutes')::timestamptz
         AND EXISTS (
           SELECT 1 FROM turns t WHERE t.session_id = s.id
             AND NOT (t.http_status IS NULL AND t.capture_complete = false
                      AND (t.input_tokens + t.output_tokens) = 0)
         )`
    );
    expect(s.activeSessions).toBe(rows[0].c);
  });
});

describe("Phase 1 -- Session.userTurns and Session.title", () => {
  beforeAll(async () => { await seedP1Fixtures(); });
  afterAll(async () => { await cleanupP1Fixtures(); });

  const SESSION_DETAIL_Q = `query ($id: ID!) {
    session(id: $id) {
      id
      title
      userTurns {
        id
        groupIdx
        primaryModel
        subCallCount
        toolCallCount
        totalTokens
        userRequestText
        status
        turns { id }
      }
    }
  }`;

  it("exposes the derived title from the haiku title-gen turn", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: SESSION_DETAIL_Q,
      variables: { id: P1_IDS.sessionGrouped },
    });
    expect(body.errors).toBeUndefined();
    const session = body.data?.session as { title: string | null } | null;
    expect(session).not.toBeNull();
    expect(session!.title).toBe("Debug flaky integration tests");
  });

  it("returns null title for sessions without a title-gen turn", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: SESSION_DETAIL_Q,
      variables: { id: P1_IDS.sessionTwoPrompts },
    });
    expect(body.errors).toBeUndefined();
    const session = body.data?.session as { title: string | null } | null;
    expect(session).not.toBeNull();
    expect(session!.title).toBeNull();
  });

  it("groups title-gen + tool-loop into one UserTurn with four wire-level sub-calls", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: SESSION_DETAIL_Q,
      variables: { id: P1_IDS.sessionGrouped },
    });
    expect(body.errors).toBeUndefined();
    const userTurns = (body.data?.session?.userTurns ?? []) as Array<{
      subCallCount: number; primaryModel: string | null; userRequestText: string | null;
      turns: Array<{ id: string }>;
    }>;
    expect(userTurns.length).toBe(1);
    expect(userTurns[0].subCallCount).toBe(4);
    expect(userTurns[0].primaryModel).toContain("opus");
    expect(userTurns[0].userRequestText).toBe("Debug flaky tests");
    expect(userTurns[0].turns).toHaveLength(4);
  });

  it("returns two UserTurns for a session with two distinct prompts", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: SESSION_DETAIL_Q,
      variables: { id: P1_IDS.sessionTwoPrompts },
    });
    expect(body.errors).toBeUndefined();
    const userTurns = (body.data?.session?.userTurns ?? []) as Array<{
      groupIdx: number; userRequestText: string | null;
    }>;
    expect(userTurns.length).toBe(2);
    const requests = userTurns.map((u) => u.userRequestText);
    expect(requests).toContain("First ask");
    expect(requests).toContain("Second ask");
  });

  it("omits the preflight-only session's quota probe from userTurns", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: SESSION_DETAIL_Q,
      variables: { id: P1_IDS.sessionPreflightOnly },
    });
    expect(body.errors).toBeUndefined();
    const userTurns = (body.data?.session?.userTurns ?? []) as Array<unknown>;
    expect(userTurns.length).toBe(0);
  });
});
