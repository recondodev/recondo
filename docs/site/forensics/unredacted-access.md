# Unredacted Access: Forensic Investigation Path

This page documents how compliance auditors, incident responders, and forensic investigators can access raw, unmasked captures directly from the Recondo gateway—bypassing all consumer-facing transports (MCP, GraphQL API, TUI, dashboard).

## Why This Page Exists

Security and compliance teams require direct access to raw captured data for:

- **Breach investigation** — determining whether sensitive user data leaked through an LLM API call
- **Incident response** — reconstructing the exact bytes that flowed through the system during an incident window
- **Forensic auditing** — SOC 2 and ISO 42001 compliance require the ability to produce unmodified audit trails
- **Pattern analysis** — searching for credential leakage, unauthorized access, or policy violations across captured sessions

All of these use cases require **unmasked, unredacted original bytes**. Recondo's consumer transports (MCP, GraphQL API, REST, TUI, dashboard) apply path-masking when returning captured content. This page shows the path around that masking for authorized forensic personnel.

## Who This Is For

- **Compliance auditors** — validating immutability claims and producing audit reports
- **Incident responders** — investigating suspected data leaks or unauthorized access
- **Security operations** — forensic analysis and pattern detection
- **Internal audit teams** — periodic verification of governance controls

**Prerequisites:**

- Shell access to the gateway host (e.g., SSH to the machine running `recondo-gateway serve`)
- Read access to the data directory (`~/.recondo/` by default, or configured via `RECONDO_STORE` and `RECONDO_OBJECTS`)
- Database access (SQLite file at `~/.recondo/recondo.db` for local deployments, or PostgreSQL connection string for cloud deployments)
- Familiarity with the `recondo-gateway` CLI subcommands

## CLI Commands for Forensic Access

All of these commands bypass path-masking and return raw captured bytes. They are extracted directly from `gateway/src/main.rs`.

### `recondo-gateway sessions`

Lists all captured sessions with summary statistics.

```bash
recondo-gateway sessions
```

**Output:**

```
ID                 Model                          Turns   Tokens   Cost Started              Intent
------------------------------------------------------------------------------------------------------------
ses_abc123         claude-3-5-sonnet-20241022        5   15432  $0.12 2026-05-09T10:30:22Z Found the bug in login
ses_def456         gpt-4                            12   42156  $1.45 2026-05-09T11:15:00Z Create a migration script
```

**Use case:** Identify sessions in a suspect time window (by `Started` column) before drilling into individual turns.

---

### `recondo-gateway session <id> [--turns]`

Shows turn-by-turn trace for a session with optional compact summary.

```bash
# Full trace with response text
recondo-gateway session ses_abc123

# Compact summary (sequence, timestamp, tokens, cost — no response text)
recondo-gateway session ses_abc123 --turns
```

**Output (full trace):**

```
Session: ses_abc123
Provider: Anthropic
Model: claude-3-5-sonnet-20241022
Started: 2026-05-09T10:30:22Z
Turns: 5/5 captured | Dropped: 0
Total tokens: 15432
Total cost: $0.12
Intent: Found the bug in login

--- Turn 1 [2026-05-09T10:30:22Z] ---
  Model: claude-3-5-sonnet-20241022  Stop: end_turn
  Tokens: 412 in / 289 out  Cost: $0.00
  User: Can you help me debug the login endpoint in auth.ts?
  Response: I'll help you debug the login endpoint. Let me analyze the code...

--- Turn 2 [2026-05-09T10:31:15Z] ---
  ...
```

**Output (compact, with `--turns`):**

```
Seq   Timestamp                Model                      In    Out   Cost
---------------------------------------------------------------------------
  1   2026-05-09T10:30:22Z     claude-3-5-sonnet-...    412   289   $0.00
  2   2026-05-09T10:31:15Z     claude-3-5-sonnet-...    521   410   $0.01
  3   2026-05-09T10:33:02Z     claude-3-5-sonnet-...    689   556   $0.01
  4   2026-05-09T10:34:18Z     claude-3-5-sonnet-...    1245  892   $0.03
  5   2026-05-09T10:35:44Z     claude-3-5-sonnet-...    412   289   $0.00
```

