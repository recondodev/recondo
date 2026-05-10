import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BUILDER_PATH = resolve(REPO_ROOT, "api/src/query/builder.ts");

describe("structured-query move completeness (D-Q5)", () => {
  it("api/src/query/builder.ts no longer contains the 8 private queryXxx functions", () => {
    const src = readFileSync(BUILDER_PATH, "utf8");
    // Each of these declarations should NOT be present (they moved to the package).
    const movedDeclarations = [
      /async\s+function\s+querySessions\s*\(/,
      /async\s+function\s+queryTurns\s*\(/,
      /async\s+function\s+queryAnomalies\s*\(/,
      /async\s+function\s+queryCost\s*\(/,
      /async\s+function\s+queryTools\s*\(/,
      /async\s+function\s+queryRisk\s*\(/,
      /async\s+function\s+queryCompliance\s*\(/,
      /async\s+function\s+queryProvenance\s*\(/,
    ];
    for (const re of movedDeclarations) {
      expect(src).not.toMatch(re);
    }
  });

  it("api/src/query/builder.ts is shrunk to under ~400 lines (was 1110)", () => {
    const src = readFileSync(BUILDER_PATH, "utf8");
    const lineCount = src.split("\n").length;
    // Pre-refactor was 1110. Plan target is ~250. Allow generous headroom of 400.
    expect(lineCount).toBeLessThanOrEqual(400);
  });

  it("api/src/query/builder.ts still imports runStructuredQuery from @recondo/data", () => {
    const src = readFileSync(BUILDER_PATH, "utf8");
    expect(src).toMatch(/from\s+["']@recondo\/data["']/);
    expect(src).toMatch(/runStructuredQuery/);
  });
});
