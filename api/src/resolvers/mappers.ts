/**
 * Row mappers: PostgreSQL snake_case -> GraphQL camelCase
 *
 * Extracted from resolvers.ts as part of D0.5 resolver domain splitting.
 * B3: Updated to match gateway's actual PostgreSQL schema column names.
 *
 * W3 fix: Explicit return type interfaces matching the generated GraphQL types.
 * These types ensure the mapper output is compatible with what the resolvers
 * (typed against generated Resolvers type) expect.
 *
 * D1.2/D1.3: Enhanced with new session and turn fields.
 *
 * FIND-1-M: Every user-visible text field that could carry the
 * `[Image: source: /Users/.../N.png]` placeholder is run through
 * `maskPlaceholderPaths` before returning to the dashboard. The raw
 * storage (req_bytes object, messages_delta column, tool_call.input)
 * stays byte-complete for compliance / audit; only the rendered view
 * is sanitized. Parity with the gateway-side allow-list is guaranteed
 * by `api/src/placeholder-mask.ts` (tested at
 * `api/tests/placeholder-mask.test.ts`).
 */

import {
  maskPlaceholderPaths,
  sanitizeAnomalyRow,
} from "../placeholder-mask.js";

// W3: Explicit return types for mapper functions.
// These mirror the generated GraphQL types from codegen but use concrete
// types (not resolver wrappers). They document exactly what each mapper returns.

