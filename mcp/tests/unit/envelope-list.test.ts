/**
 * D-C1-11 — buildListEnvelope returns the canonical 5-key shape:
 *   { items, next_offset, truncated, stream_id: null, is_final: true }
 *
 * Object.keys must be EXACTLY the 5 keys (no extras, in any order).
 */
import { describe, it, expect } from "vitest";

import { buildListEnvelope } from "../../src/envelope/list.js";

describe("D-C1-11 buildListEnvelope", () => {
  it("returns 5-key shape with stream_id: null and is_final: true", () => {
    const env = buildListEnvelope({
      items: [{ a: 1 }, { b: 2 }],
      nextOffset: null,
      truncated: false,
    });
    expect(env).toEqual({
      items: [{ a: 1 }, { b: 2 }],
      next_offset: null,
      truncated: false,
      stream_id: null,
      is_final: true,
    });
  });

  it("Object.keys is EXACTLY the 5-key set", () => {
    const env = buildListEnvelope({
      items: [{ a: 1 }],
      nextOffset: 10,
      truncated: true,
    });
    const keys = Object.keys(env).sort();
    expect(keys).toEqual(
      ["is_final", "items", "next_offset", "stream_id", "truncated"].sort(),
    );
  });

  it("nextOffset=5 → next_offset:5, truncated:true → truncated:true", () => {
    const env = buildListEnvelope({
      items: [{ x: 1 }],
      nextOffset: 5,
      truncated: true,
    });
    expect(env.next_offset).toBe(5);
    expect(env.truncated).toBe(true);
    expect(env.stream_id).toBeNull();
    expect(env.is_final).toBe(true);
  });
});
