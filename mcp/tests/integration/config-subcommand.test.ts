/**
 * D-C12-1, D-C12-2, D-C12-3 (integration) — `recondo-mcp config <flavor>`.
 *
 * Spawn the built `dist/bin/recondo-mcp.js` with `config <flavor>` args.
 * The binary prints the registration JSON to stdout and exits 0 (or
 * exits non-zero with an error to stderr for unsupported flavors / bad
 * flags).
 *
 * Per the C0 audit (Decision 3, Option A), `--scoped` is DROPPED in v1
 * — `parseFlags` rejects unknown flags, so `--scoped <project_id>`
 * causes a non-zero exit with an "Unknown flag" message on stderr.
 *
 * Skips when the binary isn't built. NOT gated on DATABASE_URL — the
 * config subcommand MUST be DB-free (it's a configuration emitter,
 * not a server).
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { RECONDO_MCP_BINARY } from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfBinary = HAVE_BINARY ? describe : describe.skip;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function runConfig(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v;
  }
  Object.assign(baseEnv, env);

  return new Promise<RunResult>((resolveP, rejectP) => {
    const child = spawn(process.execPath, [RECONDO_MCP_BINARY, ...args], {
      env: baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectP);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectP(new Error("config subcommand timeout (>10s)"));
    }, 10_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
  });
}

describeIfBinary("D-C12-1 recondo-mcp config claude-code (integration)", () => {
  it("emits valid JSON to stdout and exits zero", async () => {
    const result = await runConfig(["config", "claude-code"], {
      DATABASE_URL: "postgres://app:secret@db.example/recondo",
      RECONDO_OBJECT_STORE_PATH: "/var/recondo/objects",
    });
    expect(
      result.code,
      `non-zero exit; stderr: ${result.stderr}`,
    ).toBe(0);

    // stdout must parse as a single JSON document. Some CLIs trail a
    // newline — strip whitespace before parsing.
    const trimmed = result.stdout.trim();
    expect(trimmed.length).toBeGreaterThan(0);
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(trimmed);
    }, `stdout did not parse as JSON: ${trimmed.slice(0, 400)}`).not.toThrow();

    // Top-level shape exactly matches Claude Code's MCP config schema.
    const obj = parsed as Record<string, unknown>;
    expect(obj).toHaveProperty("mcpServers");
    const recondo = (obj.mcpServers as Record<string, unknown>)
      .recondo as Record<string, unknown>;
    expect(recondo.command).toBe("recondo-mcp");
    const env = recondo.env as Record<string, string>;
    expect(env.DATABASE_URL).toBe("postgres://app:secret@db.example/recondo");
    expect(env.RECONDO_OBJECT_STORE_PATH).toBe("/var/recondo/objects");
    expect(env).not.toHaveProperty("RECONDO_API_KEY");
  });
});

describeIfBinary("D-C12-3 recondo-mcp config cursor (integration)", () => {
  it("emits the cursor mcpServers shape", async () => {
    const result = await runConfig(["config", "cursor"], {
      DATABASE_URL: "postgres://x",
      RECONDO_OBJECT_STORE_PATH: "/y",
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed).toHaveProperty("mcpServers");
    const recondo = (parsed.mcpServers as Record<string, unknown>)
      .recondo as Record<string, unknown>;
    expect(recondo.command).toBe("recondo-mcp");
    expect(recondo).toHaveProperty("env");
  });
});

describeIfBinary("D-C12-3 recondo-mcp config goose (integration)", () => {
  it("emits the goose extensions/stdio shape", async () => {
    const result = await runConfig(["config", "goose"], {
      DATABASE_URL: "postgres://x",
      RECONDO_OBJECT_STORE_PATH: "/y",
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("mcpServers");
    expect(parsed).toHaveProperty("extensions");
    const recondo = (parsed.extensions as Record<string, unknown>)
      .recondo as Record<string, unknown>;
    expect(recondo.type).toBe("stdio");
    expect(recondo.cmd).toBe("recondo-mcp");
    expect(recondo).toHaveProperty("env");
  });
});

describeIfBinary("D-C12-2 [DROPPED] — `--scoped` is rejected", () => {
  it("`config claude-code --scoped abc` exits non-zero with unknown-flag error", async () => {
    const result = await runConfig(["config", "claude-code", "--scoped", "abc"]);
    // parseFlags throws — main.ts catches and exits 1.
    expect(result.code).not.toBe(0);
    // stderr must mention the rejected flag (parseFlags throws
    // `Unknown flag: --scoped`). We check substrings rather than the
    // whole line because logger output may JSON-wrap.
    expect(result.stderr.includes("--scoped")).toBe(true);
    // stdout must NOT contain a registration JSON document.
    expect(result.stdout.trim()).toBe("");
  });
});

describeIfBinary("D-C12 unknown flavor — graceful failure", () => {
  it("`config bogus` exits non-zero (does not silently emit)", async () => {
    const result = await runConfig(["config", "bogus-flavor"]);
    expect(result.code).not.toBe(0);
    // No partial JSON on stdout — config dispatcher must validate the
    // flavor BEFORE writing anything.
    expect(result.stdout.trim()).toBe("");
  });
});
