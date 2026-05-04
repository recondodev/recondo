/**
 * Recondo API server — Fastify-based entry point (D0.1).
 *
 * Registers all route plugins, configures CORS, and starts the server.
 * Target: under 100 lines.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { closePool } from "./db.js";
import { startViewRefreshScheduler, stopViewRefreshScheduler } from "./usage/scheduler.js";
import { healthRoutes } from "./routes/health.js";
import { graphqlRoutes } from "./routes/graphql.js";
import { sessionRoutes } from "./routes/sessions.js";
import { exportRoutes } from "./routes/exports.js";
import { usageRoutes } from "./routes/usage.js";
import { monitoringRoutes } from "./routes/monitoring.js";
import { anomalyRoutes } from "./routes/anomaly.js";
import { riskRoutes } from "./routes/risk.js";
import { queryRoutes } from "./routes/query.js";
import { auditRoutes } from "./routes/audit.js";
import { reportRoutes } from "./routes/reports.js";
import { attachmentRoutes } from "./routes/attachments.js";

const PORT = parseInt(process.env.PORT ?? "4000", 10);

async function main() {
  // NOTE: bodyLimit is 1 MiB. Requests exceeding this are rejected with 413 by
  // Fastify's built-in content-length check. This rejection happens before any
  // route handler runs, so it is NOT captured in the audit log. Acceptable
  // trade-off: adding a custom body parser hook for audit logging would add
  // significant complexity for a low-value edge case.
  const app = Fastify({ bodyLimit: 1_048_576, logger: false });

  // Custom 404 handler: return a consistent JSON error without leaking route structure.
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: "Not found" });
  });

  // Custom error handler: prevent Fastify from leaking internal error details.
  app.setErrorHandler((error, request, reply) => {
    console.error("Unhandled error:", error);
    reply.status(500).send({ error: "Internal server error" });
  });

  // CORS: Allow localhost origins for dashboard development.
  // N1 fix: Also allow "http://localhost" (no port, default 80) in addition to
  // "http://localhost:*" (with explicit port). Both are valid localhost origins.
  // NOTE: In production, replace this with explicit allowed origins from config
  // (e.g., RECONDO_CORS_ORIGINS env var) to avoid open CORS on non-localhost deploys.
  await app.register(cors, {
    origin: (origin, cb) => {
      if (
        !origin ||
        origin === "http://localhost" ||
        origin.startsWith("http://localhost:")
      ) {
        cb(null, origin || false);
      } else {
        cb(null, false);
      }
    },
    methods: ["GET", "POST", "OPTIONS", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  });

  // Register all route plugins
  await app.register(healthRoutes);
  await app.register(graphqlRoutes);
  await app.register(sessionRoutes);
  await app.register(exportRoutes);
  await app.register(usageRoutes);
  await app.register(monitoringRoutes);
  await app.register(anomalyRoutes);
  await app.register(riskRoutes);
  await app.register(queryRoutes);
  await app.register(auditRoutes);
  await app.register(reportRoutes);
  await app.register(attachmentRoutes);

  // FIND-8-B (a) + FIND-8-E: gate the MV refresh scheduler on
  // NODE_ENV. The scheduler registers setInterval timers (15min,
  // 1h, 6h, 24h) that fire `REFRESH MATERIALIZED VIEW
  // CONCURRENTLY`. During long test runs (40-90s with the in-process
  // server holding the recondo_test pool), a 15min timer could
  // theoretically fire mid-run; even if it doesn't, leaving the
  // scheduler enabled is a latent race against the tests' TRUNCATE
  // and reseed. Skipping it under NODE_ENV=test removes the entire
  // class of MVCC-snapshot races. Production is unaffected.
  if (process.env.NODE_ENV !== "test") {
    try { startViewRefreshScheduler(); } catch (e) { console.warn("Scheduler warning:", e); }
  }

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.info(JSON.stringify({
    level: "info", component: "server",
    message: `Recondo API server listening on port ${PORT}`,
    port: PORT, timestamp: new Date().toISOString(),
  }));

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.info(JSON.stringify({ level: "info", component: "server", message: `Received ${signal}, shutting down...`, signal, timestamp: new Date().toISOString() }));
    stopViewRefreshScheduler();
    await app.close();
    await closePool();
    console.info(JSON.stringify({ level: "info", component: "server", message: "Shutdown complete.", timestamp: new Date().toISOString() }));
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => console.error("Unhandled rejection:", reason));
}

main().catch((err) => { console.error("Failed to start server:", err); process.exit(1); });
