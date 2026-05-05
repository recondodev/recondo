# Documentation and Demos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing documentation at recondo.dev/docs and the two demo videos that anchor Recondo's OSS adoption story — TUI 60-second demo (cross-tool god-view) and MCP 30-second demo (agent introspecting its own history).

**Architecture:** Documentation is markdown source under `docs/site/` (or wherever the recondo.dev publishing pipeline reads from); auto-generated tool catalog reference is built from `mcp/` registered tool metadata. Demo videos are shot via `asciinema` (terminal) plus screen-capture for the MCP-in-Claude-Code demo.

**Tech Stack:** Markdown, the existing recondo.dev publishing pipeline (which exists today — verify and extend, don't replace), `asciinema`, screen-capture tooling for the MCP demo.

**Depends on:** Plans A (TUI) and D (MCP) must be functional before this plan can shoot demos. Quickstart docs can be drafted in parallel with A-D and finalized after they merge.

---

## File Structure

Files this plan creates or modifies. Anything under `docs/site/` is the source the recondo.dev publishing pipeline consumes (verify the actual root in Task 1; if it lives elsewhere, treat `docs/site/` as a logical placeholder for whatever the pipeline reads).

```
docs/site/
  index.md                                 # landing copy + hero pointing at demo embed
  quickstart.md                            # NEW — git clone → first capture in <10 min
  architecture.md                          # NEW — three peer transports over recondo-data
  tui/
    install.md                             # NEW — cargo install / cargo run -p recondo-tui
    first-run.md                           # NEW — env vars, RECONDO_API_URL, RECONDO_API_KEY
    keybindings.md                         # NEW — full keymap + lens reference
  mcp/
    install.md                             # NEW — overview + the `recondo-mcp config` helper
    install-claude-code.md                 # NEW — actual ~/.claude/mcp_servers.json snippet
    install-cursor.md                      # NEW — Cursor mcp.json snippet
    install-goose.md                       # NEW — Goose YAML snippet
    auth-modes.md                          # NEW — dev-bypass default + opt-in API key
    tool-catalog.md                        # GENERATED — auto-built from mcp/ registry
  forensics/
    unredacted-access.md                   # NEW — gateway CLI path for security teams
  reference/
    limitations.md                         # NEW — v1 known limitations
  demos/
    tui-60s.md                             # NEW — script + recording instructions
    mcp-30s.md                             # NEW — script + recording instructions
    assets/
      tui-60s.cast                         # asciinema recording (binary)
      tui-60s.mp4                          # final cut
      mcp-30s.mp4                          # final cut
      mcp-30s-storyboard.md                # screen-capture storyboard

mcp/
  scripts/
    generate-tool-catalog.ts               # NEW — emits docs/site/mcp/tool-catalog.md

README.md                                  # MODIFIED — adds `## Demo` section with embeds
justfile                                   # MODIFIED — adds `docs-tool-catalog` recipe
.github/workflows/
  docs.yml                                 # MODIFIED (or NEW) — runs catalog generator in CI
```

---

## Task 1: Verify the recondo.dev publishing pipeline and pick the docs root

**Files**
- Investigate (read-only): repo root, `package.json` files, any `vercel.json` / `netlify.toml` / Astro / Docusaurus / Nextra / VitePress config, `.github/workflows/`, README.
- Output a one-page note in `docs/site/README.md` (CREATE) recording: where the pipeline source lives, how it builds, how it deploys, and what the canonical URL prefix is for each markdown file added in later tasks.

**Steps**
- [ ] Search the repo for any existing static-site config (`grep -r "docusaurus\|nextra\|vitepress\|astro\|mkdocs\|docs-site\|recondo.dev" --include='*.json' --include='*.toml' --include='*.yml' --include='*.yaml' --include='*.config.*'`).
- [ ] Open `dashboard/`'s `package.json` and routes — confirm whether `recondo.dev` is the dashboard host or a separate site.
- [ ] If a docs site already exists, record the source root in `docs/site/README.md` and use that root for all subsequent tasks (rename `docs/site/` references in this plan to the discovered path before continuing).
- [ ] If no docs site exists, scaffold a minimal markdown tree at `docs/site/` and document the choice; the publishing wiring is **out of scope** (per spec) — this plan ships the source, infrastructure work is separate.
- [ ] Confirm with the spec author or in `docs/site/README.md` whether the tool-catalog page is checked in or generated at publish time. Default in this plan: checked in, regenerated by `just docs-tool-catalog`, CI fails if regenerating produces a diff.

**Commit:** `docs(site): record publishing pipeline root and conventions`

---

## Task 2: Quickstart page — git clone to first capture in under 10 minutes

**Files**
- `docs/site/quickstart.md` (NEW)

**Page outline (write this exact section list, then fill in prose):**

1. **What you'll have at the end** — a running gateway capturing every Claude Code call, the dashboard open at `http://localhost:5173`, the TUI running in another pane, and Claude Code able to query its own past sessions through the MCP. Total time: ~10 minutes.
2. **Prerequisites** — `git`, Docker + Docker Compose, Rust toolchain (rustup), Node 20+, `pnpm`, and one supported agent client (Claude Code, Cursor, or Goose). Disk: ~2 GB for containers + captures.
3. **Step 1 — clone and bootstrap**
   ```bash
   git clone https://github.com/<org>/recondo
   cd recondo
   just setup           # installs cargo-nextest
   just dev-setup       # starts Postgres + MiniStack + runs migrations
   ```
4. **Step 2 — start the stack** (each in its own terminal or tmux pane)
   ```bash
   just dev-run-local   # gateway on :8443
   just api-dev         # GraphQL API on :4000
   just dashboard-dev   # dashboard on :5173
   ```
5. **Step 3 — install the gateway CA so your agent trusts the MITM**
   ```bash
   just ca-install      # adds ~/.recondo/ca/ca.crt to your system trust store
   ```
   Plus the corporate-CA paragraph from `CLAUDE.md` for users behind Zscaler/etc.
6. **Step 4 — route Claude Code through the gateway**
   ```bash
   HTTPS_PROXY=http://localhost:8443 NODE_TLS_REJECT_UNAUTHORIZED=0 claude
   ```
   Send one prompt. Confirm a row appears in the dashboard's Realtime feed within 5 seconds.
7. **Step 5 — run the TUI**
   ```bash
   cargo run -p recondo-tui
   ```
   The realtime lens (`d`) should show the same metric cards and feed rows as the dashboard. Cross-link to `tui/first-run.md`.
8. **Step 6 — register the MCP**
   Cross-link to `mcp/install-claude-code.md` for the snippet and a one-line "ask Claude Code: *what's in my last session?*" verification.
9. **Verify everything works** — three checkboxes the user can self-check:
   - [ ] Dashboard at `http://localhost:5173` shows non-zero session count.
   - [ ] TUI realtime lens renders metric cards within 500 ms of launch.
   - [ ] Claude Code, when asked "what tools have I called in the last hour?", invokes `recondo_tool_call_stats` and returns a real answer.
10. **Where data lives** — `~/.recondo/objects/`, `~/.recondo/captures/`, plus the Postgres container; pointer to `architecture.md` for the full data flow.
11. **Common first-run problems** — short FAQ pulled from CLAUDE.md (TLS trust, port collisions, "another recovery in progress" wedged-lock recovery procedure).
12. **Next steps** — links to `architecture.md`, `mcp/install.md`, `forensics/unredacted-access.md`.

**Steps**
- [ ] Draft the page following the outline above; pull commands verbatim from `CLAUDE.md` so they don't drift.
- [ ] Time yourself running through the quickstart on a clean clone in a fresh data dir; record the wall-clock time in a comment at the bottom of the markdown source. Target: <10 min for a technical user. If it's >10 min, fix the friction (almost always TLS install) before merging.
- [ ] Add a callout box at the top: *"This quickstart assumes the local-dev stack. For production deploys, see `architecture.md` and the deployment guide."*

**Commit:** `docs(site): add quickstart from git clone to first capture`

---

## Task 3: Architecture overview — three peer transports over recondo-data

**Files**
- `docs/site/architecture.md` (NEW)

**Page outline:**

1. **One-paragraph mental model** — a TLS-MITM proxy writes immutable captures to PostgreSQL and an object store; three peer transports (GraphQL, MCP, REST `/v1/query`) read that store via a shared `recondo-data` library. The TUI is a GraphQL client. The dashboard is a GraphQL client. Agents are MCP clients. External scripts use REST. None of these transports wrap any of the others.
2. **Diagram** — copy the ASCII diagram from spec lines 45–72 verbatim. Re-render as Mermaid for the published page; keep the ASCII version as a fallback.
3. **The peer-transport claim, stated explicitly** (verbatim required by Step 14):
   > **MCP is a peer transport, not a wrapper over the API.** The MCP server imports `recondo-data` directly and calls its functions in-process. There is no HTTP hop from the MCP into the GraphQL API at any point. Tomorrow we could add a fourth transport (gRPC, say) by adding another package that imports `recondo-data` and exposes it on its protocol; none of GraphQL, MCP, or the new transport would need to know about each other.
4. **What `recondo-data` owns and what it doesn't.** Owns: DB pool factory, query operations, object-store access, the existing path-masking module (`placeholder-mask.ts`), `ApiKeyInfo` type, `authenticateApiKey(token)`. Does **not** own: HTTP, GraphQL schema, MCP tool registration, anything transport-shaped. Also does **not** own credential-pattern redaction in v1 — that's deferred to a future global pass; raw captured content (sans filesystem-path masks) flows through every transport today.
5. **Auth across transports.** Three different acquisition mechanisms (Authorization header, env var, header) all converge on the same `ApiKeyInfo`. Section cross-references `tui/first-run.md` and `mcp/auth-modes.md`.
6. **Immutability invariant.** Captured records — sessions, turns, tool calls, capture metadata, audit-log entries — are append-only. The gateway is the sole writer. No transport can mutate captures. Action tools (where present) only touch governance metadata.
7. **Path-masking-on-read versus on-disk bytes.** Path-masking (`placeholder-mask.ts`) modifies filesystem paths in what consumers *see*; original bytes remain byte-perfect in the object store. The gateway CLI bypasses path-masking entirely — see `forensics/unredacted-access.md`. Credential-pattern redaction is **not** in v1; captured prompts return raw through every transport today.
8. **Where to read more** — pointers to `CLAUDE.md`, `docs/CLOUD_ARCHITECTURE.md`, the design spec at `docs/superpowers/specs/2026-05-04-tui-and-mcp-design.md`.

**Steps**
- [ ] Write the page; lift the diagram and architectural claims from the spec rather than paraphrasing — these are load-bearing statements.
- [ ] Add an editor's note at the top of the markdown source pointing at the spec as the source of truth so docs drift gets caught.
- [ ] Run a link-check pass against all cross-references.

**Commit:** `docs(site): add architecture overview with peer-transport diagram`

---

## Task 4: TUI install + first-run guide

**Files**
- `docs/site/tui/install.md` (NEW)
- `docs/site/tui/first-run.md` (NEW)
- `docs/site/tui/keybindings.md` (NEW)

**`install.md` outline:**

1. **From source (current path while pre-publication)**
   ```bash
   git clone https://github.com/<org>/recondo
   cd recondo
   cargo run -p recondo-tui
   ```
2. **Once published to crates.io**
   ```bash
   cargo install recondo-tui
   recondo-tui
   ```
3. **Prebuilt binaries** — placeholder section. Out of scope for this plan; mark "coming soon" with a tracking issue link.
4. **Upgrade path** — `cargo install --force recondo-tui` once published.

**`first-run.md` outline:**

1. **What you should see** — within 500 ms of launch, the realtime lens (`d`) renders the gateway-status pill, metric cards, and a live traffic table. If the API is unreachable you get a clear unrecoverable error message with the exact troubleshooting copy from the spec.
2. **Configuration env vars** (table; do not paraphrase the spec):

   | Variable | Default | Meaning |
   |----------|---------|---------|
   | `RECONDO_API_URL` | `http://localhost:4000/graphql` | GraphQL endpoint the TUI polls. |
   | `RECONDO_API_KEY` | unset | If unset, TUI sends no `Authorization` header and inherits the API's dev-mode bypass. If set to a `wrt_...` value, sent as `Authorization: Bearer ...`. |

3. **CLI flags** — mirror the env vars (`--api-url`, `--api-key`).
4. **Auth modes**
   - **Default** — `NODE_ENV=development` + no key → admin context, full historical, cross-project. Same scope as the dashboard.
   - **Opt-in real auth** — set `RECONDO_API_KEY=wrt_...`; TUI sends Bearer; API validates against `api_keys` table.
   - **What happens in production** — once the API runs without `NODE_ENV=development`, the TUI without a key gets denied at the API. Set the key.
5. **Pinning views, time windows, selection follow** — mini-tour of the navigation model so first-time users know `:`, `/`, `*`, and `1`–`9` exist.
6. **Troubleshooting**
   - "Cannot reach Recondo API at $URL." — check `just api-dev`, the URL, and your network.
   - Empty realtime feed — confirm the gateway is running and an agent is actually routed through it.
   - Auth rejected — confirm the key value, that `api_keys` row is active, that the API is not in dev-bypass mode (which would have masked the failure).

**`keybindings.md` outline:**

- Reproduce the full keybind table from the spec verbatim (every key, every action). Add a "Lens-specific" subsection for filter/sort cycles where the behavior depends on the active lens.
- Add a one-line "see also" pointer at the end of each lens row to its dashboard counterpart for users who already know the web UI.

**Steps**
- [ ] Write the three pages.
- [ ] Cross-link from `quickstart.md` Step 5 to `first-run.md`.
- [ ] Verify every command and env var matches the actual TUI binary's flag/env parsing (run `cargo run -p recondo-tui -- --help` and diff against the doc).

**Commit:** `docs(site): add TUI install, first-run, and keybindings pages`

---

## Task 5: MCP install pages — per-client snippets

**Files**
- `docs/site/mcp/install.md` (NEW — overview + the `recondo-mcp config` helper)
- `docs/site/mcp/install-claude-code.md` (NEW)
- `docs/site/mcp/install-cursor.md` (NEW)
- `docs/site/mcp/install-goose.md` (NEW)
- `docs/site/mcp/auth-modes.md` (NEW)

**`install.md` outline:**

1. **What the MCP is** — a stdio MCP server that gives any MCP-aware agent read access (and, with `--allow-actions`, mutation access) to your Recondo capture history. Cross-reference `architecture.md` for the peer-transport claim.
2. **Install the binary** — `npm install -g @recondo/mcp` once published; for now, `pnpm --filter recondo-mcp build` from the workspace produces a binary at `mcp/bin/recondo-mcp`.
3. **The `recondo-mcp config` helper command.** The MCP binary's `config` subcommand emits a JSON registration snippet for the active environment.
   - Default invocation: `recondo-mcp config` — emits a snippet with `DATABASE_URL`, `RECONDO_OBJECT_STORE_PATH`, and other infra env vars derived from the running environment; omits `RECONDO_API_KEY` (so the agent inherits the dev-bypass admin context).
   - Scoped invocation: `recondo-mcp config --scoped <project_id>` — mints a scoped API key in `api_keys` and emits a snippet with `RECONDO_API_KEY=wrt_...` set to that key.
   - Per-client formats: `--client claude-code` (default), `--client cursor`, `--client goose` — emit the JSON shape that client expects.
   - Example output (default, Claude Code):
     ```json
     {
       "mcpServers": {
         "recondo": {
           "command": "recondo-mcp",
           "env": {
             "DATABASE_URL": "postgres://recondo:recondo_dev@localhost:5432/recondo",
             "RECONDO_OBJECT_STORE_PATH": "/Users/you/.recondo/objects"
           }
         }
       }
     }
     ```
   - **Recommended workflow**: run `recondo-mcp config --client claude-code >> ~/.claude/mcp_servers.json` (then merge by hand if the file already has `mcpServers`), restart the agent, verify the tool list appears.
4. **Pointer to the per-client snippet pages** below.

**`install-claude-code.md` — the actual file path and snippet:**

- Path: `~/.claude/mcp_servers.json` (or whichever file Claude Code reads on the user's platform — link to the upstream Claude Code docs for the platform matrix).
- **Default-mode snippet (verbatim, copy-pasteable):**
  ```json
  {
    "mcpServers": {
      "recondo": {
        "command": "recondo-mcp",
        "env": {
          "DATABASE_URL": "postgres://recondo:recondo_dev@localhost:5432/recondo",
          "RECONDO_OBJECT_STORE_PATH": "/Users/you/.recondo/objects"
        }
      }
    }
  }
  ```
- **Opt-in-key snippet (verbatim from the spec):**
  ```json
  {
    "mcpServers": {
      "recondo": {
        "command": "recondo-mcp",
        "env": {
          "DATABASE_URL": "postgres://recondo:recondo_dev@localhost:5432/recondo",
          "RECONDO_OBJECT_STORE_PATH": "/Users/you/.recondo/objects",
          "RECONDO_API_KEY": "wrt_..."
        }
      }
    }
  }
  ```
- **With actions enabled (advanced)** — show how to add `"args": ["--allow-actions"]`; describe the `--allow-destructive` second-flag escalation; warn about prompt-injection risk verbatim.
- **Verifying the install** — start a Claude Code session, run `/mcp` (or whatever the current Claude Code MCP-list command is), confirm `recondo` appears, ask Claude Code: *"What sessions did I run today?"* — confirm `recondo_list_sessions` is invoked.

**`install-cursor.md`:**
- Path: Cursor reads MCP servers from its settings UI which writes to `~/.cursor/mcp.json` (verify against current Cursor version at write time).
- Same default and opt-in-key snippets — the JSON shape is the same as Claude Code; only the file location differs.
- Cursor-specific verification path (open Cursor's MCP debug panel, confirm tool list).

**`install-goose.md`:**
- Goose uses YAML config (verify; Goose changes formats periodically). Provide both default and opt-in-key forms.
- Approximate shape:
  ```yaml
  extensions:
    recondo:
      type: stdio
      cmd: recondo-mcp
      envs:
        DATABASE_URL: postgres://recondo:recondo_dev@localhost:5432/recondo
        RECONDO_OBJECT_STORE_PATH: /Users/you/.recondo/objects
  ```
- Add a note: confirm against current Goose docs because the format has moved.

**`auth-modes.md`:**
- Restate the dev-bypass-default-then-opt-in-key model from the spec. Cover: `RECONDO_DEV_BYPASS=1`, `NODE_ENV=development` fallback, what production refusal looks like, the per-process cache of the validated key, and the explicit "no silent fallback if a key is malformed/revoked" guarantee.

**Steps**
- [ ] Write each page.
- [ ] Verify every JSON snippet parses (`jq . < snippet`) and uses the literal env var names from the MCP binary (read `mcp/src/config.ts` or whatever Plan D produces; do not paraphrase env names).
- [ ] Confirm `recondo-mcp config` output matches what the doc claims it emits (run it and diff).

**Commit:** `docs(site): add MCP install snippets for Claude Code, Cursor, Goose`

---

## Task 6: Auto-generated tool catalog reference

**Files**
- `mcp/scripts/generate-tool-catalog.ts` (NEW)
- `docs/site/mcp/tool-catalog.md` (GENERATED — checked in; CI verifies it's up to date)
- `justfile` (MODIFIED — add `docs-tool-catalog` recipe)
- `.github/workflows/docs.yml` (MODIFIED or NEW — runs `just docs-tool-catalog --check`)

**Generation strategy** (describe in the doc itself in a header comment):

- The MCP server registers tools with the `@modelcontextprotocol/sdk` server in `mcp/src/tools/`. Each registration includes `name`, `description`, JSON Schema for arguments, and an internal tag indicating its `recondo-data` source operation.
- `generate-tool-catalog.ts` imports the same registry the live server uses, walks every registered tool, and renders a markdown page with:
  - One section per tool group (Sessions, Live activity, Spend, Agents, Audit, Policies, Action tools).
  - For each tool: name, description (the exact MCP description string the agent sees), parameters table (name, type, required, description), backing `recondo-data` function name, default-vs.-`--allow-actions`-vs.-`--allow-destructive` gate, and a usage example.
- The script writes to `docs/site/mcp/tool-catalog.md`. The first line of the file is a generated-do-not-edit banner pointing at the script.
- CI runs `just docs-tool-catalog --check` which regenerates into a temp file and `diff`s against the checked-in file. Mismatch fails CI and the developer must run `just docs-tool-catalog` and commit.

**Steps**
- [ ] Implement `generate-tool-catalog.ts` against the MCP tool registry produced by Plan D. If Plan D hasn't merged yet, draft against the spec's tool tables (lines 339–397) and a stub registry, then wire to the real registry when Plan D lands.
- [ ] Add the `justfile` recipe:
   ```
   docs-tool-catalog:
       pnpm --filter recondo-mcp tsx scripts/generate-tool-catalog.ts > docs/site/mcp/tool-catalog.md
   docs-tool-catalog-check:
       pnpm --filter recondo-mcp tsx scripts/generate-tool-catalog.ts | diff -u docs/site/mcp/tool-catalog.md -
   ```
- [ ] Add a CI job that runs `just docs-tool-catalog-check` on every PR.
- [ ] Run `just docs-tool-catalog` and commit the generated `tool-catalog.md` so the file exists at HEAD.
- [ ] Add a "How this page is generated" section in `mcp/install.md` linking the script source so users understand the page is authoritative.

**Commit:** `docs(site,mcp): generate MCP tool catalog from registered tools`

---

## Task 7: Forensic-investigation path — raw captures via gateway CLI

**Files**
- `docs/site/forensics/unredacted-access.md` (NEW — keep the filename even though "unredacted" is now historical; the page is about CLI-direct access)

**Page outline:**

1. **Why this page exists** — security teams investigating "which prompt actually leaked the key?" need direct access to captured content via the gateway CLI. The MCP, dashboard, and API apply path-masking (`placeholder-mask.ts`) on read; the gateway's local CLI does not. This page documents that out-of-band path.
2. **Who this is for** — compliance auditors, incident responders. Requires shell access to the host running the gateway and read access to `~/.recondo/objects/` plus the SQLite/Postgres database.
3. **The relevant CLI commands** (verbatim from `gateway/src/main.rs`):
   - `recondo-gateway sessions` — lists every captured session.
   - `recondo-gateway session <id> [--turns]` — turn-by-turn trace for a session; `--turns` gives the compact list (sequence, timestamp, model, tokens) without full text.
   - `recondo-gateway turn <id>` — single turn detail, including the full prompt and response text with raw filesystem paths (no path-masking applied).
   - `recondo-gateway search <query>` — full-text search across captured turns.
   - `recondo-gateway verify <session_id>` — content-hash verification: re-hashes every request and response object on disk and confirms it matches the recorded hash. This is the audit-trail integrity check that backs the SOC 2 / ISO 42001 claims. Use this to prove a capture has not been tampered with on disk.
   - `recondo-gateway stats` — aggregate statistics for context.
   - `recondo-gateway reprocess [--dry-run]` — replays orphan captures (metadata on disk but no DB row); included here because forensic investigations sometimes need to recover captures from a crashed gateway run.
4. **Worked example: investigating a suspected leak**
   ```bash
   # 1. Find the session the user reported.
   recondo-gateway search "<suspect substring>"
   # 2. Inspect the turn in full.
   recondo-gateway turn trn_xxx
   # 3. Confirm the captured bytes haven't been tampered with.
   recondo-gateway verify ses_yyy
   ```
5. **What v1 does and does not protect against.**
   - **Path-masking on read.** Filesystem paths like `/Users/foo/Projects/recondo` are masked to a `[user-home]/...` placeholder when content flows through the MCP, GraphQL API, REST `/v1/query`, and consequently the dashboard and TUI. The gateway CLI bypasses this — it reads directly from the object store and DB.
   - **Credential-pattern redaction is NOT in v1.** Captured prompts that contain API keys, DB strings, tokens, etc. flow raw through every transport. This is a documented v1 limitation; a coherent global redaction layer is a tracked v1.5/v2 deliverable. Operators are responsible for content-handling discipline today, the same way they already are for `recondo-gateway turn` CLI access.
6. **Hardening recommendations.**
   - Restrict shell access to the host running the gateway to a small named group.
   - Restrict dashboard / TUI / MCP access to trusted operators given the no-credential-redaction posture.
   - Store gateway audit logs (who ran `recondo-gateway turn`) via the host's audit subsystem (auditd, OS X `auditpipe`, etc.) — Recondo does not log its own CLI invocations in v1.
7. **Cross-reference** to `architecture.md` Section 7 (path-masking-on-read versus on-disk) and `reference/limitations.md` (v1 known limitations).

**Steps**
- [ ] Write the page using the actual command names from `gateway/src/main.rs` (cross-checked above; do not paraphrase).
- [ ] Confirm each command is still valid by running `cargo run -p recondo-gateway -- <subcommand> --help` and pasting the output into a hidden HTML comment block at the bottom of the markdown for future drift checks.

**Commit:** `docs(site,forensics): document unredacted-capture access for security teams`

---

## Task 8: Known limitations page

**Files**
- `docs/site/reference/limitations.md` (NEW)

**Page outline:**

1. **Scope of this page** — limitations the v1 user should know about up front. Each entry has: what it is, why it's deferred, what the eventual fix looks like, and a link to the tracking issue / spec section.
2. **Hash-only similarity in `recondo_find_similar_prompts`.** v1 returns only byte-identical matches — captures are content-addressable so this is free. Whitespace differences, system-prompt date stamps, model-name strings, or trace IDs cause "expected duplicates" to not match. v1.5 will add embedding-based fuzzy similarity (requires a vector store + background indexer; substantial new infrastructure). Cross-reference spec Risk #4 and the `find_waste` template's "exact-match only" caveat.
3. **No streaming yet.**
   - The TUI matches the dashboard's 5-second polling cadence; no SSE-byte-level live view.
   - MCP `recondo_realtime_feed` uses opaque `since` cursors; agent loops poll at 30–60 s.
   - Streaming-prep contracts (`AsyncIterable`, `AbortSignal`, uniform list envelope, `is_final: true`, `stream_id: null`) are landed in v1 so v1.5 can light up streaming without a refactor.
   - Real-time character-by-character streaming is the agent CLI's job, not Recondo's.
4. **Single-user god-mode default.**
   - In dev (`NODE_ENV=development`), TUI without a key gets full historical, cross-project access; MCP without `RECONDO_API_KEY` does the same.
   - Multi-user / scoped-key deployments (different agents → different `project_id` scopes) are out of scope for v1. The seam exists in `recondo-data` (pass a non-admin key; everything scopes via `ctx.apiKey.projectId`); v2 lights it up.
   - In production (`NODE_ENV=production` and `RECONDO_DEV_BYPASS` unset) both transports refuse to start without a key. Document the production posture so users don't accidentally ship dev-bypass.
5. **No replay/diff in v1.** Tracked as v1.5; the `r` lens in the TUI opens a stub.
6. **No enterprise lenses in TUI v1.** Compliance, policies, reports, API keys remain web-only for v1; the TUI's `A` (Audit) opens a stub.
7. **No bundled distribution.** v1 install is `git clone` plus following the quickstart. Single-binary `recondo up` bootstrap is deferred until adoption signals demand it.
8. **Tool-call cap at 25.** The MCP tool catalog targets ~24 tools, capped at 25; agent tool-selection accuracy degrades past ~30–50 total tools across all registered MCPs. New tools that would push over 25 must consolidate, fold via `include`, or graduate to a separate MCP server.
9. **Prompt-injection from captured content is an ongoing concern.** Layered mitigations (structural delimiters, action-tool warnings, agent-side discipline) but no layer is bulletproof. The v1.5 `--read-only-on-injected-content` flag is the next mitigation tier.

**Steps**
- [ ] Write the page; copy the language from the spec's Risks / Non-goals / Acceptance criteria sections rather than rephrasing.
- [ ] Add cross-references from `quickstart.md` "Next steps" and from each affected feature's reference doc.

**Commit:** `docs(site,reference): document v1 known limitations`

---

## Task 9: Landing page hero copy + README `## Demo` placeholder

**Files**
- `docs/site/index.md` (MODIFIED or NEW — landing copy + hero embed slot)
- `README.md` (MODIFIED — adds the `## Demo` section, initially with placeholder embeds)

**Steps**
- [ ] Write a hero section for `docs/site/index.md` with: one-sentence elevator pitch, two-button CTA (Quickstart, Install MCP), embed slots for the two demo videos (filled in Task 12), and three-bullet value summary (god-view across every tool, agent recursion via MCP, audit-grade immutability).
- [ ] Add `## Demo` to `README.md` immediately after the project description, with two subsections (`### TUI: cross-tool god-view (60s)` and `### MCP: your agents introspect their own history (30s)`) and placeholder text — `<!-- video: docs/site/demos/assets/tui-60s.mp4 -->` — that Task 12 will replace with the actual embeds.

**Commit:** `docs(site,readme): add hero + demo section placeholders`

---

## Task 10: 60-second TUI demo — script and shoot

**Files**
- `docs/site/demos/tui-60s.md` (NEW — the script + recording instructions)
- `docs/site/demos/assets/tui-60s.cast` (NEW — `asciinema` recording, binary)

**Script — exact keystroke and beat sequence (target 60 s):**

| t (s) | On-screen | Voiceover (1 sentence per beat) |
|-------|-----------|---------------------------------|
| 0–3 | Empty terminal. Type `cargo run -p recondo-tui` and hit Enter. | *"This is Recondo. One command, no setup."* |
| 3–7 | Realtime lens (`d`) renders within 500 ms. Header strip lit, metric cards populating. | *"Every AI agent on this machine — Claude Code, Cursor, Codex, anything — flows through one place."* |
| 7–14 | Live traffic table fills. Three different framework pills visible (Claude Code, Cursor, raw API). | *"Live traffic, every tool, in one feed."* |
| 14–20 | Press `s`. Sessions lens. Cursor on a recent Claude Code session. | *"Drill into any session..."* |
| 20–28 | Press `Enter`. Session detail. Scroll through turns with `j`. Stop on a turn with a tool-call badge. | *"...see every turn, every tool call, every cost."* |
| 28–35 | Press `c`. Cost lens. Press `g` twice to cycle group-by from provider → model → framework. | *"Slice spend by provider, model, framework..."* |
| 35–42 | Press `:`, type `week`, Enter. Time window updates. | *"...across any time window."* |
| 42–50 | Press `a`. Agent analytics. Show framework distribution bar chart. | *"See which agents you actually use, and which ones cost you the most."* |
| 50–57 | Press `d` to land back on realtime. Selection follows: highlighted session pill still visible in header. | *"This is your AI life, ambient, in a tmux pane."* |
| 57–60 | Title card overlay: **Recondo — recondo.dev** | *(silence; just the URL)* |

**Recording instructions:**

1. **Pre-flight**
   - Use a clean shell: `env -i HOME=$HOME PATH=/usr/local/bin:/usr/bin:/bin TERM=xterm-256color zsh -f` so the prompt is plain.
   - Set the terminal to 120×40 with a high-contrast theme. Use a font that's readable at 720p (Berkeley Mono, JetBrains Mono).
   - Pre-seed the local DB with at least 3 sessions across 3 different frameworks (Claude Code, Cursor, raw API) and at least 50 turns total. Script in `docs/site/demos/tui-60s.md` should include the seed-data shell snippet.
   - Run the gateway, API, dashboard before starting the recording.
2. **Capture**
   ```bash
   asciinema rec -c "zsh -f" --rows 40 --cols 120 \
     --title "Recondo TUI — 60 seconds" \
     docs/site/demos/assets/tui-60s.cast
   ```
   Execute the keystroke sequence at the cadence in the script table. Practice 3–5 takes; pick the cleanest.
3. **Audit the recording** — `asciinema play docs/site/demos/assets/tui-60s.cast`; if any beat lands outside its window, redo.

**Steps**
- [ ] Write `tui-60s.md` containing: the table above, the seed-data snippet, the recording commands, the voiceover script, and the post-production notes (Task 12).
- [ ] Shoot the asciinema recording. Commit the `.cast` file.

**Commit:** `docs(demos): add 60-second TUI demo script and asciinema recording`

---

## Task 11: 30-second MCP demo — script and shoot

**Files**
- `docs/site/demos/mcp-30s.md` (NEW — script + recording instructions)
- `docs/site/demos/assets/mcp-30s-storyboard.md` (NEW — frame-by-frame storyboard)
- The raw screen-capture file produced during shooting (binary; not pre-named here).

**Script — exact sequence (target 30 s):**

| t (s) | On-screen | Voiceover |
|-------|-----------|-----------|
| 0–4 | Terminal split: left = `claude` running in a repo. Right = `recondo-tui` realtime lens, scrolling. | *"Your AI agent, with memory of itself."* |
| 4–10 | In Claude Code, the user types: **"What did we try in our last 5 sessions on this repo?"** Hit Enter. | *(silence; let the question land)* |
| 10–18 | Claude Code calls `recondo_list_sessions(filter: { repository: "..." }, limit: 5)`. Tool-call card visible. Then `recondo_get_session(...)` for the most recent. The right pane (TUI) lights up with a new row each time. | *"It calls Recondo. It reads its own past sessions."* |
| 18–26 | Claude Code's response renders: a bulleted summary — "Tried strategy A in session 1 (failed at test X), pivoted to strategy B in session 3 (worked but slow), session 5 introduced caching..." | *"...and tells you exactly where you left off."* |
| 26–30 | Title card overlay: **Recondo MCP — recondo.dev** | *(silence)* |

**Storyboard** in `mcp-30s-storyboard.md` — six labelled frames at 0 s, 5 s, 10 s, 18 s, 26 s, 30 s with screenshots and annotations once recorded.

**Recording instructions:**

1. **Pre-flight**
   - Register the MCP with Claude Code per `mcp/install-claude-code.md` default-mode snippet.
   - Pre-seed the local DB with 5 sessions on the demo repo. Script-seed pattern: same as Task 10 but scoped to one repo path. Vary models, costs, and outcomes so the summary has substance.
   - Use `tmux` with two equal vertical panes; the recording covers both panes.
2. **Capture**
   - Use a screen-capture tool that records both panes at 1920×1080 at 30 fps. Recommended on macOS: built-in `screencapture -v` or QuickTime Screen Recording (free, no overlay). On Linux: OBS Studio.
   - Hide menu bars and notifications; use Do Not Disturb.
3. **Take the demo** — type the question literally (do not paste); the keystroke pacing is part of the demo. Practice 3–5 takes.

**Steps**
- [ ] Write `mcp-30s.md` and the storyboard skeleton.
- [ ] Once Plan D's MCP is functional and registered with Claude Code, shoot the screen-capture take. Commit the source file (raw `.mov` or `.mkv`) into a release asset (not into git — too large; reference its location and the cleaned-up MP4 below).

**Commit:** `docs(demos): add 30-second MCP demo script and storyboard`

---

## Task 12: Edit + finalize both demos, embed in README and landing page

**Files**
- `docs/site/demos/assets/tui-60s.mp4` (NEW — final cut from `.cast`)
- `docs/site/demos/assets/mcp-30s.mp4` (NEW — final cut from screen-capture)
- `docs/site/demos/tui-60s.md` (MODIFIED — add post-production notes)
- `docs/site/demos/mcp-30s.md` (MODIFIED — add post-production notes)
- `README.md` (MODIFIED — replace placeholder embeds with real ones)
- `docs/site/index.md` (MODIFIED — replace placeholder embeds)

**Post-production notes (add to both demo `.md` files):**

1. **TUI: convert asciinema → MP4.**
   - Use `agg` (asciinema gif generator) → MP4: `agg --font-family "Berkeley Mono" --theme monokai docs/site/demos/assets/tui-60s.cast tui-60s.gif && ffmpeg -i tui-60s.gif -movflags +faststart -pix_fmt yuv420p -vf "scale=1280:-2" docs/site/demos/assets/tui-60s.mp4`.
   - Add the title card at the end with `ffmpeg` `-vf drawtext` or in any video editor; keep the demo total at 60 s including the title.
   - Add the voiceover track recorded separately (any quiet room, USB mic, Audacity); align to the table beats.
2. **MCP: edit the screen-capture.**
   - Trim to 30 s. Add the title card. Add the voiceover.
   - If the agent response text is too small to read, do a brief 2× zoom on the response panel during the 18–26 s beat.
3. **Encoding targets** for both MP4s:
   - 1280×720 minimum, 1920×1080 preferred for the MCP one.
   - H.264, yuv420p, faststart for in-page playback.
   - Keep each file under 10 MB; if over, drop bitrate before resolution.
4. **Subtitles** — write `.vtt` sidecar files with the voiceover text; helps users who watch muted (most do).

**Embed pattern for `README.md`:**

```markdown
## Demo

### TUI: cross-tool god-view (60s)

https://github.com/<org>/recondo/assets/<repo-uploaded-asset-id>/tui-60s.mp4

### MCP: your agents introspect their own history (30s)

https://github.com/<org>/recondo/assets/<repo-uploaded-asset-id>/mcp-30s.mp4
```

(GitHub auto-embeds video URLs in README.md. Upload the MP4s to a release or to issue/PR comments to get the asset URLs.)

**Embed pattern for `docs/site/index.md`:** depends on the publishing pipeline (Task 1) — typically a `<video controls src=...>` tag or a custom shortcode.

**Steps**
- [ ] Run the TUI conversion pipeline; save MP4 + VTT.
- [ ] Edit the MCP screen-capture; save MP4 + VTT.
- [ ] Upload both MP4s to a GitHub release draft or PR comment to obtain stable asset URLs.
- [ ] Replace the README and landing-page placeholders with the real embeds.
- [ ] Verify both videos play in the rendered README on github.com and on the landing page.

**Commit:** `docs(demos): finalize TUI and MCP demos and embed in README + landing`

---

## Task 13: Distribution — Show HN post and Twitter/X thread drafts

**Files**
- `docs/site/demos/show-hn-draft.md` (NEW)
- `docs/site/demos/twitter-thread-draft.md` (NEW)

**Show HN draft outline:**

1. **Title** (≤ 80 chars): *"Show HN: Recondo — see and audit every AI agent on your machine"*.
2. **First-comment body** (the explainer; HN convention is the post body is the link, the explainer is the first comment):
   - One paragraph: what Recondo is, why we built it (every AI agent ships its own opaque telemetry path; we wanted one place).
   - The two demo embeds (TUI 60 s, MCP 30 s).
   - Three-bullet "what's interesting":
     - Cross-tool capture via TLS-MITM — works with any agent that respects `HTTPS_PROXY`, no per-tool integration.
     - MCP server lets agents introspect their own past sessions.
     - Captures are immutable; SOC 2 / ISO 42001-grade audit trail by construction.
   - Repo link, recondo.dev link, Discord/issues for feedback.
3. **Comment-prep**: pre-write answers to the predictable HN questions (How is this different from LangSmith / Helicone / Witness? What's the privacy model? Why TS for the API and Rust for the gateway? When will there be a hosted version?).

**Twitter/X thread outline (8 tweets):**

1. *"We built a god-view for every AI agent on your machine."* + 60 s TUI MP4.
2. The cross-tool pitch: works with Claude Code, Cursor, Codex, anything that respects `HTTPS_PROXY`.
3. *"And we made your agents able to remember themselves."* + 30 s MCP MP4.
4. The MCP value prop: one tool registration, every MCP-aware agent gets a memory of every past session.
5. Architecture quote-tweet: the three-peer-transports diagram with caption *"MCP is a peer transport, not a wrapper over the API."*
6. The audit/compliance angle: SOC 2, ISO 42001, immutable captures.
7. Open source under [LICENSE]; install with `git clone` + the quickstart.
8. Repo link + recondo.dev + Discord.

**Steps**
- [ ] Draft both files.
- [ ] Run them past the spec author / project owner before posting.
- [ ] Coordinate the post timing with the v1 GA tag — these go out the same day, not earlier (no point hyping a project users can't yet install).

**Commit:** `docs(demos): draft Show HN post and Twitter/X thread`

---

## Task 14: Final QA pass and cross-link audit

**Files**
- All files this plan created or modified.

**Steps**
- [ ] Read every page top-to-bottom in rendering order: `index.md` → `quickstart.md` → `architecture.md` → `tui/install.md` → `tui/first-run.md` → `tui/keybindings.md` → `mcp/install.md` → per-client install pages → `mcp/auth-modes.md` → `mcp/tool-catalog.md` → `forensics/unredacted-access.md` → `reference/limitations.md`. Anything that requires the reader to know context not yet introduced is a bug; reorder or back-reference.
- [ ] Run an automated link check (`lychee docs/site/`) — every internal link resolves, every external link returns 200.
- [ ] Walk a fresh laptop through the quickstart end-to-end. Time it. If it's >10 minutes, file an issue and either trim friction or amend the limitations page to set expectations.
- [ ] Verify every JSON snippet parses (`find docs/site -name '*.md' -print0 | xargs -0 grep -l '```json' | xargs -I{} sh -c 'awk "/\`\`\`json/,/\`\`\`/" {} | jq .'` or equivalent).
- [ ] Verify every shell command runs against a clean checkout (eyeball-test plus a script that greps fenced bash blocks and runs each one in dry-run mode where possible).
- [ ] Confirm `just docs-tool-catalog-check` is green at HEAD.
- [ ] Confirm both demo MP4s play inline on github.com when the README is viewed in a logged-out browser.

**Commit:** `docs(site): final QA pass — link check, quickstart timing, snippet validation`

---

## Acceptance criteria (this plan)

- [ ] A technical user with `git`, Docker, Rust, and Node installed can go from `git clone` to TUI realtime lens populating + MCP registered with Claude Code in under 10 minutes following only `quickstart.md`.
- [ ] `architecture.md` includes the verbatim sentence *"MCP is a peer transport, not a wrapper over the API."* and the three-peer-transports diagram.
- [ ] Each MCP install page (Claude Code, Cursor, Goose) ships a copy-pasteable JSON/YAML snippet for both default-mode (no key) and opt-in-key mode.
- [ ] `mcp/tool-catalog.md` is generated from the MCP tool registry, not hand-written; CI fails if the checked-in file drifts from regenerated output.
- [ ] `forensics/unredacted-access.md` references the actual `recondo-gateway` CLI subcommands (`sessions`, `session`, `turn`, `search`, `verify`, `stats`, `reprocess`) and explains that they bypass the path-masking layer (and that v1 does not have credential-pattern redaction).
- [ ] `reference/limitations.md` covers all five v1 limitations called out in the source spec: hash-only similarity, no streaming, single-user god-mode default, no replay/diff, no enterprise lenses in TUI.
- [ ] `docs/site/demos/tui-60s.md` and `mcp-30s.md` each contain the exact keystroke/voiceover script tables shown above plus the recording-tool commands.
- [ ] Final 60 s and 30 s MP4s exist under `docs/site/demos/assets/`, are < 10 MB each, are H.264/yuv420p/faststart-encoded, and ship with `.vtt` subtitles.
- [ ] `README.md` `## Demo` section embeds both videos; rendered README on github.com plays them inline.
- [ ] Show HN draft and Twitter/X thread draft are committed (not yet posted — coordinate with v1 GA tag).
