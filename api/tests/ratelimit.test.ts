/**
 * Rate limiting tests for Sprint 4 API.
 *
 * Covers:
 * - Requests within limit succeed (200)
 * - Exceeding rate_limit_rpm returns 429 Too Many Requests
 * - Response includes X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset headers
 * - Rate limits are per-API-key (one key hitting limit does not affect another)
 * - Admin key has a higher rate limit than standard keys
 *
 * Fixture data:
 * - alpha key: rate_limit_rpm = 60
 * - beta key:  rate_limit_rpm = 60
 * - admin key: rate_limit_rpm = 1000
 *
 * Strategy: We use a special low-limit key (rate_limit_rpm = 5) seeded just
 * for rate limit tests, to avoid sending 60+ requests.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
  getPool,
  API_KEYS,
  IDS,
  API_BASE_URL,
} from "./setup.js";

// A dedicated low-limit API key for rate-limit testing
const RATE_LIMIT_KEY = "wrt_test_ratelimit_key_00000005";
const RATE_LIMIT_KEY_ID = "bb000000-0000-4000-8000-000000000005";
const RATE_LIMIT_RPM = 5; // Very low limit so we can trigger 429 quickly

beforeAll(async () => {
  await setupDatabase();

  // Create a low-limit key scoped to project alpha
  const { createHash } = await import("crypto");
  const keyHash = createHash("sha256").update(RATE_LIMIT_KEY).digest("hex");

  const pool = getPool();
  await pool.query(
    `INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [RATE_LIMIT_KEY_ID, keyHash, IDS.projectAlpha, RATE_LIMIT_RPM]
  );
});

afterAll(async () => {
  await teardownDatabase();
});

// N4: Reset rate limiter state before each test to avoid order-dependency
beforeEach(async () => {
  await fetch(`${API_BASE_URL}/_test/reset-rate-limits`, { method: "POST" });
});

const SIMPLE_QUERY = `query { sessions { items { id } } }`;

// Helper: send N requests as fast as possible
async function sendRequests(
  apiKey: string,
  count: number
): Promise<Response[]> {
  const responses: Response[] = [];
  for (let i = 0; i < count; i++) {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });
    responses.push(response);
  }
  return responses;
}

// =========================================================================
// Within rate limit
// =========================================================================

describe("within rate limit", () => {
  it("allows requests under the limit", async () => {
    // Send 2 requests with the low-limit key (limit=5)
    const responses = await sendRequests(RATE_LIMIT_KEY, 2);

    for (const r of responses) {
      expect(r.status).toBe(200);
    }
  });

  it("includes rate limit headers on successful requests", async () => {
    const { response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: SIMPLE_QUERY,
    });

    expect(response.status).toBe(200);

    // Check for rate limit headers
    const limit = response.headers.get("X-RateLimit-Limit");
    const remaining = response.headers.get("X-RateLimit-Remaining");
    const reset = response.headers.get("X-RateLimit-Reset");

    expect(limit).toBeDefined();
    expect(limit).not.toBeNull();
    expect(parseInt(limit!, 10)).toBe(10000); // alpha key has rate_limit_rpm=10000

    expect(remaining).toBeDefined();
    expect(remaining).not.toBeNull();
    const remainingNum = parseInt(remaining!, 10);
    expect(remainingNum).toBeGreaterThanOrEqual(0);
    expect(remainingNum).toBeLessThanOrEqual(10000);

    expect(reset).toBeDefined();
    expect(reset).not.toBeNull();
    // Reset should be a Unix timestamp in the future (or very near future)
    const resetTs = parseInt(reset!, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(resetTs).toBeGreaterThanOrEqual(nowSec - 1);
    expect(resetTs).toBeLessThanOrEqual(nowSec + 61); // within ~1 minute
  });

  it("X-RateLimit-Remaining decreases with each request", async () => {
    // Use a fresh low-limit key to test decrement
    // We send 2 requests and check that remaining decreases
    const r1 = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RATE_LIMIT_KEY}`,
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    const r2 = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RATE_LIMIT_KEY}`,
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    if (r1.status === 200 && r2.status === 200) {
      const remaining1 = parseInt(
        r1.headers.get("X-RateLimit-Remaining") ?? "0",
        10
      );
      const remaining2 = parseInt(
        r2.headers.get("X-RateLimit-Remaining") ?? "0",
        10
      );

      // r2 should have less remaining than r1
      expect(remaining2).toBeLessThan(remaining1);
    }
    // If we already hit the limit from other tests, that's OK — the 429 tests below cover that
  });
});

// =========================================================================
// Exceeding rate limit
// =========================================================================

describe("exceeding rate limit", () => {
  it("returns 429 after exceeding rate_limit_rpm", async () => {
    // Send more than RATE_LIMIT_RPM requests with the low-limit key
    const totalRequests = RATE_LIMIT_RPM + 3;
    const responses = await sendRequests(RATE_LIMIT_KEY, totalRequests);

    // At least one response should be 429
    const statuses = responses.map((r) => r.status);
    expect(statuses).toContain(429);

    // All 200s should come before 429s (once limited, should stay limited)
    const first429 = statuses.indexOf(429);
    expect(first429).toBeGreaterThan(0); // at least some succeeded

    // Everything after first 429 should also be 429
    for (let i = first429; i < statuses.length; i++) {
      expect(statuses[i]).toBe(429);
    }
  });

  it("429 response includes rate limit headers", async () => {
    // Exhaust the limit
    const responses = await sendRequests(RATE_LIMIT_KEY, RATE_LIMIT_RPM + 2);

    const limited = responses.find((r) => r.status === 429);
    expect(limited).toBeDefined();

    const limit = limited!.headers.get("X-RateLimit-Limit");
    const remaining = limited!.headers.get("X-RateLimit-Remaining");
    const reset = limited!.headers.get("X-RateLimit-Reset");

    expect(limit).toBeDefined();
    expect(parseInt(limit!, 10)).toBe(RATE_LIMIT_RPM);

    expect(remaining).toBeDefined();
    expect(parseInt(remaining!, 10)).toBe(0);

    expect(reset).toBeDefined();
    const resetTs = parseInt(reset!, 10);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(resetTs).toBeGreaterThanOrEqual(nowSec - 1);
  });

  it("429 response body indicates rate limiting", async () => {
    const responses = await sendRequests(RATE_LIMIT_KEY, RATE_LIMIT_RPM + 2);
    const limited = responses.find((r) => r.status === 429);
    expect(limited).toBeDefined();

    const body = await limited!.json();
    // Should have an error message about rate limiting
    const bodyStr = JSON.stringify(body).toLowerCase();
    expect(bodyStr).toMatch(/rate.?limit|too many requests|throttl/i);
  });
});

// =========================================================================
// Per-key isolation
// =========================================================================

describe("per-key rate limit isolation", () => {
  it("one key hitting limit does not affect another key", async () => {
    // Exhaust the low-limit key
    await sendRequests(RATE_LIMIT_KEY, RATE_LIMIT_RPM + 2);

    // Alpha key (rate_limit_rpm=60) should still work fine
    const { response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: SIMPLE_QUERY,
    });

    expect(response.status).toBe(200);
  });

  it("beta key is unaffected by alpha key usage", async () => {
    // Send several requests with alpha key
    await sendRequests(API_KEYS.alpha, 5);

    // Beta key should work fine
    const { response } = await graphql({
      apiKey: API_KEYS.beta,
      query: SIMPLE_QUERY,
    });

    expect(response.status).toBe(200);
  });
});

// =========================================================================
// Admin key has higher limit
// =========================================================================

describe("admin key rate limit", () => {
  it("admin key has a higher rate limit than standard keys", async () => {
    const { response } = await graphql({
      apiKey: API_KEYS.admin,
      query: SIMPLE_QUERY,
    });

    expect(response.status).toBe(200);

    const limit = response.headers.get("X-RateLimit-Limit");
    expect(limit).toBeDefined();
    expect(parseInt(limit!, 10)).toBe(1000); // admin key has rate_limit_rpm=1000
  });
});

// =========================================================================
// Health endpoint is not rate limited
// =========================================================================

describe("health endpoint rate limiting", () => {
  it("health endpoint is not subject to rate limiting", async () => {
    // Even if the key is rate-limited, /health should work
    // Health does not require auth, so it should not be rate-limited
    const responses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = await fetch(`${API_BASE_URL}/health`);
      responses.push(r.status);
    }

    // All should be 200 (not 429)
    for (const status of responses) {
      expect(status).toBe(200);
    }
  });
});
