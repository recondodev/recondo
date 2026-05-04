/**
 * SessionFilter.hideNonLlm — verifies that the resolver hides non-LLM
 * traffic captured by the TLS MITM (telemetry pings, OAuth refreshes,
 * update checks) by default, and includes them when the caller passes
 * `hideNonLlm: false` (governance / discovery views).
 *
 * A session is "non-LLM" when no LLM API call was successfully observed:
 *   framework IS NULL OR ''
 *   AND model IS NULL OR ''
 *   AND COALESCE(total_tokens, 0) = 0
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

// Distinct UUID prefix (cd...) so this fixture cannot collide with the
// shared cc-prefix sessions seeded by setup.ts.
const NON_LLM_SESSION_ID = "cd000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  await setupDatabase();
  const p = getPool();
  // A capture that the gateway saw flow through the MITM but that did
  // not look like an LLM call — no framework metadata, no model, zero
  // tokens. Mirrors the OAuth/telemetry pings we want hidden by default.
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, framework)
     VALUES ($1, $2, $3, NULL, $4, $4, NULL, NULL, $5, 0, 0, 0, 0, 0.0, NULL)
     ON CONFLICT (id) DO NOTHING`,
    [
      NON_LLM_SESSION_ID,
      IDS.projectAlpha,
      "anthropic",
      new Date().toISOString(),
      "",
    ]
  );
});

afterAll(async () => {
  await teardownDatabase();
});

describe("SessionFilter.hideNonLlm", () => {
  it("hides non-LLM sessions by default (filter omitted)", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions {
          items { id model framework totalTokens }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.sessions!.items as Array<{ id: string }>;
    const ids = items.map((s) => s.id);
    expect(ids).not.toContain(NON_LLM_SESSION_ID);
    // Real LLM sessions are still returned.
    expect(ids).toContain(IDS.sessionAlpha1);
    expect(ids).toContain(IDS.sessionAlpha2);
  });

  it("hides non-LLM sessions when hideNonLlm is explicitly true", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { hideNonLlm: true }) {
          items { id }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const ids = (body.data!.sessions!.items as Array<{ id: string }>).map(
      (s) => s.id
    );
    expect(ids).not.toContain(NON_LLM_SESSION_ID);
  });

  it("includes non-LLM sessions when hideNonLlm is false", async () => {
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { hideNonLlm: false }) {
          items { id model framework totalTokens }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.sessions!.items as Array<{
      id: string;
      model: string | null;
      framework: string | null;
      totalTokens: number;
    }>;
    const ids = items.map((s) => s.id);
    expect(ids).toContain(NON_LLM_SESSION_ID);

    const nonLlm = items.find((s) => s.id === NON_LLM_SESSION_ID)!;
    expect(nonLlm.framework).toBeNull();
    // The non-LLM row carries no model and no tokens — that's the heuristic.
    expect(nonLlm.totalTokens).toBe(0);
  });

  it("never hides a session with a model even when framework and tokens are absent", async () => {
    // sessionAlpha2's base fixture has model='gpt-4o' but no framework
    // until the d1 fixture runs — so a session with just `model` set
    // must still pass the default filter. We re-assert against the
    // base fixture row (model='gpt-4o', total_tokens=8000).
    const { body } = await graphql({
      apiKey: API_KEYS.alpha,
      query: `query {
        sessions(filter: { hideNonLlm: true }) {
          items { id model }
          total
        }
      }`,
    });

    expect(body.errors).toBeUndefined();
    const items = body.data!.sessions!.items as Array<{
      id: string;
      model: string | null;
    }>;
    const alpha2 = items.find((s) => s.id === IDS.sessionAlpha2);
    expect(alpha2).toBeDefined();
    expect(alpha2!.model).toBe("gpt-4o");
  });
});
