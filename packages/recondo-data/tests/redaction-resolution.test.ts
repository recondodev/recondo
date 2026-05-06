import { describe, it, expect } from "vitest";
import {
  maskPlaceholderPaths,
  placeholderLikePatterns,
  MASKED_PLACEHOLDER_REPLACEMENT,
} from "../src/redaction/placeholder-mask.js";

describe("@recondo/data redaction: file resolution", () => {
  it("loads shared/placeholder-prefixes.json from the package src location", () => {
    // If the path-walk fails, the import above throws at module-load and
    // this test never runs. The fact that it runs at all proves the file
    // was found.
    expect(MASKED_PLACEHOLDER_REPLACEMENT).toBeDefined();
    expect(typeof MASKED_PLACEHOLDER_REPLACEMENT).toBe("string");
  });

  it("placeholderLikePatterns is a non-empty array", () => {
    expect(Array.isArray(placeholderLikePatterns)).toBe(true);
    expect(placeholderLikePatterns.length).toBeGreaterThan(0);
  });

  it("maskPlaceholderPaths is callable and returns a string", () => {
    const result = maskPlaceholderPaths("hello world");
    expect(typeof result).toBe("string");
  });
});
