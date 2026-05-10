/**
 * Generate tool catalog markdown from MCP tool registry.
 *
 * This script walks the READ_TOOLS and ACTION_TOOLS arrays in mcp/src/server.ts,
 * extracts metadata (name, description, parameters, gate level), and outputs
 * a markdown catalog grouped by category. The output is checked into git and
 * re-generated on every CI run to detect divergence.
 *
 * Usage:
 *   pnpm --filter recondo-mcp tsx scripts/generate-tool-catalog.ts > docs/site/mcp/tool-catalog.md
 *
 * CI check (fails if output diverges):
 *   pnpm --filter recondo-mcp tsx scripts/generate-tool-catalog.ts | diff -u docs/site/mcp/tool-catalog.md -
 */

import { READ_TOOLS, ACTION_TOOLS } from "../dist/server.js";
import type { ReadTool, ActionTool } from "../dist/registry/types.js";

interface ToolCatalogEntry {
  tool: ReadTool<any, any> | ActionTool<any, any>;
  isAction: boolean;
  category: string;
  gate: "default" | "allow-actions" | "allow-destructive";
}

/**
 * Classify tools into categories based on naming convention.
 * Returns { category, gate }.
 */
function classifyTool(tool: ReadTool<any, any> | ActionTool<any, any>): {
  category: string;
  gate: "default" | "allow-actions" | "allow-destructive";
} {
  const isAction = "destructive" in tool;

  if (!isAction) {
    // Read tools
    const name = tool.name;

    if (
      name === "recondo_list_sessions" ||
      name === "recondo_get_session" ||
      name === "recondo_get_turn" ||
      name === "recondo_get_turn_raw_metadata" ||
      name === "recondo_get_turn_raw_chunk" ||
      name === "recondo_search" ||
      name === "recondo_verify_integrity"
    ) {
      return { category: "Sessions", gate: "default" };
    }

    if (
      name === "recondo_compare_turns" ||
      name === "recondo_find_similar_prompts" ||
      name === "recondo_related_turns" ||
      name === "recondo_session_efficiency"
    ) {
      return { category: "Turn Analysis", gate: "default" };
    }

    if (
      name === "recondo_realtime_overview" ||
      name === "recondo_realtime_feed"
    ) {
      return { category: "Live Activity", gate: "default" };
    }

    if (
      name === "recondo_usage_summary" ||
      name === "recondo_spend" ||
      name === "recondo_cost_projections"
    ) {
      return { category: "Spend & Cost", gate: "default" };
    }

    if (
      name === "recondo_agent_summary" ||
      name === "recondo_agent_framework_distribution" ||
      name === "recondo_top" ||
      name === "recondo_tool_call_stats"
    ) {
      return { category: "Agent Analytics", gate: "default" };
    }

    if (
      name === "recondo_audit_trail" ||
      name === "recondo_anomalies" ||
      name === "recondo_compliance" ||
      name === "recondo_reports" ||
      name === "recondo_report_trends" ||
      name === "recondo_insights"
    ) {
      return { category: "Audit & Compliance", gate: "default" };
    }

    if (
      name === "recondo_policies" ||
      name === "recondo_registered_keys"
    ) {
      return { category: "Policy & Keys", gate: "default" };
    }

    return { category: "Other", gate: "default" };
  }

  // Action tools
  const tool_action = tool as ActionTool<any, any>;
  const gate = tool_action.destructive ? "allow-destructive" : "allow-actions";

  if (
    tool.name === "recondo_create_policy" ||
    tool.name === "recondo_update_policy" ||
    tool.name === "recondo_delete_policy"
  ) {
    return { category: "Policy Actions", gate };
  }

  if (
    tool.name === "recondo_register_key" ||
    tool.name === "recondo_delete_key"
  ) {
    return { category: "Key Management", gate };
  }

  if (
    tool.name === "recondo_generate_report" ||
    tool.name === "recondo_update_control_status"
  ) {
    return { category: "Report & Control Actions", gate };
  }

  return { category: "Actions", gate };
}

/**
 * Format a Zod input shape into a markdown table.
 */
function formatParametersTable(
  inputShape: Record<string, any>,
): string {
  const rows: string[] = [
    "| Parameter | Type | Description |",
    "|-----------|------|-------------|",
  ];

  for (const [key, zodType] of Object.entries(inputShape)) {
    const typeStr = formatZodType(zodType);
    const description = extractZodDescription(zodType);
    rows.push(`| \`${key}\` | ${typeStr} | ${description} |`);
  }

  return rows.join("\n");
}

/**
 * Extract a human-readable type string from a Zod type.
 */
