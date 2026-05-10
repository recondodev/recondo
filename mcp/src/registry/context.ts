/**
 * `ToolContext` factory used by `registerReadTool`.
 *
 * The MCP SDK passes a `RequestHandlerExtra` object to every tool
 * callback. The shape we care about here is `{ signal: AbortSignal }`
 * — the rest of `extra` (authInfo, sessionId, etc.) is unused by the
 * read tools.
 *
 * `clientInfo` is resolved lazily from the inner `Server` (via
 * `getClientVersion()`) at call time — the value isn't known until
 * the client has completed `initialize`.
 */

import type { AuthContext } from "../auth/context.js";
import type { AuditWriter, ClientInfo, ToolContext } from "./types.js";

export interface ToolContextFactoryArgs {
  auth: AuthContext;
  audit: AuditWriter;
  /** Resolves to the client's self-reported `clientInfo` (post-initialize). */
  resolveClientInfo?: () => ClientInfo | undefined;
}

export interface SdkExtra {
  signal?: AbortSignal;
}

export function buildToolContext(
  args: ToolContextFactoryArgs,
  extra: SdkExtra,
): ToolContext {
  const signal = extra.signal ?? new AbortController().signal;
  const ctx: ToolContext = {
    abortSignal: signal,
    auth: args.auth,
    audit: args.audit,
  };
  const info = args.resolveClientInfo?.();
  if (info) ctx.clientInfo = info;
  return ctx;
}