**Use case:** View the complete conversation flow and identify which turns may contain the leaked data or policy violation.

---

### `recondo-gateway turn <id>`

Shows single-turn detail with **unmasked filesystem paths**, raw request/response hashes, and object store references.

```bash
recondo-gateway turn trn_xyz789
```

**Output:**

```
Turn: trn_xyz789
Session: ses_abc123
Sequence: 2
Timestamp: 2026-05-09T10:31:15Z
Model: claude-3-5-sonnet-20241022
Stop reason: end_turn
Capture complete: true

Tokens:
  Input:          521
  Output:         410
  Cache read:     0
  Cache creation: 0
  Cost:           $0.01

Hashes:
  Request:  e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  Response: 356a192b7913b04c54574d18c28d46e6395428ab12c7e4e239ab9b969e84a8d
  Req file: objects/req/e3/b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.gz (2847 bytes)
  Resp file: objects/resp/35/6a192b7913b04c54574d18c28d46e6395428ab12c7e4e239ab9b969e84a8d.gz (1456 bytes)

User message:
Here's the code from auth.ts that's failing:
  export async function login(req: Request) {
    const password = await req.body.password;
    // Check against database config
    const db = new Client({
      host: 'db.internal.company.com',
      password: 'super_secret_db_pass_12345',  <-- LEAKED CREDENTIAL
      ...
    });
  }

Response text:
I can see the issue in your auth.ts file. The database password should not be hardcoded in...

Tool calls:
```

**Critical difference from MCP/GraphQL consumers:** This output shows **unmasked filesystem paths** in the `Req file` and `Resp file` fields. It also includes the raw user message and response text without path-masking applied.

**Use case:** Verify exact file hashes in the object store, confirm capture integrity, and access unredacted captured content for forensic analysis.

---

### `recondo-gateway search <query>`

Full-text search across turn content (SQLite only; PostgreSQL deployments use the GraphQL API).

```bash
recondo-gateway search "database password"
```

**Output:**

```
Found 3 matching turn(s):

  trn_xyz789 (session ses_abc123, seq 2) [claude-3-5-sonnet-20241022]
    I can see the issue in your auth.ts file. The database password should not be hardcoded in...

  trn_aabbcc (session ses_def456, seq 5) [gpt-4]
    The password field should be retrieved from an environment variable or secrets manager...

  trn_ddeeff (session ses_ghi789, seq 1) [claude-3-opus-4-20250805]
    Remember, never commit database passwords to your repository. Use .env files or...
```

**Use case:** Find all turns that reference a specific string (credential, API endpoint, file path, user ID, etc.) across the entire capture database.

---

### `recondo-gateway verify <session_id>`

Cryptographic integrity verification: recomputes SHA-256 hashes of on-disk captured bytes and compares against the database hash claims.

```bash
recondo-gateway verify ses_abc123
```

**Output:**

```
Verifying session: ses_abc123

Turn 1 (trn_123): PASS (req OK, resp OK)
Turn 2 (trn_456): PASS (req OK, resp OK)
Turn 3 (trn_789): PASS (req OK, resp OK)
Turn 4 (trn_012): PASS (req OK, resp OK)
Turn 5 (trn_345): PASS (req OK, resp OK)

Summary: 5 passed, 0 failed, 0 skipped out of 5 turns
```

**What this proves:** Every captured request and response byte matches the SHA-256 hash stored in the database. If any byte on disk was modified post-capture, the hash would mismatch and the verification would fail.

**Use case:** Prove to auditors that the on-disk captures are byte-perfect and have not been tampered with since original capture.

---

### `recondo-gateway stats`

Aggregate statistics (SQLite only; PostgreSQL deployments use the GraphQL API).

```bash
recondo-gateway stats
```

**Output:**

```
Recondo Statistics
==================
Sessions:     1247
Turns:        8934
Total tokens: 15,234,891
Models used:  claude-3-5-sonnet-20241022, claude-3-opus-4-20250805, gpt-4, gpt-4o
```

**Use case:** Establish baseline metrics for audit reporting.

---

### `recondo-gateway reprocess [--dry-run]`

