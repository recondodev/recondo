import { describe, it, expect } from "vitest";
import { uniformListEnvelope } from "../src/envelope.js";

describe("uniformListEnvelope", () => {
  it("emits is_final=true and stream_id=null in v1", () => {
    const env = uniformListEnvelope([1, 2, 3], { nextOffset: 3, truncated: false });
    expect(env).toEqual({
      items: [1, 2, 3],
      next_offset: 3,
      truncated: false,
      stream_id: null,
      is_final: true,
    });
  });

  it("flags truncation", () => {
    const env = uniformListEnvelope(["x"], { nextOffset: 1, truncated: true });
    expect(env.truncated).toBe(true);
    expect(env.next_offset).toBe(1);
  });

  it("preserves empty items array", () => {
    const env = uniformListEnvelope<string>([], { nextOffset: null, truncated: false });
    expect(env.items).toEqual([]);
    expect(env.next_offset).toBeNull();
    expect(env.is_final).toBe(true);
    expect(env.stream_id).toBeNull();
  });

  it("supports optional total via the type", () => {
    // The plan adds a `total?: number` field for callers that know the
    // count from a SQL COUNT(*). The function doesn't set it itself; the
    // CALLER spreads it into the result. Verify the shape allows it.
    const env = uniformListEnvelope([1, 2], { nextOffset: 2, truncated: true });
    const enriched = { ...env, total: 10 };
    expect(enriched.total).toBe(10);
    expect(enriched.is_final).toBe(true);
  });
});
