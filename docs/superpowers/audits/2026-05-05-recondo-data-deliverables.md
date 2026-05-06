# `@recondo/data` Extraction — Deliverables Checklist (2026-05-05)

> Source artifact for the adversarial-workflow run on `docs/superpowers/plans/2026-05-04-B-recondo-data-extraction.md`. Every line here is an externally-observable property the spec promises. Each must have at least one **pipeline test** that drives a real consumer path and asserts on observable behavior — not a unit test of an isolated function.

## What "pipeline test" means for THIS plan

This plan is a **refactor**, not a feature. The user-visible behavior is unchanged. The deliverables are architectural invariants enforced by:

1. **Behavior-parity gate**: the existing `cd api && pnpm test` suite passes with the same count as the pre-refactor baseline. Component-level resolver tests are exactly the right "pipeline test" for behavior parity — they hit real GraphQL operations against a live PG. Reusing them is non-negotiable.
2. **Contract tests**: new properties (AsyncIterable, AbortSignal, uniform envelope, since cursor, no-transport-imports, version-lockstep) need NEW tests in `packages/recondo-data/tests/` that drive the package's exported functions through the contract.
3. **Public-surface smoke**: a single test that imports every documented export and asserts shape, catching regressions where a refactor accidentally drops or renames an export.
4. **Type-level tests**: `expect-type` assertions verifying every async export accepts `{ signal?: AbortSignal }`.

## Phantom-wiring red flags specific to this run (lessons from TUI v1)

Hunt these:

- **Exported function with zero importer**: every export from `@recondo/data` must be imported by either the API, a sibling package, or a contract test. (Smoke test catches this for documented exports; smoke test must be exhaustive.)
- **`AbortSignal` parameter accepted but never checked**: a function takes `{ signal }` but never calls `signal.aborted` and never `Promise.race`s against it. Pipeline test: pass an `AbortController.abort()`-ed signal, expect `AbortError`. Without that assertion, it's phantom.
- **`since` cursor decoded but never producing a `WHERE timestamp >` clause**: `decodeSinceCursor` runs but the SQL doesn't change. Pipeline test: assert the underlying SQL contains the cursor's `ts` (via mock-pg or by decoding the `pool.query` first arg in a spy).
- **`uniformListEnvelope` returned but `next_offset`/`truncated` always wrong**: a function wraps in the envelope but `truncated: false` even when the row count exceeds limit. Pipeline test: query with limit=1 against a known multi-row dataset, assert `truncated: true` and `next_offset !== null`.
- **`DataValidationError` thrown but resolver doesn't convert to `GraphQLError`**: package-internal error type leaks through HTTP. Pipeline test: invalid input via GraphQL, assert response body has `extensions.code` set, NOT `DataValidationError` in the message.
- **Re-export shim with no consumer**: `api/src/db.ts` becomes a shim, but if no in-tree code imports it, it's dead. Step 5.5 grep + reachability check.
- **Move was incomplete**: the test file imports from `packages/recondo-data/src/sessions.js` and passes, BUT the resolver still has inline `pool.query(...)`. The behavior parity test passes (because the inline path still works) and the new test passes (because the new path works) — but the refactor didn't actually finish. **Defense: the resolver file must be ≤ N lines and contain zero `pool.query(` matches** after the move. Add a per-task line-count + grep gate.
- **Workspace protocol drift**: API declares `"@recondo/data": "0.0.1"` instead of `"workspace:*"` after a manual edit. `version-check.mjs` catches it; ensure it runs in CI.
- **Transport imports leak into package**: someone adds `import { GraphQLError } from "graphql"` to `packages/recondo-data/src/sessions.ts`. `check-no-transport-imports.mjs` catches it.

---

## Chunk plan (10 chunks)

| Chunk | Plan tasks | Scope |
|-------|-----------|-------|
| **C1** | 1, 2, 3, 19 | Foundation: pnpm workspace, package skeleton, version-lockstep, transport-import lint |
| **C2** | 4, 5, 6, 7, 8 | Primitives: pool, types, envelope, async-iter, redaction. Includes `since` cursor and `AbortSignal` adapters. |
| **C3** | 9, 10 | Auth (`authenticateApiKey` with AbortSignal) + mappers |
| **C4** | 11 | Structured query split: `/v1/query` per-operation exports |
| **C5** | 12, 13 | Sessions + Turns (largest two resolvers) |
| **C6** | 14, 15a-c | Anomalies + Cost + Audit |
| **C7** | 15d-g | Compliance + Realtime + Agents + Reports |
| **C8** | 15h + mutations | Policies + Keys (incl. mutations) |
| **C9** | 16, 17, 18 | HTTP wiring through package, shim deprecation, docs |
| **C10** | 20, 21, 22, 23 | Public-surface smoke, type-level tests, justfile, acceptance gate |

