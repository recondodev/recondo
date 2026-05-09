/**
 * `recondo-mcp config <flavor>` emits remote Streamable HTTP
 * registration snippets. There is no child-process registration
 * path because recondo-mcp is a long-running service.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@recondo/data", () => ({
  getPool: vi.fn(),
  closePool: vi.fn(),
}));

import { parseFlags } from "../../src/config/flags.js";
import { emitRegistrationJson } from "../../src/config/registration.js";

const ORIGINAL_ENV = { ...process.env };

describe("emitRegistrationJson — claude-code flavor", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.RECONDO_API_KEY;
    delete process.env.RECONDO_MCP_URL;
    delete process.env.RECONDO_MCP_PORT;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("emits a remote Streamable HTTP mcpServers shape", async () => {
    const json = await emitRegistrationJson({ client: "claude-code" });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed).toHaveProperty("mcpServers");
    const recondo = (parsed.mcpServers as Record<string, unknown>)
      .recondo as Record<string, unknown>;
    expect(recondo).toMatchObject({
      type: "streamable-http",
      url: "http://localhost:4001/mcp",
    });
    expect(recondo).not.toHaveProperty("headers");
    expect(recondo).not.toHaveProperty("command");
    expect(recondo).not.toHaveProperty("env");
    expect(recondo).not.toHaveProperty("args");
  });

  it("uses RECONDO_MCP_URL when supplied", async () => {
    process.env.RECONDO_MCP_URL = "https://mcp.example.com/mcp";

    const json = await emitRegistrationJson({ client: "claude-code" });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { url: string } };
    };

    expect(parsed.mcpServers.recondo.url).toBe("https://mcp.example.com/mcp");
  });

  it("uses RECONDO_MCP_PORT when no explicit URL is supplied", async () => {
    process.env.RECONDO_MCP_PORT = "9444";

    const json = await emitRegistrationJson({ client: "claude-code" });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { url: string } };
    };

    expect(parsed.mcpServers.recondo.url).toBe("http://localhost:9444/mcp");
  });

  it("does not include credentials by default", async () => {
    process.env.RECONDO_API_KEY = "wrt_operator_secret";

    const json = await emitRegistrationJson({ client: "claude-code" });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: Record<string, unknown> };
    };

    expect(parsed.mcpServers.recondo).not.toHaveProperty("headers");
    expect(json).not.toContain("wrt_operator_secret");
  });
});

describe("emitRegistrationJson — cursor flavor", () => {
  it("uses the same remote mcpServers shape as claude-code", async () => {
    const json = await emitRegistrationJson({
      client: "cursor",
      env: { RECONDO_MCP_URL: "http://localhost:4001/mcp" } as NodeJS.ProcessEnv,
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const recondo = (parsed.mcpServers as Record<string, unknown>)
      .recondo as Record<string, unknown>;

    expect(recondo.type).toBe("streamable-http");
    expect(recondo.url).toBe("http://localhost:4001/mcp");
    expect(recondo).not.toHaveProperty("command");
  });
});

describe("emitRegistrationJson — goose flavor", () => {
  it("emits a remote extension shape, not a cmd-based one", async () => {
    const json = await emitRegistrationJson({
      client: "goose",
      env: { RECONDO_MCP_URL: "http://localhost:4001/mcp" } as NodeJS.ProcessEnv,
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;

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
    expect(recondo).not.toHaveProperty("env");
  });
});

describe("scoped config — `--scoped` flag + emitted header", () => {
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

  it("the config emitter includes Authorization only when apiKey is supplied", async () => {
    const json = await emitRegistrationJson({
      client: "claude-code",
      apiKey: "wrt_scoped_secret",
    });
    const parsed = JSON.parse(json) as {
      mcpServers: { recondo: { headers: Record<string, string> } };
    };

    expect(parsed.mcpServers.recondo.headers.Authorization).toBe(
      "Bearer wrt_scoped_secret",
    );
  });
});
