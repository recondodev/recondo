/**
 * D-C12-1, D-C12-2, D-C12-3 (unit) — `recondo-mcp config <flavor>` subcommand.
 *
 * Hardening restores `--scoped <project_id>` as a first-class config
 * option. The binary mints the key; this unit file checks parser and
 * emitter behavior without touching the DB.
 *
 * The implementer must export an `emitRegistrationJson` (or equivalently
 * named) function from a config-subcommand module — these unit tests
 * exercise the JSON shape directly without spawning the binary. The
 * integration-side coverage lives in `tests/integration/config-subcommand.test.ts`.
 *
 * Expected import path (RED until C12 lands):
 *   `../../src/config/registration.js` exports `emitRegistrationJson`.
 *
 * Acceptance:
 *   - claude-code flavor → `{mcpServers: {recondo: {command: "recondo-mcp", env: {...}}}}`.
 *   - cursor flavor → same `mcpServers` shape (per Plan D §Task 26).
 *   - goose flavor → `{extensions: {recondo: {type: "stdio", cmd: "recondo-mcp", env: {...}}}}`.
 *   - env populated from process.env (DATABASE_URL, RECONDO_OBJECT_STORE_PATH).
 *   - NO `RECONDO_API_KEY` in env by default.
 *   - `--scoped` is parsed and an explicitly supplied apiKey is emitted.
 *
 * NOTE: We mock @recondo/data so the registration helper can import
 * sibling modules without a live pool. JSON emission is pure /
 * process.env only; scoped key minting happens in the binary before the
 * emitter is called.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@recondo/data", () => ({
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

import { parseFlags } from "../../src/config/flags.js";

// Implementer must export `emitRegistrationJson` (sync OR async — the
// test awaits regardless). Plan D §Task 26 names the module
// `mcp/src/config/registration.ts`.
//
// If the implementer picks a different filename, update only this import.
import { emitRegistrationJson } from "../../src/config/registration.js";

const ORIGINAL_ENV = { ...process.env };

describe("D-C12-1 emitRegistrationJson — claude-code flavor", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.DATABASE_URL = "postgres://app:secret@db.example/recondo";
    process.env.RECONDO_OBJECT_STORE_PATH = "/var/recondo/objects";
    delete process.env.RECONDO_API_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("emits the canonical Claude Code mcpServers shape", async () => {
    const json = await emitRegistrationJson({ client: "claude-code" });
    expect(typeof json).toBe("string");

    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toHaveProperty("mcpServers");
    const servers = parsed.mcpServers as Record<string, unknown>;
    expect(servers).toHaveProperty("recondo");
    const recondo = servers.recondo as Record<string, unknown>;
    expect(recondo.command).toBe("recondo-mcp");
    expect(recondo).toHaveProperty("env");
  });

  it("populates env from process.env (DATABASE_URL, RECONDO_OBJECT_STORE_PATH)", async () => {
    const json = await emitRegistrationJson({ client: "claude-code" });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { env: Record<string, string> } };
    };
    const env = parsed.mcpServers.recondo.env;
    expect(env.DATABASE_URL).toBe("postgres://app:secret@db.example/recondo");
    expect(env.RECONDO_OBJECT_STORE_PATH).toBe("/var/recondo/objects");
  });

  it("propagates dev-bypass and local object/data dir env when present", async () => {
    process.env.RECONDO_DEV_BYPASS = "1";
    process.env.RECONDO_DATA_DIR = "/var/recondo/data";
    process.env.RECONDO_OBJECTS = "/var/recondo/raw-objects";
    process.env.NODE_ENV = "development";

    const json = await emitRegistrationJson({ client: "claude-code" });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { env: Record<string, string> } };
    };
    expect(parsed.mcpServers.recondo.env).toMatchObject({
      RECONDO_DEV_BYPASS: "1",
      RECONDO_DATA_DIR: "/var/recondo/data",
      RECONDO_OBJECTS: "/var/recondo/raw-objects",
      NODE_ENV: "development",
    });
  });

  it("emits args when includeArgs is requested", async () => {
    const json = await emitRegistrationJson({
      client: "claude-code",
      includeArgs: true,
      flags: { allowActions: true, allowDestructive: false },
    });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { args: string[] } };
    };
    expect(parsed.mcpServers.recondo.args).toEqual(["--allow-actions"]);
  });

  it("emits destructive args only after allow-actions", async () => {
    const json = await emitRegistrationJson({
      client: "claude-code",
      includeArgs: true,
      flags: { allowActions: true, allowDestructive: true },
    });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { args: string[] } };
    };
    expect(parsed.mcpServers.recondo.args).toEqual([
      "--allow-actions",
      "--allow-destructive",
    ]);
  });

  it("does NOT include RECONDO_API_KEY in env by default (operator supplies their own)", async () => {
    const json = await emitRegistrationJson({ client: "claude-code" });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { env: Record<string, string> } };
    };
    const env = parsed.mcpServers.recondo.env;
    expect(env).not.toHaveProperty("RECONDO_API_KEY");
    // Belt-and-suspenders: stringify check guards against the field
    // appearing somewhere outside `env`.
    expect(json).not.toContain("RECONDO_API_KEY");
  });

  it("omits env values that are not set in process.env (no empty-string injection)", async () => {
    delete process.env.DATABASE_URL;
    delete process.env.RECONDO_OBJECT_STORE_PATH;
    const json = await emitRegistrationJson({ client: "claude-code" });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { env: Record<string, string> } };
    };
    const env = parsed.mcpServers.recondo.env;
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("RECONDO_OBJECT_STORE_PATH");
  });
});

describe("D-C12-3 emitRegistrationJson — cursor flavor", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.DATABASE_URL = "postgres://x";
    process.env.RECONDO_OBJECT_STORE_PATH = "/y";
    delete process.env.RECONDO_API_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses the same mcpServers shape as Claude Code (per Plan D §Task 26)", async () => {
    const json = await emitRegistrationJson({ client: "cursor" });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toHaveProperty("mcpServers");
    const recondo = (parsed.mcpServers as Record<string, unknown>)
      .recondo as Record<string, unknown>;
    expect(recondo.command).toBe("recondo-mcp");
    expect(recondo).toHaveProperty("env");
    expect(recondo).toHaveProperty("args");
  });

  it("does NOT include RECONDO_API_KEY for cursor either", async () => {
    const json = await emitRegistrationJson({ client: "cursor" });
    expect(json).not.toContain("RECONDO_API_KEY");
  });
});

describe("D-C12-3 emitRegistrationJson — goose flavor", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.DATABASE_URL = "postgres://x";
    process.env.RECONDO_OBJECT_STORE_PATH = "/y";
    delete process.env.RECONDO_API_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses the goose `extensions` shape with type=stdio + cmd field", async () => {
    const json = await emitRegistrationJson({ client: "goose" });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Goose differs from Claude Code / Cursor: extensions block, type+cmd.
    expect(parsed).not.toHaveProperty("mcpServers");
    expect(parsed).toHaveProperty("extensions");
    const extensions = parsed.extensions as Record<string, unknown>;
    expect(extensions).toHaveProperty("recondo");
    const recondo = extensions.recondo as Record<string, unknown>;
    expect(recondo.type).toBe("stdio");
    expect(recondo.cmd).toBe("recondo-mcp");
    expect(recondo).toHaveProperty("env");
    expect(recondo).toHaveProperty("args");
    expect(recondo).toMatchObject({ enabled: true, name: "recondo" });
  });

  it("does NOT include RECONDO_API_KEY for goose either", async () => {
    const json = await emitRegistrationJson({ client: "goose" });
    expect(json).not.toContain("RECONDO_API_KEY");
  });
});

describe("D-HARD scoped config — `--scoped` flag + emitted key", () => {
  it("`config claude-code --scoped abc` is parsed as a scoped project id", () => {
    const parsed = parseFlags(["config", "claude-code", "--scoped", "abc"]);
    expect(parsed.remaining).toEqual(["config", "claude-code"]);
    expect(parsed.scopedProjectId).toBe("abc");
  });

  it("`--scoped` requires a project id", () => {
    expect(() => parseFlags(["config", "claude-code", "--scoped"])).toThrow(
      /requires a project id/,
    );
  });

  it("the config emitter includes RECONDO_API_KEY only when apiKey is supplied", async () => {
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.RECONDO_API_KEY;
    const json = await emitRegistrationJson({
      client: "claude-code",
      apiKey: "wrt_scoped_secret",
    });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { env: Record<string, string> } };
    };
    expect(parsed.mcpServers.recondo.env.RECONDO_API_KEY).toBe(
      "wrt_scoped_secret",
    );
  });
});