Replay orphan captures: when the gateway crashes between writing a capture metadata file to disk and committing the corresponding database row, the capture is "orphaned." This command rescans the captures directory and re-inserts any orphans.

```bash
# Dry-run: count orphans without writing
recondo-gateway reprocess --dry-run

# Live: recover orphans
recondo-gateway reprocess
```

**Output (dry-run):**

```
scanned=1523 orphans_found=2 recovered=0 attachments_recovered=0 failed=0 dry_run=true
Recovery report (~/.recondo):
  scanned: 1523
  orphans_found: 2
  recovered: 0
  attachments_recovered: 0
  failed: 0
  mode: dry-run (no DB writes)
```

**Output (live):**

```
scanned=1523 orphans_found=2 recovered=2 attachments_recovered=2 failed=0 dry_run=false
Recovery report (~/.recondo):
  scanned: 1523
  orphans_found: 2
  recovered: 2
  attachments_recovered: 2
  failed: 0
```

**Use case:** Ensure no captures are lost during gateway restarts or crashes; audit the completeness of the capture database.

---

## Worked Example: Investigating a Suspected Credential Leak

**Scenario:** A security alert flags a possible database password leaked in a Claude session between 2026-05-09 10:00 UTC and 2026-05-09 12:00 UTC.

### Step 1: Search for the Credential

Search for a substring of the suspected leaked password:

```bash
recondo-gateway search "super_secret"
```

Output identifies three matching turns across two sessions. One of them is `trn_xyz789` in session `ses_abc123`, which falls in your suspect time window.

### Step 2: Examine the Full Turn

Inspect the turn that contains the leak:

```bash
recondo-gateway turn trn_xyz789
```

Output shows:
- The exact user message that revealed the password
- The timestamp (2026-05-09T10:31:15Z — within the alert window)
- The model and tokens used
- Unmasked file paths where the captured bytes are stored
- SHA-256 hashes of the request and response

### Step 3: Verify Integrity

Confirm the captured bytes have not been modified:

```bash
recondo-gateway verify ses_abc123
```

Output confirms all turns in the session, including `trn_xyz789`, have valid hashes. This proves the on-disk captures are the exact bytes that were transmitted—no tampering.

### Step 4: Access the Raw Bytes (Advanced)

For forensic teams that need to analyze the raw HTTP request/response bodies:

```bash
# Decompress and examine the captured request
zcat ~/.recondo/objects/req/e3/b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.gz | head -c 500

# Or, use xxd for binary inspection
zcat ~/.recondo/objects/req/e3/b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855.gz | xxd | head -20
```

This gives you byte-level visibility into the exact HTTP request and response that contained the leak.

### Step 5: Report Findings

Document:
- **Session ID:** `ses_abc123`
- **Turn ID:** `trn_xyz789`
- **Timestamp:** 2026-05-09T10:31:15Z
- **Model:** claude-3-5-sonnet-20241022
- **User message excerpt:** "Here's the code from auth.ts that's failing..." (include the leaked line)
- **Root cause:** User pasted hardcoded database password in debugging session
- **Verification:** `recondo-gateway verify ses_abc123` confirmed all hashes are intact
- **Mitigation:** Advise user to rotate the exposed database password

---

## What v1 Protects and Doesn't

### Path-Masking on Read

**Protected:** Captured filesystem paths (e.g., `/home/user/projects/secret-ai-app/api.ts`) are replaced with placeholders like `<file_at_line_2345>` when content flows through MCP, GraphQL, REST, TUI, or dashboard.

**Not protected:** The `recondo-gateway` CLI commands shown on this page bypass path-masking entirely. Anyone with shell access to the gateway host sees unmasked paths.

This is **intentional.** Forensic investigators need the raw truth; consumer-facing transports provide privacy-safe summaries.

### Credential-Pattern Redaction

**NOT in v1.** Raw captured prompts containing API keys, database passwords, OAuth tokens, or other credentials flow through every transport:
- MCP (`recondo_session_transcript` tool, `recondo_turn_detail` tool)
- GraphQL API (`Query.session`, `Query.turn`)
- REST (`GET /v1/sessions/{id}`, `GET /v1/turns/{id}`)
- TUI (all transcript views)
- Dashboard (all session/turn displays)
- Gateway CLI (`recondo-gateway session`, `recondo-gateway turn`, `recondo-gateway search`)

