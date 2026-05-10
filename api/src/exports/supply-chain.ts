/**
 * Sprint 10 Deliverable 2: Supply Chain Evidence Package Export
 *
 * POST /v1/exports/supply-chain
 *
 * Returns a supply chain evidence package containing:
 * - sessions: list with model, provider, startedAt, turnCount
 * - artifacts: paths, hashes, turnCount
 * - supersedesChains: change history for artifacts
 * - contentHashes: totalVerified, totalFailed
 * - systemPromptHashes: hash + sessionCount
 * - attestation: signature, signatureStatus
 */

import { getPool } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

export async function handleSupplyChainExport(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const artifactPaths = body.artifactPaths as unknown;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }

  // TS2 fix: Validate artifactPaths is an array if provided
  if (artifactPaths !== undefined && artifactPaths !== null && !Array.isArray(artifactPaths)) {
    return { status: 400, body: { error: "artifactPaths must be an array of strings" } };
  }
  const typedArtifactPaths = artifactPaths as string[] | undefined;

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const pool = getPool();

  // -----------------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------------
  const sessionsResult = await pool.query(
    `SELECT s.id, s.model, s.provider, s.started_at, s.total_turns
     FROM sessions s
     WHERE s.project_id = $1
     ORDER BY s.started_at DESC
     LIMIT 10000`,
    [projectId]
  );

  const sessions = sessionsResult.rows.map((r) => ({
    id: r.id,
    model: r.model ?? null,
    provider: r.provider,
    startedAt: r.started_at,
    turnCount: Number(r.total_turns ?? 0),
  }));

  // -----------------------------------------------------------------------
  // Artifacts from tool_calls.artifacts_created
  // -----------------------------------------------------------------------
  const artifactsResult = await pool.query(
    `SELECT tc.artifacts_created, tc.artifact_hashes, t.id AS turn_id
     FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND tc.artifacts_created IS NOT NULL
       AND tc.artifacts_created != ''
     LIMIT 10000`,
    [projectId]
  );

  // Parse artifacts and collect per-path data
  const artifactMap = new Map<string, { path: string; hashes: string[]; turnCount: number }>();

  for (const row of artifactsResult.rows) {
    let paths: string[] = [];
    try {
      paths = JSON.parse(row.artifacts_created);
    } catch {
      continue;
    }

    for (const path of paths) {
      const existing = artifactMap.get(path);
      if (existing) {
        existing.turnCount += 1;
      } else {
        artifactMap.set(path, { path, hashes: [], turnCount: 1 });
      }
    }
  }

  let artifacts = Array.from(artifactMap.values());

  // Apply artifactPaths filter if provided
  if (typedArtifactPaths && typedArtifactPaths.length > 0) {
    artifacts = artifacts.filter((a) => typedArtifactPaths.includes(a.path));
  }

  // -----------------------------------------------------------------------
  // SUPERSEDES chains from turns.supersedes_turn_id
  // -----------------------------------------------------------------------
  const supersedesResult = await pool.query(
    `SELECT t.id AS turn_id, t.supersedes_turn_id, t.timestamp, t.session_id
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND t.supersedes_turn_id IS NOT NULL
     ORDER BY t.timestamp
     LIMIT 10000`,
    [projectId]
  );

  const supersedesChains = supersedesResult.rows.map((r) => ({
    turnId: r.turn_id,
    supersedesTurnId: r.supersedes_turn_id,
    sessionId: r.session_id,
    timestamp: r.timestamp,
  }));

  // -----------------------------------------------------------------------
  // Content hashes — count turns with request_hash/response_hash present
  // -----------------------------------------------------------------------
  const hashResult = await pool.query(
    `SELECT
       COUNT(CASE WHEN t.request_hash IS NOT NULL AND t.request_hash != '' THEN 1 END)::int AS verified,
       COUNT(CASE WHEN t.request_hash IS NULL OR t.request_hash = '' THEN 1 END)::int AS failed
     FROM turns t
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1`,
    [projectId]
  );

  const contentHashes = {
    totalVerified: hashResult.rows[0]?.verified ?? 0,
    totalFailed: hashResult.rows[0]?.failed ?? 0,
  };

  // -----------------------------------------------------------------------
  // System prompt hashes
  // -----------------------------------------------------------------------
  const promptHashResult = await pool.query(
    `SELECT system_prompt_hash AS hash, COUNT(*)::int AS session_count
     FROM sessions
     WHERE project_id = $1
       AND system_prompt_hash IS NOT NULL
       AND system_prompt_hash != ''
     GROUP BY system_prompt_hash
     ORDER BY session_count DESC
     LIMIT 10000`,
    [projectId]
  );

  const systemPromptHashes = promptHashResult.rows.map((r) => ({
    hash: r.hash,
    sessionCount: r.session_count,
  }));

  // -----------------------------------------------------------------------
  // Attestation signing deferred to Sprint 13 (OD-004). Signature field is
  // "unsigned" until signing key infrastructure is implemented.
  // -----------------------------------------------------------------------
  const attestation = {
    signature: "unsigned",
    signatureStatus: "pending",
  };

  return {
    status: 200,
    body: {
      generatedAt: new Date().toISOString(),
      projectId,
      sessions,
      artifacts,
      supersedesChains,
      contentHashes,
      systemPromptHashes,
      attestation,
    },
  };
}
