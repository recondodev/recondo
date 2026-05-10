/**
 * Recondo MCP server bootstrap.
 *
 * Wires `McpServer` from `@modelcontextprotocol/sdk`, resolves the API
 * key (or dev-bypass) into an `AuthContext`, and registers the
 * canonical read tools through the `registerReadTool` helper. The
 * `READ_TOOLS` array is the SINGLE
 * source of truth for the v1 read-tool catalog (28 entries after
 * insights was restored as a first-class tool). Any new read tool MUST be appended here so
 * the catalog count + parity lints stay accurate.
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import { resolveApiKey, type AuthContext } from "./auth/context.js";
import { writeAuditEntry } from "./audit/writer.js";
import type { EnvConfig } from "./config/env.js";
import type { ParsedFlags } from "./config/flags.js";
import { buildToolContext } from "./registry/context.js";
import { registerActionTool, registerReadTool } from "./registry/register.js";
import type {
  ActionTool,
  AuditWriter,
  ClientInfo,
  ReadTool,
} from "./registry/types.js";
// C12 — prompts catalog.
import { findWaste } from "./prompts/find_waste.js";
import { monitorAnomalies } from "./prompts/monitor_anomalies.js";
import { summarizeMyWeek } from "./prompts/summarize_my_week.js";
import { weeklyCostReport } from "./prompts/weekly_cost_report.js";
import type { PromptDefinition } from "./prompts/types.js";
// C12 — resources catalog.
import { sessionResource } from "./resources/session.js";
import { turnResource } from "./resources/turn.js";
import { reportResource } from "./resources/report.js";
import type { ResourceDefinition } from "./resources/types.js";
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
import { insightsTool } from "./tools/insights.js";
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
 * 28 tools:
 *   - 7 from C2 (list_sessions, get_session, get_turn, get_turn_raw_metadata,
 *     get_turn_raw_chunk, search, verify_integrity)
 *   - 4 from C5 (compare_turns, find_similar_prompts, related_turns,
 *     session_efficiency)
 *   - 5 from C6 (realtime_overview, realtime_feed, usage_summary, spend,
 *     cost_projections)
 *   - 4 from C7 (agent_summary, agent_framework_distribution, top,
 *     tool_call_stats)
 *   - 6 from C8/hardening (audit_trail, anomalies, compliance, reports,
 *     report_trends, insights)
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
  // C8/hardening — audit / anomaly / compliance / reports / insights.
  auditTrailTool,
  anomaliesTool,
  complianceTool,
  reportsTool,
  reportTrendsTool,
  insightsTool,
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

/**
 * Single source of truth for the v1 prompt catalog (D-C12-4..D-C12-6).
 *
 * 4 prompts:
 *   - 3 read-only (summarize_my_week, find_waste, monitor_anomalies)
 *   - 1 action-gated (weekly_cost_report — calls recondo_generate_report,
 *     so it is only registered when --allow-actions is set)
 */
export const PROMPTS: PromptDefinition[] = [
  summarizeMyWeek,
  findWaste,
  weeklyCostReport,
  monitorAnomalies,
];

/**
 * Single source of truth for the v1 resource catalog (D-C12-7).
 *
 * 3 resource templates: session, turn, reports. Active-session reads
 * (`ended_at IS NULL`) are rejected via a structured error envelope —
 * the integration test asserts the contract against the live SDK.
 */
export const RESOURCES: ResourceDefinition[] = [
  sessionResource,
  turnResource,
  reportResource,
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

  // D-C12-4 — prompt registration. Action-gated prompts (those whose
  // body invokes an action tool — only `weekly_cost_report` today) are
  // registered ONLY when `--allow-actions` is set; otherwise they're
  // omitted from `prompts/list` entirely.
  for (const prompt of PROMPTS) {
    if (prompt.requiresAction && !args.flags.allowActions) continue;
    server.registerPrompt(
      prompt.name,
      {
        description: prompt.description,
      },
      async () => {
        const result = await prompt.render();
        return { messages: result.messages };
      },
    );
  }

  // D-C12-7 — resource registration. The SDK's `registerResource`
  // accepts a `ResourceTemplate` (RFC 6570 URI template) plus a read
  // callback; we adapt our `ResourceDefinition.read(uri, ctx)` shape
  // to the SDK's `(uri: URL, vars, extra) => ReadResourceResult`
  // signature here. Listing is deliberately disabled (`list:
  // undefined`) — the catalog is exposed via `resources/templates/list`
  // only.
  for (const resource of RESOURCES) {
    server.registerResource(
      resource.name,
      new ResourceTemplate(resource.uriTemplate, { list: undefined }),
      {
        description: resource.description,
        ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      },
      async (uri, _vars, extra) => {
        const ctx = buildToolContext(
          { auth, audit: auditWriter, resolveClientInfo },
          { signal: extra.signal },
        );
        const result = await resource.read(uri.toString(), ctx);
        const contents = result.contents.map((c) => {
          // Each MCP resource content entry must carry exactly one of
          // `text` or `blob`. Default to an empty text body when neither
          // is supplied (defensive — every read path in resources/
          // populates `text`).
          if (c.blob !== undefined) {
            return {
              uri: c.uri,
              blob: c.blob,
              ...(c.mimeType ? { mimeType: c.mimeType } : {}),
            };
          }
          return {
            uri: c.uri,
            text: c.text ?? "",
            ...(c.mimeType ? { mimeType: c.mimeType } : {}),
          };
        });
        return {
          contents,
          ...(result.isError ? { isError: true } : {}),
        };
      },
    );
  }

  return server;
}
