/**
 * Sprint M4 — Update dev workflow + documentation: behavioral tests.
 *
 * After M4, `api/migrations/*.sql` is the single source of truth for the
 * PostgreSQL schema. The developer workflow and docs must reflect this:
 *
 *   1. CLAUDE.md — startup sequence includes `just api-migrate`
 *   2. justfile  — adds `dev-setup`, `api-migrate-create`, `api-migrate-down`
 *   3. docker-compose.fullstack.yml — migrations run before gateway/api start
 *   4. Dockerfile.api — migration files are explicitly copied into the image
 *   5. docs/MIGRATIONS.md — migration documentation file exists with required content
 *
 * These tests are written BEFORE the implementation exists.
 * They FAIL against the current codebase and PASS after M4 is done.
 *
 * No database or HTTP server required — these are pure file-content checks.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "../..");

function readRepo(relativePath: string): string {
  const fullPath = resolve(REPO_ROOT, relativePath);
  return readFileSync(fullPath, "utf-8");
}

function repoExists(relativePath: string): boolean {
  return existsSync(resolve(REPO_ROOT, relativePath));
}

// =========================================================================
// 1. CLAUDE.md — startup sequence updated
// =========================================================================

describe("M4.1 — CLAUDE.md startup sequence includes api-migrate", () => {
  let claudeMd: string;

  it("CLAUDE.md is readable", () => {
    claudeMd = readRepo("CLAUDE.md");
    expect(claudeMd.length).toBeGreaterThan(0);
  });

  it("CLAUDE.md mentions 'just api-migrate' as a command", () => {
    if (!claudeMd) claudeMd = readRepo("CLAUDE.md");
    expect(claudeMd).toContain("just api-migrate");
  });

  it("CLAUDE.md startup sequence contains just dev-infra before just api-migrate", () => {
    if (!claudeMd) claudeMd = readRepo("CLAUDE.md");
    const devInfraPos = claudeMd.indexOf("just dev-infra");
    const apiMigratePos = claudeMd.indexOf("just api-migrate");
    expect(devInfraPos).toBeGreaterThanOrEqual(0);
    expect(apiMigratePos).toBeGreaterThanOrEqual(0);
    // dev-infra must appear before api-migrate in the startup sequence
    expect(devInfraPos).toBeLessThan(apiMigratePos);
  });

  it("CLAUDE.md startup sequence contains just dev-run-local after just api-migrate", () => {
    if (!claudeMd) claudeMd = readRepo("CLAUDE.md");
    const apiMigratePos = claudeMd.indexOf("just api-migrate");
    const devRunLocalPos = claudeMd.indexOf("just dev-run-local");
    expect(apiMigratePos).toBeGreaterThanOrEqual(0);
    expect(devRunLocalPos).toBeGreaterThanOrEqual(0);
    // api-migrate must appear before dev-run-local in the startup sequence
    expect(apiMigratePos).toBeLessThan(devRunLocalPos);
  });

  it("CLAUDE.md startup sequence contains just api-dev", () => {
    if (!claudeMd) claudeMd = readRepo("CLAUDE.md");
    expect(claudeMd).toContain("just api-dev");
  });

  it("CLAUDE.md describes api-migrate as single source of truth for schema", () => {
    if (!claudeMd) claudeMd = readRepo("CLAUDE.md");
    // Must contain either the phrase 'single source of truth' or 'migrations' near api-migrate
    const hasSSOT = claudeMd.includes("single source of truth");
    const hasMigrationsDescription =
      claudeMd.toLowerCase().includes("run all migrations") ||
      claudeMd.toLowerCase().includes("applies all migrations") ||
      claudeMd.toLowerCase().includes("migration");
    expect(hasSSOT || hasMigrationsDescription).toBe(true);
  });

  it("CLAUDE.md startup sequence shows all five steps in order", () => {
    if (!claudeMd) claudeMd = readRepo("CLAUDE.md");
    const steps = [
      "just dev-infra",
      "just api-migrate",
      "just dev-run-local",
      "just api-dev",
      "just dashboard-dev",
    ];
    let lastPos = -1;
    for (const step of steps) {
      const pos = claudeMd.indexOf(step, lastPos + 1);
      expect(pos).toBeGreaterThan(lastPos);
      lastPos = pos;
    }
  });

  // NEGATIVE: old startup sequence (without api-migrate) must not be presented
  // as the canonical dev workflow. The old table omitting api-migrate should not
  // appear without a corresponding update.
  it("CLAUDE.md does not show dev-run-local as the step immediately after dev-infra in startup sequence (api-migrate must be in between)", () => {
    if (!claudeMd) claudeMd = readRepo("CLAUDE.md");
    // Find the startup sequence block — it should have api-migrate between dev-infra and dev-run-local
    const lines = claudeMd.split("\n");
    // Find lines that contain dev-infra and dev-run-local inside a code block / sequence list
    // and verify api-migrate appears between them
    const sequenceBlock = lines
      .map((l, i) => ({ line: l, idx: i }))
      .filter(
        ({ line }) =>
          line.includes("just dev-infra") ||
          line.includes("just api-migrate") ||
          line.includes("just dev-run-local")
      );

    const devInfraEntry = sequenceBlock.find((e) =>
      e.line.includes("just dev-infra")
    );
    const apiMigrateEntry = sequenceBlock.find((e) =>
      e.line.includes("just api-migrate")
    );
    const devRunLocalEntry = sequenceBlock.find((e) =>
      e.line.includes("just dev-run-local")
    );

    expect(devInfraEntry).toBeDefined();
    expect(apiMigrateEntry).toBeDefined();
    expect(devRunLocalEntry).toBeDefined();

    // api-migrate line must be strictly between dev-infra and dev-run-local
    expect(apiMigrateEntry!.idx).toBeGreaterThan(devInfraEntry!.idx);
    expect(apiMigrateEntry!.idx).toBeLessThan(devRunLocalEntry!.idx);
  });
});

// =========================================================================
// 2. justfile — new just targets
// =========================================================================

describe("M4.2 — justfile has dev-setup recipe", () => {
  let justfile: string;

  it("justfile is readable", () => {
    justfile = readRepo("justfile");
    expect(justfile.length).toBeGreaterThan(0);
  });

  it("justfile defines a dev-setup recipe", () => {
    if (!justfile) justfile = readRepo("justfile");
    expect(justfile).toMatch(/^dev-setup\s*:/m);
  });

  it("dev-setup recipe invokes dev-infra", () => {
    if (!justfile) justfile = readRepo("justfile");
    // Extract the dev-setup recipe body
    const match = justfile.match(/^dev-setup\s*:.*\n((?:[ \t]+.*\n?)*)/m);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toContain("dev-infra");
  });

  it("dev-setup recipe invokes api-migrate", () => {
    if (!justfile) justfile = readRepo("justfile");
    const match = justfile.match(/^dev-setup\s*:.*\n((?:[ \t]+.*\n?)*)/m);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toContain("api-migrate");
  });

  it("justfile default help block lists dev-setup", () => {
    if (!justfile) justfile = readRepo("justfile");
    expect(justfile).toContain("dev-setup");
  });
});

describe("M4.3 — justfile has api-migrate-create recipe", () => {
  let justfile: string;

  it("justfile defines an api-migrate-create recipe", () => {
    justfile = readRepo("justfile");
    expect(justfile).toMatch(/^api-migrate-create\s*/m);
  });

  it("api-migrate-create recipe accepts a name argument", () => {
    if (!justfile) justfile = readRepo("justfile");
    // Recipe must accept a parameter (just syntax: recipe name *args or name arg)
    expect(justfile).toMatch(/^api-migrate-create\s+\S+/m);
  });

  it("api-migrate-create recipe invokes node-pg-migrate create or npm run migrate create", () => {
    if (!justfile) justfile = readRepo("justfile");
    const match = justfile.match(
      /^api-migrate-create\s+.*\n((?:[ \t]+.*\n?)*)/m
    );
    expect(match).not.toBeNull();
    const body = match![0];
    // Must call some form of migration creation
    const hasMigrateCreate =
      body.includes("migrate create") ||
      body.includes("node-pg-migrate create") ||
      body.includes("migrate-create");
    expect(hasMigrateCreate).toBe(true);
  });
});

