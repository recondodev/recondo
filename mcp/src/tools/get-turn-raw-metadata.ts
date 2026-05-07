/**
 * `recondo_get_turn_raw_metadata` — surface the data-layer's metadata
 * for raw bytes captured on a turn.
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
 * No wrapping: the metadata is metadata about captured content, not
 * captured content itself, so the captured-message envelope wrappers
 * are irrelevant here.
 *
 * AbortSignal: `getTurnRawMetadata` calls `throwIfAborted(signal)` as
 * its FIRST statement (turns-raw.ts:166), before any DB or fs I/O.
 * The handler delegates and relies on that pre-abort check.
 */
import { getTurnRawMetadata } from "@recondo/data";
import { z } from "zod";

import type { ReadTool } from "../registry/types.js";

const inputShape = {
  turn_id: z.string().min(1),
  side: z.enum(["request", "response"]),
};

export const getTurnRawMetadataInputSchema = z.object(inputShape);
export type GetTurnRawMetadataInput = z.infer<
  typeof getTurnRawMetadataInputSchema
>;

const DESCRIPTION =
  "Return metadata for the raw bytes captured on a turn (request or " +
  "response side): `content_hash` (SHA-256 of the captured payload), " +
  "`bytes_total` (uncompressed length), `content_type` (sniffed from " +
  "the head bytes), and `head_sample_utf8` (lossy UTF-8 preview of the " +
  "first few KB). Pair with `recondo_get_turn_raw_chunk` to stream the " +
  "full bytes when the head sample is not enough.";

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
