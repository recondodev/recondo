# `recondo-mcp` v1 Hardening — Adversarial-Workflow Orchestration Prompt

> Self-contained orchestration document. Drives a 6-group hardening pass that addresses all 32 issues surfaced by the post-v1 audit. Use this as the prompt for the next session — it is written to be picked up cold with zero prior context.

---

## How to use this document

1. **Read `docs/superpowers/audits/2026-05-06-mcp-server-v1-orchestration.md` Sections "Lessons learned" and "Per-chunk dispatch templates" first.** All 18 lessons + the Test Writer / Implementer / Reviewer templates from the v1 run apply to this run unchanged.

2. **Branch:** continue on `feat/tui-v1`. The 14 v1 chunks are committed; this hardening pass stacks on top of HEAD `2e1f20b`.

3. **Per group:** Test Writer → Implementer → Reviewer → fix-loop until reviewer reports CLEAN. Spawn fresh agents per role; never combine roles. Pre-written tests pass without modification (rebut-with-evidence allowed but exceptional).

4. **Tool discipline:** `Read`, `Edit`, `Write`, `Grep`. `Bash` only for `pnpm`, `cargo`, `git`, `just`, `node`, script invocations. NEVER `cat`/`head`/`tail`/`wc`/`sed`/`awk` against repo files.

5. **No commits until the user asks for them.** This run accumulates uncommitted work on `feat/tui-v1`.

6. **Do not stop until all 32 issues are fixed.** Each group's reviewer must report CLEAN before the next group starts. After Group F, run Step 5.5 (fresh-agent audit) and the full CI matrix.

---

## Context

- **Repo:** `/Users/andmer/Projects/recondo`
- **Branch:** `feat/tui-v1` (long-running integration branch)
- **Current HEAD:** `2e1f20b` (C13 — integration test sweep, end of v1 run)
- **v1 commits:** 14 chunks landed between `148dbf7` (C0 audit) and `2e1f20b` (C13). Full per-chunk SHA list in `docs/superpowers/audits/2026-05-06-mcp-server-v1-orchestration.md`.
- **v1 baseline test counts:**
  - `recondo-mcp`: 829 / 829
  - `@recondo/data`: 358 / 358
  - `recondo-api`: 1333 / 1333
  - `recondo-dashboard`: 732 / 732
  - `cargo nextest --workspace`: 1671 / 1671
- **Plan D source:** `docs/superpowers/plans/2026-05-04-D-mcp-server-v1.md`
- **C0 contract (still binding):** `docs/superpowers/audits/2026-05-06-mcp-pre-flight.md`
- **Spec:** `docs/superpowers/specs/2026-05-04-tui-and-mcp-design.md`
- **Post-v1 audit (the source of the 32 issues):** see Section "32-issue inventory" below.

---

## What this hardening pass changes vs. v1

The v1 run shipped 27 read tools + 7 action tools + 4 prompts + 3 resources + 829 tests. A post-v1 audit on a fresh agent surfaced **3 BLOCKERs the chunk-scoped reviewers missed**, **12 WARNINGs**, **13 deferred-by-design items**, and **4 test-rigor concessions** — 32 total. This pass addresses every one of them.

The user has explicitly directed:

- "extend functionality where it makes sense to do so and fits within the overall architecture"
- "use TDD"
- "do not commit"
- "do not stop until all 32 issues are fixed"
- `recondo_insights` ships **first-class** (no shortcut, no stub).
- `--scoped` key minting ships **first-class**.
- Test isolation ships **first-class** (per-test Postgres schema namespacing).

---

## Decisions made (binding for this run)

These five decisions answer the open questions from the planning conversation. They are non-negotiable inputs to every subgroup.

### D-HARD-1: Framework ID convention (issue #15)
**Short IDs are canonical.** `compliance_frameworks.id = "soc2"` (not `"seed-fw-soc2"`). The hardening pass:
- Adds migration `015_compliance-frameworks-short-ids.sql` that updates 004's seed rows in-place: `UPDATE compliance_frameworks SET id = REPLACE(id, 'seed-fw-', '')`.
- Drops migration `014_compliance-framework-aliases.sql` (its duplicate-row hack becomes redundant).
- Updates all `seed-fw-` references in `api/`, `dashboard/`, structured-query, MCP integration tests, and prompt bodies. Estimated ~5 files outside `mcp/`.

### D-HARD-2: Audit-on-failure pattern (issue #1)
**Single record with `outcome` field.** Migration `016_audit-log-outcome.sql`:
```sql
ALTER TABLE audit_log
  ADD COLUMN outcome TEXT NOT NULL DEFAULT 'success'
    CHECK (outcome IN ('success', 'error', 'aborted')),
  ADD COLUMN error_message TEXT;
CREATE INDEX IF NOT EXISTS idx_audit_log_outcome ON audit_log(outcome);
```
The `insertAuditLog` data-layer fn extends to accept `outcome` and `errorMessage`. The MCP `withAuditLog` and `withActionAuditLog` wrappers refactor to `try/finally` so the row is recorded regardless of handler outcome.

### D-HARD-3: `recondo_insights` (issue #26)
**Ship first-class.** New `getInsights({projectId?, since?})` data-layer fn returning a structured `Insight[]`. Real ranking + thresholds, not stubs. New MCP tool `recondo_insights` registered alongside the 27 v1 read tools. **Catalog grows 27 → 28.** Insight kinds (v1 set):
- `high_cost_session` — sessions whose `cost_usd` exceeds 5× the median.
- `redundant_tool_calls` — `(tool_name, input_hash)` groups with `count >= 10` in the last hour.
- `anomaly_spike` — anomaly count week-over-week delta exceeds 100% of baseline.
- `hash_drift_failure` — recent `verifyIntegrity` runs with `failedTurns > 0`.
- `policy_trigger_burst` — policies with sudden trigger-rate increases.
Each insight carries `kind`, `severity`, `message`, `suggested_next_call: {tool, args}`, `evidence` (the underlying ids/counts).

### D-HARD-4: `mintScopedKey` + `--scoped` (issue #28)
**Ship first-class.** New `mintScopedKey({projectId, name})` in `@recondo/data`:
- Generates a 32-byte cryptographically random key via `crypto.randomBytes(32)`.
- Hashes via SHA-256 for storage in `api_keys.key_hash`.
- Persists with `project_id`, `name`, `created_at`, `scope='scoped'`.
- Returns `{keyId, rawSecret, scopedProjectId, createdAt}` (raw secret returned exactly once).
- Audit-log entry recorded for the mint itself.

`recondo-mcp config <flavor> --scoped <project_id>` calls `mintScopedKey`, captures the raw secret, and emits the config JSON with `RECONDO_API_KEY` populated. Secret never logged; only printed to stdout once.