describe("M4.4 — justfile has api-migrate-down recipe", () => {
  let justfile: string;

  it("justfile defines an api-migrate-down recipe", () => {
    justfile = readRepo("justfile");
    expect(justfile).toMatch(/^api-migrate-down\s*:/m);
  });

  it("api-migrate-down recipe invokes node-pg-migrate down or npm run migrate down", () => {
    if (!justfile) justfile = readRepo("justfile");
    const match = justfile.match(/^api-migrate-down\s*:.*\n((?:[ \t]+.*\n?)*)/m);
    expect(match).not.toBeNull();
    const body = match![0];
    const hasMigrateDown =
      body.includes("migrate down") ||
      body.includes("node-pg-migrate down") ||
      body.includes("npm run migrate") && body.includes("down");
    expect(hasMigrateDown).toBe(true);
  });

  it("api-migrate-down uses the dev DATABASE_URL", () => {
    if (!justfile) justfile = readRepo("justfile");
    const match = justfile.match(/^api-migrate-down\s*:.*\n((?:[ \t]+.*\n?)*)/m);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toContain("DATABASE_URL");
  });

  // NEGATIVE: ensure api-migrate (up) still exists and was not replaced by api-migrate-down
  it("api-migrate (up) recipe still exists alongside api-migrate-down", () => {
    if (!justfile) justfile = readRepo("justfile");
    expect(justfile).toMatch(/^api-migrate\s*:/m);
    expect(justfile).toMatch(/^api-migrate-down\s*:/m);
  });
});