export interface MappedSession {
  id: string;
  projectId: string | null;
  agentId: string | null;
  model: string | null;
  provider: string;
  startedAt: string;
  endedAt: string | null;
  lastActiveAt: string | null;
  initialIntent: string | null;
  systemPromptHash: string;
  totalTurns: number;
  turnsCaptured: number;
  droppedEvents: number;
  totalTokens: number;
  totalCostUsd: number;
  complete: boolean;
  // D1.2: New fields
  framework: string | null;
  status: string;
  duration: number | null;
  accountUuid: string | null;
  deviceId: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Logical user turn — a group of contiguous same-user_request_text wire turns
 * collapsed into one row. The public GraphQL fields match the UserTurn type;
 * `turnIds` is an internal field carried from the grouping query so the
 * UserTurn.turns child resolver can filter the session's wire turns without
 * re-running the grouping.
 */
export interface MappedUserTurn {
  id: string;
  sessionId: string;
  groupIdx: number;
  startTimestamp: string;
  endTimestamp: string;
  durationMs: number;
  userRequestText: string | null;
  primaryModel: string | null;
  provider: string;
  framework: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  subCallCount: number;
  toolCallCount: number;
  status: string;
  /** Internal — not exposed in GraphQL. Carries the wire-level turn IDs in this group. */
  turnIds: string[];
}

/** Sprint P1B: attachment metadata exposed via GraphQL. */
export interface MappedAttachment {
  id: string;
  turnId: string;
  sessionId: string;
  sequenceNum: number;
  role: string;
  kind: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  filename: string | null;
  width: number | null;
  height: number | null;
  url: string;
}

export interface MappedTurn {
  id: string;
  sessionId: string;
  sequenceNum: number;
  timestamp: string;
  turnType: string | null;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  costUsd: number;
  latencyMs: number | null;
  captureComplete: boolean;
  contentHashReq: string | null;
  contentHashResp: string | null;
  stopReason: string | null;
  model: string | null;
  provider: string | null;
  toolCallCount: number;
  // D1.3: New fields
  userRequestText: string | null;
  responseText: string | null;
  thinkingText: string | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  httpStatus: number | null;
  transport: string | null;
  ttfbMs: number | null;
  durationMs: number | null;
  requestHash: string | null;
  responseHash: string | null;
}

export interface MappedToolCall {
  id: string;
  name: string;
  input: string | null;
  inputHash: string | null;
  result: string | null;
  resultHash: string | null;
  durationMs: number | null;
  status: string | null;
  sequenceNum: number | null;
}

export interface MappedAnomaly {
  id: string;
  sessionId: string | null;
  turnId: string | null;
  anomalyType: string;
  severity: string;
  description: string | null;
  detectedAt: string;
  metadata: string | null;
}

// R2-W3: Extract formatTimestamp as a single module-level function (was duplicated 3 times)
export function formatTimestamp(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function toNumber(val: unknown): number {
  return Number(val) || 0;
}

function toNullableNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const num = Number(val);
  return Number.isFinite(num) ? num : null;
}

// R2-B3: Escape ILIKE wildcard characters to prevent injection
// N2: This function is intentionally duplicated in query/builder.ts.
// Extracting to a shared utility is deferred — not worth a file move for 3 lines.
export function escapeIlike(s: string): string {
  return s.replace(/[%_\\]/g, "\\$&");
}

/**
 * Computes duration in seconds between started_at and last_active_at.
 * Returns null if either timestamp is missing.
 */
function computeDuration(startedAt: unknown, lastActiveAt: unknown): number | null {
  if (startedAt == null || lastActiveAt == null) return null;
  const start = new Date(String(startedAt)).getTime();
  const end = new Date(String(lastActiveAt)).getTime();
  if (isNaN(start) || isNaN(end)) return null;
  const diffSeconds = Math.floor((end - start) / 1000);
  return diffSeconds >= 0 ? diffSeconds : 0;
}

// R2-W3: Uses module-level formatTimestamp (deduplicated)
// R2-W7: Defensive defaults for all non-nullable GraphQL fields
// W3 fix: Explicit return type annotation
// D1.2: Enhanced with framework, status, duration, identity, git, and cache token fields
export function mapSession(row: Record<string, unknown>): MappedSession {
  return {
    id: row.id as string,
    projectId: (row.project_id ?? row.account_uuid ?? null) as string | null,
    agentId: (row.agent_id as string) ?? null,
    model: (row.model as string) ?? null,
    provider: (row.provider as string) ?? "unknown",
    startedAt: formatTimestamp(row.started_at) ?? new Date().toISOString(),
    endedAt: formatTimestamp(row.ended_at),
    lastActiveAt: formatTimestamp(row.last_active_at),
    // FIND-1-M: initial_intent can echo the user's first message, which
    // may carry the `[Image: source: /path]` placeholder when the first
    // turn was an image attach. Mask before render.
    initialIntent: maskPlaceholderPaths(row.initial_intent as string),
    systemPromptHash: (row.system_prompt_hash as string) ?? "",
    totalTurns: toNumber(row.total_turns),
    turnsCaptured: toNumber(row.turns_captured),
    droppedEvents: toNumber(row.dropped_events),
    totalTokens: toNumber(row.total_tokens),
    totalCostUsd: Number(row.total_cost_usd) || 0,
    complete: row.ended_at !== null && row.ended_at !== undefined,
    // D1.2: New fields
    framework: (row.framework as string) ?? null,
    status: (row.ended_at !== null && row.ended_at !== undefined) ? "COMPLETED" : "ACTIVE",
    // W5 fix: Prefer ended_at for completed sessions; fall back to last_active_at for active ones.
    duration: computeDuration(row.started_at, row.ended_at ?? row.last_active_at),
    accountUuid: (row.account_uuid as string) ?? null,
    deviceId: (row.device_id as string) ?? null,
    gitRepo: (row.git_repo as string) ?? null,
    gitBranch: (row.git_branch as string) ?? null,
    // B2 fix: Sessions table has no cache token columns. Set explicit defaults of 0.
    // Actual values are populated by:
    //   - Query.sessions / Query.session: batch aggregation from turns table
    //   - DataLoader (createSessionByIdLoader): per-batch aggregation from turns table
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
}

// R2-W3: Uses module-level formatTimestamp (deduplicated)
// R2-W1: costUsd null fallback (DB column cost_usd is nullable)
// R2-N2: totalTokens fallback includes thinking_tokens
// W3 fix: Explicit return type annotation
// D1.3: Enhanced with new turn fields
export function mapTurn(row: Record<string, unknown>): MappedTurn {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    sequenceNum: toNumber(row.sequence_num),
    timestamp: formatTimestamp(row.timestamp) ?? new Date().toISOString(),
    // D0-B: The turns table has no `role` column. turnType is nullable and
    // reserved for future use (e.g., "user" | "assistant" classification).
    turnType: null,
    inputTokens: toNumber(row.input_tokens),
    outputTokens: toNumber(row.output_tokens),
    thinkingTokens: toNumber(row.thinking_tokens),
    // B3: gateway schema doesn't have total_tokens column, compute from parts
    // R2-N2: Include thinking_tokens in the fallback computation
    totalTokens: row.total_tokens != null
      ? toNumber(row.total_tokens)
      : toNumber(row.input_tokens) + toNumber(row.output_tokens) + toNumber(row.thinking_tokens),
    // R2-W1: cost_usd is nullable in the gateway DB -- fall back to 0
    costUsd: Number(row.cost_usd) || 0,
    // N1 fix: latencyMs maps from ttfb_ms (time-to-first-byte), not duration_ms.
    // durationMs maps from duration_ms (total request duration).
    latencyMs: toNullableNumber(row.ttfb_ms),
    captureComplete:
      row.capture_complete !== undefined
        ? (row.capture_complete as boolean)
        : (row.req_bytes_ref !== null &&
           row.req_bytes_ref !== "" &&
           row.resp_bytes_ref !== null &&
           row.resp_bytes_ref !== ""),
    // D0-B: Map to the actual SHA-256 content hashes (request_hash/response_hash),
    // not the object store references (req_bytes_ref/resp_bytes_ref).
    contentHashReq: (row.request_hash as string) ?? null,
    contentHashResp: (row.response_hash as string) ?? null,
    // W10: Map stopReason to the correct column: stop_reason (not error_message)
    stopReason: (row.stop_reason as string) ?? null,
    model: (row.model as string) ?? null,
    provider: (row.provider as string) ?? null,
    toolCallCount: toNumber(row.tool_call_count),
    // D1.3: New fields. FIND-1-M: mask `[Image: source: /path]` style
    // placeholders so local filesystem paths never render in the
    // dashboard. Raw storage is unchanged; only the rendered form is
    // sanitised.
    userRequestText: maskPlaceholderPaths(row.user_request_text as string),
    responseText: maskPlaceholderPaths(row.response_text as string),
    thinkingText: maskPlaceholderPaths(row.thinking_text as string),
    cacheReadTokens: toNumber(row.cache_read_tokens),
    cacheCreationTokens: toNumber(row.cache_creation_tokens),
    httpStatus: toNullableNumber(row.http_status),
    transport: (row.transport as string) ?? null,
    ttfbMs: toNullableNumber(row.ttfb_ms),
    durationMs: toNullableNumber(row.duration_ms),
    requestHash: (row.request_hash as string) ?? null,
    responseHash: (row.response_hash as string) ?? null,
  };
}

// W3 fix: Explicit return type annotation
export function mapToolCall(row: Record<string, unknown>): MappedToolCall {
  return {
    id: row.id as string,
    name: row.tool_name as string,
    // N3: Map to row.tool_input (the actual column in gateway schema).
    // FIND-1-M: tool_input can carry embedded `[Image: source: /path]`
    // placeholders when a user attaches an image to a tool result; mask
    // those before returning to the dashboard.
    input: maskPlaceholderPaths(row.tool_input as string),
    // B3: gateway uses input_hash (not tool_input_hash)
    inputHash: (row.input_hash as string) ?? (row.tool_input_hash as string) ?? null,
    // FIND-1-M: tool output can also echo the user's attached path back.
    result: maskPlaceholderPaths(row.output as string),
    resultHash: (row.output_hash as string) ?? null,
    durationMs: toNullableNumber(row.duration_ms),
    status: (row.status as string) ?? null,
    sequenceNum: toNullableNumber(row.sequence_num),
  };
}

// R2-W3: Uses module-level formatTimestamp (deduplicated)
// W3 fix: Explicit return type annotation
//
// FIND-8-A + FIND-10-E: sanitise via `sanitizeAnomalyRow`, which
// covers both top-level text columns (description, resolution_note)
// AND the `metadata` JSONB column's string values one level deep.
// Round-9 used `sanitizeRowTextFields(row, ANOMALY_TEXT_FIELDS)`
// here, which left `metadata.toolName` raw. Pre-Round-9 anomaly
// rows (or batch-imported anomalies) leaked via
// `query { anomalies { metadata } }` — the JSONB was JSON-stringified
// straight into the response without masking.
//
// VERIFIED before/after via direct GraphQL query against a fixture
// row containing `[Image: source: /Users/x/secret.png]`:
//   BEFORE: "Reviewed [Image: source: /Users/x/secret.png]"  (leak)
//   AFTER:  "Reviewed [attachment]"                          (masked)
export function mapAnomaly(row: Record<string, unknown>): MappedAnomaly {
  const sanitized = sanitizeAnomalyRow(row);
  return {
    id: sanitized.id as string,
    sessionId: (sanitized.session_id as string) ?? null,
    turnId: (sanitized.turn_id as string) ?? null,
    anomalyType: (sanitized.anomaly_type as string) ?? "unknown",
    severity: (sanitized.severity as string) ?? "info",
    description: (sanitized.description as string) ?? null,
    detectedAt: formatTimestamp(sanitized.detected_at) ?? new Date().toISOString(),
    // R2-N5: JSON.stringify on JSONB column is intentional -- the GraphQL schema
    // defines metadata as String, so we serialize the JSONB object to a JSON string.
    // FIND-10-E: by this point, `sanitized.metadata` has had every
    // string value masked by `sanitizeAnomalyRow`, so the
    // serialised JSON is safe.
    metadata: sanitized.metadata ? JSON.stringify(sanitized.metadata) : null,
  };
}