function formatZodType(zodType: any): string {
  const type = zodType?._def?.typeName;

  if (!type) {
    return "unknown";
  }

  switch (type) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      const values = zodType._def?.values ?? [];
      return `enum: ${values.map((v: string) => `\`${v}\``).join(" | ")}`;
    case "ZodArray":
      return "array";
    case "ZodRecord":
      return "object";
    case "ZodDefault":
      const defaultVal = zodType._def?.defaultValue;
      return `${formatZodType(zodType._def?.schema)} (default: \`${JSON.stringify(defaultVal)}\`)`;
    case "ZodOptional":
      return `${formatZodType(zodType._def?.schema)} (optional)`;
    case "ZodLiteral":
      return `\`${zodType._def?.value}\``;
    case "ZodUnion":
      return "union";
    default:
      return type.replace(/^Zod/, "").toLowerCase();
  }
}

/**
 * Extract description/help text from Zod type comments if available.
 * For now, return a generic description based on the type.
 */
function extractZodDescription(zodType: any): string {
  // Zod types don't carry descriptions directly in the type system,
  // so we derive a generic description from the type itself.
  // In a real implementation, you'd document parameters via JSDoc comments
  // on the inputShape definition and use those.
  const type = zodType?._def?.typeName;

  switch (type) {
    case "ZodEnum":
      return "Enum value";
    case "ZodString":
      return "String value";
    case "ZodNumber":
      return "Numeric value";
    case "ZodBoolean":
      return "Boolean flag";
    case "ZodArray":
      return "Array of values";
    case "ZodRecord":
      return "Map of values";
    default:
      return "";
  }
}

/**
 * Generate the markdown catalog.
 */
function generateCatalog(): string {
  const lines: string[] = [
    "<!-- AUTO-GENERATED FILE: do not edit by hand -->",
    "<!-- Generated by: pnpm --filter recondo-mcp tsx scripts/generate-tool-catalog.ts -->",
    "<!-- Re-generate by running: just docs-tool-catalog -->",
    "",
    "# Recondo MCP Tool Catalog",
    "",
    "Complete reference of all available tools in the Recondo MCP server.",
    "",
    "## Gate Levels",
    "",
    "- **default** — Available in all contexts; no special flags required",
    "- **--allow-actions** — Requires `--allow-actions` flag; mutates governance metadata (policies, reports, keys)",
    "- **--allow-destructive** — Requires `--allow-actions --allow-destructive`; permanently deletes rows",
    "",
  ];

  // Collect and classify all tools
  const entries: ToolCatalogEntry[] = [];

  for (const tool of READ_TOOLS) {
    const { category, gate } = classifyTool(tool);
    entries.push({ tool, isAction: false, category, gate });
  }

  for (const tool of ACTION_TOOLS) {
    const { category, gate } = classifyTool(tool);
    entries.push({ tool, isAction: true, category, gate });
  }

  // Group by category
  const byCategory = new Map<string, ToolCatalogEntry[]>();
  for (const entry of entries) {
    if (!byCategory.has(entry.category)) {
      byCategory.set(entry.category, []);
    }
    byCategory.get(entry.category)!.push(entry);
  }

  // Sort categories alphabetically
  const sortedCategories = Array.from(byCategory.keys()).sort();

  for (const category of sortedCategories) {
    const tools = byCategory.get(category) || [];
    lines.push(`## ${category}`);
    lines.push("");

    for (const entry of tools) {
      const tool = entry.tool;
      const gateStr =
        entry.gate === "default"
          ? "default"
          : entry.gate === "allow-destructive"
            ? "`--allow-destructive`"
            : "`--allow-actions`";

      lines.push(`### \`${tool.name}\``);
      lines.push("");
      lines.push(`**Gate:** ${gateStr}`);
      lines.push("");
      lines.push(`**Description:**`);
      lines.push("");
      lines.push(`${tool.description}`);
      lines.push("");

      lines.push("**Parameters:**");
      lines.push("");
      lines.push(formatParametersTable(tool.inputShape));
      lines.push("");

      // Add a simple usage example
      const exampleParams = Object.keys(tool.inputShape)
        .slice(0, 2)
        .reduce(
          (acc, key) => {
            acc[key.replace(/_/g, "_")] = `"example_value"`;
            return acc;
          },
          {} as Record<string, string>,
        );

      lines.push("**Example call:**");
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify(exampleParams, null, 2));
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Summary");
  lines.push("");
  lines.push(
    `Total tools: ${entries.length} (${READ_TOOLS.length} read, ${ACTION_TOOLS.length} action)`,
  );
  lines.push("");

  return lines.join("\n");
}

// Main
console.log(generateCatalog());
