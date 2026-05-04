import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // FIND-7-A: force the entire suite to run in a single child
    // process. Combined with global-setup migrating once and the
    // per-file TRUNCATE-only cleanup, this guarantees no cross-
    // process schema races. The reviewers reported 27/116/39 and
    // 184/57/0 failure-count-flapping across runs — root cause was
    // per-file `wipeSchema + runMigrations` in setupDatabase racing
    // with the in-process server's open connections. Now: schema
    // exists for the entire run; per-file cleanup is data-only.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Run test files sequentially — they share a database and server
    fileParallelism: false,
    // Run tests within a file sequentially for deterministic DB state
    sequence: {
      concurrent: false,
    },
    // Register pg type parser for name[] so array_agg(attname) returns JS arrays
    setupFiles: ["./tests/pg-types-setup.ts"],
    // Start the API server against recondo_test before any test runs
    globalSetup: "./tests/global-setup.ts",
  },
});
