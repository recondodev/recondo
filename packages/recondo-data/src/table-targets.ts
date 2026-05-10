/**
 * Static table-target metadata for public data-layer functions.
 *
 * The catalog parity lint uses this to enforce the v1 immutability
 * invariant: MCP action tools may write operational tables, but they
 * must not write captured-byte tables owned by the gateway capture path.
 */

export const CAPTURED_TABLES = [
  "sessions",
  "turns",
  "tool_calls",
  "attachments",
] as const;

export const TABLE_TARGETS: Record<string, readonly string[]> = {
  generateReport: ["reports"],
  updateControlStatus: ["compliance_controls", "compliance_audit_log"],
  createPolicy: ["policies"],
  updatePolicy: ["policies"],
  deletePolicy: ["policies", "policy_triggers"],
  createApiKey: ["registered_keys"],
  revokeApiKey: ["registered_keys"],
  insertAuditLog: ["audit_log"],
  mintScopedKey: ["api_keys", "audit_log"],
};
