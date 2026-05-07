/**
 * `recondo-mcp config <flavor>` JSON emitter (D-C12-1, D-C12-3).
 *
 * Pure function — reads `process.env` (or an injected env), emits a
 * registration JSON document for the requested MCP-host flavor:
 *
 *   - `claude-code` and `cursor` → `{mcpServers: {recondo: {command,
 *     env}}}`. (Identical wire shape per Plan D §Task 26.)
 *   - `goose` → `{extensions: {recondo: {type: "stdio", cmd, env}}}`.
 *
 * Per the C0 audit (Decision 3, Option A) the legacy `--scoped
 * <project_id>` flag is DROPPED in v1: this emitter does not mint API
 * keys, does not contact the DB, and never injects `RECONDO_API_KEY`
 * into the emitted env. Operators paste their own key into the
 * generated config file.
 *
 * The `env` object only includes vars that are actually set in the
 * input environment — no empty-string injection. The two interesting
 * vars right now are `DATABASE_URL` and `RECONDO_OBJECT_STORE_PATH`.
 */

export type RegistrationFlavor = "claude-code" | "cursor" | "goose";

export interface RegistrationOptions {
  client: RegistrationFlavor;
  /**
   * Optional env override — defaults to `process.env`. Tests pass an
   * explicit env so they can isolate the read from the harness.
   */
  env?: NodeJS.ProcessEnv;
}

/** Env vars surfaced into the emitted registration block, in order. */
const PROPAGATED_ENV_VARS = [
  "DATABASE_URL",
  "RECONDO_OBJECT_STORE_PATH",
] as const;

const COMMAND = "recondo-mcp";

function buildEnvBlock(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PROPAGATED_ENV_VARS) {
    const v = env[key];
    if (typeof v === "string" && v.length > 0) {
      out[key] = v;
    }
  }
  return out;
}

export function emitRegistrationJson(options: RegistrationOptions): string {
  const env = options.env ?? process.env;
  const envBlock = buildEnvBlock(env);

  let payload: Record<string, unknown>;
  switch (options.client) {
    case "claude-code":
    case "cursor":
      payload = {
        mcpServers: {
          recondo: {
            command: COMMAND,
            env: envBlock,
          },
        },
      };
      break;
    case "goose":
      payload = {
        extensions: {
          recondo: {
            type: "stdio",
            cmd: COMMAND,
            env: envBlock,
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
