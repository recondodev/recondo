/**
 * Sprint 9 Deliverable 3: AI Risk Auto-Classification
 *
 * POST /v1/risk/classify — classify a session's risk from its initial_intent
 * GET  /v1/risk/profile  — aggregated risk profile for a project
 *
 * Classification rules (checked in priority order: critical > low > high > medium):
 * - Critical: deploy, production, migration, compliance, rollback
 * - Low: document, test, format, readme, comment, lint
 * - High: security, auth, infrastructure, database, financial, payment
 * - Medium: feature, refactor, update, add, implement
 * - Default (no match): medium
 *
 * Low precedes high intentionally: the primary action ("write tests") determines
 * risk level, not the incidental subject ("auth module"). See classifyRiskLevel JSDoc.
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

/**
 * Classify risk level from intent text using keyword matching.
 * Case-insensitive. Returns the matching level based on priority order.
 *
 * Canonical implementation — import from "risk/classification.ts" everywhere.
 * Do NOT duplicate this function in other files.
 *
 * Priority order: critical > low > high > medium > default(medium).
 *
 * This order is intentional and validated by acceptance tests. Low-risk keywords
 * (e.g. "test", "document") are checked before high-risk keywords (e.g. "auth",
 * "security") so that intents like "write unit tests for the auth module" classify
 * as "low" rather than "high". The rationale: the primary action ("write tests")
 * determines risk, not the incidental subject ("auth module"). Critical keywords
 * always take precedence since they indicate production-impacting operations.
 */
export function classifyRiskLevel(intent: string): string {
  const lower = intent.toLowerCase();

  const critical = ["deploy", "production", "migration", "compliance", "rollback"];
  const low = ["document", "test", "format", "readme", "comment", "lint"];
  const high = ["security", "auth", "infrastructure", "database", "financial", "payment"];
  const medium = ["feature", "refactor", "update", "add", "implement"];

  // Priority order: critical > low > high > medium.
  // See JSDoc above for rationale on why low precedes high.
  for (const keyword of critical) {
    if (lower.includes(keyword)) return "critical";
  }
  for (const keyword of low) {
    if (lower.includes(keyword)) return "low";
  }
  for (const keyword of high) {
    if (lower.includes(keyword)) return "high";
  }
  for (const keyword of medium) {
    if (lower.includes(keyword)) return "medium";
  }

  return "medium"; // default
}

/**
 * POST /v1/risk/classify
 *
 * Body: { projectId, sessionId?, intent }
 * Returns: { riskLevel, intent, sessionId? }
 */
export async function handleClassifyRisk(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const intent = body.intent as string | undefined;
  const sessionId = body.sessionId as string | undefined;
  const projectId = body.projectId as string | undefined;

  if (!intent) {
    return { status: 400, body: { error: "Missing required field: intent" } };
  }

  // Project scoping: if API key is project-scoped, enforce it
  if (apiKey.projectId && projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden: cross-project access not allowed" } };
  }

  const riskLevel = classifyRiskLevel(intent);

  // Persist the classification if sessionId is provided
  // Table created by migration 006_runtime-tables.sql
  if (sessionId) {
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO session_risk (session_id, risk_level, intent) VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO UPDATE SET risk_level = $2, intent = $3, classified_at = NOW()`,
        [sessionId, riskLevel, intent]
      );
    } catch {
      // Non-fatal: classification result is still returned even if persistence fails
    }
  }

  return {
    status: 200,
    body: {
      riskLevel,
      intent,
      sessionId: sessionId ?? null,
    },
  };
}

/**
 * GET /v1/risk/profile
 *
 * Query: { projectId }
 * Returns: { low, medium, high, critical }
 */
export async function handleRiskProfile(
  apiKey: ApiKeyInfo,
  query: { projectId?: string }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const effectiveProjectId = apiKey.projectId ?? query.projectId;

  if (!effectiveProjectId) {
    return { status: 400, body: { error: "Missing required query parameter: projectId" } };
  }

  if (apiKey.projectId && query.projectId && apiKey.projectId !== query.projectId) {
    return { status: 403, body: { error: "Forbidden: cross-project access not allowed" } };
  }

  const profile = { low: 0, medium: 0, high: 0, critical: 0 };

  // Table created by migration 006_runtime-tables.sql
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT sr.risk_level, COUNT(*)::int AS cnt
       FROM session_risk sr
       JOIN sessions s ON sr.session_id = s.id
       WHERE s.project_id = $1
       GROUP BY sr.risk_level`,
      [effectiveProjectId]
    );

    for (const row of result.rows) {
      const level = (row.risk_level as string).toLowerCase();
      if (level in profile) {
        profile[level as keyof typeof profile] = row.cnt;
      }
    }
  } catch {
    // If table doesn't exist yet, return zeros
  }

  return {
    status: 200,
    body: profile,
  };
}
