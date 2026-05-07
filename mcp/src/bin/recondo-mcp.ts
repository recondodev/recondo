#!/usr/bin/env node
/**
 * recondo-mcp binary entrypoint.
 *
 * Parses flags + env, creates the MCP server, and connects the stdio
 * transport. Errors are written to stderr (logger) and the process
 * exits non-zero so a broken config never silently boots.
 *
 * The `config` subcommand path is C12's job; for C1, if `config`
 * appears in `remaining`, log a not-yet-implemented error and exit
 * non-zero rather than dispatching.
 */

import { logger } from "../util/logger.js";
import { parseFlags } from "../config/flags.js";
import { loadEnvConfig } from "../config/env.js";
import {
  emitRegistrationJson,
  assertSupportedFlavor,
} from "../config/registration.js";
import { createMcpServer, connectStdio } from "../server.js";

async function main(): Promise<void> {
  let flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "failed to parse CLI flags");
    process.exit(1);
  }

  // C12 — `recondo-mcp config <flavor>`. JSON emission is pure and
  // DB-free; this is the ONLY place in the binary where stdout is a
  // legitimate output channel (the SDK transport owns stdout otherwise).
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
      const json = emitRegistrationJson({ client: flavor });
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

  let server;
  try {
    server = await createMcpServer({ env, flags });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "failed to create mcp server");
    process.exit(1);
  }
  try {
    await connectStdio(server);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ error: msg }, "failed to connect stdio transport");
    process.exit(1);
  }
}

void main();
