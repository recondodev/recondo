/**
 * D-C13-10 (integration) — End-to-end Claude-Code registration round-trip.
 *
 * Run `recondo-mcp config claude-code` to capture the JSON env config
 * the binary emits, parse it, then spawn the binary again with that
 * exact env (extracting DATABASE_URL + RECONDO_OBJECT_STORE_PATH).
 * Drive `initialize` → `tools/list` → `tools/call recondo_usage_summary`.
 * Every step must succeed.
 *
 * The proof: the config flavor's emitted env is sufficient to launch
 * a working server. If the config emitter ever drifts from the env
 * loader's required keys, this test fails.
 *
 * Preconditions: `just dev-infra` running + `just api-migrate` applied
 * + the mcp build is fresh.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
} from "../helpers/spawnMcp.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface ConfigShape {
  mcpServers: {
    recondo: {
      command: string;
      env: Record<string, string>;
    };
  };
}

interface ToolDefinition {
  name: string;
}

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

async function captureConfigOutput(
  envIn: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      process.execPath,
      [RECONDO_MCP_BINARY, "config", "claude-code"],
      {
        env: envIn,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectP);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error("config subcommand timeout"));
    }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}

describeIfReady("D-C13-10 claude-code registration round-trip", () => {
  it("emit config -> spawn with that env -> initialize/list/call all succeed", async () => {
    // Step 1: ask the binary to emit the claude-code registration JSON.
    // We need DATABASE_URL + RECONDO_OBJECT_STORE_PATH in the input env
    // so the config emitter has them to forward.
    const realDbUrl = process.env.DATABASE_URL!;
    const realObjPath =
      process.env.RECONDO_OBJECT_STORE_PATH ?? "/tmp/recondo-mcp-test-objects";

    const configEnv: Record<string, string> = {
      DATABASE_URL: realDbUrl,
      RECONDO_OBJECT_STORE_PATH: realObjPath,
      PATH: process.env.PATH ?? "",
    };
    const configResult = await captureConfigOutput(configEnv);
    expect(
      configResult.code,
      `config emit failed; stderr: ${configResult.stderr}`,
    ).toBe(0);

    // Step 2: parse the JSON.
    const parsed = JSON.parse(configResult.stdout.trim()) as ConfigShape;
    expect(parsed).toHaveProperty("mcpServers");
    expect(parsed.mcpServers).toHaveProperty("recondo");
    const recondo = parsed.mcpServers.recondo;
    expect(recondo.command).toBe("recondo-mcp");
    expect(recondo).toHaveProperty("env");
    expect(typeof recondo.env.DATABASE_URL).toBe("string");
    expect(recondo.env.DATABASE_URL).toBe(realDbUrl);
    expect(recondo.env.RECONDO_OBJECT_STORE_PATH).toBe(realObjPath);

    // Step 3: spawn the binary with that env (plus dev-bypass so we
    // skip the API key step — the config emitter intentionally does
    // NOT include RECONDO_API_KEY).
    const launchEnv: Record<string, string> = {
      ...recondo.env,
      RECONDO_DEV_BYPASS: "1",
      NODE_ENV: "development",
    };
    const mcp = await spawnMcp({ env: launchEnv });
    try {
      // Step 4: tools/list must succeed and return the read catalog.
      const list = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
      expect(Array.isArray(list.tools)).toBe(true);
      expect(list.tools.length).toBeGreaterThan(0);
      const names = new Set(list.tools.map((t) => t.name));
      expect(names.has("recondo_usage_summary")).toBe(true);

      // Step 5: tools/call recondo_usage_summary must succeed.
      const call = await mcp.request<CallToolResult>("tools/call", {
        name: "recondo_usage_summary",
        arguments: { period: "week" },
      });
      expect(call.isError).not.toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
