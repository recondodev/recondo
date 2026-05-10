import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("C6 move completeness (anomalies + cost + audit)", () => {
  it("api/src/resolvers/anomalies.ts contains zero pool.query() calls", () => {
    const src = readFileSync(resolve(REPO_ROOT, "api/src/resolvers/anomalies.ts"), "utf8");
    expect(src).not.toMatch(/pool\.query\(/);
  });

  it("api/src/resolvers/cost.ts contains zero pool.query() calls", () => {
    const src = readFileSync(resolve(REPO_ROOT, "api/src/resolvers/cost.ts"), "utf8");
    expect(src).not.toMatch(/pool\.query\(/);
  });

  it("api/src/resolvers/audit.ts contains zero pool.query() calls", () => {
    const src = readFileSync(resolve(REPO_ROOT, "api/src/resolvers/audit.ts"), "utf8");
    expect(src).not.toMatch(/pool\.query\(/);
  });

  it("api/src/resolvers/anomalies.ts is shrunk to <=80 lines", () => {
    const src = readFileSync(resolve(REPO_ROOT, "api/src/resolvers/anomalies.ts"), "utf8");
    expect(src.split("\n").length).toBeLessThanOrEqual(80);
  });

  it("api/src/resolvers/cost.ts is shrunk to <=140 lines", () => {
    // Cost has 6 resolver functions; each is ~15-20 lines after thinning.
    const src = readFileSync(resolve(REPO_ROOT, "api/src/resolvers/cost.ts"), "utf8");
    expect(src.split("\n").length).toBeLessThanOrEqual(140);
  });

  it("api/src/resolvers/audit.ts is shrunk to <=80 lines", () => {
    const src = readFileSync(resolve(REPO_ROOT, "api/src/resolvers/audit.ts"), "utf8");
    expect(src.split("\n").length).toBeLessThanOrEqual(80);
  });

  it("each resolver file imports from @recondo/data", () => {
    for (const name of ["anomalies.ts", "cost.ts", "audit.ts"]) {
      const src = readFileSync(resolve(REPO_ROOT, `api/src/resolvers/${name}`), "utf8");
      expect(src).toMatch(/from\s+["']@recondo\/data["']/);
    }
  });
});
