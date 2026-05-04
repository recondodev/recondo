/**
 * GET /v1/attachments/:id — REST route tests.
 *
 * FIND-11-F: assert `X-Content-Type-Options: nosniff` is present on
 * every successful response. The gateway's allow-list bars unsafe
 * MIME types at extraction (FIND-10-G/H), but legacy rows captured
 * by pre-Round-10 gateways may still hold unsafe `mime_type` values
 * in the database. Without nosniff a browser navigating to those
 * legacy rows would interpret the response per-MIME and execute
 * embedded `<script>` tags. nosniff forces the browser to honour
 * exactly what the server says, and `application/octet-stream`
 * (the fallback for unknown mimes) downloads instead of rendering.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import {
  setupDatabase,
  teardownDatabase,
  getPool,
  API_KEYS,
  IDS,
  API_BASE_URL,
} from "./setup.js";

// We need a writable object-store root that the in-process API
// server can read. The server is spawned in global-setup with
// RECONDO_DATA_DIR inherited from the test process env (if set);
// otherwise defaults to ~/.recondo. We don't try to override at
// per-test scope — we just write into the running server's
// configured root.
function objectStoreRoot(): string {
  if (process.env.RECONDO_OBJECT_ROOT) return process.env.RECONDO_OBJECT_ROOT;
  if (process.env.RECONDO_DATA_DIR) {
    return path.join(process.env.RECONDO_DATA_DIR, "objects");
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
  return path.join(home, ".recondo", "objects");
}

const ATTACHMENT_ID = "aa000011-f000-4000-8000-000000000001";
// 8-byte PNG signature is enough — the route doesn't validate body.
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_SHA = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

// Track files we've written so we can clean them up.
const written: string[] = [];

async function insertAttachmentRow(opts: {
  id: string;
  sessionId: string;
  turnId: string;
  mimeType: string;
  sha256: string;
  filename?: string | null;
}): Promise<void> {
  const p = getPool();
  await p.query(
    `INSERT INTO attachments (
      id, session_id, turn_id, sequence_num, role, kind, mime_type,
      size_bytes, sha256, object_ref, filename
    ) VALUES ($1, $2, $3, 0, 'user', 'image', $4, 8, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE
      SET mime_type = EXCLUDED.mime_type,
          sha256 = EXCLUDED.sha256,
          object_ref = EXCLUDED.object_ref`,
    [
      opts.id,
      opts.sessionId,
      opts.turnId,
      opts.mimeType,
      opts.sha256,
      `attachments/${opts.sha256}.json.gz`,
      opts.filename ?? null,
    ],
  );
}

function ensureObjectFile(sha: string, payload: Buffer): string {
  const root = objectStoreRoot();
  const dir = path.join(root, "attachments");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(payload));
  written.push(file);
  return file;
}

beforeAll(async () => {
  await setupDatabase();
});

afterAll(async () => {
  // Best-effort cleanup of object files; don't tear down DB rows
  // because TRUNCATE in the next setupDatabase() invocation will
  // clear them.
  for (const f of written) {
    try {
      fs.unlinkSync(f);
    } catch {
      // already gone
    }
  }
  await teardownDatabase();
});

describe("GET /v1/attachments/:id — security headers (FIND-11-F)", () => {
  beforeEach(async () => {
    ensureObjectFile(PNG_SHA, PNG_SIGNATURE);
    await insertAttachmentRow({
      id: ATTACHMENT_ID,
      sessionId: IDS.sessionAlpha1,
      turnId: IDS.turnA1_1,
      mimeType: "image/png",
      sha256: PNG_SHA,
      filename: "test.png",
    });
  });

  it("sets X-Content-Type-Options: nosniff on a successful response", async () => {
    const res = await fetch(`${API_BASE_URL}/v1/attachments/${ATTACHMENT_ID}`, {
      headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
    });
    expect(res.status).toBe(200);
    // Header name comparison is case-insensitive in fetch's Headers.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("preserves nosniff even when the row's mime_type is a legacy unsafe value", async () => {
    // Imagine a pre-Round-10 capture stored `image/svg+xml`. The
    // gateway today would have rejected it, but historical rows
    // exist. The route must still send nosniff so browsers do not
    // render the response as SVG/XML.
    await insertAttachmentRow({
      id: ATTACHMENT_ID,
      sessionId: IDS.sessionAlpha1,
      turnId: IDS.turnA1_1,
      mimeType: "image/svg+xml",
      sha256: PNG_SHA,
      filename: "legacy.svg",
    });
    const res = await fetch(`${API_BASE_URL}/v1/attachments/${ATTACHMENT_ID}`, {
      headers: { Authorization: `Bearer ${API_KEYS.alpha}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
