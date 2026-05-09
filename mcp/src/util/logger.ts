/**
 * Stderr-only structured logger for recondo-mcp.
 *
 * The service uses stdout only for explicit CLI output, such as the
 * `config` subcommand. Normal service logs write EXCLUSIVELY to
 * process.stderr — never `console.log`, never `process.stdout.write`.
 *
 * Each call serialises `{...fields, level, msg}` to a single JSON line
 * suffixed with `\n`. Fields supplied by the caller win over `level`
 * and `msg` if they collide; that's intentional — callers control the
 * shape they want to emit.
 */

type Fields = Record<string, unknown>;

function emit(level: "info" | "warn" | "error", fields: Fields, msg: string): void {
  const record = { ...fields, level, msg };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // If a caller passes a value with cycles or BigInts, fall back to
    // a minimal record so we still produce a parseable line.
    line = JSON.stringify({ level, msg, serialise_error: true });
  }
  process.stderr.write(line + "\n");
}

export const logger = {
  info(fields: Fields, msg: string): void {
    emit("info", fields, msg);
  },
  warn(fields: Fields, msg: string): void {
    emit("warn", fields, msg);
  },
  error(fields: Fields, msg: string): void {
    emit("error", fields, msg);
  },
};
