/**
 * D-C13-3 (integration) — Auth refusal in production mode.
 *
 * Spawn the binary WITHOUT `RECONDO_API_KEY`, WITHOUT
 * `RECONDO_DEV_BYPASS`, with `NODE_ENV=production`. The env loader
 * MUST refuse to boot — the message "RECONDO_API_KEY is required"
 * appears on stderr, and the process exits non-zero before any RPC
 * traffic is accepted.
 *
 * Skips when the binary isn't built. Does NOT need DATABASE_URL — the
 * env-loader's auth check fires before any DB pool is opened, so we
 * supply a placeholder DSN to satisfy the earlier `databaseUrl`
 * required check.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { RECONDO_MCP_BINARY } from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfBinary = HAVE_BINARY ? describe : describe.skip;

describeIfBinary("D-C13-3 auth refuses without key in production", () => {
  it("exits non-zero with stderr 'RECONDO_API_KEY is required'", async () => {
    // Build a minimal env: NO RECONDO_API_KEY, NO RECONDO_DEV_BYPASS,
    // NODE_ENV=production. We DO supply DATABASE_URL +
    // RECONDO_OBJECT_STORE_PATH so the auth-gate is the failure cause.
    const baseEnv: Record<string, string> = {
      DATABASE_URL:
        "postgres://placeholder:placeholder@127.0.0.1:0/placeholder",
      RECONDO_OBJECT_STORE_PATH: "/tmp/recondo-mcp-test-objects-auth-refuses",
      NODE_ENV: "production",
      // Inherit only PATH so node can find itself; do NOT inherit
      // process.env wholesale (vitest sets RECONDO_DEV_BYPASS).
      PATH: process.env.PATH ?? "",
    };

    const child = spawn(process.execPath, [RECONDO_MCP_BINARY], {
      env: baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once("close", (code, signal) => resolveExit({ code, signal }));
        // Safety timer — if the process somehow runs forever, kill it.
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 5000);
      },
    );

    expect(
      exit.code === null || exit.code === 0,
      `process should refuse to boot; got code=${exit.code} signal=${exit.signal}; stderr=${stderrBuf}`,
    ).toBe(false);
    expect(stderrBuf).toContain("RECONDO_API_KEY is required");
  });
});
