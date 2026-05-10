/**
 * Query builder route -- D0.1 Fastify extraction.
 *
 * W1 fix: Shared helpers imported from middleware/rest-helpers.ts.
 * Local copies of getSourceIp, ApiKeyInfo type removed.
 *
 * C9 (plan task 16): per-request AbortController wired from
 * `request.raw` close event into `handleQuery`'s `signal` parameter,
 * which forwards it to `runStructuredQuery`. When the HTTP client
 * disconnects mid-flight the data layer is notified so its
 * AsyncIterable consumers can stop work cooperatively.
 */

import type { FastifyInstance } from "fastify";
import { handleRestEndpoint } from "../middleware/rest-helpers.js";
import { handleQuery } from "../query/builder.js";

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  app.post("/v1/query", async (request, reply) => {
    // C9 (plan task 16): per-request AbortController wired from the
    // raw response stream's `close` event into `handleQuery`'s `signal`
    // parameter, which forwards it to `runStructuredQuery`. When the
    // HTTP client disconnects mid-flight the data layer is notified so
    // its AsyncIterable consumers can stop work cooperatively.
    //
    // We listen on `reply.raw` (the ServerResponse) rather than
    // `request.raw` because IncomingMessage's `close` can fire as soon
    // as the request body is fully consumed (which Fastify does before
    // dispatching the handler). ServerResponse's `close` only fires on
    // socket close, which is what "client gave up" actually means.
    const ctrl = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) ctrl.abort();
    };
    reply.raw.on("close", onClose);
    try {
      await handleRestEndpoint(request, reply, "query", (body, apiKey) =>
        handleQuery(body, apiKey, ctrl.signal),
      );
    } finally {
      reply.raw.off("close", onClose);
    }
  });
}
