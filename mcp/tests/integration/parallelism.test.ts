import { describe, it, expect } from "vitest";

import { withIsolatedSchema } from "../helpers/schema-namespace.js";

const HAVE_DB = Boolean(process.env.DATABASE_URL);
const describeIfDb = HAVE_DB ? describe : describe.skip;

describeIfDb("D-HARD integration schema isolation helper", () => {
  it("runs two schema-scoped operations concurrently without cross-contamination", async () => {
    const [left, right] = await Promise.all([
      withIsolatedSchema(async (schemaName, client) => {
        await client.query(`CREATE TABLE scratch (id text PRIMARY KEY)`);
        await client.query(`INSERT INTO scratch (id) VALUES ('left')`);
        const result = await client.query(`SELECT id FROM scratch`);
        return { schemaName, ids: result.rows.map((row) => row.id as string) };
      }),
      withIsolatedSchema(async (schemaName, client) => {
        await client.query(`CREATE TABLE scratch (id text PRIMARY KEY)`);
        await client.query(`INSERT INTO scratch (id) VALUES ('right')`);
        const result = await client.query(`SELECT id FROM scratch`);
        return { schemaName, ids: result.rows.map((row) => row.id as string) };
      }),
    ]);

    expect(left.schemaName).not.toBe(right.schemaName);
    expect(left.ids).toEqual(["left"]);
    expect(right.ids).toEqual(["right"]);
  });
});
