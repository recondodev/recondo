import { describe, it, expect } from "vitest";
import {
  mapSession,
  mapTurn,
  mapAnomaly,
  escapeIlike,
  formatTimestamp,
} from "../src/mappers.js";

describe("@recondo/data: mappers exports", () => {
  it("exports mapSession as a function", () => {
    expect(typeof mapSession).toBe("function");
  });

  it("exports mapTurn as a function", () => {
    expect(typeof mapTurn).toBe("function");
  });

  it("exports mapAnomaly as a function", () => {
    expect(typeof mapAnomaly).toBe("function");
  });

  it("exports escapeIlike as a function", () => {
    expect(typeof escapeIlike).toBe("function");
  });

  it("exports formatTimestamp as a function", () => {
    expect(typeof formatTimestamp).toBe("function");
  });
});

describe("@recondo/data mappers: escapeIlike", () => {
  it("escapes percent signs", () => {
    expect(escapeIlike("100%")).toBe("100\\%");
  });

  it("escapes underscores", () => {
    expect(escapeIlike("a_b_c")).toBe("a\\_b\\_c");
  });

  it("escapes backslashes", () => {
    expect(escapeIlike("path\\to\\file")).toBe("path\\\\to\\\\file");
  });

  it("passes through plain text unchanged", () => {
    expect(escapeIlike("hello world")).toBe("hello world");
  });

  it("escapes a mix of special characters", () => {
    expect(escapeIlike("100%_off\\")).toBe("100\\%\\_off\\\\");
  });
});

describe("@recondo/data mappers: formatTimestamp", () => {
  it("formats a Date to ISO 8601 string", () => {
    const d = new Date("2026-05-04T12:00:00.000Z");
    const result = formatTimestamp(d);
    expect(typeof result).toBe("string");
    // Should be ISO-shaped
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("handles null/undefined gracefully", () => {
    // The existing implementation may return null, undefined, or a placeholder.
    // The contract is: doesn't throw on missing input.
    expect(() => formatTimestamp(null as never)).not.toThrow();
    expect(() => formatTimestamp(undefined as never)).not.toThrow();
  });
});
