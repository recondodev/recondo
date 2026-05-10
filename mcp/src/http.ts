/**
 * Long-running Streamable HTTP transport for recondo-mcp.
 *
 * Recondo's fullstack deployment exposes MCP as a remote service. The
 * process owns an HTTP listener and keeps MCP transports keyed by
 * `MCP-Session-Id`, matching the stateful Streamable HTTP model.
 */

import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { EnvConfig } from "./config/env.js";
import type { ParsedFlags } from "./config/flags.js";
import {
  AuthUnauthorizedError,
  resolveApiKey,
  type AuthContext,
} from "./auth/context.js";
import { logger } from "./util/logger.js";
import { createMcpServer } from "./server.js";

export interface StartHttpServerArgs {
  env: EnvConfig;
  flags: ParsedFlags;
  host: string;
  port: number;
}

interface SessionTransport {
  auth: AuthContext;
  server: Awaited<ReturnType<typeof createMcpServer>>;
  transport: StreamableHTTPServerTransport;
}

function parseSessionId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  return undefined;
}

function parseAuthorization(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : undefined;
}

async function resolveHttpAuth(
  req: any,
  env: EnvConfig,
): Promise<AuthContext> {
  const bearer = parseAuthorization(req.headers.authorization);
  if (bearer) {
    return resolveApiKey({ apiKey: bearer });
  }
  if (env.devBypass) {
    return resolveApiKey({ devBypass: true });
  }
  throw new AuthUnauthorizedError("Authorization header required");
}

function allowedHostsFor(host: string): string[] | undefined {
  const fromEnv = process.env.RECONDO_MCP_ALLOWED_HOSTS;
  if (fromEnv) {
    return fromEnv
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  if (host === "0.0.0.0" || host === "::") {
    return ["localhost", "127.0.0.1", "[::1]", "mcp", "recondo-mcp-1"];
  }
  return undefined;
}

function badRequest(res: any, message: string): void {
  res.status(400).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message,
    },
    id: null,
  });
}

function sessionNotFound(res: any): void {
  res.status(404).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Session not found",
    },
    id: null,
  });
}

function unauthorized(res: any, message: string): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message,
    },
    id: null,
  });
}

function authContextMatches(left: AuthContext, right: AuthContext): boolean {
  return (
    left.kind === right.kind &&
    left.keyId === right.keyId &&
    left.projectId === right.projectId &&
    left.isAdmin === right.isAdmin
  );
}

async function authorizeSessionRequest(
  req: any,
  res: any,
  env: EnvConfig,
  existing: SessionTransport,
): Promise<boolean> {
  let auth: AuthContext;
  try {
    auth = await resolveHttpAuth(req, env);
  } catch (err) {
    if (!(err instanceof AuthUnauthorizedError)) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    unauthorized(res, msg);
    return false;
  }

  if (!authContextMatches(auth, existing.auth)) {
    unauthorized(res, "Authorization does not match MCP session");
    return false;
  }
  return true;
}

function internalServerError(res: any, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ error: msg }, "mcp http request failed");
  if (!res.headersSent) {
    res.status(500).json({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: "Internal server error",
      },
      id: null,
    });
  }
}

export async function startHttpServer(
  args: StartHttpServerArgs,
): Promise<HttpServer> {
  const sessions = new Map<string, SessionTransport>();
  const app = createMcpExpressApp({
    host: args.host,
    allowedHosts: allowedHostsFor(args.host),
  });

  app.get("/healthz", (_req: any, res: any) => {
    res.status(200).json({
      ok: true,
      service: "recondo-mcp",
      transport: "streamable-http",
    });
  });

  app.post("/mcp", async (req: any, res: any) => {
    const sessionId = parseSessionId(req.headers["mcp-session-id"]);

    try {
      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        if (!(await authorizeSessionRequest(req, res, args.env, existing))) {
          return;
        }
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId) {
        sessionNotFound(res);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        badRequest(res, "Missing MCP-Session-Id for non-initialize request");
        return;
      }

      let auth: AuthContext;
      try {
        auth = await resolveHttpAuth(req, args.env);
      } catch (err) {
        if (!(err instanceof AuthUnauthorizedError)) {
          throw err;
        }
        const msg = err instanceof Error ? err.message : String(err);
        unauthorized(res, msg);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          const entry = pending;
          sessions.set(newSessionId, entry);
          logger.info({ sessionId: newSessionId }, "mcp session initialized");
        },
      });
      const server = await createMcpServer({
        env: args.env,
        flags: args.flags,
        auth,
      });
      const pending: SessionTransport = { auth, server, transport };

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };
      transport.onerror = (error) => {
        logger.error({ error: error.message }, "mcp transport error");
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      internalServerError(res, err);
    }
  });

  app.get("/mcp", async (req: any, res: any) => {
    const sessionId = parseSessionId(req.headers["mcp-session-id"]);
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId) {
      badRequest(res, "Missing MCP-Session-Id");
      return;
    }
    if (!existing) {
      sessionNotFound(res);
      return;
    }
    try {
      if (!(await authorizeSessionRequest(req, res, args.env, existing))) {
        return;
      }
      await existing.transport.handleRequest(req, res);
    } catch (err) {
      internalServerError(res, err);
    }
  });

  app.delete("/mcp", async (req: any, res: any) => {
    const sessionId = parseSessionId(req.headers["mcp-session-id"]);
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (!sessionId) {
      badRequest(res, "Missing MCP-Session-Id");
      return;
    }
    if (!existing) {
      sessionNotFound(res);
      return;
    }
    try {
      if (!(await authorizeSessionRequest(req, res, args.env, existing))) {
        return;
      }
      await existing.transport.handleRequest(req, res);
      if (res.statusCode >= 200 && res.statusCode < 400) {
        sessions.delete(sessionId);
      }
    } catch (err) {
      internalServerError(res, err);
    }
  });

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const listener = app.listen(args.port, args.host, () => resolve(listener));
    listener.once("error", reject);
  });

  const closeSessions = async (): Promise<void> => {
    for (const [sessionId, entry] of sessions) {
      sessions.delete(sessionId);
      await entry.server.close().catch(() => {});
    }
  };

  process.once("SIGTERM", () => {
    void closeSessions().finally(() => httpServer.close(() => process.exit(0)));
  });
  process.once("SIGINT", () => {
    void closeSessions().finally(() => httpServer.close(() => process.exit(0)));
  });

  logger.info(
    {
      host: args.host,
      port: args.port,
      endpoint: `http://${args.host}:${args.port}/mcp`,
    },
    "recondo-mcp listening",
  );

  return httpServer;
}
