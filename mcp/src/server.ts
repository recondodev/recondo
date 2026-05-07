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
import { compareTurnsTool } from "./tools/compare-turns.js";
import { findSimilarPromptsTool } from "./tools/find-similar-prompts.js";
import { relatedTurnsTool } from "./tools/related-turns.js";
import { sessionEfficiencyTool } from "./tools/session-efficiency.js";
import { realtimeOverviewTool } from "./tools/realtime-overview.js";
import { realtimeFeedTool } from "./tools/realtime-feed.js";
import { usageSummaryTool } from "./tools/usage-summary.js";
import { spendTool } from "./tools/spend.js";
import { costProjectionsTool } from "./tools/cost-projections.js";
import { agentSummaryTool } from "./tools/agent-summary.js";
import { agentFrameworkDistributionTool } from "./tools/agent-framework-distribution.js";
import { topTool } from "./tools/top.js";
import { toolCallStatsTool } from "./tools/tool-call-stats.js";
import { auditTrailTool } from "./tools/audit-trail.js";
import { anomaliesTool } from "./tools/anomalies.js";
import { complianceTool } from "./tools/compliance.js";
import { reportsTool } from "./tools/reports.js";
import { reportTrendsTool } from "./tools/report-trends.js";

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
  // C5 — turn-level analytical tools. Auth context is delivered for
  // future project scoping; the v1 data-layer helpers are unscoped, so
  // the handlers ignore `ctx.auth` and call the data layer directly.
  registerReadTool(server, compareTurnsTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, findSimilarPromptsTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, relatedTurnsTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, sessionEfficiencyTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  // C6 — live activity + spend tools.
  registerReadTool(server, realtimeOverviewTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, realtimeFeedTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, usageSummaryTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, spendTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, costProjectionsTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  // C7 — agent analytics tools.
  registerReadTool(server, agentSummaryTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, agentFrameworkDistributionTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, topTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, toolCallStatsTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  // C8 — audit / anomaly / compliance / reports tools (5 total).
  // NOTE: the `insights` tool is intentionally NOT registered (C0 §5 #1
  // dropped it — no matching `data.insights` resolver exists).
  registerReadTool(server, auditTrailTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, anomaliesTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, complianceTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, reportsTool, {
    auth,
    audit: auditWriter,
    resolveClientInfo,
  });
  registerReadTool(server, reportTrendsTool, {
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
