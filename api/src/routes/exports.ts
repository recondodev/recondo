/**
 * Export routes -- D0.1 Fastify extraction.
 *
 * All /v1/exports/* and /v1/attestation/* endpoints.
 *
 * W1 fix: Shared helpers imported from middleware/rest-helpers.ts.
 * Local copies of getSourceIp, handleRestEndpoint, and ApiKeyInfo type removed.
 */

import type { FastifyInstance } from "fastify";
import { authenticateRequest } from "@recondo/data";
import { logAuditEntry } from "../audit.js";
import { checkRateLimit } from "../ratelimit.js";
import { getSourceIp, handleRestEndpoint } from "../middleware/rest-helpers.js";
import { handleAttestationGenerate } from "../attestation.js";
import { handleSoc2Export } from "../exports/soc2.js";
import { handleSr117Export } from "../exports/sr11-7.js";
import { handleIso42001Export } from "../exports/iso42001.js";
import { handleMifidIIExport } from "../exports/mifid-ii.js";
import { handleMifidIIDetailed } from "../exports/mifid-ii-detailed.js";
import { handleChangeTraceability } from "../exports/change-traceability.js";
import { handleSoc2Package } from "../exports/soc2-package.js";
import { handleIso42001Evidence } from "../exports/iso42001-evidence.js";
import { handleSupplyChainExport } from "../exports/supply-chain.js";
import { handleCustomExport } from "../exports/custom.js";
import {
  handleCreateSchedule,
  handleListSchedules,
  handleDeleteSchedule,
  handleEvaluateSchedules,
} from "../exports/schedules.js";

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  // POST /v1/attestation/generate
  app.post("/v1/attestation/generate", async (request, reply) => {
    await handleRestEndpoint(request, reply, "attestation.generate", handleAttestationGenerate);
  });

  // POST /v1/exports/soc2
  app.post("/v1/exports/soc2", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.soc2", handleSoc2Export);
  });

  // POST /v1/exports/sr11-7
  app.post("/v1/exports/sr11-7", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.sr11-7", handleSr117Export);
  });

  // POST /v1/exports/iso42001
  app.post("/v1/exports/iso42001", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.iso42001", handleIso42001Export);
  });

  // POST /v1/exports/mifid-ii
  app.post("/v1/exports/mifid-ii", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.mifid-ii", handleMifidIIExport);
  });

  // POST /v1/exports/mifid-ii/detailed
  app.post("/v1/exports/mifid-ii/detailed", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.mifid-ii.detailed", handleMifidIIDetailed);
  });

  // POST /v1/exports/change-traceability
  app.post("/v1/exports/change-traceability", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.change-traceability", handleChangeTraceability);
  });

  // POST /v1/exports/soc2/package -- binary ZIP response
  // This endpoint has custom response handling (binary buffer), so it uses
  // inline auth/rate-limit/audit rather than handleRestEndpoint.
  app.post("/v1/exports/soc2/package", async (request, reply) => {
    const sourceIp = getSourceIp(request);
    const userAgent = (request.headers["user-agent"] ?? "") as string;
    const authHeader = request.headers["authorization"] as string | undefined;
    const apiKey = await authenticateRequest(authHeader);

    if (!apiKey) {
      await logAuditEntry({ apiKeyId: "anonymous", queryType: "exports.soc2.package", sourceIp, userAgent, responseStatus: 401 });
      reply.status(401).send({ error: "Unauthorized: invalid or missing API key" });
      return;
    }

    const rateLimitResult = checkRateLimit(apiKey.id, apiKey.rateLimitRpm);
    const rlHeaders: Record<string, string> = {
      "X-RateLimit-Limit": String(rateLimitResult.limit),
      "X-RateLimit-Remaining": String(rateLimitResult.remaining),
      "X-RateLimit-Reset": String(rateLimitResult.resetEpochSeconds),
    };

    if (!rateLimitResult.allowed) {
      await logAuditEntry({ apiKeyId: apiKey.id, queryType: "exports.soc2.package", sourceIp, userAgent, responseStatus: 429 });
      reply.headers(rlHeaders).status(429).send({ error: "Rate limit exceeded" });
      return;
    }

    const parsedBody = (request.body ?? {}) as Record<string, unknown>;

    if (!parsedBody.projectId) {
      await logAuditEntry({ apiKeyId: apiKey.id, queryType: "exports.soc2.package", sourceIp, userAgent, responseStatus: 400 });
      reply.headers(rlHeaders).status(400).send({ error: "Missing required field: projectId" });
      return;
    }

    if (apiKey.projectId && apiKey.projectId !== parsedBody.projectId) {
      await logAuditEntry({ apiKeyId: apiKey.id, queryType: "exports.soc2.package", sourceIp, userAgent, responseStatus: 403 });
      reply.headers(rlHeaders).status(403).send({ error: "Forbidden" });
      return;
    }

    try {
      const result = await handleSoc2Package(parsedBody, apiKey);

      await logAuditEntry({ apiKeyId: apiKey.id, queryType: "exports.soc2.package", sourceIp, userAgent, responseStatus: result.status });

      if (result.buffer) {
        reply
          .headers(rlHeaders)
          .header("Content-Type", result.contentType ?? "application/zip")
          .header("Content-Disposition", "attachment; filename=soc2-evidence.zip; filename*=UTF-8''soc2-evidence.zip")
          .status(result.status)
          .send(result.buffer);
      } else {
        reply.headers(rlHeaders).status(result.status).send(result.body ?? { error: "Unknown error" });
      }
    } catch (err) {
      console.error("REST endpoint error: exports.soc2.package", err);
      await logAuditEntry({ apiKeyId: apiKey.id, queryType: "exports.soc2.package", sourceIp, userAgent, responseStatus: 500 }).catch(() => {});
      reply.headers(rlHeaders).status(500).send({ error: "Internal server error" });
    }
  });

  // POST /v1/exports/iso42001/evidence
  app.post("/v1/exports/iso42001/evidence", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.iso42001.evidence", handleIso42001Evidence);
  });

  // POST /v1/exports/supply-chain
  app.post("/v1/exports/supply-chain", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.supply-chain", handleSupplyChainExport);
  });

  // POST /v1/exports/custom
  app.post("/v1/exports/custom", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.custom", handleCustomExport);
  });

  // POST /v1/exports/schedule
  app.post("/v1/exports/schedule", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.schedule.create", handleCreateSchedule);
  });

  // GET /v1/exports/schedules
  app.get("/v1/exports/schedules", async (request, reply) => {
    const query = request.query as Record<string, string>;
    const schedProjectId = query.projectId ?? undefined;
    await handleRestEndpoint(request, reply, "exports.schedules.list", async (_body, apiKey) => {
      return handleListSchedules(apiKey, schedProjectId);
    });
  });

  // POST /v1/exports/schedules/evaluate
  app.post("/v1/exports/schedules/evaluate", async (request, reply) => {
    await handleRestEndpoint(request, reply, "exports.schedules.evaluate", handleEvaluateSchedules);
  });

  // DELETE /v1/exports/schedules/:id
  app.delete("/v1/exports/schedules/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await handleRestEndpoint(request, reply, "exports.schedules.delete", async (_body, apiKey) => {
      return handleDeleteSchedule(id, apiKey);
    });
  });
}