After C10 → fresh Step 5.5 audit + Step 6 CI.

---

## Chunk 1 — Foundation

- [ ] **D-F1**: `pnpm install` from repo root succeeds; `packages/recondo-data` shows up as a workspace package via `pnpm list -r --depth -1`.
- [ ] **D-F2**: `pnpm --filter @recondo/data build` succeeds with empty barrel `dist/index.js`.
- [ ] **D-F3**: `node scripts/version-check.mjs` exits 0 when `api/package.json` declares `"@recondo/data": "workspace:*"`; exits non-zero when it declares a literal version that drifts from `packages/recondo-data/package.json`'s `version`. Pipeline test: a script-level test fixture (`scripts/version-check.test.mjs` or vitest in repo-root) that mutates a temp `api/package.json` and asserts script exit codes.
- [ ] **D-F4**: `node packages/recondo-data/scripts/check-no-transport-imports.mjs` exits 0 on a clean tree; exits non-zero when any `tui/src/*.ts` (mistype — `packages/recondo-data/src/*.ts`) contains `from "graphql"` etc. Pipeline test: temp file with the forbidden import, assert exit code 1 and the offending file in stderr.

## Chunk 2 — Primitives

- [ ] **D-P1**: `getPool() === getPool()` (singleton) — covered by `pool.test.ts`.
- [ ] **D-P2**: `checkDatabaseHealth()` returns `true` against a live `recondo_test` DB.
- [ ] **D-P3**: `closePool()` is idempotent and the next `getPool()` returns a fresh pool. (Edge case: tests must not stomp each other.)
- [ ] **D-P4**: `encodeSinceCursor({ts, id})` ↔ `decodeSinceCursor` round-trips (already in plan).
- [ ] **D-P5**: `decodeSinceCursor` rejects non-base64url, malformed JSON, and payloads missing `ts` or `id`.
- [ ] **D-P6**: `uniformListEnvelope([], {nextOffset: null, truncated: false})` produces `{items, next_offset: null, truncated: false, stream_id: null, is_final: true}`.
- [ ] **D-P7**: `rowsToAsyncIterable([1,2,3])` materializes via `Array.fromAsync` to `[1,2,3]`.
- [ ] **D-P8**: `abortableIterable(inner, signal)` throws `AbortError` when signal fires mid-iteration; passes through when signal never fires; throws immediately if signal is already aborted.
- [ ] **D-P9** (phantom-wiring guard): the package's `abortableIterable` IS used by per-domain functions to honor caller-provided signals. Step 5.5 must trace at least 3 call sites.
- [ ] **D-P10**: `placeholder-mask.test.ts` (moved from `api/tests/`) passes from the new location.
- [ ] **D-P11** (file resolution): `placeholder-mask.ts` finds `shared/placeholder-prefixes.json` from BOTH the dist path AND the src path (path-walk extended in plan task 8.1).

## Chunk 3 — Auth + Mappers

- [ ] **D-A1**: `authenticateApiKey(token, options)` returns `null` for missing/malformed/unknown/revoked tokens.
- [ ] **D-A2**: `authenticateApiKey("wrt_validkey", {})` returns `{id, projectId, rateLimitRpm}` against a seeded test key.
- [ ] **D-A3**: `authenticateApiKey("wrt_x", {signal: alreadyAbortedSignal})` rejects with `AbortError` BEFORE issuing a query (assert via timing or by spying on `pool.query`).
- [ ] **D-A4**: `authenticateRequest("Bearer wrt_x", ...)` is a thin wrapper over `authenticateApiKey`. Reject non-Bearer headers.
- [ ] **D-A5** (parity): `cd api && pnpm test -- auth` passes with the same count as baseline.
- [ ] **D-M1**: `mapSession`, `mapTurn`, `mapAnomaly`, `escapeIlike`, `formatTimestamp` exported and importable from `@recondo/data`.
- [ ] **D-M2** (parity): `cd api && pnpm test` mappers-related count preserved.

## Chunk 4 — Structured Query