describe("M4.5 — justfile help text lists all new migration recipes", () => {
  let justfile: string;

  it("justfile help block mentions api-migrate-create", () => {
    justfile = readRepo("justfile");
    expect(justfile).toContain("api-migrate-create");
  });

  it("justfile help block mentions api-migrate-down", () => {
    if (!justfile) justfile = readRepo("justfile");
    expect(justfile).toContain("api-migrate-down");
  });

  it("justfile help block mentions dev-setup", () => {
    if (!justfile) justfile = readRepo("justfile");
    // dev-setup must appear in the @echo help section
    const helpSection = justfile.split("# Dev environment setup")[0];
    expect(helpSection).toContain("dev-setup");
  });
});

// =========================================================================
// 3. docker-compose.fullstack.yml — migration init service
// =========================================================================

describe("M4.6 — docker-compose.fullstack.yml runs migrations before gateway/api", () => {
  let compose: string;

  it("docker-compose.fullstack.yml is readable", () => {
    compose = readRepo("docker-compose.fullstack.yml");
    expect(compose.length).toBeGreaterThan(0);
  });

  it("compose file defines a migrations service or init container", () => {
    if (!compose) compose = readRepo("docker-compose.fullstack.yml");
    // The migrations service can be named 'migrations', 'migrate', 'db-migrate', or similar
    const hasMigrationsService =
      compose.includes("migrations:") ||
      compose.includes("migrate:") ||
      compose.includes("db-migrate:");
    expect(hasMigrationsService).toBe(true);
  });

  it("migrations service depends on postgres being healthy", () => {
    if (!compose) compose = readRepo("docker-compose.fullstack.yml");
    // Find the migrations service block and verify it waits for postgres
    // The depends_on with service_healthy condition must be present
    const migrationsBlock = extractServiceBlock(compose, /migrations:|migrate:|db-migrate:/);
    expect(migrationsBlock).not.toBeNull();
    expect(migrationsBlock).toContain("postgres");
    expect(migrationsBlock).toContain("service_healthy");
  });

  it("migrations service runs node-pg-migrate or npm run migrate", () => {
    if (!compose) compose = readRepo("docker-compose.fullstack.yml");
    const migrationsBlock = extractServiceBlock(compose, /migrations:|migrate:|db-migrate:/);
    expect(migrationsBlock).not.toBeNull();
    const hasMigrateCommand =
      migrationsBlock!.includes("node-pg-migrate") ||
      migrationsBlock!.includes("npm run migrate") ||
      migrationsBlock!.includes("migrate up");
    expect(hasMigrateCommand).toBe(true);
  });

  it("api service depends on migrations completing successfully", () => {
    if (!compose) compose = readRepo("docker-compose.fullstack.yml");
    const apiBlock = extractServiceBlock(compose, /^  api:$/m);
    expect(apiBlock).not.toBeNull();
    // api must depend on the migrations service
    const hasMigrationsDep =
      apiBlock!.includes("migrations") ||
      apiBlock!.includes("migrate");
    expect(hasMigrationsDep).toBe(true);
  });

  it("gateway service depends on migrations completing successfully", () => {
    if (!compose) compose = readRepo("docker-compose.fullstack.yml");
    const gatewayBlock = extractServiceBlock(compose, /^  gateway:$/m);
    expect(gatewayBlock).not.toBeNull();
    const hasMigrationsDep =
      gatewayBlock!.includes("migrations") ||
      gatewayBlock!.includes("migrate");
    expect(hasMigrationsDep).toBe(true);
  });

  // NEGATIVE: postgres init SQL must not create application tables
  // (those must come from migrations, not docker-entrypoint-initdb.d)
  it("postgres service init SQL is not creating application tables (gateway init SQL only)", () => {
    if (!compose) compose = readRepo("docker-compose.fullstack.yml");
    // The postgres entrypoint init SQL must reference the gateway-only schema, not api tables.
    // Specifically, if the init SQL file is init-gateway-postgres.sql, it should only have
    // gateway tables. We just assert that no application migration SQL is mounted as init:
    const lines = compose.split("\n");
    const initLines = lines.filter(
      (l) =>
        l.includes("docker-entrypoint-initdb.d") &&
        l.includes(".sql") &&
        !l.includes("gateway") // gateway-only init is acceptable; api migrations must not be there
    );
    // All init SQL mounts should be gateway-specific (filename must contain 'gateway' or 'init')
    for (const line of initLines) {
      expect(line).toMatch(/gateway|init/i);
    }
  });
});

