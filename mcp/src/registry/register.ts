/**
 * Canonical "register a read tool" helper.
 *
 * Every C2..C9 read tool funnels through this so the wiring stays
 * in one place:
 *   1. Build `ToolContext` from the SDK's `extra` arg (signal +
 *      resolved clientInfo).
 *   2. Run the tool's handler.
 *   3. Emit the audit row (post-fetch, so `responseBytes` is real).
 *   4. Wrap the envelope into the SDK `CallToolResult` shape
 *      (`content[].text` + `structuredContent`).
 *
 * The audit step lives in `withAuditLog`. This helper composes both.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { withAuditLog, withActionAuditLog } from "./audit-wrap.js";
import { buildToolContext, type SdkExtra, type ToolContextFactoryArgs } from "./context.js";
import type { ActionTool, ReadTool } from "./types.js";

export function registerReadTool<TInput, TOutput>(
  server: McpServer,
  tool: ReadTool<TInput, TOutput>,
  factoryArgs: ToolContextFactoryArgs,
): void {
  const wrapped = withAuditLog(tool);

  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputShape,
    },
    // The SDK validates `args` against the inputShape before invoking
    // the callback, so we can trust the shape at this point.
    async (args: unknown, extra: SdkExtra) => {
      const ctx = buildToolContext(factoryArgs, extra);
      const envelope = await wrapped(args as TInput, ctx);
      const text = JSON.stringify(envelope ?? null);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent: (envelope as Record<string, unknown> | null) ?? undefined,
      };
    },
  );
}

/**
 * Canonical "register an action tool" helper (D-C10).
 *
 * Mirrors `registerReadTool`: builds the per-call `ToolContext`, runs
 * the audit wrap (so the `arguments` field captures what was attempted
 * and `responseBytes` reflects the realised payload), and folds the
 * data-layer return value into the SDK `CallToolResult` shape.
 */
export function registerActionTool<TInput, TOutput>(
  server: McpServer,
  tool: ActionTool<TInput, TOutput>,
  factoryArgs: ToolContextFactoryArgs,
): void {
  const wrapped = withActionAuditLog(tool);

  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputShape,
    },
    async (args: unknown, extra: SdkExtra) => {
      const ctx = buildToolContext(factoryArgs, extra);
      const result = await wrapped(args as TInput, ctx);
      const text = JSON.stringify(result ?? null);
      return {
        content: [{ type: "text" as const, text }],
        structuredContent:
          (result as Record<string, unknown> | null) ?? undefined,
      };
    },
  );
}
