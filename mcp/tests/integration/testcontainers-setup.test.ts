import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { RECONDO_MCP_BINARY } from "../helpers/spawnMcp.js";

const HAVE_BINARY = existsSync(RECONDO_MCP_BINARY);
const describeIfBinary = HAVE_BINARY ? describe : describe.skip;

describeIfBinary("integration database setup", () => {
  it("provides DATABASE_URL even when the caller did not", () => {
    expect(process.env.DATABASE_URL).toMatch(/^postgres:\/\//);
    expect(process.env.RECONDO_TEST_SCHEMA).toMatch(/^recondo_test_/);
  });
});
