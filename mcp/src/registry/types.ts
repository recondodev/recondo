/**
 * Tool-registry type vocabulary (skeleton — populated in C2+).
 *
 * `ToolContext` is the per-call object the registry threads into every
 * tool handler. The audit-write callback is invoked AFTER the handler
 * returns, with the serialised response byte count.
 */

import type { z } from "zod";
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

export interface AuditWriteOptions {
  signal?: AbortSignal;
}

export interface AuditWriter {
  write(entry: AuditWriteEntry, options?: AuditWriteOptions): Promise<void>;
}

export interface ToolContext {
  abortSignal: AbortSignal;
  auth: AuthContext;
  clientInfo?: ClientInfo;
  audit: AuditWriter;
}

/**
 * Read-only tool. Never mutates captured tables.
 *
 * `inputShape` is a Zod raw shape (key -> ZodType) handed to the SDK's
 * `registerTool` so the SDK can wrap it in `z.object()` internally and
 * derive the JSON-Schema for `tools/list`. `inputSchema` is the same
 * shape pre-wrapped so unit tests can call `.parse()` directly without
 * booting the SDK.
 */
export interface ReadTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  /**
   * The same shape pre-wrapped via `z.object(inputShape)` for unit
   * tests that want to call `.parse()` directly. Typed loosely as
   * `z.ZodTypeAny` because Zod's `default()` makes the input vs output
   * types diverge (e.g. `limit?: number` on input → `limit: number`
   * on output) and the generic interface can't carry both.
   */
  inputSchema: z.ZodTypeAny;
  handler: (input: Input, ctx: ToolContext) => Promise<Output>;
}

/**
 * Action tool. Mutates governance metadata only — captured tables are
 * forbidden (enforced by Plan D §D-C13-8 row-count immutability test).
 */
export interface ActionTool<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  inputSchema: z.ZodTypeAny;
  destructive: boolean;
  handler: (input: Input, ctx: ToolContext) => Promise<Output>;
}
