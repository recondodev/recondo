/**
 * D-C12-1, D-C12-2, D-C12-3 (unit) — `recondo-mcp config <flavor>` subcommand.
 *
 * Per the C0 audit (Decision 3, Option A), `--scoped` is DROPPED in v1.
 * `mintScopedKey` does not exist; the flag is not recognized.
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
 *   - `--scoped` is rejected at the flag layer (parseFlags throws on unknown flag).
 *
 * NOTE: We mock @recondo/data so the registration helper can import
 * sibling modules without a live pool. The config flow MUST NOT touch
 * the database — JSON emission is pure / process.env only.
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

type Flavor = "claude-code" | "cursor" | "goose";

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
  });

  it("does NOT include RECONDO_API_KEY for goose either", async () => {
    const json = await emitRegistrationJson({ client: "goose" });
    expect(json).not.toContain("RECONDO_API_KEY");
  });
});

describe("D-C12-2 [DROPPED per C0 §5 #3] — `--scoped` flag is rejected", () => {
  it("`config claude-code --scoped abc` is rejected by parseFlags as unknown flag", () => {
    // Per C0 Decision 3 Option A: `--scoped` is removed entirely from
    // the v1 surface. parseFlags rejects all unknown `--*` tokens, so
    // the rejection is at the flag-parser layer — no special-case
    // handling needed in the config dispatcher.
    expect(() => parseFlags(["config", "claude-code", "--scoped", "abc"])).toThrow(
      /--scoped/,
    );
  });

  it("the config emitter surface does NOT accept `scopedProjectId` (TS contract)", async () => {
    // The RegistrationOptions type must NOT have a `scopedProjectId`
    // field. We assert at runtime that passing one through is either
    // ignored OR throws — but it must NOT produce a `RECONDO_API_KEY`
    // in the env. The runtime contract: no key minting.
    process.env.DATABASE_URL = "postgres://x";
    delete process.env.RECONDO_API_KEY;
    // `as never` because the implementer should not have widened the
    // type to permit this; this exists to catch a regression where
    // someone re-adds `scopedProjectId` plumbing.
    const json = await emitRegistrationJson({
      client: "claude-code",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(({ scopedProjectId: "proj_should_not_mint" } as unknown) as object),
    } as { client: Flavor });
    expect(json).not.toContain("RECONDO_API_KEY");
    expect(json).not.toContain("proj_should_not_mint");
  });
});