**When will it be redacted?** v1.5/v2 will add a global credential-redaction pass that identifies and masks patterns like:
- AWS/GCP/Azure secret keys
- API keys (OpenAI, Anthropic, etc.)
- Database connection strings
- OAuth tokens
- PII (email, phone, SSN, credit card numbers)

This requires uniform application across all transports and careful design around operator visibility for debugging. It is a tracked feature for the next release.

**Until then:** Recondo operators and auditors are responsible for the same content-handling discipline they currently apply to logs and transcripts—i.e., be mindful when screen-sharing, copying output, or sharing session links with untrusted parties.

---

## Hardening Recommendations

To limit exposure of sensitive captured content:

### 1. Restrict Shell Access to Gateway Host

Forensic-access tools (`recondo-gateway turn`, `recondo-gateway search`, `recondo-gateway verify`) require shell access to the machine running the gateway. Limit SSH access to a small set of authorized security/compliance personnel.

```bash
# Example: restrict SSH to a security-team subnet
# (in your host firewall or security group rules)
allow 10.20.30.0/24 port 22  # security team subnet
deny all other port 22
```

### 2. Restrict MCP/GraphQL/REST Access to Trusted Operators

The MCP, GraphQL API, REST, and TUI are consumer-facing transports. They serve the dashboard, agent integrations (Claude Code, Cursor, Goose), and operational dashboards. Restrict their network access:

```bash
# Example: only allow GraphQL API from internal networks
# (in your API container's ingress rules or load balancer)
allow 10.0.0.0/8          # internal network
allow 203.0.113.10/32     # specific dashboard IP
deny all other
```

### 3. Enable Host-Level Audit Logging

Recondo does not log CLI command invocations in v1. Enable your host's audit subsystem to track who runs `recondo-gateway` commands and when:

**Linux (auditd):**
```bash
# Log all recondo-gateway invocations
auditctl -w /usr/local/bin/recondo-gateway -p x -k recondo_cli
# Then query the audit log
ausearch -k recondo_cli | head -20
```

**macOS (auditctl):**
```bash
# Similar to Linux
praudit /var/audit/<audit-log-file> | grep recondo
```

**Windows (Event Viewer):**
- Enable command-line auditing: Group Policy → Computer Configuration → Administrative Templates → System → Audit Process Creation
- Query Event Viewer → Windows Logs → Security for `recondo-gateway` invocations

### 4. Encrypt Data Directory at Rest

Captures are stored on disk as gzipped objects. Encrypt the volume or filesystem:

**Linux (LUKS):**
```bash
cryptsetup luksFormat /dev/sdX
cryptsetup luksOpen /dev/sdX recondo_data
mkfs.ext4 /dev/mapper/recondo_data
mount /dev/mapper/recondo_data ~/.recondo
```

**macOS (FileVault):**
- System Settings → Privacy & Security → FileVault → Turn On

**Cloud (AWS/GCP/Azure):**
- Enable EBS/persistent-disk encryption at the volume level
- Enable database encryption (RDS, Cloud SQL)

### 5. Rotate Database Credentials Regularly

If using PostgreSQL, rotate the `recondo` database user's password quarterly or after any access-control audit.

```bash
# Connect as postgres superuser
ALTER USER recondo WITH PASSWORD 'new_secure_password_here';
```

### 6. Audit Log Retention

Set a retention window for captured data based on your compliance requirements (SOC 2, ISO 42001, etc.). After the retention window, consider archiving or purging old captures.

(Purge tools are not in v1 but are on the roadmap for v1.5.)

---

## Cross-References

- **Architecture overview:** See `architecture.md` Section 7, which explains the separation between path-masking-on-read and on-disk bytes.
- **Security model:** See `architecture.md` Section 7, "Security," for details on immutability, prompt-injection mitigations, and credential handling.
- **Data capture pipeline:** See `CLAUDE.md` in the repository root for the full data flow from interception through storage, the session identity model, and forensic recovery procedures.
- **Operator documentation:** See `tui/first-run.md` and `mcp/auth-modes.md` for configuring access control on consumer-facing transports.
