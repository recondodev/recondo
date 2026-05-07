/**
 * D-C2-2 — Test seed harness for the MCP integration suite.
 *
 * Truncates the captured tables (tool_calls, attachments, turns,
 * sessions) inside a transaction wrapped with `SET LOCAL
 * recondo.gdpr_bypass = 'true'` so the SOC 2 PI1 immutability
 * triggers don't reject the DELETE. Then INSERTs the requested
 * fixtures and returns the resulting ids + a `cleanup()` that
 * closes the @recondo/data pool.
 *
 * The captured-table mutation MUST stay a single transaction —
 * `SET LOCAL` is scoped to the active txn. Splitting it into
 * multiple top-level statements silently disables the bypass and
 * the DELETE will throw "turns table is append-only".
 */
import { randomUUID } from "node:crypto";

// Lazy-import @recondo/data so missing infra at module-load doesn't
// crash the file before the integration test gets a chance to skip.
type DataModule = typeof import("@recondo/data");
let _dataMod: DataModule | undefined;
async function dataModule(): Promise<DataModule> {
  if (!_dataMod) _dataMod = await import("@recondo/data");
  return _dataMod;
}

export interface SessionFixture {
  id?: string;
  provider?: string;
  model?: string | null;
  startedAt?: Date | string;
  lastActiveAt?: Date | string;
  endedAt?: Date | string | null;
  initialIntent?: string | null;
  systemPromptHash?: string;
  totalTurns?: number;
  turnsCaptured?: number;
  droppedEvents?: number;
  totalTokens?: number;
  totalCostUsd?: number;
  framework?: string | null;
  agentId?: string | null;
  projectId?: string | null;
  accountUuid?: string | null;
  deviceId?: string | null;
  toolDefinitionsHash?: string;
}

export interface TurnFixture {
  id?: string;
  sessionId: string;
  sequenceNum?: number;
  timestamp?: Date | string;
  requestHash?: string;
  responseHash?: string;
  reqBytesRef?: string | null;
  reqBytesSize?: number | null;
  respBytesRef?: string | null;
  respBytesSize?: number | null;
  model?: string | null;
  provider?: string | null;
  userRequestText?: string | null;
  responseText?: string | null;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number | null;
  ttfbMs?: number | null;
  toolCallCount?: number;
  thinkingTokens?: number;
  retryCount?: number;
  createdAt?: Date | string;
  captureComplete?: boolean;
  httpStatus?: number | null;
  supersedesTurnId?: string | null;
}

export interface ToolCallFixture {
  id?: string;
  turnId: string;
  toolName?: string;
  toolInput?: string;
  inputHash?: string | null;
  durationMs?: number | null;
  status?: string | null;
  output?: string | null;
  outputHash?: string | null;
}

export interface SeedFixtures {
  sessions?: SessionFixture[];
  turns?: TurnFixture[];
  toolCalls?: ToolCallFixture[];
}

export interface SeedResult {
  sessionIds: string[];
  turnIds: string[];
  toolCallIds: string[];
  /** Closes the @recondo/data pool. Idempotent. */
  cleanup(): Promise<void>;
}

/**
 * Wipe captured rows in dependency order under GDPR bypass.
 * Exported for tests that want to assert the mechanism in isolation.
 */
