import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SESSIONS_RESOLVER = resolve(REPO_ROOT, "api/src/resolvers/sessions.ts");
const TURNS_RESOLVER = resolve(REPO_ROOT, "api/src/resolvers/turns.ts");

describe("sessions+turns move completeness (D-S12)", () => {
  it("api/src/resolvers/sessions.ts contains zero pool.query() calls", () => {
    const src = readFileSync(SESSIONS_RESOLVER, "utf8");
    expect(src).not.toMatch(/pool\.query\(/);
  });

  it("api/src/resolvers/turns.ts contains zero pool.query() calls", () => {
    const src = readFileSync(TURNS_RESOLVER, "utf8");
    expect(src).not.toMatch(/pool\.query\(/);
  });

  it("api/src/resolvers/sessions.ts is shrunk to <=120 lines (was ~563)", () => {
    const src = readFileSync(SESSIONS_RESOLVER, "utf8");
    expect(src.split("\n").length).toBeLessThanOrEqual(120);
  });

  it("api/src/resolvers/turns.ts is shrunk to <=120 lines (was ~544)", () => {
    const src = readFileSync(TURNS_RESOLVER, "utf8");
    expect(src.split("\n").length).toBeLessThanOrEqual(120);
  });

  it("api/src/resolvers/sessions.ts imports from @recondo/data", () => {
    const src = readFileSync(SESSIONS_RESOLVER, "utf8");
    expect(src).toMatch(/from\s+["']@recondo\/data["']/);
  });

  it("api/src/resolvers/turns.ts imports from @recondo/data", () => {
    const src = readFileSync(TURNS_RESOLVER, "utf8");
    expect(src).toMatch(/from\s+["']@recondo\/data["']/);
  });
});
