/**
 * Attachment streaming route -- Sprint P1B.
 *
 * GET /v1/attachments/:id
 *
 * Streams the binary bytes of an inline attachment (image, PDF, etc.) that
 * the gateway extracted from an LLM request. Metadata lives in GraphQL
 * (Turn.attachments -> Attachment); this route serves the binary payload.
 *
 * Consistent with the rest of the /v1/* routes in this API (audit exports,
 * usage dumps) — GraphQL is for structured queries; REST covers binary
 * streaming and bulk exports that don't fit GraphQL's request/response shape.
 *
 * Auth: Bearer-token or dev-bypass (NODE_ENV=development). Authorization is
 * scoped by the attachment's session -> project; a key without access to the
 * parent project gets 404 rather than 403 to avoid leaking existence.
 *
 * Storage lookup: the gateway writes attachment objects to
 *   <object-root>/attachments/<hash>.json.gz
 * (the ObjectStore::put convention for the "attachments" kind). This route
 * decompresses on-the-fly and streams the raw bytes with the real MIME.
 *
 * For attachments of kind "external_image_url" there are no bytes stored
 * locally — the API never fetched them. Those return 404 because the
 * browser should have hit the original URL directly (which is what the
 * Attachment.url GraphQL resolver returns for that kind).
 */

import type { FastifyInstance } from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  NoSuchKey,
  S3Client,
} from "@aws-sdk/client-s3";
import { authenticateRequest } from "../auth.js";
import { logAuditEntry } from "../audit.js";
import { getSourceIp } from "../middleware/rest-helpers.js";
import { getPool } from "../db.js";

// Lazy singleton S3 client. Initialized on first attachment fetch when
// `RECONDO_OBJECTS=s3`. The endpoint URL, region, and credentials come
// from the standard `AWS_*` environment variables — same chain the
// gateway uses (gateway/src/storage/mod.rs:160).
let s3Client: S3Client | null = null;
function getS3Client(): S3Client {
  if (s3Client !== null) return s3Client;
  const region = process.env.AWS_REGION ?? "us-east-1";
  const endpoint = process.env.AWS_ENDPOINT_URL;
  s3Client = new S3Client({
    region,
    // `forcePathStyle: true` is required for S3-compatible services
    // (MiniStack, LocalStack, MinIO) that don't support virtual-hosted
    // bucket addressing. Real AWS S3 also accepts path-style.
    forcePathStyle: true,
    ...(endpoint ? { endpoint } : {}),
  });
  return s3Client;
}

function isS3ObjectStore(): boolean {
  return process.env.RECONDO_OBJECTS === "s3";
}

/** Resolve the gateway's object-store root. In dev (local filesystem) this
 *  is `~/.recondo/objects` unless `RECONDO_DATA_DIR` overrides it. */
function objectStoreRoot(): string {
  if (process.env.RECONDO_OBJECT_ROOT) return process.env.RECONDO_OBJECT_ROOT;
  if (process.env.RECONDO_DATA_DIR) {
    return path.join(process.env.RECONDO_DATA_DIR, "objects");
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".recondo", "objects");
}

