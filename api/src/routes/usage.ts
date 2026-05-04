/**
 * Usage/analytics routes -- D0.1 Fastify extraction.
 *
 * W1 fix: Shared helpers imported from middleware/rest-helpers.ts.
 * Local copies of getSourceIp, handleRestEndpoint, and ApiKeyInfo type removed.
 */

import type { FastifyInstance } from "fastify";
import { handleRestEndpoint } from "../middleware/rest-helpers.js";
import {
  handleTokenSpend,
  handleModelDistribution,
  handleActiveAgents,
  handleCostTrend,
} from "../usage/dashboard.js";
import { handleCostAllocation } from "../usage/cost-allocation.js";
import {
  handleSpendAnomalies,
  handleSpendAnomaliesEvaluate,
} from "../usage/spend-detection.js";
import {
  handleCostByTeam,
  handleDeveloperProductivity,
  handleModelAnalysis,
  handleToolAnalytics,
} from "../usage/intelligence.js";

export async function usageRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/usage/token-spend", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.token-spend", async (_b, k) => handleTokenSpend(k, q.period));
  });
  app.get("/v1/usage/model-distribution", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.model-distribution", async (_b, k) => handleModelDistribution(k, q.period));
  });
  app.get("/v1/usage/active-agents", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.active-agents", async (_b, k) => handleActiveAgents(k, q.period));
  });
  app.get("/v1/usage/cost-trend", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.cost-trend", async (_b, k) => handleCostTrend(k, q.period));
  });
  app.get("/v1/usage/cost-allocation", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.cost-allocation", async (_b, k) =>
      handleCostAllocation(k, q.period, q.from, q.to));
  });
  app.get("/v1/usage/spend-anomalies", async (req, rep) => {
    await handleRestEndpoint(req, rep, "usage.spend-anomalies", async (_b, k) => handleSpendAnomalies(k));
  });
  app.post("/v1/usage/spend-anomalies/evaluate", async (req, rep) => {
    await handleRestEndpoint(req, rep, "usage.spend-anomalies.evaluate", handleSpendAnomaliesEvaluate);
  });
  app.get("/v1/usage/cost-by-team", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.cost-by-team", async (_b, k) =>
      handleCostByTeam(k, { projectId: q.projectId, period: q.period }));
  });
  app.get("/v1/usage/developer-productivity", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.developer-productivity", async (_b, k) =>
      handleDeveloperProductivity(k, { projectId: q.projectId }));
  });
  app.get("/v1/usage/model-analysis", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.model-analysis", async (_b, k) =>
      handleModelAnalysis(k, { projectId: q.projectId }));
  });
  app.get("/v1/usage/tool-analytics", async (req, rep) => {
    const q = req.query as Record<string, string>;
    await handleRestEndpoint(req, rep, "usage.tool-analytics", async (_b, k) =>
      handleToolAnalytics(k, { projectId: q.projectId }));
  });
}
