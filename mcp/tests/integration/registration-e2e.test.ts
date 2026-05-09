/**
 * Remote registration round-trip.
 *
 * Start the long-running MCP service, ask `recondo-mcp config` to emit
 * a registration snippet for that service URL, and then prove the
 * service behind the emitted URL answers the normal tool catalog.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
} from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_BINARY ? describe : describe.skip;

interface ConfigShape {
  mcpServers: {
    recondo: {
      type: string;
      url: string;
      headers: Record<string, string>;
    };
  };
}

interface ToolDefinition {
  name: string;
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

describeIfReady("remote registration round-trip", () => {
  it("emit config for a running server URL -> tools/list succeeds", async () => {
    const mcp = await spawnMcp({ devBypass: true });
    try {
      const configEnv: Record<string, string> = {
        RECONDO_MCP_URL: `${mcp.baseUrl}/mcp`,
        PATH: process.env.PATH ?? "",
      };
      const configResult = await captureConfigOutput(configEnv);
      expect(
        configResult.code,
        `config emit failed; stderr: ${configResult.stderr}`,
      ).toBe(0);

      const parsed = JSON.parse(configResult.stdout.trim()) as ConfigShape;
      expect(parsed.mcpServers.recondo).toMatchObject({
        type: "streamable-http",
        url: `${mcp.baseUrl}/mcp`,
      });
      expect(parsed.mcpServers.recondo).not.toHaveProperty("headers");

      const list = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
      expect(Array.isArray(list.tools)).toBe(true);
      expect(list.tools.length).toBeGreaterThan(0);
      const names = new Set(list.tools.map((t) => t.name));
      expect(names.has("recondo_usage_summary")).toBe(true);
    } finally {
      await mcp.close();
    }
  });
});
