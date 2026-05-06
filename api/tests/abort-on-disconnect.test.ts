/**
 * D-HT2: Verify that when an HTTP client disconnects mid-flight from
 * /v1/query, the AbortController in the route fires and the AbortSignal
 * passed into runStructuredQuery enters the aborted state.
 *
 * Strategy: spin up a fresh in-process Fastify instance, register the
 * real `queryRoutes`, and `vi.mock("@recondo/data")` so the route's
 * `handleQuery` -> `runStructuredQuery` chain calls our mock (which
 * captures the signal). The global-setup child API server is irrelevant
 * here — this test binds its own ephemeral port via `app.listen({port: 0})`.
 *
 * The first attempt at this test relied on `vi.mock("@recondo/data")`
 * applying to the API server, but the global setup spawns the server as
 * a child Node process — vi.mock cannot cross process boundaries. The
 * in-process Fastify approach loads the route in the same process as
 * the test, so the mock IS observed.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

// State captured from inside the mock factory. Use vi.hoisted so the
// references are valid even after vi.mock hoisting reorders module init.
const captured = vi.hoisted(() => ({
  signal: undefined as AbortSignal | undefined,
  resolveHeld: undefined as
    | ((value: { rows: unknown[]; totalCount: number }) => void)
    | undefined,
}));

// Mock the entire @recondo/data barrel. We need:
//   - runStructuredQuery: capture options.signal, hold the promise.
//   - authenticateRequest: short-circuit auth so the route reaches handleQuery.
//   - getPool: rest-helpers -> audit.ts -> getPool().query(...). Audit failures
//     are swallowed by audit.ts, but getPool() throws if the pool isn't
//     initialized — so we return a stub whose .query() resolves to nothing.
vi.mock("@recondo/data", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@recondo/data");
  const fakePool = {
    query: async () => ({ rows: [], rowCount: 0 }),
  };
  return {
    ...actual,
    getPool: vi.fn(() => fakePool),
    authenticateRequest: vi.fn(async () => ({
      id: "test-key-id",
      projectId: "p_test",
      rateLimitRpm: 100,
      isAdmin: false,
    })),
    runStructuredQuery: vi.fn(
      async (
        _queryType: string,
        _projectId: string,
        _filters: Record<string, unknown>,
        _groupBy: string | undefined,
        _limit: number,
        options: { signal?: AbortSignal } = {},
      ) => {
        captured.signal = options.signal;
        return new Promise<{ rows: unknown[]; totalCount: number }>(
          (resolve) => {
            captured.resolveHeld = resolve;
          },
        );
      },
    ),
  };
});

// Import AFTER vi.mock so the route binds against the mocked module.
const { queryRoutes } = await import("../src/routes/query.js");

describe("D-HT2: client disconnect aborts in-flight /v1/query (in-process)", () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    await queryRoutes(app);
    // Fastify v5: listen() returns a Promise<string> with the bound address.
    baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    // Release any held promise so the worker can exit.
    if (captured.resolveHeld) {
      captured.resolveHeld({ rows: [], totalCount: 0 });
      captured.resolveHeld = undefined;
    }
    await app.close();
  });

  it("AbortController fires when the HTTP client cancels the request", async () => {
    captured.signal = undefined;
    captured.resolveHeld = undefined;

    const clientCtrl = new AbortController();

    const fetchPromise = fetch(`${baseUrl}/v1/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrt_test_dummy",
      },
      body: JSON.stringify({
        queryType: "sessions",
        filters: {},
        limit: 10,
      }),
      signal: clientCtrl.signal,
    }).catch((err) => err); // capture abort rejection so assertion-flow proceeds

    // Wait for the server to dispatch the route, hit our mock,
    // and capture the signal. Polling is more robust than a fixed sleep.
    const captureDeadline = Date.now() + 2000;
    while (Date.now() < captureDeadline && captured.signal === undefined) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(captured.signal).toBeDefined();
    expect(captured.signal?.aborted).toBe(false);

    // Trigger client-side disconnect.
    clientCtrl.abort();

    // Server's reply.raw "close" handler should fire and abort the controller.
    const abortDeadline = Date.now() + 2000;
    while (
      Date.now() < abortDeadline &&
      captured.signal?.aborted !== true
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(captured.signal?.aborted).toBe(true);

    // Release the held query so the route handler unwinds cleanly.
    if (captured.resolveHeld) {
      captured.resolveHeld({ rows: [], totalCount: 0 });
      captured.resolveHeld = undefined;
    }
    await fetchPromise;
  }, 10_000);
});
