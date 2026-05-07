/**
 * D-C1-13 — Bootstrap integration: spawn the built binary, exchange
 * JSON-RPC `initialize` over stdio, and assert:
 *   - capabilities advertise tools, prompts, resources
 *   - serverInfo.name === "recondo-mcp"
 *   - every line on stdout parses as JSON (no log bleed)
 *   - missing DATABASE_URL → non-zero exit + structured stderr error
 *
 * Skips when no DATABASE_URL is provided (orchestrator launches
 * `just dev-infra` before invoking pnpm test).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const BINARY = resolve(__dirname, "../../dist/bin/recondo-mcp.js");
const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(BINARY);

const describeIfReady =
  HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

function spawnBinary(env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [BINARY], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function readUntilResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs: number,
): Promise<{
  response: RpcMessage;
  stdoutLines: string[];
  stderr: string;
}> {
  return new Promise((resolveP, rejectP) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    const stdoutLines: string[] = [];
    const timer = setTimeout(() => {
      rejectP(new Error("timeout waiting for JSON-RPC response"));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuf += chunk.toString("utf8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (line.trim().length === 0) continue;
        stdoutLines.push(line);
        try {
          const msg = JSON.parse(line) as RpcMessage;
          if (msg.id === id) {
            clearTimeout(timer);
            resolveP({ response: msg, stdoutLines, stderr: stderrBuf });
            return;
          }
        } catch {
          clearTimeout(timer);
          rejectP(
            new Error(`stdout produced non-JSON line: ${line.slice(0, 200)}`),
          );
          return;
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });
  });
}

describeIfReady("D-C1-13 bootstrap integration", () => {
  it("responds to initialize with required capabilities + serverInfo", async () => {
    const child = spawnBinary({
      ...process.env,
      RECONDO_DEV_BYPASS: "1",
      NODE_ENV: "development",
      RECONDO_OBJECT_STORE_PATH:
        process.env.RECONDO_OBJECT_STORE_PATH ?? "/tmp/recondo-objects",
    });

    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" },
      },
    };
    child.stdin.write(JSON.stringify(init) + "\n");

    try {
      const { response, stdoutLines } = await readUntilResponse(
        child,
        1,
        10_000,
      );

      expect(response.error).toBeUndefined();
      const result = response.result as {
        capabilities: Record<string, unknown>;
        serverInfo: { name: string };
      };
      expect(result).toBeDefined();
      expect(result.capabilities).toBeDefined();
      expect(result.capabilities).toHaveProperty("tools");
      expect(result.capabilities).toHaveProperty("prompts");
      expect(result.capabilities).toHaveProperty("resources");
      expect(result.serverInfo.name).toBe("recondo-mcp");

      // Every stdout line so far must parse as JSON (no log bleed).
      for (const line of stdoutLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    } finally {
      child.kill();
      await new Promise((r) => child.once("close", r));
    }
  });

  it("exits non-zero with structured stderr error when DATABASE_URL missing", async () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    const child = spawnBinary({
      ...env,
      RECONDO_DEV_BYPASS: "1",
      NODE_ENV: "development",
      RECONDO_OBJECT_STORE_PATH:
        env.RECONDO_OBJECT_STORE_PATH ?? "/tmp/recondo-objects",
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const exitCode: number | null = await new Promise((r) => {
      child.once("close", (code) => r(code));
    });

    expect(exitCode).not.toBe(0);
    expect(stderr).toMatch(/DATABASE_URL/);
  });
});
