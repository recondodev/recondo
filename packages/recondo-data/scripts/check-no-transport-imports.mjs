#!/usr/bin/env node
// Architecture lint: @recondo/data must own zero transport surface.
// Mirror of the gateway's xtask `lint-arch` for the TypeScript side.
//
// Resolves the package src dir from process.cwd() so test harnesses can
// drive us against a temp tree. We try two candidate locations:
//   1. <cwd>/packages/recondo-data/src  (repo-root invocation, e.g. test harness)
//   2. <cwd>/src                        (package-root invocation, e.g. `pnpm test`)
// First one that exists wins. If neither exists, exit clean — there is
// nothing to scan in this tree.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";

const FORBIDDEN = [
  "graphql",
  "@apollo/server",
  "@as-integrations/fastify",
  "fastify",
  "express",
  "@modelcontextprotocol/sdk",
  "ws",
];

const candidatePaths = [
  resolve(process.cwd(), "packages", "recondo-data", "src"),
  resolve(process.cwd(), "src"),
];
let PKG_SRC = null;
for (const p of candidatePaths) {
  if (existsSync(p)) {
    PKG_SRC = p;
    break;
  }
}
if (PKG_SRC === null) {
  console.log("@recondo/data: no src dir found under cwd; nothing to lint");
  process.exit(0);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (full.endsWith(".ts")) yield full;
  }
}

/**
 * Strip line and block comments from a TS source blob. String literals
 * are preserved — we rely on the structural grammar of the import-from
 * regex (which requires the `from` or `import` keyword followed by a
 * quoted module path) to discriminate real imports from incidental
 * string contents.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < src.length - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const offenders = [];
for (const file of walk(PKG_SRC)) {
  const raw = readFileSync(file, "utf8");
  const noComments = stripComments(raw);
  for (const dep of FORBIDDEN) {
    const escaped = dep.replace(/[.@/]/g, "\\$&");
    // ES `import ... from "dep"` and bare `import "dep"`. The leading
    // boundary `(?:^|[^A-Za-z0-9_$])` prevents matches against words
    // that merely END in `from` or `import` (e.g. `transform`, `imports`).
    const importRe = new RegExp(
      `(?:^|[^A-Za-z0-9_$])(?:from|import)\\s*["']${escaped}(?:/[^"']*)?["']`,
      "m",
    );
    // CommonJS: `require("dep")`
    const requireRe = new RegExp(
      `(?:^|[^A-Za-z0-9_$])require\\s*\\(\\s*["']${escaped}(?:/[^"']*)?["']\\s*\\)`,
      "m",
    );
    if (importRe.test(noComments) || requireRe.test(noComments)) {
      const rel = relative(process.cwd(), file);
      offenders.push({ file: rel, dep });
    }
  }
}

if (offenders.length > 0) {
  console.error("@recondo/data: transport-layer imports detected (forbidden):");
  for (const o of offenders) {
    console.error(`  ${o.file} → ${o.dep}`);
  }
  console.error(
    "\nThe package owns nothing transport-shaped (no HTTP, no GraphQL, no MCP).\n" +
      "Move the transport-touching code into the consumer (api/src or mcp/src).",
  );
  process.exit(1);
}
console.log("@recondo/data: no transport imports detected");