// =========================================================================
// 4. Dockerfile.api — migration files copied into image
// =========================================================================

describe("M4.7 — Dockerfile.api explicitly copies migration files", () => {
  let dockerfile: string;

  it("Dockerfile.api is readable", () => {
    dockerfile = readRepo("Dockerfile.api");
    expect(dockerfile.length).toBeGreaterThan(0);
  });

  it("Dockerfile.api has an explicit COPY instruction for migrations directory", () => {
    if (!dockerfile) dockerfile = readRepo("Dockerfile.api");
    // Must have a COPY that includes migrations/ explicitly, not just relying on COPY api/ ./
    // The sprint requires making migrations an explicit, named copy step
    const hasMigrationsCopy =
      dockerfile.includes("migrations") &&
      dockerfile.includes("COPY");
    expect(hasMigrationsCopy).toBe(true);
  });

  it("Dockerfile.api copies migrations/ as a distinct named COPY step", () => {
    if (!dockerfile) dockerfile = readRepo("Dockerfile.api");
    // There must be a COPY line that references migrations explicitly
    const copyLines = dockerfile
      .split("\n")
      .filter((l) => l.trim().startsWith("COPY") && l.includes("migrations"));
    expect(copyLines.length).toBeGreaterThanOrEqual(1);
  });

  it("Dockerfile.api migration COPY step copies from api/migrations or migrations", () => {
    if (!dockerfile) dockerfile = readRepo("Dockerfile.api");
    const copyLines = dockerfile
      .split("\n")
      .filter((l) => l.trim().startsWith("COPY") && l.includes("migrations"));
    // At least one COPY line must reference the migrations source path
    const validCopy = copyLines.some(
      (l) => l.includes("api/migrations") || l.includes("./migrations") || l.includes("migrations/")
    );
    expect(validCopy).toBe(true);
  });

  // NEGATIVE: the CMD must not silently skip migrations — it must either:
  // (a) run migrations before starting the server in an entrypoint/CMD, or
  // (b) be a plain app server CMD (migrations run by the separate init service in compose)
  // The key check is that migration files ARE present in the image (verified above).
  // We also verify the image doesn't try to create tables via ensure*() (already covered by M3).
  it("Dockerfile.api CMD or ENTRYPOINT does not reference ensure functions", () => {
    if (!dockerfile) dockerfile = readRepo("Dockerfile.api");
    expect(dockerfile).not.toContain("ensure");
  });
});

// =========================================================================
// 5. docs/MIGRATIONS.md — migration documentation exists
// =========================================================================

describe("M4.8 — docs/MIGRATIONS.md exists", () => {
  it("docs/MIGRATIONS.md file exists", () => {
    expect(repoExists("docs/MIGRATIONS.md")).toBe(true);
  });
});

