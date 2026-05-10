/**
 * Remote MCP transport regression.
 *
 * Recondo's MCP server is a long-running Streamable HTTP service. This
 * test starts the built binary on an ephemeral localhost port and drives
 * the real `/mcp` endpoint.
 */
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RECONDO_MCP_BINARY, type RpcMessage } from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_BINARY ? describe : describe.skip;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
      lastErr = new Error(`health status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`MCP HTTP server did not become healthy: ${String(lastErr)}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseMcpResponse(
  res: Response,
): Promise<RpcMessage | undefined> {
  if (res.status === 202) return undefined;
  const body = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for (const block of body.split(/\n\n+/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (!data) continue;
      const parsed = JSON.parse(data) as RpcMessage;
      if (parsed.id !== undefined) return parsed;
    }
    return undefined;
  }
  return JSON.parse(body) as RpcMessage;
}

async function mcpPost(
  baseUrl: string,
  message: RpcMessage,
  sessionId?: string,
): Promise<{ message?: RpcMessage; sessionId?: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    headers["MCP-Session-Id"] = sessionId;
    headers["MCP-Protocol-Version"] = "2025-11-25";
  }
  const res = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
  });
  expect(res.status, await res.clone().text()).toBeLessThan(400);
  return {
    message: await parseMcpResponse(res),
    sessionId: res.headers.get("mcp-session-id") ?? undefined,
  };
}

async function expectStatus(
  res: Response,
  expected: number,
): Promise<void> {
  expect(res.status, await res.text()).toBe(expected);
}

describeIfReady("remote Streamable HTTP transport", () => {
  it("boots as an HTTP service and answers initialize + tools/list", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [RECONDO_MCP_BINARY], {
      env: {
        ...process.env,
        DATABASE_URL:
          process.env.DATABASE_URL ??
          "postgres://placeholder:placeholder@127.0.0.1:0/placeholder",
        RECONDO_MCP_HOST: "127.0.0.1",
        RECONDO_MCP_PORT: String(port),
        RECONDO_DEV_BYPASS: "1",
        NODE_ENV: "development",
        RECONDO_OBJECT_STORE_PATH:
          process.env.RECONDO_OBJECT_STORE_PATH ?? "/tmp/recondo-objects",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let stdout = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const exitPromise = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });

    try {
      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(baseUrl);

      const init = await mcpPost(baseUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "vitest-http", version: "0.0.0" },
        },
      });
      expect(init.sessionId).toBeTruthy();
      expect(init.message?.error).toBeUndefined();
      const initResult = init.message?.result as {
        serverInfo: { name: string };
        capabilities: Record<string, unknown>;
      };
      expect(initResult.serverInfo.name).toBe("recondo-mcp");
      expect(initResult.capabilities).toHaveProperty("tools");

      await mcpPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        },
        init.sessionId,
      );

      const list = await mcpPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        init.sessionId,
      );
      const listResult = list.message?.result as {
        tools: Array<{ name: string }>;
      };
      expect(listResult.tools.map((tool) => tool.name)).toContain(
        "recondo_list_sessions",
      );

      const rejectedDelete = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: {
          "MCP-Session-Id": init.sessionId!,
          "MCP-Protocol-Version": "1900-01-01",
        },
      });
      expect(
        rejectedDelete.status,
        await rejectedDelete.text(),
      ).toBeGreaterThanOrEqual(400);

      const afterRejectedDelete = await mcpPost(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        },
        init.sessionId,
      );
      expect(afterRejectedDelete.message?.error).toBeUndefined();

      const deleted = await fetch(`${baseUrl}/mcp`, {
        method: "DELETE",
        headers: { "MCP-Session-Id": init.sessionId! },
      });
      expect(deleted.status, await deleted.text()).toBe(200);

      await expectStatus(
        await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "MCP-Session-Id": init.sessionId!,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/list",
            params: {},
          }),
        }),
        404,
      );
      await expectStatus(
        await fetch(`${baseUrl}/mcp`, {
          method: "GET",
          headers: { "MCP-Session-Id": init.sessionId! },
        }),
        404,
      );
      await expectStatus(
        await fetch(`${baseUrl}/mcp`, {
          method: "DELETE",
          headers: { "MCP-Session-Id": init.sessionId! },
        }),
        404,
      );
      await sleep(250);
      expect(child.exitCode, stderr).toBeNull();
      await waitForHealth(baseUrl);
      expect(stdout).toBe("");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
      }
      await Promise.race([exitPromise, sleep(5000)]);
    }

    expect(stderr).not.toContain("failed to connect transport");
  });
});
