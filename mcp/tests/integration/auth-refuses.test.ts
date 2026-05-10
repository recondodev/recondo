/**
 * Auth refusal in production mode.
 *
 * A remote MCP service should boot without a baked-in service key, then
 * reject unauthenticated HTTP initialize requests when dev-bypass is not
 * enabled.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";

import { RECONDO_MCP_BINARY } from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfBinary = HAVE_BINARY ? describe : describe.skip;

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

describeIfBinary("auth refuses without key in production", () => {
  it("boots the service but rejects initialize without Authorization", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [RECONDO_MCP_BINARY], {
      env: {
        DATABASE_URL:
          "postgres://placeholder:placeholder@127.0.0.1:0/placeholder",
        RECONDO_OBJECT_STORE_PATH: "/tmp/recondo-mcp-test-objects-auth-refuses",
        RECONDO_MCP_HOST: "127.0.0.1",
        RECONDO_MCP_PORT: String(port),
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(baseUrl);
      const res = await fetch(`${baseUrl}/mcp`, {
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
            clientInfo: { name: "auth-refuses-test", version: "0" },
          },
        }),
      });

      expect(res.status).toBe(401);
      expect(await res.text()).toContain("Authorization");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });
    }

    expect(stderrBuf).toContain("recondo-mcp listening");
  });

  it("rejects initialize without Authorization even when RECONDO_API_KEY is configured", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [RECONDO_MCP_BINARY], {
      env: {
        DATABASE_URL:
          "postgres://placeholder:placeholder@127.0.0.1:0/placeholder",
        RECONDO_API_KEY: "wrt_configured_service_key",
        RECONDO_OBJECT_STORE_PATH:
          "/tmp/recondo-mcp-test-objects-auth-service-key-no-header",
        RECONDO_MCP_HOST: "127.0.0.1",
        RECONDO_MCP_PORT: String(port),
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(baseUrl);
      const res = await fetch(`${baseUrl}/mcp`, {
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
            clientInfo: { name: "auth-service-key-test", version: "0" },
          },
        }),
      });

      expect(res.status).toBe(401);
      expect(await res.text()).toContain("Authorization");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });
    }

    expect(stderrBuf).toContain("recondo-mcp listening");
  });

  it("returns a generic 500 when bearer auth backend lookup fails", async () => {
    const port = await freePort();
    const child = spawn(process.execPath, [RECONDO_MCP_BINARY], {
      env: {
        DATABASE_URL:
          "postgres://placeholder:placeholder@127.0.0.1:0/placeholder",
        RECONDO_OBJECT_STORE_PATH:
          "/tmp/recondo-mcp-test-objects-auth-backend-fails",
        RECONDO_MCP_HOST: "127.0.0.1",
        RECONDO_MCP_PORT: String(port),
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(baseUrl);
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer wrt_backend_failure_probe",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "auth-backend-fails-test", version: "0" },
          },
        }),
      });

      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).toContain("Internal server error");
      expect(body).not.toContain("ECONNREFUSED");
      expect(body).not.toContain("127.0.0.1");
      expect(body).not.toContain("placeholder");
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
          resolve();
        }, 5000);
      });
    }

    expect(stderrBuf).toContain("mcp http request failed");
  });
});
