/**
 * CLI flag parser for `recondo-mcp`.
 *
 * Final-state validation: walk argv once, collect flags into a record,
 * then validate the resulting state. Order doesn't matter — the only
 * invariant is `--allow-destructive` requires `--allow-actions`.
 *
 * Subcommand args (e.g. `config claude-code`) flow through `remaining`
 * verbatim for the binary entrypoint to dispatch in C12.
 */

const KNOWN_FLAGS = new Set(["--allow-actions", "--allow-destructive"]);

export interface ParsedFlags {
  allowActions: boolean;
  allowDestructive: boolean;
  remaining: string[];
}

export function parseFlags(argv: string[]): ParsedFlags {
  let allowActions = false;
  let allowDestructive = false;
  const remaining: string[] = [];

  for (const token of argv) {
    if (token === "--allow-actions") {
      allowActions = true;
      continue;
    }
    if (token === "--allow-destructive") {
      allowDestructive = true;
      continue;
    }
    if (token.startsWith("--")) {
      if (!KNOWN_FLAGS.has(token)) {
        throw new Error(`Unknown flag: ${token}`);
      }
      continue;
    }
    remaining.push(token);
  }

  if (allowDestructive && !allowActions) {
    throw new Error("--allow-destructive requires --allow-actions");
  }

  return { allowActions, allowDestructive, remaining };
}
