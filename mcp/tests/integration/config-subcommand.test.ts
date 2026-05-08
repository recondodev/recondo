/**
 * D-C12-1, D-C12-2, D-C12-3 (integration) — `recondo-mcp config <flavor>`.
 *
 * Spawn the built `dist/bin/recondo-mcp.js` with `config <flavor>` args.
 * The binary prints the registration JSON to stdout and exits 0 (or
 * exits non-zero with an error to stderr for unsupported flavors / bad
 * flags).
 *
 * Hardening restores `--scoped <project_id>` as a first-class config
 * option: the binary mints a scoped key and injects it into the emitted
 * env as `RECONDO_API_KEY`.
 *
 * Skips when the binary isn't built. NOT gated on DATABASE_URL — the
 * Normal config subcommands remain DB-free. The scoped variant is gated
 * on DATABASE_URL because it intentionally mints a DB-backed key.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

import { RECONDO_MCP_BINARY } from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const HAVE_DB = Boolean(process.env.DATABASE_URL);
const describeIfBinary = HAVE_BINARY ? describe : describe.skip;
const describeIfBinaryAndDb = HAVE_BINARY && HAVE_DB ? describe : describe.skip;

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

  it("can emit CLI args and propagated dev env", async () => {
    const result = await runConfig(
      ["config", "claude-code", "--emit-args", "--allow-actions"],
      {
        DATABASE_URL: "postgres://app:secret@db.example/recondo",
        RECONDO_OBJECT_STORE_PATH: "/var/recondo/objects",
        RECONDO_DEV_BYPASS: "1",
        RECONDO_DATA_DIR: "/var/recondo/data",
        RECONDO_OBJECTS: "/var/recondo/raw-objects",
        NODE_ENV: "development",
      },
    );
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      mcpServers: { recondo: { args: string[]; env: Record<string, string> } };
    };
    expect(parsed.mcpServers.recondo.args).toEqual(["--allow-actions"]);
    expect(parsed.mcpServers.recondo.env).toMatchObject({
      RECONDO_DEV_BYPASS: "1",
      RECONDO_DATA_DIR: "/var/recondo/data",
      RECONDO_OBJECTS: "/var/recondo/raw-objects",
      NODE_ENV: "development",
    });
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
    expect(recondo).toHaveProperty("args");
    expect(recondo).toMatchObject({ enabled: true, name: "recondo" });
  });
});

describeIfBinaryAndDb("D-HARD scoped config — `--scoped` mints a key", () => {
  it("`config claude-code --scoped my-project` emits a scoped API key exactly once", async () => {
    const result = await runConfig(["config", "claude-code", "--scoped", "my-project"]);
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      mcpServers: { recondo: { env: Record<string, string> } };
    };
    const rawSecret = parsed.mcpServers.recondo.env.RECONDO_API_KEY;
    expect(rawSecret).toMatch(/^wrt_/);
    expect(result.stdout.match(/RECONDO_API_KEY/g)?.length).toBe(1);

    const { getPool } = await import("@recondo/data");
    const keyHash = createHash("sha256").update(rawSecret).digest("hex");
    const pool = getPool();
    const row = await pool.query(
      `SELECT id, project_id, scope FROM api_keys WHERE key_hash = $1`,
      [keyHash],
    );
    expect(row.rows[0]).toMatchObject({
      project_id: "my-project",
      scope: "scoped",
    });
    await pool.query(`DELETE FROM api_keys WHERE key_hash = $1`, [keyHash]);
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
