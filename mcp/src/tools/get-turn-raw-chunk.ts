/**
 * `recondo_get_turn_raw_chunk` — return a slice of the raw REQUEST-SIDE
 * bytes captured on a turn, base64-encoded inside a `<captured_raw_bytes>`
 * wrapper.
 *
 * Delegates to `getTurnRawChunk(turnId, offset, length, options)` from
 * `@recondo/data` (turns-raw.ts) and wraps the returned `Buffer` via
 * `buildRawByteEnvelope` — `{ role, from_turn_id, offset, length,
 * next_offset, content }`. The base64 alphabet contains no `<`/`>` so
 * adversarial input bytes can never break out of the wrapper tag.
 *
 * Request-side only: v1 ships request-side raw access only. Response
 * bytes (assistant SSE stream) are a future Plan E item.
 *
 * Defensive Zod cap: `length` is capped at 32_768 (32 KB) at the MCP
 * schema layer so the SDK rejects oversize calls BEFORE the handler
 * runs. The data layer would silently clamp; we surface the cap as a
 * validation error for visibility.
 *
 * Short reads (past-EOF clamp): the data layer may return fewer bytes
 * than requested when `offset + length > bytes_total`. The envelope's
 * `length` reflects the ACTUAL bytes returned (not the requested
 * length) and `next_offset` propagates verbatim from the data layer
 * (`null` once EOF is reached, otherwise the next valid offset).
 *
 * AbortSignal: `getTurnRawChunk` validates `offset`/`length`
 * synchronously, then `getTurnRawChunkAsync` calls
 * `throwIfAborted(signal)` as its FIRST statement, before any DB or
 * fs I/O. The handler delegates and relies on that pre-abort check.
 */
import { getTurnRawChunk } from "@recondo/data";
import { z } from "zod";

import { buildRawByteEnvelope } from "../envelope/raw.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  turn_id: z.string().min(1),
  offset: z.number().int().min(0),
  length: z.number().int().min(1).max(32_768),
};

export const getTurnRawChunkInputSchema = z.object(inputShape);
export type GetTurnRawChunkInput = z.infer<typeof getTurnRawChunkInputSchema>;

const DESCRIPTION =
  "Return a raw bytes chunk from a turn's captured REQUEST-SIDE " +
  "payload. `length` is capped at 32 KB (32_768) at the schema layer; " +
  "walk the payload by following `next_offset` from each response. " +
  "Past-EOF reads return fewer bytes than requested and `next_offset` " +
  "becomes null. Bytes are base64-encoded inside a <captured_raw_bytes> " +
  "wrapper so adversarial input cannot break out of the envelope. " +
  "Request-side only in v1; response-side raw access is a future tool.";

export const getTurnRawChunkTool: ReadTool<GetTurnRawChunkInput, unknown> = {
  name: "recondo_get_turn_raw_chunk",
  description: DESCRIPTION,
  inputShape,
  inputSchema: getTurnRawChunkInputSchema,
  handler: async (input, ctx) => {
    const result = await getTurnRawChunk(
      input.turn_id,
      input.offset,
      input.length,
      { signal: ctx.abortSignal },
    );
    // Past-EOF clamp: the data layer may return fewer bytes than
    // `input.length`. Surface the ACTUAL bytes count to callers and
    // propagate `next_offset` verbatim so they can drive iteration.
    return buildRawByteEnvelope({
      turnId: input.turn_id,
      offset: input.offset,
      length: result.bytes.length,
      bytes: result.bytes,
      nextOffset: result.next_offset,
    });
  },
};
