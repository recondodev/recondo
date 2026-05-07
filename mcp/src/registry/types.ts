/**
 * Tool-registry type vocabulary (skeleton — populated in C2+).
 *
 * `ToolContext` is the per-call object the registry threads into every
 * tool handler. The audit-write callback is invoked AFTER the handler
 * returns, with the serialised response byte count.
 */

import type { AuthContext } from "../auth/context.js";

export interface ClientInfo {
  name?: string;
  version?: string;
}

export interface AuditWriteEntry {
  toolName: string;
  arguments: unknown;
  responseBytes: number;
  clientName?: string | null;
  keyId?: string | null;
}

export interface ToolContext {
  abortSignal: AbortSignal;
  auth: AuthContext;
  clientInfo?: ClientInfo;
  audit: {
    write(entry: AuditWriteEntry): Promise<void>;
  };
}

/**
 * Read-only tool. Never mutates captured tables.
 */
export interface ReadTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Input, ctx: ToolContext) => Promise<Output>;
}

/**
 * Action tool. Mutates governance metadata only — captured tables are
 * forbidden (enforced by Plan D §D-C13-8 row-count immutability test).
 */
export interface ActionTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
  handler: (input: Input, ctx: ToolContext) => Promise<Output>;
}
