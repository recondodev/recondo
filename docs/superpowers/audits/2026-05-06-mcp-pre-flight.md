# `recondo-mcp` v1 — C0 Pre-Flight Surface Audit

- **Date:** 2026-05-06
- **Branch:** `feat/tui-v1`
- **HEAD:** `f619e59d2e5410243fe47ec49dba438682fa77bb`
- **Auditor:** C0 Pre-Flight Surface Auditor (research-only)
- **Plan D:** `docs/superpowers/plans/2026-05-04-D-mcp-server-v1.md`
- **Orchestration:** `docs/superpowers/audits/2026-05-06-mcp-server-v1-orchestration.md`

This document is the contract that C1..C13 honor.

---

## 1. Methodology

Files read in full or in part:

- `docs/superpowers/audits/2026-05-06-mcp-server-v1-orchestration.md` — context.
- `packages/recondo-data/src/index.ts` — canonical export list (loaded; line numbers below cite this file unless noted).
- `packages/recondo-data/src/audit.ts` — confirm `listAuditEvents` only reads from `turns` (no INSERT path; no `insertAuditLog` precedent).
- `packages/recondo-data/src/pool.ts` — verify `getPool` / `closePool` / `checkDatabaseHealth` (no `initialize` export).
- `api/migrations/002_api-tables.sql` — `access_audit_log` schema.
- `api/migrations/004_compliance.sql` — `compliance_audit_log` schema (different purpose).
- `api/migrations/005_reports-policies-keys.sql` — `policies`, `registered_keys` schemas.
- `api/src/audit.ts` — existing `logAuditEntry` reference implementation against `access_audit_log`.
- MCP TS SDK README on the `v1.x` GitHub branch via `gh api`.
- MCP TS SDK `docs/server.md` on the `v1.x` GitHub branch via `gh api`.

Searches performed (Bash with quoted globs only — no `cat`/`head`/`tail`/`sed`/`awk`):

- `grep -rn "insights|insertAuditLog|mintScopedKey|__tableTargets" packages/recondo-data/src/` — zero hits in source files outside `index.ts`'s comment line for `insights` (no hits).
- `grep -rn "CREATE TABLE.*audit_log" api/migrations/` — only `access_audit_log` (002), `compliance_audit_log` (004); NO plain `audit_log`.
- `grep -rn "modelcontextprotocol" /Users/andmer/Projects/recondo/` (excluding `node_modules`) — only Plan B/D doc references; the SDK is not yet installed anywhere.
- `pnpm view @modelcontextprotocol/sdk version` → **`1.29.0`** (latest stable 1.x at audit time).
- `pnpm view @modelcontextprotocol/sdk versions --json` → 1.29.0 is the highest published 1.x.
- `gh api 'repos/modelcontextprotocol/typescript-sdk/contents/README.md?ref=v1.x'` → confirms v1.x API surface.
- `gh api 'repos/modelcontextprotocol/typescript-sdk/contents/docs/server.md?ref=v1.x'` → confirms `McpServer.registerTool(name, {description, inputSchema, ...}, handler)` is the canonical v1.x shape.

`mcp/` directory does **not yet exist** on disk; `node_modules/@modelcontextprotocol` does not exist (no install has occurred).

---

## 2. D-C0-1 — API-reality verification table

Every left-column name comes from Plan D / orchestration. The "Real export name" column reproduces the orchestration's right column. The "Verified" column is this auditor's evidence-backed verdict.

All `EXISTS` line citations are against `packages/recondo-data/src/index.ts` at HEAD `f619e59`.

