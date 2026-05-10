#!/usr/bin/env node
// Risk #2: enforce that all workspace packages declaring a dep on
// @recondo/data are pinned to the in-tree version. Fails CI on drift.
//
// Resolves paths from process.cwd() so test harnesses can point us at
// a temp tree mocking the workspace structure.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();

const dataPkgPath = resolve(root, "packages/recondo-data/package.json");
const dataPkg = JSON.parse(readFileSync(dataPkgPath, "utf8"));
const expected = dataPkg.version;

const consumers = [
  "api/package.json",
  // "mcp/package.json",  // uncomment when Plan D lands
];

let failed = false;
for (const rel of consumers) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolve(root, rel), "utf8"));
  } catch {
    // consumer doesn't exist in this tree — skip silently
    continue;
  }
  const dep =
    pkg.dependencies?.["@recondo/data"] ??
    pkg.devDependencies?.["@recondo/data"];
  if (dep === undefined) continue;
  const acceptable =
    dep === "workspace:*" ||
    dep === `workspace:^${expected}` ||
    dep === `workspace:~${expected}` ||
    dep === expected;
  if (!acceptable) {
    console.error(
      `${rel}: @recondo/data declared as ${dep}, expected workspace:* or ${expected}`,
    );
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`version-check: all consumers pinned to @recondo/data ${expected}`);
