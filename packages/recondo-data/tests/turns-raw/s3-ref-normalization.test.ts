import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  closePool,
  getPool,
  getTurnRawChunk,
  getTurnRawMetadata,
} from "../../src/index.js";

const servers: Array<ReturnType<typeof createServer>> = [];
const ORIGINAL_ENV = { ...process.env };

async function withObjectServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ endpoint: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    handler(req, res);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not bind to a TCP port");
  }
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
  };
}

function configureS3Env(endpoint: string): void {
  process.env.RECONDO_OBJECTS = "s3";
  process.env.RECONDO_S3_BUCKET = "recondo-objects-dev";
  process.env.AWS_ENDPOINT_URL = endpoint;
  process.env.AWS_REGION = "us-east-1";
  process.env.AWS_ACCESS_KEY_ID = "test";
  process.env.AWS_SECRET_ACCESS_KEY = "test";
}

afterEach(async () => {
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

afterAll(async () => {
  await closePool();
});

describe("turn raw S3 object refs", () => {
  it("normalizes gateway refs with objects/ prefix before S3 raw metadata reads", async () => {
    const hash = "abcdef123456";
    const body = Buffer.from("{\"ok\":true}", "utf8");
    const compressed = gzipSync(body);
    const { endpoint, requests } = await withObjectServer((req, res) => {
      expect(req.url?.split("?")[0]).toBe(
        `/recondo-objects-dev/objects/req/${hash}.json.gz`,
      );
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(compressed.length),
      });
      res.end(compressed);
    });
    configureS3Env(endpoint);

    const pool = getPool();
    vi.spyOn(pool, "query").mockResolvedValueOnce({
      rows: [
        {
          request_hash: hash,
          req_bytes_size: body.length,
          req_bytes_ref: `objects/req/${hash}.json.gz`,
        },
      ],
    } as never);

    const metadata = await getTurnRawMetadata("turn-1");

    expect(metadata).toMatchObject({
      content_hash: hash,
      bytes_total: body.length,
      content_type: "application/json",
      head_sample_utf8: body.toString("utf8"),
    });
    expect(requests).toHaveLength(1);
  });

  it("normalizes gateway refs with objects/ prefix before S3 raw chunk reads", async () => {
    const hash = "fedcba654321";
    const body = Buffer.from("chunk me from s3", "utf8");
    const compressed = gzipSync(body);
    const { endpoint, requests } = await withObjectServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(compressed.length),
      });
      res.end(compressed);
    });
    configureS3Env(endpoint);

    const pool = getPool();
    vi.spyOn(pool, "query").mockResolvedValueOnce({
      rows: [
        {
          request_hash: hash,
          req_bytes_size: body.length,
          req_bytes_ref: `objects/req/${hash}.json.gz`,
        },
      ],
    } as never);

    const chunk = await getTurnRawChunk("turn-1", 6, 2);

    expect(chunk.bytes.toString("utf8")).toBe("me");
    expect(chunk.next_offset).toBe(8);
    expect(requests.map((url) => url.split("?")[0])).toEqual([
      `/recondo-objects-dev/objects/req/${hash}.json.gz`,
    ]);
  });
});
