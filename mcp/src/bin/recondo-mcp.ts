#!/usr/bin/env node
/**
 * recondo-mcp binary entrypoint.
 *
 * Parses flags + env, then starts the long-running Streamable HTTP
 * service. Errors are written to stderr (logger) and the process exits
 * non-zero so a broken config never silently boots.
 */

import { mintScopedKey } from "@recondo/data";
import { logger } from "../util/logger.js";
import { parseFlags } from "../config/flags.js";
import { loadEnvConfig } from "../config/env.js";
import {
  emitRegistrationJson,
  assertSupportedFlavor,
} from "../config/registration.js";
import { startHttpServer } from "../http.js";

function parsePort(value: string | undefined): number {
  const raw = value ?? "4001";
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`invalid MCP port: ${raw}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "failed to parse CLI flags");
    process.exit(1);
  }

  // `recondo-mcp config <flavor>`. JSON emission is pure and DB-free
  // unless --scoped is used to mint a bearer key. This is the only
  // normal-mode stdout output; the service itself listens over HTTP.
  if (flags.remaining[0] === "config") {
    try {
      const flavorArg = flags.remaining[1];
      if (typeof flavorArg !== "string" || flavorArg.length === 0) {
        throw new Error(
          "config subcommand requires a flavor argument (claude-code | cursor | goose)",
        );
      }
      const flavor = assertSupportedFlavor(flavorArg);
      // No extra positional args after the flavor are expected.
      if (flags.remaining.length > 2) {
        throw new Error(
          `unexpected positional argument(s) after flavor: ${flags.remaining
            .slice(2)
            .join(" ")}`,
        );
      }
      let apiKey: string | undefined;
      if (flags.scopedProjectId) {
        const minted = await mintScopedKey({
          projectId: flags.scopedProjectId,
          name: `mcp-${flavor}-${Date.now()}`,
        });
        apiKey = minted.rawSecret;
      }
      const json = emitRegistrationJson({
        client: flavor,
        includeArgs: flags.emitArgs,
        flags,
        apiKey,
      });
      process.stdout.write(json + "\n");
      process.exit(0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, "config subcommand failed");
      process.exit(1);
    }
  }

  let env;
  try {
    env = loadEnvConfig(process.env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "failed to load environment config");
    process.exit(1);
  }

  try {
    await startHttpServer({
      env,
      flags,
      host: process.env.RECONDO_MCP_HOST ?? "127.0.0.1",
      port: parsePort(process.env.RECONDO_MCP_PORT ?? process.env.PORT),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "failed to start mcp http service");
    process.exit(1);
  }
}

void main();