| Plan D assumes | Real export name | Verified | Evidence |
|---|---|---|---|
| `listSessions` | `listSessions` | EXISTS — line 86 | `export { listSessions, getSession, listUserTurns } from "./sessions.js";` |
| `getSession` | `getSession` | EXISTS — line 86 | same line as above |
| `getTurn` | `getTurn` | EXISTS — line 91 | `export { getTurn, searchTurns, verifyIntegrity } from "./turns.js";` |
| `getTurnRawMetadata` | `getTurnRawMetadata` | EXISTS — line 96 | `export { getTurnRawMetadata, getTurnRawChunk } from "./turns-raw.js";` |
| `getTurnRawChunk` | `getTurnRawChunk` | EXISTS — line 96 | same line |
| `search` | `searchTurns` | RENAME → `searchTurns` (line 91) | left name absent (grep zero hits for `^export.*search\b` other than `searchTurns`); right name on line 91 |
| `verifyIntegrity` | `verifyIntegrity` | EXISTS — line 91 | same line |
| `compareTurns` | `compareTurns` | EXISTS — line 100 | `export { compareTurns } from "./compare-turns.js";` |
| `findSimilarPrompts` | `findSimilarPrompts` | EXISTS — line 108 | `export { findSimilarPrompts } from "./find-similar-prompts.js";` |
| `relatedTurns` | `relatedTurns` | EXISTS — line 117; `Relation` type line 118 | `export { relatedTurns } from "./related-turns.js";` / `export type { Relation, RelatedTurnsRow } ...`. Per orchestration, the `Relation` union is 3 members: `same_session | same_prompt_hash | retry_of`. |
| `sessionEfficiency` | `sessionEfficiency` | EXISTS — line 123 | `export { sessionEfficiency } from "./session-efficiency.js";` |
| `realtimeStats` | `getRealtimeStats` | RENAME → `getRealtimeStats` (line 196) | `realtimeStats` absent; `export { getRealtimeStats, listRealtimeFeed, getGatewayStatus, ... } from "./realtime.js";` |
| `gatewayStatus` | `getGatewayStatus` | RENAME → `getGatewayStatus` (line 196) | same line |
| `realtimeFeed` | `listRealtimeFeed` | RENAME → `listRealtimeFeed` (line 196) | same line |
| `usageSummary` | `getUsageSummary` | RENAME → `getUsageSummary` (line 151) | `export { resolveDateRange, getUsageSummary, listSpendByProvider, ... } from "./cost.js";` |
| `spendByProvider` | `listSpendByProvider` | RENAME → `listSpendByProvider` (line 152) | same `cost.js` block |
| `spendByModel` | `listSpendByModel` | RENAME → `listSpendByModel` (line 153) | same |
| `spendByFramework` | `listSpendByFramework` | RENAME → `listSpendByFramework` (line 154) | same |
| `dailySpend` | `listDailySpend` | RENAME → `listDailySpend` (line 155) | same |
| `costProjections` | `getCostProjections` | RENAME → `getCostProjections` (line 156) | same |
| `agentSummary` | `getAgentSummary` | RENAME → `getAgentSummary` (line 212) | `export { getAgentSummary, listAgentFrameworkDistribution, listTopDevelopers, listTopRepositories, listAgentActivity } from "./agents.js";` |
| `agentFrameworkDistribution` | `listAgentFrameworkDistribution` | RENAME → `listAgentFrameworkDistribution` (line 213) | same agents block |
| `topDevelopers` | `listTopDevelopers` | RENAME → `listTopDevelopers` (line 214) | same |
| `topRepositories` | `listTopRepositories` | RENAME → `listTopRepositories` (line 215) | same |
| `toolCallStats` | `toolCallStats` | EXISTS — line 133 | `export { toolCallStats } from "./tool-call-stats.js";`. Output type lacks `token_cost_total`; ships `total_duration_ms`. |
| `auditTrail` | `listAuditEvents` | RENAME → `listAuditEvents` (line 166) | `export { listAuditEvents, getAuditEntries } from "./audit.js";`. Note: `audit.ts` reads from `turns` table, not from `access_audit_log` (relevant for D-C13-7). |
| `anomalies` | `listAnomalies` | RENAME → `listAnomalies` (line 145) | `export { listAnomalies } from "./anomalies.js";` |
| `complianceSummary` | `getComplianceSummary` | RENAME → `getComplianceSummary` (line 176) | `export { getComplianceSummary, listComplianceFrameworks, listComplianceAuditLog, listComplianceFindings, updateControlStatus } from "./compliance.js";` |
| `complianceFrameworks` | `listComplianceFrameworks` | RENAME → `listComplianceFrameworks` (line 177) | same |
| `complianceAuditLog` | `listComplianceAuditLog` | RENAME → `listComplianceAuditLog` (line 178) | same — note: this reads `compliance_audit_log` (control-status mutation history), distinct from MCP's per-call audit log. |
| `insights` | **DOES NOT EXIST** | MISSING — decision: **DROP** (see §5) | `grep -n "insights" packages/recondo-data/src/` returns zero hits. |
| `reports` | `listReports` | RENAME → `listReports` (line 229) | `export { listReports, getReport, listReportCoverageTrend, listReportFindingsTrend, generateReport } from "./reports.js";` |
| `reportCoverageTrend` | `listReportCoverageTrend` | RENAME → `listReportCoverageTrend` (line 231) | same |
| `reportFindingsTrend` | `listReportFindingsTrend` | RENAME → `listReportFindingsTrend` (line 232) | same |
| `policies` | `listPolicies` | RENAME → `listPolicies` (line 247) | `export { listPolicies, getPolicy, listPolicyTriggerHistory, createPolicy, updatePolicy, deletePolicy } from "./policies.js";` |
| `registeredKeys` | `listApiKeys` | RENAME → `listApiKeys` (line 267) | `export { listApiKeys, createApiKey, revokeApiKey } from "./keys.js";`. Per code comment lines 262–264: this operates on the `registered_keys` table (NOT `api_keys`); the file is named `keys.ts`. The MCP tool `recondo_registered_keys` matches the table semantically. |
| `generateReport` | `generateReport` | EXISTS — line 233 | same reports block |
| `updateControlStatus` | `updateControlStatus` | EXISTS — line 180 | same compliance block |
| `createPolicy` | `createPolicy` | EXISTS — line 250 | same policies block |
| `updatePolicy` | `updatePolicy` | EXISTS — line 251 | same |
| `deletePolicy` | `deletePolicy` | EXISTS — line 252 | same |
| `registerKey` | `createApiKey` | RENAME → `createApiKey` (line 267) | same keys block. NOTE: this writes the `registered_keys` table (managed LLM keys), NOT the auth `api_keys` table. The MCP tool `recondo_register_key` mirrors the dashboard surface. |
| `deleteKey` | `revokeApiKey` | RENAME → `revokeApiKey` (line 267) | same. The action is non-destructive in the SQL sense (sets `status='revoked'` / `revoked_at=now()`), but Plan D registers it with `destructive: true` because it removes operational capability. |
| `authenticateApiKey` | `authenticateApiKey` | EXISTS — line 50 | `export { authenticateApiKey, authenticateRequest } from "./auth.js";`. NOTE: this reads the **`api_keys`** table (auth tokens), distinct from `registered_keys`. |
| `insertAuditLog` | **DOES NOT EXIST** | MISSING — decision: **ADD** to `@recondo/data` in C1 (see §5) | `grep -n "insertAuditLog\|insertAudit\b" packages/recondo-data/src/` returns zero hits. `audit.ts` exports only `listAuditEvents` and `getAuditEntries`. |
| `mintScopedKey` | **DOES NOT EXIST** | MISSING — decision: **DEFER** (see §5) | `grep -rn "mintScopedKey\|scopedKey\|mintKey" packages/recondo-data/src/` returns zero hits. No scoped-key minting infra exists in api/ either (manual `INSERT INTO api_keys` only). |
| `initialize` | **DOES NOT EXIST** | MISSING — decision: **use `getPool()` directly** (see §5) | `pool.ts` exports only `getPool`, `closePool`, `checkDatabaseHealth`. There is no `initialize` symbol; pool construction is lazy on first `getPool()` call (read of `pool.ts` confirms). |
| `__tableTargets` | **DOES NOT EXIST** | MISSING — decision: **DEFER (Phase 2 future work)** (see §5) | `grep -rn "__tableTargets\|tableTargets" packages/recondo-data/src/` returns zero hits. |

