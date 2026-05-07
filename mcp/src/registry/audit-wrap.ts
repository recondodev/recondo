/**
 * Audit-log wrapper for read-tool handlers.
 *
 * Wraps a `ReadTool.handler` so the audit row is appended AFTER the
 * tool's data fetch resolves. This ordering matters: `responseBytes`
 * must reflect the actual serialised response size, so the wrap has
 * to run post-fetch.
 *
 * Per orchestration Lesson 4, audit failures are swallowed inside
 * `writeAuditEntry` (the writer behind `AuditWriter.write`). We rely
 * on that contract — this wrapper does NOT add a try/catch of its
 * own. If the underlying writer ever changed to throw, propagating
 * the error here would surface the bug instead of hiding it.
 */

import type { ActionTool, ReadTool, ToolContext } from "./types.js";

export type ReadToolHandler<TInput, TOutput> = (
  input: TInput,
  ctx: ToolContext,
) => Promise<TOutput>;

export type ActionToolHandler<TInput, TOutput> = (
  input: TInput,
  ctx: ToolContext,
) => Promise<TOutput>;

export function withAuditLog<TInput, TOutput>(
  tool: ReadTool<TInput, TOutput>,
): ReadToolHandler<TInput, TOutput> {
  return async (input, ctx) => {
    const result = await tool.handler(input, ctx);
    const responseBytes = JSON.stringify(result ?? null).length;
    await ctx.audit.write(
      {
        toolName: tool.name,
        arguments: input,
        responseBytes,
        clientName: ctx.clientInfo?.name ?? null,
        keyId: ctx.auth.keyId,
      },
      { signal: ctx.abortSignal },
    );
    return result;
  };
}

/**
 * Audit-log wrapper for action-tool handlers (D-C10). Behaviour mirrors
 * `withAuditLog` for read tools: emit the audit row AFTER the handler
 * resolves so `responseBytes` reflects the realised payload, and pass
 * the input args verbatim so the audit log captures what was attempted.
 */
export function withActionAuditLog<TInput, TOutput>(
  tool: ActionTool<TInput, TOutput>,
): ActionToolHandler<TInput, TOutput> {
  return async (input, ctx) => {
    const result = await tool.handler(input, ctx);
    const responseBytes = JSON.stringify(result ?? null).length;
    await ctx.audit.write(
      {
        toolName: tool.name,
        arguments: input,
        responseBytes,
        clientName: ctx.clientInfo?.name ?? null,
        keyId: ctx.auth.keyId,
      },
      { signal: ctx.abortSignal },
    );
    return result;
  };
}
