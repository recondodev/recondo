import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("C7 move completeness (compliance + realtime + agents + reports)", () => {
  const files = [
    { path: "api/src/resolvers/compliance.ts", maxLines: 100 },
    { path: "api/src/resolvers/realtime.ts", maxLines: 150 },
    { path: "api/src/resolvers/agents.ts", maxLines: 120 },
    { path: "api/src/resolvers/reports.ts", maxLines: 100 },
  ];

  for (const { path, maxLines } of files) {
    it(`${path} contains zero pool.query() calls`, () => {
      const src = readFileSync(resolve(REPO_ROOT, path), "utf8");
      expect(src).not.toMatch(/pool\.query\(/);
    });

    it(`${path} is shrunk to <=${maxLines} lines`, () => {
      const src = readFileSync(resolve(REPO_ROOT, path), "utf8");
      expect(src.split("\n").length).toBeLessThanOrEqual(maxLines);
    });

    it(`${path} imports from @recondo/data`, () => {
      const src = readFileSync(resolve(REPO_ROOT, path), "utf8");
      expect(src).toMatch(/from\s+["']@recondo\/data["']/);
    });
  }
});
