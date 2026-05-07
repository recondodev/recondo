/**
 * D-C2-1 — Reusable spawn helper for recondo-mcp integration tests.
 *
 * Spawns the built `dist/bin/recondo-mcp.js` binary, exchanges
 * line-delimited JSON-RPC over stdio, and exposes a `request()` /
 * `notify()` / `close()` surface so tests can drive `initialize`,
 * `tools/list`, `tools/call`, etc. without re-implementing the
 * JSON-RPC framing every time.
 *
 * Tests should `existsSync(BINARY)`-skip when the binary isn't built;
 * the helper itself does NOT skip — it errors loudly so a missing
 * build never silently passes.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Readable, Writable } from "node:stream";

// ESM equivalent of CommonJS `__dirname`. The helper lives in an ESM
// package (`"type": "module"`) so the legacy global is undefined at
// runtime — derive it from `import.meta.url` instead.
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
}

export interface SpawnedMcp {
  request<TResult = unknown>(method: string, params?: unknown): Promise<TResult>;
  notify(method: string, params?: unknown): void;
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly stderr: string;
  /** All raw stdout lines parsed so far (mostly for debugging). */
  readonly stdoutLines: ReadonlyArray<string>;
  close(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10000;
const CLOSE_GRACE_MS = 2000;

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
  // Sensible defaults for local dev-infra.
  if (!baseEnv.RECONDO_OBJECT_STORE_PATH) {
    baseEnv.RECONDO_OBJECT_STORE_PATH = "/tmp/recondo-objects";
  }
  // The catalog-count integration test (D-C9-3) deliberately runs
  // without a live database — `tools/list` doesn't hit the DB. The env
  // loader still requires DATABASE_URL to be a non-empty string, so
  // supply a placeholder that resolves syntactically. Tests that
  // actually need a working DB must set DATABASE_URL themselves (and
  // gate with HAVE_DB so they skip when unset).
  if (!baseEnv.DATABASE_URL) {
    baseEnv.DATABASE_URL = "postgres://placeholder:placeholder@127.0.0.1:0/placeholder";
  }
  if (!baseEnv.RECONDO_DEV_BYPASS) baseEnv.RECONDO_DEV_BYPASS = "1";
  // The env loader only honours dev-bypass when NODE_ENV=development.
  // Vitest sets NODE_ENV=test, so we always force it back to
  // development for the spawned subprocess unless the caller supplies
  // an explicit override.
  baseEnv.NODE_ENV = "development";
  Object.assign(baseEnv, options.env ?? {});

  const child = spawn(process.execPath, [RECONDO_MCP_BINARY, ...(options.args ?? [])], {
    env: baseEnv,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stdoutLines: string[] = [];
  let stderrBuf = "";
  let nextId = 1;

  type Pending = {
    resolve: (msg: RpcMessage) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  };
  const pending = new Map<number | string, Pending>();
  let stdoutBuf = "";

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.trim().length === 0) continue;
      stdoutLines.push(line);
      let parsed: RpcMessage | undefined;
      try {
        parsed = JSON.parse(line) as RpcMessage;
      } catch {
        // Reject any pending requests; non-JSON on stdout is a fatal
        // contract violation (no log bleed).
        for (const [id, p] of pending) {
          clearTimeout(p.timer);
          p.reject(new Error(`stdout non-JSON: ${line.slice(0, 200)}`));
          pending.delete(id);
        }
        continue;
      }
      if (parsed && parsed.id !== undefined && pending.has(parsed.id)) {
        const p = pending.get(parsed.id)!;
        clearTimeout(p.timer);
        pending.delete(parsed.id);
        p.resolve(parsed);
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit) => {
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    },
  );
  // Surface premature exit by rejecting any pending requests.
  void exitPromise.then(({ code }) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(
        new Error(`recondo-mcp exited (code=${code}) with pending requests; stderr=${stderrBuf}`),
      );
      pending.delete(id);
    }
  });

  function sendRaw(msg: RpcMessage): void {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  async function request<TResult = unknown>(
    method: string,
    params?: unknown,
  ): Promise<TResult> {
    const id = nextId++;
    return new Promise<TResult>((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectP(new Error(`timeout waiting for ${method} (id=${id})`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (msg) => {
          if (msg.error) {
            rejectP(
              new Error(
                `JSON-RPC error for ${method}: ${msg.error.code} ${msg.error.message}`,
              ),
            );
            return;
          }
          resolveP(msg.result as TResult);
        },
        reject: rejectP,
        timer,
      });
      const params2 = params === undefined ? {} : params;
      sendRaw({ jsonrpc: "2.0", id, method, params: params2 });
    });
  }

  function notify(method: string, params?: unknown): void {
    sendRaw({ jsonrpc: "2.0", method, params });
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

  // Run the handshake unless the caller opts out.
  if (options.initialize !== false) {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: options.clientInfo ?? { name: "vitest", version: "0.0.0" },
    });
    // Per MCP spec, the client should send `notifications/initialized`
    // after the handshake response. The SDK is forgiving about this in
    // tests, but it costs nothing to do it correctly.
    notify("notifications/initialized");
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
    close,
  };
}
