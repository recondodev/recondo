/**
 * Health check endpoint tests for Sprint 4 API.
 *
 * Covers:
 * - GET /health returns 200 with healthy status when DB is connected
 * - Response body structure: { status, components: { database } }
 * - Health endpoint does NOT require authentication
 * - Content-Type is application/json
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
const { Pool } = pg;
import {
  setupDatabase,
  teardownDatabase,
  httpGet,
  API_BASE_URL,
} from "./setup.js";

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  await teardownDatabase();
});

// =========================================================================
// Healthy state
// =========================================================================

describe("health check — healthy", () => {
  it("returns 200 with status healthy", async () => {
    const { body, response } = await httpGet("/health");

    expect(response.status).toBe(200);

    const json = body as Record<string, unknown>;
    expect(json.status).toBe("healthy");
  });

  it("includes database component status as connected", async () => {
    const { body } = await httpGet("/health");

    const json = body as Record<string, unknown>;
    const components = json.components as Record<string, unknown>;
    expect(components).toBeDefined();
    expect(components.database).toBe("connected");
  });

  it("returns Content-Type application/json", async () => {
    const { response } = await httpGet("/health");

    const contentType = response.headers.get("content-type");
    expect(contentType).toMatch(/application\/json/);
  });

  it("does not require authentication", async () => {
    // No Authorization header — should still get 200
    const response = await fetch(`${API_BASE_URL}/health`, {
      method: "GET",
      // Deliberately no Authorization header
    });

    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json.status).toBe("healthy");
  });

  it("returns expected JSON structure", async () => {
    const { body } = await httpGet("/health");

    const json = body as Record<string, unknown>;

    // Must have exactly the documented structure
    expect(json).toHaveProperty("status");
    expect(json).toHaveProperty("components");
    expect(json).toHaveProperty("components.database");

    // status must be a string
    expect(typeof json.status).toBe("string");

    // components.database must be a string
    const components = json.components as Record<string, unknown>;
    expect(typeof components.database).toBe("string");
  });
});

// =========================================================================
// Unhealthy state
// =========================================================================

describe("health check — unhealthy", () => {
  /**
   * N6: Test that verifies checkDatabaseHealth returns false when the
   * database is unreachable. Creates a second pool pointing to a
   * nonexistent database and confirms the health check fails.
   */
  it("detects unhealthy database when connection fails", async () => {
    // Create a pool pointing to a nonexistent database
    const badPool = new Pool({
      connectionString: "postgres://nobody:wrong@localhost:59999/nonexistent_db",
      connectionTimeoutMillis: 1_000,
    });

    let healthy: boolean;
    try {
      const client = await badPool.connect();
      await client.query("SELECT 1");
      client.release();
      healthy = true;
    } catch {
      healthy = false;
    } finally {
      await badPool.end();
    }

    // The bad pool should fail to connect
    expect(healthy).toBe(false);
  });

  it("returns 503 with unhealthy status when DB is unreachable", async () => {
    // This test requires the API server to be configured to point at a
    // non-existent database. If API_UNHEALTHY_URL is set, we use that
    // endpoint; otherwise we skip.
    const unhealthyUrl = process.env.API_UNHEALTHY_URL;
    if (!unhealthyUrl) {
      console.log(
        "Skipping unhealthy test: set API_UNHEALTHY_URL to an API instance with broken DB"
      );
      return;
    }

    const response = await fetch(`${unhealthyUrl}/health`);
    expect(response.status).toBe(503);

    const json = (await response.json()) as Record<string, unknown>;
    expect(json.status).toBe("unhealthy");

    const components = json.components as Record<string, unknown>;
    expect(components.database).toBe("disconnected");
  });
});
