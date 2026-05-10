/**
 * Bootstrap integration for the remote MCP service.
 *
 * The binary starts a long-running Streamable HTTP endpoint. Bootstrap
 * coverage asserts that the helper can initialize a session and that
 * startup failures still surface as structured stderr.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { RECONDO_MCP_BINARY, spawnMcp } from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfBinary = HAVE_BINARY ? describe : describe.skip;

describeIfBinary("MCP HTTP bootstrap integration", () => {
  it("initializes an HTTP MCP session and exposes the tool catalog", async () => {
    const mcp = await spawnMcp({ devBypass: true });
    try {
      expect(mcp.sessionId).toBeTruthy();
      expect(mcp.child.exitCode).toBeNull();
      expect(mcp.child.signalCode).toBeNull();
      expect(mcp.stdoutLines).toEqual([]);

      const result = await mcp.request<{ tools: Array<{ name: string }> }>(
        "tools/list",
      );
      expect(result.tools.map((tool) => tool.name)).toContain(
        "recondo_list_sessions",
      );
    } finally {
      await mcp.close();
    }
  });

  it("exits non-zero with structured stderr error when DATABASE_URL missing", async () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const child = spawn(process.execPath, [RECONDO_MCP_BINARY], {
      env: {
        ...env,
        RECONDO_DEV_BYPASS: "1",
        NODE_ENV: "development",
        RECONDO_OBJECT_STORE_PATH:
          env.RECONDO_OBJECT_STORE_PATH ?? "/tmp/recondo-objects",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exitCode: number | null = await new Promise((resolve) => {
      child.once("close", (code) => resolve(code));
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, 5000);
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/DATABASE_URL/);
  });
});
