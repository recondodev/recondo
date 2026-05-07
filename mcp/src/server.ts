/**
 * Recondo MCP server bootstrap.
 *
 * Wires `McpServer` from `@modelcontextprotocol/sdk` with a stdio
 * transport. C1 advertises the empty capability sets for tools,
 * prompts, and resources — subsequent chunks register tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import type { EnvConfig } from "./config/env.js";
import type { ParsedFlags } from "./config/flags.js";

export interface CreateMcpServerArgs {
  env: EnvConfig;
  flags: ParsedFlags;
}

const SERVER_NAME = "recondo-mcp";
const SERVER_VERSION = "0.1.0";

export function createMcpServer(_args: CreateMcpServerArgs): McpServer {
  // Capabilities for tools/prompts/resources are advertised explicitly
  // so the `initialize` handshake reports the categories even when no
  // entries are registered yet (C1 ships an empty server; C2+ register
  // tools incrementally).
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

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
