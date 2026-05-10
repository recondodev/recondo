/**
 * C9 contract: the 4 deprecated shim files at api/src/* must be DELETED.
 *
 * The user's standing directive is "no backward-compatibility scaffolding."
 * Internal consumers in api/src/ all import directly from "@recondo/data".
 *
 * If these paths re-appear, the deletion regressed.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("C9 shim deletion (no backward-compat scaffolding)", () => {
  const deletedShims = [
    "api/src/db.ts",
    "api/src/auth.ts",
    "api/src/placeholder-mask.ts",
    "api/src/resolvers/mappers.ts",
  ];

  for (const shim of deletedShims) {
    it(`${shim} no longer exists (deleted by C9)`, () => {
      const fullPath = resolve(REPO_ROOT, shim);
      expect(existsSync(fullPath)).toBe(false);
    });
  }
});
