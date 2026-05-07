/**
 * D-C11 (integration) — Catalog parity lint script runs end-to-end.
 *
 * Runs the COMPILED `dist/scripts/catalog-parity-lint.js` as a child
 * process. Asserts:
 *   - exit code 0 (parity holds)
 *   - the script emits a recognisable success message on stdout or
 *     stderr (humans should be able to tell the run succeeded)
 *
 * The script is invoked via `node dist/scripts/catalog-parity-lint.js`.
 * The implementer is free to put the entry point behind an
 * `if (import.meta.url === ...)` guard so the same module can also be
 * imported by the unit tests; either approach must produce the same
 * exit-code-0-on-success behaviour.
 *
 * Skipped when the binary tree is missing — `pnpm build` rebuilds it.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(
  __dirname,
  "../../dist/scripts/catalog-parity-lint.js",
);

const HAVE_SCRIPT = existsSync(SCRIPT_PATH);
const describeIfReady = HAVE_SCRIPT ? describe : describe.skip;

describeIfReady("D-C11 catalog-parity-lint integration", () => {
  it("exits 0 when name parity holds", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(
      result.status,
      `lint failed (status=${result.status})\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    ).toBe(0);
  });

  it("emits a recognisable success message on stdout or stderr", () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH], {
      encoding: "utf8",
      env: { ...process.env },
    });
    const blob = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    // The implementer chooses the exact phrasing; we accept any of:
    //   "parity holds" / "parity ok" / "lint passed" / "no violations"
    // (case-insensitive).
    const ok = /(parity (holds|ok)|lint passed|no violations|catalog parity)/i.test(
      blob,
    );
    expect(
      ok,
      `expected a parity-success message in stdout/stderr, got: ${blob.slice(0, 300)}`,
    ).toBe(true);
  });
});
