// Public surface of @recondo/data.

// Pool / health (driver-shaped but kept here as the canonical home;
// transport-import lint excludes pg).
export { getPool, closePool, checkDatabaseHealth } from "./pool.js";

// Type vocabulary.
export type {
  ApiKeyInfo,
  ListEnvelope,
  SinceCursor,
  SinceCursorPayload,
  QueryOptions,
  ListOptions,
} from "./types.js";
export { DataValidationError } from "./types.js";

// Envelope + cursor codec.
export type { EnvelopeMeta } from "./envelope.js";
export {
  encodeSinceCursor,
  decodeSinceCursor,
  uniformListEnvelope,
} from "./envelope.js";

// Async iterator adapters.
export { rowsToAsyncIterable, abortableIterable } from "./async-iter.js";

// Redaction subsystem — namespaced barrel for new consumers, plus
// flat re-exports for backward compatibility with the api/ shim.
export * as redaction from "./redaction/index.js";
export {
  PLACEHOLDER_PREFIXES,
  MASKED_PLACEHOLDER_REPLACEMENT,
  isAttachmentPlaceholder,
  maskPlaceholderPaths,
  sanitizeRowTextFields,
  TURN_TEXT_FIELDS,
  SESSION_TEXT_FIELDS,
  TOOL_CALL_TEXT_FIELDS,
  ANOMALY_TEXT_FIELDS,
  sanitizeAnomalyRow,
  SQL_PREFIX_NAMES,
  SQL_PREFIX_ALTERNATION,
  placeholderLikePatterns,
  looksLikePathProbe,
} from "./redaction/index.js";

// Auth — header parsing + token validation.
export { authenticateApiKey, authenticateRequest } from "./auth.js";

// Row mappers (PostgreSQL snake_case -> GraphQL camelCase) + helpers.
export {
  mapSession,
  mapTurn,
  mapToolCall,
  mapAnomaly,
  escapeIlike,
  formatTimestamp,
} from "./mappers.js";
export type {
  MappedSession,
  MappedUserTurn,
  MappedAttachment,
  MappedTurn,
  MappedToolCall,
  MappedAnomaly,
} from "./mappers.js";

// Structured query primitives — per-operation iterables + the legacy
// /v1/query dispatcher.
export {
  listStructuredSessions,
  listStructuredTurns,
  listStructuredAnomalies,
  listStructuredCost,
  listStructuredTools,
  listStructuredRisk,
  listStructuredCompliance,
  listStructuredProvenance,
  runStructuredQuery,
} from "./structured-query.js";

// Sessions: list / detail / userTurns. The GraphQL Connection
// re-shaping (items/total/limit/offset) stays in api/.
export { listSessions, getSession, listUserTurns } from "./sessions.js";
export type { SessionFilter, SessionListItem } from "./sessions.js";

// Turns: detail + search + verify. The api/ resolver materialises the
// AsyncIterable via Array.fromAsync.
export { getTurn, searchTurns, verifyIntegrity } from "./turns.js";
export type { VerifyIntegrityResult } from "./turns.js";
