/**
 * Audit export routes -- Sprint D4.2.
 *
 * GET /v1/audit/export.csv  -- CSV export of audit trail
 * GET /v1/audit/export.json -- JSON evidence package export
 *
 * Both endpoints:
 * - Require authentication (Bearer token)
 * - Support search, type, from, to query parameters
 * - Return 401 for unauthenticated requests
 */

import type { FastifyInstance } from "fastify";
import { authenticateRequest } from "../auth.js";
import { logAuditEntry } from "../audit.js";
import { getSourceIp } from "../middleware/rest-helpers.js";
import { getAuditEntries } from "../resolvers/audit.js";

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/audit/export.csv
   *
   * Returns audit trail entries as CSV with header row.
   * Columns: timestamp, session_id, sequence_num, provider, request_hash,
   *          response_hash, total_tokens, integrity_status, http_status, capture_complete
   */
  app.get("/v1/audit/export.csv", async (request, reply) => {
    const sourceIp = getSourceIp(request);
    const userAgent = (request.headers["user-agent"] ?? "") as string;
    const authHeader = request.headers["authorization"] as string | undefined;
    let apiKey = await authenticateRequest(authHeader);

    // Dev bypass: skip auth in development
    if (!apiKey && process.env.NODE_ENV === "development" && !process.env.RECONDO_DASHBOARD_API_KEY) {
      apiKey = { id: "dev-bypass", projectId: null, rateLimitRpm: 1000 };
    }

    if (!apiKey) {
      await logAuditEntry({
        apiKeyId: "anonymous",
        queryType: "audit.export.csv",
        sourceIp,
        userAgent,
        responseStatus: 401,
      });
      reply.status(401).send({ error: "Unauthorized: invalid or missing API key" });
      return;
    }

    // W4: Execute query BEFORE logging audit entry, so we log the actual response status
    const query = request.query as Record<string, string>;
    let entries;
    try {
      entries = await getAuditEntries({
        search: query.search,
        type: query.type,
        from: query.from,
        to: query.to,
        projectId: apiKey.projectId,
      });
    } catch (err) {
      // W4: Log with status 500 on query failure
      await logAuditEntry({
        apiKeyId: apiKey.id,
        queryType: "audit.export.csv",
        sourceIp,
        userAgent,
        responseStatus: 500,
      });
      throw err;
    }

    await logAuditEntry({
      apiKeyId: apiKey.id,
      queryType: "audit.export.csv",
      sourceIp,
      userAgent,
      responseStatus: 200,
    });

    // N7: CSV field escaping function used for both header and data values
    const escapeCsvField = (f: string): string => {
      if (f.includes(",") || f.includes('"') || f.includes("\n")) {
        return `"${f.replace(/"/g, '""')}"`;
      }
      return f;
    };

    // Build CSV
    // N7: Pass header values through the same escaping function for consistency
    const headerFields = [
      "timestamp", "session_id", "sequence_num", "provider", "model",
      "request_hash", "response_hash", "total_tokens", "integrity_status",
      "http_status", "capture_complete",
    ];
    const header = headerFields.map(escapeCsvField).join(",");
    const rows = entries.map((e) => {
      const fields = [
        e.timestamp,
        e.sessionId,
        String(e.sequenceNum),
        e.provider,
        e.model ?? "",
        e.requestHash ?? "",
        e.responseHash ?? "",
        String(e.totalTokens),
        e.integrityStatus,
        e.httpStatus !== null && e.httpStatus !== undefined ? String(e.httpStatus) : "",
        String(e.captureComplete),
      ];
      return fields.map(escapeCsvField).join(",");
    });

    const csv = [header, ...rows].join("\n") + "\n";

    // W3: Add X-Total-Count header for truncation awareness
    reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", "attachment; filename=audit-trail.csv")
      .header("X-Total-Count", String(entries.length))
      .status(200)
      .send(csv);
  });

  /**
   * GET /v1/audit/export.json
   *
   * Returns audit trail entries as a JSON evidence package.
   * Structure: { entries: [...], exportedAt: string, count: number }
   */
  app.get("/v1/audit/export.json", async (request, reply) => {
    const sourceIp = getSourceIp(request);
    const userAgent = (request.headers["user-agent"] ?? "") as string;
    const authHeader = request.headers["authorization"] as string | undefined;
    const apiKey = await authenticateRequest(authHeader);

    if (!apiKey) {
      await logAuditEntry({
        apiKeyId: "anonymous",
        queryType: "audit.export.json",
        sourceIp,
        userAgent,
        responseStatus: 401,
      });
      reply.status(401).send({ error: "Unauthorized: invalid or missing API key" });
      return;
    }

    // W4: Execute query BEFORE logging audit entry, so we log the actual response status
    const query = request.query as Record<string, string>;
    let entries;
    try {
      entries = await getAuditEntries({
        search: query.search,
        type: query.type,
        from: query.from,
        to: query.to,
        projectId: apiKey.projectId,
      });
    } catch (err) {
      // W4: Log with status 500 on query failure
      await logAuditEntry({
        apiKeyId: apiKey.id,
        queryType: "audit.export.json",
        sourceIp,
        userAgent,
        responseStatus: 500,
      });
      throw err;
    }

    await logAuditEntry({
      apiKeyId: apiKey.id,
      queryType: "audit.export.json",
      sourceIp,
      userAgent,
      responseStatus: 200,
    });

    // W3: Add truncated field when count reaches the 10000 limit
    const MAX_EXPORT_ROWS = 10000;
    const evidencePackage = {
      entries,
      exportedAt: new Date().toISOString(),
      count: entries.length,
      truncated: entries.length >= MAX_EXPORT_ROWS,
    };

    // W3: Add X-Total-Count header for truncation awareness
    reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("X-Total-Count", String(entries.length))
      .status(200)
      .send(evidencePackage);
  });
}
