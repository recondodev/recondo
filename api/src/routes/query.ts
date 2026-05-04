/**
 * Query builder route -- D0.1 Fastify extraction.
 *
 * W1 fix: Shared helpers imported from middleware/rest-helpers.ts.
 * Local copies of getSourceIp, ApiKeyInfo type removed.
 */

import type { FastifyInstance } from "fastify";
import { handleRestEndpoint } from "../middleware/rest-helpers.js";
import { handleQuery } from "../query/builder.js";

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/query", async (request, reply) => {
    await handleRestEndpoint(request, reply, "query", handleQuery);
  });
}
