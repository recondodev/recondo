/**
 * Authentication tests for Sprint 4 API.
 *
 * Covers:
 * - Valid API key authentication
 * - Invalid / missing / malformed API keys → 401
 * - Revoked API key → 401
 * - Project-scoped key isolation (alpha cannot see beta data)
 * - Admin key cross-project access
 * - Key prefix validation (must start with wrt_)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  setupDatabase,
  teardownDatabase,
  graphql,
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

// A simple query to test auth — returns minimal data
const SIMPLE_QUERY = `query { sessions { items { id } } }`;

// =========================================================================
// Valid authentication
// =========================================================================

describe("valid authentication", () => {
  it("accepts a valid project-scoped API key", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.alpha,
      query: SIMPLE_QUERY,
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();
    expect(body.data!.sessions).toBeDefined();
  });

  it("accepts a valid admin API key", async () => {
    const { body, response } = await graphql({
      apiKey: API_KEYS.admin,
      query: SIMPLE_QUERY,
    });

    expect(response.status).toBe(200);
    expect(body.errors).toBeUndefined();
    expect(body.data).toBeDefined();
  });
});

// =========================================================================
// Invalid authentication → 401
// =========================================================================

describe("invalid authentication", () => {
  it("rejects request with no Authorization header", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects request with empty Authorization header", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "",
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects request with invalid API key", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEYS.invalid}`,
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects request with Bearer prefix missing", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: API_KEYS.alpha, // missing "Bearer " prefix
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects request with malformed token (not wrt_ prefix)", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk_totally_wrong_format",
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects request with revoked API key", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEYS.revoked}`,
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    expect(response.status).toBe(401);
  });

  it("returns JSON error body on 401", async () => {
    const response = await fetch(`${API_BASE_URL}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEYS.invalid}`,
      },
      body: JSON.stringify({ query: SIMPLE_QUERY }),
    });

    expect(response.status).toBe(401);

    const body = await response.json();
    // Should contain an error message indicating unauthorized
    expect(body).toBeDefined();
    // Accept either { error: "..." } or { errors: [...] } or { message: "..." }
    const hasErrorField =
      body.error || body.errors || body.message;
    expect(hasErrorField).toBeTruthy();
  });
});

// =========================================================================
// Project scoping
// =========================================================================

describe("project scoping", () => {
  it("alpha key sees only alpha project sessions", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query { sessions { items { id projectId } } }`,
    });

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    for (const s of sessions) {
      expect(s.projectId).toBe(IDS.projectAlpha);
    }
    expect(sessions.length).toBe(2);
  });

  it("beta key sees only beta project sessions", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.beta,
      query: `query { sessions { items { id projectId } } }`,
    });

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    for (const s of sessions) {
      expect(s.projectId).toBe(IDS.projectBeta);
    }
    expect(sessions.length).toBe(1);
  });

  it("alpha key cannot read a specific beta session", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($id: ID!) { session(id: $id) { id } }`,
      variables: { id: IDS.sessionBeta1 },
    });

    expect(body.data!.session).toBeNull();
  });

  it("alpha key cannot read a turn belonging to beta project", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query($id: ID!) { turn(id: $id) { id } }`,
      variables: { id: IDS.turnB1_1 },
    });

    expect(body.data!.turn).toBeNull();
  });

  it("admin key can read sessions from any project", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query { sessions { items { id projectId } } }`,
    });

    const sessions = (body.data!.sessions as Record<string, unknown>).items as Array<Record<string, unknown>>;
    const projectIds = new Set(sessions.map((s) => s.projectId));
    expect(projectIds.size).toBeGreaterThanOrEqual(2);
    expect(projectIds).toContain(IDS.projectAlpha);
    expect(projectIds).toContain(IDS.projectBeta);
  });

  it("admin key can read a specific session from any project", async () => {
    // Admin reads beta session
    const { body: betaResult } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query($id: ID!) { session(id: $id) { id projectId } }`,
      variables: { id: IDS.sessionBeta1 },
    });
    expect(betaResult.data!.session).not.toBeNull();
    expect((betaResult.data!.session as Record<string, unknown>).projectId).toBe(
      IDS.projectBeta
    );

    // Admin reads alpha session
    const { body: alphaResult } = await graphql({
      apiKey: API_KEYS.admin,
      query: `query($id: ID!) { session(id: $id) { id projectId } }`,
      variables: { id: IDS.sessionAlpha1 },
    });
    expect(alphaResult.data!.session).not.toBeNull();
    expect(
      (alphaResult.data!.session as Record<string, unknown>).projectId
    ).toBe(IDS.projectAlpha);
  });
});