### D-HARD-5: Integration test isolation (issue #31)
**Per-test Postgres schema namespacing.** Every integration test creates a unique `recondo_test_${pid}_${counter}` schema, runs migrations against it, seeds/truncates within it, drops it on teardown. The `singleFork: true` workaround is removed; integration tests run in parallel pools.

Implementation notes:
- New `mcp/tests/helpers/schema-namespace.ts` — `withIsolatedSchema(callback)`.
- Helper sets `search_path` to the test schema for the duration.
- `seedTestDb` and integration tests opt into the namespacing automatically via a `beforeEach` hook.

---

## 32-issue inventory (the canonical list this run must close)

The full audit lives in conversation but is reproduced below as the contract. Each issue must be CLOSED before this run is considered done.

### BLOCKERs (3)
1. **Audit log NEVER fires when an action handler throws.** `mcp/src/registry/audit-wrap.ts` awaits handler before audit write; thrown errors skip audit.
2. **`recondo://turn/{id}` resource bypasses injection defense.** Body emits raw `userRequestText`/`responseText`/`thinkingText` alongside the wrapped `captured` block.
3. **All 4 prompt bodies cite tool arguments those tools don't accept.** `summarize_my_week`, `find_waste`, `monitor_anomalies`, `weekly_cost_report` all fail Zod validation if executed.

### WARNINGs (12)
4. `audit_trail period` enum forwarded raw; data-layer `resolveDateRange` regex doesn't match → silent 30-day fallback.
5. `policies include=trigger_history` returns identical global trend per row (data-layer ignores apiKey, has no policyId filter).
6. `policies.policy_id` accepted in schema but never read in handler.
7. `tool_call_stats.project_id` accepted, never forwarded to data layer.
8. `compliance(summary, frameworks)` accepts `limit/offset`, never forwarded.
9. `generate_report` schema diverges from Plan D (Plan D required `{type, period, from, to, params}`; ship has `{framework, period_start, period_end}`). No `name` field.
10. `update_control_status.new_status: z.string()` — Plan D required enum `(compliant | non_compliant | in_review)`.
11. `NODE_ENV ?? "development"` — unset NODE_ENV silently enables dev-bypass gate.
12. `spawnMcp.ts` test helper injects placeholder `DATABASE_URL` + forces `RECONDO_DEV_BYPASS=1` + forces `NODE_ENV=development` → production-mode auth bugs invisible to integration suite.
13. Config subcommand: claude-code/cursor/goose configs missing `args`; `RECONDO_DEV_BYPASS`/`RECONDO_DATA_DIR`/`RECONDO_OBJECTS` not propagated.
14. 5 list tools (`list_sessions`, `realtime_feed`, `search`, `related_turns`, `find_similar_prompts`) emit `next_offset=null` even when page is exactly `limit` items — caller cannot detect "more pages exist".
15. Migration 014 introduces duplicate framework ids (`soc2` AND `seed-fw-soc2`) — addressed via D-HARD-1 above.

