/**
 * Shared test setup for Sprint 4 API behavioral tests.
 *
 * Responsibilities:
 * - Connect to test PostgreSQL database
 * - Create schema (sessions, turns, tool_calls, anomaly_events, api_keys,
 *   access_audit_log, projects)
 * - Seed realistic fixture data
 * - Provide helpers for HTTP requests and DB queries
 * - Clean up after tests
 *
 * Expects:
 * - PostgreSQL running at localhost:5432 (docker-compose.sprint4.yml)
 * - API server running at localhost:4000 (started by implementation)
 *
 * Environment variables (with defaults):
 *   TEST_DB_URL   = postgres://recondo:recondo_dev@localhost:5432/recondo_test
 *   API_BASE_URL  = http://localhost:4000
 *
 * B3 fix: Schema now matches the gateway's actual PostgreSQL schema
 * (pg_schema_ddl.rs) for sessions, turns, and tool_calls columns.
 * API-specific tables (projects, api_keys, access_audit_log, anomaly_events)
 * are kept as API-layer additions.
 */

import pg from "pg";
// FIND-7-A: removed `execSync`, `path`, `url` imports.
// `runMigrations()` was deleted (migrations now run once in
// global-setup.ts); per-file cleanup is data-only via
// `resetSchemaState`. No path/URL helpers needed in this file.

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const TEST_DB_URL =
  process.env.TEST_DB_URL ??
  "postgres://recondo:recondo_dev@localhost:5432/recondo_test";

export const API_BASE_URL =
  process.env.API_BASE_URL ?? "http://localhost:4000";

