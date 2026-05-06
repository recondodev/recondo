/**
 * Sprint 10 Deliverable 3: Custom YAML-Defined Export Templates
 *
 * POST /v1/exports/custom
 *
 * Accepts a template with sections, each containing a SQL SELECT query.
 * Runs queries against the project's data and returns structured results.
 *
 * Security:
 * - STRICT allowlist: query MUST start with SELECT (after trimming)
 * - Expanded blocklist: INSERT, UPDATE, DELETE, DROP, TRUNCATE, ALTER, CREATE,
 *   GRANT, REVOKE, COPY, DO, SET, CALL, EXECUTE, INTO — rejected anywhere (case-insensitive)
 * - Metadata enumeration blocked: pg_catalog, pg_proc, information_schema rejected
 * - No semicolons (prevents statement chaining)
 * - Every query MUST contain $project_id for project scoping
 * - SET TRANSACTION READ ONLY before each query for defense-in-depth
 * - LIMIT 10000 appended if no LIMIT present
 *
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

interface TemplateSection {
  title: string;
  query: string;
}

interface Template {
  name: string;
  sections: TemplateSection[];
}

/** Maximum rows returned per custom query section */
const CUSTOM_QUERY_LIMIT = 10000;

/**
 * Validate that a SQL query is safe to execute:
 * - Must start with SELECT (strict allowlist, case-insensitive)
 * - No semicolons (prevents statement chaining)
 * - No dangerous keywords anywhere (expanded blocklist, word-boundary matching)
 * - No pg_catalog / pg_proc / information_schema access
 * - Must contain $project_id placeholder for project scoping
 */
function validateSql(query: string): string | null {
  const trimmed = query.trim();

  // Check for semicolons (prevents multi-statement injection)
  if (trimmed.includes(";")) {
    return "SQL query must not contain semicolons";
  }

  // Normalize to uppercase for keyword matching
  const upper = trimmed.toUpperCase();

  // STRICT ALLOWLIST: must start with SELECT
  if (!upper.startsWith("SELECT")) {
    return "Only SELECT queries are allowed";
  }

  // EXPANDED BLOCKLIST: dangerous keywords (word boundary matching)
  const dangerousKeywords = [
    "INSERT", "UPDATE", "DELETE", "DROP", "TRUNCATE", "ALTER", "CREATE",
    "GRANT", "REVOKE", "COPY", "DO", "SET", "CALL", "EXECUTE", "INTO",
  ];
  for (const keyword of dangerousKeywords) {
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(trimmed)) {
      return `SQL query must not contain ${keyword} statements`;
    }
  }

  // Block metadata enumeration (pg_catalog, pg_proc, information_schema)
  const metadataPatterns = ["pg_catalog", "pg_proc", "information_schema"];
  for (const pattern of metadataPatterns) {
    if (trimmed.toLowerCase().includes(pattern)) {
      return `SQL query must not reference ${pattern}`;
    }
  }

  // Require $project_id placeholder for project scoping (SEC3)
  if (!trimmed.includes("$project_id")) {
    return "Query must reference $project_id for project scoping";
  }

  return null; // Valid
}

export async function handleCustomExport(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const template = body.template as unknown;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  if (!template) {
    return { status: 400, body: { error: "Missing required field: template" } };
  }

  // TS1: Runtime validation of request body shape
  if (typeof template !== "object" || template === null || Array.isArray(template)) {
    return { status: 400, body: { error: "template must be an object" } };
  }

  const tpl = template as Record<string, unknown>;

  if (!tpl.sections || !Array.isArray(tpl.sections)) {
    return { status: 400, body: { error: "template.sections must be an array" } };
  }

  if (tpl.sections.length === 0) {
    return { status: 400, body: { error: "Template must have at least one section" } };
  }

  // Validate each section has string title and string query
  for (const section of tpl.sections) {
    if (typeof section !== "object" || section === null || Array.isArray(section)) {
      return { status: 400, body: { error: "Each section must be an object with title and query" } };
    }
    const sec = section as Record<string, unknown>;
    if (typeof sec.title !== "string" || sec.title.length === 0) {
      return { status: 400, body: { error: "Each section must have a non-empty string title" } };
    }
    if (typeof sec.query !== "string" || sec.query.length === 0) {
      return { status: 400, body: { error: "Each section must have a non-empty string query" } };
    }
  }

  const typedSections = tpl.sections as TemplateSection[];

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  // Validate all queries before executing any
  for (const section of typedSections) {
    const error = validateSql(section.query);
    if (error) {
      return {
        status: 400,
        body: { error: `Invalid SQL in section '${section.title}': ${error}` },
      };
    }
  }

  const pool = getPool();
  const sections: Array<Record<string, unknown>> = [];

  for (const section of typedSections) {
    // Replace $project_id with parameterized $1
    let query = section.query.replace(/\$project_id/g, "$1");

    // SEC5: Enforce LIMIT. If user provides their own, cap it at CUSTOM_QUERY_LIMIT.
    // NEW-3 fix: prevent user-supplied LIMIT > 10000 bypass.
    const limitMatch = query.match(/\bLIMIT\s+(\d+)/i);
    if (limitMatch) {
      const userLimit = parseInt(limitMatch[1], 10);
      if (userLimit > CUSTOM_QUERY_LIMIT) {
        query = query.replace(/\bLIMIT\s+\d+/i, `LIMIT ${CUSTOM_QUERY_LIMIT}`);
      }
    } else {
      query = `${query} LIMIT ${CUSTOM_QUERY_LIMIT}`;
    }

    try {
      // Defense-in-depth: SET TRANSACTION READ ONLY before executing each custom query
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET TRANSACTION READ ONLY");
        const result = await client.query(query, [projectId]);
        await client.query("COMMIT");
        sections.push({
          title: section.title,
          data: result.rows,
        });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => { /* ignore rollback errors */ });
        sections.push({
          title: section.title,
          data: [],
          error: err instanceof Error ? err.message : "Query execution failed",
        });
      } finally {
        client.release();
      }
    } catch (err) {
      sections.push({
        title: section.title,
        data: [],
        error: err instanceof Error ? err.message : "Query execution failed",
      });
    }
  }

  return {
    status: 200,
    body: {
      name: (tpl.name as string) ?? "custom",
      generatedAt: new Date().toISOString(),
      projectId,
      sections,
    },
  };
}
