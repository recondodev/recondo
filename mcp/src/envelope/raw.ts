/**
 * Raw-byte envelope construction.
 *
 * Wraps a `Buffer` slice as base64 inside
 *   <captured_raw_bytes turn_id="..." offset="..." length="...">
 *   ...base64...
 *   </captured_raw_bytes>
 *
 * The base64 alphabet ([A-Za-z0-9+/=]) cannot contain `<` or `>`, so
 * even adversarial input bytes can never break out of the wrapper.
 *
 * Per Plan D §lines 546-568, this returns a structured object exposing
 * the routing metadata (role/from_turn_id/offset/length) alongside the
 * pre-rendered `content` string. Consumers can serialise the object as
 * JSON for envelopes that group multiple raw chunks.
 */

import { escapeAttr } from "./xml.js";

export interface RawByteEnvelopeArgs {
  turnId: string;
  offset: number;
  length: number;
  bytes: Buffer;
}

export interface RawByteEnvelope {
  role: "raw";
  from_turn_id: string;
  offset: number;
  length: number;
  /** `<captured_raw_bytes ...>BASE64</captured_raw_bytes>` */
  content: string;
}

export function buildRawByteEnvelope(args: RawByteEnvelopeArgs): RawByteEnvelope {
  const turnIdAttr = escapeAttr(args.turnId);
  const offset = Number.isFinite(args.offset) ? Math.trunc(args.offset) : 0;
  const length = Number.isFinite(args.length) ? Math.trunc(args.length) : 0;
  const b64 = args.bytes.toString("base64");
  const content =
    `<captured_raw_bytes turn_id="${turnIdAttr}" offset="${offset}" length="${length}">` +
    b64 +
    `</captured_raw_bytes>`;
  return {
    role: "raw",
    from_turn_id: args.turnId,
    offset,
    length,
    content,
  };
}
