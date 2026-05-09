/**
 * S3-compatible ObjectStore reader.
 *
 * The Rust gateway writes content-addressed gzip objects to:
 *   objects/<kind>/<hash>.json.gz
 *
 * This reader mirrors that key format so API/MCP consumers can read
 * the same objects from AWS S3 or local S3-compatible services such as
 * MiniStack.
 */

import { gunzipSync } from "node:zlib";
import {
  GetObjectCommand,
  NoSuchKey,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";

const PATH_COMPONENT_RE = /^[A-Za-z0-9_-]+$/;

function validatePathComponent(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (!PATH_COMPONENT_RE.test(value)) {
    throw new Error(
      `${label} contains invalid characters (must be alphanumeric, hyphens, or underscores): ${JSON.stringify(value)}`,
    );
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("aborted", "AbortError");
  }
}

interface ByteArrayBody {
  transformToByteArray?: () => Promise<Uint8Array>;
}

async function bodyToBuffer(body: ByteArrayBody): Promise<Buffer> {
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  throw new Error("S3 GetObject body does not support transformToByteArray");
}

export interface S3ObjectStoreOpts {
  bucket: string;
  client?: S3Client;
  endpoint?: string;
  region?: string;
}

export class S3ObjectStore {
  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(opts: S3ObjectStoreOpts) {
    if (typeof opts?.bucket !== "string" || opts.bucket.length === 0) {
      throw new Error("S3ObjectStore: `bucket` is required");
    }
    this.bucket = opts.bucket;
    this.client = opts.client ?? new S3Client(S3ObjectStore.clientConfig(opts));
  }

  private static clientConfig(opts: S3ObjectStoreOpts): S3ClientConfig {
    const endpoint = opts.endpoint ?? process.env.AWS_ENDPOINT_URL;
    return {
      region: opts.region ?? process.env.AWS_REGION ?? "us-east-1",
      forcePathStyle: true,
      ...(endpoint ? { endpoint } : {}),
    };
  }

  private objectKey(kind: string, hash: string): string {
    validatePathComponent(kind, "kind");
    validatePathComponent(hash, "hash");
    return `objects/${kind}/${hash}.json.gz`;
  }

  async readRange(
    kind: string,
    hash: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    throwIfAborted(signal);

    const key = this.objectKey(kind, hash);
    let compressed: Buffer;
    try {
      const obj = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      throwIfAborted(signal);
      if (!obj.Body) {
        throw new Error(`S3 object body was empty for ${key}`);
      }
      compressed = await bodyToBuffer(obj.Body);
      throwIfAborted(signal);
    } catch (err) {
      if (err instanceof NoSuchKey) {
        throw new Error(`S3 object not found: ${key}`);
      }
      throw err;
    }

    const plaintext = gunzipSync(compressed);
    if (offset >= plaintext.length) {
      return Buffer.alloc(0);
    }
    const end = Math.min(plaintext.length, offset + length);
    return Buffer.from(plaintext.subarray(offset, end));
  }
}
