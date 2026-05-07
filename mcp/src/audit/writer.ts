/**
 * MCP per-call audit writer.
 *
 * Wraps `insertAuditLog` from `@recondo/data` with try/catch so a DB
 * outage NEVER blocks an MCP tool call. Failures are logged via the
 * stderr-only `logger.warn`. Audit is observability, not gating.
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

export async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  try {
    await insertAuditLog({
      toolName: entry.toolName,
      arguments: entry.arguments,
      responseBytes: entry.responseBytes,
      clientName: entry.clientName ?? null,
      keyId: entry.keyId ?? null,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { error: errMsg, toolName: entry.toolName },
      "audit insert failed",
    );
  }
}
