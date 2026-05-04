/**
 * Health check route — D0.1 Fastify extraction.
 */

import type { FastifyInstance } from "fastify";
import { checkDatabaseHealth } from "../db.js";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    const dbHealthy = await checkDatabaseHealth();
    const status = dbHealthy ? "healthy" : "unhealthy";
    const httpStatus = dbHealthy ? 200 : 503;
    const dbStatus = dbHealthy ? "connected" : "disconnected";

    reply.status(httpStatus).send({
      status,
      components: {
        database: dbStatus,
      },
    });
  });
}
