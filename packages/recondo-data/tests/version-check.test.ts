import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "version-check.mjs");

/**
 * Run version-check.mjs against a temp directory mocking the workspace
 * structure (packages/recondo-data/package.json + api/package.json).
 *
 * The implementer's script must accept a CWD argument or honor process.cwd()
 * so we can point it at the temp tree. If it hardcodes a path, the test
 * won't be drivable — that's an implementer constraint, NOT a test relaxation.
 */
function runCheck(opts: {
  dataVersion: string;
  apiDep: string | undefined; // undefined → don't declare @recondo/data dep
}): { status: number; stderr: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "recondo-vc-"));
  mkdirSync(join(dir, "packages", "recondo-data"), { recursive: true });
  mkdirSync(join(dir, "api"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });

  writeFileSync(
    join(dir, "packages", "recondo-data", "package.json"),
    JSON.stringify({ name: "@recondo/data", version: opts.dataVersion, private: true }),
  );
  const apiPkg: Record<string, unknown> = {
    name: "recondo-api",
    version: "0.0.1",
    private: true,
  };
  if (opts.apiDep !== undefined) {
    apiPkg.dependencies = { "@recondo/data": opts.apiDep };
  }
  writeFileSync(join(dir, "api", "package.json"), JSON.stringify(apiPkg));
  copyFileSync(SCRIPT, join(dir, "scripts", "version-check.mjs"));

  const r = spawnSync("node", ["scripts/version-check.mjs"], {
    cwd: dir,
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return { status: r.status ?? -1, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
}

describe("scripts/version-check.mjs", () => {
  it("exits 0 when api declares workspace:*", () => {
    const r = runCheck({ dataVersion: "0.0.1", apiDep: "workspace:*" });
    expect(r.status).toBe(0);
  });

  it("exits 0 when api declares matching workspace:^version", () => {
    const r = runCheck({ dataVersion: "0.0.1", apiDep: "workspace:^0.0.1" });
    expect(r.status).toBe(0);
  });

  it("exits 0 when api declares matching literal version", () => {
    const r = runCheck({ dataVersion: "0.0.1", apiDep: "0.0.1" });
    expect(r.status).toBe(0);
  });

  it("exits non-zero when api declares a drifted literal version", () => {
    const r = runCheck({ dataVersion: "0.0.1", apiDep: "0.0.5" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/0\.0\.5/);
    expect(r.stderr.toLowerCase()).toMatch(/api\/package\.json/);
  });

  it("exits 0 when api does not declare @recondo/data at all", () => {
    const r = runCheck({ dataVersion: "0.0.1", apiDep: undefined });
    expect(r.status).toBe(0);
  });
});
