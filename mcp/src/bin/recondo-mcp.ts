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

  // C12 will dispatch `recondo-mcp config <flavor>`. For C1, parse-only.
  if (flags.remaining[0] === "config") {
    logger.error(
      { subcommand: flags.remaining.join(" ") },
      "config subcommand is not yet implemented (C12)",
    );
    process.exit(1);
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