// ---------------------------------------------------------------------------
// Database pool (shared across all test files)
// ---------------------------------------------------------------------------

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    // FIND-14-TS-2: tag the test pool's application_name so operators
    // (and the cleanup script in scripts/test-pg-cleanup.sh, plus the
    // global-setup.ts orphan-eviction step) can identify connections
    // owned by THIS test process. Without a tag, these connections
    // appeared in pg_stat_activity as the deadpool default and were
    // indistinguishable from the API-server pool, so the orphan
    // eviction step couldn't tell them apart.
    //
    // The suffix matches `RECONDO_API_APP_NAME_SUFFIX` (set by
    // global-setup.ts before the API server is spawned) when running
    // under vitest, falling back to PID for ad-hoc invocations.
    const appNameSuffix =
      process.env.RECONDO_API_APP_NAME_SUFFIX ?? String(process.pid);
    pool = new Pool({
      connectionString: TEST_DB_URL,
      application_name: `recondo-test-pool-${appNameSuffix}`,
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

/**
 * Run an UPDATE on turns or tool_calls using the GDPR bypass.
 * These tables have immutability triggers (SOC 2 PI1) that block direct UPDATEs.
 * Test fixture setup must use this helper to update turn/tool_call fields.
 */
export async function gdprBypassUpdate(
  p: pg.Pool,
  sql: string,
  params?: unknown[]
): Promise<void> {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL recondo.gdpr_bypass = 'true'");
    await client.query(sql, params);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Fixed UUIDs for deterministic fixture data
// ---------------------------------------------------------------------------

export const IDS = {
  // Projects (prefix: aa)
  projectAlpha: "aa000000-0000-4000-8000-000000000001",
  projectBeta: "aa000000-0000-4000-8000-000000000002",

  // API keys (prefix: bb)
  keyAlpha: "bb000000-0000-4000-8000-000000000001",
  keyBeta: "bb000000-0000-4000-8000-000000000002",
  keyAdmin: "bb000000-0000-4000-8000-000000000003",

  // Sessions (prefix: cc) — 2 in alpha, 1 in beta
  sessionAlpha1: "cc000000-0000-4000-8000-000000000001",
  sessionAlpha2: "cc000000-0000-4000-8000-000000000002",
  sessionBeta1: "cc000000-0000-4000-8000-000000000003",

  // Turns (prefix: dd) — alpha session 1 has 3 turns, alpha session 2 has 2, beta has 2
  turnA1_1: "dd000000-0000-4000-8000-000000000001",
  turnA1_2: "dd000000-0000-4000-8000-000000000002",
  turnA1_3: "dd000000-0000-4000-8000-000000000003",
  turnA2_1: "dd000000-0000-4000-8000-000000000004",
  turnA2_2: "dd000000-0000-4000-8000-000000000005",
  turnB1_1: "dd000000-0000-4000-8000-000000000006",
  turnB1_2: "dd000000-0000-4000-8000-000000000007",

  // Tool calls (prefix: ee)
  toolCall1: "ee000000-0000-4000-8000-000000000001",
  toolCall2: "ee000000-0000-4000-8000-000000000002",
  toolCall3: "ee000000-0000-4000-8000-000000000003",

  // Anomaly events (prefix: ff)
  anomaly1: "ff000000-0000-4000-8000-000000000001",
  anomaly2: "ff000000-0000-4000-8000-000000000002",
} as const;

// Raw API key strings (the "wrt_..." tokens sent in Authorization header).
// The api_keys table stores a SHA-256 hash of these.
export const API_KEYS = {
  alpha: "wrt_test_alpha_key_000000000001",
  beta: "wrt_test_beta_key_000000000002",
  admin: "wrt_test_admin_key_000000000003",
  revoked: "wrt_test_revoked_key_0000000004",
  invalid: "wrt_this_key_does_not_exist",
} as const;

export const REVOKED_KEY_ID = "bb000000-0000-4000-8000-000000000004";

// ---------------------------------------------------------------------------
// (Schema creation removed — tests now run actual migrations via runMigrations())
// ---------------------------------------------------------------------------

// SHA-256 helper (to hash API key values for storage)
// ---------------------------------------------------------------------------

async function sha256(input: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Seed fixture data
// ---------------------------------------------------------------------------

// ISSUE 10 fix: All fixture seeding uses parameterized queries ($1, $2, etc.)
// instead of string interpolation, preventing any SQL injection risk in tests.
//
// FIND-10-B: this function previously took a Pool and issued ~30 separate
// queries through `p.query(...)`. Each call checked out a fresh connection,
// which meant the seed phase ran *outside* the resetSchemaState transaction.
// The reviewers reproduced 3 separate `seedFixtures` deadlocks across
// `auth.test.ts`, `baselines.test.ts`, `dashboard-monitoring.test.ts`
// when two `npm test` invocations raced: process A's TRUNCATE + compliance
// reseed committed, then process A's seedFixtures started inserting `projects`
// rows, while process B's TRUNCATE — also in a serialized advisory-lock
// transaction — ran. Process B got the lock (we released it on commit), then
// blocked on the FK rows process A was still inserting, while process A
// blocked on B's ACCESS EXCLUSIVE. 40P01 deadlock.
//
// Fix: take a `pg.PoolClient` instead of a Pool. The caller (setupDatabase)
// now does TRUNCATE + compliance-reseed + ALL fixture inserts inside a SINGLE
// transaction holding `pg_advisory_xact_lock(hashtext('reset_schema_state'))`.
// Any concurrent process must wait until COMMIT, after which the schema is
// fully populated. There is no longer a window where seedFixtures' INSERTs
// race with another process's TRUNCATE.
async function seedFixtures(p: pg.PoolClient): Promise<void> {
  const hashAlpha = await sha256(API_KEYS.alpha);
  const hashBeta = await sha256(API_KEYS.beta);
  const hashAdmin = await sha256(API_KEYS.admin);
  const hashRevoked = await sha256(API_KEYS.revoked);

  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3600_000);
  const twoHoursAgo = new Date(now.getTime() - 7200_000);

  // Projects
  await p.query(
    `INSERT INTO projects (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [IDS.projectAlpha, "Project Alpha"]
  );
  await p.query(
    `INSERT INTO projects (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [IDS.projectBeta, "Project Beta"]
  );

  // API keys
  await p.query(
    `INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [IDS.keyAlpha, hashAlpha, IDS.projectAlpha, 10000]
  );
  await p.query(
    `INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [IDS.keyBeta, hashBeta, IDS.projectBeta, 10000]
  );
  await p.query(
    `INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [IDS.keyAdmin, hashAdmin, null, 1000]
  );

  // Revoked key
  await p.query(
    `INSERT INTO api_keys (id, key_hash, project_id, rate_limit_rpm, revoked_at)
     VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO NOTHING`,
    [REVOKED_KEY_ID, hashRevoked, IDS.projectAlpha, 10000]
  );

  // Sessions (B3: TEXT ids, TEXT timestamps, project_id as TEXT)
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [IDS.sessionAlpha1, IDS.projectAlpha, "anthropic", "claude-sonnet-4-20250514",
     twoHoursAgo.toISOString(), hourAgo.toISOString(), hourAgo.toISOString(),
     "Refactor authentication module", "abc123def456", 3, 3, 0, 15000, 0.45, "claude-code"]
  );
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [IDS.sessionAlpha2, IDS.projectAlpha, "openai", "gpt-4o",
     hourAgo.toISOString(), hourAgo.toISOString(), null,
     "Write unit tests for payment service", "def456abc789", 2, 2, 0, 8000, 0.20, "cursor"]
  );
  await p.query(
    `INSERT INTO sessions (id, project_id, provider, model, started_at, last_active_at, ended_at,
                           initial_intent, system_prompt_hash, total_turns, turns_captured,
                           dropped_events, total_tokens, total_cost_usd, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (id) DO NOTHING`,
    [IDS.sessionBeta1, IDS.projectBeta, "anthropic", "claude-sonnet-4-20250514",
     hourAgo.toISOString(), hourAgo.toISOString(), null,
     "Deploy infrastructure changes", "ghi789jkl012", 2, 2, 1, 12000, 0.35, "claude-code"]
  );

  // B3: turns now use gateway column names: request_hash, response_hash, stop_reason, created_at
  const turnInsertSql = `INSERT INTO turns (id, session_id, sequence_num, timestamp, request_hash, response_hash,
                       req_bytes_ref, resp_bytes_ref, model, provider,
                       input_tokens, output_tokens, thinking_tokens, cost_usd,
                       duration_ms, tool_call_count, stop_reason, created_at,
                       cache_read_tokens, cache_creation_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT (id) DO NOTHING`;

  await p.query(turnInsertSql,
    [IDS.turnA1_1, IDS.sessionAlpha1, 1, twoHoursAgo.toISOString(),
     "hash_req_a1_1", "hash_resp_a1_1", "req_sha256_a1_1", "resp_sha256_a1_1",
     "claude-sonnet-4-20250514", "anthropic", 1000, 500, 0, 0.05, 1200, 1, "end_turn",
     twoHoursAgo.toISOString(), 0, 0]
  );
  await p.query(turnInsertSql,
    [IDS.turnA1_2, IDS.sessionAlpha1, 2, new Date(twoHoursAgo.getTime() + 60000).toISOString(),
     "hash_req_a1_2", "hash_resp_a1_2", "req_sha256_a1_2", "resp_sha256_a1_2",
     "claude-sonnet-4-20250514", "anthropic", 2000, 3000, 0, 0.15, 3400, 2, "end_turn",
     new Date(twoHoursAgo.getTime() + 60000).toISOString(), 0, 0]
  );
  await p.query(turnInsertSql,
    [IDS.turnA1_3, IDS.sessionAlpha1, 3, new Date(twoHoursAgo.getTime() + 120000).toISOString(),
     "hash_req_a1_3", "hash_resp_a1_3", "req_sha256_a1_3", "resp_sha256_a1_3",
     "claude-sonnet-4-20250514", "anthropic", 3000, 5500, 0, 0.25, 5600, 0, "end_turn",
     new Date(twoHoursAgo.getTime() + 120000).toISOString(), 0, 0]
  );
  await p.query(turnInsertSql,
    [IDS.turnA2_1, IDS.sessionAlpha2, 1, hourAgo.toISOString(),
     "hash_req_a2_1", "hash_resp_a2_1", "req_sha256_a2_1", "resp_sha256_a2_1",
     "gpt-4o", "openai", 1500, 2000, 0, 0.10, 2100, 0, "end_turn",
     hourAgo.toISOString(), 0, 0]
  );
  await p.query(turnInsertSql,
    [IDS.turnA2_2, IDS.sessionAlpha2, 2, new Date(hourAgo.getTime() + 60000).toISOString(),
     "hash_req_a2_2", "hash_resp_a2_2", "req_sha256_a2_2", "resp_sha256_a2_2",
     "gpt-4o", "openai", 2000, 2500, 0, 0.10, 1800, 1, "end_turn",
     new Date(hourAgo.getTime() + 60000).toISOString(), 0, 0]
  );
  await p.query(turnInsertSql,
    [IDS.turnB1_1, IDS.sessionBeta1, 1, hourAgo.toISOString(),
     "hash_req_b1_1", "hash_resp_b1_1", "req_sha256_b1_1", "resp_sha256_b1_1",
     "claude-sonnet-4-20250514", "anthropic", 4000, 3000, 0, 0.20, 4500, 1, "end_turn",
     hourAgo.toISOString(), 0, 0]
  );
  await p.query(turnInsertSql,
    [IDS.turnB1_2, IDS.sessionBeta1, 2, new Date(hourAgo.getTime() + 120000).toISOString(),
     "hash_req_b1_2", "hash_resp_b1_2", "req_sha256_b1_2", "resp_sha256_b1_2",
     "claude-sonnet-4-20250514", "anthropic", 2000, 3000, 0, 0.15, 3200, 0, "end_turn",
     new Date(hourAgo.getTime() + 120000).toISOString(), 0, 0]
  );

  // FIND-10-B: we are already inside the caller's transaction (the
  // single `setupDatabase` BEGIN that holds the advisory lock). The
  // immutability trigger consults `recondo.gdpr_bypass` via
  // current_setting(), which respects `SET LOCAL` for the current
  // transaction. So we can flip the bypass for one statement using
  // SAVEPOINT semantics: `SET LOCAL` here propagates through to
  // COMMIT, but we restore it via SET LOCAL ... = 'false' immediately
  // after. The earlier wrap into the helper assumed a separate
  // connection (FIND-8-B), but that doesn't apply when the whole
  // setup runs on one client; calling the helper would deadlock
  // because gdprBypassUpdate does its own BEGIN on a NEW connection,
  // and that new connection's SET LOCAL has nothing to do with the
  // immutability trigger that fires on OUR client's UPDATE.
  await p.query("SET LOCAL recondo.gdpr_bypass = 'true'");
  await p.query(
    `UPDATE turns SET search_vector = to_tsvector('english',
       coalesce(model, '') || ' ' ||
       coalesce(provider, ''))
     WHERE search_vector IS NULL`,
  );
  await p.query("SET LOCAL recondo.gdpr_bypass = 'false'");

  // B3: tool_calls now use gateway column names: tool_input, input_hash (not tool_input_hash)
  const toolCallInsertSql = `INSERT INTO tool_calls (id, turn_id, tool_name, tool_input, input_hash, sequence_num,
                            output, output_hash, duration_ms, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (id) DO NOTHING`;

  await p.query(toolCallInsertSql,
    [IDS.toolCall1, IDS.turnA1_1, "Read", '{"file": "auth.ts"}', "input_hash_tc1", 0,
     "File contents: export function auth()...", "output_hash_tc1", 350, "success"]
  );
  await p.query(toolCallInsertSql,
    [IDS.toolCall2, IDS.turnA1_2, "Edit", '{"file": "auth.ts", "edits": 3}', "input_hash_tc2", 0,
     "Applied 3 edits to auth.ts", "output_hash_tc2", 120, "success"]
  );
  await p.query(toolCallInsertSql,
    [IDS.toolCall3, IDS.turnA1_2, "Bash", '{"command": "npm test"}', "input_hash_tc3", 1,
     "npm test: 42 passed, 0 failed", "output_hash_tc3", 5400, "success"]
  );

  // Anomaly events
  await p.query(
    `INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity,
                                 description, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [IDS.anomaly1, IDS.sessionBeta1, null, "dropped_event", "warning",
     "Network timeout caused 1 dropped event in session", hourAgo.toISOString()]
  );
  await p.query(
    `INSERT INTO anomaly_events (id, session_id, turn_id, anomaly_type, severity,
                                 description, detected_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [IDS.anomaly2, IDS.sessionAlpha1, IDS.turnA1_3, "hash_mismatch", "critical",
     "Response hash mismatch detected on turn 3", twoHoursAgo.toISOString()]
  );
}

// ---------------------------------------------------------------------------
// Per-file cleanup helpers
//
// FIND-7-A: removed `wipeSchema()` and `runMigrations()` — both were
// per-file DROP+migrate operations that raced under any concurrency
// (intra-file when the in-process server held connections to the
// pool while wipeSchema ran DDL). Schema is now established ONCE
// by `tests/global-setup.ts`; per-file cleanup is `resetSchemaState`
// (defined below `setupDatabase`).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public helpers: setup / teardown for use in beforeAll / afterAll
// ---------------------------------------------------------------------------

/**
 * Call from beforeAll in each test file.
 *
 * FIND-7-A: previously called `wipeSchema(p) + runMigrations()` per
 * file. That paired DROP-all-tables + re-run-migrations with the
 * `node-pg-migrate` advisory lock. Under any concurrency (even with
 * `fileParallelism: false`, the in-process server's connection pool
 * issues queries while wipeSchema is running), this caused
 * non-determinism the reviewers reported (27/116/39 / 184/57/0
 * failures across runs).
 *
 * The fix: schema is established ONCE by `global-setup.ts` (which
 * runs `npm run migrate up` before any worker spawns). Per-file
 * cleanup is now data-only via TRUNCATE — fast, deterministic, no
 * migration replay, no advisory-lock contention. Each file then
 * re-seeds its baseline fixtures.
 *
 * Tables truncated CASCADE-style to clean dependent rows; the
 * `pgmigrations` tracking table is preserved so global-setup's
 * migration history persists across files.
 */
export async function setupDatabase(): Promise<void> {
  const p = getPool();
  // FIND-10-B: TRUNCATE + compliance reseed + fixture inserts run in
  // ONE transaction holding ONE advisory lock. The previous
  // resetSchemaState-then-seedFixtures split released the lock at
  // the first COMMIT, opening a window in which a concurrent
  // process could TRUNCATE while we held FK rows mid-insert. The
  // reviewers reproduced 3 distinct deadlocks (auth.test.ts,
  // baselines.test.ts, dashboard-monitoring.test.ts) under that
  // pattern. Now: one BEGIN, one pg_advisory_xact_lock(hashtext(
  // 'reset_schema_state')), one COMMIT, no intermediate release
  // window. Materialized-view refresh runs AFTER the commit because
  // REFRESH MATERIALIZED VIEW (non-CONCURRENT) takes its own
  // ACCESS EXCLUSIVE lock and must not nest under our advisory
  // lock — but since the advisory lock has been released at COMMIT,
  // any concurrent writer can proceed in lockstep with our refresh.
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    // Cross-process serialisation. hashtext() is deterministic so
    // every caller (this function AND the gateway-side test that
    // takes the same key in attachment_scoping_tests) computes the
    // same i4 lock id. pg_advisory_xact_lock auto-releases at
    // COMMIT/ROLLBACK; we cannot leak the lock.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('reset_schema_state'))",
    );
    // TRUNCATE all user tables (compliance_* included).
    await client.query(`
      DO $$
      DECLARE
        table_list text;
      BEGIN
        SELECT string_agg(format('public.%I', tablename), ', ')
          INTO table_list
          FROM pg_tables
         WHERE schemaname = 'public'
           AND tablename <> 'pgmigrations';
        IF table_list IS NOT NULL THEN
          EXECUTE 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY CASCADE';
        END IF;
      END $$;
    `);
    // Re-seed compliance reference data (mirror of migration 004's
    // INSERTs; idempotent ON CONFLICT). Inside the same tx so a
    // concurrent reader sees either pre-truncate or fully-seeded.
    await client.query(COMPLIANCE_SEED_SQL);
    // Seed fixtures (projects, api_keys, sessions, turns, tool_calls,
    // anomaly_events). Was a separate post-commit phase in Round 9;
    // now part of the same tx so the lock covers the entire
    // user-data initialisation, not just the truncate.
    await seedFixtures(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // ROLLBACK on a connection in an unknown state can fail; we
      // still release the connection so the pool reclaims it.
    });
    throw err;
  } finally {
    client.release();
  }
  // Refresh materialized views AFTER commit. CONCURRENTLY would
  // require unique indexes; non-concurrent is fine here because the
  // test file's beforeAll runs before any test fires queries.
  await p.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN SELECT matviewname FROM pg_matviews WHERE schemaname = 'public' LOOP
        EXECUTE 'REFRESH MATERIALIZED VIEW public.' || quote_ident(r.matviewname);
      END LOOP;
    END $$;
  `);

  // Reset rate limits between test files to prevent 429 errors
  try {
    await fetch(`${API_BASE_URL}/_test/reset-rate-limits`, { method: "POST" });
  } catch {
    // Server may not be running yet; non-fatal
  }
}

// FIND-10-B: `resetSchemaState` was inlined into `setupDatabase` so
// that TRUNCATE + compliance reseed + fixture seed all run inside a
// single transaction holding one advisory lock. Keeping it as a
// separate function would re-introduce the lock-release window that
// produced the seedFixtures deadlocks the reviewers reproduced.

/**
 * FIND-7-A: compliance reference seeds copied verbatim from
 * `api/migrations/004_compliance.sql` plus the short-id reconciliation
 * in `015_compliance-frameworks-short-ids.sql`. Idempotent via
 * `ON CONFLICT (id) DO NOTHING`. Re-applied per file so test code
 * that depends on reference rows (e.g. `m1-migrations.test.ts`'s
 * "M1.5 — compliance seed data" block) sees the canonical state.
 *
 * If migration 004 changes its seed, mirror the change here too.
 */
const COMPLIANCE_SEED_SQL = `
  INSERT INTO compliance_frameworks (id, name, subtitle, compliance_percentage, controls_met, controls_total) VALUES
    ('soc2',     'SOC 2 Type II',  'Service Organization Control',   0, 0, 7),
    ('iso42001', 'ISO 42001',      'AI Management System',           0, 0, 7),
    ('euai',     'EU AI Act',      'European Union AI Regulation',   0, 0, 7),
    ('nist',     'NIST AI RMF',    'AI Risk Management Framework',   0, 0, 7)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO compliance_controls (id, framework_id, control_id, description, status) VALUES
    ('seed-ctrl-soc2-1', 'soc2', 'CC6.1', 'Logical and physical access controls', 'PLANNED'),
    ('seed-ctrl-soc2-2', 'soc2', 'CC6.2', 'System operations monitoring', 'PLANNED'),
    ('seed-ctrl-soc2-3', 'soc2', 'CC6.3', 'Change management procedures', 'PLANNED'),
    ('seed-ctrl-soc2-4', 'soc2', 'CC7.1', 'System availability monitoring', 'PLANNED'),
    ('seed-ctrl-soc2-5', 'soc2', 'CC7.2', 'Incident response procedures', 'PLANNED'),
    ('seed-ctrl-soc2-6', 'soc2', 'CC8.1', 'Processing integrity controls', 'PLANNED'),
    ('seed-ctrl-soc2-7', 'soc2', 'CC9.1', 'Confidentiality controls', 'PLANNED'),

    ('seed-ctrl-iso-1', 'iso42001', '6.1.1', 'AI risk assessment', 'PLANNED'),
    ('seed-ctrl-iso-2', 'iso42001', '6.1.2', 'AI impact assessment', 'PLANNED'),
    ('seed-ctrl-iso-3', 'iso42001', '6.2.1', 'AI system lifecycle management', 'PLANNED'),
    ('seed-ctrl-iso-4', 'iso42001', '7.1.1', 'Competence and awareness', 'PLANNED'),
    ('seed-ctrl-iso-5', 'iso42001', '7.2.1', 'Documented information', 'PLANNED'),
    ('seed-ctrl-iso-6', 'iso42001', '8.1.1', 'Operational planning and control', 'PLANNED'),
    ('seed-ctrl-iso-7', 'iso42001', '9.1.1', 'Performance evaluation', 'PLANNED'),

    ('seed-ctrl-euai-1', 'euai', 'Art.9',  'Risk management system', 'PLANNED'),
    ('seed-ctrl-euai-2', 'euai', 'Art.10', 'Data governance', 'PLANNED'),
    ('seed-ctrl-euai-3', 'euai', 'Art.11', 'Technical documentation', 'PLANNED'),
    ('seed-ctrl-euai-4', 'euai', 'Art.12', 'Record-keeping', 'PLANNED'),
    ('seed-ctrl-euai-5', 'euai', 'Art.13', 'Transparency and information', 'PLANNED'),
    ('seed-ctrl-euai-6', 'euai', 'Art.14', 'Human oversight', 'PLANNED'),
    ('seed-ctrl-euai-7', 'euai', 'Art.15', 'Accuracy, robustness, cybersecurity', 'PLANNED'),

    ('seed-ctrl-nist-1', 'nist', 'GOVERN-1',  'AI governance policies',     'PLANNED'),
    ('seed-ctrl-nist-2', 'nist', 'GOVERN-2',  'Accountability structures',  'PLANNED'),
    ('seed-ctrl-nist-3', 'nist', 'MAP-1',     'AI system context mapping',  'PLANNED'),
    ('seed-ctrl-nist-4', 'nist', 'MAP-2',     'Stakeholder identification', 'PLANNED'),
    ('seed-ctrl-nist-5', 'nist', 'MEASURE-1', 'Risk measurement',           'PLANNED'),
    ('seed-ctrl-nist-6', 'nist', 'MEASURE-2', 'Testing and evaluation',     'PLANNED'),
    ('seed-ctrl-nist-7', 'nist', 'MANAGE-1',  'Risk response and mitigation','PLANNED')
  ON CONFLICT (id) DO NOTHING;
`;

/**
 * Call from afterAll in each test file.
 * Closes the connection pool.
 */
export async function teardownDatabase(): Promise<void> {
  await closePool();
}

// ---------------------------------------------------------------------------
// GraphQL request helper
// ---------------------------------------------------------------------------

interface GraphQLResponse<T = Record<string, any>> {
  data?: T;
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
}

interface RequestOptions {
  query: string;
  variables?: Record<string, unknown>;
  apiKey?: string;
  headers?: Record<string, string>;
}

/**
 * Sends a GraphQL POST request to the API server.
 * Returns the parsed JSON body plus the raw Response for header inspection.
 */
export async function graphql<T = Record<string, any>>(
  opts: RequestOptions
): Promise<{ body: GraphQLResponse<T>; response: Response }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...opts.headers,
  };

  if (opts.apiKey) {
    headers["Authorization"] = `Bearer ${opts.apiKey}`;
  }

  const response = await fetch(`${API_BASE_URL}/graphql`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: opts.query,
      variables: opts.variables ?? {},
    }),
  });

  const body = (await response.json()) as GraphQLResponse<T>;
  return { body, response };
}

/**
 * Sends a plain HTTP GET request (for health check, etc.).
 */
export async function httpGet(
  path: string,
  headers?: Record<string, string>
): Promise<{ body: unknown; response: Response }> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "GET",
    headers,
  });

  let body: unknown;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  return { body, response };
}