### Deferred-by-design / accepted-NOTE items (13)
16. `compareTurns` wraps captured text with literal empty `from_session_id: ""`. Data layer doesn't carry session_id back.
17. `action_immutability` test uses row-count-only fingerprint — delete+reinsert at same count undetected.
18. `audit-log` test has 50ms `setTimeout` "defensive yield".
19. `cost_projections.period` is reserved/ignored. TODO(plan-e).
20. Catalog parity lint Phase 2 (action-immutability lint via `__tableTargets`) deferred.
21. `stream_id`/`is_final` envelope keys are pre-streaming stubs (always `null`/`true`).
22. S3 raw-byte reads explicitly throw — local driver only.
23. `relatedTurns` enum reduced from Plan D's 5 → 3.
24. `spend` and `report_trends` have no offset/limit; SQL caps at fixed limits.
25. Audit-write failure is logged-and-swallowed (combined with #1: silent compliance gap).
26. `recondo_insights` dropped — addressed via D-HARD-3 above (ship first-class).
27. `tool_call_stats period: quarter` deliberately omitted.
28. `recondo-mcp config --scoped` dropped — addressed via D-HARD-4 above (ship first-class).

### Test rigor concessions (4)
29. 40+ unit tests use bare `rejects.toThrow()` without message/class assertion — wrong error type passes silently.
30. All 17 integration files silently skip when DATABASE_URL or binary missing.
31. Integration project runs `singleFork: true` — masks any production handler-parallelism race. Addressed via D-HARD-5.
32. `ReadTool.inputSchema` typed loosely (Zod `.default()` divergence) — papered over with `as` casts.

---

## Lessons learned from the v1 run (apply unchanged)

These are encoded in `~/.claude/projects/-Users-andmer-Projects-recondo/memory/feedback_*.md` and were proven across 14 v1 chunks. They apply identically here.

1. **Adversarial workflow only.** Test Writer ≠ Implementer ≠ Reviewer. Three agents per group.
2. **No backward-compat shims.** Refactors update all internal consumers in the same commit; no deprecation phase, no shims.
3. **Native tools, not Bash piping.** `Read`/`Edit`/`Write`/`Grep` for files; `Bash` only for `pnpm`/`cargo`/`git`/`just`/scripts.
4. **Pipeline tests, not component tests.** Every deliverable drives a real production entry point and asserts observable state.
5. **API-reality table baked into every prompt.** See `docs/superpowers/audits/2026-05-06-mcp-pre-flight.md` §1. Every tool import uses RIGHT-column names.
6. **Verify "pre-existing" claims before accepting them.** Reproduce against the baseline before calling something out-of-scope.
7. **Test the deliverable's production path, not a synthetic interface.**
8. **Implementer pushback on factual errors is encouraged.** Rebut with evidence; don't silently invent functions.
9. **Forward-looking exports without consumers are phantom.** This is the core lesson the post-v1 audit re-validated — it's exactly how the 32 issues happened.
10. **Final Step 5.5 audit on a FRESH agent.** No round contamination.
11. **NOTE-severity findings still trigger re-review.** Don't rationalize NOTEs away.
12. **REJECTED-by-orchestrator findings are valid too.** When a reviewer suggestion would diverge from established patterns, the orchestrator can REJECT with documented rationale.
13. **`afterAll` teardowns wrap DELETEs of captured tables in `BEGIN; SET LOCAL recondo.gdpr_bypass = 'true'; ...; COMMIT`.**
14. **AsyncIterable convention: outer non-async + inner async generator.** Sync arg validation in the outer wrapper; signal checks + I/O in the inner generator.
15. **`enforceListBudget(items, offset, JSON.stringify)` is the canonical truncation path.**
16. **Stdout discipline.** No code in `mcp/src/` writes to stdout except the MCP transport itself and the `recondo-mcp config` subcommand.
17. **Integration tests need `just dev-infra` running.** `DATABASE_URL` + `RECONDO_OBJECT_STORE_PATH` must be set in the shell before running mcp tests.
18. **CI gate has no carve-outs.** `data`/`api`/`dashboard`/`mcp`/`cargo` all green every chunk's reviewer pass.

**New lessons from the post-v1 audit (the reasons the 32 issues slipped through):**

19. **Per-chunk reviewers don't see cross-cutting failures.** Audit-on-failure path requires inspecting the action wrapper AND the failure-mode contract — neither chunk's reviewer scope. Same for prompt bodies (C12 reviewer audited prompts in isolation, never piped argument JSON through Zod). Solution: this run's reviewers MUST check cross-cutting properties explicitly per group.

20. **Zod schema acceptance ≠ semantic correctness.** A tool can accept and ignore a parameter — both passing the schema and the integration smoke. Solution: every parameter in every Zod schema MUST have a corresponding "this parameter changes observable behavior" test.

21. **The integration suite's `RECONDO_DEV_BYPASS=1` shim hid production-mode auth bugs.** Solution: production-mode auth tests must exist for every auth-relevant code path.

22. **"Every read tool wraps captured content" was checked for tools but not resources.** Solution: resource handlers get the same scrutiny as tools.

23. **Pagination cursor semantics were never an explicit deliverable.** The 5-key envelope shape was asserted; "is the cursor *useful*" was not. Solution: this run adds a "cursor usefulness" test for every list tool — return `next_offset != null` when more data exists.

---

## Group plan

Six groups, executed in order. Each group is one Test Writer → Implementer → Reviewer triple (fix-loops as needed).

### Group A — Compliance/Safety BLOCKERs (issues #1, #2, #3)

#### A1. Audit-on-failure (#1, #25)

**TDD targets (Test Writer):**
- `mcp/tests/integration/audit-on-failure.test.ts`:
  - Successful action → audit row with `outcome="success"`, `error_message=NULL`.
  - Action whose handler throws (synthetic injection of a throwing data-layer mock) → audit row with `outcome="error"`, `error_message` containing the thrown message.
  - Pre-aborted signal → audit row with `outcome="aborted"`, `error_message="AbortError"`.
  - Read-tool failure path also writes the audit row.
- `mcp/tests/unit/audit-wrap.test.ts`:
  - `withAuditLog(...)`/`withActionAuditLog(...)` invoke the audit writer in a `finally` block.
  - Throw propagates to the caller AFTER audit write completes.

**Implementation:**
- Migration `016_audit-log-outcome.sql` per D-HARD-2 above.
- Extend `@recondo/data::insertAuditLog({...entry, outcome?, errorMessage?})`.
- Refactor `mcp/src/registry/audit-wrap.ts`:
  ```typescript
  export function withAuditLog(tool, audit) {
    return async (input, ctx) => {
      let outcome: "success" | "error" | "aborted" = "success";
      let errorMessage: string | null = null;
      let result: unknown;
      try {
        result = await tool.handler(input, ctx);
        return result;
      } catch (err) {
        outcome = err?.name === "AbortError" ? "aborted" : "error";
        errorMessage = err?.message ?? String(err);
        throw err;
      } finally {
        const responseBytes = result == null ? 0 : JSON.stringify(result).length;
        await audit.write({
          toolName: tool.name,
          arguments: input,
          responseBytes,
          clientName: ctx.clientInfo?.name ?? null,
          keyId: ctx.auth.keyId,
          outcome,
          errorMessage,
        }, { signal: ctx.abortSignal });
      }
    };
  }
  ```
- Same shape for `withActionAuditLog`.
- Update D-C13-7 audit-log integration test to assert `outcome`/`error_message` round-trip.
- Update C13's existing audit-log test to assert success path still records `outcome="success"`.

**Reviewer cross-cuts:**
- Verify the `finally` block survives a thrown error in the audit writer itself (it should — audit-writer swallows internally).
- Verify `responseBytes` is 0 for the error/aborted paths (not undefined/null).
- Verify the SOC 2 PI1 `prevent_audit_mutation` trigger still applies to the new column shape.

#### A2. Turn resource injection bypass (#2)

**TDD targets:**
- `mcp/tests/integration/turn-resource-injection.test.ts`:
  - Seed a turn with `userRequestText` containing literal `"INJECTION_PAYLOAD_xyz"`.
  - Read `recondo://turn/<id>` resource.
  - Assert `INJECTION_PAYLOAD_xyz` appears EXACTLY ONCE in the response body, and ONLY inside `<captured_user_message>...</captured_user_message>`.
  - Assert response body has NO key path that exposes the raw text outside the wrapper (specifically: `body.turn.userRequestText` does not exist OR is the wrapped envelope object).
- Adversarial close-tag test: same as the tool-side D-C13-5 but via the resource.

**Implementation:**
- `mcp/src/resources/turn.ts`: replicate `mcp/src/tools/get-turn.ts` field-replacement logic.
- Drop the `{turn, captured}` dual shape; emit the in-place-wrapped `MappedTurn` only.
- Update `mcp/tests/unit/resources/turn.test.ts` (create if absent) with the new shape.

**Reviewer cross-cuts:**
- Run the same injection regression against `recondo://session/{id}` and `recondo://reports/{id}` to confirm parity.
- Grep `mcp/src/resources/` for any other dual-shape patterns.

#### A3. Prompt bodies cite wrong arguments (#3)

**TDD targets:**
- `mcp/tests/unit/prompts-validate.test.ts`:
  - For each of the 4 prompts: parse the rendered body, extract every `tool: name, args: {...}` reference, look up the tool by name in `READ_TOOLS`/`ACTION_TOOLS`/etc., pipe the args through `tool.inputSchema.parse(...)`. ALL must succeed.
  - Adversarial: a stub prompt with `period: "last_7_days"` MUST fail this validator (sanity check).

**Implementation:**
- Rewrite all 4 prompt bodies:
  - `summarize_my_week`: `recondo_usage_summary({period: "week"})`, `recondo_top({dimension: "developer", period: "week", limit: 5})`, `recondo_session_efficiency({session_id})` (drop `period`).
  - `find_waste`: drop `period`/`min_repeats` references; use `recondo_find_similar_prompts({turn_id})` per session, or `{text: "..."}` for query-driven.
  - `monitor_anomalies`: `recondo_anomalies({since: "<ISO timestamp>"})` instead of `period`.
  - `weekly_cost_report`: `recondo_generate_report({type, period, from?, to?, params?})` per the new D-HARD-1-extended schema (see C6 below).
- New helper `mcp/src/prompts/validate.ts`:
  ```typescript
  export function validatePromptCalls(prompt: Prompt, toolCatalog: {read: ReadTool[], action: ActionTool[]}): ValidationResult;
  ```
- Wire into `just mcp-lint-parity` (Phase 1.5 check) so future prompt drift is caught at CI time.

**Reviewer cross-cuts:**
- Confirm the validator catches a deliberately-broken stub prompt.
- Confirm the rendered prompt bodies still make narrative sense to a human reader (not just schema-clean).

---

### Group B — Auth/Security WARNINGs (issues #11, #12, #13)

#### B1. NODE_ENV default flips to production (#11)

**TDD targets:**
- `mcp/tests/unit/env.test.ts`: missing NODE_ENV + `RECONDO_DEV_BYPASS=1` + no key → throws.
- Existing dev-bypass tests must explicitly set `NODE_ENV=development` (regression sweep).

**Implementation:**
- `mcp/src/config/env.ts`: change `nodeEnv = env.NODE_ENV ?? "production"`.
- Audit and update test fixtures across the suite.

#### B2. spawnMcp shim opt-in (#12)

**TDD targets:**
- `mcp/tests/integration/auth-production-mode.test.ts` (NEW):
  - Spawn binary in production mode (`NODE_ENV=production`, no dev-bypass) WITH a real seeded API key.
  - Call `recondo_list_sessions`. Succeeds.
  - Spawn in production mode WITHOUT a key. Process exits non-zero with stderr `RECONDO_API_KEY is required`.
- `mcp/tests/helpers/spawnMcp.test.ts`: helper without `devBypass: true` opt-in does NOT inject `RECONDO_DEV_BYPASS` or `NODE_ENV=development`.

**Implementation:**
- Refactor `mcp/tests/helpers/spawnMcp.ts`:
  - `spawnMcp({devBypass?: boolean = false, ...})`: only inject bypass + dev `NODE_ENV` when explicitly opted in.
  - Default behavior forwards the caller's env unchanged.
- Sweep every existing integration test:
  - Tests that need bypass: opt in via `spawnMcp({devBypass: true})`.
  - Tests that should exercise production-mode auth: opt in via `spawnMcp({devBypass: false})` (the default) AND seed a real API key.
  - Estimate: ~17 integration files updated; explicit decision per test.

**Reviewer cross-cuts:**
- Confirm at least 3 integration tests now exercise production-mode auth end-to-end.
- Confirm the helper still works in CI environments where `DATABASE_URL` may not be in the shell.

#### B3. Config subcommand completeness (#13)

**TDD targets:**
- `mcp/tests/unit/config-subcommand.test.ts` extensions:
  - `recondo-mcp config claude-code --emit-args --allow-actions` emits `args: ["--allow-actions"]`.
  - `recondo-mcp config claude-code --emit-args --allow-actions --allow-destructive` emits `args: ["--allow-actions", "--allow-destructive"]`.
  - With `RECONDO_DEV_BYPASS=1` set: emitted `env` includes the bypass flag.
  - With `RECONDO_DATA_DIR` / `RECONDO_OBJECTS` set: emitted `env` includes them.
  - Goose flavor: `args: []`, `enabled: true`, `name: "recondo"`.

**Implementation:**
- Extend `emitRegistrationJson({client, env, flags?, includeArgs?: boolean})`.
- Add `--emit-args` CLI flag handling in `bin/recondo-mcp.ts` config branch.
- Extend `PROPAGATED_ENV_VARS` to include `RECONDO_DEV_BYPASS`, `RECONDO_DATA_DIR`, `RECONDO_OBJECTS`, `NODE_ENV`.
- Goose template adds `args`, `enabled`, `name`.

---

### Group C — Phantom Parameters (issues #4–10)

For each: TDD-first; pin observable behavior; either WIRE THROUGH (extend `@recondo/data` if needed) or REMOVE from the Zod schema.

#### C1. `audit_trail.period` → wire through (#4)
**Test:** `period: "week"` causes the SQL filter to scope to last 7 days (assert via row count delta against seeded data).
**Implementation:** translate via `mcp/src/period.ts`'s `toDataLayerPeriod` before forwarding to `listAuditEvents`. Verify `resolveDateRange` accepts the translated form.

#### C2. `policies.include=trigger_history` per-policy enrichment (#5)
**Test:** seed two policies with distinct trigger histories. Call `recondo_policies({include: ["trigger_history"]})`. Assert the two returned policies have DIFFERENT `triggerHistory` values.
**Implementation:** extend `@recondo/data::listPolicyTriggerHistory({policyId?})` to accept an optional `policyId` filter. Honor `apiKey` scoping. MCP handler iterates returned policies and calls per-policy.

#### C3. `policies.policy_id` → wire through as filter (#6)
**Test:** `recondo_policies({policy_id: "abc"})` returns exactly that one policy.
**Implementation:** extend `@recondo/data::listPolicies({policyId?: string})` filter; MCP handler forwards.

#### C4. `tool_call_stats.project_id` → wire through (#7)
**Test:** seed two projects, scope to one, assert results scoped.
**Implementation:** extend `@recondo/data::toolCallStats({projectId?})`. Add SQL `WHERE` clause.

#### C5. `compliance.{summary, frameworks}.limit/offset` → drop via discriminated union (#8)
**Test:** `recondo_compliance({view: "summary", limit: 10})` is REJECTED at the schema layer (schema doesn't allow limit/offset on this view).
**Implementation:** rewrite `complianceInputSchema` as `z.discriminatedUnion("view", [z.object({view: z.literal("summary"), ...}), z.object({view: z.literal("frameworks"), ...}), z.object({view: z.literal("audit_log"), limit, offset, ...})])`.

#### C6. `generate_report` schema reconcile to Plan D (#9)
**Test:** schema accepts `{type: enum(weekly_cost|compliance|anomaly|custom), period: enum(week|month), from?, to?, params?}`. Each `type` causes the data layer to dispatch to the right query.
**Implementation:**
- Extend `@recondo/data::generateReport({type, period, from?, to?, params?})`.
- Per-type dispatch in the data layer:
  - `weekly_cost`: existing `getUsageSummary` + cost rollup.
  - `compliance`: `getComplianceSummary` snapshot.
  - `anomaly`: `listAnomalies` summary.
  - `custom`: takes `params` (caller-supplied SQL-safe filter set).
- MCP `generate_report` schema mirrors.

#### C7. `update_control_status.new_status` → tighten enum (#10)
**Test:** `new_status: "compliant"` accepted; `new_status: "compliantz"` rejected.
**Implementation:** Zod `enum(["compliant", "non_compliant", "in_review"])`.

---

### Group D — Phantom Cursors (issue #14)

**TDD targets (per affected tool):**
- `mcp/tests/integration/cursor-honors-overflow-<tool>.test.ts` — seed `limit + 5` rows; first call returns `next_offset != null`; calling with `next_offset` returns the next page; final page returns `next_offset === null`.

**Affected tools:**
- `recondo_list_sessions`
- `recondo_realtime_feed`
- `recondo_search`
- `recondo_related_turns`
- `recondo_find_similar_prompts`
- `recondo_anomalies` (currently honored only when budget hits — verify and tighten)

**Implementation strategy:**
- **Where data layer already returns `{total, limit, offset}`:** thread it through (most policy/key/audit tools already do).
- **Where it doesn't:** fetch `limit + 1`; emit `next_offset = offset + limit` when the +1 sentinel is present, else `null`.
- For AsyncIterable functions (`searchTurns`, `relatedTurns`, `findSimilarPrompts`): handler drains `limit + 1` and slices.
- `enforceListBudget` continues to override `next_offset` with the byte-budget cursor when the budget hits before the limit.

**Reviewer cross-cuts:**
- Confirm every list tool now honors the cursor.
- Confirm the cursor's value is meaningful (the next page actually returns NEW data when fed back).

---

### Group E — Schema/Migration/Behavior Reconcile (issues #15–28)

#### E1. Migration 014 reconcile → short IDs canonical (#15)

**TDD:**
- Test: `compliance_frameworks` has rows with id `soc2`, `iso42001`, `euai`, `nist` only (no `seed-fw-*`).
- Test: queries by short-id from MCP integration tests, dashboard, API all resolve to the same row.

**Implementation:**
- Migration `015_compliance-frameworks-short-ids.sql`:
  ```sql
  -- Re-key seed framework rows from `seed-fw-<name>` to `<name>`.
  -- Cascades via FK on compliance_controls.framework_id.
  UPDATE compliance_frameworks SET id = SUBSTRING(id FROM 9) WHERE id LIKE 'seed-fw-%';
  ```
- Drop migration `014_compliance-framework-aliases.sql` (move to `api/migrations/.deleted/` or delete outright; document in commit).
- Update `seed-fw-*` references in:
  - `api/tests/setup.ts:514-520`
  - `api/tests/m1-migrations.test.ts:1163-1178`
  - any `dashboard/` references
  - structured-query helpers
- All references audited via `grep -rn "seed-fw-"`.

#### E2. compareTurns extends with sessionId (#16)

**TDD:** wrapped envelope's `from_session_id` matches the seeded session.

**Implementation:**
- Extend `@recondo/data::CompareTurnsRow` with `sessionId: string`.
- Extend the SELECT to JOIN `turns → sessions`.
- MCP handler passes the real `sessionId` to `buildMessageEnvelope`.

#### E3. action_immutability content fingerprint (#17)

**TDD:** delete-then-reinsert at same row count is detected.

**Implementation:**
- Extend `mcp/tests/integration/action-immutability.test.ts` fingerprint:
  ```sql
  SELECT
    md5(string_agg(id::text, ',' ORDER BY id)) AS content_hash,
    count(*) AS row_count
  FROM <table>;
  ```
- Combined hash detects content delta even at constant count.

#### E4. audit-log setTimeout drop (#18)

**TDD:** test passes without the 50ms sleep.

**Implementation:** drop the sleep. The audit writer is awaited inside the registry; the row is on disk by the time the response returns.

#### E5. cost_projections.period (#19)

**TDD:** each period (`day`/`week`/`month`/`quarter`) returns a different projection window.

**Implementation:**
- Extend `@recondo/data::getCostProjections({period?: "day"|"week"|"month"|"quarter"})`. Drop the `_period` underscore.
- Translate via `period.ts` to `DAY_n`. Compute projection from the selected window.
- Update tool description to remove the v1 reservation note.
- Drop `TODO(plan-e)` comment.

#### E6. Phase 2 immutability lint (#20)

**TDD:**
- Phantom action handler that calls a captured-table-writing data fn fails the lint.
- All 7 real action handlers pass.

**Implementation:**
- New sidecar: `packages/recondo-data/src/__table-targets.ts`:
  ```typescript
  export const TABLE_TARGETS: Record<string, readonly string[]> = {
    listSessions: ["sessions"],
    getSession: ["sessions"],
    getTurn: ["turns"],
    // ... all 96 exports
    createPolicy: ["policies"],
    deletePolicy: ["policies"],
    createApiKey: ["api_keys", "audit_log"],
    revokeApiKey: ["api_keys", "audit_log"],
    insertAuditLog: ["audit_log"],
    mintScopedKey: ["api_keys", "audit_log"],
    // captured tables that NO action tool may write:
    // turns, tool_calls, sessions, attachments
  };
  export const CAPTURED_TABLES = ["turns", "tool_calls", "sessions", "attachments"] as const;
  ```
- Each entry verified by reading the SQL.
- Extend `mcp/src/scripts/catalog-parity-lint.ts` Phase 2:
  - Walk `ACTION_TOOL_TO_DATA_FN` values.
  - For each, look up `TABLE_TARGETS[fn]`.
  - Assert `TABLE_TARGETS[fn] ∩ CAPTURED_TABLES === ∅`.
  - Emit violation `action_writes_captured_table` if any action writes a captured table.
- Drop `TODO(plan-e)` comments referencing Phase 2.

#### E7. Pre-streaming envelope keys (#21)

**No code change.** Add a comment block in `mcp/src/envelope/list.ts` documenting the v2 streaming contract.

#### E8, E9, E13. Genuine v1 cuts — document, don't implement (#22, #23, #27)
S3 raw bytes, `relatedTurns` 5→3, `tool_call_stats quarter`. Add inline comments in source pointing to the design rationale. No behavior change.

#### E10. `spend` and `report_trends` pagination (#24)

**TDD:** both tools accept and honor `limit` + `offset`; `next_offset` works.

**Implementation:**
- Extend `@recondo/data` envelopes for `listSpendByX`, `listDailySpend`, `listReportCoverageTrend`, `listReportFindingsTrend` to include `total/limit/offset`.
- Add `limit`/`offset` to MCP schemas for `recondo_spend` and `recondo_report_trends`.

#### E11. Audit swallow + observability (#25)
Combined with A1. The audit-write FAILURE path remains observability (logged-and-swallowed), BUT now the structured warning emits a metric tag (e.g., `audit_write_failed: true` in the JSON line) so an operator can alert on it.

#### E12. recondo_insights first-class (#26, per D-HARD-3)

**TDD targets:**
- `packages/recondo-data/tests/insights.test.ts`:
  - Seed sessions with known cost outliers; `getInsights` returns `high_cost_session` for those.
  - Seed redundant tool calls; `getInsights` flags `redundant_tool_calls`.
  - Seed anomalies; `getInsights` flags `anomaly_spike` if WoW delta > 100%.
  - Seed `verifyIntegrity` failures; `getInsights` flags `hash_drift_failure`.
  - Each insight carries `kind`, `severity`, `message`, `suggested_next_call: {tool, args}`, `evidence`.
- `mcp/tests/unit/insights.test.ts`: schema parses `{project_id?, since?}`; description ≥ 50 chars; AbortSignal threaded.
- `mcp/tests/integration/insights.test.ts`: spawn binary; call `recondo_insights({})`; assert structured response shape.
- `mcp/tests/unit/catalog-count.test.ts`: `READ_TOOLS.length === 28` (NOT 27).

**Implementation:**
- New `packages/recondo-data/src/insights.ts`:
  ```typescript
  export interface Insight {
    kind: "high_cost_session" | "redundant_tool_calls" | "anomaly_spike" | "hash_drift_failure" | "policy_trigger_burst";
    severity: "info" | "warning" | "critical";
    message: string;
    suggested_next_call: { tool: string; args: Record<string, unknown> };
    evidence: Record<string, unknown>;
  }

  export interface InsightsArgs {
    projectId?: string;
    since?: string; // ISO-8601
  }

  export async function getInsights(
    apiKey: ApiKeyInfo,
    args: InsightsArgs = {},
    options: QueryOptions = {},
  ): Promise<{ insights: Insight[] }>;
  ```
- Implementation composes existing data-layer fns (`getUsageSummary`, `toolCallStats`, `listAnomalies`, `verifyIntegrity` history, `listPolicyTriggerHistory`).
- Ranking: severity ordered `critical > warning > info`; within severity, ordered by evidence magnitude.
- Top 5 returned by default.
- New `mcp/src/tools/insights.ts` registered in `READ_TOOLS`.
- Catalog parity lint mapping: `recondo_insights → "getInsights"`.

#### E14. mintScopedKey + --scoped first-class (#28, per D-HARD-4)

**TDD targets:**
- `packages/recondo-data/tests/mint-scoped-key.test.ts`:
  - `mintScopedKey({projectId: "alpha", name: "test-key"})` returns `{keyId, rawSecret, scopedProjectId, createdAt}`.
  - The raw secret is 32 bytes of cryptographic randomness (entropy check via collision probability OR explicit `crypto.randomBytes` mock verification).
  - `api_keys` row exists with `key_hash = sha256(rawSecret)`, `project_id = "alpha"`, `scope = "scoped"`.
  - The mint itself produces an audit-log entry with `tool_name = "mintScopedKey"` (data-layer-level audit; mints from CLI are out-of-tool-call).
  - Subsequent `authenticateApiKey(rawSecret)` returns the scoped context.
  - Calling `mintScopedKey` twice for the same project returns DIFFERENT secrets.
- `mcp/tests/integration/config-scoped.test.ts`:
  - `recondo-mcp config claude-code --scoped my-project` exits 0; stdout is valid JSON; `mcpServers.recondo.env.RECONDO_API_KEY` is a non-empty string starting with the key prefix.
  - Spawn `recondo-mcp` with the emitted env; `tools/list` succeeds; calls scoped to `my-project` only see `my-project` data.
  - Verify the secret is printed exactly once (re-running the CLI mints a new key, doesn't return the same one).

**Implementation:**
- `packages/recondo-data/src/keys.ts`:
  ```typescript
  export async function mintScopedKey(
    args: { projectId: string; name: string },
    options: QueryOptions = {},
  ): Promise<{ keyId: string; rawSecret: string; scopedProjectId: string; createdAt: Date }> {
    const rawSecret = crypto.randomBytes(32).toString("base64url");
    const keyHash = crypto.createHash("sha256").update(rawSecret).digest("hex");
    const keyId = crypto.randomUUID();
    const createdAt = new Date();
    await pool.query(`INSERT INTO api_keys (id, key_hash, name, project_id, scope, created_at) VALUES ($1, $2, $3, $4, 'scoped', $5)`, [keyId, keyHash, args.name, args.projectId, createdAt]);
    await insertAuditLog({ toolName: "mintScopedKey", arguments: { projectId: args.projectId, name: args.name }, responseBytes: 0, keyId, requestedAt: createdAt, outcome: "success", errorMessage: null });
    return { keyId, rawSecret, scopedProjectId: args.projectId, createdAt };
  }
  ```
- Re-export from `index.ts`.
- `mcp/src/bin/recondo-mcp.ts` config branch:
  - Recognize `--scoped <project_id>`.
  - Calls `mintScopedKey({ projectId, name: `mcp-${flavor}-${timestamp}` })`.
  - Adds `RECONDO_API_KEY: rawSecret` to the emitted env.
  - Stdout is the only output channel; secret never logged via `logger`.
- Update `mcp/src/config/registration.ts::emitRegistrationJson` to accept an optional `apiKey: string` field.

**Reviewer cross-cuts:**
- Confirm the secret is never logged anywhere.
- Confirm collision risk is acceptable (32 bytes ≈ 256 bits of entropy).
- Confirm `authenticateApiKey` correctly resolves the new scoped key to its project.
- Confirm catalog parity lint includes `mintScopedKey` (not opted out).

---

### Group F — Test Rigor (issues #29–32)

#### F1. Tighten `rejects.toThrow()` (#29)

**TDD:** N/A — this is a sweep. Each `rejects.toThrow()` becomes `rejects.toThrow(/specific message regex/)` or `rejects.toThrow(SpecificError)`.

**Implementation:**
- Sweep `mcp/tests/unit/*.test.ts` and `packages/recondo-data/tests/*.test.ts`.
- For each occurrence, identify the expected error class/message; tighten.
- Run the suite. Catch any tests that were silently passing on the wrong error — those are real bugs to fix.

#### F2. Silent skipping audit (#30)

**TDD:** running integration suite without DB now emits a structured warning; CI gate detects skipped integration tests.

**Implementation:**
- Replace `describe.skip` paths with logged warnings:
  ```typescript
  if (!HAVE_DB || !HAVE_BINARY) {
    console.warn(JSON.stringify({ skipped: true, reason: !HAVE_DB ? "no_database_url" : "no_binary", file: __filename }));
  }
  ```
- New `just ci-typescript-with-infra` recipe that boots dev-infra, applies migrations, runs ALL tests, and asserts zero `skipped: true` warnings.

#### F3. Per-test schema namespacing (#31, per D-HARD-5)

**TDD:**
- `mcp/tests/integration/parallelism.test.ts`: parallel-run two integration tests that both seed and truncate; assert no cross-contamination.
- Existing integration tests pass with `singleFork: false`.

**Implementation:**
- `mcp/tests/helpers/schema-namespace.ts`:
  ```typescript
  export async function withIsolatedSchema<T>(callback: (schemaName: string) => Promise<T>): Promise<T> {
    const schemaName = `recondo_test_${process.pid}_${schemaCounter.next()}`;
    const pool = getPool();
    await pool.query(`CREATE SCHEMA ${quoteIdent(schemaName)}`);
    try {
      // Apply migrations to the new schema.
      await applyMigrations(pool, schemaName);
      // Set search_path for all queries in this scope.
      const previousSearchPath = await pool.query(`SHOW search_path`);
      await pool.query(`SET search_path TO ${quoteIdent(schemaName)}, public`);
      try {
        return await callback(schemaName);
      } finally {
        await pool.query(`SET search_path TO ${previousSearchPath.rows[0].search_path}`);
      }
    } finally {
      await pool.query(`DROP SCHEMA ${quoteIdent(schemaName)} CASCADE`);
    }
  }
  ```
- `seedTestDb` uses the helper transparently via a `beforeEach`/`afterEach` hook.
- `vitest.config.ts`: integration project switches from `singleFork: true` to default parallel pool.
- Update CI baseline: integration tests now run in ~5s instead of ~20s.

#### F4. ReadTool.inputSchema type tightening (#32)

**Investigation step.** Determine if `z.input<T>` / `z.output<T>` distinction lets us tighten the type without breaking `.default()` divergence.

**If feasible:** tighten to `z.ZodObject<RawShape, ..., z.input<...>>`. Update tool definitions.
**If not feasible:** add a JSDoc comment explaining the constraint and leave as-is. Document that future Zod major versions may resolve this.

---

## Verification gates

After all 6 groups CLEAN:

### Step H.5 — Final fresh-agent audit
Same shape as v1's Step 5.5, but covering all 32 issues. The fresh agent:
- Re-reads this orchestration doc cold.
- For each of the 32 issues, locates the test that asserts the fix AND the production code that satisfies it.
- Runs the full CI matrix (NO carve-outs, no carve-ins).
- Confirms no NEW issues introduced.
- Reports `AUDIT_PASSED | AUDIT_FAILED`.

### Step H.6 — Final CI gate

Required baselines (must meet or exceed):
- `recondo-mcp`: ≥ 950 (829 + estimated +120 from this run's TDD additions)
- `@recondo/data`: ≥ 380 (358 + ~22 for new exports + insights + mintScopedKey)
- `recondo-api`: ≥ 1333 (likely +5 for migration tests)
- `recondo-dashboard`: ≥ 732 (likely unchanged)
- `cargo nextest --workspace`: ≥ 1671
- `cargo clippy -D warnings`: clean
- `cargo fmt --check`: clean
- `xtask lint-arch`: clean
- `just mcp-lint-parity` (Phase 1+2): exits 0
- `just ci-typescript`: green
- `just ci-typescript-with-infra` (NEW): green, zero `skipped: true`
- 5 / 5 stability runs of `pnpm --filter recondo-mcp test` — all 950+ pass each run

### Closing the run
After Step H.6:
- Report final state to the user.
- Do NOT commit. The user will direct commit + branch strategy.

---

## Per-group dispatch templates

### Test Writer prompt template

```
You are the Test Writer for Group <X> (<title>) of the recondo-mcp v1 hardening pass.
Write deliverable pipeline tests BEFORE implementation. You may NEVER write production code.

## Tool discipline
Read/Edit/Write/Grep for files. Bash only for `pnpm test`, `git`, `just`, `node`.
Never `cat`/`wc`/`head`/`tail`/`sed`/`awk` against repo files.

## Workspace
- /Users/andmer/Projects/recondo
- Branch: feat/tui-v1
- HEAD baseline (start of hardening pass): 2e1f20b
- This orchestration doc: docs/superpowers/audits/2026-05-07-mcp-v1-hardening-orchestration.md
- v1 orchestration doc (lessons + per-chunk template): docs/superpowers/audits/2026-05-06-mcp-server-v1-orchestration.md
- v1 C0 contract: docs/superpowers/audits/2026-05-06-mcp-pre-flight.md

## Pre-flight contract
[Insert this orchestration's "Decisions made" section verbatim, plus the relevant
group's section (A/B/C/D/E/F).]

## API reality (carry forward from v1's C0)
[Insert the v1 C0 API-reality table verbatim. Add any new exports this group
introduces (e.g., insertAuditLog now takes outcome+errorMessage; getInsights
new export; mintScopedKey new export).]

## Schema reality (carry forward from v1's C0 + this run's migrations)
[Insert the v1 schema reality block + new migrations 015 (short-id reconcile) +
016 (audit_log outcome).]

## Phantom-wiring red flags (group-specific)
[Insert the group's specific red flags from this orchestration's group sections.]

## Pre-Written Test files to create
[List the test files this group needs, with verbatim TDD targets.]

## Verification
Run `cd mcp && pnpm install && pnpm run build && pnpm run test 2>&1 | tail -40`.
Expected: tests fail because production code doesn't exist yet.

## Rules
- Write only the test files.
- Do not weaken assertions.
- Do not pre-create implementer modules.
- Do not commit.
- Integration tests require dev-infra; unit tests may mock single functions.
- afterAll teardown for any seeded captured rows wraps DELETEs in
  BEGIN; SET LOCAL recondo.gdpr_bypass = 'true'; ...; COMMIT.
- For per-test schema isolation (Group F): use the new withIsolatedSchema
  helper if it exists in this group's commit history; otherwise stick with
  the existing seedTestDb pattern and let Group F upgrade later.

## Report
1. Paths of files created.
2. The API shape you wrote tests against (signatures).
3. Last 30 lines of verify-fail run.
4. `git status --short` showing only the new test files.
5. Status: TESTS_FAIL_AS_EXPECTED | NOT_AS_EXPECTED | BLOCKED.
```

### Implementer prompt template

```
You are the Implementation Agent for Group <X> (<title>) of the recondo-mcp v1
hardening pass. A separate Test Writer placed failing pipeline tests. Make them
pass without breaking the existing test matrix.

## Tool discipline
Read/Edit/Write/Grep for files. Bash for `pnpm test`, `cargo test`, `git`,
`just`, `node`. Never `cat`/`wc`/`head`/`tail`/`sed`/`awk` against repo files.

## Workspace
- Same as Test Writer.
- Pre-written failing tests at the paths the Test Writer reported.

## Pre-flight contract
[Same as Test Writer.]

## What to implement
[Per the group's "Implementation" section in this orchestration doc.]

## NO BACKWARD-COMPAT SHIMS
The hardening pass extends `@recondo/data` cleanly. Update all internal consumers
in the same change. No deprecation phase.

## Phantom-wiring red flags
[Same as Test Writer.]

## Implementer pushback is encouraged
If a test asserts behavior that no @recondo/data export can support, REBUT
with evidence (paste from the source). Do NOT silently invent functions.
Do NOT silently weaken tests.

## Verification
[Run the full matrix per the group's verification block. ALL existing suites
must continue passing — no carve-outs.]

## Do NOT commit.

## Rules
1. Pre-written tests pass without modification (or document a rebuttal).
2. ALL existing test suites continue passing — no carve-outs.
3. mcp/src/ never writes to stdout (except bin/recondo-mcp.ts config branch).
4. AbortSignal threaded through every handler.
5. Action tool descriptions carry the verbatim INJECTION_WARNING.
6. Captured content wrapped in <captured_*> envelope.
7. List tools route through buildListEnvelope / enforceListBudget.
8. No phantom exports / no LEFT-column @recondo/data imports.
9. Audit-on-failure: every action handler's audit row is recorded regardless of
   success/failure (per D-HARD-2).
10. Test isolation: every new integration test uses withIsolatedSchema (per D-HARD-5,
    once Group F lands the helper).

## Report
1. Files created/modified.
2. Sample 3 @recondo/data imports (showing the right-column names used).
3. Test outputs (last 10 lines per suite — mcp + data + api + dashboard + cargo).
4. Final test counts (mcp + data + api + dashboard + cargo).
5. NO commit (user directive).
6. Honest assessment.
7. Status: DONE | DONE_WITH_CONCERNS | BLOCKED.
```

### Reviewer prompt template

```
Process Reviewer for Group <X> (<title>) of the recondo-mcp v1 hardening pass.
Find every problem.

## Tool discipline
Read/Grep/Edit. Bash only for `pnpm test`, `cargo test`, `git`, `just`.

## Critical scrutiny

### 1. Test fidelity
Confirm the implementer did NOT modify any pre-written test (or documented
a rebuttal). Reviewer reads each pre-written test file and compares to spec.

### 2. API-reality compliance
Grep mcp/src/ and packages/recondo-data/src/ for any v1-era LEFT-column name from
the orchestration's API-reality table. Any hit on a LEFT-column name in an import
or function call = BLOCKER.

### 3. AbortSignal honor
For each new handler, read the body and verify ctx.abortSignal is threaded into
both for-await loops AND every underlying data-layer call's options.signal.

### 4. Stdout discipline
Grep mcp/src/ for `console.log` and `process.stdout.write`. Allowed only in
bin/recondo-mcp.ts inside the `config` branch. Anywhere else = BLOCKER.

### 5. Audit-on-failure compliance (NEW for hardening pass)
For every action handler this group touches:
- Confirm withActionAuditLog wraps in try/finally.
- Confirm the `outcome` field is set correctly per success/error/aborted path.
- Run the integration test with a deliberately throwing handler; assert audit row
  with outcome="error" appears.

### 6. Resource handler scrutiny (NEW for hardening pass)
For every resource handler this group touches:
- Confirm captured content is wrapped via buildMessageEnvelope.
- Confirm NO raw text leaks alongside the wrapped form.

### 7. Prompt schema validation (NEW for hardening pass)
For every prompt this group touches:
- Run the prompt validator over its body; assert all referenced tool calls
  validate against the actual schemas.

### 8. Cursor usefulness (NEW for hardening pass)
For every list tool this group touches:
- Run the cursor-honors-overflow test.
- Confirm next_offset is non-null when more pages exist.

### 9. Test isolation honor (NEW for hardening pass, post-Group-F)
For every integration test this group adds:
- Confirm it uses withIsolatedSchema (or has a documented rebuttal).
- Confirm 5/5 parallel runs pass.

### 10. Run the full test matrix (NO CARVE-OUTS)
[List the commands. ALL must pass. Required baselines per this orchestration's
"Verification gates" section.]

### 11. Move-completeness / size sanity
The hardening pass is additive. `git show <sha> --stat` should show only the
files this group touches. Anything else = BLOCKER unless explicitly justified.

### 12. Specific to this group
[2-3 group-specific items per the group's section in this orchestration.]

## Output
For each finding:
- ID: FIND-H<group>-<n>
- Severity: BLOCKER | WARNING | NOTE | SHAM_FIX
- Location: file:line
- Issue
- Evidence
- Fix

Final verdict: CLEAN | DIRTY.
```

---

## Run discipline summary (cheat sheet)

After loading this doc, the orchestrator's loop is:

For each group A → F:
1. Spawn Test Writer with deliverables checklist + this group's section + decisions.
2. Test Writer reports `TESTS_FAIL_AS_EXPECTED`.
3. Spawn Implementer with same context + the pre-written failing tests.
4. Implementer reports `DONE | DONE_WITH_CONCERNS | BLOCKED`. **NO COMMIT.**
5. Spawn Reviewer with group-specific scrutiny.
6. Reviewer reports `CLEAN | DIRTY`.
7. If `DIRTY` (any severity, including NOTE): Fix Implementer → re-review.
8. When Reviewer reports `CLEAN`: mark group done; advance to next group.

After all 6 groups CLEAN:
1. Spawn fresh Step H.5 Auditor (no round contamination).
2. If `AUDIT_FAILED`: spawn fix implementer → re-audit until `AUDIT_PASSED`.
3. Run Step H.6 CI gate. NO CARVE-OUTS.
4. Report final state to user. DO NOT COMMIT.

The orchestrator's only job is process discipline. The implementers write code. The reviewers find problems. The auditor verifies. The orchestrator never edits code, never marks deliverables closed without reviewer sign-off, never accepts "close enough," never commits without explicit user direction.

---

## Open items the next session should re-confirm before starting

- **Branch strategy:** continue on `feat/tui-v1` (default) or fork to `feat/mcp-v1-harden`? Ask user.
- **Schema isolation rollout:** Group F adds the helper but earlier groups land before that. Acceptable? (Yes — earlier groups stay on the existing seedTestDb pattern; Group F upgrades all integration tests in one sweep.)
- **Migration ordering:** 015 (short-id reconcile) and 016 (audit_log outcome) — confirm both apply cleanly against the current dev-infra state. The user has already run migration 014 in their dev environment; 015 must drop 014's rows or coexist with them during the transition.

---

End of orchestration document. Hand this entire file to the next session along with the v1 orchestration doc + C0 audit doc to reconstruct full context.