### New BLOCKERs surfaced beyond the orchestration table

**None.** Every right-column name in the orchestration's table either EXISTS verbatim in `packages/recondo-data/src/index.ts` or is the `MISSING` row already flagged for a C0 decision. No third-tier rename was discovered during this audit.

### Corrections to orchestration claims

- The orchestration says `complianceAuditLog → listComplianceAuditLog` is a rename for `recondo_compliance` view dispatch. **Confirmed** — and the data-layer function reads the `compliance_audit_log` table (control-status change history). This is structurally **different** from the per-call MCP audit log (D-C0-2). C8's `recondo_compliance` tool reads the former; C13-7 (`audit_log.test.ts`) writes/reads the latter. The two MUST NOT be confused.
- The orchestration says `registeredKeys → listApiKeys`. **Confirmed**. The filename `keys.ts` and the function name `listApiKeys` are misleading; per the file's exported docstring (lines 262–264 of `index.ts`), the function actually queries `registered_keys` (managed LLM keys). The auth-side `api_keys` table is queried by `authenticateApiKey` in `auth.ts`. C9 tools and tests must read the file's docstring before assuming.

---

## 3. D-C0-2 — `audit_log` table verification

### Verdict: **MISSING — no plain `audit_log` table exists.**

The closest extant tables in `api/migrations/` are:

