import pg from "pg";
const { Pool } = pg;

// W11: In production mode, require DATABASE_URL to be set.
// Only fall back to test URL in development.
const DATABASE_URL = (() => {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL environment variable is required in production mode. " +
      "Set NODE_ENV to something other than 'production' for development defaults."
    );
  }
  return "postgres://recondo:recondo_dev@localhost:5432/recondo_test";
})();

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    // FIND-13-TS-2: tag the application_name with this process's
    // PID (or a caller-supplied env override) so test-suite
    // recovery code can terminate ONLY backends owned by THIS
    // process, not every `recondo-api*` backend on the same
    // PostgreSQL instance.
    //
    // Round 12 used a fixed `recondo-api` tag with a `LIKE
    // 'recondo-api%'` terminate query. In a CI matrix runner that
    // shares a single `recondo_test` database across parallel
    // jobs, that pattern killed sibling jobs' API server pools
    // (PG error 57P01 cascades through every active query).
    //
    // The PID is stable for the lifetime of this process and
    // unique among co-resident workers; the env-override allows
    // CI to inject a run UUID when PIDs are not unique across
    // matrix runners (e.g. containerised runners that always start
    // at PID 1).
    const appNameSuffix =
      process.env.RECONDO_API_APP_NAME_SUFFIX ?? String(process.pid);
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // The tag format is `recondo-api-<pid|run_uuid>`. The
      // `recondo-api-` prefix is stable so dashboards/diagnostics
      // can still match any API-server connection with
      // `application_name LIKE 'recondo-api-%'`; the suffix scopes
      // termination to a single owning process.
      application_name: `recondo-api-${appNameSuffix}`,
    });
    // W5 fix: Listen for unexpected errors on idle clients. Without this listener,
    // an idle client error would crash the process with an unhandled 'error' event.
    pool.on('error', (err) => {
      console.error('Unexpected idle client error:', err);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// W12: Health check timeout constant
const HEALTH_CHECK_TIMEOUT_MS = 3_000;

/**
 * Quick connectivity check for the health endpoint.
 * W12: Returns true if a simple query succeeds within 3 seconds.
 * Uses Promise.race to enforce the timeout.
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  // R2-B1: Capture timer ID and clear it to prevent dangling timers
  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const p = getPool();

    const healthQuery = (async () => {
      const client = await p.connect();
      try {
        await client.query("SELECT 1");
        return true;
      } finally {
        client.release();
      }
    })();

    const timeout = new Promise<boolean>((_, reject) => {
      timerId = setTimeout(() => reject(new Error("Health check timed out")), HEALTH_CHECK_TIMEOUT_MS);
    });

    const result = await Promise.race([healthQuery, timeout]);
    clearTimeout(timerId);
    return result;
  } catch {
    clearTimeout(timerId);
    return false;
  }
}