describe("M4.9 — docs/MIGRATIONS.md contains required sections", () => {
  let migrationDoc: string;

  it("docs/MIGRATIONS.md is readable with non-zero content", () => {
    migrationDoc = readRepo("docs/MIGRATIONS.md");
    expect(migrationDoc.length).toBeGreaterThan(200);
  });

  it("docs/MIGRATIONS.md explains how to create a new migration", () => {
    if (!migrationDoc) migrationDoc = readRepo("docs/MIGRATIONS.md");
    const hasCreateSection =
      migrationDoc.toLowerCase().includes("create") &&
      (migrationDoc.includes("api-migrate-create") ||
        migrationDoc.includes("node-pg-migrate create") ||
        migrationDoc.includes("npm run migrate create"));
    expect(hasCreateSection).toBe(true);
  });

  it("docs/MIGRATIONS.md documents the NNN_description.sql naming convention", () => {
    if (!migrationDoc) migrationDoc = readRepo("docs/MIGRATIONS.md");
    // Must reference the naming convention with numbers prefix
    const hasNamingConvention =
      migrationDoc.includes("NNN") ||
      migrationDoc.match(/\d{3}_/) !== null ||
      migrationDoc.toLowerCase().includes("naming convention");
    expect(hasNamingConvention).toBe(true);
  });

  it("docs/MIGRATIONS.md explains how to test a migration locally", () => {
    if (!migrationDoc) migrationDoc = readRepo("docs/MIGRATIONS.md");
    const hasLocalTestingSection =
      migrationDoc.toLowerCase().includes("local") &&
      (migrationDoc.toLowerCase().includes("test") ||
        migrationDoc.toLowerCase().includes("verify"));
    expect(hasLocalTestingSection).toBe(true);
  });

  it("docs/MIGRATIONS.md warns that applied migrations must not be edited", () => {
    if (!migrationDoc) migrationDoc = readRepo("docs/MIGRATIONS.md");
    // Must contain a warning about not editing applied migrations
    const hasWarning =
      migrationDoc.toLowerCase().includes("never edit") ||
      migrationDoc.toLowerCase().includes("do not edit") ||
      migrationDoc.toLowerCase().includes("never modify") ||
      migrationDoc.toLowerCase().includes("do not modify") ||
      (migrationDoc.toLowerCase().includes("warning") &&
        migrationDoc.toLowerCase().includes("applied"));
    expect(hasWarning).toBe(true);
  });

  it("docs/MIGRATIONS.md references just api-migrate command", () => {
    if (!migrationDoc) migrationDoc = readRepo("docs/MIGRATIONS.md");
    expect(migrationDoc).toContain("api-migrate");
  });

  it("docs/MIGRATIONS.md references api/migrations/ as the migrations directory", () => {
    if (!migrationDoc) migrationDoc = readRepo("docs/MIGRATIONS.md");
    const hasMigrationsDir =
      migrationDoc.includes("api/migrations") ||
      migrationDoc.includes("api/migrations/");
    expect(hasMigrationsDir).toBe(true);
  });

  it("docs/MIGRATIONS.md references just api-migrate-down for rollback", () => {
    if (!migrationDoc) migrationDoc = readRepo("docs/MIGRATIONS.md");
    expect(migrationDoc).toContain("api-migrate-down");
  });

  // NEGATIVE: the doc must not instruct developers to run DDL manually
  it("docs/MIGRATIONS.md does not instruct running psql DDL directly to create tables", () => {
    if (!migrationDoc) migrationDoc = readRepo("docs/MIGRATIONS.md");
    // Should not have instructions like "psql ... CREATE TABLE" as a workflow step
    const hasDdlInstruction =
      migrationDoc.includes("CREATE TABLE") &&
      migrationDoc.toLowerCase().includes("run this");
    expect(hasDdlInstruction).toBe(false);
  });
});

// =========================================================================
// 6. just fullstack — end-to-end integration check
// =========================================================================

