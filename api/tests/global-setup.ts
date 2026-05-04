/**
 * Vitest global setup — starts the API server against recondo_test before
 * any test file runs, and tears it down when the suite finishes.
 *
 * This makes `npm test` fully self-contained: no need to manually start
 * `just api-dev` first.
 *
 * FIND-6-B hardening: migrations run ONCE here (before any worker
 * spawns), not per-file via `runMigrations()` inside
 * `setupDatabase()`. Per-file migrations previously:
 *   - held node-pg-migrate's advisory lock, serialising an already-
 *     serialised sequence (no speedup, just lock contention if
 *     something else probes the DB concurrently),
 *   - re-ran the full migration list 40+ times per `npm test`
 *     invocation (adds 10–20s to the suite),
 *   - made the run flaky on slow boxes where the advisory-lock
 *     timeout can elapse before the previous migrator releases.
 * Per-file `setupDatabase()` now just TRUNCATEs + re-seeds; the
 * schema itself is populated once.
 */

import { execSync, spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(__dirname, "..");

// `TEST_DB_URL` defaults to a shared local recondo_test DB (legacy
// path: developer ran `just dev-infra`). When it is not set, `setup()`
// instead spawns an ephemeral postgres container via `testcontainers`
// and rebinds this binding to the container URL. Callers that read
// TEST_DB_URL after `setup()` returns get the right value either way.
//
// `let` (not `const`) so `setup()` can rebind. The original env value
// is captured into `TEST_DB_URL_FROM_ENV` so downstream logic can tell
// "developer ran `just dev-infra`" (env-driven) apart from
// "container fixture" (auto-spawned).
const TEST_DB_URL_FROM_ENV = process.env.TEST_DB_URL;
let TEST_DB_URL =
  TEST_DB_URL_FROM_ENV ??
  "postgres://recondo:recondo_dev@localhost:5432/recondo_test";

// Holder for the spawned container. Module-scoped so `teardown()` can
// stop it. `null` when the developer set TEST_DB_URL themselves.
let testPgContainer:
  | import("@testcontainers/postgresql").StartedPostgreSqlContainer
  | null = null;

// FIND-12-E: refuse to run if TEST_DB_URL doesn't look like a test
// DB. The setup() function below issues `pg_terminate_backend`
// against `current_database()` for any backend tagged
// `application_name LIKE 'recondo-api%'`. If someone exports
// TEST_DB_URL pointing at a production DB (typo, copy-pasted from
// a runbook, mistakenly-checked-in `.env`), that termination
// would evict the production API server's connection pool —
// exactly the foot-gun the harness should make impossible.
//
// The check is cheap and the rule simple: the database name
// segment of the URL MUST contain `_test`. If it does not, fail
// loudly with the offending URL so the operator can correct it.
//
// We extract the database name from the URL pathname. A URL
// like `postgres://u:p@h:5432/recondo_test` has pathname
// `/recondo_test`; we strip the leading slash and check for the
// `_test` suffix (or `_test` followed by a `?param` query
// segment, e.g. `?sslmode=require`).
function assertTestDbUrl(url: string): void {
  let dbName = "";
  try {
    // node:URL accepts `postgres://...`. The pathname is the
    // path part minus the leading `/`.
    const parsed = new URL(url);
    dbName = parsed.pathname.replace(/^\//, "");
  } catch {
    // Fallback: split on the last '/' and strip query params.
    // We never want to throw a parse error here — that would
    // mask the real misconfig with a nonsense message.
    const tail = url.split("/").pop() ?? "";
    dbName = tail.split("?")[0];
  }
  // Strip any trailing query string fragment that survived the
  // pathname extraction (e.g. `?sslmode=require`).
  dbName = dbName.split("?")[0];

  // FIND-13-TS-1: explicit allow-list, not regex. The Round 12
  // pattern `/_test(\b|_)/` admitted `recondo_test_prod` because
  // the alternation `_` ate the underscore between `test` and
  // `prod`, leaving the rest of the name to match outside the
  // capture. Allow-list is unambiguous and trivially auditable.
  //
  // To add a new test DB, extend this set. `postgres` is allowed
  // because the testcontainers-spawned DB defaults to that name and
  // the container is private to this test process — there is no
  // production-DB foot-gun to guard against.
  const ALLOWED_TEST_DBS = new Set([
    "recondo_test",
    "recondo_test_empty",
    "postgres",
  ]);
  if (!ALLOWED_TEST_DBS.has(dbName)) {
    throw new Error(
      `[global-setup] TEST_DB_URL must point at one of ${[...ALLOWED_TEST_DBS].join(", ")}; ` +
        `refusing to operate on "${dbName}" (full URL: ${url}). ` +
        `This guard exists because setup() runs pg_terminate_backend against current_database().`,
    );
  }
}
assertTestDbUrl(TEST_DB_URL);

const API_BASE_URL =
  process.env.API_BASE_URL ?? "http://localhost:4000";

const PORT = new URL(API_BASE_URL).port || "4000";

let serverProcess: ChildProcess | null = null;

// FIND-14-TS-4: the long-lived `pg.Client` that holds the
// cross-runner advisory locks for the duration of this test run.
// `setup()` acquires; `teardown()` releases by closing the session.
// Typed via dynamic import so we don't add a top-level `pg` import
// (which would trigger eager module-level connection setup before
// the env-var sanity checks above run).
let testRunnerLockClient: import("pg").Client | null = null;

// FIND-11-B: install process-level handlers BEFORE the server is
// spawned (and crucially, before any `await` in `setup()`) so an
// interrupted vitest run cannot leak the API server process.
// Without these, SIGINT/OOM/timeout would skip the `teardown()`
// callback, leaving the spawned API server alive — it kept
// `node-pg-migrate`'s advisory lock and pinned the connection to
// `recondo_test`, so the next `npm test` invocation crashed with
// "Another migration is already running."
//
// Module-scope `serverProcess` plus a `killServer()` closure means
// every signal path observes the latest spawned PID. SIGKILL (not
// SIGTERM) — we don't trust the orphan to handle a graceful
// shutdown when the parent is going down hard.
function killServer(): void {
  const proc = serverProcess;
  if (proc && !proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // Process may already be dead; nothing to do.
    }
  }
  // FIND-14-TS-4: also release the cross-runner lock client on any
  // signal-driven shutdown. We can't `await` here (signal handlers
  // are sync), so we fire-and-forget the .end() promise; PG will
  // close the session at the OS level once the process exits even
  // if .end() doesn't resolve in time.
  const lc = testRunnerLockClient;
  if (lc) {
    testRunnerLockClient = null;
    try {
      void lc.end().catch(() => {});
    } catch {
      // Client may already be closed.
    }
  }
}

let signalsRegistered = false;
function registerSignalHandlers(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;
  // `exit` fires for normal termination (vitest finished cleanly).
  // `teardown()` should have nulled `serverProcess` already; this is
  // a belt-and-braces guard for any path that bypassed it.
  process.on("exit", killServer);
  // SIGINT (Ctrl-C) and SIGTERM (kill from CI runner). Re-throw the
  // signal exit code via process.exit so the runner observes the
  // expected status.
  process.on("SIGINT", () => {
    killServer();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    killServer();
    process.exit(143);
  });
  // uncaughtException / unhandledRejection: vitest may surface a
  // setup error here; kill the server before re-throwing so the
  // process exits cleanly and the next run is not blocked.
  process.on("uncaughtException", (err) => {
    killServer();
    throw err;
  });
  process.on("unhandledRejection", (reason) => {
    killServer();
    throw reason;
  });
}

/**
 * FIND-12-F: poll pg_locks for advisory-lock release after a
 * pg_terminate_backend call.
 *
 * `node-pg-migrate` acquires an advisory lock for the duration of
 * its run; if the lock is held by a backend we just terminated,
 * the kernel may not have closed the socket yet, so the lock entry
 * lingers in pg_locks for a short window. The previous fixed
 * 500ms sleep was a guess — on a slow CI box the lock might
 * survive past 500ms, on a fast box we burned 500ms for nothing.
 *
 * Strategy: poll pg_locks every 100ms, return as soon as no
 * advisory lock is held by another backend. Bounded at 3s — if
 * the lock somehow survives that long, we still proceed because
 * `npm run migrate up` will retry lock acquisition with its own
 * timeout (node-pg-migrate's default is ~5s) and surface a
 * clearer error if it ultimately fails.
 *
 * NOTE: we use `pg_locks` (not pg_advisory_lock probes) because
 * we don't want to acquire a lock ourselves and accidentally
 * block the migrator that runs immediately after.
 */
async function waitForAdvisoryLockRelease(
  client: import("pg").Client,
  maxMs = 3_000,
): Promise<void> {
  const start = Date.now();
  let lastCount = "?";
  while (Date.now() - start < maxMs) {
    const r = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM pg_locks
        WHERE locktype = 'advisory'
          AND pid <> pg_backend_pid()`,
    );
    lastCount = r.rows[0]?.count ?? "?";
    if (lastCount === "0") {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // FIND-13-TS-3: log the diagnostic so a stuck holder is visible
  // in the test output. We still proceed (do not throw) — the
  // subsequent `npm run migrate up` is idempotent and will retry
  // lock acquisition with node-pg-migrate's own timeout, surfacing
  // a clearer error there if the lock genuinely cannot be
  // obtained. Round 12 returned silently here, which left
  // operators staring at a downstream "Another migration is
  // already running" with no clue that we had already polled
  // pg_locks for 3s and timed out.
  console.warn(
    `[global-setup] waitForAdvisoryLockRelease: ${lastCount} advisory locks still held after ${maxMs}ms; ` +
      `proceeding with migrate-up retry`,
  );
}

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE_URL}/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `API server did not become healthy at ${API_BASE_URL} within ${timeoutMs}ms`
  );
}

export async function setup(): Promise<void> {
  // FIND-11-B: register signal handlers FIRST so any failure between
  // here and the end of `setup()` still triggers `killServer()` for
  // a future spawn. (`serverProcess` is null at this point, so the
  // handler is a no-op until `spawn()` populates it.)
  registerSignalHandlers();

  // Spawn an ephemeral postgres container via testcontainers when
  // the developer did NOT set `TEST_DB_URL`. This removes the
  // `just dev-infra` prerequisite for `npm test`. The container
  // lives until `teardown()` stops it; vitest workers pick up the
  // new URL because we set `process.env.TEST_DB_URL` BEFORE they
  // spawn.
  if (TEST_DB_URL_FROM_ENV === undefined) {
    const { PostgreSqlContainer } = await import(
      "@testcontainers/postgresql"
    );
    testPgContainer = await new PostgreSqlContainer("postgres:18.3-alpine")
      .start();
    TEST_DB_URL = testPgContainer.getConnectionUri();
    process.env.TEST_DB_URL = TEST_DB_URL;
  }

  // FIND-11-B: terminate orphan API-server backends from a prior
  // interrupted vitest run BEFORE we attempt migrations. At this
  // point in `setup()` we have not yet spawned our own API server,
  // so any connection tagged `application_name = 'recondo-api'`
  // against `recondo_test` is necessarily a leftover from a prior
  // run that was killed before its `teardown()` could fire. Those
  // backends hold node-pg-migrate's advisory lock and would block
  // `npm run migrate up` below with "Another migration is already
  // running."
  //
  // We connect via a one-shot `pg.Client` rather than the test
  // helper pool because (a) `setup.ts` initialises its own pool
  // lazily on first `getPool()` call and (b) we want this query
  // to happen BEFORE any other DB I/O.
  // FIND-13-TS-2: each test run gets a unique application_name
  // suffix (caller-provided env, or this process's PID). The
  // suffix is propagated to the spawned API server via the
  // `RECONDO_API_APP_NAME_SUFFIX` env var (see api/src/db.ts).
  // We then terminate ONLY backends tagged with our own suffix,
  // so a parallel CI matrix runner sharing this PG instance is
  // not affected. Round 12 used `LIKE 'recondo-api%'` here, which
  // killed sibling jobs' connection pools and cascaded PG
  // 57P01 errors across the matrix.
  const APP_NAME_SUFFIX =
    process.env.RECONDO_API_APP_NAME_SUFFIX ?? String(process.pid);
  process.env.RECONDO_API_APP_NAME_SUFFIX = APP_NAME_SUFFIX;
  const APP_NAME = `recondo-api-${APP_NAME_SUFFIX}`;

  // FIND-14-TS-4: cross-runner mutex. Required when `npm test` and
  // `just test-pg` share a `recondo_test` DB — without serialization
  // the cleanup script could DROP+CREATE the DB mid-`npm test`. With
  // testcontainers, this process owns its own ephemeral PG; no peer
  // process is reachable, so the lock dance is skipped entirely.
  if (testPgContainer === null) {
  const adminUrlForLock = (() => {
    try {
      const u = new URL(TEST_DB_URL);
      u.pathname = "/recondo";
      u.searchParams.set("application_name", `recondo-test-runner-${APP_NAME_SUFFIX}`);
      return u.toString();
    } catch {
      return TEST_DB_URL.replace(/\/[^/]+(\?|$)/, "/recondo$1");
    }
  })();

  const { default: pg } = await import("pg");

  // FIND-15-TS-3 + FIND-15-TS-5: 3-attempt retry around the lock
  // client connect + advisory-lock acquire, with TCP keepalive
  // enabled on every attempt's client. A pg.Client that fails to
  // connect cannot be reused, so we construct a NEW client each
  // attempt. Logged per-attempt to stderr so partial failures show
  // up in CI logs.
  //
  // Keepalive (FIND-15-TS-5): without `keepAlive: true`, an idle
  // TCP socket can be silently dropped by an intermediate NAT /
  // firewall / laptop pause-resume without PG ever noticing. The
  // session stays open server-side but any future query hangs.
  // Keepalive probes (initial delay 30s) surface dead sockets
  // within roughly a minute end-to-end.
  let lockClient: import("pg").Client | null = null;
  let lastErr: unknown = null;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = new pg.Client({
      connectionString: adminUrlForLock,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    });
    try {
      await candidate.connect();
      // Acquire BOTH the cross-runner lock (excludes this code
      // from a peer `npm test`) AND the cleanup-script's lock
      // (excludes this code from concurrent `just test-pg`
      // cleanup runs). statement_timeout caps the wait so a
      // wedged peer cannot hang vitest startup forever.
      //
      // FIND-16-TS-1: 600s ceiling matches the cleanup script
      // (scripts/test-pg-cleanup.sh:210) and the justfile test-pg
      // recipe. The retry loop above is for transient connect
      // failures (network blips, PG restart) — NOT for waiting
      // through legitimate peer holds. A peer `just test-pg`
      // can legitimately hold `recondo-test-runner` for 200s+
      // during a real test run; a 60s per-attempt timeout × 3
      // attempts (= 180s) bails out on a healthy peer and
      // empirically reproduces as `attempt N/3 failed:
      // canceling statement due to statement timeout` followed
      // by an exit-137 vitest abort. A single 600s wait inside
      // pg_advisory_lock is the correct shape: one long
      // lock-wait per legitimate peer hold, with the retry loop
      // reserved for connect-time failures only.
      await candidate.query("SET statement_timeout = '600s'");
      await candidate.query(
        "SELECT pg_advisory_lock(hashtext('recondo-test-runner'))",
      );
      await candidate.query(
        "SELECT pg_advisory_lock(hashtext('recondo-test-pg-cleanup'))",
      );
      lockClient = candidate;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[global-setup] lock-client attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}\n`,
      );
      try {
        await candidate.end();
      } catch {
        /* swallow — already failed */
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  if (lockClient === null) {
    throw new Error(
      `[global-setup] failed to acquire cross-runner advisory lock after ${MAX_ATTEMPTS} attempts: ${
        lastErr instanceof Error ? lastErr.message : String(lastErr)
      }`,
    );
  }
  // Stash the lock client so teardown() can release it. We hold
  // it for the entire vitest run.
  testRunnerLockClient = lockClient;
  // Capture into a non-null const so the closure below doesn't
  // need to repeat the null check (TS narrows `lockClient` here
  // but the closure is evaluated lazily).
  const acquiredLockClient = lockClient;
  // Register a process-exit handler to close the lock client on
  // any exit path (SIGINT/SIGTERM/uncaught) — without this, an
  // interrupted run leaks the advisory lock until PG closes the
  // session (which depends on TCP keep-alive timing).
  process.on("exit", () => {
    try {
      acquiredLockClient.end().catch(() => {});
    } catch {
      /* swallow on shutdown */
    }
  });
  } // end `if (testPgContainer === null)` cross-runner lock block

  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString: TEST_DB_URL });
    await client.connect();
    try {
      // FIND-14-1: terminate ONLY backends matched by exact
      // application_name (parameterized — not LIKE prefix). This
      // is a best-effort cleanup of orphans from a prior run with
      // the same PID/suffix; it cannot evict orphans whose PID we
      // no longer know, but those orphans are harmless to a
      // sibling process and will be cleaned up when their owner
      // re-runs (or when they hit the connection-limit cap or the
      // explicit recondo-* eviction in scripts/test-pg-cleanup.sh).
      await client.query(
        `
        SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
         WHERE datname = current_database()
           AND application_name = $1
           AND pid <> pg_backend_pid()
      `,
        [APP_NAME],
      );
      // FIND-12-F: poll for the advisory lock to be released
      // rather than sleeping a fixed 500ms. The fixed sleep was
      // a guess; on a slow CI box the lock may not have been
      // released yet, and on a fast box we wasted 500ms. Poll
      // pg_locks instead, bounded at 3s — `npm run migrate up`
      // is itself idempotent (FIND-12-G), so even if the poll
      // times out the migration will retry the lock acquisition
      // with node-pg-migrate's own backoff.
      await waitForAdvisoryLockRelease(client);
    } finally {
      await client.end();
    }
  } catch (err) {
    // If the DB doesn't exist yet, that's fine — there's nothing
    // to evict. Anything else (auth failure, host down) will be
    // surfaced by the next migration attempt with a clearer error.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/does not exist|ECONNREFUSED|ENOTFOUND/i.test(msg)) {
      throw err;
    }
  }

  // FIND-6-B: run migrations ONCE here before any test worker spawns.
  // `execSync("npm run migrate up")` holds the node-pg-migrate
  // advisory lock for the duration of the call; doing it once at
  // global-setup time means there's no concurrent lock contention
  // between workers. Individual test files use `setupDatabase()`
  // (which now only TRUNCATEs + re-seeds — see setup.ts).
  //
  // FIND-7-H: capture stdout AND stderr separately on failure so
  // operators see the actual node-pg-migrate error (e.g. "syntax
  // error in migration 011"), not just "Command failed: npm run
  // migrate up". Prior `stdio: "pipe"` lumped both streams into
  // err.message which `execSync` ultimately discarded.
  //
  // FIND-12-G: this `npm run migrate up` runs UNCONDITIONALLY on
  // every setup() call regardless of whether the prior run
  // completed cleanly. node-pg-migrate is idempotent — already-
  // applied migrations are skipped via the `pgmigrations` table.
  // If a previous test run was interrupted mid-migration (e.g. by
  // a SASL auth retry, an OOM, or Ctrl-C), this re-run will
  // resume from the partially-applied state and complete the
  // remaining migrations. The pg_terminate_backend call above
  // first evicts any backend still holding the advisory lock.
  try {
    execSync("npm run migrate up", {
      cwd: API_DIR,
      env: { ...process.env, DATABASE_URL: TEST_DB_URL },
      // stdio[0]=stdin (ignored), stdio[1]=stdout (captured),
      // stdio[2]=stderr (captured). On non-zero exit, execSync
      // throws and exposes both streams via err.stdout / err.stderr.
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer;
      stderr?: Buffer;
    };
    const stdout = e.stdout?.toString() ?? "";
    const stderr = e.stderr?.toString() ?? "";
    const detail = e instanceof Error ? e.message : String(e);
    // Compose a single error message that includes BOTH streams so
    // the failure is actionable from a CI log alone — no need to
    // re-run with stdio: inherit to see what went wrong.
    throw new Error(
      `[global-setup] migrations failed against ${TEST_DB_URL}\n`
        + `${detail}\n`
        + (stdout.length > 0 ? `\n--- migrate stdout ---\n${stdout}` : "")
        + (stderr.length > 0 ? `\n--- migrate stderr ---\n${stderr}` : ""),
    );
  }

  serverProcess = spawn(
    "node",
    ["--import", "tsx/esm", "src/index.ts"],
    {
      cwd: API_DIR,
      env: {
        ...process.env,
        DATABASE_URL: TEST_DB_URL,
        NODE_ENV: "test",
        PORT,
      },
      stdio: "pipe",
    }
  );

  serverProcess.stderr?.on("data", (_buf: Buffer) => {
    // Suppress server logs during test run.
    // Uncomment for debugging: process.stderr.write(_buf);
  });
  serverProcess.stdout?.on("data", (_buf: Buffer) => {
    // Suppress server logs during test run.
    // Uncomment for debugging: process.stdout.write(_buf);
  });

  serverProcess.on("error", (err) => {
    console.error("[global-setup] Failed to start API server:", err);
  });

  await waitForServer();
}

export async function teardown(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 3_000);
      serverProcess!.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });
    serverProcess = null;
  }
  // FIND-14-TS-4: release the cross-runner advisory locks by
  // closing the lock-holder session. PG releases all session-level
  // advisory locks held by the session when it closes.
  if (testRunnerLockClient) {
    try {
      await testRunnerLockClient.end();
    } catch {
      /* swallow on shutdown */
    }
    testRunnerLockClient = null;
  }
  // Stop the ephemeral postgres container if we spawned one. No-op
  // when the developer set `TEST_DB_URL` themselves.
  if (testPgContainer) {
    try {
      await testPgContainer.stop();
    } catch {
      /* container may already be stopped */
    }
    testPgContainer = null;
  }
}