- [ ] **D-Q1**: 8 per-operation exports exist: `listStructuredSessions`, `listStructuredTurns`, `listStructuredAnomalies`, `listStructuredCost`, `listStructuredTools`, `listStructuredRisk`, `listStructuredCompliance`, `listStructuredProvenance`.
- [ ] **D-Q2**: each per-operation function returns `AsyncIterable<row>`. `Array.fromAsync` materializes correctly.
- [ ] **D-Q3**: each per-operation function rejects with `AbortError` when called with an aborted signal.
- [ ] **D-Q4**: `runStructuredQuery("anomalies", projectId, filters, undefined, 10)` returns `{rows, totalCount}` (legacy compat path for `/v1/query` HTTP route).
- [ ] **D-Q5** (move-completeness): `api/src/query/builder.ts` no longer contains the 8 inline `queryXxx` functions (grep returns zero matches for `function querySessions`, etc.). The file is ≤ ~250 lines (down from 1110).
- [ ] **D-Q6** (parity): `cd api && pnpm test -- query-builder` passes unchanged.

## Chunk 5 — Sessions + Turns

- [ ] **D-S1**: `listSessions(apiKey, filter, options)` returns `Promise<ListEnvelope<SessionListItem>>`; envelope has `items`, `next_offset`, `truncated`, `stream_id: null`, `is_final: true`, `total: number`.
- [ ] **D-S2**: project scoping — `apiKey.projectId === null` returns sessions from all projects; `apiKey.projectId === "p_x"` returns ONLY sessions where `s.project_id = 'p_x'`. Test with two seeded projects.
- [ ] **D-S3**: `filter.search` longer than 500 chars throws `DataValidationError`.
- [ ] **D-S4**: `listSessions` honors `AbortSignal` (rejects with `AbortError` when signal fires).
- [ ] **D-S5**: `getSession(apiKey, "non-existent")` returns `null`.
- [ ] **D-S6**: `getSession(apiKey, validId)` returns the same shape as `mapSession(...)` produced before the refactor (compare against the GraphQL response from a known seeded session).
- [ ] **D-S7**: `listUserTurns(sessionId)` returns the array (NOT envelope — child collection).
- [ ] **D-S8**: `searchTurns(apiKey, query > 500 chars, ...)` throws `DataValidationError` synchronously (NOT deferred-rejection).
- [ ] **D-S9**: `searchTurns` returns `AsyncIterable<TurnRow>`; `Array.fromAsync` materializes.
- [ ] **D-S10**: `searchTurns` honors `AbortSignal` mid-iteration.
- [ ] **D-S11**: `getTurn(apiKey, validId)` returns mapped turn; non-existent returns `null`.
- [ ] **D-S12** (move-completeness): `api/src/resolvers/sessions.ts` and `turns.ts` together contain ZERO `pool.query(` matches. Resolvers ≤ ~80 lines each.
- [ ] **D-S13** (error conversion): GraphQL request with `search: "x".repeat(501)` returns a `GraphQLError` with `extensions.code === "BAD_USER_INPUT"`, NOT a leaked `DataValidationError`. Pipeline test driving the actual GraphQL endpoint.
- [ ] **D-S14** (parity): `cd api && pnpm test -- sessions` and `pnpm test -- turns` pass with same count as baseline.

## Chunk 6 — Anomalies + Cost + Audit

- [ ] **D-AN1**: `listAnomalies` returns `Promise<ListEnvelope<AnomalyRow>>` with project scoping.
- [ ] **D-AN2** (since cursor): `listAnomalies(apiKey, {since: encodedCursor}, ...)` produces a SQL query with `WHERE a.detected_at > $N AND (a.detected_at > $N OR a.id > $M)` (tie-break on id). Verify by spying on `pool.query` first arg.
- [ ] **D-AN3** (since backward-compat): `listAnomalies(apiKey, {since: "2026-04-01T00:00:00Z"}, ...)` (raw ISO date) STILL works — the implementation must heuristically detect base64url-vs-ISO.
- [ ] **D-CO1**: 6 cost exports exist: `getUsageSummary`, `listSpendByProvider`, `listSpendByModel`, `listSpendByFramework`, `listDailySpend`, `getCostProjections`. Plus `resolveDateRange` utility.
- [ ] **D-CO2**: each exported function honors AbortSignal.
- [ ] **D-CO3** (parity): `cd api && pnpm test -- cost` passes unchanged.
- [ ] **D-AU1**: `listAuditEvents` returns envelope with `since` cursor support (time-ordered).
- [ ] **D-AU2** (parity): `cd api && pnpm test -- audit` unchanged.

## Chunk 7 — Compliance + Realtime + Agents + Reports