export async function attachmentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>(
    "/v1/attachments/:id",
    async (request, reply) => {
      const sourceIp = getSourceIp(request);
      const userAgent = (request.headers["user-agent"] ?? "") as string;
      const authHeader = request.headers["authorization"] as string | undefined;
      let apiKey = await authenticateRequest(authHeader);

      // Dev bypass: matches the pattern used in the other /v1/* routes.
      if (
        !apiKey &&
        process.env.NODE_ENV === "development" &&
        !process.env.RECONDO_DASHBOARD_API_KEY
      ) {
        apiKey = {
          id: "dev-bypass",
          projectId: null,
          rateLimitRpm: 1000,
        };
      }

      if (!apiKey) {
        await logAuditEntry({
          apiKeyId: "anonymous",
          queryType: "attachments.get",
          sourceIp,
          userAgent,
          responseStatus: 401,
        });
        reply
          .status(401)
          .send({ error: "Unauthorized: invalid or missing API key" });
        return;
      }

      const { id } = request.params;
      // Attachment ids are either pure UUIDs (HTTP capture path) or
      // `<turn_uuid>-att-<N>` (codex/WebSocket path — see Batch 12 in
      // gateway/src/gateway/run_listener.rs::write_codex_attachments).
      // Anything else is a probe. Reject cheaply without a DB round-trip
      // so malformed URLs don't add query load.
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-att-\d+)?$/i.test(
          id
        )
      ) {
        reply.status(404).send({ error: "Not found" });
        return;
      }

      // Look up the attachment + its session's project_id so we can enforce
      // scoping. A project-scoped API key only sees its own attachments;
      // admin keys (projectId=null) see everything.
      const pool = getPool();
      const result = await pool.query(
        `SELECT a.kind, a.mime_type, a.sha256, a.object_ref, a.filename,
                s.project_id
         FROM attachments a
         JOIN sessions s ON a.session_id = s.id
         WHERE a.id = $1`,
        [id]
      );
      if (result.rows.length === 0) {
        reply.status(404).send({ error: "Not found" });
        return;
      }
      const row = result.rows[0] as {
        kind: string;
        mime_type: string;
        sha256: string;
        object_ref: string;
        filename: string | null;
        project_id: string | null;
      };

      // Scoping: if the key is project-scoped, require a match. Admin keys
      // (projectId null) see everything. Returning 404 (not 403) avoids
      // leaking the existence of attachments to out-of-scope callers.
      if (apiKey.projectId && row.project_id !== apiKey.projectId) {
        await logAuditEntry({
          apiKeyId: apiKey.id,
          queryType: "attachments.get",
          sourceIp,
          userAgent,
          responseStatus: 404,
        });
        reply.status(404).send({ error: "Not found" });
        return;
      }

      // External-URL attachments have no local bytes; the Attachment.url
      // GraphQL resolver returns the original URL so the browser fetches
      // directly. Anything that reaches this route for such an attachment
      // is a misconfiguration — report it as 404.
      if (row.kind === "external_image_url") {
        reply.status(404).send({ error: "Not available via proxy" });
        return;
      }

      // Resolve the object-store path. The gateway uses ObjectStore.put
      // with kind="attachments", hash=sha256 -> <root>/attachments/<hash>.json.gz.
      // (The .json.gz suffix is a misnomer for binary objects but it's
      // the single convention the gateway uses for all kinds.)
      const sha = row.sha256;
      if (!/^[0-9a-f]{64}$/.test(sha)) {
        // Defense in depth — if somehow the DB holds a non-hex hash, don't
        // construct a path with it.
        reply.status(404).send({ error: "Not found" });
        return;
      }

      // S3-vs-local resolution. When `RECONDO_OBJECTS=s3`, fetch via
      // GetObject from the configured bucket. The S3 key matches the
      // gateway's S3ObjectStore::s3_key format
      // (gateway/src/storage/object.rs:175): `objects/<kind>/<hash>.json.gz`.
      // For the local backend the file path is `<root>/<kind>/<hash>.json.gz`
      // (no `objects/` prefix because `<root>` already terminates in
      // `objects`).
      let objectStream: NodeJS.ReadableStream;
      if (isS3ObjectStore()) {
        const bucket = process.env.RECONDO_S3_BUCKET;
        if (!bucket) {
          request.log.error(
            "RECONDO_OBJECTS=s3 but RECONDO_S3_BUCKET is unset; cannot serve attachment"
          );
          reply.status(500).send({ error: "Object store misconfigured" });
          return;
        }
        const s3Key = `objects/attachments/${sha}.json.gz`;
        try {
          const obj = await getS3Client().send(
            new GetObjectCommand({ Bucket: bucket, Key: s3Key })
          );
          if (!obj.Body) {
            reply.status(404).send({ error: "Not found" });
            return;
          }
          // The AWS SDK v3 S3 Body is a SdkStream that's already a
          // Node Readable in Node.js runtimes. Cast accordingly.
          objectStream = obj.Body as Readable;
        } catch (err) {
          if (err instanceof NoSuchKey) {
            reply.status(404).send({ error: "Not found" });
            return;
          }
          request.log.error({ err, s3Key, bucket }, "S3 GetObject failed");
          reply.status(502).send({ error: "Object store unavailable" });
          return;
        }
      } else {
        const root = objectStoreRoot();
        const objectPath = path.join(root, "attachments", `${sha}.json.gz`);
        if (!fs.existsSync(objectPath)) {
          reply.status(404).send({ error: "Not found" });
          return;
        }
        objectStream = fs.createReadStream(objectPath);
      }

      // Stream via a gunzip transform. Avoids buffering the full attachment
      // in memory — critical for the 20 MiB cap.
      const headers: Record<string, string> = {
        "content-type": row.mime_type || "application/octet-stream",
        // Conservative cache control: attachments are content-addressed so
        // immutable by nature, but they're behind auth so don't let
        // intermediate caches hold them.
        "cache-control": "private, max-age=3600",
        // FIND-11-F: hard-disable browser MIME sniffing on attachment
        // responses. The gateway's allow-list (FIND-10-G/H) blocks
        // svg/html/javascript at extraction time, but legacy rows
        // captured by pre-Round-10 gateways may still have unsafe
        // mime_type values in the DB (e.g. `image/svg+xml`). Without
        // `X-Content-Type-Options: nosniff` a browser navigating to
        // such an attachment would render it as HTML/SVG and execute
        // any embedded `<script>`. With nosniff set the browser
        // refuses to interpret the response as anything other than
        // the explicit content-type — and our content-type for
        // unknown-mime rows falls back to application/octet-stream,
        // which the browser will only download.
        "x-content-type-options": "nosniff",
      };
      if (row.filename) {
        // Sanitize: filenames come from clients and could contain CRLFs.
        const safeFilename = row.filename.replace(/[\r\n"]/g, "_");
        headers["content-disposition"] = `inline; filename="${safeFilename}"`;
      }
      reply.headers(headers);

      await logAuditEntry({
        apiKeyId: apiKey.id,
        queryType: "attachments.get",
        sourceIp,
        userAgent,
        responseStatus: 200,
      });

      const stream = objectStream.pipe(zlib.createGunzip());
      return reply.send(stream);
    }
  );
}
