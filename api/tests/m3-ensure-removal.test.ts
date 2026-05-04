/**
 * Sprint M3 — Remove ensure*() startup DDL: behavioral tests.
 *
 * After M3, ONLY migration files create tables. The ensure*() functions that
 * ran CREATE TABLE IF NOT EXISTS at API startup must be deleted, along with
 * their imports and invocations in index.ts.
 *
 * This test file verifies the removal at the SOURCE LEVEL by reading the
 * TypeScript files and asserting that the ensure* patterns are gone. This is
 * a deletion sprint — the tests confirm dead code was actually removed.
 *
 * Functions targeted for removal:
 *   1. ensureMonitoringTables()       — api/src/monitoring.ts
 *   2. ensureUsageTables()            — api/src/usage/schema.ts
 *   3. ensureMaterializedViews()      — api/src/usage/schema.ts
 *   4. ensureAnomalyDetectionTables() — api/src/anomaly-detection/baselines.ts
 *   5. ensureSessionRiskTable()       — api/src/risk/classification.ts
 *   6. ensureExportSchedulesTables()  — api/src/exports/schedules.ts
 *
 * These tests are written BEFORE the implementation exists.
 * They will FAIL against the current codebase and PASS after M3 is done.
 *
 * No database or HTTP server required — these are pure source-level checks.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SRC_ROOT = resolve(__dirname, "../src");

/**
 * Read a source file relative to api/src/ and return its contents as a string.
 */
function readSrc(relativePath: string): string {
  const fullPath = resolve(SRC_ROOT, relativePath);
  return readFileSync(fullPath, "utf-8");
}

/**
 * Return all non-empty, non-comment lines from a source file.
 * Strips single-line comments (//) and blank lines for cleaner assertions.
 * Block comments are left intact since they can span code lines.
 */
function codeLines(source: string): string[] {
  return source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"));
}

// =========================================================================
// 1. index.ts must not import any ensure* functions
// =========================================================================

describe("M3.1 — index.ts does not import ensure* functions", () => {
  const ENSURE_IMPORTS = [
    "ensureMonitoringTables",
    "ensureUsageTables",
    "ensureMaterializedViews",
    "ensureAnomalyDetectionTables",
    "ensureSessionRiskTable",
    "ensureExportSchedulesTables",
  ];

  let indexSource: string;

  it("index.ts is readable", () => {
    indexSource = readSrc("index.ts");
    expect(indexSource.length).toBeGreaterThan(0);
  });

  for (const fnName of ENSURE_IMPORTS) {
    it(`does not import ${fnName}`, () => {
      if (!indexSource) indexSource = readSrc("index.ts");
      // Match both named imports like { ensureFoo } and any reference in import lines
      const importLines = indexSource
        .split("\n")
        .filter((line) => line.includes("import") && line.includes(fnName));
      expect(importLines).toHaveLength(0);
    });
  }
});

// =========================================================================
// 2. index.ts must not call any ensure* function at startup
// =========================================================================

describe("M3.2 — index.ts does not call ensure* functions at startup", () => {
  const ENSURE_CALLS = [
    "ensureMonitoringTables",
    "ensureUsageTables",
    "ensureMaterializedViews",
    "ensureAnomalyDetectionTables",
    "ensureSessionRiskTable",
    "ensureExportSchedulesTables",
  ];

  let indexCode: string[];

  it("index.ts has code lines", () => {
    const indexSource = readSrc("index.ts");
    indexCode = codeLines(indexSource);
    expect(indexCode.length).toBeGreaterThan(0);
  });

  for (const fnName of ENSURE_CALLS) {
    it(`does not call ${fnName}()`, () => {
      if (!indexCode) {
        indexCode = codeLines(readSrc("index.ts"));
      }
      const callLines = indexCode.filter((line) => line.includes(fnName));
      expect(callLines).toHaveLength(0);
    });
  }

  it("does not contain the inits array of ensure functions", () => {
    if (!indexCode) {
      indexCode = codeLines(readSrc("index.ts"));
    }
    // The old code had: const inits = [ensureMonitoringTables, ...]
    const initsLines = indexCode.filter(
      (line) => line.includes("inits") && line.includes("ensure")
    );
    expect(initsLines).toHaveLength(0);
  });
});

// =========================================================================
// 3. Source modules must not export ensure* functions
// =========================================================================