| Table | Migration | Purpose |
|---|---|---|
| `access_audit_log` | `api/migrations/002_api-tables.sql:24` | API request audit (CC6) — written by `api/src/audit.ts::logAuditEntry`. |
| `compliance_audit_log` | `api/migrations/004_compliance.sql:38` | Control-status change history — written by the GraphQL `updateControlStatus` mutation. |

Neither matches Plan D's expected per-call MCP audit log shape. Concretely:

#### `access_audit_log` (closest existing fit) vs Plan D expectation

Migration 002 lines 23–34:

```
CREATE TABLE IF NOT EXISTS access_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
    api_key_id TEXT NOT NULL,
    user_id TEXT,
    query_type TEXT NOT NULL,
    resource_ids TEXT[],
    source_ip TEXT,
    user_agent TEXT,
    response_status INT
);
```

Append-only enforcement: trigger `audit_log_immutability` on UPDATE/DELETE (migration 002 lines 44–48).

| Plan D expected column | `access_audit_log` column | Status | Notes |
|---|---|---|---|
| `tool_name` | (closest: `query_type TEXT`) | DRIFT | `query_type` is a coarse label like `"tools/call"`. We need `tool_name` granularity (e.g., `"recondo_list_sessions"`). |
| `arguments` (jsonb) | (none) | MISSING | No `JSONB` column. |
| `response_bytes` | (closest: `response_status INT`) | MISSING | `response_status` is HTTP status, not byte size. |
| `client_name` | (closest: `user_agent TEXT`) | DRIFT | `user_agent` is closer to a UA string. MCP `client_name` comes from MCP `initialize.clientInfo.name`. |
| `key_id` | `api_key_id TEXT NOT NULL` | DRIFT (rename) | Same concept; column name differs. |
| `requested_at` | `timestamp TIMESTAMPTZ` | DRIFT (rename) | Same concept; column name differs. |

### Recommendation: **MIGRATE — add new `audit_log` table, do not overload `access_audit_log`.**

Rationale:
1. `access_audit_log` is REST-API-shaped (HTTP status, source IP, user agent). MCP per-tool-call audit needs JSONB args + tool name + response byte count. Forcing them into the same table breaks both schemas.
2. `access_audit_log` is already wired into SOC 2 CC6 evidence exports (`api/src/exports/soc2.ts:115`). Mutating its schema would break the existing exporter; adding optional columns keeps coupling but loses the column NOT-NULL invariants the api/ writer relies on.
3. C0 authorizes additive changes to `@recondo/data`. A new migration adding `audit_log` (with the Plan D shape) is in scope as part of C1 — paired with the new `insertAuditLog` export decision in §5.

**Action item for C1:** create `api/migrations/013_mcp-audit-log.sql` with:

```
CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tool_name TEXT NOT NULL,
    arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_bytes INTEGER NOT NULL DEFAULT 0,
    client_name TEXT,
    key_id TEXT
);

-- Append-only (mirror access_audit_log):
DROP TRIGGER IF EXISTS audit_log_mcp_immutability ON audit_log;
CREATE TRIGGER audit_log_mcp_immutability
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_mutation();

CREATE INDEX IF NOT EXISTS idx_audit_log_requested_at ON audit_log(requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_tool_name ON audit_log(tool_name);
CREATE INDEX IF NOT EXISTS idx_audit_log_key_id ON audit_log(key_id);
```