describe("M4.10 — just fullstack invokes migrations end-to-end", () => {
  let justfile: string;

  it("fullstack recipe still exists in justfile", () => {
    justfile = readRepo("justfile");
    expect(justfile).toMatch(/^fullstack\s*:/m);
  });

  it("fullstack recipe uses docker-compose.fullstack.yml", () => {
    if (!justfile) justfile = readRepo("justfile");
    const match = justfile.match(/^fullstack\s*:.*\n((?:[ \t]+.*\n?)*)/m);
    expect(match).not.toBeNull();
    const body = match![0];
    expect(body).toContain("docker-compose.fullstack.yml");
  });

  it("docker-compose.fullstack.yml migrations service uses the recondo DATABASE_URL", () => {
    const compose = readRepo("docker-compose.fullstack.yml");
    // The migrations service must point at the postgres service, not localhost
    const migrationsBlock = extractServiceBlock(compose, /migrations:|migrate:|db-migrate:/);
    expect(migrationsBlock).not.toBeNull();
    // DB URL must reference postgres host (docker service name), not localhost
    const hasDockerDbUrl =
      migrationsBlock!.includes("postgres:5432") ||
      migrationsBlock!.includes("@postgres/") ||
      migrationsBlock!.includes("DATABASE_URL");
    expect(hasDockerDbUrl).toBe(true);
  });

  // Verify the migrations service is marked as a one-shot (restart: "no" or similar)
  // so it doesn't keep restarting after migrations succeed
  it("migrations service in compose does not restart indefinitely", () => {
    const compose = readRepo("docker-compose.fullstack.yml");
    const migrationsBlock = extractServiceBlock(compose, /migrations:|migrate:|db-migrate:/);
    expect(migrationsBlock).not.toBeNull();
    // restart: "no" or no restart policy (default is no), or service_completed_successfully
    const safeRestart =
      migrationsBlock!.includes('restart: "no"') ||
      migrationsBlock!.includes("restart: 'no'") ||
      migrationsBlock!.includes("restart: no") ||
      migrationsBlock!.includes("service_completed_successfully") ||
      !migrationsBlock!.includes("restart: always");
    expect(safeRestart).toBe(true);
  });
});

// =========================================================================
// 7. Migration files exist and follow naming convention
// =========================================================================

describe("M4.11 — api/migrations/ directory contains migration files with correct naming", () => {
  it("api/migrations/ directory exists", () => {
    expect(repoExists("api/migrations")).toBe(true);
  });

  it("api/migrations/001_core-tables.sql exists (baseline migration)", () => {
    expect(repoExists("api/migrations/001_core-tables.sql")).toBe(true);
  });

  it("migration filenames follow NNN_description.sql convention", () => {
    // Read migration filenames — they should all match /^\d{3}_[\w-]+\.sql$/
    const { readdirSync } = require("node:fs");
    const migrationsDir = resolve(REPO_ROOT, "api/migrations");
    const files = readdirSync(migrationsDir) as string[];
    const sqlFiles = files.filter((f: string) => f.endsWith(".sql"));
    expect(sqlFiles.length).toBeGreaterThan(0);
    for (const file of sqlFiles) {
      expect(file).toMatch(/^\d{3}_[\w-]+\.sql$/);
    }
  });

  it("migration files are numbered sequentially without gaps", () => {
    const { readdirSync } = require("node:fs");
    const migrationsDir = resolve(REPO_ROOT, "api/migrations");
    const files = (readdirSync(migrationsDir) as string[])
      .filter((f: string) => f.endsWith(".sql"))
      .sort();
    const numbers = files.map((f: string) => parseInt(f.slice(0, 3), 10));
    for (let i = 0; i < numbers.length; i++) {
      expect(numbers[i]).toBe(i + 1);
    }
  });
});

// =========================================================================
// Helper: extract a YAML service block from docker-compose content
// =========================================================================

/**
 * Given compose file content and a regex matching the start of a service
 * definition, returns the text of that service block (until the next
 * top-level service or end of services section).
 */
function extractServiceBlock(
  composeContent: string,
  servicePattern: RegExp
): string | null {
  const lines = composeContent.split("\n");
  let startIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (servicePattern.test(lines[i])) {
      startIdx = i;
      break;
    }
  }

  if (startIdx === -1) return null;

  // Collect lines until we hit another top-level service (2-space indent key)
  // or a top-level key (volumes:, networks:, etc.)
  const blockLines: string[] = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // A new top-level service starts at 2-space indent followed by non-space + colon
    if (/^  \w[\w-]*:/.test(line) && !line.startsWith("   ")) {
      break;
    }
    // A top-level YAML key (volumes:, networks:, etc.)
    if (/^\w[\w-]*:/.test(line)) {
      break;
    }
    blockLines.push(line);
  }

  return blockLines.join("\n");
}