describe("M3.3 — ensure* functions are removed from source modules", () => {
  it("monitoring.ts does not export ensureMonitoringTables", () => {
    const source = readSrc("monitoring.ts");
    expect(source).not.toMatch(
      /export\s+(async\s+)?function\s+ensureMonitoringTables/
    );
  });

  it("usage/schema.ts does not export ensureUsageTables", () => {
    const source = readSrc("usage/schema.ts");
    expect(source).not.toMatch(
      /export\s+(async\s+)?function\s+ensureUsageTables/
    );
  });

  it("usage/schema.ts does not export ensureMaterializedViews", () => {
    const source = readSrc("usage/schema.ts");
    expect(source).not.toMatch(
      /export\s+(async\s+)?function\s+ensureMaterializedViews/
    );
  });

  it("anomaly-detection/baselines.ts does not export ensureAnomalyDetectionTables", () => {
    const source = readSrc("anomaly-detection/baselines.ts");
    expect(source).not.toMatch(
      /export\s+(async\s+)?function\s+ensureAnomalyDetectionTables/
    );
  });

  it("risk/classification.ts does not export ensureSessionRiskTable", () => {
    const source = readSrc("risk/classification.ts");
    expect(source).not.toMatch(
      /export\s+(async\s+)?function\s+ensureSessionRiskTable/
    );
  });

  it("exports/schedules.ts does not export ensureExportSchedulesTables", () => {
    const source = readSrc("exports/schedules.ts");
    expect(source).not.toMatch(
      /export\s+(async\s+)?function\s+ensureExportSchedulesTables/
    );
  });
});

// =========================================================================
// 4. No ensure* function DEFINITIONS remain anywhere (not just un-exported)
// =========================================================================

describe("M3.4 — ensure* function definitions are fully deleted", () => {
  const ENSURE_FUNCTIONS: Array<{ file: string; fnName: string }> = [
    { file: "monitoring.ts", fnName: "ensureMonitoringTables" },
    { file: "usage/schema.ts", fnName: "ensureUsageTables" },
    { file: "usage/schema.ts", fnName: "ensureMaterializedViews" },
    { file: "anomaly-detection/baselines.ts", fnName: "ensureAnomalyDetectionTables" },
    { file: "risk/classification.ts", fnName: "ensureSessionRiskTable" },
    { file: "exports/schedules.ts", fnName: "ensureExportSchedulesTables" },
  ];

  for (const { file, fnName } of ENSURE_FUNCTIONS) {
    it(`${file} does not define ${fnName} (even as a private function)`, () => {
      const source = readSrc(file);
      // Match any function definition, exported or not
      expect(source).not.toMatch(
        new RegExp(`(async\\s+)?function\\s+${fnName}\\s*\\(`)
      );
    });
  }
});

// =========================================================================
// 5. Initialization guard variables are removed
// =========================================================================

describe("M3.5 — initialization guard variables are removed", () => {
  it("monitoring.ts does not have monitoringTablesInitialized flag", () => {
    const source = readSrc("monitoring.ts");
    expect(source).not.toContain("monitoringTablesInitialized");
  });

  it("usage/schema.ts does not have usageTablesInitialized flag", () => {
    const source = readSrc("usage/schema.ts");
    expect(source).not.toContain("usageTablesInitialized");
  });

  it("usage/schema.ts does not have mvInitialized flag", () => {
    const source = readSrc("usage/schema.ts");
    expect(source).not.toContain("mvInitialized");
  });

  it("risk/classification.ts does not have sessionRiskTableInitialized flag", () => {
    const source = readSrc("risk/classification.ts");
    expect(source).not.toContain("sessionRiskTableInitialized");
  });
});

// =========================================================================
// 6. Internal callers no longer call ensure* before queries
// =========================================================================

describe("M3.6 — handler functions do not call ensure* internally", () => {
  it("monitoring.ts handleAlertConfigure does not call ensureMonitoringTables", () => {
    const source = readSrc("monitoring.ts");
    // Remove the function definition itself (already checked above), focus on call sites
    // Look for ensureMonitoringTables() calls anywhere in the file
    const lines = codeLines(source);
    const callLines = lines.filter(
      (line) =>
        line.includes("ensureMonitoringTables") &&
        !line.includes("function ensureMonitoringTables")
    );
    expect(callLines).toHaveLength(0);
  });

  it("monitoring.ts handleAlertEvaluate does not call ensureMonitoringTables", () => {
    const source = readSrc("monitoring.ts");
    // Count all references to ensureMonitoringTables (excluding comments)
    const refs = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .filter((l) => l.includes("ensureMonitoringTables"));
    expect(refs).toHaveLength(0);
  });

  it("exports/schedules.ts handlers do not call ensureExportSchedulesTables", () => {
    const source = readSrc("exports/schedules.ts");
    // All references should be gone — no definition, no calls
    const refs = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .filter((l) => l.includes("ensureExportSchedulesTables"));
    expect(refs).toHaveLength(0);
  });
});

// =========================================================================
// 7. No CREATE TABLE statements remain in runtime source files
// =========================================================================

