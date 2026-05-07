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
 */

export interface RawByteEnvelopeArgs {
  turnId: string;
  offset: number;
  length: number;
  bytes: Buffer;
}

/**
 * Escape an attribute value: `&`, `"`, `<`, `>` -> entity refs.
 * Order matters — `&` first so we don't double-escape.
 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildRawByteEnvelope(args: RawByteEnvelopeArgs): string {
  const turnIdAttr = escapeAttr(args.turnId);
  const offset = Number.isFinite(args.offset) ? Math.trunc(args.offset) : 0;
  const length = Number.isFinite(args.length) ? Math.trunc(args.length) : 0;
  const b64 = args.bytes.toString("base64");
  return (
    `<captured_raw_bytes turn_id="${turnIdAttr}" offset="${offset}" length="${length}">` +
    b64 +
    `</captured_raw_bytes>`
  );
}
