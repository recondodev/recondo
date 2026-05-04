/**
 * Anomaly detection routes -- D0.1 Fastify extraction.
 *
 * W1 fix: Shared helpers imported from middleware/rest-helpers.ts.
 * Local copies of getSourceIp and ApiKeyInfo type removed.
 */

import type { FastifyInstance } from "fastify";
import { handleRestEndpoint } from "../middleware/rest-helpers.js";
import {
  handleComputeBaselines,
  handleGetBaselines,
} from "../anomaly-detection/baselines.js";
import {
  handleEvaluateAnomalies,
  handleGetAnomalies,
} from "../anomaly-detection/evaluate.js";
import { handleResolveAnomaly } from "../anomaly-detection/resolution.js";

export async function anomalyRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/anomaly-detection/baselines/compute", async (req, rep) => {
    await handleRestEndpoint(req, rep, "anomaly-detection.baselines.compute", handleComputeBaselines);
  });
  app.get("/v1/anomaly-detection/baselines", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "anomaly-detection.baselines", async (_b, k) =>
      handleGetBaselines(k, q.projectId));
  });
  app.post("/v1/anomaly-detection/evaluate", async (req, rep) => {
    await handleRestEndpoint(req, rep, "anomaly-detection.evaluate", handleEvaluateAnomalies);
  });
  app.get("/v1/anomaly-detection/anomalies", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "anomaly-detection.anomalies", async (_b, k) =>
      handleGetAnomalies(k, { projectId: q.projectId, type: q.type, severity: q.severity }));
  });
  app.patch("/v1/anomalies/:id/resolve", async (req, rep) => {
    const { id } = req.params as { id: string };
    await handleRestEndpoint(req, rep, "anomaly-detection.resolve", async (body, apiKey) =>
      handleResolveAnomaly(id, body, apiKey));
  });
}
