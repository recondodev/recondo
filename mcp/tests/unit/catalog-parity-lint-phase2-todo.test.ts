/**
 * D-HARD — action-immutability lint is implemented, not deferred.
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

describe("D-HARD catalog parity action-immutability lint", () => {
  const source = readFileSync(SCRIPT_PATH, "utf8");

  it("does not leave the action-immutability work as a TODO", () => {
    expect(/\b(TODO|FIXME)\b.*action-immutability/i.test(source)).toBe(false);
  });

  it("uses TABLE_TARGETS metadata", () => {
    expect(source.includes("TABLE_TARGETS")).toBe(true);
  });

  it("emits the action_writes_captured_table violation kind", () => {
    expect(source).toContain("action_writes_captured_table");
  });
});
