# `recondo-data` Package Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoist the data-access layer out of `api/src/` into a shared `packages/recondo-data` workspace package that the API and (in Plan D) the MCP service both depend on as equals — neither service is the parent of the other. Lands streaming-prep contracts (`AsyncIterable`, `AbortSignal`, uniform envelope, `since` cursors) during the same refactor since retrofit cost is high.

**Architecture:** Pure refactor with zero new behavior. The package owns: DB pool factory, per-operation query functions, object-store access, redaction-layer foundations, `ApiKeyInfo` type, `authenticateApiKey(token)`. The package owns nothing transport-shaped (no HTTP, no GraphQL, no MCP). API resolvers become thin transport adapters that materialize the package's `AsyncIterable` returns into arrays via `Array.fromAsync`.

**Tech Stack:** TypeScript, pnpm workspaces (or npm workspaces), `tsx`/`tsc`, existing `pg` driver, existing test stack.

---

## File Structure

### Before

```
recondo/
├── api/
│   ├── package.json                          (name: "recondo-api")
│   ├── tsconfig.json
│   ├── src/
│   │   ├── auth.ts                           ← authenticateRequest
│   │   ├── context.ts                        ← ApiKeyInfo type
│   │   ├── db.ts                             ← getPool, closePool, checkDatabaseHealth
│   │   ├── placeholder-mask.ts               ← maskPlaceholderPaths, sanitizers
│   │   ├── query/
│   │   │   └── builder.ts                    ← runQuery({queryType,...}) switch dispatch
│   │   ├── resolvers/
│   │   │   ├── sessions.ts                   ← inline pool.query(...)
│   │   │   ├── turns.ts                      ← inline pool.query(...)
│   │   │   ├── anomalies.ts                  ← inline pool.query(...)
│   │   │   ├── cost.ts                       ← inline pool.query(...)
│   │   │   ├── audit.ts                      ← inline pool.query(...)
│   │   │   ├── compliance.ts                 ← inline pool.query(...)
│   │   │   ├── realtime.ts                   ← inline pool.query(...)
│   │   │   ├── agents.ts                     ← inline pool.query(...)
│   │   │   ├── reports.ts                    ← inline pool.query(...)
│   │   │   ├── policies.ts                   ← inline pool.query(...)
│   │   │   ├── keys.ts                       ← inline pool.query(...)
│   │   │   ├── mappers.ts
│   │   │   ├── scalars.ts
│   │   │   └── index.ts
│   │   └── ...
│   └── tests/
└── shared/
    └── placeholder-prefixes.json
```

### After

```
recondo/
├── pnpm-workspace.yaml                       NEW: workspace config
├── package.json                              NEW: root manifest with version-lockstep script
├── packages/
│   └── recondo-data/                         NEW
│       ├── package.json                      name: "@recondo/data", version pinned
│       ├── tsconfig.json
│       ├── src/
│       │   ├── index.ts                      barrel: re-exports public API
│       │   ├── pool.ts                       ← moved from api/src/db.ts
│       │   ├── auth.ts                       ← moved from api/src/auth.ts (authenticateApiKey)
│       │   ├── types.ts                      ← ApiKeyInfo, list-envelope types, cursor types
│       │   ├── envelope.ts                   ← uniformListEnvelope helper, since-cursor codec
│       │   ├── async-iter.ts                 ← AsyncIterable helpers (rowsToAsyncIterable)
│       │   ├── redaction/
│       │   │   ├── index.ts                  ← re-exports
│       │   │   └── placeholder-mask.ts       ← moved from api/src/placeholder-mask.ts
│       │   ├── mappers.ts                    ← moved from api/src/resolvers/mappers.ts
│       │   ├── sessions.ts                   listSessions, getSession, listUserTurns, ...
│       │   ├── turns.ts                      getTurn, searchTurns, listTurnsBySession
│       │   ├── anomalies.ts                  listAnomalies
│       │   ├── cost.ts                       getUsageSummary, spendByProvider, ...
│       │   ├── audit.ts                      listAuditEvents, ...
│       │   ├── compliance.ts                 listComplianceFindings, ...
│       │   ├── realtime.ts                   getRealtimeStats, listRealtimeFeed, ...
│       │   ├── agents.ts                     listAgentActivity, ...
│       │   ├── reports.ts                    listReports, getReport, ...
│       │   ├── policies.ts                   listPolicies, getPolicy, ...
│       │   ├── keys.ts                       listApiKeys, ...
│       │   └── structured-query.ts           ← moved from api/src/query/builder.ts
│       │                                       (per-operation exports + runStructuredQuery dispatcher)
│       └── tests/
│           ├── envelope.test.ts
│           ├── async-iter.test.ts
│           ├── since-cursor.test.ts
│           ├── auth.test.ts                  (moved from api/tests/auth.test.ts)
│           └── placeholder-mask.test.ts      (moved from api/tests/placeholder-mask.test.ts)
├── api/
│   ├── package.json                          (depends on "@recondo/data": "workspace:*")
│   ├── src/
│   │   ├── db.ts                             SHIM: re-exports from @recondo/data
│   │   ├── auth.ts                           SHIM: re-exports from @recondo/data
│   │   ├── context.ts                        re-imports ApiKeyInfo from @recondo/data
│   │   ├── placeholder-mask.ts               SHIM: re-exports from @recondo/data
│   │   ├── query/
│   │   │   └── builder.ts                    THIN HTTP/format adapter — calls @recondo/data
│   │   ├── resolvers/
│   │   │   ├── sessions.ts                   THIN: calls @recondo/data, Array.fromAsync
│   │   │   ├── turns.ts                      THIN: calls @recondo/data, Array.fromAsync
│   │   │   └── ... (each resolver thinned)
│   │   └── ...
│   └── tests/                                (unchanged, must keep passing)
└── shared/
    └── placeholder-prefixes.json
```

