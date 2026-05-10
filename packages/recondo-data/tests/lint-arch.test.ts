import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SCRIPT = resolve(
  REPO_ROOT,
  "packages",
  "recondo-data",
  "scripts",
  "check-no-transport-imports.mjs",
);

/**
 * Run lint-arch script in a temp tree containing only the supplied src files.
 * The script must accept a configurable root (CWD or arg) so we can target it.
 */
function runLint(srcFiles: Record<string, string>): {
  status: number;
  stderr: string;
  stdout: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "recondo-lint-"));
  const pkgRoot = join(dir, "packages", "recondo-data");
  mkdirSync(join(pkgRoot, "src"), { recursive: true });
  mkdirSync(join(pkgRoot, "scripts"), { recursive: true });
  for (const [path, content] of Object.entries(srcFiles)) {
    const full = join(pkgRoot, "src", path);
    mkdirSync(resolve(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  copyFileSync(SCRIPT, join(pkgRoot, "scripts", "check-no-transport-imports.mjs"));

  const r = spawnSync("node", ["packages/recondo-data/scripts/check-no-transport-imports.mjs"], {
    cwd: dir,
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status ?? -1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

describe("packages/recondo-data/scripts/check-no-transport-imports.mjs", () => {
  it("exits 0 when src contains only safe code", () => {
    const r = runLint({
      "index.ts": `export const greeting = "hello";`,
      "pool.ts": `import { Pool } from "pg";\nexport function getPool() { return new Pool(); }`,
    });
    expect(r.status).toBe(0);
  });

  it("exits non-zero when a file imports graphql", () => {
    const r = runLint({
      "index.ts": `import { GraphQLError } from "graphql";\nexport const x = GraphQLError;`,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toMatch(/index\.ts/);
    expect(r.stderr.toLowerCase()).toMatch(/graphql/);
  });

  it("exits non-zero on @apollo/server import", () => {
    const r = runLint({
      "auth.ts": `import { ApolloServer } from "@apollo/server";\nexport const x = ApolloServer;`,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/@apollo\/server/);
  });

  it("exits non-zero on fastify import", () => {
    const r = runLint({
      "x.ts": `import Fastify from "fastify";\nexport const x = Fastify;`,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/fastify/);
  });

  it("exits non-zero on @modelcontextprotocol/sdk import", () => {
    const r = runLint({
      "x.ts": `import { Server } from "@modelcontextprotocol/sdk/server/index.js";\nexport const x = Server;`,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/modelcontextprotocol/);
  });

  it("exits non-zero on require() of a forbidden dep", () => {
    const r = runLint({
      "x.ts": `const Fastify = require("fastify");\nexport const x = Fastify;`,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/fastify/);
  });

  it("does NOT flag forbidden names that appear only inside comments", () => {
    const r = runLint({
      "x.ts": `// from "graphql" — this is a comment, not a real import.\nexport const x = 1;`,
    });
    expect(r.status).toBe(0);
  });

  it("does NOT flag forbidden names inside string literals (not import statements)", () => {
    const r = runLint({
      "x.ts": `export const note = "we forbid graphql imports here";`,
    });
    expect(r.status).toBe(0);
  });

  it("flags a file even if a safe file is also present (multi-file scan)", () => {
    const r = runLint({
      "safe.ts": `export const safe = 1;`,
      "bad.ts": `import { GraphQLError } from "graphql";\nexport const x = GraphQLError;`,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/bad\.ts/);
  });
});
