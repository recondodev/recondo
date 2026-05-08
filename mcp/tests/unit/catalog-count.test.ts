/**
 * D-C9-3 (unit) — Read-tool catalog count + per-tool description-length
 * + naming-convention lint.
 *
 * Contract pinned by C0 audit:
 *   - The C8/hardening catalog registers 26 read tools including
 *     `recondo_insights`.
 *   - C9 adds exactly TWO more: `recondo_policies` and
 *     `recondo_registered_keys`.
 *   - Therefore after hardening, `READ_TOOLS.length === 28`.
 *
 * Implementer requirement (handed off in plain text — the Test Writer
 * never modifies production code): `mcp/src/server.ts` MUST expose the
 * registered read tool list so this test can import it. Recommended
 * shape:
 *
 *     export const READ_TOOLS: ReadTool<unknown, unknown>[] = [
 *       listSessionsTool,
 *       getSessionTool,
 *       ...
 *       policiesTool,
 *       registeredKeysTool,
 *     ];
 *
 * The `createMcpServer` body iterates `READ_TOOLS` and calls
 * `registerReadTool(server, tool, ...)` for each entry — keeping the
 * single source of truth in one place.
 *
 * If the implementer chooses a different export name or location, this
 * test must keep the SAME contract:
 *   - exactly 28 read tools after C9
 *   - every description length >= 50 chars
 *   - every tool name matches `/^recondo_[a-z_]+$/`
 *
 * Naming convention guard:
 *   - All names start with `recondo_` and use `[a-z_]` only. The C0
 *     audit decided UNDERSCORES (snake_case) over hyphens for tool
 *     names. The MCP SDK accepts both, but mixing breaks the parity
 *     lint (C11 / Task 25) which compares tool names against
 *     `recondo-data` function names normalised to snake_case.
 */
import { describe, it, expect } from "vitest";

import { READ_TOOLS } from "../../src/server.js";
import type { ReadTool } from "../../src/registry/types.js";

describe("D-C9-3 read-tool catalog count", () => {
  it("READ_TOOLS is an array", () => {
    expect(Array.isArray(READ_TOOLS)).toBe(true);
  });

  it("READ_TOOLS.length === 28 after C9 (25 from C8 + policies + registered_keys; insights restored)", () => {
    expect(READ_TOOLS.length).toBe(28);
  });

  it("all tool names are unique", () => {
    const names = (READ_TOOLS as ReadTool<unknown, unknown>[]).map(
      (t) => t.name,
    );
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes, `duplicate tool names: ${dupes.join(", ")}`).toEqual([]);
  });

  it("every tool name starts with `recondo_` and matches /^recondo_[a-z_]+$/", () => {
    const pattern = /^recondo_[a-z_]+$/;
    for (const tool of READ_TOOLS as ReadTool<unknown, unknown>[]) {
      expect(
        pattern.test(tool.name),
        `tool name violates naming convention: ${tool.name}`,
      ).toBe(true);
    }
  });

  it("every tool description length >= 50 chars", () => {
    for (const tool of READ_TOOLS as ReadTool<unknown, unknown>[]) {
      expect(typeof tool.description).toBe("string");
      expect(
        tool.description.length,
        `tool ${tool.name} has description length ${tool.description.length} (< 50)`,
      ).toBeGreaterThanOrEqual(50);
    }
  });
});

describe("D-C9-3 read-tool catalog membership", () => {
  it("includes every C2..C8 read tool plus the two new C9 tools", () => {
    // Pinned membership for the v1 catalog. Order is irrelevant — we
    // sort both sides — but presence of every name is mandatory.
    const expected = [
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
    const actual = (READ_TOOLS as ReadTool<unknown, unknown>[])
      .map((t) => t.name)
      .sort();
    expect(actual).toEqual(expected.slice().sort());
  });

  it("includes the restored recondo_insights tool", () => {
    const names = (READ_TOOLS as ReadTool<unknown, unknown>[]).map(
      (t) => t.name,
    );
    expect(names).toContain("recondo_insights");
  });
});