describe("M3.7 — no CREATE TABLE/VIEW DDL in runtime source files", () => {
  const RUNTIME_FILES = [
    "monitoring.ts",
    "usage/schema.ts",
    "anomaly-detection/baselines.ts",
    "risk/classification.ts",
    "exports/schedules.ts",
  ];

  for (const file of RUNTIME_FILES) {
    it(`${file} contains no CREATE TABLE statements`, () => {
      const source = readSrc(file);
      expect(source.toUpperCase()).not.toContain("CREATE TABLE");
    });

    it(`${file} contains no CREATE MATERIALIZED VIEW statements`, () => {
      const source = readSrc(file);
      expect(source.toUpperCase()).not.toContain("CREATE MATERIALIZED VIEW");
    });

    it(`${file} contains no ALTER TABLE ADD COLUMN statements`, () => {
      const source = readSrc(file);
      expect(source.toUpperCase()).not.toContain("ALTER TABLE");
    });
  }
});

// =========================================================================
// 8. usage/schema.ts resetUsageTablesInit is removed
// =========================================================================

describe("M3.8 — test-only reset helpers are removed", () => {
  it("usage/schema.ts does not export resetUsageTablesInit", () => {
    const source = readSrc("usage/schema.ts");
    expect(source).not.toMatch(
      /export\s+function\s+resetUsageTablesInit/
    );
  });

  it("usage/schema.ts does not define resetUsageTablesInit at all", () => {
    const source = readSrc("usage/schema.ts");
    expect(source).not.toContain("resetUsageTablesInit");
  });
});

// =========================================================================
// 9. Core business functions still exist (ensure deletion was surgical)
// =========================================================================

describe("M3.9 — business logic functions survive the deletion", () => {
  it("monitoring.ts still exports handleCompleteness", () => {
    const source = readSrc("monitoring.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleCompleteness/
    );
  });

  it("monitoring.ts still exports handleAvailability", () => {
    const source = readSrc("monitoring.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleAvailability/
    );
  });

  it("monitoring.ts still exports handleAlertConfigure", () => {
    const source = readSrc("monitoring.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleAlertConfigure/
    );
  });

  it("monitoring.ts still exports handleAlertEvaluate", () => {
    const source = readSrc("monitoring.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleAlertEvaluate/
    );
  });

  it("anomaly-detection/baselines.ts still exports handleComputeBaselines", () => {
    const source = readSrc("anomaly-detection/baselines.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleComputeBaselines/
    );
  });

  it("anomaly-detection/baselines.ts still exports handleGetBaselines", () => {
    const source = readSrc("anomaly-detection/baselines.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleGetBaselines/
    );
  });

  it("risk/classification.ts still exports classifyRiskLevel", () => {
    const source = readSrc("risk/classification.ts");
    expect(source).toMatch(
      /export\s+function\s+classifyRiskLevel/
    );
  });

  it("risk/classification.ts still exports handleClassifyRisk", () => {
    const source = readSrc("risk/classification.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleClassifyRisk/
    );
  });

  it("risk/classification.ts still exports handleRiskProfile", () => {
    const source = readSrc("risk/classification.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleRiskProfile/
    );
  });

  it("exports/schedules.ts still exports handleCreateSchedule", () => {
    const source = readSrc("exports/schedules.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleCreateSchedule/
    );
  });

  it("exports/schedules.ts still exports handleListSchedules", () => {
    const source = readSrc("exports/schedules.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleListSchedules/
    );
  });

  it("exports/schedules.ts still exports handleDeleteSchedule", () => {
    const source = readSrc("exports/schedules.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleDeleteSchedule/
    );
  });

  it("exports/schedules.ts still exports handleEvaluateSchedules", () => {
    const source = readSrc("exports/schedules.ts");
    expect(source).toMatch(
      /export\s+async\s+function\s+handleEvaluateSchedules/
    );
  });
});

// =========================================================================
// 10. index.ts still registers routes and starts server
// =========================================================================

describe("M3.10 — index.ts server startup is intact", () => {
  let indexSource: string;

  it("index.ts still imports and registers healthRoutes", () => {
    indexSource = readSrc("index.ts");
    expect(indexSource).toContain("healthRoutes");
    expect(indexSource).toContain("app.register(healthRoutes)");
  });

  it("index.ts still imports and registers graphqlRoutes", () => {
    if (!indexSource) indexSource = readSrc("index.ts");
    expect(indexSource).toContain("graphqlRoutes");
    expect(indexSource).toContain("app.register(graphqlRoutes)");
  });

  it("index.ts still calls app.listen", () => {
    if (!indexSource) indexSource = readSrc("index.ts");
    expect(indexSource).toContain("app.listen");
  });

  it("index.ts still has graceful shutdown handlers", () => {
    if (!indexSource) indexSource = readSrc("index.ts");
    expect(indexSource).toContain("SIGTERM");
    expect(indexSource).toContain("SIGINT");
  });

  it("index.ts still imports closePool for shutdown", () => {
    if (!indexSource) indexSource = readSrc("index.ts");
    expect(indexSource).toContain("closePool");
  });
});