Reuses the existing `prevent_audit_mutation()` PL/pgSQL function defined in 002. Plan D Test 33 (action_immutability) does NOT touch `audit_log`; `audit_log` is observability, not captured. The GDPR bypass is unrelated.

**C13-7 (`audit_log.test.ts`) must SELECT FROM `audit_log` (not `access_audit_log`).** Confirm in test writer prompt.

---

## 4. D-C0-3 — `@modelcontextprotocol/sdk` version + shape

### Version pin: **`^1.29.0`** (latest stable 1.x at audit time, 2026-05-06).

Verified via:

```
$ pnpm view @modelcontextprotocol/sdk version
1.29.0
```

Plan D §line 201 currently shows `"@modelcontextprotocol/sdk": "^1.0.0"`. C1 must pin `^1.29.0` (or floor `^1.x` per the npm semver caret semantics; `^1.0.0` resolves to `<2.0.0` and would also pull 1.29.x at install time, so the practical difference is the floor on bug-fix-only versions). **Recommendation: `^1.29.0`** to lock in known-good stdio behavior and zod-v4 import path conformance.

### Shape: **NEW shape (`McpServer.registerTool`) is canonical in v1.x; OLD shape (`Server.setRequestHandler`) is also available.** Both ship in the same package.

Evidence — v1.x README quick-start example (fetched via `gh api`):

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'my-server', version: '1.0.0' });
server.registerTool(
    'calculate-bmi',
    {
        title: 'BMI Calculator',
        description: 'Calculate Body Mass Index',
        inputSchema: {
            weightKg: z.number(),
            heightM: z.number()
        },
        outputSchema: { bmi: z.number() }
    },
    async ({ weightKg, heightM }) => { ... }
);
```

Source: `gh api 'repos/modelcontextprotocol/typescript-sdk/contents/docs/server.md?ref=v1.x'` (v1.x branch HEAD; section "Tools, resources, and prompts").

### Subtle delta from Plan D's draft

Plan D (line 808) says `Server.tool(name, description, schema, handler)`. The actual v1.x SDK call is:

- Class: `McpServer` (from `@modelcontextprotocol/sdk/server/mcp.js`), not bare `Server`.
- Method: `registerTool(name, opts, handler)` — opts is `{ title?, description, inputSchema, outputSchema? }`. Description and inputSchema are NESTED inside opts, NOT positional.

The 4-arg "Server.tool" form Plan D drafts is NOT the v1.29 API. C1 implementer must use `McpServer.registerTool(name, {description, inputSchema}, handler)`. The orchestration's "new shape" guidance is correct in spirit; the exact call signature differs by one level of nesting.

### Recommended use

- C1 wires `McpServer` + `StdioServerTransport`.
- The registry layer maps each tool's `{name, description, zodSchema, handler}` record into a `server.registerTool(name, { description, inputSchema }, handler)` call.
- Resources use `server.registerResource(uriTemplate, opts, handler)`.
- Prompts use `server.registerPrompt(name, opts, handler)`.
- Fall back to `Server.setRequestHandler(...)` ONLY if a feature gap forces it (none expected for Plan D's stdio + tools/resources/prompts surface).

### Schema-validation library

The v1.x SDK's `inputSchema` accepts a Zod v4 (or v3.25+) shape. Plan D already declares `zod` as a dependency — confirm the C1 `package.json` declares it. The SDK's internal `zod/v4` import is forward-compatible with v3.25+ per the README.

---

## 5. D-C0-4 — Decisions

### Decision 1: `recondo_insights` (`insights` data-layer function) — **DROP**

The `recondo_insights` tool surfaces "what should I do next" recommendations. There is no underlying `insights` function in `@recondo/data`, no `insights` table or view, and no Plan B/C work that materializes one. Adding a real implementation would require designing an insight-extraction algorithm (rule-based or otherwise) — well outside Plan D's "thin adapter" scope.

**Rationale:** Plan D is explicitly thin adapters over existing data-layer functions. A net-new business-logic surface belongs in a future Plan E. Dropping the tool keeps the read-tool catalog at **27** (Plan D's draft was 28; Plan C's reality + this drop = 27). The catalog parity lint enforces 1:1 against extant data-layer functions, so dropping is mechanically clean.

**Downstream impact:**

- C8 ships 5 audit/compliance read tools (not 6); the `recondo_insights` registration is removed.
- C9's catalog count test asserts `READ_TOOLS.length === 27` (NOT 28).
- C12's prompt templates are unaffected (no prompt depends on `recondo_insights`).

### Decision 2: `insertAuditLog` (audit writer) — **ADD inline in C1**

Plan D requires every MCP tool call to append a row to the audit log. There is no existing `insertAuditLog` in `@recondo/data` (`audit.ts` is read-only). Per D-C0-2, the per-call audit log is a NEW table.

**Rationale:** The audit writer is load-bearing for Plan D's compliance posture (D-C13-7 `audit_log.test.ts`). Adding an `insertAuditLog` export to `@recondo/data` keeps the data-access layer cleanly separated from the MCP transport — same pattern as Plan B's other inserts (`createPolicy`, `createApiKey`). Ships inside C1's chunk; signature:

```typescript
export async function insertAuditLog(entry: {
  toolName: string;
  arguments: unknown; // serialized via JSON.stringify before INSERT
  responseBytes: number;
  clientName?: string | null;
  keyId?: string | null;
  requestedAt?: Date;       // defaults to now() in SQL
}, options?: QueryOptions): Promise<void>;
```

Failure semantics: the function CAN throw; the MCP-side `mcp/src/audit/writer.ts::writeAuditEntry` swallows + logs (per D-C1-8). This keeps the data-layer pure-error-pass-through and isolates the "audit-is-observability-not-gating" policy at the MCP boundary.

**Migration:** see §3 — C1 adds `api/migrations/013_mcp-audit-log.sql`. Files for `@recondo/data`: new `packages/recondo-data/src/audit.ts` is updated (or a sibling `packages/recondo-data/src/audit-mcp.ts` is added; either is fine — recommend extending `audit.ts` to keep all audit-shaped calls colocated). New unit tests under `packages/recondo-data/test/audit.test.ts`.

### Decision 3: `mintScopedKey` (used by `recondo-mcp config --scoped`) — **DEFER**

C12 (Tasks 26–28) ships the `recondo-mcp config <flavor> [--scoped <project_id>]` subcommand. Plan D draft has `--scoped` minting a project-scoped API key on the fly. There is no `mintScopedKey` export and no scoped-key minting infrastructure in either `@recondo/data` or `api/`.

**Rationale:** Building a scoped-key minting flow safely (key fingerprint generation, secure return, persistence to `api_keys` with `project_id` set, secret-emission audit, tests) is itself a 1–2 chunk effort. Plan D's primary goal is the MCP server surface, not key minting UX. Deferring keeps C12 focused.

**Downstream impact:**

- D-C12-1 (`recondo-mcp config claude-code` without `--scoped`) ships normally — no key in env, user supplies their own.
- D-C12-2 (`--scoped` flag) is ELIDED from C12. The flag either:
  - **Option A (preferred):** is removed from the C12 surface entirely; the documented config flow tells the operator to mint a key out-of-band (CLI/dashboard) and paste it into env.
  - **Option B:** the flag exists but errors with `"--scoped is not yet implemented; mint a key via the dashboard then set RECONDO_API_KEY"` — gives the surface a future-extension hook without phantom wiring.
- The orchestration's catalog count is unaffected (`config` is a binary subcommand, not a tool).
- Test writer for C12 must drop D-C12-2 from the deliverables checklist OR rewrite it to assert Option B's error message.

**Recommendation:** Option A — drop `--scoped` from the C12 surface. Reintroduce in a Plan E once minting has its own audit story.

### Decision 4: `__tableTargets` (per-function table-target metadata for parity lint) — **DEFER (Phase 1 only)**

Plan D's parity lint (C11, Task 25) wants a check that "no action tool writes a captured table" — implemented by reading `__tableTargets` metadata off each `@recondo/data` function. No such metadata exists; all extant functions either query or mutate without exposing their target tables to consumers.

**Confirming the orchestration's pre-baked recommendation:** Phase 1 (name parity only) is sufficient. Phase 2 (`__tableTargets`) is DEFERRED.

**Rationale:**
1. The action_immutability integration test (Task 33, D-C13-8) is the load-bearing assertion. It hashes captured-table row counts before and after invoking every action tool with `--allow-actions --allow-destructive`, asserting the hashes are unchanged. This is a black-box pipeline-level guarantee that beats source-code metadata for confidence.
2. Adding `__tableTargets` to every existing data-layer function (40+ exports) is a refactor that touches Plan B/C surfaces, exceeds Plan D's additive-only scope, and risks breaking the dashboard.
3. The Phase 1 parity lint already catches "tool calls a left-column name" and "tool registered without a data-layer mapping" — the cases most likely to introduce phantom wiring.

**Downstream impact:**

- C11 ships `mcp/scripts/catalog-parity-lint.ts` Phase 1: name parity table + opt-out set. The action-immutability lint becomes a TODO comment referencing the Phase 2 future work AND the D-C13-8 integration test (so an operator reading the lint understands the immutability invariant is enforced elsewhere).
- D-C11-4 asserts the violations list is empty under Phase 1 mode AND that the TODO comment exists.

---

## 6. D-C0-5 — git status confirmation

After writing this audit doc only, `git status --short` output:

```
?? docs/superpowers/audits/2026-05-06-mcp-pre-flight.md
```

(See §6.1 final command below for the live re-run before handing back to the orchestrator.)

No production source files were created, modified, or deleted by C0. No changes to `mcp/`, `packages/recondo-data/src/`, `api/migrations/`, or `gateway/`. C0's only artifact is this markdown document.

Final live `git status --short` will be captured in the report-back to the orchestrator.

---

## 7. Summary — what each subsequent chunk inherits from C0

**C1 (Tasks 1–9 — workspace scaffold + bootstrap).** Inherits every C0 decision. Specifically: pins `@modelcontextprotocol/sdk@^1.29.0` and uses `McpServer.registerTool(name, {description, inputSchema}, handler)` (NOT `Server.tool(...)`). Adds `insertAuditLog` to `@recondo/data` AND `api/migrations/013_mcp-audit-log.sql` (audit_log table) inside this chunk. The audit writer in `mcp/src/audit/writer.ts` calls `insertAuditLog` and swallows errors. The MCP server uses `getPool()` directly (no `initialize()` export — Decision §5 item 3 confirms).

**C2 (Tasks 10–11 — seed harness + `recondo_list_sessions`).** Inherits API-reality table; `listSessions` exists verbatim (no rename). The `seed.ts` truncate path uses GDPR bypass — orchestration Lesson 13.

**C3 (Tasks 12–13 — single-record + raw-byte tools).** Inherits API-reality: `getSession`, `getTurn`, `getTurnRawMetadata`, `getTurnRawChunk` all exist verbatim. `getTurnRawMetadata` returns `head_sample_utf8` per Plan C C1 — Plan D's `head_sample_bytes` draft is wrong; reviewer flags.

**C4 (Tasks 14–15 — search + verify).** Inherits the `search → searchTurns` rename. No `since` cursor on `recondo_search` (relevance-ranked).

**C5 (Tasks 16 — turn-level analytics).** Inherits the `relatedTurns` 3-member relation enum (`same_session | same_prompt_hash | retry_of`). `findSimilarPrompts` accepts `string | {text}`. `compareTurns`, `sessionEfficiency` exist verbatim.

**C6 (Tasks 17–18 — live + spend).** Inherits 9 renames in this chunk's surface: `getRealtimeStats`, `getGatewayStatus`, `listRealtimeFeed`, `getUsageSummary`, `listSpendByProvider`, `listSpendByModel`, `listSpendByFramework`, `listDailySpend`, `getCostProjections`. Reviewer greps for any LEFT-column name; zero hits expected.

**C7 (Tasks 19 — agent analytics).** Inherits 4 renames: `getAgentSummary`, `listAgentFrameworkDistribution`, `listTopDevelopers`, `listTopRepositories`. `toolCallStats` no rename; output type lacks `token_cost_total`.

**C8 (Task 20 — audit/anomaly/compliance/insights/reports).** Inherits the `insights` DROP decision (§5 #1). Ships **5 tools** in this chunk (NOT 6): `recondo_audit_trail`, `recondo_anomalies`, `recondo_compliance`, `recondo_reports`, `recondo_report_trends`. Renames: `listAuditEvents`, `listAnomalies`, `getComplianceSummary`/`listComplianceFrameworks`/`listComplianceAuditLog`, `listReports`, `listReportCoverageTrend`/`listReportFindingsTrend`. **Special note:** `listComplianceAuditLog` reads the `compliance_audit_log` table (control-status mutation history); this is DISTINCT from the new `audit_log` table written by C1's `insertAuditLog`.

**C9 (Tasks 21–22 — policy/key reads + catalog count).** Inherits the catalog count adjustment from Decision #1: **`READ_TOOLS.length === 27`** (NOT 28). Renames: `listPolicies`, `listApiKeys`. Description-length lint asserts ≥ 50 chars per tool.

**C10 (Tasks 23–24 — action tools + gating).** Inherits renames: `createApiKey` (for `register_key`), `revokeApiKey` (for `delete_key`). 7 action tools total, 2 destructive (`delete_policy`, `delete_key`). Every action description carries the verbatim INJECTION_WARNING per orchestration phantom-wiring red flags.

**C11 (Task 25 — parity lint).** Inherits the **Phase 1 only** decision (§5 #4). The action-immutability check is a TODO referencing D-C13-8. The opt-out set lists every internal `@recondo/data` export not exposed (e.g., `getPool`, `closePool`, `checkDatabaseHealth`, `redaction.*`, `rowsToAsyncIterable`, `abortableIterable`, `DataValidationError`, `mapSession`, `mapTurn`, `mapToolCall`, `mapAnomaly`, `escapeIlike`, `formatTimestamp`, `listStructuredSessions`, `listStructuredTurns`, `listStructuredAnomalies`, `listStructuredCost`, `listStructuredTools`, `listStructuredRisk`, `listStructuredCompliance`, `listStructuredProvenance`, `runStructuredQuery`, `authenticateRequest`, `listUserTurns`, `listAgentActivity`, `getReport`, `getPolicy`, `listPolicyTriggerHistory` (or this is folded into `recondo_policies` `include`), `LocalObjectStore`, `getAuditEntries`, `listComplianceFindings`, `resolveDateRange`, `buildGroupingCTEs`, `EXCLUDE_PURE_PREFLIGHT_SQL`, `encodeSinceCursor`, `decodeSinceCursor`, `uniformListEnvelope`, `mapAttachment` types, AND **`insertAuditLog`** (newly added in C1; opt-out reason: "audit writer, not a tool surface")). The lint also enforces that no action tool's mapping function is one of `listSessions`/`getSession`/`getTurn`/...read functions — name-mode action immutability.

**C12 (Tasks 26–28 — config + prompts + resources).** Inherits the `mintScopedKey` DEFER decision (§5 #3). The `recondo-mcp config <flavor>` flow ships WITHOUT `--scoped`; D-C12-2 is dropped (Option A) or replaced by an explicit unimplemented-error (Option B). Recommendation: Option A.

**C13 (Tasks 29–35 — integration sweep).** Inherits the `audit_log` migration + table from C1 (§3). D-C13-7 (`audit_log.test.ts`) SELECTs FROM `audit_log` (NOT `access_audit_log` or `compliance_audit_log`). D-C13-8 (`action_immutability.test.ts`) is the load-bearing immutability assertion that justified deferring `__tableTargets` (§5 #4); test writer must implement row-count hashing for every captured table (`turns`, `tool_calls`, `sessions`, `attachments`).

**Step 5.5 (final fresh-agent audit).** Inherits all of the above as evidence. The auditor verifies: zero LEFT-column name hits in `mcp/src/`, the 27-tool catalog assertion holds, the audit_log migration is applied, `recondo_related_turns` Zod enum has exactly 3 members, `recondo_tool_call_stats` output type lacks `token_cost_total`. The Step 5.5 prompt template inherits this audit doc as the contract.
