/**
 * D-C2-1 — Self-test for the `spawnMcp` integration helper.
 *
 * Skips when DATABASE_URL or the built binary aren't available.
 *
 * The helper is the foundation for every C2+ integration test, so it
 * must hold contracts:
 *   - spawnMcp() resolves only after `initialize` round-trips.
 *   - request() correlates by id even when calls overlap.
 *   - close() resolves within a few seconds.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";

import { spawnMcp, RECONDO_MCP_BINARY } from "../helpers/spawnMcp.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

describeIfReady("D-C2-1 spawnMcp helper", () => {
  it("initialize handshake completes (helper resolves only after the response arrives)", async () => {
    // spawnMcp() awaits the initialize round-trip internally before
    // returning. If we get a SpawnedMcp at all, the handshake worked.
    const mcp = await spawnMcp({});
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
    const mcp = await spawnMcp({});
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
    const mcp = await spawnMcp({});
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
    const mcp = await spawnMcp({});
    const start = Date.now();
    await mcp.close();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(3000);
  });
});
