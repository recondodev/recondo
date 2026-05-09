/**
 * D-C9-3 (integration) — End-to-end read-tool catalog count.
 *
 * Spawn the recondo-mcp binary as a remote HTTP service WITHOUT any
 * action flags (default mode), call `tools/list`, and assert:
 *   1. exactly 28 tools are advertised (matches READ_TOOLS.length unit
 *      assertion). C10 ships action tools — but they only appear with
 *      `--allow-actions`, so the default-mode count stays 28.
 *   2. every tool's description length >= 50 chars.
 *   3. every tool's name matches /^recondo_[a-z_]+$/ AND starts with
 *      `recondo_`.
 *   4. the restored `recondo_insights` tool is present.
 *   5. the C9 tools are present:
 *        - recondo_policies
 *        - recondo_registered_keys
 *
 * After C10 (without `--allow-actions`), the count stays 28. With
 * `--allow-actions`, the count rises by N action tools — that test
 * lives in C10's action_gating integration. C9 only pins the default-
 * mode count.
 *
 * NB: this test runs even WITHOUT a database, because `tools/list`
 * doesn't hit the DB. The HAVE_DB guard is intentionally omitted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_BINARY ? describe : describe.skip;

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [k: string]: unknown;
  };
}

const EXPECTED_READ_TOOLS = [
  // C2 — bootstrap read tools.
  "recondo_list_sessions",
  "recondo_get_session",
  "recondo_get_turn",
  "recondo_get_turn_raw_metadata",
  "recondo_get_turn_raw_chunk",
  "recondo_search",
  "recondo_verify_integrity",
  // C5 — turn-level analytical tools.
  "recondo_compare_turns",
  "recondo_find_similar_prompts",
  "recondo_related_turns",
  "recondo_session_efficiency",
  // C6 — live activity + spend tools.
  "recondo_realtime_overview",
  "recondo_realtime_feed",
  "recondo_usage_summary",
  "recondo_spend",
  "recondo_cost_projections",
  // C7 — agent analytics tools.
  "recondo_agent_summary",
  "recondo_agent_framework_distribution",
  "recondo_top",
  "recondo_tool_call_stats",
  // C8/hardening — audit / anomaly / compliance / reports / insights.
  "recondo_audit_trail",
  "recondo_anomalies",
  "recondo_compliance",
  "recondo_reports",
  "recondo_report_trends",
  "recondo_insights",
  // C9 — policy + key reads.
  "recondo_policies",
  "recondo_registered_keys",
];

describeIfReady("D-C9-3 tools/list catalog count (default mode)", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    // Default mode — no `--allow-actions`. After C10 only read tools
    // appear in this configuration.
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("advertises exactly 28 tools", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    expect(result.tools.length).toBe(28);
  });

  it("contains every expected read tool name", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const actual = result.tools.map((t) => t.name).sort();
    expect(actual).toEqual(EXPECTED_READ_TOOLS.slice().sort());
  });

  it("advertises the restored recondo_insights tool", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("recondo_insights");
  });

  it("includes the two new C9 tools", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("recondo_policies");
    expect(names).toContain("recondo_registered_keys");
  });

  it("every advertised tool has a description >= 50 chars", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    for (const tool of result.tools) {
      expect(typeof tool.description).toBe("string");
      expect(
        (tool.description ?? "").length,
        `tool ${tool.name} has description length ${(tool.description ?? "").length} (< 50)`,
      ).toBeGreaterThanOrEqual(50);
    }
  });

  it("every advertised tool name matches /^recondo_[a-z_]+$/", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const pattern = /^recondo_[a-z_]+$/;
    for (const tool of result.tools) {
      expect(
        pattern.test(tool.name),
        `tool name violates naming convention: ${tool.name}`,
      ).toBe(true);
    }
  });
});
