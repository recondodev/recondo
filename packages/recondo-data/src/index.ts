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
