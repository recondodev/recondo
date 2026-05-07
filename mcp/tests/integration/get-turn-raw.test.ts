/**
 * D-C3-3 + D-C3-4 (integration) — End-to-end raw-byte access tools.
 *
 * Two layers of assertion:
 *
 *   1. Schema discovery — both tools are registered, with descriptions
 *      >= 50 chars and the documented required fields.
 *
 *   2. Defensive Zod cap — `recondo_get_turn_raw_chunk` rejects
 *      `length > 32_768` at the SDK schema layer (the SDK rejects
 *      input-validation errors before the handler even runs).
 *
 *   3. Happy-path round-trip — given a real fixture file written under
 *      `RECONDO_OBJECT_STORE_PATH` and a turn pointing at its hash,
 *      `recondo_get_turn_raw_metadata` surfaces the data layer's
 *      `head_sample_utf8` field name (NOT `head_sample_bytes`), and
 *      `recondo_get_turn_raw_chunk` returns the structured raw envelope.
 *
 * Preconditions: dev-infra + migrations + fresh build. Object store
 * fixture is written under `RECONDO_OBJECT_STORE_PATH` (defaults to
 * `/tmp/recondo-objects` per `spawnMcp.ts`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { spawnMcp, RECONDO_MCP_BINARY, type SpawnedMcp } from "../helpers/spawnMcp.js";
import { seedTestDb, truncateCapturedTables } from "../helpers/seed.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_DB && HAVE_BINARY ? describe : describe.skip;

interface CallToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function extractEnvelope(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }
  if (result.content && result.content.length > 0) {
    const first = result.content[0];
    if (first?.type === "text" && typeof first.text === "string") {
      return JSON.parse(first.text) as Record<string, unknown>;
    }
  }
  throw new Error(
    `tool result missing payload: ${JSON.stringify(result).slice(0, 400)}`,
  );
}

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    required?: string[];
    properties?: Record<string, { type?: string; maximum?: number }>;
  };
}

describeIfReady("D-C3-3 / D-C3-4 raw-byte tools — schema discovery", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it("recondo_get_turn_raw_metadata is registered with the canonical schema", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find(
      (t) => t.name === "recondo_get_turn_raw_metadata",
    );
    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
    const required = (tool!.inputSchema?.required ?? []) as string[];
    expect(required).toContain("turn_id");
    expect(required).toContain("side");
  });

  it("recondo_get_turn_raw_chunk is registered with length capped at 32_768", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const tool = result.tools.find((t) => t.name === "recondo_get_turn_raw_chunk");
    expect(tool).toBeDefined();
    expect(tool!.description!.length).toBeGreaterThanOrEqual(50);
    const required = (tool!.inputSchema?.required ?? []) as string[];
    expect(required).toContain("turn_id");
    expect(required).toContain("side");
    expect(required).toContain("offset");
    expect(required).toContain("length");

    // Defensive Zod cap: the JSON-Schema MUST surface
    // `length.maximum === 32768` so the SDK rejects oversize calls
    // before the handler is invoked.
    const props = tool!.inputSchema?.properties ?? {};
    expect(props.length).toBeDefined();
    expect(props.length?.maximum).toBe(32768);
  });

  it("rejects length > 32_768 at the schema layer", async () => {
    const bad = await mcp
      .request<CallToolResult>("tools/call", {
        name: "recondo_get_turn_raw_chunk",
        arguments: {
          turn_id: "00000000-0000-0000-0000-000000000000",
          side: "request",
          offset: 0,
          length: 32769,
        },
      })
      .catch((err: unknown) => err);

    if (bad instanceof Error) {
      expect(String(bad.message)).toMatch(/(?:Invalid|validation|length|32768|maximum)/i);
    } else {
      const r = bad as CallToolResult;
      expect(r.isError).toBe(true);
    }
  });
});

describeIfReady("D-C3-3 / D-C3-4 raw-byte tools — happy-path round-trip", () => {
  let mcp: SpawnedMcp;
  let seeded: Awaited<ReturnType<typeof seedTestDb>> | null = null;

  beforeAll(async () => {
    mcp = await spawnMcp({});
  });

  afterAll(async () => {
    await mcp?.close();
    if (seeded) await seeded.cleanup();
    try {
      await truncateCapturedTables();
    } catch {
      // pool may already be closed
    }
  });

  it("metadata surfaces head_sample_utf8 (NOT head_sample_bytes) and chunk returns structured envelope", async () => {
    // Build a fixture body: small JSON payload so content_type sniffs
    // to "application/json" via the leading `{` byte.
    const bodyText = '{"hello":"world"}';
    const bodyBuf = Buffer.from(bodyText, "utf8");
    const hash = createHash("sha256").update(bodyBuf).digest("hex");

    // Object store layout: `<storeRoot>/<kind>/<hash>.json.gz` (gateway
    // produces the same path; the local driver reads from there).
    const storeRoot =
      process.env.RECONDO_OBJECT_STORE_PATH ?? "/tmp/recondo-objects";
    const fixturePath = join(storeRoot, "req", `${hash}.json.gz`);
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, gzipSync(bodyBuf));

    const sessionId = randomUUID();
    const turnId = randomUUID();
    seeded = await seedTestDb({
      sessions: [{ id: sessionId, framework: "claude-code" }],
      turns: [
        {
          id: turnId,
          sessionId,
          requestHash: hash,
          reqBytesRef: `req/${hash}.json.gz`,
          reqBytesSize: bodyBuf.length,
        },
      ],
    });

    // Metadata round-trip.
    const metaResult = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_get_turn_raw_metadata",
      arguments: { turn_id: turnId, side: "request" },
    });
    expect(metaResult.isError).not.toBe(true);
    const meta = extractEnvelope(metaResult);
    const metaJson = JSON.stringify(meta);
    // Plan D drift check — `head_sample_bytes` MUST NOT appear.
    expect(metaJson).not.toContain("head_sample_bytes");
    expect(meta).toHaveProperty("head_sample_utf8");
    expect(meta.head_sample_utf8).toBe(bodyText);
    expect(meta.bytes_total).toBe(bodyBuf.length);
    expect(meta.content_type).toBe("application/json");
    expect(meta.content_hash).toBe(hash);

    // Chunk round-trip.
    const chunkResult = await mcp.request<CallToolResult>("tools/call", {
      name: "recondo_get_turn_raw_chunk",
      arguments: {
        turn_id: turnId,
        side: "request",
        offset: 0,
        length: 100,
      },
    });
    expect(chunkResult.isError).not.toBe(true);
    const chunk = extractEnvelope(chunkResult);

    // Structured RawByteEnvelope: { role, from_turn_id, offset, length, content }.
    expect(chunk.role).toBe("raw");
    expect(chunk.from_turn_id).toBe(turnId);
    expect(typeof chunk.offset).toBe("number");
    expect(typeof chunk.length).toBe("number");
    expect(typeof chunk.content).toBe("string");
    const content = chunk.content as string;
    expect(content).toContain("<captured_raw_bytes");
    expect(content).toContain("</captured_raw_bytes>");
    // Base64 of the body is embedded in the wrapper.
    expect(content).toContain(bodyBuf.toString("base64"));
  });
});
