/**
 * MCP per-call audit writer.
 *
 * Wraps `insertAuditLog` from `@recondo/data` with try/catch so a DB
 * outage NEVER blocks an MCP tool call. Failures are logged via the
 * stderr-only `logger.warn`. Audit is observability, not gating.
 *
 * Optional `AbortSignal` threading: callers (e.g. the MCP transport)
 * can pass `options.signal` so an in-flight DB insert is cancelled when
 * the request is aborted. The writer still resolves cleanly because the
 * AbortError is swallowed alongside any other failure.
 */

import { insertAuditLog } from "@recondo/data";
import { logger } from "../util/logger.js";

export interface AuditEntry {
  toolName: string;
  arguments: unknown;
  responseBytes: number;
  clientName?: string | null;
  keyId?: string | null;
}

export interface WriteAuditOptions {
  signal?: AbortSignal;
}

export async function writeAuditEntry(
  entry: AuditEntry,
  options?: WriteAuditOptions,
): Promise<void> {
  try {
    await insertAuditLog(
      {
        toolName: entry.toolName,
        arguments: entry.arguments,
        responseBytes: entry.responseBytes,
        clientName: entry.clientName ?? null,
        keyId: entry.keyId ?? null,
      },
      { signal: options?.signal },
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { error: errMsg, toolName: entry.toolName },
      "audit insert failed",
    );
  }
}
