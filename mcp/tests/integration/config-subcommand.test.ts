/**
 * `recondo-mcp config <flavor>` integration coverage.
 *
 * The binary prints remote Streamable HTTP registration JSON to stdout
 * and exits. It does not emit child-process registration config.
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

describeIfBinary("recondo-mcp config claude-code", () => {
  it("emits valid remote JSON to stdout and exits zero", async () => {
    const result = await runConfig(["config", "claude-code"], {
      RECONDO_MCP_URL: "http://localhost:4001/mcp",
    });
    expect(result.code, `non-zero exit; stderr: ${result.stderr}`).toBe(0);

    const trimmed = result.stdout.trim();
    expect(trimmed.length).toBeGreaterThan(0);
    let parsed: unknown;
    expect(() => {
      parsed = JSON.parse(trimmed);
    }, `stdout did not parse as JSON: ${trimmed.slice(0, 400)}`).not.toThrow();

    const obj = parsed as Record<string, unknown>;
    expect(obj).toHaveProperty("mcpServers");
    const recondo = (obj.mcpServers as Record<string, unknown>)
      .recondo as Record<string, unknown>;
    expect(recondo).toMatchObject({
      type: "streamable-http",
      url: "http://localhost:4001/mcp",
    });
    expect(recondo).not.toHaveProperty("headers");
    expect(recondo).not.toHaveProperty("command");
    expect(recondo).not.toHaveProperty("env");
  });

  it("can derive the local URL from RECONDO_MCP_PORT", async () => {
    const result = await runConfig(["config", "claude-code"], {
      RECONDO_MCP_PORT: "4111",
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      mcpServers: { recondo: { url: string } };
    };
    expect(parsed.mcpServers.recondo.url).toBe("http://localhost:4111/mcp");
  });
});

describeIfBinary("recondo-mcp config cursor", () => {
  it("emits the cursor mcpServers remote shape", async () => {
    const result = await runConfig(["config", "cursor"], {
      RECONDO_MCP_URL: "http://localhost:4001/mcp",
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    const recondo = (parsed.mcpServers as Record<string, unknown>)
      .recondo as Record<string, unknown>;
    expect(recondo.type).toBe("streamable-http");
    expect(recondo.url).toBe("http://localhost:4001/mcp");
    expect(recondo).not.toHaveProperty("command");
  });
});

describeIfBinary("recondo-mcp config goose", () => {
  it("emits the goose remote extension shape", async () => {
    const result = await runConfig(["config", "goose"], {
      RECONDO_MCP_URL: "http://localhost:4001/mcp",
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("mcpServers");
    expect(parsed).toHaveProperty("extensions");
    const recondo = (parsed.extensions as Record<string, unknown>)
      .recondo as Record<string, unknown>;
    expect(recondo).toMatchObject({
      enabled: true,
      name: "recondo",
      type: "streamable-http",
      url: "http://localhost:4001/mcp",
    });
    expect(recondo).not.toHaveProperty("headers");
    expect(recondo).not.toHaveProperty("cmd");
  });
});

describeIfBinaryAndDb("scoped config — `--scoped` mints a key", () => {
  it("`config claude-code --scoped my-project` emits a scoped bearer header exactly once", async () => {
    const result = await runConfig(["config", "claude-code", "--scoped", "my-project"], {
      RECONDO_MCP_URL: "http://localhost:4001/mcp",
    });
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const parsed = JSON.parse(result.stdout.trim()) as {
      mcpServers: { recondo: { headers: Record<string, string> } };
    };
    const auth = parsed.mcpServers.recondo.headers.Authorization;
    expect(auth).toMatch(/^Bearer wrt_/);
    expect(result.stdout.match(/Authorization/g)?.length).toBe(1);

    const rawSecret = auth.slice("Bearer ".length);
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

describeIfBinary("unknown flavor", () => {
  it("`config bogus` exits non-zero without partial JSON", async () => {
    const result = await runConfig(["config", "bogus-flavor"]);
    expect(result.code).not.toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