export async function truncateCapturedTables(): Promise<void> {
  const { getPool } = await dataModule();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL recondo.gdpr_bypass = 'true'");
    // Children before parents — the FK on turns(session_id) is RESTRICT,
    // not CASCADE, so we must clear children first.
    await client.query("DELETE FROM tool_calls");
    await client.query("DELETE FROM attachments");
    await client.query("DELETE FROM turns");
    await client.query("DELETE FROM sessions");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function toIso(value: Date | string | undefined, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  return fallback;
}

export async function seedTestDb(fixtures: SeedFixtures = {}): Promise<SeedResult> {
  const { getPool, closePool } = await dataModule();
  const pool = getPool();

  await truncateCapturedTables();

  const sessionIds: string[] = [];
  const turnIds: string[] = [];
  const toolCallIds: string[] = [];

  const now = new Date();
  const nowIso = now.toISOString();

  for (const s of fixtures.sessions ?? []) {
    const id = s.id ?? randomUUID();
    sessionIds.push(id);
    await pool.query(
      `INSERT INTO sessions (
         id, provider, model, started_at, last_active_at, ended_at,
         initial_intent, system_prompt_hash, total_turns, turns_captured,
         dropped_events, total_tokens, total_cost_usd, framework,
         agent_id, account_uuid, device_id, project_id, tool_definitions_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        id,
        s.provider ?? "anthropic",
        s.model ?? "claude-sonnet-4-20250514",
        toIso(s.startedAt, nowIso),
        toIso(s.lastActiveAt, nowIso),
        s.endedAt === null ? null : toIso(s.endedAt as Date | string | undefined, nowIso),
        s.initialIntent ?? "seeded test session",
        s.systemPromptHash ?? "test-system-prompt-hash",
        s.totalTurns ?? 0,
        s.turnsCaptured ?? 0,
        s.droppedEvents ?? 0,
        s.totalTokens ?? 0,
        s.totalCostUsd ?? 0,
        s.framework ?? "claude-code",
        s.agentId ?? null,
        s.accountUuid ?? null,
        s.deviceId ?? null,
        s.projectId ?? null,
        s.toolDefinitionsHash ?? "",
      ],
    );
  }

  for (const t of fixtures.turns ?? []) {
    const id = t.id ?? randomUUID();
    turnIds.push(id);
    await pool.query(
      `INSERT INTO turns (
         id, session_id, sequence_num, timestamp, request_hash, response_hash,
         req_bytes_ref, resp_bytes_ref, req_bytes_size, resp_bytes_size,
         model, provider, user_request_text, response_text,
         stop_reason, capture_complete,
         input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         cost_usd, ttfb_ms, tool_call_count, thinking_tokens, retry_count,
         created_at, http_status, supersedes_turn_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)`,
      [
        id,
        t.sessionId,
        t.sequenceNum ?? 1,
        toIso(t.timestamp, nowIso),
        t.requestHash ?? `req-${id}`,
        t.responseHash ?? `resp-${id}`,
        t.reqBytesRef ?? null,
        t.respBytesRef ?? null,
        t.reqBytesSize ?? null,
        t.respBytesSize ?? null,
        t.model ?? "claude-sonnet-4-20250514",
        t.provider ?? "anthropic",
        t.userRequestText ?? "Hello",
        t.responseText ?? "Hi",
        t.stopReason ?? "end_turn",
        t.captureComplete ?? true,
        t.inputTokens ?? 100,
        t.outputTokens ?? 50,
        t.cacheReadTokens ?? 0,
        t.cacheCreationTokens ?? 0,
        t.costUsd ?? 0.01,
        t.ttfbMs ?? 200,
        t.toolCallCount ?? 0,
        t.thinkingTokens ?? 0,
        t.retryCount ?? 0,
        toIso(t.createdAt, nowIso),
        t.httpStatus ?? 200,
        t.supersedesTurnId ?? null,
      ],
    );
  }

  for (const tc of fixtures.toolCalls ?? []) {
    const id = tc.id ?? randomUUID();
    toolCallIds.push(id);
    await pool.query(
      `INSERT INTO tool_calls (
         id, turn_id, tool_name, tool_input, input_hash,
         duration_ms, status, output, output_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        tc.turnId,
        tc.toolName ?? "test_tool",
        tc.toolInput ?? "{}",
        tc.inputHash ?? null,
        tc.durationMs ?? null,
        tc.status ?? "ok",
        tc.output ?? null,
        tc.outputHash ?? null,
      ],
    );
  }

  let cleaned = false;
  return {
    sessionIds,
    turnIds,
    toolCallIds,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        await closePool();
      } catch {
        // already closed elsewhere
      }
    },
  };
}
