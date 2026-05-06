/**
 * Sprint 11 Deliverable 2: SUPERSEDES Chain Audit Export (Change Traceability)
 *
 * POST /v1/exports/change-traceability
 *
 * Walks the supersedes_turn_id chain using application-level iteration over a pre-fetched result set to build a
 * complete change history for any artifact (file path). Returns:
 * - changeHistory: ordered array of changes with turn/session/model/intent
 * - originatingIntent: the first session's initial_intent
 * - chainLength: number of changes
 * - contentHashes: first and latest SHA-256
 * - summary: human-readable description
 *
 * Auth required, project scoped.
 */

import { getPool, maskPlaceholderPaths } from "@recondo/data";
import type { ApiKeyInfo } from "../context.js";

const QUERY_LIMIT = 10000;

export async function handleChangeTraceability(
  body: Record<string, unknown>,
  apiKey: ApiKeyInfo
): Promise<{ status: number; body: Record<string, unknown> }> {
  const projectId = body.projectId as string | undefined;
  const artifactPath = body.artifactPath as string | undefined;

  if (!projectId) {
    return { status: 400, body: { error: "Missing required field: projectId" } };
  }
  if (!artifactPath) {
    return { status: 400, body: { error: "Missing required field: artifactPath" } };
  }

  // Project scoping
  if (apiKey.projectId && apiKey.projectId !== projectId) {
    return { status: 403, body: { error: "Forbidden" } };
  }

  const pool = getPool();

  // Step 1: Find all tool_calls that created/modified this artifact in the project.
  // Escape the artifactPath for LIKE pattern matching (escape %, _, \)
  const escapedPath = artifactPath
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");

  const toolCallsResult = await pool.query(
    `SELECT tc.turn_id, tc.tool_name, t.session_id, t.timestamp, t.model,
            t.request_hash, t.supersedes_turn_id, s.initial_intent
     FROM tool_calls tc
     JOIN turns t ON tc.turn_id = t.id
     JOIN sessions s ON t.session_id = s.id
     WHERE s.project_id = $1
       AND tc.artifacts_created LIKE $2
     ORDER BY t.timestamp ASC
     LIMIT $3`,
    [projectId, `%${escapedPath}%`, QUERY_LIMIT]
  );

  if (toolCallsResult.rows.length === 0) {
    // No changes found for this artifact
    return {
      status: 200,
      body: {
        generatedAt: new Date().toISOString(),
        projectId,
        artifactPath,
        changeHistory: [],
        originatingIntent: null,
        chainLength: 0,
        contentHashes: { first: null, latest: null },
        summary: `No changes found for artifact: ${artifactPath}`,
      },
    };
  }

  // Step 2: Walk the supersedes chain. We have the turn IDs from tool_calls.
  // Build the change history ordered by timestamp.
  // For each turn that touches this artifact, we follow the supersedes chain.

  // Collect all turn IDs that touch this artifact
  const artifactTurnIds = new Set(toolCallsResult.rows.map((r) => r.turn_id));

  // For chain walking, find the root turn (the one with no supersedes_turn_id
  // or whose supersedes_turn_id is not in our set)
  const turnDataMap = new Map<string, {
    turnId: string;
    sessionId: string;
    timestamp: string;
    model: string;
    intent: string;
    toolName: string;
    supersedes: string | null;
    requestHash: string;
  }>();

  for (const row of toolCallsResult.rows) {
    turnDataMap.set(row.turn_id, {
      turnId: row.turn_id,
      sessionId: row.session_id,
      timestamp: row.timestamp,
      model: row.model,
      // FIND-1-M re-open: change-traceability exports are part of
      // supply-chain attestation evidence. Mask placeholder paths out
      // of `intent` so local filesystem paths never reach an auditor.
      intent: maskPlaceholderPaths(row.initial_intent as string | null) ?? "",
      toolName: row.tool_name,
      supersedes: row.supersedes_turn_id,
      requestHash: row.request_hash,
    });
  }

  // Build chain order: start from root (turn without a superseded-by in set, or supersedes=null)
  // and follow forward.
  // First, find root(s): turns whose supersedes_turn_id is null or not in our artifact set
  const roots: string[] = [];
  // Map from superseded turn_id to the list of turn_ids that supersede it.
  // Uses string[] to handle branching (multiple children superseding the same parent).
  // When walking the chain, we follow the primary (most recent) child. Branching is a
  // known limitation: only the primary path is included in the linear chain output.
  const childMap = new Map<string, string[]>();

  for (const [turnId, data] of turnDataMap) {
    if (data.supersedes !== null && artifactTurnIds.has(data.supersedes)) {
      const existing = childMap.get(data.supersedes);
      if (existing) {
        existing.push(turnId);
      } else {
        childMap.set(data.supersedes, [turnId]);
      }
    }
    if (data.supersedes === null || !artifactTurnIds.has(data.supersedes)) {
      roots.push(turnId);
    }
  }

  // Walk chain from each root
  const changeHistory: Array<{
    turnId: string;
    sessionId: string;
    timestamp: string;
    model: string;
    intent: string;
    toolName: string;
    supersedes: string | null;
  }> = [];

  for (const rootId of roots) {
    const visited = new Set<string>();
    let currentId: string | undefined = rootId;
    while (currentId && turnDataMap.has(currentId) && !visited.has(currentId)) {
      visited.add(currentId);
      const data = turnDataMap.get(currentId)!;
      changeHistory.push({
        turnId: data.turnId,
        sessionId: data.sessionId,
        timestamp: data.timestamp,
        model: data.model,
        intent: data.intent,
        toolName: data.toolName,
        supersedes: (data.supersedes !== null && artifactTurnIds.has(data.supersedes))
          ? data.supersedes
          : null,
      });
      // Follow the primary (most recent) child when branches exist
      const children = childMap.get(currentId);
      currentId = children ? children[children.length - 1] : undefined;
    }
  }

  // Sort by timestamp to ensure correct order
  changeHistory.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Fix supersedes: the first entry should have null, subsequent should reference previous
  // Actually, the supersedes field from the DB is correct - the first entry (root) has null supersedes,
  // and each subsequent entry supersedes the previous turn.
  // But for entries whose supersedes_turn_id was not in our artifact set, we already set it to null.

  // Step 3: Compute originating intent from the first session in the chain
  const originatingIntent = changeHistory.length > 0
    ? changeHistory[0].intent
    : null;

  // Step 4: Content hashes from first and latest turns
  const firstTurn = changeHistory.length > 0 ? turnDataMap.get(changeHistory[0].turnId) : null;
  const latestTurn = changeHistory.length > 0
    ? turnDataMap.get(changeHistory[changeHistory.length - 1].turnId)
    : null;

  const contentHashes = {
    first: firstTurn?.requestHash ?? null,
    latest: latestTurn?.requestHash ?? null,
  };

  // Step 5: Summary
  const chainLength = changeHistory.length;
  const summary = chainLength > 0
    ? `Artifact "${artifactPath}" has ${chainLength} change(s) across ${new Set(changeHistory.map((h) => h.sessionId)).size} session(s). Originating intent: "${originatingIntent}".`
    : `No changes found for artifact: ${artifactPath}`;

  return {
    status: 200,
    body: {
      generatedAt: new Date().toISOString(),
      projectId,
      artifactPath,
      changeHistory,
      originatingIntent,
      chainLength,
      contentHashes,
      summary,
    },
  };
}
