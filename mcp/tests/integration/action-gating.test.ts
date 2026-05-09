/**
 * D-C10-8 (integration) — End-to-end action-tool gating via CLI flags.
 *
 * Spawns the recondo-mcp binary as a remote HTTP service with various flag
 * combinations and asserts the `tools/list` shape:
 *
 *   | flags                                  | tool count | rationale                                                |
 *   |----------------------------------------|------------|----------------------------------------------------------|
 *   | (none)                                 | 28         | read tools only (matches D-C9-3)                         |
 *   | --allow-actions                        | 33         | 28 read + 5 non-destructive action tools                 |
 *   | --allow-actions --allow-destructive    | 35         | 28 read + 5 non-destructive + 2 destructive action tools |
 *   | --allow-destructive  (alone)           | exit != 0  | parseFlags rejects (requires --allow-actions)            |
 *
 * The action-tool count is fixed at 7 (5 non-destructive + 2 destructive).
 * If the implementer adds a new action tool, this file MUST be updated in
 * sync with `ACTION_TOOLS` in `mcp/src/server.ts`.
 *
 * NB: this test does NOT need a database — `tools/list` only enumerates
 * the registered tools; it doesn't fire any data-layer call. Skips only
 * when the binary isn't built.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import {
  spawnMcp,
  RECONDO_MCP_BINARY,
  type SpawnedMcp,
} from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfReady = HAVE_BINARY ? describe : describe.skip;

interface ToolDefinition {
  name: string;
  description?: string;
}

const READ_TOOL_COUNT = 28;
const NON_DESTRUCTIVE_ACTION_COUNT = 5;
const DESTRUCTIVE_ACTION_COUNT = 2;

const NON_DESTRUCTIVE_ACTION_NAMES = [
  "recondo_generate_report",
  "recondo_update_control_status",
  "recondo_create_policy",
  "recondo_update_policy",
  "recondo_register_key",
];

const DESTRUCTIVE_ACTION_NAMES = [
  "recondo_delete_policy",
  "recondo_delete_key",
];

const ALL_ACTION_NAMES = [
  ...NON_DESTRUCTIVE_ACTION_NAMES,
  ...DESTRUCTIVE_ACTION_NAMES,
];

describeIfReady("D-C10-8 action-gating: default mode (no flags)", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it(`advertises exactly ${READ_TOOL_COUNT} tools (read-only catalog)`, async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    expect(result.tools.length).toBe(READ_TOOL_COUNT);
  });

  it("does NOT advertise any action tool", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const names = new Set(result.tools.map((t) => t.name));
    for (const action of ALL_ACTION_NAMES) {
      expect(
        names.has(action),
        `action tool ${action} leaked into default-mode catalog`,
      ).toBe(false);
    }
  });
});

describeIfReady("D-C10-8 action-gating: --allow-actions only", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions"] });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it(`advertises ${READ_TOOL_COUNT + NON_DESTRUCTIVE_ACTION_COUNT} tools (read + non-destructive action)`, async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    expect(result.tools.length).toBe(
      READ_TOOL_COUNT + NON_DESTRUCTIVE_ACTION_COUNT,
    );
  });

  it("advertises every non-destructive action tool", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const names = new Set(result.tools.map((t) => t.name));
    for (const action of NON_DESTRUCTIVE_ACTION_NAMES) {
      expect(names.has(action), `missing non-destructive action ${action}`).toBe(true);
    }
  });

  it("does NOT advertise destructive action tools without --allow-destructive", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const names = new Set(result.tools.map((t) => t.name));
    for (const action of DESTRUCTIVE_ACTION_NAMES) {
      expect(
        names.has(action),
        `destructive tool ${action} leaked without --allow-destructive`,
      ).toBe(false);
    }
  });
});

describeIfReady("D-C10-8 action-gating: --allow-actions --allow-destructive", () => {
  let mcp: SpawnedMcp;

  beforeAll(async () => {
    mcp = await spawnMcp({ devBypass: true, args: ["--allow-actions", "--allow-destructive"] });
  });

  afterAll(async () => {
    await mcp?.close();
  });

  it(`advertises ${READ_TOOL_COUNT + NON_DESTRUCTIVE_ACTION_COUNT + DESTRUCTIVE_ACTION_COUNT} tools (full catalog)`, async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    expect(result.tools.length).toBe(
      READ_TOOL_COUNT + NON_DESTRUCTIVE_ACTION_COUNT + DESTRUCTIVE_ACTION_COUNT,
    );
  });

  it("advertises every action tool (including destructive)", async () => {
    const result = await mcp.request<{ tools: ToolDefinition[] }>("tools/list");
    const names = new Set(result.tools.map((t) => t.name));
    for (const action of ALL_ACTION_NAMES) {
      expect(names.has(action), `missing action tool ${action}`).toBe(true);
    }
  });
});

describeIfReady("D-C10-8 action-gating: --allow-destructive WITHOUT --allow-actions", () => {
  it("process exits non-zero (parseFlags rejects)", async () => {
    // The binary should refuse to boot — parseFlags throws synchronously
    // and the wrapper logs+exits 1 before any RPC traffic. We don't use
    // spawnMcp here because it runs the initialize handshake; we just
    // spawn the process and observe the exit code.
    const baseEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") baseEnv[k] = v;
    }
    if (!baseEnv.DATABASE_URL) {
      baseEnv.DATABASE_URL =
        "postgres://placeholder:placeholder@127.0.0.1:0/placeholder";
    }
    if (!baseEnv.RECONDO_DEV_BYPASS) baseEnv.RECONDO_DEV_BYPASS = "1";
    baseEnv.NODE_ENV = "development";

    const child = spawn(
      process.execPath,
      [RECONDO_MCP_BINARY, "--allow-destructive"],
      { env: baseEnv, stdio: ["pipe", "pipe", "pipe"] },
    );

    let stderrBuf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        child.once("close", (code, signal) => resolveExit({ code, signal }));
        // Safety timeout: if the process somehow runs forever, kill it.
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 5000);
      },
    );

    expect(
      exit.code === null || exit.code === 0,
      `process exited with code=${exit.code} signal=${exit.signal}; stderr=${stderrBuf}`,
    ).toBe(false);
    // Stderr should mention --allow-actions (the parseFlags error message).
    expect(stderrBuf).toMatch(/--allow-actions/);
  });
});
