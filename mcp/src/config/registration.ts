/**
 * `recondo-mcp config <flavor>` JSON emitter.
 *
 * Pure function — reads `process.env` (or an injected env), emits a
 * remote Streamable HTTP registration JSON document for the requested
 * MCP-host flavor:
 *
 *   - `claude-code` and `cursor` → `{mcpServers: {recondo: {type,
 *     url, headers}}}`.
 *   - `goose` → `{extensions: {recondo: {type, url, headers}}}`.
 *
 * When the binary handles `--scoped <project_id>`, it mints a scoped
 * key before calling this emitter and passes that raw secret as an
 * Authorization header. Normal config emission remains DB-free and
 * never includes credentials unless the caller supplies `apiKey`.
 */

export type RegistrationFlavor = "claude-code" | "cursor" | "goose";

export interface RegistrationOptions {
  client: RegistrationFlavor;
  flags?: {
    allowActions?: boolean;
    allowDestructive?: boolean;
  };
  includeArgs?: boolean;
  apiKey?: string;
  /**
   * Optional env override — defaults to `process.env`. Tests pass an
   * explicit env so they can isolate the read from the harness.
   */
  env?: NodeJS.ProcessEnv;
}

function resolveMcpUrl(env: NodeJS.ProcessEnv): string {
  const explicit = env.RECONDO_MCP_URL;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  const port = env.RECONDO_MCP_PORT ?? env.PORT ?? "4001";
  return `http://localhost:${port}/mcp`;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  if (apiKey && apiKey.length > 0) {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return {};
}

function buildServerConfig(
  url: string,
  headers: Record<string, string>,
): Record<string, unknown> {
  const server: Record<string, unknown> = {
    type: "streamable-http",
    url,
  };
  if (Object.keys(headers).length > 0) {
    server.headers = headers;
  }
  return server;
}

export function emitRegistrationJson(options: RegistrationOptions): string {
  const env = options.env ?? process.env;
  const url = resolveMcpUrl(env);
  const headers = buildHeaders(options.apiKey);
  const server = buildServerConfig(url, headers);

  let payload: Record<string, unknown>;
  switch (options.client) {
    case "claude-code":
    case "cursor":
      payload = {
        mcpServers: {
          recondo: server,
        },
      };
      break;
    case "goose":
      payload = {
        extensions: {
          recondo: {
            name: "recondo",
            enabled: true,
            ...server,
          },
        },
      };
      break;
    default: {
      const exhaustive: never = options.client;
      throw new Error(`Unknown registration flavor: ${String(exhaustive)}`);
    }
  }

  return JSON.stringify(payload, null, 2);
}

/**
 * Validate that the supplied flavor is one of the three v1 flavors.
 * Throws on bad input — the binary entrypoint catches and exits 1.
 */
export function assertSupportedFlavor(value: string): RegistrationFlavor {
  if (value === "claude-code" || value === "cursor" || value === "goose") {
    return value;
  }
  throw new Error(
    `Unsupported config flavor '${value}'; expected one of: claude-code, cursor, goose`,
  );
}
