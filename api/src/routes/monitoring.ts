/**
 * Monitoring routes -- D0.1 Fastify extraction.
 *
 * W1 fix: Shared helpers imported from middleware/rest-helpers.ts.
 * Local copies of getSourceIp, handleRestEndpoint, and ApiKeyInfo type removed.
 */

import type { FastifyInstance } from "fastify";
import { handleRestEndpoint } from "../middleware/rest-helpers.js";
import {
  handleCompleteness,
  handleAvailability,
  handleAlertConfigure,
  handleAlertEvaluate,
} from "../monitoring.js";
import { handleMonitoringDashboard } from "../dashboards/monitoring.js";
import { handleManagementReview } from "../dashboards/management-review.js";

export async function monitoringRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/monitoring/completeness", async (req, rep) => {
    await handleRestEndpoint(req, rep, "monitoring.completeness", async (_b, k) => handleCompleteness(k));
  });
  app.get("/v1/monitoring/availability", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "monitoring.availability", async (_b, k) => handleAvailability(k, q.projectId));
  });
  app.post("/v1/monitoring/alerts/configure", async (req, rep) => {
    await handleRestEndpoint(req, rep, "monitoring.alerts.configure", handleAlertConfigure);
  });
  app.get("/v1/monitoring/alerts/evaluate", async (req, rep) => {
    await handleRestEndpoint(req, rep, "monitoring.alerts.evaluate", async (_b, k) => handleAlertEvaluate(k));
  });
  app.get("/v1/dashboards/monitoring", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "dashboards.monitoring", async (_b, k) =>
      handleMonitoringDashboard(k, { projectId: q.projectId, agent: q.agent, model: q.model }));
  });
  app.get("/v1/dashboards/management-review", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "dashboards.management-review", async (_b, k) =>
      handleManagementReview(k, { projectId: q.projectId }));
  });
}
