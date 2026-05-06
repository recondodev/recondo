/**
 * Report download route -- Sprint D6.1.
 *
 * GET /v1/reports/:id/download -- download a generated report
 *
 * Authentication required (Bearer token).
 * Returns 200 with report JSON, 404 if not found, 401 if unauthenticated.
 *
 * B3: Project-scoped -- adds AND project_id = $2 when apiKey.projectId is set.
 */

import type { FastifyInstance } from "fastify";
import { authenticateRequest, getPool } from "@recondo/data";

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/reports/:id/download", async (request, reply) => {
    const authHeader = request.headers["authorization"] as string | undefined;
    const apiKey = await authenticateRequest(authHeader);

    if (!apiKey) {
      reply.status(401).send({ error: "Unauthorized: invalid or missing API key" });
      return;
    }

    const { id } = request.params as { id: string };

    const pool = getPool();

    // B3: Project-scoped query when apiKey.projectId is set
    const conditions: string[] = ["id = $1"];
    const params: unknown[] = [id];

    if (apiKey.projectId) {
      conditions.push("project_id = $2");
      params.push(apiKey.projectId);
    }

    const result = await pool.query(
      `SELECT id, name, framework, period_start, period_end, capture_count,
              findings_critical, findings_high, findings_medium, findings_low,
              hash, status, generated_at
       FROM reports
       WHERE ${conditions.join(" AND ")}`,
      params
    );

    if (result.rows.length === 0) {
      reply.status(404).send({ error: "Report not found" });
      return;
    }

    const row = result.rows[0];

    const reportData = {
      id: row.id,
      name: row.name,
      framework: row.framework,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      captureCount: row.capture_count,
      findings: {
        critical: row.findings_critical,
        high: row.findings_high,
        medium: row.findings_medium,
        low: row.findings_low,
      },
      hash: row.hash,
      status: row.status,
      generatedAt: row.generated_at,
    };

    reply
      .status(200)
      .header("Content-Type", "application/json")
      .header("Content-Disposition", `attachment; filename="report-${id}.json"`)
      .send(reportData);
  });
}
