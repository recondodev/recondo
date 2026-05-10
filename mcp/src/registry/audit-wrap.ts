/**
 * Audit-log wrapper for read-tool handlers.
 *
 * Wraps a `ReadTool.handler` so the audit row is appended for success,
 * error, and aborted calls. The audit write happens in `finally`: a
 * failed handler is still compliance evidence, and the original error is
 * re-thrown after the audit writer finishes.
 */

import type { ActionTool, ReadTool, ToolContext } from "./types.js";

type AuditOutcome = "success" | "error" | "aborted";

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
    return runWithAudit(tool, input, ctx);
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
    return runWithAudit(tool, input, ctx);
  };
}

async function runWithAudit<TInput, TOutput>(
  tool: ReadTool<TInput, TOutput> | ActionTool<TInput, TOutput>,
  input: TInput,
  ctx: ToolContext,
): Promise<TOutput> {
  let outcome: AuditOutcome = "success";
  let errorMessage: string | null = null;
  let responseBytes = 0;

  try {
    const result = await tool.handler(input, ctx);
    responseBytes = result == null ? 0 : JSON.stringify(result).length;
    return result;
  } catch (err) {
    const isAbort =
      err instanceof Error && err.name === "AbortError";
    outcome = isAbort ? "aborted" : "error";
    errorMessage = isAbort
      ? "AbortError"
      : err instanceof Error
        ? err.message
        : String(err);
    throw err;
  } finally {
    const auditOptions =
      outcome === "aborted" ? undefined : { signal: ctx.abortSignal };
    await ctx.audit.write(
      {
        toolName: tool.name,
        arguments: input,
        responseBytes,
        clientName: ctx.clientInfo?.name ?? null,
        keyId: ctx.auth.keyId,
        outcome,
        errorMessage,
      },
      auditOptions,
    );
  }
}
