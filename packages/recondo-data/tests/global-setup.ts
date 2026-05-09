import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

let postgres: StartedPostgreSqlContainer | undefined;

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, "../../..");
const API_DIR = resolve(REPO_ROOT, "api");

export default async function setup(): Promise<() => Promise<void>> {
  if (!process.env.DATABASE_URL) {
    postgres = await new PostgreSqlContainer("postgres:17-alpine")
      .withDatabase("recondo_test")
      .withUsername("recondo")
      .withPassword("recondo_dev")
      .start();
    process.env.DATABASE_URL = postgres.getConnectionUri();
    process.env.RECONDO_TESTCONTAINERS_POSTGRES = "1";

    try {
      execSync("pnpm run migrate up", {
        cwd: API_DIR,
        env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: Buffer;
        stderr?: Buffer;
      };
      const stdout = e.stdout?.toString() ?? "";
      const stderr = e.stderr?.toString() ?? "";
      const detail = e instanceof Error ? e.message : String(e);
      throw new Error(
        `[recondo-data global setup] migrations failed against ${process.env.DATABASE_URL}\n`
          + `${detail}\n`
          + (stdout.length > 0 ? `\n--- migrate stdout ---\n${stdout}` : "")
          + (stderr.length > 0 ? `\n--- migrate stderr ---\n${stderr}` : ""),
      );
    }
  }

  return async () => {
    await postgres?.stop();
    postgres = undefined;
  };
}