- [ ] **D-CP1**: `listComplianceFindings` returns envelope; passes parity tests.
- [ ] **D-RT1**: `getRealtimeStats` returns single record (NOT envelope); honors signal.
- [ ] **D-RT2**: `listRealtimeFeed` returns `AsyncIterable<RealtimeFeedItem>` with `since` cursor support.
- [ ] **D-RT3**: `getGatewayStatus` returns single record.
- [ ] **D-RT4** (parity): `cd api && pnpm test -- realtime` unchanged.
- [ ] **D-AG1**: `listAgentActivity` returns envelope; parity test passes.
- [ ] **D-RP1**: `listReports` envelope; `getReport` single; `generateReport` mutation returns single record.

## Chunk 8 — Policies + Keys + Mutations

- [ ] **D-PO1**: 5 policy exports: `listPolicies, getPolicy, createPolicy, updatePolicy, deletePolicy`. Mutations return single records.
- [ ] **D-KE1**: 3 key exports: `listApiKeys, createApiKey, revokeApiKey`. Mutations return single records.
- [ ] **D-PO2/D-KE2** (parity): API tests for policies/keys unchanged.

## Chunk 9 — HTTP wiring + shims + docs

- [ ] **D-HT1**: `/v1/query` Fastify route calls `runStructuredQuery` (not inline switch).
- [ ] **D-HT2**: `req.raw.on("close")` aborts the underlying SQL query (verified by spy on `pool.query` cancel path OR by integration test that cancels mid-flight).
- [ ] **D-SH1**: `api/src/db.ts`, `api/src/auth.ts`, `api/src/placeholder-mask.ts`, `api/src/resolvers/mappers.ts` are 1-line re-export shims marked `// DEPRECATED`.
- [ ] **D-SH2**: `grep -r "from \"./db.js\"\|from \"../db.js\"" api/src/` returns ZERO matches (all in-tree consumers updated to `from "@recondo/data"`).
- [ ] **D-DC1**: `api/src/resolvers/README.md` exists and documents the `Array.fromAsync` materialization pattern + the `AbortSignal` v1.5 follow-up.
- [ ] **D-DC2**: `CLAUDE.md` mentions `@recondo/data` under "Architecture".

## Chunk 10 — Smoke + types + acceptance

- [ ] **D-SM1**: `tests/smoke.test.ts` imports the FULL public surface and asserts each is `typeof === "function"` (or correct shape). Lists every name documented in plan task 20.1 — exhaustively.
- [ ] **D-SM2**: smoke test runs `listSessions` end-to-end against live PG and asserts `is_final: true`, `stream_id: null`.
- [ ] **D-TY1**: `tests/types.test-d.ts` uses `expect-type` to assert EVERY exported async function's last param is `{ signal?: AbortSignal } | undefined`. Fails to compile if any function loses the parameter.
- [ ] **D-JF1**: `justfile` recipes `data-build`, `data-test`, `data-lint-arch`, `ws-install`, `ws-build`, `ws-test`, `check-versions`, `ci-typescript` exist and work.
- [ ] **D-AC1** (acceptance gate): `cd api && pnpm test` pass count ≥ pre-refactor baseline. Document baseline in commit body.
- [ ] **D-AC2**: `cd dashboard && pnpm test` (if exists) passes unchanged.
- [ ] **D-AC3**: `pnpm --filter @recondo/data test` passes (smoke + per-domain + envelope + cursor + auth + structured + types).
- [ ] **D-AC4**: `pnpm --filter @recondo/data run lint:arch` passes.
- [ ] **D-AC5**: `node scripts/version-check.mjs` passes.

---

## Step 5.5 mandatory checks (final audit)

1. **Public-surface trace**: every named export from `packages/recondo-data/src/index.ts` has at least one importer in `api/src/` (or in a test). Greps for each.
2. **AbortSignal honor**: every exported async function that accepts `{signal}` either (a) calls `signal?.aborted` early, OR (b) `Promise.race`s the work against signal abort, OR (c) passes the signal through to `abortableIterable`. Trace each.
3. **`since` cursor honor**: every list function that documents `since` support actually decodes and produces a `WHERE timestamp >` clause. Read the SQL.
4. **No transport imports**: `lint:arch` script still passes.
5. **Shim deprecation**: every shim file has the `DEPRECATED` comment and re-exports only.
6. **Move completeness**: `grep -rn "pool.query(" api/src/resolvers/` returns ZERO matches (or all matches are in DataLoaders, which are explicitly kept in API).
7. **API parity**: pre/post test counts match.
8. **Removal test**: pick 5 new exports, ask "if I deleted this, what fails?" Smoke test catches missing exports; per-domain tests catch wrong behavior; type-level catches missing AbortSignal.
