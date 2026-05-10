/**
 * REST session and turn routes -- D0.1 + D0.2 + D0.6.
 *
 * GET /v1/sessions -- list sessions (auth + rate limit + audit + Zod validation)
 * GET /v1/sessions/:id -- session detail with turns (auth + rate limit + audit + Zod validation)
 * GET /v1/turns/:id -- turn detail (auth + rate limit + audit + Zod validation)
 *
 * B1 fix: All queries are project-scoped via apiKey.projectId.
 * B2 fix: All handlers wrapped in try/catch (via handleRestEndpoint).
 * W2 fix: Rate limiting and audit logging applied via handleRestEndpoint.
 * D0.6: Zod validation on all REST input parameters.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod/v4";
import { getPool, sanitizeRowTextFields, SESSION_TEXT_FIELDS, TURN_TEXT_FIELDS } from "@recondo/data";
import { handleRestEndpoint } from "../middleware/rest-helpers.js";

// D0.6: Zod schemas for input validation

// W5 fix: z.coerce.number() accepts hex strings like "0xff" which coerce to 255.
// Use a strict decimal-only parser: validate the raw string matches /^\d+$/,
// then transform to number. This rejects hex strings, floats, and non-numeric input.

/**
 * Parses a query param string as a strict decimal integer.
 * Rejects hex ("0xff"), floats ("3.14"), negative ("-1"), and non-numeric ("abc").
 */
function parseStrictInt(val: unknown): number | undefined {
  if (val === undefined || val === null || val === "") return undefined;
  const s = String(val);
  if (!/^\d+$/.test(s)) return NaN;
  return Number(s);
}

/** Validates limit query parameter: positive integer 1..1000, defaults to 50 */
const limitSchema = z.preprocess(
  parseStrictInt,
  z.number({ message: "Must be a positive integer" }).int().positive().max(1000).optional()
).transform(v => v ?? 50);

/** Validates offset query parameter: non-negative integer, defaults to 0 */
const offsetSchema = z.preprocess(
  parseStrictInt,
  z.number({ message: "Must be a non-negative integer" }).int().nonnegative().optional()
).transform(v => v ?? 0);

/** Validates session/turn list query parameters */
const listQuerySchema = z.object({
  limit: limitSchema,
  offset: offsetSchema,
});

/** Validates ID path parameters: hex characters and hyphens only */
const idSchema = z.string().regex(/^[a-f0-9-]+$/i, "Invalid ID format");

