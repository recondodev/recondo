/**
 * GraphQL route — D0.1 Fastify extraction.
 *
 * Integrates Apollo Server with Fastify via @as-integrations/fastify.
 * Handles auth, rate limiting, audit logging, and depth limiting.
 */

import type { FastifyInstance } from "fastify";
import { ApolloServer } from "@apollo/server";
import { fastifyApolloDrainPlugin } from "@as-integrations/fastify";
import { GraphQLError, type ValidationContext, type ASTVisitor } from "graphql";
import { typeDefs } from "../schema.js";
import { resolvers } from "../resolvers.js";
import { authenticateRequest, getPool } from "@recondo/data";
import { logAuditEntry } from "../audit.js";
import { checkRateLimit, resetRateLimits } from "../ratelimit.js";
import type { GqlContext } from "../context.js";
import { getSourceIp } from "../middleware/rest-helpers.js";
import { createLoaders } from "../loaders.js";

// R2-W4: Query depth limiter -- rejects queries deeper than MAX_DEPTH levels
const MAX_DEPTH = 4;

function depthLimitRule(context: ValidationContext): ASTVisitor {
  function checkSelectionDepth(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node: any,
    depth: number
  ): void {
    if (node.selectionSet) {
      if (depth > MAX_DEPTH) {
        context.reportError(
          new GraphQLError(
            `Query depth ${depth} exceeds maximum allowed depth of ${MAX_DEPTH}.`
          )
        );
        return;
      }
      for (const sel of node.selectionSet.selections) {
        checkSelectionDepth(sel, depth + 1);
      }
    }
  }

  return {
    OperationDefinition(node) {
      checkSelectionDepth(node, 0);
    },
  };
}

// R2-W6: Pre-compiled regex patterns (module-level constants, not per-request)
const KNOWN_OPS = [
  "verifyIntegrity",
  "sessions",
  "session",
  "anomalies",
  "search",
  "turn",
] as const;

const OP_REGEXES: ReadonlyMap<string, RegExp> = new Map(
  KNOWN_OPS.map((op) => [op, new RegExp(`\\b${op}\\b\\s*[({]`)])
);