// ---------------------------------------------------------------------------
// Audit log query helper
// ---------------------------------------------------------------------------

/**
 * Queries the access_audit_log table directly.
 * Returns all rows matching optional filters.
 */
export async function queryAuditLog(
  filters?: Partial<{
    api_key_id: string;
    query_type: string;
    response_status: number;
  }>
): Promise<Array<Record<string, unknown>>> {
  const p = getPool();
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (filters?.api_key_id) {
    conditions.push(`api_key_id = $${idx++}`);
    values.push(filters.api_key_id);
  }
  if (filters?.query_type) {
    conditions.push(`query_type = $${idx++}`);
    values.push(filters.query_type);
  }
  if (filters?.response_status !== undefined) {
    conditions.push(`response_status = $${idx++}`);
    values.push(filters.response_status);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await p.query(
    `SELECT * FROM access_audit_log ${where} ORDER BY timestamp DESC`,
    values
  );
  return result.rows;
}

/**
 * Counts rows in access_audit_log (used to detect new entries after a request).
 */
export async function countAuditLogs(): Promise<number> {
  const p = getPool();
  const result = await p.query("SELECT count(*)::int AS n FROM access_audit_log");
  return result.rows[0].n;
}

/**
 * Truncates the audit log (for test isolation).
 * Must disable/re-enable the immutability trigger.
 */
export async function clearAuditLog(): Promise<void> {
  const p = getPool();
  // FIND-8-B (b) + FIND-8-F: use DISABLE/ENABLE TRIGGER instead of
  // DROP/CREATE. DROP TRIGGER takes ACCESS EXCLUSIVE on the table
  // catalog, racing with the in-process API server's pool that
  // holds READ/WRITE locks on access_audit_log for inserts. Under
  // load this manifested as cascading test failures (the server
  // would block on the catalog change, then time out, then crash).
  // DISABLE TRIGGER takes a much weaker SHARE ROW EXCLUSIVE lock
  // and doesn't drop the trigger definition — the TRUNCATE proceeds
  // without trigger interference, then ENABLE TRIGGER restores the
  // immutability check.
  //
  // BEGIN/COMMIT scopes the disable+truncate+enable sequence in
  // ONE transaction, so the immutability invariant is restored
  // atomically — no observation window where a mid-test write
  // could bypass the trigger.
  await p.query(`
    BEGIN;
      ALTER TABLE access_audit_log DISABLE TRIGGER audit_log_immutability;
      TRUNCATE access_audit_log;
      ALTER TABLE access_audit_log ENABLE TRIGGER audit_log_immutability;
    COMMIT;
  `);
}
