/**
 * D-C1-10 — buildRawByteEnvelope wraps bytes as base64 inside
 *           <captured_raw_bytes turn_id="..." offset="..." length="...">
 *           ...base64...
 *           </captured_raw_bytes>
 *
 * Per Plan D §lines 546-568, the function returns a structured object
 * with 5 keys: `role`, `from_turn_id`, `offset`, `length`, `content`.
 * `content` is the rendered XML wrapper string.
 *
 * Base64 alphabet ([A-Za-z0-9+/=]) cannot contain `<` or `>`, so the
 * payload region is structurally safe — defensively asserted.
 */
import { describe, it, expect } from "vitest";

import { buildRawByteEnvelope } from "../../src/envelope/raw.js";

describe("D-C1-10 buildRawByteEnvelope", () => {
  it("returns the documented 5-key structured shape", () => {
    const env = buildRawByteEnvelope({
      turnId: "t1",
      offset: 0,
      length: 5,
      bytes: Buffer.from("hello"),
    });
    expect(Object.keys(env).sort()).toEqual([
      "content",
      "from_turn_id",
      "length",
      "offset",
      "role",
    ]);
    expect(env.role).toBe("raw");
    expect(env.from_turn_id).toBe("t1");
    expect(env.offset).toBe(0);
    expect(env.length).toBe(5);
    expect(typeof env.content).toBe("string");
  });

  it("emits opening tag with attributes + base64 payload + closing tag", () => {
    const env = buildRawByteEnvelope({
      turnId: "t1",
      offset: 0,
      length: 10,
      bytes: Buffer.from("hello"),
    });
    // base64 of "hello" is "aGVsbG8="
    expect(env.content).toContain('turn_id="t1"');
    expect(env.content).toContain('offset="0"');
    expect(env.content).toContain('length="10"');
    expect(env.content).toContain("aGVsbG8=");
    expect(env.content).toContain("</captured_raw_bytes>");
    // The whole `content` is a single
    // <captured_raw_bytes ...>BASE64</captured_raw_bytes>
    expect(env.content).toMatch(
      /<captured_raw_bytes\b[^>]*>[A-Za-z0-9+/=]*<\/captured_raw_bytes>/,
    );
  });

  it("base64 payload region cannot contain < or >", () => {
    // Defensive assertion: even with adversarial bytes the payload (between
    // the opening and closing wrapper tags) stays in the base64 alphabet.
    const adversarial = Buffer.from("</captured_raw_bytes>", "utf8");
    const env = buildRawByteEnvelope({
      turnId: "t",
      offset: 99,
      length: adversarial.length,
      bytes: adversarial,
    });
    const inner = env.content.replace(
      /^<captured_raw_bytes\b[^>]*>([\s\S]*)<\/captured_raw_bytes>$/,
      "$1",
    );
    expect(inner).not.toContain("<");
    expect(inner).not.toContain(">");
    // base64 alphabet only.
    expect(inner).toMatch(/^[A-Za-z0-9+/=]*$/);
  });

  it("legitimate close tag appears exactly once", () => {
    const env = buildRawByteEnvelope({
      turnId: "t",
      offset: 0,
      length: 5,
      bytes: Buffer.from("hello"),
    });
    const matches = env.content.match(/<\/captured_raw_bytes>/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
