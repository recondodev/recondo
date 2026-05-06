import { describe, it, expect } from "vitest";
import { encodeSinceCursor, decodeSinceCursor } from "../src/envelope.js";
import type { SinceCursor } from "../src/types.js";

describe("since-cursor codec", () => {
  it("round-trips (timestamp, id)", () => {
    const enc = encodeSinceCursor({ ts: "2026-05-04T12:00:00.000Z", id: "abc-123" });
    const dec = decodeSinceCursor(enc);
    expect(dec).toEqual({ ts: "2026-05-04T12:00:00.000Z", id: "abc-123" });
  });

  it("encodes to a non-empty base64url string", () => {
    const enc = encodeSinceCursor({ ts: "2026-05-04T12:00:00.000Z", id: "x" });
    expect(typeof enc).toBe("string");
    expect((enc as string).length).toBeGreaterThan(0);
    // base64url is URL-safe — no '+', '/', '=' padding
    expect(enc as string).not.toMatch(/[+/=]/);
  });

  it("rejects encoding when ts is missing", () => {
    expect(() => encodeSinceCursor({ ts: "", id: "x" } as never)).toThrow();
  });

  it("rejects encoding when id is missing", () => {
    expect(() => encodeSinceCursor({ ts: "2026-05-04T12:00:00.000Z", id: "" } as never)).toThrow();
  });

  it("rejects decoding non-base64url input", () => {
    // base64url with invalid chars
    expect(() => decodeSinceCursor("not a cursor!" as SinceCursor))
      .toThrow(/invalid since cursor/i);
  });

  it("rejects decoding base64url that decodes to non-JSON", () => {
    const bad = Buffer.from("not json at all").toString("base64url") as SinceCursor;
    expect(() => decodeSinceCursor(bad)).toThrow();
  });

  it("rejects decoding payloads missing ts", () => {
    const bad = Buffer.from(JSON.stringify({ id: "x" })).toString("base64url") as SinceCursor;
    expect(() => decodeSinceCursor(bad)).toThrow();
  });

  it("rejects decoding payloads missing id", () => {
    const bad = Buffer.from(JSON.stringify({ ts: "2026-05-04T12:00:00.000Z" })).toString("base64url") as SinceCursor;
    expect(() => decodeSinceCursor(bad)).toThrow();
  });

  it("rejects decoding payloads with non-string ts/id", () => {
    const bad = Buffer.from(JSON.stringify({ ts: 12345, id: "x" })).toString("base64url") as SinceCursor;
    expect(() => decodeSinceCursor(bad)).toThrow();
  });
});
