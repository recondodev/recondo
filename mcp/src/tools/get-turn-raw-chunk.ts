/**
 * `recondo_get_turn_raw_chunk` — return a slice of the raw bytes
 * captured on a turn, base64-encoded inside a `<captured_raw_bytes>`
 * wrapper.
 *
 * Delegates to `getTurnRawChunk(turnId, offset, length, options)` from
 * `@recondo/data` (turns-raw.ts) and wraps the returned `Buffer` via
 * `buildRawByteEnvelope` — `{ role, from_turn_id, offset, length,
 * content }`. The base64 alphabet contains no `<`/`>` so adversarial
 * input bytes can never break out of the wrapper tag.
 *
 * Defensive Zod cap: `length` is capped at 32_768 (32 KB) at the MCP
 * schema layer so the SDK rejects oversize calls BEFORE the handler
 * runs. The data layer would silently clamp; we surface the cap as a
 * validation error for visibility.
 *
 * AbortSignal: `getTurnRawChunk` validates `offset`/`length`
 * synchronously, then `getTurnRawChunkAsync` calls
 * `throwIfAborted(signal)` as its FIRST statement (turns-raw.ts:220),
 * before any DB or fs I/O. The handler delegates and relies on that
 * pre-abort check.
 */
import { getTurnRawChunk } from "@recondo/data";
import { z } from "zod";

import { buildRawByteEnvelope } from "../envelope/raw.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  turn_id: z.string().min(1),
  side: z.enum(["request", "response"]),
  offset: z.number().int().min(0),
  length: z.number().int().min(1).max(32_768),
};

export const getTurnRawChunkInputSchema = z.object(inputShape);
export type GetTurnRawChunkInput = z.infer<typeof getTurnRawChunkInputSchema>;

const DESCRIPTION =
  "Return a raw bytes chunk from a turn's captured request or response " +
  "payload. `length` is capped at 32 KB (32_768) at the schema layer; " +
  "use `offset` and the previous response's reported length to walk " +
  "the full payload. Bytes are base64-encoded inside a " +
  "<captured_raw_bytes> wrapper so adversarial input cannot break out " +
  "of the envelope.";

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
    return buildRawByteEnvelope({
      turnId: input.turn_id,
      offset: input.offset,
      length: input.length,
      bytes: result.bytes,
    });
  },
};
