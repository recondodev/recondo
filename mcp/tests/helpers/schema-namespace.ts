/**
 * Per-test schema helper for integration tests that need isolated
 * scratch database state.
 *
 * Existing MCP integration helpers still seed the canonical schema for
 * end-to-end server tests. This helper is for tests that can execute
 * DB work in-process and need to prove concurrent schema isolation.
 */

let counter = 0;

export interface IsolatedSchemaClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

export async function withIsolatedSchema<T>(
  callback: (schemaName: string, client: IsolatedSchemaClient) => Promise<T>,
): Promise<T> {
  const { getPool } = await import("@recondo/data");
  const pool = getPool();
  const client = await pool.connect();
  const schemaName = `recondo_test_${process.pid}_${++counter}`;
  const quoted = quoteIdent(schemaName);
  const previousSearchPath = await client.query(`SHOW search_path`);
  const previous = String(previousSearchPath.rows[0]?.search_path ?? "public");

  await client.query(`CREATE SCHEMA ${quoted}`);
  try {
    await client.query(`SET search_path TO ${quoted}, public`);
    return await callback(schemaName, client);
  } finally {
    await client.query(`SET search_path TO ${previous}`);
    await client.query(`DROP SCHEMA ${quoted} CASCADE`);
    client.release();
  }
}
