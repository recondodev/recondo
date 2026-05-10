/**
 * D-C2-1 — Self-test for the `spawnMcp` integration helper.
 *
 * Skips when DATABASE_URL or the built binary aren't available.
 *
 * The helper is the foundation for every C2+ integration test, so it
 * must hold contracts:
 *   - spawnMcp({devBypass:true}) resolves only after `initialize` round-trips.
 *   - request() correlates by id even when calls overlap.
 *   - close() resolves within a few seconds.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";

import { spawnMcp, RECONDO_MCP_BINARY } from "../helpers/spawnMcp.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;
const describeIfBinary = HAVE_BINARY ? describe : describe.skip;

async function waitForHealth(
  mcp: {
    readonly baseUrl: string;
    readonly child: {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    readonly stderr: string;
  },
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (mcp.child.exitCode !== null || mcp.child.signalCode !== null) {
      throw new Error(
        `recondo-mcp exited before healthcheck; code=${mcp.child.exitCode} signal=${mcp.child.signalCode}; stderr=${mcp.stderr}`,
      );
    }
    try {
      const res = await fetch(`${mcp.baseUrl}/healthz`);
      if (res.ok) return;
      lastErr = new Error(`health status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for MCP healthcheck: ${String(lastErr)}`);
}

describeIfBinary("Group B spawnMcp helper auth defaults", () => {
  it("default spawn does not inject dev-bypass or NODE_ENV=development", async () => {
    const previousBypass = process.env.RECONDO_DEV_BYPASS;
    const previousNodeEnv = process.env.NODE_ENV;
    const previousApiKey = process.env.RECONDO_API_KEY;
    process.env.RECONDO_DEV_BYPASS = "1";
    process.env.NODE_ENV = "development";
    delete process.env.RECONDO_API_KEY;
    const mcp = await spawnMcp({
      initialize: false,
      env: {
        DATABASE_URL: "postgres://placeholder:placeholder@127.0.0.1:0/placeholder",
        RECONDO_OBJECT_STORE_PATH: "/tmp/recondo-objects",
        RECONDO_API_KEY: "",
      },
      timeoutMs: 500,
    });
    try {
      await waitForHealth(mcp, 5000);
      const res = await fetch(`${mcp.baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "spawn-helper-auth-defaults", version: "0" },
          },
        }),
      });
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("Authorization");
    } finally {
      await mcp.close();
      if (previousBypass === undefined) {
        delete process.env.RECONDO_DEV_BYPASS;
      } else {
        process.env.RECONDO_DEV_BYPASS = previousBypass;
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
      if (previousApiKey === undefined) {
        delete process.env.RECONDO_API_KEY;
      } else {
        process.env.RECONDO_API_KEY = previousApiKey;
      }
    }
  });
});

describeIfReady("D-C2-1 spawnMcp helper", () => {
  it("initialize handshake completes (helper resolves only after the response arrives)", async () => {
    // spawnMcp() awaits the initialize round-trip internally before
    // returning. If we get a SpawnedMcp at all, the handshake worked.
    const mcp = await spawnMcp({ devBypass: true });
    try {
      expect(mcp.child.exitCode).toBeNull();
      expect(mcp.child.signalCode).toBeNull();
    } finally {
      await mcp.close();
    }
  });

  it("tools/list round-trips after at least one tool is registered (lazy SDK init)", async () => {
    // Note: this test is RED until C2 registers the first tool. The
    // SDK only wires up `tools/list` lazily on the first registerTool
    // call, so a bare-server C1 binary will reply -32601 here.
    const mcp = await spawnMcp({ devBypass: true });
    try {
      const result = await mcp.request<{ tools: Array<{ name: string }> }>(
        "tools/list",
      );
      expect(result).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("interleaved requests each receive their own id (correlation layer)", async () => {
    // RED until C2 registers the first tool — same lazy SDK init reason.
    const mcp = await spawnMcp({ devBypass: true });
    try {
      const [a, b] = await Promise.all([
        mcp.request<{ tools: unknown[] }>("tools/list"),
        mcp.request<{ tools: unknown[] }>("tools/list"),
      ]);
      // Both must succeed independently — proves the id correlation
      // layer is not first-write-wins.
      expect(Array.isArray(a.tools)).toBe(true);
      expect(Array.isArray(b.tools)).toBe(true);
    } finally {
      await mcp.close();
    }
  });

  it("close() resolves within 3 seconds", async () => {
    const mcp = await spawnMcp({ devBypass: true });
    const start = Date.now();
    await mcp.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});
