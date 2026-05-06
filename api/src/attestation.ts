/**
 * Sprint 5 Deliverable 3: Attestation Document Generator
 *
 * POST /v1/attestation/generate
 *
 * Generates a supply chain attestation document containing:
 * - Artifact list with SHA-256 hashes
 * - Provenance: every session and turn that touched each artifact
 * - Originating intents from each session
 * - Model versions used
 * - System prompt hashes
 * - Time range
 * - Signature (placeholder "unsigned" until OD-004)
 * - Generation timestamp
 */

import { createHash } from "crypto";
import type pg from "pg";
import { getPool, maskPlaceholderPaths } from "@recondo/data";
import type { ApiKeyInfo } from "./context.js";

// N5 fix: AttestationRequest interface removed — input validation is done
// inline with runtime type checks, not static types on untyped body.

interface ArtifactEntry {
  path: string;
  hash: string;
}

interface ProvenanceEntry {
  sessionId: string;
  turnId: string;
  toolName: string;
  timestamp: string;
}

interface AttestationDocument {
  artifacts: ArtifactEntry[];
  provenance: ProvenanceEntry[];
  intents: string[];
  models: string[];
  systemPromptHashes: string[];
  timeRange: { start: string; end: string };
  signature: string;
  generatedAt: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function handleAttestationGenerate(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const artifactPaths = body.artifactPaths as string[] | undefined;
  const projectId = body.projectId as string | undefined;

  // Validation
  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  if (!artifactPaths || !Array.isArray(artifactPaths) || artifactPaths.length === 0) {
    return { status: 400, body: { error: "artifactPaths must be a non-empty array" } };
  }

  // W6 fix: Limit artifactPaths array size to prevent abuse.
  if (artifactPaths.length > 100) {
    return { status: 400, body: { error: "artifactPaths must contain at most 100 entries" } };
  }

  // W9/W14 fix: Non-admin keys attempting cross-project access get 403 Forbidden.
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const pool = getPool();

  // Find all tool calls that created/modified any of the requested artifact paths
  // We look in artifacts_created JSON arrays for matching paths
  const provenanceEntries: ProvenanceEntry[] = [];
  const sessionIds = new Set<string>();
  const turnIds = new Set<string>();

  for (const artifactPath of artifactPaths) {
    // Query tool_calls that have the artifact path in their artifacts_created field
    // Join with turns and sessions to get context
    // B8 fix: Escape LIKE wildcard characters to prevent injection.
    const escapedPath = artifactPath.replace(/[%_\\]/g, "\\$&");
    // B6 fix: Add LIMIT to prevent unbounded result sets.
    const result = await pool.query(
      `SELECT tc.turn_id, tc.tool_name, t.session_id, t.timestamp, tc.artifacts_created
       FROM tool_calls tc
       JOIN turns t ON tc.turn_id = t.id
       JOIN sessions s ON t.session_id = s.id
       WHERE s.project_id = $1
         AND tc.artifacts_created IS NOT NULL
         AND tc.artifacts_created LIKE $2 ESCAPE '\\'
       ORDER BY t.timestamp ASC
       LIMIT 10000`,
      [projectId, `%${escapedPath}%`]
    );

    for (const row of result.rows) {
      // B2 fix: Verify the path is actually an exact element in the JSON array,
      // not just a substring match from the LIKE query.
      let isExactMatch = false;
      try {
        const artifacts: string[] = JSON.parse(row.artifacts_created ?? "[]");
        isExactMatch = artifacts.includes(artifactPath);
      } catch {
        isExactMatch = false;
      }
      if (!isExactMatch) continue;

      provenanceEntries.push({
        sessionId: row.session_id,
        turnId: row.turn_id,
        toolName: row.tool_name,
        timestamp: row.timestamp,
      });
      sessionIds.add(row.session_id);
      turnIds.add(row.turn_id);
    }
  }

  // Walk SUPERSEDES chains for all found turns to include predecessor turns
  // W8 fix: Add visited set for cycle detection.
  // B4 fix: Add project scoping to chain walk queries.
  for (const turnId of [...turnIds]) {
    let currentTurnId: string | null = turnId;
    const maxDepth = 100;
    let depth = 0;
    const visitedInChain = new Set<string>();

    while (currentTurnId && depth < maxDepth) {
      // W8 fix: Break immediately if already visited (cycle detection)
      if (visitedInChain.has(currentTurnId)) break;
      visitedInChain.add(currentTurnId);

      // B4 fix: Join sessions to check project_id, preventing cross-project leaks
      const chainRows: pg.QueryResult = await pool.query(
        `SELECT t.supersedes_turn_id, t.session_id, t.timestamp
         FROM turns t
         JOIN sessions s ON t.session_id = s.id
         WHERE t.id = $1 AND s.project_id = $2`,
        [currentTurnId, projectId]
      );

      if (chainRows.rows.length === 0) break;

      const nextTurnId: string | null = chainRows.rows[0].supersedes_turn_id;
      if (!nextTurnId) break;

      // Add the predecessor to provenance if not already there
      if (!turnIds.has(nextTurnId)) {
        turnIds.add(nextTurnId);
        sessionIds.add(chainRows.rows[0].session_id as string);

        // B4 fix: predecessor query also scoped by project
        const predTcResult = await pool.query(
          `SELECT tc.tool_name FROM tool_calls tc
           JOIN turns t ON tc.turn_id = t.id
           JOIN sessions s ON t.session_id = s.id
           WHERE tc.turn_id = $1 AND s.project_id = $2 LIMIT 1`,
          [nextTurnId, projectId]
        );

        const predTurnResult = await pool.query(
          `SELECT t.timestamp, t.session_id FROM turns t
           JOIN sessions s ON t.session_id = s.id
           WHERE t.id = $1 AND s.project_id = $2`,
          [nextTurnId, projectId]
        );

        if (predTurnResult.rows.length > 0) {
          provenanceEntries.push({
            sessionId: predTurnResult.rows[0].session_id,
            turnId: nextTurnId,
            toolName: predTcResult.rows.length > 0 ? predTcResult.rows[0].tool_name : "unknown",
            timestamp: predTurnResult.rows[0].timestamp,
          });
        }
      }

      currentTurnId = nextTurnId;
      depth++;
    }
  }

  // N4: Known limitation — session/turn queries below are N+1 (one query per
  // sessionId/turnId). Future optimization: batch these into IN-list queries
  // (e.g., WHERE id = ANY($1::text[])) to reduce round-trips for large attestations.
  // Gather session-level data
  const intents: string[] = [];
  const models = new Set<string>();
  const systemPromptHashes = new Set<string>();
  const timestamps: Date[] = [];

  for (const sessionId of sessionIds) {
    const sessResult = await pool.query(
      `SELECT initial_intent, model, system_prompt_hash FROM sessions WHERE id = $1`,
      [sessionId]
    );

    if (sessResult.rows.length > 0) {
      const row = sessResult.rows[0];
      if (row.initial_intent) {
        // FIND-1-M re-open: attestation bundles are shipped to
        // auditors / regulators. Sanitise intent strings before they
        // enter the attestation envelope — raw storage remains intact
        // for internal audit, but attestation output must not leak
        // local filesystem paths from user machines.
        const sanitized = maskPlaceholderPaths(row.initial_intent as string);
        if (sanitized) intents.push(sanitized);
      }
      if (row.model) models.add(row.model);
      if (row.system_prompt_hash) systemPromptHashes.add(row.system_prompt_hash);
    }
  }

  // Gather model info from turns as well
  for (const turnId of turnIds) {
    const turnResult = await pool.query(
      `SELECT model, timestamp FROM turns WHERE id = $1`,
      [turnId]
    );

    if (turnResult.rows.length > 0) {
      const row = turnResult.rows[0];
      if (row.model) models.add(row.model);
      if (row.timestamp) {
        const d = new Date(row.timestamp);
        if (!isNaN(d.getTime())) timestamps.push(d);
      }
    }
  }

  // Build time range
  let timeRange: { start: string; end: string };
  if (timestamps.length > 0) {
    timestamps.sort((a, b) => a.getTime() - b.getTime());
    timeRange = {
      start: timestamps[0].toISOString(),
      end: timestamps[timestamps.length - 1].toISOString(),
    };
  } else {
    const now = new Date().toISOString();
    timeRange = { start: now, end: now };
  }

  // Build artifacts list
  const artifacts: ArtifactEntry[] = artifactPaths.map((p) => ({
    path: p,
    hash: sha256(p),
  }));

  const attestation: AttestationDocument & { signatureStatus: string } = {
    artifacts,
    provenance: provenanceEntries,
    intents: [...new Set(intents)],
    models: [...models],
    systemPromptHashes: [...systemPromptHashes],
    timeRange,
    signature: "unsigned",
    // N1 fix: Document explicitly that attestation is unsigned.
    signatureStatus: "unsigned - pending OD-004 signing key infrastructure",
    generatedAt: new Date().toISOString(),
  };

  return { status: 200, body: { attestation } };
}
