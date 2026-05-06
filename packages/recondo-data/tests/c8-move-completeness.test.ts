import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("C8 move completeness (policies + keys)", () => {
  const files = [
    { path: "api/src/resolvers/policies.ts", maxLines: 100 },
    { path: "api/src/resolvers/keys.ts", maxLines: 100 },
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
