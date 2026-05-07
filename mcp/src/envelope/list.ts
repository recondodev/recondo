/**
 * Canonical list-envelope shape for recondo-mcp list tools.
 *
 * Always exactly 5 keys:
 *   { items, next_offset, truncated, stream_id: null, is_final: true }
 *
 * `stream_id` is reserved for streaming variants (always null in v1).
 * `is_final` is literal `true` (every response is a final response).
 */

export interface ListEnvelope<T> {
  items: T[];
  next_offset: number | null;
  truncated: boolean;
  stream_id: null;
  is_final: true;
}

export interface BuildListEnvelopeArgs<T> {
  items: T[];
  nextOffset: number | null;
  truncated: boolean;
}

export function buildListEnvelope<T>(args: BuildListEnvelopeArgs<T>): ListEnvelope<T> {
  return {
    items: args.items,
    next_offset: args.nextOffset,
    truncated: args.truncated,
    stream_id: null,
    is_final: true,
  };
}
