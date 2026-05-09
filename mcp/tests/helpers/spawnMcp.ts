/**
 * Reusable MCP integration helper.
 *
 * Starts the built `dist/bin/recondo-mcp.js` binary as a long-running
 * Streamable HTTP service on an ephemeral localhost port, initializes an
 * MCP session, and exposes `request()` / `notify()` / `close()` helpers.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const RECONDO_MCP_BINARY = resolve(
  __dirname,
  "../../dist/bin/recondo-mcp.js",
);

export interface RpcMessage {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface SpawnMcpOptions {
  /** Extra env vars merged on top of the cloned process.env. */
  env?: Record<string, string>;
  /** CLI args. e.g. ["--allow-actions"]. */
  args?: string[];
  /** Default true — send `initialize` and await its response before resolving. */
  initialize?: boolean;
  /** Client info forwarded in `initialize.params.clientInfo`. */
  clientInfo?: { name?: string; version?: string };
  /** Per-request timeout (ms). Default 10000. */
  timeoutMs?: number;
  /**
   * Opt into the local development auth bypass. Defaults false so tests
   * exercise production-mode auth unless they explicitly request bypass.
   */
  devBypass?: boolean;
  /** Bearer token sent on MCP HTTP requests. */
  bearerToken?: string;
}

export interface SpawnedMcp {
  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  notify(method: string, params?: unknown): void;
  readonly child: ChildProcess;
  readonly stderr: string;
  /** Kept for old assertions; HTTP-mode MCP must not write protocol to stdout. */
  readonly stdoutLines: ReadonlyArray<string>;
  readonly baseUrl: string;
  readonly sessionId: string | undefined;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10000;
const CLOSE_GRACE_MS = 2000;

async function freePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const server = createServer();
    server.once("error", rejectP);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => rejectP(new Error("failed to allocate MCP port")));
        return;
      }
      const { port } = address;
      server.close(() => resolveP(port));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveP) => setTimeout(resolveP, ms));
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcess,
  timeoutMs: number,
  readStderr: () => string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `recondo-mcp exited before healthcheck; code=${child.exitCode} signal=${child.signalCode}; stderr=${readStderr()}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`);
      if (res.ok) return;
      lastErr = new Error(`health status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  throw new Error(`timeout waiting for MCP healthcheck: ${String(lastErr)}`);
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await promise;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`timeout waiting for ${label}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function spawnMcp(
  options: SpawnMcpOptions = {},
): Promise<SpawnedMcp> {
  if (!existsSync(RECONDO_MCP_BINARY)) {
    throw new Error(
      `recondo-mcp binary not found at ${RECONDO_MCP_BINARY} — run "pnpm --filter recondo-mcp run build" first`,
    );
  }

  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v;
  }
  if (options.devBypass === true && !baseEnv.RECONDO_OBJECT_STORE_PATH) {
    baseEnv.RECONDO_OBJECT_STORE_PATH = "/tmp/recondo-objects";
  }
  if (options.devBypass === true && !baseEnv.DATABASE_URL) {
    baseEnv.DATABASE_URL = "postgres://placeholder:placeholder@127.0.0.1:0/placeholder";
  }
  if (options.devBypass === true) {
    baseEnv.RECONDO_DEV_BYPASS = "1";
    baseEnv.NODE_ENV = "development";
  } else {
    delete baseEnv.RECONDO_DEV_BYPASS;
    if (baseEnv.NODE_ENV === "development" && !baseEnv.RECONDO_API_KEY) {
      delete baseEnv.NODE_ENV;
    }
  }
  Object.assign(baseEnv, options.env ?? {});

  const port = await freePort();
  baseEnv.RECONDO_MCP_HOST = "127.0.0.1";
  baseEnv.RECONDO_MCP_PORT = String(port);
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [RECONDO_MCP_BINARY, ...(options.args ?? [])], {
    env: baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdoutLines: string[] = [];
  let stdoutBuf = "";
  let stderrBuf = "";
  let nextId = 1;
  let sessionId: string | undefined;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.trim().length > 0) stdoutLines.push(line);
    }
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    },
  );

  async function post(
    message: RpcMessage,
    includeSession: boolean,
  ): Promise<{ message?: RpcMessage; sessionId?: string }> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (options.bearerToken) {
      headers.authorization = `Bearer ${options.bearerToken}`;
    }
    if (includeSession) {
      if (!sessionId) throw new Error("MCP session is not initialized");
      headers["MCP-Session-Id"] = sessionId;
      headers["MCP-Protocol-Version"] = "2025-11-25";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 400) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status} for ${message.method}: ${body}`);
    }
    return {
      message: await parseMcpResponse(res),
      sessionId: res.headers.get("mcp-session-id") ?? undefined,
    };
  }

  async function request<TResult = unknown>(
    method: string,
    params?: unknown,
  ): Promise<TResult> {
    const id = nextId++;
    const result = await post(
      {
        jsonrpc: "2.0",
        id,
        method,
        params: params === undefined ? {} : params,
      },
      true,
    );
    const msg = result.message;
    if (!msg) {
      throw new Error(`empty MCP response for ${method}`);
    }
    if (msg.error) {
      throw new Error(
        `JSON-RPC error for ${method}: ${msg.error.code} ${msg.error.message}`,
      );
    }
    return msg.result as TResult;
  }

  function notify(method: string, params?: unknown): void {
    void post(
      {
        jsonrpc: "2.0",
        method,
        params: params === undefined ? {} : params,
      },
      true,
    );
  }

  async function close(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, CLOSE_GRACE_MS);
    try {
      await exitPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  if (options.initialize !== false) {
    await waitForHealth(baseUrl, child, timeoutMs, () => stderrBuf);
    const init = await withTimeout(
      post(
        {
          jsonrpc: "2.0",
          id: nextId++,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: options.clientInfo ?? { name: "vitest", version: "0.0.0" },
          },
        },
        false,
      ),
      timeoutMs,
      "initialize",
    );
    sessionId = init.sessionId;
    if (!sessionId) {
      await close();
      throw new Error(`initialize response did not include MCP-Session-Id`);
    }
    if (init.message?.error) {
      await close();
      throw new Error(
        `JSON-RPC error for initialize: ${init.message.error.code} ${init.message.error.message}`,
      );
    }
    await post(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      true,
    );
  }

  return {
    request,
    notify,
    child,
    get stderr() {
      return stderrBuf;
    },
    get stdoutLines() {
      return stdoutLines;
    },
    get baseUrl() {
      return baseUrl;
    },
    get sessionId() {
      return sessionId;
    },
    close,
  };
}
