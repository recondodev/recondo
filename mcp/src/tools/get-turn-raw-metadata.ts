/**
 * `recondo_get_turn_raw_metadata` — surface the data-layer's metadata
 * for raw REQUEST-SIDE bytes captured on a turn.
 *
 * Thin pass-through to `getTurnRawMetadata(turnId, options)` from
 * `@recondo/data` (turns-raw.ts). Returns the data-layer record
 * verbatim:
 *
 *   { content_hash, bytes_total, content_type, head_sample_utf8 }
 *
 * The canonical sample-field name is `head_sample_utf8`. Plan D's
 * `head_sample_bytes` was drift; we MUST NOT rename, alias, or fall
 * back to the wrong name.
 *
 * Request-side only: v1 ships request-side raw access only. Response
 * bytes (assistant SSE stream) are a future Plan E item — they need a
 * separate column path AND a streaming-decode story.
 *
 * No wrapping: the metadata is metadata about captured content, not
 * captured content itself, so the captured-message envelope wrappers
 * are irrelevant here.
 *
 * AbortSignal: `getTurnRawMetadata` calls `throwIfAborted(signal)` as
 * its FIRST statement, before any DB or fs I/O. The handler delegates
 * and relies on that pre-abort check.
 */
import { getTurnRawMetadata } from "@recondo/data";
import { z } from "zod";

import type { ReadTool } from "../registry/types.js";

const inputShape = {
  turn_id: z.string().min(1),
};

export const getTurnRawMetadataInputSchema = z.object(inputShape);
export type GetTurnRawMetadataInput = z.infer<
  typeof getTurnRawMetadataInputSchema
>;

const DESCRIPTION =
  "Return metadata for the raw REQUEST-SIDE bytes captured on a turn: " +
  "`content_hash` (SHA-256 of the captured payload), `bytes_total` " +
  "(uncompressed length), `content_type` (sniffed from the head bytes), " +
  "and `head_sample_utf8` (lossy UTF-8 preview of the first few KB). " +
  "Request-side only in v1; response-side raw access is a future tool. " +
  "Pair with `recondo_get_turn_raw_chunk` to stream the full bytes when " +
  "the head sample is not enough.";

export const getTurnRawMetadataTool: ReadTool<
  GetTurnRawMetadataInput,
  unknown
> = {
  name: "recondo_get_turn_raw_metadata",
  description: DESCRIPTION,
  inputShape,
  inputSchema: getTurnRawMetadataInputSchema,
  handler: async (input, ctx) => {
    return await getTurnRawMetadata(input.turn_id, {
      signal: ctx.abortSignal,
    });
  },
};
