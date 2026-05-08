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

export interface ParsedFlags {
  allowActions: boolean;
  allowDestructive: boolean;
  emitArgs: boolean;
  scopedProjectId?: string;
  remaining: string[];
}

export function parseFlags(argv: string[]): ParsedFlags {
  let allowActions = false;
  let allowDestructive = false;
  let emitArgs = false;
  let scopedProjectId: string | undefined;
  const remaining: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--allow-actions") {
      allowActions = true;
      continue;
    }
    if (token === "--allow-destructive") {
      allowDestructive = true;
      continue;
    }
    if (token === "--emit-args") {
      emitArgs = true;
      continue;
    }
    if (token === "--scoped") {
      const value = argv[++i];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
        throw new Error("--scoped requires a project id");
      }
      scopedProjectId = value;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Unknown flag: ${token}`);
    }
    remaining.push(token);
  }

  if (allowDestructive && !allowActions) {
    throw new Error("--allow-destructive requires --allow-actions");
  }

  return { allowActions, allowDestructive, emitArgs, scopedProjectId, remaining };
}