function extractQueryType(parsed: { query?: string }): string {
  try {
    const query = parsed.query;
    if (!query) return "unknown";
    for (const [op, re] of OP_REGEXES) {
      if (re.test(query)) return op;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

function extractResourceIds(parsed: { variables?: Record<string, unknown> }, queryType: string): string[] {
  try {
    const vars = parsed.variables ?? {};
    const ids: string[] = [];
    if (queryType === "session" && vars.id) ids.push(String(vars.id));
    if (queryType === "turn" && vars.id) ids.push(String(vars.id));
    if (queryType === "verifyIntegrity" && vars.sessionId) ids.push(String(vars.sessionId));
    if (queryType === "verifyIntegrity" && vars.sid) ids.push(String(vars.sid));
    if (queryType === "search" && vars.projectId) ids.push(String(vars.projectId));
    if (queryType === "search" && vars.pid) ids.push(String(vars.pid));
    return ids;
  } catch {
    return [];
  }
}

// W6 fix: safeErrorCodes hoisted to module scope (was recreated per error in formatError)
const safeErrorCodes = new Set([
  "GRAPHQL_VALIDATION_FAILED",
  "GRAPHQL_PARSE_FAILED",
  "BAD_USER_INPUT",
]);

/**
 * Creates and starts the Apollo Server, then registers the GraphQL route.
 */
export async function graphqlRoutes(app: FastifyInstance): Promise<void> {
  const apollo = new ApolloServer<GqlContext>({
    typeDefs,
    resolvers,
    plugins: [fastifyApolloDrainPlugin(app)],
    validationRules: [depthLimitRule],
    formatError: (formattedError, _error) => {
      const code = formattedError.extensions?.code as string | undefined;
      // W6 fix: safeErrorCodes is now a module-scope constant (not recreated per error)
      if (code && safeErrorCodes.has(code)) return formattedError;
      console.error("GraphQL resolver error:", JSON.stringify(formattedError));
      return {
        message: "Internal server error",
        extensions: { code: code ?? "INTERNAL_SERVER_ERROR" },
      };
    },
  });

  await apollo.start();

  // Register the Apollo handler for POST /graphql only
  // We use a manual route rather than the default Apollo integration
  // so we can handle auth, rate limiting, and audit logging inline.
  app.post("/graphql", async (request, reply) => {
    const sourceIp = getSourceIp(request);
    const userAgent = (request.headers["user-agent"] ?? "") as string;

    const parsed = (request.body ?? {}) as { query?: string; variables?: Record<string, unknown> };

    // Authenticate
    const authHeader = request.headers["authorization"] as string | undefined;
    let apiKey = await authenticateRequest(authHeader);

    // Dev bypass: skip auth in development when no API key is configured
    if (!apiKey && process.env.NODE_ENV === "development" && !process.env.RECONDO_DASHBOARD_API_KEY) {
      apiKey = {
        id: "dev-bypass",
        projectId: null,
        rateLimitRpm: 1000,
      };
    }

    if (!apiKey) {
      const queryType = extractQueryType(parsed);
      await logAuditEntry({
        apiKeyId: "anonymous",
        queryType,
        sourceIp,
        userAgent,
        responseStatus: 401,
      });
      reply.status(401).send({ error: "Unauthorized: invalid or missing API key" });
      return;
    }

    // Rate limiting
    const rateLimitResult = checkRateLimit(apiKey.id, apiKey.rateLimitRpm);
    const rlHeaders: Record<string, string> = {
      "X-RateLimit-Limit": String(rateLimitResult.limit),
      "X-RateLimit-Remaining": String(rateLimitResult.remaining),
      "X-RateLimit-Reset": String(rateLimitResult.resetEpochSeconds),
    };

    if (!rateLimitResult.allowed) {
      const queryType = extractQueryType(parsed);
      await logAuditEntry({
        apiKeyId: apiKey.id,
        queryType,
        sourceIp,
        userAgent,
        responseStatus: 429,
      });
      reply.headers(rlHeaders).status(429).send({ error: "Rate limit exceeded. Too many requests." });
      return;
    }

    // N2: We use apollo.executeOperation() (Apollo's test/programmatic API) intentionally
    // instead of the standard fastifyApollo handler. This allows us to perform auth,
    // rate limiting, and audit logging inline within the route handler, giving us full
    // control over the request lifecycle. The standard Apollo Fastify integration does
    // not expose hooks for these cross-cutting concerns at the right points.
    const loaders = createLoaders(getPool());
    const context: GqlContext = { apiKey, sourceIp, userAgent, loaders };

    const apolloResponse = await apollo.executeOperation(
      {
        query: parsed.query ?? "",
        variables: parsed.variables ?? {},
      },
      { contextValue: context }
    );

    // W6 fix: Build the response object directly instead of serializing to JSON
    // and then parsing it back. The previous code did:
    //   responseBody = JSON.stringify({...})
    //   parsedResponse = JSON.parse(responseBody)
    //   responseBody = JSON.stringify(parsedResponse)
    // which is a wasteful double serialization round-trip.
    let responseObj: Record<string, unknown>;
    let httpStatus: number;

    if (apolloResponse.body.kind === "single") {
      const singleResult = apolloResponse.body.singleResult;
      responseObj = { data: singleResult.data };
      // Only include errors if present (avoid { errors: undefined } in output)
      if (singleResult.errors && singleResult.errors.length > 0) {
        responseObj.errors = singleResult.errors;
      }
      httpStatus = 200;
    } else {
      responseObj = { errors: [{ message: "Unexpected incremental response" }] };
      httpStatus = 500;
    }

    // Audit logging
    const queryType = extractQueryType(parsed);
    const resourceIds = extractResourceIds(parsed, queryType);

    await logAuditEntry({
      apiKeyId: apiKey.id,
      queryType,
      resourceIds: resourceIds.length > 0 ? resourceIds : undefined,
      sourceIp,
      userAgent,
      responseStatus: httpStatus,
    });

    // W6 fix: Send the object directly -- Fastify serializes it to JSON.
    // No need for manual JSON.stringify/JSON.parse round-trips.
    reply
      .headers(rlHeaders)
      .header("Content-Type", "application/json")
      .status(httpStatus)
      .send(responseObj);
  });

  // Test-only endpoint to reset rate limits
  if (process.env.NODE_ENV === "test" || process.env.NODE_ENV === "development") {
    app.post("/_test/reset-rate-limits", async (_request, reply) => {
      resetRateLimits();
      reply.send({ ok: true });
    });
  }
}
