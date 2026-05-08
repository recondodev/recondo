import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";
import pg from "pg";

const { Client } = pg;

const binaryPath = fileURLToPath(
  new URL("../../dist/bin/recondo-mcp.js", import.meta.url),
);
const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const migrationsDir = resolve(repoRoot, "api/migrations");

const reasons: string[] = [];
if (!process.env.DATABASE_URL) reasons.push("no_database_url");
if (!existsSync(binaryPath)) reasons.push("no_binary");

if (reasons.length > 0) {
  console.warn(JSON.stringify({
    skipped: true,
    suite: "mcp-integration",
    reason: reasons.join(","),
  }));
}

let schemaName: string | undefined;
let originalDatabaseUrl: string | undefined;

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function withSearchPath(databaseUrl: string, schema: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

async function applySqlMigrations(client: pg.Client): Promise<void> {
  const files = (await readdir(migrationsDir))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  for (const file of files) {
    const sql = await readFile(resolve(migrationsDir, file), "utf8");
    await client.query(sql);
  }
}

async function createIsolatedSchema(): Promise<void> {
  originalDatabaseUrl = process.env.DATABASE_URL;
  if (!originalDatabaseUrl || reasons.length > 0) return;

  schemaName = `recondo_test_${process.pid}_${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}`;
  const quoted = quoteIdent(schemaName);
  const client = new Client({ connectionString: originalDatabaseUrl });

  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${quoted}`);
    await client.query(`SET search_path TO ${quoted}, public`);
    await applySqlMigrations(client);
  } finally {
    await client.query("RESET search_path").catch(() => {});
    await client.end();
  }

  process.env.RECONDO_TEST_SCHEMA = schemaName;
  process.env.DATABASE_URL = withSearchPath(originalDatabaseUrl, schemaName);
}

async function dropIsolatedSchema(): Promise<void> {
  if (!schemaName || !originalDatabaseUrl) return;
  const client = new Client({ connectionString: originalDatabaseUrl });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schemaName)} CASCADE`);
  } finally {
    await client.end();
  }
}

await createIsolatedSchema();

afterAll(async () => {
  await dropIsolatedSchema();
});
