# `@recondo/data` New Operations — Adversarial-Workflow Orchestration Prompt

> Self-contained orchestration document. Drives the adversarial workflow at `/Users/andmer/Projects/recondo/adversarial-workflow.md` to completion of the scope at `docs/superpowers/plans/2026-05-04-C-recondo-data-new-ops.md`, plus the two trailing gaps from Plan B (D-S13 GraphQL error-conversion test + D-HT2 abort-on-disconnect test).

---

## How to use this document

1. **Read `adversarial-workflow.md` Section O first.** Internalize the 12 orchestrator rules. The most important ones for this run:
   - Rule 2 — separate agents per role (writer ≠ implementer ≠ reviewer; never combined)
   - Rule 3 — pass deliverables checklist explicitly to every test writer prompt
   - Rule 5 — re-review after every fix round
   - Rule 7 — track every finding across rounds
   - Rule 8 — flag SHAM_FIX as worse than the original finding
   - Rule 12 — never check off a deliverable that contains stubs

2. **Apply the lessons from prior runs (TUI v1 + Plan B).** Listed below — they are mandatory operating constraints, not suggestions.

3. **Run chunks in order.** C0 first (Plan B gap fixes — close the branch's existing technical debt before adding new work). Then C1 → C7. Step 5.5 final audit runs after C7. Step 6 CI gate after Step 5.5.

4. **Per chunk:** test writer → implementer → reviewer → fix round if needed → re-review until reviewer is CLEAN. Then mark chunk done. Spawn fresh agents per role; never combine.

5. **Tool discipline:** Use `Read`, `Edit`, `Write`, `Grep`. Use `Bash` only for `pnpm test`, `cargo test`, `git`, `just`, and script invocations. Never `cat`/`head`/`tail`/`wc -l`/`sed`/`awk` against repo files.

---

## Context

- **Repo:** `/Users/andmer/Projects/recondo`
- **Branch:** `feat/tui-v1` (long-running integration branch; TUI v1 + Plan B + this run all stack on top of each other)
- **Plan B HEAD:** `fd85ac1` (`test(data): public-surface smoke + AbortSignal type contract; chore: justfile recipes`)
- **Plan C source:** `docs/superpowers/plans/2026-05-04-C-recondo-data-new-ops.md`
- **Deliverables file (this orchestration's input):** this document itself, `2026-05-06-recondo-data-new-ops-orchestration.md`. The orchestrator hands relevant sections to subagents inline rather than asking them to read the file.

---

## Schema reality (BAKE INTO EVERY PROMPT)

Plan C was written without verifying the live schema. **Half the column names in its draft SQL don't exist by those names in the actual `001_core-tables.sql`.** Every test writer prompt and every implementer prompt MUST include this reality table. If an implementer writes SQL using a Plan-C-draft column name from the left column, their query will runtime-fail in production.

| Plan C draft uses | Actual schema column | Resolution |
|---|---|---|
| `turns.request_content_hash` | `turns.request_hash` | rename |
| `turns.request_bytes_total` | `turns.req_bytes_size` | rename |
| `turns.request_content_type` | **does not exist** | DROP field, OR sniff: `application/json` if first non-whitespace byte is `{` or `[`, else `application/octet-stream`. **Decision pre-baked: SNIFF.** |
| `turns.cache_read_input_tokens` | `turns.cache_read_tokens` | rename |
| `turns.time_to_first_token_ms` | `turns.ttfb_ms` | rename |
| `turns.prompt_hash` | **does not exist** | compute on-the-fly via `md5(user_request_text)` in SQL; document seq-scan perf hit in the function header |
| `turns.prompt_text` | `turns.user_request_text` | rename |
| `turns.tool_call_names` | **does not exist** (only `tool_call_count BIGINT`) | derive via `LEFT JOIN tool_calls tc ON tc.turn_id = t.id` + `array_agg(tc.tool_name)` |
| `turns.caused_by_turn_id` | **does not exist** | TRIM `caused_by` from `relatedTurns` relation enum |
| `turns.retry_of_turn_id` | **does not exist** (closest is `supersedes_turn_id`) | map `retry_of` → `supersedes_turn_id` with a documented semantic note ("supersedes ≈ retry-of: a later turn that replaces an earlier one") |
| `turns.tool_chain_id` | **does not exist** | TRIM `same_tool_chain` from `relatedTurns` relation enum |
| `turns.captured_at` | `turns.timestamp` (TEXT) | rename |
| `tool_calls.args_hash` | `tool_calls.input_hash` | rename |
| `tool_calls.success: boolean` | `tool_calls.status: TEXT` + `error: TEXT` | derive `failure_rate` from `status != 'success'`; verify the actual status enum during implementation by inspecting existing rows or the gateway's pg_schema_ddl |
| `tool_calls.latency_ms` | `tool_calls.duration_ms` | rename |
| `tool_calls.token_cost` | **does not exist** | DROP `token_cost_total` from `toolCallStats` output. **Decision pre-baked: DROP.** Replace with `total_duration_ms` (sum of `duration_ms`) so the user has *something* aggregated. |
| `tool_calls.captured_at` | **does not exist** | JOIN `turns.timestamp` for time-window filter |
| `sessions.agent_framework` | `sessions.framework` | rename |

### `relatedTurns` — trimmed relation enum

Plan C drafted 5 relations; only 3 are implementable without a schema migration:

```typescript
export type Relation = "same_session" | "same_prompt_hash" | "retry_of";
```

- `same_session` — uses `session_id` (real)
- `same_prompt_hash` — computed on-the-fly via `md5(user_request_text)` (no `prompt_hash` column)
- `retry_of` — maps to `supersedes_turn_id`. **The MCP tool description in Plan D MUST use the term "retry_of (supersedes)" or similar to make the semantic mapping visible to users.**

The dropped relations (`caused_by`, `same_tool_chain`) are NOT placeholders — they are deleted from the enum. If a future plan adds the columns, that plan adds the relations back. **Do not leave a "throws unknown relation" arm for a relation we don't ship.**

### Decisions pre-baked

1. **`relatedTurns` ships 3 relations** (above). Plan D's MCP tool description gets the truthful set.
2. **`toolCallStats` drops `token_cost_total`** (no per-tool-call cost in schema). Replaces with `total_duration_ms`.
3. **`getTurnRawMetadata.content_type` is sniffed** from the first non-whitespace byte: `{`/`[` → `application/json`; else `application/octet-stream`. Document the heuristic in the function header.

---

## Lessons from prior runs (mandatory operating constraints)

These are encoded in `~/.claude/projects/-Users-andmer-Projects-recondo/memory/feedback_*.md`. Apply to every dispatch in this run.

1. **Adversarial workflow only.** Test Writer ≠ Implementer ≠ Reviewer. NEVER combine roles "to save time." When a chunk is small enough to feel combinable, the answer is to spawn three agents anyway.

2. **No backward-compatibility shims.** When a refactor moves a name or changes a contract, update ALL consumers in the same commit. Delete the old path. No deprecation phase. (See `feedback_no_backward_compat.md`.) Plan C is purely additive so this should rarely come up — but if a new operation duplicates an existing internal helper, replace the helper, don't leave both.

3. **Native tools, not Bash piping.** Use `Read`, `Edit`, `Write`, `Grep`. Bash only for `pnpm`, `cargo`, `git`, `just`, script execution. Tell every subagent the same.

4. **Pipeline tests, not component tests.** Every D-* deliverable must have a test that drives a real production entry point and asserts on observable state. Component tests of internal helpers do NOT close a deliverable.

5. **Schema reconnaissance up-front, baked into prompts.** The C8 / Plan B `registered_keys` vs `api_keys` confusion happened because the implementer trusted a vague spec. Plan C's schema-reality table (above) is the corrective. Pass it to every chunk's prompts inline.

6. **Verify "pre-existing rot" claims before accepting them.** When a test fails and the temptation is to call it "pre-existing rot," run `git diff main..HEAD -- <area>` first. If the diff is empty, the failure is environmental, not real regression — investigate, don't dismiss.

7. **Test the deliverable's production path, not a synthetic interface.** The TUI run shipped a `KeyAction::CycleGroupBy` variant whose handler worked in tests but no `dispatch_key` ever produced it. Plan C analog: a `findSimilarPrompts` function whose `findSimilarPrompts({text})` overload works in the unit test, but the MCP tool that consumers will call is `findSimilarPrompts(turnId)` and that path has a different SQL bug. **Tests must drive the real call shape MCP/api consumers will use.**

8. **Implementer pushback on factual errors is encouraged.** If the deliverables say "use column X" and column X doesn't exist, the implementer rebuts with evidence (paste from the migration file) and the reviewer either accepts the rebuttal or escalates. Never silently invent columns.

9. **Forward-looking exports without consumers are phantom.** Plan B's audit accepted forward-looking exports (`getReport`, `listAgentActivity`) on the rationale that Plans C and D would consume them. Plan C MUST consume the ones relevant to it (e.g., `getTurnRawMetadata` and `getTurnRawChunk` will end up consumed by Plan D's MCP tools, not by api/). The orchestrator tracks: every export added in Plan C must trace to either (a) a consumer in Plan D's known surface, or (b) a real test that exercises the production call path. If neither, delete the export.

10. **Final Step 5.5 audit is mandatory and must run on a fresh agent.** That agent has not seen prior round contamination. Its uncontaminated read of "is this code phantom or production-wired" is what closes the run.

---

## Phantom-wiring red flags specific to Plan C

Hunt these in every chunk's reviewer pass:

- **SQL with column names that don't exist** — the schema-reality table above is the corrective. Reviewer greps the new SQL for any of the LEFT-column names. Hit = BLOCKER.
- **`AbortSignal` accepted but never checked before SQL** — the C2-2 pattern from Plan B. Every new operation must call `signal?.throwIfAborted()` (or `signal.aborted` check) BEFORE the first `pool.query` invocation.
- **`md5(user_request_text)` without an index** is unavoidable in v1. Reviewer accepts it but verifies the function header documents the perf cost ("seq scan; consider adding `prompt_hash` column + index in a future migration").
- **`relatedTurns` SQL hardcoding the dropped relations** — if `SQL_FOR_RELATION` includes a `caused_by` or `same_tool_chain` arm, BLOCKER.
- **Test seeders that bypass the captures pipeline.** `seedTurn` should INSERT a row that passes the same constraints production rows pass (e.g., `request_hash` is a real SHA-256 hex, `req_bytes_ref` actually points at an object in the test object store, not a fake string). Otherwise the seed masks schema drift.
- **`toolCallStats` SQL referencing `tc.captured_at`** — column doesn't exist. Must `JOIN turns t ON t.id = tc.turn_id` and use `t.timestamp::timestamptz`.
- **`compareTurns` SQL selecting `tool_call_names`** — column doesn't exist. Must derive via subquery / lateral join.
- **`getTurnRawMetadata` returning a hardcoded `content_type`** that ignores the actual bytes. The decision is "sniff from first non-whitespace byte" — verify the implementation actually does this, not just returns `"application/json"`.
- **An export added to `index.ts` but no consumer in api/, no consumer in tests/, and no documented Plan D consumer** — phantom. Delete or wire up.
- **Tests that pass against an empty DB (vacuous green)** — D-SE2 (`returns zeros for empty session`) is supposed to be vacuous. But D-FSP1 (`matches byte-identical prompts`) is NOT — if there are zero seeded matches, the test must FAIL. Reviewer reads each pipeline test and confirms it would fail under "implementation does nothing."

---

## Chunk plan (8 chunks)

| Chunk | Tasks | Scope |
|---|---|---|
| **C0** | Plan B gap fixes | D-S13 GraphQL error-conversion pipeline test + D-HT2 abort-on-disconnect integration test. No new production code. Closes Plan B gaps before Plan C work begins. |
| **C1** | Plan C T1, T2, T3 | `ObjectStore.readRange` foundation + `getTurnRawMetadata` (with content-type sniff) + `getTurnRawChunk` (32 KB cap). Coupled because the two raw-byte ops share the readRange foundation. |
| **C2** | Plan C T4 | `compareTurns` — derive `tool_call_names` via JOIN; `prompt`/`response` via `user_request_text`/`response_text`. |
| **C3** | Plan C T5 | `findSimilarPrompts` — on-the-fly `md5(user_request_text)` for hash. v1 hash-only limitation documented. |
| **C4** | Plan C T6 | `relatedTurns` — 3 relations only. `retry_of` mapped to `supersedes_turn_id`. |
| **C5** | Plan C T7 | `sessionEfficiency` — column renames; on-the-fly prompt hash for reuse-ratio; `tool_calls.input_hash` for redundancy. |
| **C6** | Plan C T8 | `toolCallStats` — drop `token_cost_total`, replace with `total_duration_ms`. `failure_rate` from `status`. JOIN turns for time-window. |
| **C7** | Plan C T9, T10, T11 | Exhaustive exports check + streaming-prep contract type tests + end-to-end sweep. |

After C7: Step 5.5 final audit (fresh agent) → Step 6 CI gate (full matrix below).

---

## Deliverables (D-*)

Each entry has the form `D-XX: <observable property> — <test that asserts it>`. The test must drive a real production path and would fail under "implementation does nothing." See `Phantom-wiring red flags` above for what to hunt during review.

### C0 — Plan B trailing gaps

- **D-S13** — A GraphQL request to the running Apollo server with `search: "x".repeat(501)` returns a response whose `errors[0].extensions.code === "BAD_USER_INPUT"` and whose error message does NOT contain the string `"DataValidationError"`. Test in `api/tests/sessions-search-validation.test.ts`. Drives the actual Apollo path, not a unit-test of the resolver.
- **D-HT2** — When a Fastify request to `/v1/query` is in flight and `reply.raw` emits `close`, the in-flight `pool.query`'s `signal` argument receives an abort. Verified by spying on `pool.query` (or on the `runStructuredQuery` `options.signal`). Test in `api/tests/query-route-abort.test.ts`. Spy must observe the actual signal flow, not a stub.

### C1 — Object-store byte-range + raw-byte ops

- **D-OS1** — `ObjectStore.readRange(hash, offset, length, signal?)` on the local driver returns a `Buffer` of length `min(length, bytes_total - offset)` against a known-content store. Test in `packages/recondo-data/tests/object-store/range.test.ts`.
- **D-OS2** — `readRange` clamps when `offset + length > bytes_total` (returns the tail).
- **D-OS3** — `readRange` rejects with `AbortError` on a pre-aborted signal BEFORE issuing any I/O.
- **D-RM1** — `getTurnRawMetadata(turnId)` returns `{content_hash: turn.request_hash, bytes_total: turn.req_bytes_size, content_type: <sniffed>, head_sample_utf8: <first ≤4096 bytes of the body>}`. Test seeds a real turn + writes the body to the local object store under the right hash, then calls `getTurnRawMetadata`. Asserts each field.
- **D-RM2** — `head_sample_utf8` is the actual first bytes of the body, not arbitrary content. Test seeds `'{"hello":"world"}'` as the body and asserts the head contains `"hello":"world"`.
- **D-RM3** — `content_type` sniff: bodies starting with `{` or `[` (after whitespace) get `application/json`; everything else gets `application/octet-stream`. Verified with two seeded bodies.
- **D-RM4** — Pre-aborted signal → AbortError before any DB or store read.
- **D-RC1** — `getTurnRawChunk(turnId, offset, length)` returns `{offset, bytes, next_offset}` with `bytes.length === min(length, 32_768, bytes_total - offset)`.
- **D-RC2** — `length > 32_768` is silently capped at 32_768.
- **D-RC3** — When `offset + bytes.length === bytes_total`, `next_offset === null`. Otherwise `next_offset === offset + bytes.length`.
- **D-RC4** — Pre-aborted signal → AbortError before any DB or store read.
- **D-RC5** — `offset < 0` or `length < 0` throws synchronously (not a deferred rejection).

### C2 — `compareTurns`

- **D-CT1** — Default `aspects` is `["prompt", "response", "tools", "cost", "tokens", "model"]` (in that order). Result `rows.length === 6`.
- **D-CT2** — `aspects: ["cost"]` produces a result with `rows.length === 1`.
- **D-CT3** — For numeric aspects (`cost`, `tokens`), `delta === Math.max(values) - Math.min(values)`. For text aspects (`prompt`, `response`, `model`), `delta === null`. For `tools`, `delta === null` (it's a list-comparison aspect).
- **D-CT4** — `tools` aspect's values are arrays of tool names per turn (derived via JOIN tool_calls + array_agg). Verified with a turn that has 2 tool calls.
- **D-CT5** — Result preserves caller-specified `turn_ids` order even if the SQL returned them in a different order.
- **D-CT6** — Empty `turn_ids` array throws synchronously.
- **D-CT7** — Non-existent turn id in input throws (with the missing id in the message).
- **D-CT8** — Pre-aborted signal → AbortError before any DB read.

### C3 — `findSimilarPrompts`

- **D-FSP1** — Two seeded turns with identical `user_request_text` produce a match (the second turn appears in the iterator output when querying with the first's id). Test asserts presence + non-presence.
- **D-FSP2** — A turn whose prompt has trailing whitespace differs and is NOT in the result. (v1 hash-only limitation working as designed.)
- **D-FSP3** — `findSimilarPrompts({text: "..."})` accepts a raw text input and returns matching turns.
- **D-FSP4** — `limit: 3` caps the iterator at 3 even when 5 matches exist.
- **D-FSP5** — Pre-aborted signal → AbortError. Mid-iteration abort throws on the next yield.
- **D-FSP6** — Function header documents the v1 limitation ("byte-identical only; whitespace differences will not match; v1.5 may add embedding-based fuzzy match").

### C4 — `relatedTurns`

- **D-RT1** — `same_session` returns the other turns in the same session (excluding the input turn), ordered by `timestamp` ASC.
- **D-RT2** — `same_prompt_hash` returns turns whose `md5(user_request_text)` matches the input turn's, excluding the input turn.
- **D-RT3** — `retry_of` returns turns where `supersedes_turn_id === inputTurnId` OR the input turn's `supersedes_turn_id` (the chain in both directions).
- **D-RT4** — Unknown relation throws synchronously with `"unknown relation: <name>"`.
- **D-RT5** — The `Relation` type has EXACTLY 3 members. Type test asserts this (`expectTypeOf<Relation>().toEqualTypeOf<"same_session" | "same_prompt_hash" | "retry_of">()`).
- **D-RT6** — Pre-aborted signal → AbortError. Mid-iteration abort throws.
- **D-RT7** — Function header documents the `retry_of → supersedes_turn_id` mapping.

### C5 — `sessionEfficiency`

- **D-SE1** — `cache_hit_rate` = `sum(cache_read_tokens) / sum(input_tokens)`. Verified with seeded `[1000, 700]` totals → `0.7`.
- **D-SE2** — `prompt_token_reuse_ratio` = (number of turns whose `md5(user_request_text)` is shared with another turn in the session) / total turns. Verified with 3 of 10 turns sharing one prompt → `0.3`.
- **D-SE3** — `tokens_per_turn` returns `{p50, p99, mean}` over `input_tokens + output_tokens`, computed via `percentile_disc`.
- **D-SE4** — `redundant_tool_call_count` counts tool_calls whose `(tool_name, input_hash)` pair appears more than once in the session (returns count - 1 per group, summed).
- **D-SE5** — `ttft_ms` returns `{p50, p99, mean}` over `ttfb_ms`.
- **D-SE6** — All metrics computed in ONE SQL round-trip (single `pool.query` call). Verified by `vi.spyOn(pool, "query")`.
- **D-SE7** — Empty session returns all zeros (no division-by-zero).
- **D-SE8** — Pre-aborted signal → AbortError before SQL.
- **D-SE9** — Header documents: percentile_disc on tiny samples (e.g., 3 turns) returns p99 = max — that's correct semantics, not a bug.

### C6 — `toolCallStats`

- **D-TS1** — `group_by: "tool_name"` returns rows keyed by tool name. Verified with seeded `[Bash, Bash (failed), Read]` → 2 rows.
- **D-TS2** — `failure_rate` = (count where `status != 'success'`) / total. Verified: 1 of 2 Bash calls failed → 0.5.
- **D-TS3** — `avg_latency_ms` = `AVG(duration_ms)` (NOT `AVG(latency_ms)` — column doesn't exist by that name).
- **D-TS4** — `total_duration_ms` = `SUM(duration_ms)` is present in the output (replacing the dropped `token_cost_total`).
- **D-TS5** — `group_by: "session"` keys rows by `t.session_id`.
- **D-TS6** — `group_by: "framework"` keys rows by `s.framework` (NOT `s.agent_framework`).
- **D-TS7** — `period: "24h"` filters via `JOIN turns t ON t.id = tc.turn_id WHERE t.timestamp::timestamptz >= now() - '24 hours'::interval`. Verified by spying on the SQL.
- **D-TS8** — Unknown period throws synchronously.
- **D-TS9** — Pre-aborted signal → AbortError. Mid-iteration abort throws on next yield.
- **D-TS10** — Output type does NOT include a `token_cost_total` field. Type-level test asserts.

### C7 — Exports + contracts + e2e

- **D-EX1** — All seven new operations exported from `packages/recondo-data/src/index.ts`. Smoke test asserts `typeof === "function"` for each.
- **D-EX2** — `ObjectStore.readRange` is on the public interface (exported from the object-store module's barrel).
- **D-CT-LIST** — `findSimilarPrompts`, `relatedTurns`, `toolCallStats` return AsyncIterables (have `[Symbol.asyncIterator]`).
- **D-CT-SCALAR** — `getTurnRawMetadata`, `getTurnRawChunk`, `compareTurns`, `sessionEfficiency` accept a final options arg with optional `{signal?: AbortSignal}`. Verified by `expectTypeOf` assertions in `tests/types.test-d.ts` (extending the existing Plan B type-test file).
- **D-E2E** — Single test seeds a 5-turn session with one duplicate prompt + a 50 KB raw body on turn 0 + 2 redundant tool calls. Calls each of the 7 new ops in sequence; asserts:
  - `getTurnRawMetadata.bytes_total === 50_000`
  - `getTurnRawChunk(0, 32768)` and `getTurnRawChunk(32768, 32768)` together cover the body, second chunk's `next_offset === null`
  - `compareTurns(allFive)` produces 6 rows with non-zero cost delta
  - `findSimilarPrompts(turn0Id)` includes turn 2 (shared prompt)
  - `relatedTurns(turn0Id, "same_session")` returns the other 4 turns
  - `sessionEfficiency(sessionId)` returns `prompt_token_reuse_ratio ≈ 0.4`, `redundant_tool_call_count === 2`
  - `toolCallStats({period: "24h", group_by: "tool_name"})` returns at least one row covering the seeded calls
- **D-PARITY** — Full matrix passes (Step 6 CI gate, below).

---

## Per-chunk dispatch templates

Each chunk follows the same pattern: test writer → implementer → reviewer → fix-loop → re-review.

### Test Writer prompt template

```
You are the Test Writer for Chunk <X> (<title>) of the @recondo/data new-ops
adversarial-workflow run. Write deliverable pipeline tests BEFORE
implementation. You may NEVER write production code.

## Tool discipline
Read/Edit/Write/Grep for files. Bash only for `pnpm test`, `git`, etc.

## Schema reality (BAKE INTO YOUR TESTS)
[Insert the schema-reality table from the orchestration doc above. Every SQL or
column reference in test assertions / spies / fixtures must use the right-column
name, never the left-column name.]

## Decisions pre-baked
1. relatedTurns ships 3 relations only: same_session, same_prompt_hash, retry_of (→ supersedes_turn_id).
2. toolCallStats drops token_cost_total; replaces with total_duration_ms.
3. getTurnRawMetadata.content_type is sniffed (`{`/`[` → application/json; else application/octet-stream).

## Phantom-wiring red flags to design tests against
- A test that asserts on the result of an internal helper — write tests that
  drive the public exported function instead.
- A test that passes against an empty DB (vacuous green) when it shouldn't —
  D-FSP1 must FAIL if the implementation does nothing.
- A test seeder that fakes the schema (e.g., inserts a turn without a real
  request_hash). Use real SHA-256 hex; write the body to the local object store
  under that hash.
- A test that exercises only the abort signal contract — every D-* needs
  positive (does the right thing) AND negative (signal aborts cleanly) coverage.

## Context
[Branch, prior commits, package state.]

## Pre-Written Test files to create
[List the test files this chunk needs, with verbatim content. Include all D-*
deliverables for this chunk inline.]

## Verification
[Run `pnpm --filter @recondo/data test 2>&1 | tail -<N>`. Expected: tests fail
because production code doesn't exist yet. List the expected error patterns.]

## Rules
- Write only the test files. Nothing else.
- Do not weaken assertions.
- Do not pre-create implementer modules.
- Do not commit.
- The schema-reality table above is the contract. SQL references in test spies
  and fixtures use the right-column name only.

## Report
1. Paths of files created.
2. Last 30 lines of verify-fail run.
3. `git status` showing only the new test files.
4. Status: TESTS_FAIL_AS_EXPECTED | NOT_AS_EXPECTED | BLOCKED.
```

### Implementer prompt template

```
You are the Implementation Agent for Chunk <X> (<title>) of the @recondo/data
new-ops adversarial-workflow run. A separate Test Writer placed failing pipeline
tests. Make them pass without breaking the existing test matrix.

## Tool discipline
Read/Edit/Write/Grep for files. Bash for `pnpm test`, `cargo test`, `git`,
`just`. Never `cat`/`wc`/`head` against repo files.

## NEW DIRECTIVE: NO BACKWARD-COMPAT SHIMS
[Carryover from Plan B. Plan C is purely additive — this rarely applies — but if
a new operation duplicates an existing helper, REPLACE the helper, don't leave
both.]

## Schema reality (USE THE RIGHT-COLUMN NAMES ONLY)
[Insert the same schema-reality table from above. Every SQL string you write
must use the right-column name. Reviewer will grep for left-column names; any
hit is a BLOCKER.]

## Decisions pre-baked
1. relatedTurns ships 3 relations: same_session, same_prompt_hash, retry_of.
2. toolCallStats drops token_cost_total; replaces with total_duration_ms.
3. getTurnRawMetadata.content_type is sniffed.

## Phantom-wiring red flags
- Forward-looking exports without a consumer in this run OR Plan D's known
  surface. Trace each new export.
- AbortSignal accepted but not checked before SQL.
- A SQL string that uses the schema-reality LEFT column name (the wrong name).
- A test that bypasses the public exported function and reaches into an
  internal helper.

## Pre-Written Failing Tests
[Test file paths from this chunk. Reminder: do NOT modify them.]

## What to implement
[Per-task spec, with the schema-reality column names already substituted in
the SQL. Include the AbortSignal check pattern at the top of each function:
  signal?.throwIfAborted();
or for older Node:
  if (signal?.aborted) throw new DOMException("aborted", "AbortError");
]

## Implementer pushback is encouraged
If a test asserts behavior that the schema cannot support (e.g., asserts
behavior on a column the schema doesn't have, after the rename), rebut with
evidence (paste from the migration file). DO NOT silently invent columns.
DO NOT silently drop assertions to make a broken test pass.

## Verification
[Run package tests + api tests + lint:arch + version-check + cargo clippy
--workspace --all-targets -- -D warnings + cargo fmt --all --check.]

## Commit
[Single commit per chunk. Message format: `recondo-data: <chunk title>`.]

## Rules
1. The pre-written tests must pass without modification (or document a rebuttal
   with evidence if a deliverable was genuinely misspecified).
2. ALL existing tests in the matrix must continue to pass:
   - cargo nextest run --workspace --features test-support
   - pnpm --filter @recondo/data test
   - pnpm --filter recondo-api test
   - pnpm --filter recondo-dashboard test
3. cargo clippy --workspace --all-targets -- -D warnings: clean.
4. cargo fmt --all --check: clean.
5. AbortSignal checked BEFORE first pool.query in every new function.
6. No transport imports in package (lint:arch passes).
7. No phantom exports (every new export has a consumer in this chunk OR a
   pinned use in a test that drives a real path).

## Report
1. Files created/modified.
2. Schema-reality column rename map applied (sample: list 3 SQL queries you
   wrote and show they use the right-column names).
3. Test outputs (last 10 lines per suite).
4. Commit SHA.
5. Honest assessment.
6. Status: DONE | DONE_WITH_CONCERNS | BLOCKED.
```

### Reviewer prompt template

```
Process Reviewer for Chunk <X> (<title>) of the @recondo/data new-ops
adversarial-workflow run. Find every problem.

## Tool discipline
Read/Grep/Edit. Bash only for `pnpm test`, `cargo test`, `git`.

## Critical scrutiny

### 1. Test fidelity
Confirm the implementer did NOT modify any pre-written test (or documented a
rebuttal with evidence). Reviewer reads each pre-written test file and compares
to the test writer's spec.

### 2. Schema-reality compliance
Grep the new SQL files for LEFT-column names from the schema-reality table:
  request_content_hash | request_bytes_total | request_content_type |
  cache_read_input_tokens | time_to_first_token_ms | prompt_hash |
  prompt_text | tool_call_names | caused_by_turn_id | retry_of_turn_id |
  tool_chain_id | (turns.captured_at — but tool_calls has no captured_at,
  while turns.timestamp is the right name) | args_hash |
  (tool_calls.success — boolean column doesn't exist) | latency_ms |
  token_cost | (tool_calls.captured_at) | agent_framework
Any hit = BLOCKER (silent runtime SQL failure).

### 3. AbortSignal honor
For each new exported function, read the body and verify the FIRST executable
statement (after argument validation) is a signal check. List the line:column
of the signal check for each function.

### 4. Phantom-wiring trace
Pick 3 new exports. For each, grep for callers in:
  api/src/   (api consumer?)
  packages/recondo-data/src/  (other package internal?)
  packages/recondo-data/tests/  (test consumer?)
If only test consumers exist, the export is "smoke-only" — flag and confirm a
Plan D consumer exists or will exist.

### 5. Run the full test matrix
[List the commands. All must pass.]

### 6. Move-completeness / size sanity
Plan C is additive. Verify no api/ resolver was modified that shouldn't have
been. `git diff fd85ac1..HEAD -- api/` shows zero changes (or only the C0 gap
fixes if this is C0).

### 7. Specific to this chunk
[List 2-3 chunk-specific things to verify. Examples per chunk:
  C1: head_sample_utf8 sniff handles {  / [ / arbitrary bytes correctly;
      content-type is sniffed not hardcoded.
  C4: Relation type has exactly 3 members.
  C5: All metrics computed in ONE pool.query call (verify by counting calls).
  C6: token_cost_total is NOT in the output type or SQL.
]

## Output
For each finding:
- ID: FIND-C<n>-<m>
- Severity: BLOCKER | WARNING | NOTE | SHAM_FIX
- Location: file:line
- Issue
- Evidence
- Fix

Final verdict: CLEAN | DIRTY.
```

---

## C0 — Plan B trailing gaps (dispatch first)

### C0 Test Writer prompt (verbatim — drop into Agent tool)

```
You are the Test Writer for Plan B Chunk 0 (gap-fix) of the @recondo/data
adversarial-workflow run. Two pre-existing deliverables shipped without their
pipeline tests; this chunk closes those gaps before Plan C work begins.

## Tool discipline
Read/Edit/Grep/Write for files. Bash only for `pnpm test`, `git`.

## Context
- Workspace: /Users/andmer/Projects/recondo
- Branch: feat/tui-v1
- Plan B HEAD: fd85ac1

## Gaps to close

### D-S13 — GraphQL error-conversion pipeline test
The api/src/resolvers/sessions.ts has a `try { ... } catch (DataValidationError
=> throw GraphQLError(..., { extensions: { code: "BAD_USER_INPUT" } }))` block.
No test exercises it. Delete the catch tomorrow → no test fails.

Write `api/tests/sessions-search-validation.test.ts`:
- Set up the running api harness (similar to existing `api/tests/auth.test.ts`
  pattern — uses `./setup.js` with `setupDatabase`/`teardownDatabase`).
- Issue a GraphQL `query Sessions($filter: SessionFilter)` request with
  `filter.search = "x".repeat(501)`.
- Assert the response has at least one entry in `errors`.
- Assert `errors[0].extensions.code === "BAD_USER_INPUT"`.
- Assert `errors[0].message` does NOT contain the string "DataValidationError"
  (the package's error class name must not leak through HTTP).

### D-HT2 — Abort-on-disconnect integration test
api/src/routes/query.ts wires `reply.raw.on("close")` →
`AbortController.abort()` and passes `{signal}` to `runStructuredQuery(...)`.
No test verifies it fires.

Write `api/tests/query-route-abort.test.ts`:
- Spy on the `signal` argument that runStructuredQuery receives. Easiest:
  vi.spyOn(@recondo/data exports, "runStructuredQuery") and capture the
  options.signal on call.
- Issue a Fastify request to `/v1/query` with a valid body. After the spy
  captures the signal, simulate `reply.raw.emit("close")`.
- Assert the captured signal's `aborted` becomes true.
- Restore the spy at the end.

If the spy approach is awkward against the live ESM module, an alternate
approach: use a real `pool.query` spy that captures the signal threaded by
the test runner (sessions, anomalies, etc. functions all forward signal to
pool.query via their internal patterns; query route sets the signal on
runStructuredQuery → which forwards to private query helpers; the private
helpers may or may not forward signal further). The signal on runStructuredQuery
is the contract; that's what the test must observe.

## Phantom-wiring red flags
- A test that asserts on `result.errors[0].extensions.code` but uses an
  in-process Apollo executeOperation — that DOES exercise the resolver path
  (acceptable). A test that mocks the resolver entirely doesn't.
- A test that calls `runStructuredQuery` directly with `{signal: ctrl.signal}`
  — that proves the dispatcher honors signal but does NOT prove the route's
  reply.raw.on("close") wiring fires. The route-level test must drive the
  Fastify route, not just the dispatcher.

## Verification
After writing the two test files:
  pnpm --filter recondo-api test 2>&1 | tail -10
Expected: 2 NEW tests fail (because the assertions hit real behavior the
existing wiring does support — actually wait. Re-read.)

ACTUALLY: D-S13's wiring DOES exist (the catch block in sessions.ts).
D-HT2's wiring DOES exist (in api/src/routes/query.ts).
So when the test writer drops in tests against existing wiring, the tests
should PASS on the first run.

If a test fails, that's a genuine surprise — it means the wiring claim from
the C9 implementer's report was wrong. Investigate:
- For D-S13: confirm api/src/resolvers/sessions.ts:catch (DataValidationError
  => GraphQLError({code: BAD_USER_INPUT})) actually exists.
- For D-HT2: confirm api/src/routes/query.ts has reply.raw.on("close") →
  AbortController.abort() actually wired.

If the wiring DOESN'T exist (was the audit's claim phantom?), document and
escalate to the implementer for actual implementation, not just test addition.

## Rules
- Write only the test files.
- Do not weaken assertions.
- The tests must drive REAL paths (Apollo + Fastify), not internal helpers.
- Do not commit (implementer commits the test + any wiring fix together).

## Report
1. File paths created (2).
2. Verification run — DID THE TESTS PASS or FAIL on the first run?
   If PASS: the wiring already works; chunk is closed by adding tests alone.
     Confirm explicitly that you did NOT modify any production code.
   If FAIL: explain what the actual wiring is and what the gap is. Hand off
     to the implementer for code changes.
3. Status: TESTS_PASS_VERIFIED_WIRING | TESTS_FAIL_NEED_IMPLEMENTER | BLOCKED.
```

### C0 Implementer prompt

If C0 Test Writer returns `TESTS_PASS_VERIFIED_WIRING`, the implementer's job is just to commit the new tests:

```
You are the Implementation Agent for Plan B Chunk 0 gap-fix. The Test Writer
verified the existing wiring is real and the two new tests pass on first run.
Your job: commit the new test files, no production code changes.

[Run all the verification commands; commit; report.]
```

If C0 Test Writer returns `TESTS_FAIL_NEED_IMPLEMENTER`, the implementer
investigates the actual wiring and either fixes it (writing real production
code) or documents an escalation.

### C0 Reviewer prompt
Standard reviewer template above; specific scrutiny:
- Tests drive real Apollo / Fastify paths (not in-process helpers).
- D-S13 test asserts `extensions.code === "BAD_USER_INPUT"` AND that the error
  message does NOT contain "DataValidationError".
- D-HT2 test observes the actual signal threaded through, not a stub.
- All 1330+ existing api tests still pass; new count is 1332.

---

## C1–C7 — Plan C new operations

For each, generate the test writer / implementer / reviewer prompts using the
templates above. Substitute:
- The chunk's specific D-* deliverables from the section above.
- The chunk's specific files to create.
- The chunk's specific schema-reality concerns.
- The chunk's specific phantom-wiring red flags.

The orchestrator should NOT manually rewrite the templates — it should fill the
slots and dispatch. If a chunk's reviewer flags issues, dispatch a fix-round
(implementer with the findings + rebuttal-allowed instructions) → re-review.
Repeat until reviewer reports CLEAN.

---

## Step 5.5 — Final comprehensive audit

After C7 reviewer reports CLEAN, dispatch a FRESH agent that has NOT seen any
prior round. Audit prompt:

```
You are performing the FINAL COMPREHENSIVE AUDIT (Step 5.5) of the @recondo/data
new-ops adversarial-workflow run. You are a FRESH agent — no prior round
contamination.

## Tool discipline
Read/Edit/Grep. Bash for `pnpm test`, `cargo test`, `git`, `just`.

## Project Context
[Workspace, branch, plan path, deliverables doc path.]

## Audit tasks

### 1. Deliverables verification
[Read the deliverables-by-chunk section of the orchestration document above.
For each D-* item, verify the contract is met (find the test that asserts it),
production wiring exists, and there's no phantom wiring (smoke-only export
without a real consumer).]

### 2. Step 5.5 mandatory checks
a. Public surface trace: every new export from packages/recondo-data/src/index.ts
   has a consumer in api/src/, packages/recondo-data/src/, packages/recondo-data/tests/,
   OR a documented Plan D MCP tool that will consume it. List the trace per export.
b. AbortSignal honor: every new async function calls signal?.throwIfAborted()
   (or equivalent) before the first pool.query. List line:column per function.
c. Schema-reality compliance: grep the new SQL for LEFT-column names from the
   schema-reality table. Zero hits expected.
d. relatedTurns: confirm exactly 3 relations in the type, 3 SQL arms, no
   leftover caused_by/same_tool_chain references.
e. toolCallStats: confirm no token_cost_total in output type or SQL. Confirm
   total_duration_ms IS present.
f. getTurnRawMetadata: confirm content_type is sniffed (not hardcoded).
g. End-to-end sweep test passes against a real seeded session.
h. Existing api / dashboard test counts unchanged from Plan B baseline.

### 3. Run the full CI gate (Step 6)
- pnpm install --frozen-lockfile
- pnpm --filter @recondo/data build
- pnpm --filter @recondo/data run lint:arch
- pnpm --filter @recondo/data run test:types
- pnpm --filter @recondo/data test
- pnpm --filter recondo-api test
- pnpm --filter recondo-dashboard test
- node scripts/version-check.mjs
- cargo build --workspace
- cargo nextest run --workspace --features test-support
- cargo clippy --workspace --all-targets -- -D warnings
- cargo fmt --all --check
- cargo run --quiet --package xtask -- lint-arch
- just ci-typescript

All must pass. List final counts per suite.

### 4. Output
Final verdict: AUDIT_PASSED | AUDIT_FAILED.
[Justification + per-deliverable evidence.]
```

---

## Step 6 — CI gate

Final commit must pass the full matrix. Numeric baselines as of Plan B HEAD `fd85ac1`:

- `cargo nextest run --workspace --features test-support` — **1669** passed
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
- `cargo fmt --all --check` — clean
- `cargo run --package xtask -- lint-arch` — clean
- `pnpm --filter @recondo/data test` — **263** passed (will grow with C0–C7)
- `pnpm --filter @recondo/data run lint:arch` — clean
- `pnpm --filter @recondo/data run test:types` — clean
- `pnpm --filter recondo-api test` — **1330** passed (will grow by 2 after C0)
- `pnpm --filter recondo-dashboard test` — **732** passed (no Plan-C changes expected)
- `node scripts/version-check.mjs` — clean
- `just ci-typescript` — clean

Plan C should add (estimated):
- C0: +2 api tests = 1332.
- C1–C6: ~40–60 new package tests across the 7 operations.
- C7: ~20 new package tests (smoke + types + e2e).

Final expected: package ≥ 320 tests, api = 1332, dashboard = 732, rust = 1669.

Any number below baseline = AUDIT_FAILED.

---

## Run discipline summary (cheat sheet)

Per chunk:
1. Spawn Test Writer with deliverables checklist + schema-reality table inline.
2. Test Writer reports TESTS_FAIL_AS_EXPECTED (or PASS for C0).
3. Spawn Implementer with same context + the now-existing failing tests.
4. Implementer reports DONE | DONE_WITH_CONCERNS | BLOCKED.
5. Spawn Reviewer with the chunk's specific scrutiny list.
6. Reviewer reports CLEAN | DIRTY.
7. If DIRTY: spawn Fix Implementer with findings → re-review.
8. When reviewer reports CLEAN: mark chunk done.

After C7:
1. Spawn fresh Step 5.5 Auditor.
2. If AUDIT_FAILED: spawn fix implementer → re-audit until PASSED.
3. Run Step 6 CI gate.
4. Report final state to user.

The orchestrator's only job is process discipline. The implementers write code.
The reviewers find problems. The auditor verifies. The orchestrator never edits
code, never marks deliverables closed without reviewer sign-off, never accepts
"close enough."
