/**
 * Risk classification routes -- D0.1 Fastify extraction.
 *
 * W1 fix: Shared helpers imported from middleware/rest-helpers.ts.
 * Local copies of getSourceIp and ApiKeyInfo type removed.
 */

import type { FastifyInstance } from "fastify";
import { handleRestEndpoint } from "../middleware/rest-helpers.js";
import { handleClassifyRisk, handleRiskProfile } from "../risk/classification.js";
import { handleImpactAssessment } from "../reports/impact-assessment.js";

export async function riskRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/risk/classify", async (req, rep) => {
    await handleRestEndpoint(req, rep, "risk.classify", handleClassifyRisk);
  });
  app.get("/v1/risk/profile", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "risk.profile", async (_b, k) =>
      handleRiskProfile(k, { projectId: q.projectId }));
  });
  app.post("/v1/reports/impact-assessment", async (req, rep) => {
    await handleRestEndpoint(req, rep, "reports.impact-assessment", handleImpactAssessment);
  });
}
