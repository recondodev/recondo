/**
 * D-C11-4 — Phase 1 only: action-immutability check is a TODO that
 * references Phase 2 + the D-C13-8 row-count hashing integration test.
 *
 * Per C0 audit §5 Decision #4:
 *   "C11 ships `mcp/scripts/catalog-parity-lint.ts` Phase 1: name parity
 *    table + opt-out set. The action-immutability lint becomes a TODO
 *    comment referencing the Phase 2 future work AND the D-C13-8
 *    integration test (so an operator reading the lint understands the
 *    immutability invariant is enforced elsewhere)."
 *
 * This test reads the script source on disk and asserts:
 *   1. There is a TODO/FIXME marker referencing Phase 2.
 *   2. The marker references `__tableTargets` (the deferred mechanism).
 *   3. The marker references `D-C13-8` (the load-bearing replacement).
 *   4. NO action-immutability check is implemented in Phase 1 — i.e. the
 *      script does NOT contain runtime code that walks
 *      ACTION_TOOL_TO_DATA_FN against `__tableTargets` or against any
 *      "captured tables" allow-list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(
  __dirname,
  "../../src/scripts/catalog-parity-lint.ts",
);

describe("D-C11-4 Phase 2 TODO marker", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");

  it("references Phase 2 in a TODO/FIXME comment", () => {
    // Must contain a TODO or FIXME marker.
    expect(/\b(TODO|FIXME)\b/.test(source)).toBe(true);
    // Must mention Phase 2 within the same script (case-insensitive).
    expect(/phase\s*2/i.test(source)).toBe(true);
  });

  it("references __tableTargets (deferred Phase 2 mechanism)", () => {
    expect(source.includes("__tableTargets")).toBe(true);
  });

  it("references D-C13-8 (the replacement integration test)", () => {
    // The audit doc names the test deliverable D-C13-8 — the row-count
    // hashing assertion that supersedes Phase 2 source-code metadata.
    expect(/D-?C13-?8/i.test(source)).toBe(true);
  });

  it("does NOT implement an action-immutability runtime check", () => {
    // The Phase 1 script must not silently ship a half-finished
    // immutability check — that work belongs to D-C13-8 (row-count
    // hashing) per the C0 audit decision.
    //
    // We grep for tell-tale identifiers that would only exist in a
    // Phase 2 implementation. None of these may appear as live code
    // (presence inside a comment is fine — the TODO references some
    // of them, so we assert the runtime form is absent).
    //
    // A `function ...immutability...(` declaration would be a runtime
    // check. A `const CAPTURED_TABLES = [...]` array would be the
    // allow-list. Neither may appear.
    expect(/function\s+\w*[Ii]mmutab\w*\s*\(/.test(source)).toBe(false);
    expect(/const\s+CAPTURED_TABLES\s*=/.test(source)).toBe(false);
    expect(/CAPTURED_TABLES\s*\.\s*(includes|has)\s*\(/.test(source)).toBe(
      false,
    );
  });
});
