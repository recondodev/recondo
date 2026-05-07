/**
 * Recondo MCP server bootstrap.
 *
 * Wires `McpServer` from `@modelcontextprotocol/sdk` with a stdio
 * transport, resolves the API key (or dev-bypass) into an
 * `AuthContext`, and registers the canonical read tools through the
 * `registerReadTool` helper. The `READ_TOOLS` array is the SINGLE
 * source of truth for the v1 read-tool catalog (27 entries after C9 —
 * insights dropped per C0). Any new read tool MUST be appended here so
 * the catalog count + parity lints stay accurate.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { resolveApiKey, type AuthContext } from "./auth/context.js";
import { writeAuditEntry } from "./audit/writer.js";
import type { EnvConfig } from "./config/env.js";
import type { ParsedFlags } from "./config/flags.js";
import { registerActionTool, registerReadTool } from "./registry/register.js";
import type {
  ActionTool,
  AuditWriter,
  ClientInfo,
  ReadTool,
} from "./registry/types.js";
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
import { policiesTool } from "./tools/policies.js";
import { registeredKeysTool } from "./tools/registered-keys.js";
// C10 — action tools.
import { generateReportTool } from "./tools/generate-report.js";
import { updateControlStatusTool } from "./tools/update-control-status.js";
import { createPolicyTool } from "./tools/create-policy.js";
import { updatePolicyTool } from "./tools/update-policy.js";
import { registerKeyTool } from "./tools/register-key.js";
import { deletePolicyTool } from "./tools/delete-policy.js";
import { deleteKeyTool } from "./tools/delete-key.js";

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

/**
 * Single source of truth for the v1 read-tool catalog.
 *
 * 27 tools after C9:
 *   - 7 from C2 (list_sessions, get_session, get_turn, get_turn_raw_metadata,
 *     get_turn_raw_chunk, search, verify_integrity)
 *   - 4 from C5 (compare_turns, find_similar_prompts, related_turns,
 *     session_efficiency)
 *   - 5 from C6 (realtime_overview, realtime_feed, usage_summary, spend,
 *     cost_projections)
 *   - 4 from C7 (agent_summary, agent_framework_distribution, top,
 *     tool_call_stats)
 *   - 5 from C8 (audit_trail, anomalies, compliance, reports,
 *     report_trends — `insights` dropped per C0 §5 #1)
 *   - 2 from C9 (policies, registered_keys)
 */
export const READ_TOOLS: ReadTool<any, any>[] = [
  // C2 — bootstrap read tools.
  listSessionsTool,
  getSessionTool,
  getTurnTool,
  getTurnRawMetadataTool,
  getTurnRawChunkTool,
  searchTool,
  verifyIntegrityTool,
  // C5 — turn-level analytical tools.
  compareTurnsTool,
  findSimilarPromptsTool,
  relatedTurnsTool,
  sessionEfficiencyTool,
  // C6 — live activity + spend tools.
  realtimeOverviewTool,
  realtimeFeedTool,
  usageSummaryTool,
  spendTool,
  costProjectionsTool,
  // C7 — agent analytics tools.
  agentSummaryTool,
  agentFrameworkDistributionTool,
  topTool,
  toolCallStatsTool,
  // C8 — audit / anomaly / compliance / reports tools (5 total).
  // NOTE: the `insights` tool is intentionally NOT registered (C0 §5 #1
  // dropped it — no matching `data.insights` resolver exists).
  auditTrailTool,
  anomaliesTool,
  complianceTool,
  reportsTool,
  reportTrendsTool,
  // C9 — policy + key reads.
  policiesTool,
  registeredKeysTool,
];

/**
 * Single source of truth for the v1 action-tool catalog (D-C10).
 *
 * 7 tools:
 *   - 5 non-destructive: generate_report, update_control_status,
 *     create_policy, update_policy, register_key
 *   - 2 destructive: delete_policy, delete_key
 *
 * Gated behind `--allow-actions` (non-destructive) and
 * `--allow-actions --allow-destructive` (destructive). See
 * `createMcpServer` for the registration logic.
 */
export const ACTION_TOOLS: ActionTool<any, any>[] = [
  generateReportTool,
  updateControlStatusTool,
  createPolicyTool,
  updatePolicyTool,
  registerKeyTool,
  deletePolicyTool,
  deleteKeyTool,
];

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

  for (const tool of READ_TOOLS) {
    registerReadTool(server, tool, {
      auth,
      audit: auditWriter,
      resolveClientInfo,
    });
  }

  // D-C10 — action-tool gating. Always-off by default; `--allow-actions`
  // unlocks the 5 non-destructive tools; `--allow-destructive` (which
  // parseFlags rejects without `--allow-actions`) additionally unlocks
  // the 2 destructive tools.
  if (args.flags.allowActions) {
    for (const tool of ACTION_TOOLS) {
      if (tool.destructive && !args.flags.allowDestructive) continue;
      registerActionTool(server, tool, {
        auth,
        audit: auditWriter,
        resolveClientInfo,
      });
    }
  }

  return server;
}

export async function connectStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