The package is published as `@recondo/data` in the workspace; the `workspace:*` protocol pins the API to whatever is in-tree. A root-level `package.json` `scripts.version-check` enforces lockstep (Risk #2): the API and the package must declare the same major.minor.

---

## Tasks

### Task 1: Set up pnpm workspace at the repo root

**Files:**
- `package.json` (NEW)
- `pnpm-workspace.yaml` (NEW)
- `.gitignore` (edit)

**Steps:**

- [ ] **1.1** Decide on package manager. Use pnpm — it has first-class workspace protocol (`workspace:*`) which solves Risk #2 (version-lockstep) more cleanly than npm workspaces. Verify pnpm is installed: `pnpm --version` (require >= 8). If absent, add an install instruction to the README later.

- [ ] **1.2** Create `pnpm-workspace.yaml` at the repo root:

  ```yaml
  packages:
    - "api"
    - "dashboard"
    - "packages/*"
  ```

- [ ] **1.3** Create root `package.json`:

  ```json
  {
    "name": "recondo-monorepo",
    "version": "0.0.0",
    "private": true,
    "license": "Apache-2.0",
    "scripts": {
      "build": "pnpm -r build",
      "test": "pnpm -r test",
      "version-check": "node scripts/version-check.mjs",
      "lint:archlock": "node scripts/lint-archlock.mjs"
    },
    "engines": {
      "node": ">=20.0.0",
      "pnpm": ">=8.0.0"
    }
  }
  ```

- [ ] **1.4** Add to `.gitignore`:

  ```
  # pnpm
  .pnpm-store/
  pnpm-debug.log*
  ```

- [ ] **1.5** Run `pnpm install` from the repo root and confirm it links existing `api/` and `dashboard/` correctly without altering their `node_modules` shape (use `--no-frozen-lockfile` on first run to generate `pnpm-lock.yaml`). Commit `pnpm-lock.yaml`.

**Commit message:** `chore: bootstrap pnpm workspace at repo root`

---

### Task 2: Create the empty `recondo-data` package skeleton

**Files:**
- `packages/recondo-data/package.json` (NEW)
- `packages/recondo-data/tsconfig.json` (NEW)
- `packages/recondo-data/src/index.ts` (NEW)
- `packages/recondo-data/vitest.config.ts` (NEW)

**Steps:**

- [ ] **2.1** Create `packages/recondo-data/package.json`:

  ```json
  {
    "name": "@recondo/data",
    "version": "0.0.1",
    "private": true,
    "license": "Apache-2.0",
    "type": "module",
    "description": "Shared data-access layer for Recondo (API + MCP)",
    "main": "dist/index.js",
    "types": "dist/index.d.ts",
    "exports": {
      ".": {
        "types": "./dist/index.d.ts",
        "default": "./dist/index.js"
      }
    },
    "scripts": {
      "build": "tsc",
      "test": "vitest run",
      "test:watch": "vitest"
    },
    "dependencies": {
      "pg": "^8.13.0"
    },
    "devDependencies": {
      "@types/node": "^22.0.0",
      "@types/pg": "^8.11.0",
      "typescript": "^5.7.0",
      "vitest": "^3.0.0"
    }
  }
  ```

- [ ] **2.2** Create `packages/recondo-data/tsconfig.json`:

  ```json
  {
    "compilerOptions": {
      "target": "ES2023",
      "module": "Node16",
      "moduleResolution": "node16",
      "esModuleInterop": true,
      "strict": true,
      "declaration": true,
      "skipLibCheck": true,
      "outDir": "dist",
      "rootDir": "src",
      "lib": ["ES2023", "ESNext.Array"]
    },
    "include": ["src/**/*.ts"],
    "exclude": ["node_modules", "dist", "tests"]
  }
  ```

  `ESNext.Array` is required for `Array.fromAsync` lib types (the API consumes it). `target: ES2023` is sufficient for `AsyncIterable`.

- [ ] **2.3** Create `packages/recondo-data/src/index.ts` as an empty barrel for now:

  ```ts
  // Public surface of @recondo/data — populated by subsequent tasks.
  export {};
  ```

- [ ] **2.4** Create `packages/recondo-data/vitest.config.ts`:

  ```ts
  import { defineConfig } from "vitest/config";

  export default defineConfig({
    test: {
      globals: true,
      include: ["tests/**/*.test.ts"],
    },
  });
  ```

- [ ] **2.5** Run `pnpm install` from the repo root, confirm `packages/recondo-data` shows up as a workspace package (`pnpm list -r --depth -1`), then `pnpm --filter @recondo/data build` succeeds with an empty `dist/index.js`.

**Commit message:** `chore(data): scaffold @recondo/data package`

---

### Task 3: Add version-lockstep enforcement script

**Files:**
- `scripts/version-check.mjs` (NEW)

**Steps:**

- [ ] **3.1** Per Risk #2, the API, MCP (Plan D), and `@recondo/data` must release together. Enforce via a script that compares major.minor across consumers.

- [ ] **3.2** Create `scripts/version-check.mjs`:

  ```js
  #!/usr/bin/env node
  // Risk #2: enforce that all workspace packages declaring a dep on
  // @recondo/data are pinned to the in-tree version. Fails CI on drift.
  import { readFileSync } from "node:fs";
  import { resolve } from "node:path";

  const root = resolve(import.meta.dirname, "..");
  const dataPkg = JSON.parse(
    readFileSync(resolve(root, "packages/recondo-data/package.json"), "utf8"),
  );
  const expected = dataPkg.version;

  const consumers = [
    "api/package.json",
    // "mcp/package.json",  // uncomment when Plan D lands
  ];

  let failed = false;
  for (const rel of consumers) {
    const pkg = JSON.parse(readFileSync(resolve(root, rel), "utf8"));
    const dep =
      pkg.dependencies?.["@recondo/data"] ??
      pkg.devDependencies?.["@recondo/data"];
    if (!dep) continue;
    if (dep !== "workspace:*" && dep !== `workspace:^${expected}` && dep !== expected) {
      console.error(
        `${rel}: @recondo/data declared as ${dep}, expected workspace:* or ${expected}`,
      );
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log(`version-check: all consumers pinned to @recondo/data ${expected}`);
  ```

- [ ] **3.3** Wire into `justfile` if a `just lint-arch` recipe exists; otherwise add a new top-level `just check-versions` recipe:

  ```
  check-versions:
      node scripts/version-check.mjs
  ```

- [ ] **3.4** Run `node scripts/version-check.mjs` (it should print a passing message — no consumers yet). Make the script executable: `chmod +x scripts/version-check.mjs`.

- [ ] **3.5** No test required; the script is a CI gate executed by humans/CI.

**Commit message:** `chore(data): add version-lockstep CI script`

---

### Task 4: Move `db.ts` into the package as `pool.ts` (TDD)

**Files:**
- `packages/recondo-data/src/pool.ts` (NEW — moved)
- `packages/recondo-data/tests/pool.test.ts` (NEW)
- `packages/recondo-data/src/index.ts` (edit)
- `api/src/db.ts` (edit — becomes a re-export shim)

**Steps:**

- [ ] **4.1** **RED.** Create `packages/recondo-data/tests/pool.test.ts` covering the three exported functions (`getPool`, `closePool`, `checkDatabaseHealth`). Reuse the test conventions from `api/tests/setup.ts` — point at `postgres://recondo:recondo_dev@localhost:5432/recondo_test`:

  ```ts
  import { describe, it, expect, afterAll } from "vitest";
  import { getPool, closePool, checkDatabaseHealth } from "../src/pool.js";

  afterAll(async () => {
    await closePool();
  });

  describe("@recondo/data: pool", () => {
    it("returns a singleton pool", () => {
      const a = getPool();
      const b = getPool();
      expect(a).toBe(b);
    });

    it("checkDatabaseHealth returns true against a live db", async () => {
      const ok = await checkDatabaseHealth();
      expect(ok).toBe(true);
    });
  });
  ```

  Run `pnpm --filter @recondo/data test` — fails (no `pool.ts` yet).

- [ ] **4.2** **GREEN.** Move `api/src/db.ts` to `packages/recondo-data/src/pool.ts`. The body is identical except for the application_name suffix env var name, which stays `RECONDO_API_APP_NAME_SUFFIX` for backward compatibility (do NOT rename — sibling test runners depend on it). Add the file verbatim.

- [ ] **4.3** Update `packages/recondo-data/src/index.ts`:

  ```ts
  export { getPool, closePool, checkDatabaseHealth } from "./pool.js";
  ```

  Run `pnpm --filter @recondo/data build` then `pnpm --filter @recondo/data test`. Should pass.

- [ ] **4.4** Add the dependency in `api/package.json`:

  ```json
  "dependencies": {
    "@apollo/server": "^4.11.0",
    "@recondo/data": "workspace:*",
    ...
  }
  ```

  Run `pnpm install`.

- [ ] **4.5** Replace the body of `api/src/db.ts` with a shim:

  ```ts
  // Compatibility shim — real implementation lives in @recondo/data.
  // Kept as a stable import path for code paths that haven't been
  // refactored to import from "@recondo/data" directly. New code should
  // import from "@recondo/data" directly; do NOT add new exports here.
  export { getPool, closePool, checkDatabaseHealth } from "@recondo/data";
  ```

  Run the API test suite: `cd api && pnpm test`. All tests must still pass (zero behavioral change). Commit.

**Commit message:** `refactor(data): move db pool factory into @recondo/data`

---

### Task 5: Establish `ApiKeyInfo` type and shared types module

**Files:**
- `packages/recondo-data/src/types.ts` (NEW)
- `packages/recondo-data/src/index.ts` (edit)
- `api/src/context.ts` (edit)

**Steps:**

- [ ] **5.1** Create `packages/recondo-data/src/types.ts`:

  ```ts
  /**
   * Information about the authenticated API key. Attached to every
   * data-layer call site so the package can apply project scoping.
   *
   * `projectId === null` means admin (cross-project access).
   */
  export interface ApiKeyInfo {
    id: string;
    projectId: string | null;
    rateLimitRpm: number;
  }

  /**
   * Uniform list-shape envelope. v1 always emits `is_final: true` and
   * `stream_id: null`; v1.5 streaming variants emit the same shape across
   * progress notifications. See spec § "Streaming preparation".
   */
  export interface ListEnvelope<T> {
    items: T[];
    next_offset: number | null;
    truncated: boolean;
    stream_id: string | null;
    is_final: true;
  }

  /**
   * Opaque cursor for time-ordered list functions. Encoded as
   * base64url(JSON({ts, id})). Consumers must NOT introspect the
   * shape — encode/decode helpers in envelope.ts are the only legal
   * entry points.
   */
  export type SinceCursor = string & { readonly __brand: "SinceCursor" };

  /**
   * Common options threaded through every read function. Per spec
   * § "Streaming preparation" commitment 4 — every async function
   * accepts an optional AbortSignal.
   */
  export interface QueryOptions {
    signal?: AbortSignal;
  }

  /**
   * Options for list-shape reads. `since` and `offset` are
   * mutually advisory: time-ordered lists prefer `since`; relevance-
   * ranked lists (search) use `offset` only.
   */
  export interface ListOptions extends QueryOptions {
    limit?: number;
    offset?: number;
    since?: SinceCursor;
  }
  ```

- [ ] **5.2** Re-export from `packages/recondo-data/src/index.ts`:

  ```ts
  export { getPool, closePool, checkDatabaseHealth } from "./pool.js";
  export type {
    ApiKeyInfo,
    ListEnvelope,
    SinceCursor,
    QueryOptions,
    ListOptions,
  } from "./types.js";
  ```

- [ ] **5.3** Update `api/src/context.ts` to re-export the canonical type:

  ```ts
  import type { Loaders } from "./loaders.js";
  import type { ApiKeyInfo } from "@recondo/data";

  export type { ApiKeyInfo };

  export interface GqlContext {
    apiKey: ApiKeyInfo;
    sourceIp: string;
    userAgent: string;
    loaders: Loaders;
  }
  ```

- [ ] **5.4** Run `cd api && pnpm exec tsc --noEmit`. Any consumer that imported `ApiKeyInfo` from `./context.js` continues to compile because we re-export the same name.

- [ ] **5.5** Run the full API test suite (`cd api && pnpm test`). Zero failures expected. Commit.

**Commit message:** `refactor(data): canonicalize ApiKeyInfo in @recondo/data`

---

### Task 6: Implement `since` cursor codec and uniform envelope helpers (TDD)

**Files:**
- `packages/recondo-data/src/envelope.ts` (NEW)
- `packages/recondo-data/tests/envelope.test.ts` (NEW)
- `packages/recondo-data/tests/since-cursor.test.ts` (NEW)

**Steps:**

- [ ] **6.1** **RED.** Create `packages/recondo-data/tests/since-cursor.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { encodeSinceCursor, decodeSinceCursor } from "../src/envelope.js";

  describe("since-cursor codec", () => {
    it("round-trips (timestamp, id)", () => {
      const enc = encodeSinceCursor({ ts: "2026-05-04T12:00:00.000Z", id: "abc-123" });
      const dec = decodeSinceCursor(enc);
      expect(dec).toEqual({ ts: "2026-05-04T12:00:00.000Z", id: "abc-123" });
    });

    it("rejects non-base64url input", () => {
      expect(() => decodeSinceCursor("not a cursor!" as never)).toThrow(/invalid since cursor/i);
    });

    it("rejects payloads missing ts or id", () => {
      const bad = Buffer.from(JSON.stringify({ ts: "x" })).toString("base64url");
      expect(() => decodeSinceCursor(bad as never)).toThrow();
    });
  });
  ```

  Create `packages/recondo-data/tests/envelope.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { uniformListEnvelope } from "../src/envelope.js";

  describe("uniformListEnvelope", () => {
    it("emits is_final=true and stream_id=null in v1", () => {
      const env = uniformListEnvelope([1, 2, 3], { nextOffset: 3, truncated: false });
      expect(env).toEqual({
        items: [1, 2, 3],
        next_offset: 3,
        truncated: false,
        stream_id: null,
        is_final: true,
      });
    });

    it("flags truncation", () => {
      const env = uniformListEnvelope(["x"], { nextOffset: 1, truncated: true });
      expect(env.truncated).toBe(true);
    });
  });
  ```

  Run `pnpm --filter @recondo/data test`. Both fail.

- [ ] **6.2** **GREEN.** Create `packages/recondo-data/src/envelope.ts`:

  ```ts
  import type { ListEnvelope, SinceCursor } from "./types.js";

  export interface SinceCursorPayload {
    ts: string; // ISO 8601 UTC, Z suffix
    id: string;
  }

  export function encodeSinceCursor(payload: SinceCursorPayload): SinceCursor {
    if (!payload.ts || !payload.id) {
      throw new Error("encodeSinceCursor: ts and id required");
    }
    const json = JSON.stringify({ ts: payload.ts, id: payload.id });
    return Buffer.from(json, "utf8").toString("base64url") as SinceCursor;
  }

  export function decodeSinceCursor(cursor: SinceCursor): SinceCursorPayload {
    let json: string;
    try {
      json = Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
      throw new Error("invalid since cursor: not base64url");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new Error("invalid since cursor: not JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { ts?: unknown }).ts !== "string" ||
      typeof (parsed as { id?: unknown }).id !== "string"
    ) {
      throw new Error("invalid since cursor: missing ts or id");
    }
    return parsed as SinceCursorPayload;
  }

  export interface EnvelopeMeta {
    nextOffset: number | null;
    truncated: boolean;
  }

  export function uniformListEnvelope<T>(
    items: T[],
    meta: EnvelopeMeta,
  ): ListEnvelope<T> {
    return {
      items,
      next_offset: meta.nextOffset,
      truncated: meta.truncated,
      stream_id: null, // v1: always null. v1.5 streaming sets per chunk.
      is_final: true, // v1: always true. v1.5 emits false on intermediate chunks.
    };
  }
  ```

- [ ] **6.3** Re-export from `packages/recondo-data/src/index.ts`:

  ```ts
  export {
    encodeSinceCursor,
    decodeSinceCursor,
    uniformListEnvelope,
  } from "./envelope.js";
  export type { SinceCursorPayload, EnvelopeMeta } from "./envelope.js";
  ```

- [ ] **6.4** `pnpm --filter @recondo/data test` — both new tests pass.

- [ ] **6.5** Commit.

**Commit message:** `feat(data): add since cursor codec and uniform list envelope`

---

### Task 7: Add the AsyncIterable adapter helper (TDD)

**Files:**
- `packages/recondo-data/src/async-iter.ts` (NEW)
- `packages/recondo-data/tests/async-iter.test.ts` (NEW)

**Steps:**

- [ ] **7.1** **RED.** Per spec § "Streaming preparation" commitment 2 — every read function returns `AsyncIterable<Item>`. The dominant pattern in the existing resolvers is `pool.query(...).rows.map(...)`, which produces an array. We need a tiny adapter so we don't pay any runtime cost in v1 (the API materializes back to an array via `Array.fromAsync`) but the shape is right for v1.5 streaming.

  Create `packages/recondo-data/tests/async-iter.test.ts`:

  ```ts
  import { describe, it, expect } from "vitest";
  import { rowsToAsyncIterable, abortableIterable } from "../src/async-iter.js";

  describe("rowsToAsyncIterable", () => {
    it("yields each row in order", async () => {
      const out: number[] = [];
      for await (const r of rowsToAsyncIterable([1, 2, 3])) out.push(r);
      expect(out).toEqual([1, 2, 3]);
    });

    it("Array.fromAsync materializes back to array", async () => {
      const arr = await Array.fromAsync(rowsToAsyncIterable(["a", "b"]));
      expect(arr).toEqual(["a", "b"]);
    });
  });

  describe("abortableIterable", () => {
    it("throws when signal aborts mid-iteration", async () => {
      const ctrl = new AbortController();
      const it = abortableIterable(rowsToAsyncIterable([1, 2, 3, 4]), ctrl.signal);
      const out: number[] = [];
      await expect(async () => {
        for await (const r of it) {
          out.push(r);
          if (r === 2) ctrl.abort();
        }
      }).rejects.toThrow(/abort/i);
      expect(out).toEqual([1, 2]);
    });

    it("passes through when signal never fires", async () => {
      const ctrl = new AbortController();
      const arr = await Array.fromAsync(
        abortableIterable(rowsToAsyncIterable([1, 2, 3]), ctrl.signal),
      );
      expect(arr).toEqual([1, 2, 3]);
    });
  });
  ```

- [ ] **7.2** **GREEN.** Create `packages/recondo-data/src/async-iter.ts`:

  ```ts
  /**
   * Adapter helpers for the v1 → v1.5 streaming-prep contract.
   *
   * v1: every read function returns AsyncIterable<Item>. The API
   * resolver materializes via Array.fromAsync (because GraphQL has no
   * @stream directive). The MCP transport adapter (Plan D) materializes
   * into a 32 KB-bounded array.
   *
   * v1.5: the same data-layer code, with no edits, is consumed by a
   * streaming MCP transport adapter that emits notifications/progress
   * per chunk. The shape is ready; the cost is essentially zero.
   */

  /** Wrap an array (or any sync iterable) as an AsyncIterable. */
  export async function* rowsToAsyncIterable<T>(
    rows: Iterable<T>,
  ): AsyncIterable<T> {
    for (const r of rows) yield r;
  }

  /**
   * Compose an AsyncIterable with an AbortSignal. If the signal fires
   * mid-iteration, the next yield throws an AbortError. If the signal is
   * undefined, behaves as a passthrough.
   *
   * Pattern: every read function in @recondo/data should call this
   * before returning, threading the caller's options.signal through.
   */
  export async function* abortableIterable<T>(
    inner: AsyncIterable<T>,
    signal?: AbortSignal,
  ): AsyncIterable<T> {
    if (!signal) {
      yield* inner;
      return;
    }
    if (signal.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    for await (const item of inner) {
      if (signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      yield item;
    }
  }
  ```

- [ ] **7.3** Add exports to `packages/recondo-data/src/index.ts`:

  ```ts
  export { rowsToAsyncIterable, abortableIterable } from "./async-iter.js";
  ```

- [ ] **7.4** `pnpm --filter @recondo/data test` — passes.

- [ ] **7.5** Commit.

**Commit message:** `feat(data): add AsyncIterable + AbortSignal adapters`

---

### Task 8: Move `placeholder-mask.ts` into the redaction module

**Files:**
- `packages/recondo-data/src/redaction/placeholder-mask.ts` (NEW — moved)
- `packages/recondo-data/src/redaction/index.ts` (NEW)
- `packages/recondo-data/tests/placeholder-mask.test.ts` (NEW — moved)
- `packages/recondo-data/src/index.ts` (edit)
- `api/src/placeholder-mask.ts` (edit — becomes a re-export shim)

**Steps:**

- [ ] **8.1** Move the existing path-masking file unchanged so dashboards continue to mask paths identically. (Credential-pattern redaction was originally planned as Plan C work but was dropped from v1; the existing path-masking behavior here is the only redaction-adjacent work in v1.)

  Move `api/src/placeholder-mask.ts` → `packages/recondo-data/src/redaction/placeholder-mask.ts`. The file references `shared/placeholder-prefixes.json` via a path-walk. The walk currently tries three paths — extend it with a fourth that resolves `shared/` from the new location:

  ```ts
  for (const candidate of [
    // Existing fallbacks (kept so the shim path still resolves):
    resolve(__dirname, "..", "..", "shared", "placeholder-prefixes.json"),
    resolve(__dirname, "..", "..", "..", "shared", "placeholder-prefixes.json"),
    resolve(__dirname, "..", "shared", "placeholder-prefixes.json"),
    // New: from packages/recondo-data/dist/redaction/ → repo root
    resolve(__dirname, "..", "..", "..", "..", "shared", "placeholder-prefixes.json"),
    // New: from packages/recondo-data/src/redaction/ → repo root
    resolve(__dirname, "..", "..", "..", "shared", "placeholder-prefixes.json"),
  ]) {
  ```

  Add a unit test that proves the file is found from the new location.

- [ ] **8.2** Create `packages/recondo-data/src/redaction/index.ts` as a barrel:

  ```ts
  /**
   * Redaction module. v1 covers placeholder-path masking only.
   * Credential-pattern scrubbing was deferred from v1; if/when added,
   * it lands inside this module so consumers never re-import from a
   * moved path.
   */
  export {
    looksLikePathProbe,
    maskPlaceholderPaths,
    MASKED_PLACEHOLDER_REPLACEMENT,
    placeholderLikePatterns,
    sanitizeAnomalyRow,
    sanitizeRowTextFields,
    SESSION_TEXT_FIELDS,
    TOOL_CALL_TEXT_FIELDS,
    TURN_TEXT_FIELDS,
  } from "./placeholder-mask.js";
  ```

- [ ] **8.3** Move `api/tests/placeholder-mask.test.ts` and `api/tests/placeholder-mask-e2e.test.ts` to `packages/recondo-data/tests/`. Update the import path from `"../src/placeholder-mask.js"` to `"../src/redaction/placeholder-mask.js"`. Run `pnpm --filter @recondo/data test`.

- [ ] **8.4** Add to `packages/recondo-data/src/index.ts`:

  ```ts
  export * as redaction from "./redaction/index.js";
  // Also re-export the legacy names at the root for backward-compat
  // with existing API resolvers that import them flat. New code should
  // prefer the namespaced form `redaction.maskPlaceholderPaths`.
  export {
    looksLikePathProbe,
    maskPlaceholderPaths,
    MASKED_PLACEHOLDER_REPLACEMENT,
    placeholderLikePatterns,
    sanitizeAnomalyRow,
    sanitizeRowTextFields,
    SESSION_TEXT_FIELDS,
    TOOL_CALL_TEXT_FIELDS,
    TURN_TEXT_FIELDS,
  } from "./redaction/index.js";
  ```

- [ ] **8.5** Replace `api/src/placeholder-mask.ts` body with a shim:

  ```ts
  // Compatibility shim — real implementation lives in
  // @recondo/data/redaction. (Credential-pattern scrubbing deferred from v1.)
  export {
    looksLikePathProbe,
    maskPlaceholderPaths,
    MASKED_PLACEHOLDER_REPLACEMENT,
    placeholderLikePatterns,
    sanitizeAnomalyRow,
    sanitizeRowTextFields,
    SESSION_TEXT_FIELDS,
    TOOL_CALL_TEXT_FIELDS,
    TURN_TEXT_FIELDS,
  } from "@recondo/data";
  ```

  Run `cd api && pnpm test` — every existing call site (sessions/turns resolvers, `query/builder.ts`) compiles and tests pass. Commit.

**Commit message:** `refactor(data): move placeholder-mask under @recondo/data/redaction`

---

### Task 9: Move `auth.ts` and rename to `authenticateApiKey`

**Files:**
- `packages/recondo-data/src/auth.ts` (NEW — moved)
- `packages/recondo-data/tests/auth.test.ts` (NEW — moved)
- `packages/recondo-data/src/index.ts` (edit)
- `api/src/auth.ts` (edit — becomes a re-export shim)

**Steps:**

- [ ] **9.1** Move `api/src/auth.ts` → `packages/recondo-data/src/auth.ts`. Add a new exported name `authenticateApiKey` that takes the raw token (not the header), and keep `authenticateRequest` as a thin shim so the API HTTP middleware doesn't need to change in this task.

  ```ts
  import { createHash } from "node:crypto";
  import { getPool } from "./pool.js";
  import type { ApiKeyInfo, QueryOptions } from "./types.js";

  /**
   * Look up an API key by its raw token (without "Bearer " prefix).
   *
   * Callable from any consumer (API HTTP middleware, MCP stdio handshake).
   * Returns null if the key is absent, malformed, unknown, or revoked.
   *
   * Per spec § "Streaming preparation" commitment 4: accepts an optional
   * AbortSignal. Postgres' pg.Query supports cancellation via the
   * client.cancel() escape hatch but pool.query() does not — so we wrap
   * the awaited promise in a race against signal abort. If the signal
   * fires after the row is fetched but before the function returns, the
   * promise resolves normally and the abort is a no-op (correct behavior:
   * the work was already done).
   */
  export async function authenticateApiKey(
    token: string | null | undefined,
    options: QueryOptions = {},
  ): Promise<ApiKeyInfo | null> {
    if (!token) return null;
    const trimmed = token.trim();
    if (!trimmed.startsWith("wrt_")) return null;

    const keyHash = createHash("sha256").update(trimmed).digest("hex");
    const pool = getPool();

    const queryPromise = pool.query(
      `SELECT id, project_id, rate_limit_rpm, revoked_at
       FROM api_keys
       WHERE key_hash = $1`,
      [keyHash],
    );

    const result = options.signal
      ? await Promise.race([
          queryPromise,
          new Promise<never>((_, reject) => {
            const onAbort = () =>
              reject(new DOMException("aborted", "AbortError"));
            if (options.signal!.aborted) onAbort();
            else options.signal!.addEventListener("abort", onAbort, { once: true });
          }),
        ])
      : await queryPromise;

    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    if (row.revoked_at !== null) return null;
    return {
      id: row.id,
      projectId: row.project_id,
      rateLimitRpm: row.rate_limit_rpm,
    };
  }

  /**
   * Compatibility wrapper that accepts a full `Authorization` header
   * value. Kept so the API's existing HTTP middleware path (which only
   * sees the header string) doesn't need to change in this task.
   */
  export async function authenticateRequest(
    authHeader: string | undefined | null,
    options: QueryOptions = {},
  ): Promise<ApiKeyInfo | null> {
    if (!authHeader) return null;
    if (!authHeader.toLowerCase().startsWith("bearer ")) return null;
    const token = authHeader.slice(7).trim();
    return authenticateApiKey(token, options);
  }
  ```

- [ ] **9.2** Move `api/tests/auth.test.ts` to `packages/recondo-data/tests/auth.test.ts` and update imports:

  ```ts
  import { authenticateApiKey, authenticateRequest } from "../src/auth.js";
  ```

  Add a test for the new `authenticateApiKey(token)` signature and one for AbortSignal:

  ```ts
  it("rejects when AbortSignal fires before query completes", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(authenticateApiKey("wrt_test", { signal: ctrl.signal }))
      .rejects.toThrow(/abort/i);
  });
  ```

- [ ] **9.3** Update `packages/recondo-data/src/index.ts`:

  ```ts
  export { authenticateApiKey, authenticateRequest } from "./auth.js";
  ```

- [ ] **9.4** Replace `api/src/auth.ts` body with a shim:

  ```ts
  // Compatibility shim — see @recondo/data/auth.
  export { authenticateApiKey, authenticateRequest } from "@recondo/data";
  ```

- [ ] **9.5** Run `pnpm --filter @recondo/data test` then `cd api && pnpm test`. All pass. Commit.

**Commit message:** `refactor(data): move authenticateApiKey into @recondo/data`

---

### Task 10: Move `mappers.ts` into the package

**Files:**
- `packages/recondo-data/src/mappers.ts` (NEW — moved)
- `packages/recondo-data/src/index.ts` (edit)
- `api/src/resolvers/mappers.ts` (edit — re-export shim)

**Steps:**

- [ ] **10.1** Mappers are the row → domain-object translation layer (`mapSession`, `mapTurn`, `mapAnomaly`, `escapeIlike`, `formatTimestamp`). They are pure data-layer concerns and have no GraphQL surface — they belong in the package.

  Move `api/src/resolvers/mappers.ts` → `packages/recondo-data/src/mappers.ts` verbatim. The mappers import nothing GraphQL-shaped (verify by inspection — they reference `placeholder-mask` which is now also in the package).

- [ ] **10.2** Fix imports inside the moved file: change `from "../placeholder-mask.js"` to `from "./redaction/index.js"`.

- [ ] **10.3** Re-export from `packages/recondo-data/src/index.ts`:

  ```ts
  export { mapSession, mapTurn, mapAnomaly, escapeIlike, formatTimestamp } from "./mappers.js";
  ```

  (Adjust to the actual export list — read mappers.ts first.)

- [ ] **10.4** Replace `api/src/resolvers/mappers.ts` with a shim:

  ```ts
  export { mapSession, mapTurn, mapAnomaly, escapeIlike, formatTimestamp } from "@recondo/data";
  ```

- [ ] **10.5** Run `cd api && pnpm test`. All resolver imports of `./mappers.js` continue to work via the shim. Commit.

**Commit message:** `refactor(data): hoist mappers into @recondo/data`

---

### Task 11: Move `query/builder.ts` core into per-operation exports (TDD)

**Files:**
- `packages/recondo-data/src/structured-query.ts` (NEW)
- `packages/recondo-data/tests/structured-query.test.ts` (NEW)
- `api/src/query/builder.ts` (edit — becomes a thin HTTP/format adapter)

**Steps:**

- [ ] **11.1** **The core refactor.** `api/src/query/builder.ts` is 1110 lines, of which roughly 200 are HTTP-shape concerns (request validation, format-switching, attribution string lookup, response status codes) and roughly 900 are SQL + per-domain query functions (`querySessions`, `queryTurns`, `queryAnomalies`, `queryCost`, `queryTools`, `queryRisk`, `queryCompliance`, `queryProvenance`).

  We extract the SQL functions into `packages/recondo-data/src/structured-query.ts` as named exports. We expose an internal `runStructuredQuery` for backward-compat, but new callers prefer the named per-operation functions.

  **RED.** Create `packages/recondo-data/tests/structured-query.test.ts`. Reuse the assertion patterns from `api/tests/query-builder.test.ts` but test the per-operation functions directly:

  ```ts
  import { describe, it, expect, beforeAll, afterAll } from "vitest";
  import {
    listStructuredSessions,
    listStructuredTurns,
    listStructuredAnomalies,
    listStructuredCost,
    listStructuredTools,
    listStructuredRisk,
    listStructuredCompliance,
    listStructuredProvenance,
    runStructuredQuery,
  } from "../src/structured-query.js";
  import { closePool } from "../src/pool.js";
  // (test fixtures similar to api/tests/setup.ts)

  afterAll(async () => { await closePool(); });

  describe("structured-query: per-operation exports", () => {
    it("listStructuredSessions returns AsyncIterable<row>", async () => {
      const it = listStructuredSessions("test-project", {}, { limit: 10 });
      const rows = await Array.fromAsync(it);
      expect(Array.isArray(rows)).toBe(true);
    });

    it("each function accepts AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(
        Array.fromAsync(listStructuredSessions("test-project", {}, { signal: ctrl.signal })),
      ).rejects.toThrow(/abort/i);
    });

    it("runStructuredQuery dispatches by queryType", async () => {
      const out = await runStructuredQuery("anomalies", "test-project", {}, undefined, 10);
      expect(out.rows).toBeDefined();
      expect(typeof out.totalCount).toBe("number");
    });
  });
  ```

- [ ] **11.2** **GREEN.** Create `packages/recondo-data/src/structured-query.ts`. Move the eight `queryXxx` functions verbatim from `api/src/query/builder.ts`, then wrap each as a per-operation export that returns an `AsyncIterable<row>` and accepts a `ListOptions`:

  ```ts
  import { getPool } from "./pool.js";
  import { abortableIterable, rowsToAsyncIterable } from "./async-iter.js";
  import type { ListOptions } from "./types.js";
  import {
    sanitizeAnomalyRow,
    sanitizeRowTextFields,
    SESSION_TEXT_FIELDS,
    TOOL_CALL_TEXT_FIELDS,
    TURN_TEXT_FIELDS,
  } from "./redaction/index.js";

  function escapeIlike(s: string): string {
    return s.replace(/[%_\\]/g, "\\$&");
  }

  // ---------- private query helpers (moved verbatim from api) ----------

  async function querySessions(
    projectId: string,
    filters: Record<string, unknown>,
    limit: number,
  ): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
    // ... body moved verbatim from api/src/query/builder.ts ...
  }

  async function queryTurns(/* ... */) { /* ... */ }
  async function queryAnomalies(/* ... */) { /* ... */ }
  async function queryCost(/* ... */) { /* ... */ }
  async function queryTools(/* ... */) { /* ... */ }
  async function queryRisk(/* ... */) { /* ... */ }
  async function queryCompliance(/* ... */) { /* ... */ }
  async function queryProvenance(/* ... */) { /* ... */ }

  // ---------- per-operation public exports ----------

  export function listStructuredSessions(
    projectId: string,
    filters: Record<string, unknown>,
    options: ListOptions = {},
  ): AsyncIterable<Record<string, unknown>> {
    const limit = options.limit ?? 100;
    const inner = (async function* () {
      const { rows } = await querySessions(projectId, filters, limit);
      yield* rows;
    })();
    return abortableIterable(inner, options.signal);
  }

  export function listStructuredTurns(
    projectId: string,
    filters: Record<string, unknown>,
    options: ListOptions = {},
  ): AsyncIterable<Record<string, unknown>> {
    const limit = options.limit ?? 100;
    const inner = (async function* () {
      const { rows } = await queryTurns(projectId, filters, limit);
      yield* rows;
    })();
    return abortableIterable(inner, options.signal);
  }

  // ... five more in the same shape ...
  export function listStructuredAnomalies(/* ... */): AsyncIterable<Record<string, unknown>> { /* ... */ }
  export function listStructuredCost(/* ... */): AsyncIterable<Record<string, unknown>> { /* ... */ }
  export function listStructuredTools(/* ... */): AsyncIterable<Record<string, unknown>> { /* ... */ }
  export function listStructuredRisk(/* ... */): AsyncIterable<Record<string, unknown>> { /* ... */ }
  export function listStructuredCompliance(/* ... */): AsyncIterable<Record<string, unknown>> { /* ... */ }
  export function listStructuredProvenance(/* ... */): AsyncIterable<Record<string, unknown>> { /* ... */ }

  // ---------- compatibility dispatcher (kept so the HTTP adapter stays small) ----------

  /**
   * Switch-dispatch over queryType for the /v1/query HTTP route. Materializes
   * the AsyncIterable into an array because the route returns one JSON body.
   * New consumers should call the per-operation functions directly.
   */
  export async function runStructuredQuery(
    queryType: string,
    projectId: string,
    filters: Record<string, unknown>,
    groupBy: string | undefined,
    limit: number,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ rows: Record<string, unknown>[]; totalCount: number }> {
    switch (queryType) {
      case "sessions":   return querySessions(projectId, filters, limit);
      case "turns":      return queryTurns(projectId, filters, limit);
      case "anomalies":  return queryAnomalies(projectId, filters, limit);
      case "cost":       return queryCost(projectId, filters, groupBy, limit);
      case "tools":      return queryTools(projectId, filters, limit);
      case "risk":       return queryRisk(projectId, filters, limit);
      case "compliance": return queryCompliance(projectId, filters, limit);
      case "provenance": return queryProvenance(projectId, filters, limit);
      default: throw new Error(`Unknown queryType: ${queryType}`);
    }
  }
  ```

  Wire the exports through `packages/recondo-data/src/index.ts`.

- [ ] **11.3** Replace the body of `api/src/query/builder.ts` with the HTTP/format adapter only. Keep request parsing, shortcut resolution (`session_complete`, `provenance_chain`, etc.), format switching (`json`/`table`/`narrative`), and attribution string lookup. Replace the inline `executeQuery` switch with a single call to `runStructuredQuery`:

  ```ts
  import {
    runStructuredQuery,
    type ApiKeyInfo,
  } from "@recondo/data";

  // ... existing shortcut/format/attribution code unchanged ...

  // Inside handleQuery, replace executeQuery() call:
  const { rows, totalCount } = await Promise.race([
    runStructuredQuery(queryType, projectId, filters, groupBy, effectiveLimit),
    timeoutPromise(30_000),
  ]);
  ```

  Delete the eight private `queryXxx` functions from `builder.ts` — they now live in the package.

- [ ] **11.4** Run `cd api && pnpm test -- query-builder`. The query-builder tests (which test the HTTP-shape behavior end-to-end) must pass unchanged. Run `pnpm --filter @recondo/data test` — new structured-query tests pass.

- [ ] **11.5** Commit.

**Commit message:** `refactor(data): split structured query into per-operation exports`

---

### Task 12: Promote `sessions` resolver DB code into the package (TDD)

**Files:**
- `packages/recondo-data/src/sessions.ts` (NEW)
- `packages/recondo-data/tests/sessions.test.ts` (NEW)
- `api/src/resolvers/sessions.ts` (edit — becomes thin transport adapter)

**Steps:**

- [ ] **12.1** **The most representative refactor.** `api/src/resolvers/sessions.ts` is 563 lines. The DB-touching code lives inside the resolver functions (`sessionsResolver`, `sessionResolver`, `userTurnsResolver`); the GraphQL-shape code is just argument unpacking and the return-shape envelope.

  We move the SQL into `packages/recondo-data/src/sessions.ts` as named exports and reduce the resolvers to ~10-line wrappers.

  **RED.** Create `packages/recondo-data/tests/sessions.test.ts`:

  ```ts
  import { describe, it, expect, afterAll } from "vitest";
  import { listSessions, getSession, listUserTurns } from "../src/sessions.js";
  import { closePool } from "../src/pool.js";
  import type { ApiKeyInfo } from "../src/types.js";

  const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

  afterAll(async () => { await closePool(); });

  describe("@recondo/data: sessions", () => {
    it("listSessions returns the uniform list envelope shape", async () => {
      const env = await listSessions(adminKey, {}, { limit: 10 });
      expect(env).toHaveProperty("items");
      expect(env).toHaveProperty("next_offset");
      expect(env).toHaveProperty("truncated");
      expect(env.stream_id).toBeNull();
      expect(env.is_final).toBe(true);
    });

    it("listSessions items are AsyncIterable-materializable via Array.fromAsync", async () => {
      // The function returns the envelope synchronously-after-await,
      // but each `items` entry is the same shape as today (a record
      // object). The async-iter contract applies to the FULL function
      // return, not item-by-item, for list-shape reads — see spec
      // § "Streaming preparation" commitment 1+2 interaction.
      const env = await listSessions(adminKey, {}, { limit: 5 });
      expect(Array.isArray(env.items)).toBe(true);
    });

    it("getSession returns a single record or null", async () => {
      const session = await getSession(adminKey, "non-existent-id");
      expect(session).toBeNull();
    });

    it("every function accepts AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(listSessions(adminKey, {}, { signal: ctrl.signal }))
        .rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **12.2** **GREEN.** Create `packages/recondo-data/src/sessions.ts`. Move the SQL bodies of `sessionsResolver`, `sessionResolver`, and `userTurnsResolver` into per-operation functions:

  ```ts
  import { GraphQLError } from "graphql"; // ⚠️ STOP — see 12.3 below
  ```

- [ ] **12.3** **Important boundary check.** `GraphQLError` is a transport concern. The package must NOT import `graphql`. Replace `throw new GraphQLError(...)` with a plain `class DataValidationError extends Error` in the package. The API resolver wraps it back into `GraphQLError`. Add `DataValidationError` to `packages/recondo-data/src/types.ts`:

  ```ts
  /**
   * Thrown by data-layer functions when a caller-provided argument is
   * structurally invalid (e.g. search query > 500 chars). Transport
   * adapters convert this to their own error shape — GraphQLError on
   * the API side, an MCP InvalidParams error on the MCP side.
   */
  export class DataValidationError extends Error {
    constructor(message: string, public readonly code: string = "BAD_USER_INPUT") {
      super(message);
      this.name = "DataValidationError";
    }
  }
  ```

  Add it to the index export.

- [ ] **12.4** Now write `packages/recondo-data/src/sessions.ts`. This shows the actual move pattern that all 11 resolver tasks follow:

  ```ts
  import { getPool } from "./pool.js";
  import { abortableIterable, rowsToAsyncIterable } from "./async-iter.js";
  import { uniformListEnvelope } from "./envelope.js";
  import { mapSession, escapeIlike } from "./mappers.js";
  import {
    looksLikePathProbe,
    maskPlaceholderPaths,
    MASKED_PLACEHOLDER_REPLACEMENT,
    placeholderLikePatterns,
  } from "./redaction/index.js";
  import type {
    ApiKeyInfo,
    ListEnvelope,
    ListOptions,
    QueryOptions,
  } from "./types.js";
  import { DataValidationError } from "./types.js";

  export interface SessionFilter {
    provider?: string;
    model?: string;
    projectId?: string;
    startedAfter?: string;
    startedBefore?: string;
    status?: "ACTIVE" | "COMPLETED";
    framework?: string;
    hideNonLlm?: boolean;
    search?: string;
  }

  export interface SessionListItem {
    id: string;
    // ... mirrors the existing mapSession output exactly
    [key: string]: unknown;
  }

  /**
   * List sessions with project scoping derived from `apiKey`. v1 returns
   * the full envelope; v1.5 streaming wraps the same envelope across
   * notifications/progress chunks.
   */
  export async function listSessions(
    apiKey: ApiKeyInfo,
    filter: SessionFilter,
    options: ListOptions = {},
  ): Promise<ListEnvelope<SessionListItem>> {
    if (options.signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const pool = getPool();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (apiKey.projectId) {
      conditions.push(`s.project_id = $${idx++}`);
      params.push(apiKey.projectId);
    }
    // ... ALL the filter logic moved verbatim from api/src/resolvers/sessions.ts:23-194 ...
    // (provider, model, projectId, startedAfter, startedBefore, status, framework,
    //  hideNonLlm, search with looksLikePathProbe + queryMatchesMaskedForm
    //  expansion — every line moves identically.)

    if (filter.search && filter.search.length > 500) {
      throw new DataValidationError("Search query too long");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    let limit = options.limit ?? 100;
    let offset = options.offset ?? 0;
    if (limit < 0) limit = 0;
    if (limit > 1000) limit = 1000;
    if (offset < 0) offset = 0;
    if (offset > 100000) offset = 100000;

    const countParams = [...params];
    params.push(limit);
    const limitIdx = idx++;
    params.push(offset);
    const offsetIdx = idx++;

    const queryPromise = Promise.all([
      pool.query(
        `SELECT s.*, /* ... full SQL block from api/src/resolvers/sessions.ts:218-258 ... */
         FROM sessions s
         /* lateral joins ... */
         ${where}
         ORDER BY s.started_at DESC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      ),
      pool.query(
        `SELECT COUNT(*)::bigint AS total FROM sessions s ${where}`,
        countParams,
      ),
    ]);

    const [result, countResult] = options.signal
      ? await raceAbort(queryPromise, options.signal)
      : await queryPromise;

    const sessions = result.rows.map((row) => mapSession({
      ...row,
      model: row.resolved_model ?? row.model,
      initial_intent: row.resolved_initial_intent ?? row.initial_intent,
    }));
    const total = Number(countResult.rows[0]?.total ?? 0);

    // Cache-token aggregation (moved verbatim from sessions.ts:276-303)
    if (sessions.length > 0) {
      const sessionIds = sessions.map((s) => s.id);
      const cacheResult = await pool.query(
        `SELECT session_id, /* ... */
         FROM turns WHERE session_id = ANY($1) GROUP BY session_id`,
        [sessionIds],
      );
      const cacheMap = new Map<string, { cacheReadTokens: number; cacheCreationTokens: number }>();
      for (const row of cacheResult.rows) {
        cacheMap.set(row.session_id as string, {
          cacheReadTokens: (row.cache_read_tokens as number) ?? 0,
          cacheCreationTokens: (row.cache_creation_tokens as number) ?? 0,
        });
      }
      for (const session of sessions) {
        const cache = cacheMap.get(session.id);
        if (cache) {
          session.cacheReadTokens = cache.cacheReadTokens;
          session.cacheCreationTokens = cache.cacheCreationTokens;
        }
      }
    }

    const nextOffset = offset + sessions.length < total ? offset + sessions.length : null;
    return uniformListEnvelope(sessions as SessionListItem[], {
      nextOffset,
      truncated: nextOffset !== null,
    });
  }

  export async function getSession(
    apiKey: ApiKeyInfo,
    id: string,
    options: QueryOptions = {},
  ): Promise<SessionListItem | null> {
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const pool = getPool();
    const conditions = [`s.id = $1`];
    const params: unknown[] = [id];
    if (apiKey.projectId) {
      conditions.push(`s.project_id = $2`);
      params.push(apiKey.projectId);
    }
    // ... full SELECT block moved verbatim from sessions.ts:328-368 ...
    const result = await pool.query(/* ... */ , params);
    if (result.rows.length === 0) return null;
    const session = mapSession({
      ...result.rows[0],
      model: result.rows[0].resolved_model ?? result.rows[0].model,
      initial_intent: result.rows[0].resolved_initial_intent ?? result.rows[0].initial_intent,
    });
    // ... cache-token block from sessions.ts:381-392 ...
    return session as SessionListItem;
  }

  export async function listUserTurns(
    sessionId: string,
    options: QueryOptions = {},
  ): Promise<unknown[]> {
    // Moved verbatim from sessions.ts:430-535. Returns array (not envelope)
    // because it's a child-of-session collection, not a paginated top-level
    // list. Wrapping it in the uniform envelope would lie about pagination
    // semantics — there's no offset for this query.
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const pool = getPool();
    const result = await pool.query(/* ... full WITH CTE ... */, [sessionId]);
    return result.rows.map((row) => { /* ... unchanged shape ... */ });
  }

  // ---------- private ----------

  async function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new DOMException("aborted", "AbortError"));
        else signal.addEventListener("abort",
          () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    ]);
  }
  ```

  **The mechanical move:** every `pool.query(SQL, params)` line in the resolver moves verbatim. The only behavioral edits are: replace `ctx.apiKey` with the explicit `apiKey` parameter, replace `args.filter` with the explicit `filter` parameter, replace `GraphQLError` with `DataValidationError`, wrap the return in `uniformListEnvelope`.

- [ ] **12.5** Now thin the API resolver. **The API consumer of an `AsyncIterable` returning function uses `Array.fromAsync`.** Per spec, `listSessions` returns an envelope (single object, not iterable) — but if we ever switch the return to `AsyncIterable<ListEnvelope<T>>` for streaming, the API resolver would call `Array.fromAsync`. Show both patterns in the resolver file.

  Replace `api/src/resolvers/sessions.ts` body:

  ```ts
  import { GraphQLError } from "graphql";
  import {
    listSessions,
    getSession,
    listUserTurns,
    DataValidationError,
  } from "@recondo/data";
  import type {
    QueryResolvers,
    SessionResolvers,
    UserTurnResolvers,
  } from "../generated/graphql.js";

  /** Convert a data-layer error into a GraphQL error. */
  function asGqlError(err: unknown): never {
    if (err instanceof DataValidationError) {
      throw new GraphQLError(err.message, { extensions: { code: err.code } });
    }
    throw err;
  }

  const sessionsResolver: NonNullable<QueryResolvers["sessions"]> = async (
    _parent, args, ctx,
  ) => {
    try {
      const env = await listSessions(
        ctx.apiKey,
        {
          provider: args.filter?.provider ?? undefined,
          model: args.filter?.model ?? undefined,
          projectId: args.filter?.projectId ?? undefined,
          startedAfter: args.filter?.startedAfter ?? undefined,
          startedBefore: args.filter?.startedBefore ?? undefined,
          status: (args.filter?.status as "ACTIVE" | "COMPLETED" | undefined) ?? undefined,
          framework: args.filter?.framework ?? undefined,
          hideNonLlm: args.filter?.hideNonLlm ?? undefined,
          search: args.filter?.search ?? undefined,
        },
        { limit: args.limit ?? 100, offset: args.offset ?? 0 },
      );
      // GraphQL SessionConnection shape: total/limit/offset/items.
      // The package returns the streaming-prep envelope; the resolver
      // re-shapes it into the GraphQL connection shape (which predates
      // streaming-prep and is not changing).
      return {
        items: env.items as never,
        total: (env.next_offset ?? env.items.length) +
          (env.truncated ? 1 : 0), // see comment below
        limit: args.limit ?? 100,
        offset: args.offset ?? 0,
      };
    } catch (err) { asGqlError(err); }
  };
  ```

  **Important detail.** The current `sessionsResolver` returns `{ items, total, limit, offset }` from the SQL `COUNT(*)`. The package needs to expose `total` separately because the envelope only carries `next_offset`/`truncated` (which can't reconstruct total). Update the package function to return both — make `listSessions` return `{ envelope: ListEnvelope<T>, total: number }` or extend the envelope with an optional `total?: number` for cases where the underlying data layer knows it. Pick the second:

  ```ts
  // In packages/recondo-data/src/types.ts:
  export interface ListEnvelope<T> {
    items: T[];
    next_offset: number | null;
    truncated: boolean;
    stream_id: string | null;
    is_final: true;
    /**
     * Optional caller-provided total. Present when the data layer
     * knows the full row count (e.g. via SQL COUNT(*)); absent when
     * the data layer can only paginate forward (e.g. cursor-only
     * streams). MCP transports may ignore it; GraphQL adapters use
     * it to populate Connection.total.
     */
    total?: number;
  }
  ```

  Then in `listSessions`, set `total` on the envelope. The GraphQL resolver reads `env.total ?? env.items.length`.

  **The `Array.fromAsync` materialization (in resolvers that call iterable functions, e.g. structured-query):**

  ```ts
  // api/src/query/builder.ts (the HTTP /v1/query route) — example of
  // materializing an AsyncIterable from the package into an array.
  import { listStructuredSessions } from "@recondo/data";

  // Inside the route handler:
  const rows = await Array.fromAsync(
    listStructuredSessions(projectId, filters, { limit: effectiveLimit, signal: req.signal }),
  );
  ```

  `req.signal` is Fastify's per-request AbortSignal — thread it all the way down so client disconnects cancel the SQL.

  Show the threading in at least one HTTP handler (the `/v1/query` route). The GraphQL resolvers do not have a per-request AbortSignal exposed by Apollo Server v4; pass `{}` (no signal) for now and document it as a v1.5 follow-up.

  Update the rest of the resolver file (`session`, `userTurns`, `turns`, `title`, `userTurnChildren`) to delegate to the package functions in the same pattern. The DataLoader-based resolvers (`turnsBySessionId`, `titleBySessionId`) keep their existing shape — DataLoaders live in the API because they're per-request caches, not data-layer concerns.

- [ ] **12.6** Run `cd api && pnpm test -- sessions`. Then `pnpm --filter @recondo/data test -- sessions`. Both pass. Commit.

**Commit message:** `refactor(data): hoist session DB code into @recondo/data`

---

### Task 13: Promote `turns` resolver DB code

**Files:**
- `packages/recondo-data/src/turns.ts` (NEW)
- `packages/recondo-data/tests/turns.test.ts` (NEW)
- `api/src/resolvers/turns.ts` (edit)

**Steps:**

- [ ] **13.1** **RED.** Create `packages/recondo-data/tests/turns.test.ts` covering the three operations: `getTurn`, `searchTurns`, and `verifyIntegrity` (the integrity-verification SQL is currently at the bottom of `api/src/resolvers/turns.ts`).

  ```ts
  import { describe, it, expect } from "vitest";
  import { getTurn, searchTurns } from "../src/turns.js";
  import type { ApiKeyInfo } from "../src/types.js";

  const adminKey: ApiKeyInfo = { id: "k", projectId: null, rateLimitRpm: 1000 };

  describe("@recondo/data: turns", () => {
    it("searchTurns rejects queries longer than 500 chars", async () => {
      const long = "x".repeat(501);
      await expect(searchTurns(adminKey, long, null, { limit: 100 }))
        .rejects.toThrow(/too long/i);
    });

    it("searchTurns returns AsyncIterable<TurnRow>", async () => {
      const rows = await Array.fromAsync(searchTurns(adminKey, "auth", null, { limit: 10 }));
      expect(Array.isArray(rows)).toBe(true);
    });

    it("searchTurns honors AbortSignal", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      await expect(Array.fromAsync(
        searchTurns(adminKey, "anything", null, { signal: ctrl.signal }),
      )).rejects.toThrow(/abort/i);
    });
  });
  ```

- [ ] **13.2** **GREEN.** Create `packages/recondo-data/src/turns.ts`:

  ```ts
  import { getPool } from "./pool.js";
  import { abortableIterable, rowsToAsyncIterable } from "./async-iter.js";
  import { mapTurn, escapeIlike } from "./mappers.js";
  import {
    maskPlaceholderPaths,
    MASKED_PLACEHOLDER_REPLACEMENT,
    placeholderLikePatterns,
  } from "./redaction/index.js";
  import type { ApiKeyInfo, ListOptions, QueryOptions } from "./types.js";
  import { DataValidationError } from "./types.js";

  export async function getTurn(
    apiKey: ApiKeyInfo,
    id: string,
    options: QueryOptions = {},
  ): Promise<unknown | null> {
    if (options.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const pool = getPool();
    const conditions = [`t.id = $1`];
    const params: unknown[] = [id];
    if (apiKey.projectId) {
      conditions.push(`s.project_id = $2`);
      params.push(apiKey.projectId);
    }
    const result = await pool.query(
      `SELECT t.* FROM turns t
       JOIN sessions s ON t.session_id = s.id
       WHERE ${conditions.join(" AND ")}`,
      params,
    );
    if (result.rows.length === 0) return null;
    return mapTurn(result.rows[0]);
  }

  /**
   * Search turns. Note: list-shape, but uses `offset` (not `since`) per
   * spec — search results are relevance-ranked, not time-ordered.
   * Returns AsyncIterable so the MCP adapter can later stream chunks.
   */
  export function searchTurns(
    apiKey: ApiKeyInfo,
    query: string,
    requestedProjectId: string | null,
    options: ListOptions = {},
  ): AsyncIterable<unknown> {
    if (query.length > 500) {
      // Eagerly throw — package contract is "either yields or throws";
      // a sync throw is preferable to a deferred-rejection iterator
      // because callers can catch it without iterating.
      throw new DataValidationError("Search query too long");
    }

    const inner = (async function* () {
      const pool = getPool();
      const effectiveProjectId =
        requestedProjectId ?? apiKey.projectId ?? null;
      if (
        apiKey.projectId &&
        requestedProjectId &&
        apiKey.projectId !== requestedProjectId
      ) {
        return; // empty
      }

      const escapedQuery = escapeIlike(query);
      const projectCondition = effectiveProjectId
        ? `s.project_id = $1 AND `
        : "";
      const baseParams: unknown[] = effectiveProjectId
        ? [effectiveProjectId]
        : [];
      const queryParamIdx = effectiveProjectId ? 2 : 1;

      // ALL the existing FTS + ILIKE + post-filter logic moves verbatim
      // from api/src/resolvers/turns.ts:104-247. The for-loop that
      // accumulates batches via fetchAndPostFilterTurns also moves —
      // it's pure SQL + JS, no GraphQL surface.
      try {
        const result = await pool.query(
          `SELECT t.* FROM turns t
           JOIN sessions s ON t.session_id = s.id
           WHERE ${projectCondition}t.search_vector @@ plainto_tsquery('english', $${queryParamIdx})
           ORDER BY t.timestamp DESC, t.id ASC
           LIMIT 100`,
          [...baseParams, query],
        );
        if (result.rows.length > 0) {
          for (const row of postFilterByMaskedQuery(result.rows, query, 100)) {
            yield mapTurn(row);
          }
          return;
        }
        // ... ILIKE-fallback branch + masked-search expansion + batched accumulation, all moved
        // verbatim. Yield each post-filtered row instead of accumulating into a return array.
        for (const row of await fetchAndPostFilterTurns(
          pool, /* fetchBatch closure */, query, 100,
        )) {
          yield mapTurn(row);
        }
      } catch {
        // Fallback ILIKE branch (search_vector column missing) — moved verbatim.
        for (const row of await fetchAndPostFilterTurns(
          pool, /* fallback fetchBatch closure */, query, 100,
        )) {
          yield mapTurn(row);
        }
      }
    })();
    return abortableIterable(inner, options.signal);
  }

  // postFilterByMaskedQuery and fetchAndPostFilterTurns move verbatim
  // from api/src/resolvers/turns.ts (private to this module).

  function postFilterByMaskedQuery(
    rows: Array<Record<string, unknown>>,
    query: string,
    limit: number,
  ): Array<Record<string, unknown>> {
    // ... verbatim from turns.ts:375-401 ...
  }

  async function fetchAndPostFilterTurns(
    _pool: import("pg").Pool,
    fetchBatch: (offset: number, batchLimit: number) => Promise<{ rows: Array<Record<string, unknown>> }>,
    query: string,
    desired: number,
  ): Promise<Array<Record<string, unknown>>> {
    // ... verbatim from turns.ts:277-354 ...
  }
  ```

- [ ] **13.3** Thin `api/src/resolvers/turns.ts`:

  ```ts
  import { GraphQLError } from "graphql";
  import { getTurn, searchTurns, DataValidationError } from "@recondo/data";
  import type { QueryResolvers, TurnResolvers } from "../generated/graphql.js";

  const turnResolver: NonNullable<QueryResolvers["turn"]> = async (
    _parent, args, ctx,
  ) => getTurn(ctx.apiKey, args.id);

  const searchResolver: NonNullable<QueryResolvers["search"]> = async (
    _parent, args, ctx,
  ) => {
    try {
      // GraphQL has no @stream — materialize the AsyncIterable into an array.
      return await Array.fromAsync(
        searchTurns(ctx.apiKey, args.query, args.projectId ?? null, { limit: 100 }),
      );
    } catch (err) {
      if (err instanceof DataValidationError) {
        throw new GraphQLError(err.message, { extensions: { code: err.code } });
      }
      throw err;
    }
  };

  // (verifyIntegrity, toolCalls nested resolver — same pattern.)

  export const turnResolvers = {
    Query: { turn: turnResolver, search: searchResolver },
    Turn: { /* ... */ },
  };
  ```

- [ ] **13.4** Run `cd api && pnpm test -- turns`. All pass.

- [ ] **13.5** Commit.

**Commit message:** `refactor(data): hoist turn DB code into @recondo/data`

---

### Task 14: Promote `anomalies` resolver DB code

**Files:**
- `packages/recondo-data/src/anomalies.ts` (NEW)
- `packages/recondo-data/tests/anomalies.test.ts` (NEW)
- `api/src/resolvers/anomalies.ts` (edit)

**Steps:**

- [ ] **14.1** **RED.** Test `listAnomalies(apiKey, filter, options)` — the simpler analog of `listSessions`. Test envelope shape, `since` cursor support, AbortSignal.

- [ ] **14.2** **GREEN.** Create `packages/recondo-data/src/anomalies.ts`. The full body of `anomaliesResolver` (lines 14-72 of `api/src/resolvers/anomalies.ts`) moves verbatim. Add `since` cursor handling (the existing resolver has `args.filter?.since` as a string ISO date — accept that AND the new opaque cursor):

  ```ts
  import { decodeSinceCursor } from "./envelope.js";
  // ...
  if (filter.since) {
    // Heuristic: if it parses as a base64url(JSON), treat as opaque
    // cursor; otherwise treat as a raw ISO 8601 date for backward compat.
    let ts: string;
    let id: string | null = null;
    try {
      const decoded = decodeSinceCursor(filter.since as SinceCursor);
      ts = decoded.ts;
      id = decoded.id;
    } catch {
      ts = filter.since;
    }
    conditions.push(`a.detected_at::TIMESTAMPTZ > $${idx++}`);
    params.push(ts);
    if (id !== null) {
      // tie-break on id when timestamps collide
      conditions.push(`(a.detected_at::TIMESTAMPTZ > $${idx - 1} OR a.id > $${idx++})`);
      params.push(id);
    }
  }
  ```

- [ ] **14.3** Thin `api/src/resolvers/anomalies.ts`:

  ```ts
  import { listAnomalies } from "@recondo/data";
  // ...
  const anomaliesResolver: NonNullable<QueryResolvers["anomalies"]> = async (
    _parent, args, ctx,
  ) => {
    const env = await listAnomalies(
      ctx.apiKey,
      {
        severity: args.filter?.severity ?? undefined,
        sessionId: args.filter?.sessionId ?? undefined,
        anomalyType: args.filter?.anomalyType ?? undefined,
        since: args.filter?.since ?? undefined,
      },
      { limit: args.limit ?? 100, offset: args.offset ?? 0 },
    );
    return env.items;
  };
  ```

- [ ] **14.4** Run `pnpm --filter @recondo/data test -- anomalies` and `cd api && pnpm test -- anomaly`. Pass.

- [ ] **14.5** Commit.

**Commit message:** `refactor(data): hoist anomalies DB code into @recondo/data`

---

### Task 15: Promote `cost`, `audit`, `compliance`, `realtime`, `agents`, `reports`, `policies`, `keys` resolver DB code

**Files:**
- `packages/recondo-data/src/cost.ts` (NEW)
- `packages/recondo-data/src/audit.ts` (NEW)
- `packages/recondo-data/src/compliance.ts` (NEW)
- `packages/recondo-data/src/realtime.ts` (NEW)
- `packages/recondo-data/src/agents.ts` (NEW)
- `packages/recondo-data/src/reports.ts` (NEW)
- `packages/recondo-data/src/policies.ts` (NEW)
- `packages/recondo-data/src/keys.ts` (NEW)
- `packages/recondo-data/tests/cost.test.ts` (NEW)
- `packages/recondo-data/tests/audit.test.ts` (NEW)
- `packages/recondo-data/tests/compliance.test.ts` (NEW)
- `packages/recondo-data/tests/realtime.test.ts` (NEW)
- `packages/recondo-data/tests/agents.test.ts` (NEW)
- `packages/recondo-data/tests/reports.test.ts` (NEW)
- `packages/recondo-data/tests/policies.test.ts` (NEW)
- `packages/recondo-data/tests/keys.test.ts` (NEW)
- `api/src/resolvers/{cost,audit,compliance,realtime,agents,reports,policies,keys}.ts` (edits)

**Steps:**

- [ ] **15.1** This task is eight sub-iterations of the same mechanical move. Treat each domain as a separate sub-task with its own commit, but the recipe is identical:

  1. Read the resolver file.
  2. For each exported resolver function, identify the per-operation function name (`Query.usageSummary` → `getUsageSummary`, `Query.dailySpend` → `listDailySpend`, etc.). Use the `list*`/`get*` prefix convention for shape clarity (`list*` returns `ListEnvelope<T>` or `AsyncIterable<T>`, `get*` returns `T | null`).
  3. Move the SQL body into the corresponding `packages/recondo-data/src/<domain>.ts` function. Replace `ctx.apiKey` → explicit `apiKey: ApiKeyInfo` param. Replace `GraphQLError` → `DataValidationError`. Wrap returns in `uniformListEnvelope` for list-shape, plain return for single-record.
  4. For list functions where time-ordering is meaningful (`listAuditEvents`, `listRealtimeFeed`), add the same `since` cursor decoding shown in Task 14.
  5. Thin the resolver to a 5-10 line wrapper that argument-shuffles, calls the package function, materializes via `await Array.fromAsync(...)` if the package returns `AsyncIterable<T>` (vs `Promise<ListEnvelope<T>>`).
  6. Run that domain's API tests (`pnpm test -- <domain>`).
  7. Commit per domain.

- [ ] **15.2** **`cost.ts` specifics.** The cost resolvers use a shared `resolveDateRange` helper (private to `api/src/resolvers/cost.ts`). Move it into the package as an exported utility — both the API and MCP need it.

  Per-operation exports for cost:

  ```ts
  export async function getUsageSummary(apiKey, period, from, to, options): Promise<UsageSummary>;
  export async function listSpendByProvider(apiKey, period, from, to, options): Promise<ListEnvelope<SpendBucket>>;
  export async function listSpendByModel(apiKey, period, from, to, options): Promise<ListEnvelope<SpendBucket>>;
  export async function listSpendByFramework(apiKey, period, from, to, options): Promise<ListEnvelope<SpendBucket>>;
  export async function listDailySpend(apiKey, period, from, to, options): Promise<ListEnvelope<DailyBucket>>;
  export async function getCostProjections(apiKey, period, options): Promise<CostProjections>;
  export { resolveDateRange };
  ```

- [ ] **15.3** **`realtime.ts` specifics.** `realtime.ts` (667 lines) is the largest. It imports network code (`fetch` to `GATEWAY_METRICS_URL`) — that's a transport concern but specifically it's the gateway's metrics endpoint, which is data-layer-shaped (same domain object as DB stats). Keep it in the package; document it in `packages/recondo-data/src/realtime.ts`:

  ```ts
  // realtime.ts polls the gateway's Prometheus metrics endpoint to
  // augment DB-derived stats with live histogram data. The fetch URL
  // is configurable via GATEWAY_METRICS_URL. This is data-layer-shaped
  // (gateway stats are part of the operational data model) but it does
  // mean the package depends on global fetch — Node 20+ provides this.
  ```

  Per-operation exports:

  ```ts
  export async function getRealtimeStats(apiKey, options): Promise<RealtimeStats>;
  export function listRealtimeFeed(apiKey, filter, options): AsyncIterable<RealtimeFeedItem>;
  export async function getGatewayStatus(apiKey, options): Promise<GatewayStatus>;
  ```

- [ ] **15.4** **`audit.ts`, `compliance.ts`, `agents.ts`, `reports.ts`, `policies.ts`, `keys.ts`.** Same recipe. The mutation resolvers (`reports`, `policies`, `keys` have Mutation entries — `generateReport`, `createPolicy`, `deletePolicy`, `createApiKey`, `revokeApiKey`) move to the package as plain function exports (not async iterables — mutations always return a single record). Naming: `generateReport`, `createPolicy`, `updatePolicy`, `deletePolicy`, `createApiKey`, `revokeApiKey`.

  ```ts
  // packages/recondo-data/src/policies.ts
  export async function listPolicies(apiKey, filter, options): Promise<ListEnvelope<Policy>>;
  export async function getPolicy(apiKey, id, options): Promise<Policy | null>;
  export async function createPolicy(apiKey, input, options): Promise<Policy>;
  export async function updatePolicy(apiKey, id, input, options): Promise<Policy>;
  export async function deletePolicy(apiKey, id, options): Promise<{ id: string }>;
  ```

- [ ] **15.5** After each sub-task, the corresponding API resolver becomes ~30 lines of argument shuffling. Run `cd api && pnpm test -- <domain>` after each sub-task. Eight commits, one per domain.

**Commit messages (one per sub-iteration):**
- `refactor(data): hoist cost DB code into @recondo/data`
- `refactor(data): hoist audit DB code into @recondo/data`
- `refactor(data): hoist compliance DB code into @recondo/data`
- `refactor(data): hoist realtime DB code into @recondo/data`
- `refactor(data): hoist agents DB code into @recondo/data`
- `refactor(data): hoist reports DB code into @recondo/data`
- `refactor(data): hoist policies DB code into @recondo/data`
- `refactor(data): hoist API keys DB code into @recondo/data`

---

### Task 16: Wire the API `/v1/query` HTTP route to the per-operation exports

**Files:**
- `api/src/query/builder.ts` (edit)

**Steps:**

- [ ] **16.1** The `/v1/query` route is the one place where the HTTP request carries the `queryType` switch tag explicitly. The original `runQuery({queryType, ...})` pattern is preserved as a thin compatibility layer inside the package (`runStructuredQuery`, added in Task 11). The HTTP route stays in `api/src/query/builder.ts` because request validation, format-switching, and Fastify response shaping are transport concerns.

- [ ] **16.2** Replace the inline `executeQuery` switch in `builder.ts` with `runStructuredQuery` from the package. Pass through the Fastify request `AbortSignal`:

  ```ts
  // Inside handleQuery (Fastify handler):
  const ctrl = new AbortController();
  req.raw.on("close", () => ctrl.abort());

  const { rows, totalCount } = await Promise.race([
    runStructuredQuery(queryType, projectId, filters, groupBy, effectiveLimit, {
      signal: ctrl.signal,
    }),
    timeoutPromise(30_000),
  ]);
  ```

  `req.raw.on("close")` is Fastify's per-request socket close event — the abort propagates the cancellation down to `pool.query` (where applicable).

- [ ] **16.3** For the route handlers that *want* per-operation surfacing (the new `/v1/query/sessions`-style routes that Plan C may add — out of scope for this plan, but ensure the door is open), document the migration path in a comment at the top of `builder.ts`:

  ```ts
  /**
   * MIGRATION NOTE: New per-domain routes should call the named exports
   * (listStructuredSessions, listStructuredAnomalies, ...) directly and
   * materialize the AsyncIterable via `await Array.fromAsync(...)`. The
   * runStructuredQuery dispatcher exists for the legacy /v1/query?queryType=
   * route only and may be deprecated in v2 once all callers migrate.
   */
  ```

- [ ] **16.4** Run `cd api && pnpm test -- query-builder`. All pass — the HTTP-shape behavior is identical.

- [ ] **16.5** Commit.

**Commit message:** `refactor(api): wire /v1/query through @recondo/data exports`

---

### Task 17: Eliminate or pin the API resolver shim files

**Files:**
- `api/src/auth.ts` (verify)
- `api/src/db.ts` (verify)
- `api/src/placeholder-mask.ts` (verify)
- `api/src/resolvers/mappers.ts` (verify)

**Steps:**

- [ ] **17.1** Audit each shim file. They exist because earlier tasks added them defensively to keep imports working — but if every consumer has been updated to import from `@recondo/data` directly, the shims are dead code.

- [ ] **17.2** Run `cd api && grep -r "from \"./db.js\"\|from \"../db.js\"" src/`. For each match, update it to `from "@recondo/data"`. Same for `auth.js`, `placeholder-mask.js`, `resolvers/mappers.js`.

- [ ] **17.3** Once no in-tree consumer references the shim, replace each shim's body with a deprecation comment and re-export only:

  ```ts
  // DEPRECATED: this shim exists for any external scripts that still
  // import api/src/db.ts directly. New code MUST import from
  // "@recondo/data". Remove this file once we confirm no out-of-tree
  // consumer (deploy scripts, ad-hoc tools) depends on it.
  export { getPool, closePool, checkDatabaseHealth } from "@recondo/data";
  ```

  We don't delete the shims in this plan — Plan C or a follow-up may remove them. Pinning them as DEPRECATED is the lockable boundary.

- [ ] **17.4** Run `cd api && pnpm exec tsc --noEmit`. Clean.

- [ ] **17.5** Commit.

**Commit message:** `refactor(api): mark legacy shims as deprecated, point all consumers at @recondo/data`

---

### Task 18: Document `Array.fromAsync` materialization pattern in API resolvers

**Files:**
- `api/src/resolvers/README.md` (NEW)

**Steps:**

- [ ] **18.1** Per spec § "Streaming preparation" commitment 2: the API materializes via `Array.fromAsync` because GraphQL has no `@defer`/`@stream` natively. This pattern is non-obvious to a future reader looking at a one-line resolver — they'll wonder why we added `AsyncIterable` overhead at all.

  Create `api/src/resolvers/README.md` (≤ 30 lines, no code beyond the canonical example):

  ```markdown
  # API Resolvers — Architecture Note

  Every resolver in this directory is a thin transport adapter over
  `@recondo/data`. The data-layer functions return `AsyncIterable<T>`
  (for list-shape reads) or `Promise<T | null>` (for single-record
  reads). Resolvers shape the return value into the GraphQL schema's
  expected shape and translate `DataValidationError` into `GraphQLError`.

  ## Why AsyncIterable?

  Per the streaming-prep commitments (see
  `docs/superpowers/specs/2026-05-04-tui-and-mcp-design.md` §
  "Streaming preparation"), the data layer is shaped for v1.5 streaming
  *now* even though v1 ships polling-only. GraphQL has no `@defer` /
  `@stream` directives in our stack, so we materialize:

  ```ts
  import { searchTurns } from "@recondo/data";

  const searchResolver: NonNullable<QueryResolvers["search"]> = async (
    _parent, args, ctx,
  ) => {
    return await Array.fromAsync(
      searchTurns(ctx.apiKey, args.query, args.projectId ?? null, {
        limit: 100,
      }),
    );
  };
  ```

  v1 cost is ~zero (`for await` over an in-memory generator is one
  function-call deeper than a direct return). v1.5 streaming
  consumers (MCP) chunk the same iterable into progress notifications.

  ## AbortSignal

  `ctx` does not carry a per-request `AbortSignal` from Apollo Server v4
  in our setup. Pass `{}` (no signal) for now; threading is a v1.5
  follow-up. The Fastify HTTP route at `api/src/query/builder.ts` *does*
  thread `req.raw.on("close")` → `AbortController.abort()` → data layer.
  ```

- [ ] **18.2** Add a one-line entry to the project-root `CLAUDE.md` under "Architecture":

  ```
  - **Data layer:** `@recondo/data` (workspace package at `packages/recondo-data/`) — see `api/src/resolvers/README.md` for the resolver-adapter pattern.
  ```

- [ ] **18.3** No tests required (documentation only).

- [ ] **18.4** Commit.

**Commit message:** `docs(api): document Array.fromAsync materialization pattern`

---

### Task 19: Add a TypeScript-level "no transport imports" guard to the package

**Files:**
- `packages/recondo-data/scripts/check-no-transport-imports.mjs` (NEW)
- `packages/recondo-data/package.json` (edit)

**Steps:**

- [ ] **19.1** Per the architecture statement, `@recondo/data` must never import `graphql`, `fastify`, `@apollo/server`, `@modelcontextprotocol/sdk`, `express`, or any other transport-shaped library. We need a CI lint that fails the build if anyone adds such an import.

  Create `packages/recondo-data/scripts/check-no-transport-imports.mjs`:

  ```js
  #!/usr/bin/env node
  // Architecture lint: @recondo/data must own zero transport surface.
  // Mirror of the gateway's xtask `lint-arch` for the TypeScript side.
  import { readFileSync, readdirSync, statSync } from "node:fs";
  import { resolve, join } from "node:path";

  const FORBIDDEN = [
    "graphql",
    "@apollo/server",
    "@as-integrations/fastify",
    "fastify",
    "express",
    "@modelcontextprotocol/sdk",
    "ws",
  ];

  const SRC = resolve(import.meta.dirname, "..", "src");

  function* walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) yield* walk(full);
      else if (full.endsWith(".ts")) yield full;
    }
  }

  const offenders = [];
  for (const file of walk(SRC)) {
    const src = readFileSync(file, "utf8");
    for (const dep of FORBIDDEN) {
      const re = new RegExp(
        `(?:from\\s+["']${dep.replace(/[.@/]/g, "\\$&")}["']|require\\(["']${dep.replace(/[.@/]/g, "\\$&")}["']\\))`,
      );
      if (re.test(src)) {
        offenders.push({ file, dep });
      }
    }
  }

  if (offenders.length > 0) {
    console.error("@recondo/data: transport-layer imports detected (forbidden):");
    for (const o of offenders) {
      console.error(`  ${o.file} → ${o.dep}`);
    }
    console.error(
      "\nThe package owns nothing transport-shaped (no HTTP, no GraphQL, no MCP).\n" +
      "Move the transport-touching code into the consumer (api/src or mcp/src).",
    );
    process.exit(1);
  }
  console.log("@recondo/data: no transport imports detected");
  ```

- [ ] **19.2** Wire into the package's test script:

  ```json
  "scripts": {
    "build": "tsc",
    "test": "node scripts/check-no-transport-imports.mjs && vitest run",
    "lint:arch": "node scripts/check-no-transport-imports.mjs",
    "test:watch": "vitest"
  }
  ```

- [ ] **19.3** Run `pnpm --filter @recondo/data run lint:arch`. Should pass on a clean tree. If it flags anything, that import was missed in the refactor — fix it.

- [ ] **19.4** Add a line to the root `justfile`:

  ```
  data-lint-arch:
      pnpm --filter @recondo/data run lint:arch
  ```

- [ ] **19.5** Commit.

**Commit message:** `chore(data): lint @recondo/data for forbidden transport imports`

---

### Task 20: Add a smoke-level integration test that proves the package works end-to-end

**Files:**
- `packages/recondo-data/tests/smoke.test.ts` (NEW)

**Steps:**

- [ ] **20.1** A single test file that imports every exported function from `@recondo/data` and exercises one happy path per major operation. Catches regressions where a refactor accidentally drops an export.

  ```ts
  import { describe, it, expect, afterAll } from "vitest";
  import * as data from "../src/index.js";
  import type { ApiKeyInfo } from "../src/types.js";

  const adminKey: ApiKeyInfo = { id: "test", projectId: null, rateLimitRpm: 1000 };

  afterAll(async () => { await data.closePool(); });

  describe("@recondo/data: surface smoke", () => {
    it("exports the documented public API", () => {
      // Pool
      expect(typeof data.getPool).toBe("function");
      expect(typeof data.closePool).toBe("function");
      expect(typeof data.checkDatabaseHealth).toBe("function");
      // Auth
      expect(typeof data.authenticateApiKey).toBe("function");
      expect(typeof data.authenticateRequest).toBe("function");
      // Envelope + cursor
      expect(typeof data.encodeSinceCursor).toBe("function");
      expect(typeof data.decodeSinceCursor).toBe("function");
      expect(typeof data.uniformListEnvelope).toBe("function");
      // Async-iter
      expect(typeof data.rowsToAsyncIterable).toBe("function");
      expect(typeof data.abortableIterable).toBe("function");
      // Per-domain readers
      expect(typeof data.listSessions).toBe("function");
      expect(typeof data.getSession).toBe("function");
      expect(typeof data.getTurn).toBe("function");
      expect(typeof data.searchTurns).toBe("function");
      expect(typeof data.listAnomalies).toBe("function");
      expect(typeof data.getUsageSummary).toBe("function");
      expect(typeof data.listSpendByProvider).toBe("function");
      expect(typeof data.listAuditEvents).toBe("function");
      expect(typeof data.listComplianceFindings).toBe("function");
      expect(typeof data.getRealtimeStats).toBe("function");
      expect(typeof data.listRealtimeFeed).toBe("function");
      expect(typeof data.listAgentActivity).toBe("function");
      expect(typeof data.listReports).toBe("function");
      expect(typeof data.listPolicies).toBe("function");
      expect(typeof data.listApiKeys).toBe("function");
      // Mutations
      expect(typeof data.generateReport).toBe("function");
      expect(typeof data.createPolicy).toBe("function");
      expect(typeof data.deletePolicy).toBe("function");
      expect(typeof data.createApiKey).toBe("function");
      expect(typeof data.revokeApiKey).toBe("function");
      // Structured query
      expect(typeof data.runStructuredQuery).toBe("function");
      expect(typeof data.listStructuredSessions).toBe("function");
      expect(typeof data.listStructuredAnomalies).toBe("function");
      // Redaction
      expect(typeof data.maskPlaceholderPaths).toBe("function");
      expect(typeof data.redaction.maskPlaceholderPaths).toBe("function");
    });

    it("listSessions + getSession can run against a live DB", async () => {
      const env = await data.listSessions(adminKey, {}, { limit: 1 });
      expect(env.is_final).toBe(true);
      expect(env.stream_id).toBeNull();
      if (env.items.length > 0) {
        const s = await data.getSession(adminKey, (env.items[0] as { id: string }).id);
        expect(s).not.toBeNull();
      }
    });
  });
  ```

- [ ] **20.2** Run `pnpm --filter @recondo/data test -- smoke`. Pass.

- [ ] **20.3** If this fails because some export name was different, fix the export name to match the test (the test is the spec for the public surface). Adjust API resolvers in tandem.

- [ ] **20.4** Commit.

**Commit message:** `test(data): add public-surface smoke test`

---

### Task 21: Type-level test for the AbortSignal contract

**Files:**
- `packages/recondo-data/tests/types.test-d.ts` (NEW)
- `packages/recondo-data/package.json` (edit, add `tsd` or use `vitest` typecheck)

**Steps:**

- [ ] **21.1** Per the v1 acceptance criteria: "type-level tests verify `AbortSignal` parameter on every exported `recondo-data` function." Vitest supports type-only tests via `expect-type` — add it as a devDep, then write a test that fails to compile if any read function loses its `signal?: AbortSignal` parameter.

  Add to `packages/recondo-data/package.json`:

  ```json
  "devDependencies": {
    ...
    "expect-type": "^0.20.0"
  }
  ```

- [ ] **21.2** Create `packages/recondo-data/tests/types.test-d.ts`:

  ```ts
  import { expectTypeOf } from "expect-type";
  import {
    listSessions, getSession,
    getTurn, searchTurns,
    listAnomalies,
    getUsageSummary, listSpendByProvider, listSpendByModel,
    listSpendByFramework, listDailySpend, getCostProjections,
    listAuditEvents,
    listComplianceFindings,
    getRealtimeStats, listRealtimeFeed, getGatewayStatus,
    listAgentActivity,
    listReports, getReport, generateReport,
    listPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy,
    listApiKeys, createApiKey, revokeApiKey,
    runStructuredQuery,
    listStructuredSessions, listStructuredTurns, listStructuredAnomalies,
    listStructuredCost, listStructuredTools, listStructuredRisk,
    listStructuredCompliance, listStructuredProvenance,
    authenticateApiKey,
  } from "../src/index.js";

  // Every exported function accepts options with optional AbortSignal.
  // Fails to compile if anyone removes the parameter.
  expectTypeOf(listSessions).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
  expectTypeOf(getSession).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
  expectTypeOf(getTurn).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
  expectTypeOf(searchTurns).parameter(3).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
  expectTypeOf(listAnomalies).parameter(2).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
  expectTypeOf(getUsageSummary).parameter(4).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
  expectTypeOf(listSpendByProvider).parameter(4).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
  // ... one assertion per exported function ...
  expectTypeOf(authenticateApiKey).parameter(1).toMatchTypeOf<{ signal?: AbortSignal } | undefined>();
  ```

- [ ] **21.3** Run `pnpm --filter @recondo/data exec tsc --noEmit`. Compile must succeed (test passes by virtue of compiling).

- [ ] **21.4** If any function fails the type assertion, fix the function signature. Do not adjust the test — the test is the contract.

- [ ] **21.5** Commit.

**Commit message:** `test(data): assert every export accepts optional AbortSignal`

---

### Task 22: Verify CI tooling and update justfile

**Files:**
- `justfile` (edit)

**Steps:**

- [ ] **22.1** Add new recipes for the data package and the workspace-wide pipeline:

  ```
  # Data package
  data-build:
      pnpm --filter @recondo/data build

  data-test:
      pnpm --filter @recondo/data test

  data-lint-arch:
      pnpm --filter @recondo/data run lint:arch

  # Workspace
  ws-install:
      pnpm install

  ws-build:
      pnpm -r build

  ws-test:
      pnpm -r test

  check-versions:
      node scripts/version-check.mjs
  ```

- [ ] **22.2** Update the existing `api-dev` and `api-test` recipes if they reference paths inside `api/` directly — they continue to work (the `cd api && ...` form is unaffected by the workspace).

- [ ] **22.3** Update `just ci` if it exists to include the data-package suite. Otherwise add:

  ```
  ci-typescript: ws-install data-lint-arch check-versions ws-build ws-test
  ```

- [ ] **22.4** Run `just ci-typescript`. Everything passes.

- [ ] **22.5** Commit.

**Commit message:** `chore: add justfile recipes for @recondo/data + workspace pipeline`

---

### Task 23: Acceptance gate — run the full API test suite, verify zero new failures

**Files:** none

**Steps:**

- [ ] **23.1** Per the spec acceptance: *"existing dashboard tests continue to pass after the refactor."* Run the full API test suite from a clean state:

  ```bash
  cd /Users/andmer/Projects/recondo
  pnpm install
  pnpm --filter @recondo/data build
  pnpm --filter @recondo/data test
  cd api && pnpm test
  ```

  **Required:** every test that passed on `main` before this branch must still pass. Zero new failures, zero new flakes.

- [ ] **23.2** Compare counts. On `main`: `cd api && pnpm test 2>&1 | tail -20` — record the pass count. After the refactor branch: same command — pass count must be ≥ the baseline (it can be higher if Task 21 added new package-side tests; it must NOT be lower for the API suite specifically).

- [ ] **23.3** Run the dashboard test suite if one exists: `cd dashboard && pnpm test`. The dashboard talks to the API via GraphQL — its test suite is the closest thing we have to an end-to-end "no behavioral regression" check. Zero new failures.

- [ ] **23.4** If any failure surfaces:
  - **Diff isolation:** check if the failing test references a specific resolver that was thinned in this plan. Re-read the corresponding `packages/recondo-data/src/<domain>.ts` against the original `api/src/resolvers/<domain>.ts` and identify the dropped line.
  - **Regression types to look for:** missing `mapSession` field, dropped `apiKey.projectId` scoping clause, lost `args.filter?.X` argument shuffle, an envelope `total` that no longer matches the count query, an `AsyncIterable` consumed twice (which would silently return empty the second time).
  - Fix in the package, re-run.

- [ ] **23.5** Once the full suite is green, write a short verification note in the commit body confirming the test counts. Commit.

**Commit message:**

```
test: verify @recondo/data extraction has zero behavioral regressions

API suite: <N> tests passing (baseline: <N>)
Dashboard suite: <M> tests passing (baseline: <M>)
@recondo/data suite: <K> new tests passing (smoke + per-domain + type-level)

Closes Plan B (recondo-data extraction). Plan C extends the package
with new operations (compareTurns, findSimilarPrompts, raw-byte
chunking) and the full secret-pattern redaction module. Plan D adds
the MCP service as a sibling consumer.
```

---

## Acceptance Gate Summary

This plan is complete when:

1. `packages/recondo-data/` exists with the public surface enumerated in Task 20.
2. Every API resolver in `api/src/resolvers/*.ts` is a thin transport adapter that calls into `@recondo/data`. No `pool.query(...)` SQL string lives in any resolver file.
3. `api/src/db.ts`, `api/src/auth.ts`, `api/src/placeholder-mask.ts`, `api/src/resolvers/mappers.ts` are deprecated re-export shims pointing at `@recondo/data`.
4. `pnpm-workspace.yaml` exists; `pnpm install` from the repo root links the package to the API.
5. `scripts/version-check.mjs` enforces lockstep versions across consumers.
6. `packages/recondo-data/scripts/check-no-transport-imports.mjs` passes (no `graphql`, `fastify`, `@apollo/server`, `@modelcontextprotocol/sdk` imports inside the package).
7. Every exported async function in `@recondo/data` accepts an optional `AbortSignal` (verified by `tests/types.test-d.ts`).
8. Every list-shape return is wrapped in `uniformListEnvelope({ items, next_offset, truncated, stream_id: null, is_final: true })`.
9. Every read function returns `AsyncIterable<Item>` or `Promise<ListEnvelope<T>>`; the API resolvers materialize via `Array.fromAsync` where needed.
10. List functions for time-ordered domains (`listAnomalies`, `listAuditEvents`, `listRealtimeFeed`, `listSessions`, `listComplianceFindings` audit-log view) accept an opaque `since` cursor decoded via `decodeSinceCursor`. `searchTurns` uses `offset` only (per spec).
11. **The full API test suite passes with zero new failures relative to the pre-refactor baseline.**
12. The dashboard test suite passes unchanged.

Out of scope (deferred to Plan C / Plan D):

- New analytical functions (`compareTurns`, `findSimilarPrompts`, `relatedTurns`, `sessionEfficiency`, `toolCallStats`, `getTurnRawMetadata`, `getTurnRawChunk`).
- Full secret-pattern redaction module (Anthropic admin keys, AWS, GCP, GitHub PAT variants, Stripe, Slack/Discord webhooks, Bearer tokens, JWTs, PEM, DB connection strings, `.env` fragments, byte-framing-preserving raw-byte redaction).
- The MCP service itself.
- True streaming behavior — only the *shape* lands in this plan; v1.5 wires the streaming transport adapter on top of the unchanged `AsyncIterable` returns.
