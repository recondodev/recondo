import { defineConfig } from "vitest/config";

/**
 * Vitest config — split into two projects so integration tests run in
 * a single fork while unit tests stay parallel.
 *
 * Why: integration tests under `tests/integration/**` truncate the
 * shared captured tables (sessions / turns / tool_calls / attachments)
 * inside a `recondo.gdpr_bypass` transaction before seeding fixtures.
 * Vitest 3 schedules test FILES across multiple worker forks by
 * default, so two integration files seeding concurrently against the
 * same Postgres race — one TRUNCATE wipes the other's fixtures and
 * the assertions flap (~60% repro on CI).
 *
 * The `integration` project sets `pool: "forks"` + `singleFork: true`
 * which serialises every integration file onto a single worker
 * process. Unit tests stay in their own project with default
 * parallelism so the suite total stays fast.
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          testTimeout: 20000,
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 30000,
          pool: "forks",
          poolOptions: {
            forks: {
              singleFork: true,
            },
          },
        },
      },
    ],
  },
});
