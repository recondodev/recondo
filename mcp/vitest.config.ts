import { defineConfig } from "vitest/config";

/**
 * Vitest config — split into unit and integration projects. Integration
 * tests include a setup hook that emits structured skip warnings when
 * DATABASE_URL or the built MCP binary are missing; CI recipes grep for
 * those warnings so infra-dependent coverage cannot disappear silently.
 */
export default defineConfig({
  test: {
    sequence: {
      hooks: "stack",
    },
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
          setupFiles: ["tests/integration/setup.ts"],
          testTimeout: 30000,
          pool: "forks",
        },
      },
    ],
  },
});
