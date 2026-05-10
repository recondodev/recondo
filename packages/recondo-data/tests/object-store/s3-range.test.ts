/**
 * S3ObjectStore.readRange -- MiniStack/AWS-compatible object reads.
 *
 * The gateway stores gzipped content-addressed objects at:
 *   objects/<kind>/<hash>.json.gz
 *
 * The TypeScript data layer must use the same key format so MCP can run
 * against fullstack's S3-backed object store.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { once } from "node:events";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it } from "vitest";

import { S3ObjectStore } from "../../src/index.js";

const servers: Array<ReturnType<typeof createServer>> = [];

async function withObjectServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{
  endpoint: string;
  requests: string[];
  authorizations: Array<string | undefined>;
}> {
  const requests: string[] = [];
  const authorizations: Array<string | undefined> = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? "");
    authorizations.push(req.headers.authorization);
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
    authorizations,
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("S3ObjectStore.readRange", () => {
  it("fetches the gateway S3 key, gunzips the object, and returns the requested slice", async () => {
    const hash = "abcdef123456";
    const body = Buffer.from("hello world from s3", "utf8");
    const compressed = gzipSync(body);
    const { endpoint, requests, authorizations } = await withObjectServer((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url?.split("?")[0]).toBe(
        `/recondo-objects-dev/objects/req/${hash}.json.gz`,
      );
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-length": String(compressed.length),
      });
      res.end(compressed);
    });

    const client = new S3Client({
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: "test",
        secretAccessKey: "test",
      },
    });
    const store = new S3ObjectStore({
      bucket: "recondo-objects-dev",
      client,
    });
    const slice = await store.readRange("req", hash, 6, 5);

    expect(slice.toString("utf8")).toBe("world");
    expect(requests).toHaveLength(1);
    expect(authorizations[0]).toContain("Credential=test/");
  });

  it("rejects invalid kind/hash components before making an HTTP request", async () => {
    const { endpoint, requests } = await withObjectServer((_req, res) => {
      res.writeHead(500).end("should not be reached");
    });
    const store = new S3ObjectStore({
      bucket: "recondo-objects-dev",
      endpoint,
      region: "us-east-1",
    });

    await expect(store.readRange("../req", "abc", 0, 10)).rejects.toThrow(/kind/);
    await expect(store.readRange("req", "abc/def", 0, 10)).rejects.toThrow(/hash/);
    expect(requests).toHaveLength(0);
  });
});
