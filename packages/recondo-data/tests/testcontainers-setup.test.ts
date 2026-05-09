import { describe, expect, it } from "vitest";

describe("data package database setup", () => {
  it("provides a database URL from either the caller or Testcontainers", async () => {
    expect(process.env.DATABASE_URL).toMatch(/^postgres:\/\//);
    if (process.env.RECONDO_TESTCONTAINERS_POSTGRES !== undefined) {
      expect(process.env.RECONDO_TESTCONTAINERS_POSTGRES).toBe("1");
    }
  });
});