// W8: Optional filter params for GET /v1/sessions
const providerFilterSchema = z.string().max(100).optional();
const frameworkFilterSchema = z.string().max(100).optional();
const statusFilterSchema = z.enum(["active", "complete"]).optional();

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/sessions -- list
  // W8: Supports ?provider=, ?framework=, ?status= query params
  app.get("/v1/sessions", async (request, reply) => {
    await handleRestEndpoint(request, reply, "sessions.list", async (_body, apiKey) => {
      const query = request.query as Record<string, string>;

      // D0.6: Validate query parameters with Zod
      const parseResult = listQuerySchema.safeParse({
        limit: query.limit,
        offset: query.offset,
      });

      if (!parseResult.success) {
        const errorMessages = parseResult.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ");
        return { status: 400, body: { error: `Validation failed: ${errorMessages}` } };
      }

      // W8: Validate optional filter params
      const providerResult = providerFilterSchema.safeParse(query.provider);
      const frameworkResult = frameworkFilterSchema.safeParse(query.framework);
      const statusResult = statusFilterSchema.safeParse(query.status);

      if (!providerResult.success || !frameworkResult.success || !statusResult.success) {
        return { status: 400, body: { error: "Invalid filter parameter" } };
      }

      const { limit, offset } = parseResult.data;

      const pool = getPool();

      // B1: Project scoping -- non-admin keys can only see their own project's sessions
      const conditions: string[] = [];
      const params: unknown[] = [];
      let idx = 1;

      if (apiKey.projectId) {
        conditions.push(`project_id = $${idx++}`);
        params.push(apiKey.projectId);
      }

      // W8: Apply filter conditions
      if (providerResult.data) {
        conditions.push(`provider = $${idx++}`);
        params.push(providerResult.data);
      }
      if (frameworkResult.data) {
        conditions.push(`framework = $${idx++}`);
        params.push(frameworkResult.data);
      }
      if (statusResult.data) {
        // "active" = ended_at IS NULL, "complete" = ended_at IS NOT NULL
        if (statusResult.data === "active") {
          conditions.push(`ended_at IS NULL`);
        } else {
          conditions.push(`ended_at IS NOT NULL`);
        }
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      params.push(limit);
      const limitIdx = idx++;
      params.push(offset);
      const offsetIdx = idx++;

      const result = await pool.query(
        `SELECT id, provider, model, started_at, last_active_at,
                initial_intent, system_prompt_hash, total_turns,
                turns_captured, total_tokens, total_cost_usd, framework
         FROM sessions ${where}
         ORDER BY started_at DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params
      );

      // FIND-1-M re-open: sanitize every emitted session row's text
      // fields so `initial_intent` never leaks a `[Image: source:
      // /Users/.../N.png]` placeholder path to the REST client.
      const sanitized = result.rows.map((row) =>
        sanitizeRowTextFields(row as Record<string, unknown>, SESSION_TEXT_FIELDS),
      );
      return { status: 200, body: sanitized as unknown as Record<string, unknown> };
    });
  });

  // GET /v1/sessions/:id -- detail with nested turns
  app.get("/v1/sessions/:id", async (request, reply) => {
    await handleRestEndpoint(request, reply, "sessions.detail", async (_body, apiKey) => {
      const { id } = request.params as { id: string };

      // D0.6: Validate ID format with Zod
      const idParseResult = idSchema.safeParse(id);
      if (!idParseResult.success) {
        return { status: 400, body: { error: "Invalid ID format" } };
      }

      const pool = getPool();

      // B1: Project scoping
      const conditions = [`id = $1`];
      const params: unknown[] = [id];

      if (apiKey.projectId) {
        conditions.push(`project_id = $2`);
        params.push(apiKey.projectId);
      }

      const sessionResult = await pool.query(
        `SELECT * FROM sessions WHERE ${conditions.join(" AND ")}`,
        params
      );

      if (sessionResult.rows.length === 0) {
        return { status: 404, body: { error: "Session not found" } };
      }

      const turnsResult = await pool.query(
        `SELECT * FROM turns WHERE session_id = $1 ORDER BY sequence_num`,
        [id]
      );

      // FIND-1-M re-open: sanitize both the session row (initial_intent)
      // and every turn row (user_request_text, response_text,
      // thinking_text) before serialising the response. `SELECT *`
      // emits every column verbatim; without this pass, placeholder
      // paths would leak to the REST client.
      const session = sanitizeRowTextFields(
        sessionResult.rows[0] as Record<string, unknown>,
        SESSION_TEXT_FIELDS,
      );
      session.turns = turnsResult.rows.map((r) =>
        sanitizeRowTextFields(r as Record<string, unknown>, TURN_TEXT_FIELDS),
      );
      return { status: 200, body: session };
    });
  });

  // GET /v1/turns/:id -- turn detail
  app.get("/v1/turns/:id", async (request, reply) => {
    await handleRestEndpoint(request, reply, "turns.detail", async (_body, apiKey) => {
      const { id } = request.params as { id: string };

      // D0.6: Validate ID format with Zod
      const idParseResult = idSchema.safeParse(id);
      if (!idParseResult.success) {
        return { status: 400, body: { error: "Invalid ID format" } };
      }

      const pool = getPool();

      // B1: Project scoping via JOIN with sessions
      const conditions = [`t.id = $1`];
      const params: unknown[] = [id];

      if (apiKey.projectId) {
        conditions.push(`s.project_id = $2`);
        params.push(apiKey.projectId);
      }

      const result = await pool.query(
        `SELECT t.* FROM turns t
         JOIN sessions s ON t.session_id = s.id
         WHERE ${conditions.join(" AND ")}`,
        params
      );

      if (result.rows.length === 0) {
        return { status: 404, body: { error: "Turn not found" } };
      }

      // FIND-1-M re-open: sanitize turn text fields so
      // `user_request_text`, `response_text`, and `thinking_text`
      // never expose an `[Image: source: /Users/.../N.png]` path.
      const turn = sanitizeRowTextFields(
        result.rows[0] as Record<string, unknown>,
        TURN_TEXT_FIELDS,
      );
      return { status: 200, body: turn };
    });
  });
}
