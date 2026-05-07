/**
 * D-C1-8 — writeAuditEntry is observability, not gating.
 *
 * It calls `insertAuditLog` from `@recondo/data` with the same fields,
 * and SWALLOWS errors (logger.warn, no throw). The MCP transport must
 * never block on audit DB writes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { insertAuditLog, warn } = vi.hoisted(() => ({
  insertAuditLog: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@recondo/data", () => ({
  insertAuditLog,
}));

vi.mock("../../src/util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn,
    error: vi.fn(),
  },
}));

import { writeAuditEntry } from "../../src/audit/writer.js";

describe("D-C1-8 writeAuditEntry", () => {
  beforeEach(() => {
    insertAuditLog.mockReset();
    warn.mockReset();
  });

  it("calls insertAuditLog with the same fields", async () => {
    insertAuditLog.mockResolvedValueOnce(undefined);
    await writeAuditEntry({
      toolName: "recondo_list_sessions",
      arguments: { limit: 10 },
      responseBytes: 4321,
      clientName: "claude-code",
      keyId: "dev-bypass",
    });
    expect(insertAuditLog).toHaveBeenCalledTimes(1);
    const arg = insertAuditLog.mock.calls[0][0];
    expect(arg).toMatchObject({
      toolName: "recondo_list_sessions",
      arguments: { limit: 10 },
      responseBytes: 4321,
      clientName: "claude-code",
      keyId: "dev-bypass",
    });
  });

  it("swallows insertAuditLog rejection and logs a warning", async () => {
    insertAuditLog.mockRejectedValueOnce(new Error("db down"));
    await expect(
      writeAuditEntry({
        toolName: "recondo_list_sessions",
        arguments: {},
        responseBytes: 0,
        clientName: null,
        keyId: null,
      }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    // Find a warn call that mentions the failure.
    const allArgs = warn.mock.calls.flat();
    const stringified = JSON.stringify(allArgs);
    expect(stringified).toMatch(/db down/);
    expect(stringified).toMatch(/audit insert failed/);
  });
});
