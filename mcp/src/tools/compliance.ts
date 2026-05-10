/**
 * `recondo_compliance` — compliance posture surface dispatched on the
 * required `view` enum (3 values):
 *
 *   - "summary"    → `getComplianceSummary(apiKey, options)`
 *                    Single record (overallScore, captureIntegrity,
 *                    findingsBySeverity, lastAssessment, ...).
 *   - "frameworks" → `listComplianceFrameworks(apiKey, options)`
 *                    Canonical 5-key list envelope of framework rows
 *                    (id / name / subtitle / compliancePercentage /
 *                    controls).
 *   - "audit_log"  → `listComplianceAuditLog(apiKey, filter, options)`
 *                    Canonical 5-key list envelope of CONTROL-STATUS
 *                    MUTATION rows (id / controlId / oldStatus /
 *                    newStatus / changedBy / changedAt / reason). This
 *                    reads the `compliance_audit_log` TABLE and is
 *                    DISTINCT from the per-call MCP `audit_log` written
 *                    by `insertAuditLog` (C13-7).
 *
 * `summary` returns a single record (subject to the 32 KB
 * single-record budget); the other two return the list envelope.
 *
 * `ctx.abortSignal` is threaded into the dispatched call.
 */

import {
  getComplianceSummary,
  listComplianceFrameworks,
  listComplianceAuditLog,
} from "@recondo/data";
import type {
  ApiKeyInfo,
  ComplianceAuditEntry,
  ComplianceAuditFilter,
  ComplianceFrameworkRow,
  ListEnvelope,
} from "@recondo/data";
import { z } from "zod";

import { buildListEnvelope } from "../envelope/list.js";
import {
  enforceListBudget,
  enforceSingleRecordBudget,
} from "../envelope/truncate.js";
import type { AuthContext } from "../auth/context.js";
import type { ReadTool } from "../registry/types.js";

const inputShape = {
  view: z.enum(["summary", "frameworks", "audit_log"]),
  control_id: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).optional(),
  offset: z.number().int().min(0).optional(),
};

const summaryInputSchema = z
  .object({
    view: z.literal("summary"),
    project_id: z.string().optional(),
  })
  .strict();

const frameworksInputSchema = z
  .object({
    view: z.literal("frameworks"),
    project_id: z.string().optional(),
  })
  .strict();

const auditLogInputSchema = z
  .object({
    view: z.literal("audit_log"),
    control_id: z.string().optional(),
    project_id: z.string().optional(),
    limit: z.number().int().min(1).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export const complianceInputSchema = z.discriminatedUnion("view", [
  summaryInputSchema,
  frameworksInputSchema,
  auditLogInputSchema,
]);
export type ComplianceInput = z.infer<typeof complianceInputSchema>;

const DESCRIPTION =
  "Compliance posture surface. Dispatches on the required `view` enum " +
  "(summary | frameworks | audit_log). `summary` returns a single " +
  "record (overall score, capture integrity, findings by severity). " +
  "`frameworks` returns the canonical 5-key list envelope of framework " +
  "rows. `audit_log` reads the `compliance_audit_log` table " +
  "(control-status mutation history, distinct from the per-call MCP " +
  "audit log) and supports `control_id` filtering plus limit/offset.";

function authContextToApiKey(
  auth: AuthContext,
  projectIdOverride?: string,
): ApiKeyInfo {
  return {
    id: auth.keyId,
    projectId: projectIdOverride ?? auth.projectId,
    rateLimitRpm: 0,
  };
}

type FrameworksEnvelope = ListEnvelope<ComplianceFrameworkRow>;
type AuditLogEnvelope = ListEnvelope<ComplianceAuditEntry> & {
  total: number;
  limit: number;
  offset: number;
};

export const complianceTool: ReadTool<ComplianceInput, unknown> = {
  name: "recondo_compliance",
  description: DESCRIPTION,
  inputShape,
  inputSchema: complianceInputSchema as unknown as z.SomeZodObject,
  handler: async (rawInput, ctx) => {
    const input = complianceInputSchema.parse(rawInput);
    const apiKey = authContextToApiKey(ctx.auth, input.project_id);

    if (input.view === "summary") {
      const record = await getComplianceSummary(apiKey, {
        signal: ctx.abortSignal,
      });
      return enforceSingleRecordBudget(record, JSON.stringify);
    }

    if (input.view === "frameworks") {
      const envelope: FrameworksEnvelope = await listComplianceFrameworks(
        apiKey,
        { signal: ctx.abortSignal },
      );
      const offset = 0;
      const budget = enforceListBudget(envelope.items, offset, JSON.stringify);
      if (!budget.truncated) {
        return envelope;
      }
      return buildListEnvelope({
        items: budget.items,
        nextOffset: budget.nextOffset,
        truncated: true,
      });
    }

    // view === "audit_log"
    const filter: ComplianceAuditFilter = {};
    if (input.control_id !== undefined) filter.controlId = input.control_id;

    const listOptions: {
      signal?: AbortSignal;
      limit?: number;
      offset?: number;
    } = { signal: ctx.abortSignal };
    if (input.limit !== undefined) listOptions.limit = input.limit;
    if (input.offset !== undefined) listOptions.offset = input.offset;

    const envelope: AuditLogEnvelope = await listComplianceAuditLog(
      apiKey,
      filter,
      listOptions,
    );
    const offset = envelope.offset;
    const budget = enforceListBudget(envelope.items, offset, JSON.stringify);
    if (!budget.truncated) {
      return envelope;
    }
    return buildListEnvelope({
      items: budget.items,
      nextOffset: budget.nextOffset,
      truncated: true,
    });
  },
};
