/**
 * Shared REST endpoint helpers — extracted from duplicated code across route files.
 *
 * Single canonical implementations of getSourceIp and handleRestEndpoint.
 * All route files import from here instead of maintaining local copies.
 *
 * The ApiKeyInfo type is imported from context.ts where it is already defined.
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { authenticateRequest } from "@recondo/data";
import { logAuditEntry } from "../audit.js";
import { checkRateLimit } from "../ratelimit.js";
import type { ApiKeyInfo } from "../context.js";

/**
 * Validates whether a string looks like a valid IPv4 or IPv6 address.
 * Used to sanitize X-Forwarded-For values before trusting them.
 */
function isValidIp(ip: string): boolean {
  // IPv4: 1.2.3.4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return true;
  // IPv6 (full or collapsed): ::1, fe80::1, etc.
  if (/^[0-9a-fA-F:]+$/.test(ip)) return true;
  // IPv4-mapped IPv6: ::ffff:1.2.3.4
  if (/^::ffff:\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return true;
  return false;
}

/**
 * Extract the source IP from a Fastify request.
 *
 * Checks X-Forwarded-For first (leftmost entry), validates it looks like
 * a real IP, and falls back to request.ip.
 *
 * W1 fix: This is the single canonical implementation. The ::ffff: check
 * was missing in some route files' copies — now consistently present.
 */
export function getSourceIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (forwarded) {
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(",")[0];
    const trimmed = ip.trim();
    if (isValidIp(trimmed)) return trimmed;
  }
  return request.ip ?? "127.0.0.1";
}

/**
 * Standard REST endpoint wrapper that handles:
 *   1. Authentication (401 if invalid)
 *   2. Rate limiting (429 if exceeded, with X-RateLimit-* headers)
 *   3. Audit logging (all outcomes: 401, 429, and success)
 *   4. Error handling (try/catch with 500 on unexpected failures)
 *
 * Route handlers only need to implement the business logic.
 */
export async function handleRestEndpoint(
  request: FastifyRequest,
  reply: FastifyReply,
  queryType: string,
  handler: (
    body: Record<string, unknown>,
    apiKey: ApiKeyInfo
  ) => Promise<{ status: number; body: Record<string, unknown> }>
): Promise<void> {
  const sourceIp = getSourceIp(request);
  const userAgent = (request.headers["user-agent"] ?? "") as string;

  const authHeader = request.headers["authorization"] as string | undefined;
  const apiKey = await authenticateRequest(authHeader);

  if (!apiKey) {
    await logAuditEntry({ apiKeyId: "anonymous", queryType, sourceIp, userAgent, responseStatus: 401 });
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
    await logAuditEntry({ apiKeyId: apiKey.id, queryType, sourceIp, userAgent, responseStatus: 429 });
    reply.headers(rlHeaders).status(429).send({ error: "Rate limit exceeded" });
    return;
  }

  const parsedBody = (request.body ?? {}) as Record<string, unknown>;

  try {
    const result = await handler(parsedBody, apiKey);
    await logAuditEntry({ apiKeyId: apiKey.id, queryType, sourceIp, userAgent, responseStatus: result.status });
    reply.headers(rlHeaders).status(result.status).send(result.body);
  } catch (err) {
    console.error("REST endpoint error:", queryType, err);
    await logAuditEntry({ apiKeyId: apiKey.id, queryType, sourceIp, userAgent, responseStatus: 500 }).catch(() => {});
    reply.headers(rlHeaders).status(500).send({ error: "Internal server error" });
  }
}

