/**
 * Recondo MCP server bootstrap.
 *
 * Wires `McpServer` from `@modelcontextprotocol/sdk` with a stdio
 * transport, resolves the API key (or dev-bypass) into an
 * `AuthContext`, and registers the canonical read tools through the
 * `registerReadTool` helper. Subsequent chunks (C3..C9) extend the
 * tool list by appending more `registerReadTool` calls here.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveApiKey, type AuthContext } from "./auth/context.js";
import { writeAuditEntry } from "./audit/writer.js";
import type { EnvConfig } from "./config/env.js";
import type { ParsedFlags } from "./config/flags.js";
import { registerReadTool } from "./registry/register.js";
import type { AuditWriter, ClientInfo } from "./registry/types.js";
import { listSessionsTool } from "./tools/list-sessions.js";
import { getSessionTool } from "./tools/get-session.js";
import { getTurnTool } from "./tools/get-turn.js";
import { getTurnRawMetadataTool } from "./tools/get-turn-raw-metadata.js";
import { getTurnRawChunkTool } from "./tools/get-turn-raw-chunk.js";
import { searchTool } from "./tools/search.js";
import { verifyIntegrityTool } from "./tools/verify-integrity.js";

export interface CreateMcpServerArgs {
  env: EnvConfig;
  flags: ParsedFlags;
  /** Optional auth override — used by tests that pre-resolve auth. */
  auth?: AuthContext;
}

const SERVER_NAME = "recondo-mcp";
const SERVER_VERSION = "0.1.0";

const auditWriter: AuditWriter = {
  write: writeAuditEntry,
};

export async function createMcpServer(
  args: CreateMcpServerArgs,
): Promise<McpServer> {
  // Capabilities for tools/prompts/resources are advertised explicitly
  // so the `initialize` handshake reports the categories. The SDK
  // wires up the `tools/list` request handler lazily on the first
  // `registerTool` call below, so we MUST register at least one tool
  // before the transport accepts traffic.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    },
  );

  const auth =
    args.auth ??
    (await resolveApiKey({
      devBypass: args.env.devBypass,
      apiKey: args.env.apiKey,
    }));

  const resolveClientInfo = (): ClientInfo | undefined => {
    const info = server.server.getClientVersion();
    if (!info) return undefined;
    const out: ClientInfo = {};
    if (info.name !== undefined) out.name = info.name;
    if (info.version !== undefined) out.version = info.version;
    return out;
  };

  registerReadTool(server, listSessionsTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, getSessionTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, getTurnTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, getTurnRawMetadataTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, getTurnRawChunkTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, searchTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, verifyIntegrityTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
