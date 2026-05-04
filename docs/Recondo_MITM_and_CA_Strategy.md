# Recondo — MITM and Enterprise CA Deployment Strategy

**Version:** 1.0
**Date:** 2026-04-22
**Status:** Technical strategy — informs product, documentation, and security-review posture
**Companion to:** Business Plan v0.4, Pivot Memo, MVP v1 Plan

---

## Why This Document Exists

Recondo's entire thesis — zero-touch, closed-agent governance, structural advantage over SDK competitors — rests on TLS MITM working cleanly in real enterprise environments. That's technically solved, but the *product experience* around trust distribution is currently poor:

- The default local-dev onboarding uses `NODE_TLS_REJECT_UNAUTHORIZED=0`, which is insecure and shows up as a finding in any serious security review.
- Developers and IT teams don't uniformly know how to install a custom CA into different runtime trust stores.
- The message sent to a CISO during a POC ("set this insecure flag on your laptop") is the opposite of the message we want to send in the enterprise sale.

This document defines how Recondo distributes trust across every deployment context — without ever asking a developer or customer to disable TLS validation.

---

## The Core Principle

**Recondo never asks anyone to bypass TLS. Recondo asks them to trust one additional CA.**

These are architecturally different things with wildly different security postures:

| Approach | What it does | Security posture |
|---|---|---|
| `NODE_TLS_REJECT_UNAUTHORIZED=0` | Disables *all* TLS certificate validation in Node.js. Any MITM — attacker or otherwise — is now accepted. | **Insecure.** Blocker in any security review. Should never appear in any Recondo-authored documentation or onboarding flow. |
| CA trust-store install | Adds the Recondo CA to the list of CAs the system trusts. All other certificate validation works exactly as before. | **Standard enterprise pattern.** Same model as Zscaler, Netskope, Bluecoat, and every corporate TLS inspection deployment. Defensible in SOC 2, ISO 27001, and bank vendor security reviews. |

Every onboarding path, every documentation page, every CLI command, and every MDM profile must take the second approach exclusively. `NODE_TLS_REJECT_UNAUTHORIZED=0` is explicitly prohibited from appearing anywhere in the product or its docs.

---

## Canonical Filesystem Layout

Recondo uses a fixed directory convention on every OS. All tooling, documentation, CLI commands, and `.recondorc` exports reference these paths consistently. Inconsistent CA locations across docs or runtime contexts is a recipe for security-review findings and user-support tickets — fix it at the spec level, not ad hoc.

### Per-user state directory — `~/.recondo/`

| Path | Purpose | Set by | Permissions |
|---|---|---|---|
| `~/.recondo/` | Root for all per-user Recondo state | `recondo init` | `0700` |
| `~/.recondo/config.toml` | Tenant, proxy, and runtime configuration | `recondo init` | `0600` |
| `~/.recondo/ca/` | Certificate authority directory | `recondo init` | `0700` |
| `~/.recondo/ca/ca.crt` | Recondo tenant CA public certificate — what every runtime trusts | `recondo init` | `0644` |
| `~/.recondo/ca/ca.key` | Recondo tenant CA private key — local-dev mode only; SaaS mode keeps the key server-side | `recondo init` (local dev) | `0600` |
| `~/.recondo/ca/extra_roots.pem` | Customer-provided corporate CAs (Zscaler, Netskope, Bluecoat) that Recondo's upstream TLS client must trust | Operator / MDM | `0644` |
| `~/.recondo/ca/leaf_cache/` | Per-host leaf certificates issued on demand, LRU-cached | Gateway runtime | `0700` |
| `~/.recondo/ca/audit.log` | Per-leaf-cert issuance log — every hostname Recondo has ever signed a certificate for, with timestamp + source session ID | Gateway runtime | `0600` |
| `~/.recondo/captures/` | Local capture metadata (dev mode; production writes to S3 + Postgres) | Gateway runtime | `0700` |
| `~/.recondo/objects/` | Local content-addressable object store (dev mode) | Gateway runtime | `0700` |
| `~/.recondo/wal/` | Write-ahead log buffer for fail-open durability | Gateway runtime | `0700` |

### System-wide state (Enterprise / MDM-deployed)

When deployed via MDM to a managed fleet, the CA lives in the OS trust store — not in the user's home directory. The `~/.recondo/` directory still exists for runtime-level config (proxy endpoint, per-tenant identity) but does not hold the CA.

| OS | System CA location | System config location |
|---|---|---|
| macOS | System Keychain (`/Library/Keychains/System.keychain`) | `/Library/Application Support/Recondo/config.toml` |
| Linux | `/usr/local/share/ca-certificates/recondo.crt` | `/etc/recondo/config.toml` |
| Windows | Trusted Root Certification Authorities store | `%PROGRAMDATA%\Recondo\config.toml` |

### Invariants

Three rules the product must preserve forever:

1. **`~/.recondo/ca/ca.crt` is the canonical path** for every documentation example, every `.recondorc` export (`NODE_EXTRA_CA_CERTS="$HOME/.recondo/ca/ca.crt"`, etc.), every support-ticket triage command, and every `recondo doctor` check. Never introduce alternate paths like `~/.recondoca/` or `~/.config/recondo/ca/`.
2. **`~/.recondo/ca/extra_roots.pem` is auto-discovered** by the gateway on startup. Customers behind Zscaler / Netskope drop their corporate CA bundle there once, and Recondo's upstream TLS client trusts it without further configuration. The startup log line `Loaded extra CA certificates for upstream TLS` confirms discovery.
3. **`recondo init` and `recondo cert install` are idempotent** — safe to re-run. They detect existing CA material and do not regenerate unless explicitly requested with `--force`, because regenerating the CA invalidates every leaf cert in the cache and breaks every running agent process.

This convention matches what the current gateway already ships. Future CLI commands, MDM templates, and documentation pages must conform to it rather than diverge.

---

## How It Works — TLS Handshake Walkthrough

This section explains the mechanics of the TLS handshake with and without Recondo in the path, and shows exactly why `NODE_TLS_REJECT_UNAUTHORIZED=0` is architecturally unsafe while `NODE_EXTRA_CA_CERTS` is architecturally correct. Internalize this — it is the canonical answer to 80% of the security-review questions you will receive.

### The baseline: a normal TLS connection (no Recondo, no MITM)

When Claude Code or any Node.js agent calls `https://api.anthropic.com`:

```
┌─────────────────┐                              ┌──────────────────────┐
│  Agent (Node)   │ ── TLS handshake ─────────▶  │  api.anthropic.com   │
│                 │                              │                      │
│ Trust list:     │ ◀── server cert ──           │ Serves leaf cert:    │
│  - Mozilla      │                              │  CN=api.anthropic.com│
│    bundled CAs  │                              │  Signed by: DigiCert │
└─────────────────┘                              └──────────────────────┘

Agent checks:
  1. Is the cert valid (not expired, hostname matches)?
  2. Is it signed by a CA in my trust list? (Yes — DigiCert is bundled.)
  → Handshake succeeds. Encrypted session established.
```

Node.js uses a bundled Mozilla CA list — not the OS trust store. That's a critical detail: installing a CA into the macOS Keychain does *not* automatically make Node.js trust it.

### With Recondo in the path (the correct model)

The agent is configured with two things: `HTTPS_PROXY=http://recondo:8443` and `NODE_EXTRA_CA_CERTS=~/.recondo/ca/ca.crt`.

```
┌─────────────────┐         ┌──────────────────────┐         ┌──────────────────────┐
│  Agent (Node)   │         │  Recondo Gateway     │         │  api.anthropic.com   │
│                 │         │                      │         │                      │
│ Trust list:     │         │ Holds:               │         │                      │
│  - Mozilla      │         │  - Recondo CA key    │         │                      │
│    bundled CAs  │         │  - Mozilla CA bundle │         │                      │
│  - Recondo CA   │         │    (for upstream)    │         │                      │
│    (from        │         │                      │         │                      │
│    NODE_EXTRA_  │         │                      │         │                      │
│    CA_CERTS)    │         │                      │         │                      │
└─────────────────┘         └──────────────────────┘         └──────────────────────┘

Step 1: Agent sends HTTP CONNECT api.anthropic.com:443
        ───────────────────────────────────────────▶

Step 2: Recondo responds 200 OK. Agent now expects TLS with "api.anthropic.com".
        ◀───────────────────────────────────────────

Step 3: Downstream TLS handshake (Agent ↔ Recondo):
        Recondo presents a leaf cert it just minted:
          CN=api.anthropic.com
          Signed by: Recondo CA (your tenant's CA)
        ◀─── leaf cert ─────────────────────────────

        Agent checks:
          1. Cert valid? Yes.
          2. Signed by a trusted CA? Yes — Recondo CA is in the trust list
             because NODE_EXTRA_CA_CERTS added it.
          → Downstream handshake succeeds.

Step 4: Recondo opens its own upstream TLS to the real api.anthropic.com.
        Recondo validates Anthropic's real cert against the standard Mozilla bundle
        (plus ~/.recondo/ca/extra_roots.pem for corporate-CA coexistence).
        ─────── TLS handshake ──────────────────────▶
        ◀────── Anthropic real cert (DigiCert) ─────

Step 5: Plaintext traffic flows across both legs. Recondo inspects, records,
        optionally redacts. Re-encrypts upstream.

Result: Agent sees "TLS connection to api.anthropic.com, validated, encrypted." 
        Agent's TLS validation was NOT weakened. The only change is that the
        agent trusts one additional CA (Recondo's), whose authority is scoped
        to this one machine.
```

The agent's TLS validation is fully intact. Recondo's CA was added to the trust list; nothing was subtracted or disabled.

### The wrong way: `NODE_TLS_REJECT_UNAUTHORIZED=0`

If instead of installing the CA, the developer sets the insecure flag:

```
┌─────────────────┐         ┌──────────────────────┐         ┌──────────────────────┐
│  Agent (Node)   │         │  Recondo Gateway     │         │  api.anthropic.com   │
│                 │         │                      │         │                      │
│ NODE_TLS_       │         │                      │         │                      │
│ REJECT_         │         │                      │         │                      │
│ UNAUTHORIZED=0  │         │                      │         │                      │
│                 │         │                      │         │                      │
│ Trust list:     │         │                      │         │                      │
│  *** IGNORED ***│         │                      │         │                      │
└─────────────────┘         └──────────────────────┘         └──────────────────────┘

Step 3': Recondo presents leaf cert signed by Recondo CA.

        Agent checks:
          1. Cert valid? ... doesn't matter.
          2. Signed by a trusted CA? ... doesn't matter.
          3. Hostname matches? ... doesn't matter.
          → Handshake succeeds. ALL certificate validation was skipped.
```

The handshake "succeeds" but TLS is now vacuous. The agent accepts *any* certificate from *any* party presenting *any* hostname. That means:

1. **Recondo works** — the leaf cert is accepted. So far so good.
2. **But every OTHER HTTPS site the agent contacts is also unvalidated.** If the agent calls `https://github.com`, it will accept any cert presented — including one issued by an attacker. The flag is process-wide and doesn't scope to Anthropic.
3. **Coffee-shop Wi-Fi becomes a real risk.** An attacker on the same network who injects certs for `github.com`, `slack.com`, or any other hostname the agent touches gets silent MITM.
4. **The flag often leaks into production.** A developer sets it in `.bashrc` for a POC, forgets, and six months later an agent running in prod is still bypassing TLS validation.
5. **Automated security scanners flag it.** Most SOC 2 / ISO 27001 tooling treats `NODE_TLS_REJECT_UNAUTHORIZED=0` as a critical finding. Running a POC with it set creates an actual compliance problem.

### The key architectural difference

| | `NODE_EXTRA_CA_CERTS` | `NODE_TLS_REJECT_UNAUTHORIZED=0` |
|---|---|---|
| **What it does** | Adds one CA to the existing trust list | Disables all certificate validation |
| **Scope** | One specific CA, controlled by its private key | All connections, all hostnames, all certs |
| **Attacker resistance** | Attacker still needs Recondo's CA private key to MITM | Attacker can MITM with *any* certificate |
| **Revocation** | Remove ca.crt → all Recondo-signed certs instantly invalid | No revocation — the flag must be unset |
| **Security-review posture** | Identical to Zscaler / Netskope pattern, accepted | Critical finding in any serious review |
| **Failure mode if misconfigured** | Connection fails visibly | Connection silently succeeds against attacker certs |

The two look superficially similar — both let the agent connect through Recondo. Architecturally they are opposites. One narrows trust to a known additional party. The other removes trust entirely.

### Why Recondo's MITM is safe even though MITM is inherent to the design

Five properties hold the model together:

1. **Trust is additive, not subtractive.** Every runtime keeps its existing CA bundle. Recondo's CA is appended, not substituted. The agent's defense against every other attacker is unchanged.
2. **Scope is hostname-bounded.** Recondo's gateway only mints leaf certs for hostnames in its configured allowlist (Anthropic, OpenAI, Gemini, and explicitly added custom endpoints). CONNECT tunnels for any other hostname pass through without MITM — Recondo never sees the plaintext, never issues a cert.
3. **The CA private key has a narrow blast radius.** In SaaS mode, the private key lives in the gateway process (tenant-isolated, KMS-wrapped at rest). In BYOC / Enterprise mode, the customer holds the key in their own KMS. Developer laptops hold only the public certificate, which is useless for impersonation.
4. **Every leaf cert is logged.** `~/.recondo/ca/audit.log` (or in SaaS mode, the tenant's audit log) records hostname, issuance timestamp, and originating session for every certificate Recondo signs. "Show me every cert Recondo has ever issued" is a queryable answer.
5. **The CA is instantly revocable.** `recondo cert uninstall` removes Recondo's CA from the trust store; subsequent connections fail as they should. No certificate-revocation-list propagation delay, no browser cache — it's local trust, removing the local trust terminates the authority.

### What this means for the product

Three concrete requirements fall out of the mechanics:

1. **`recondo doctor` must detect insecure env vars.** Specifically: `NODE_TLS_REJECT_UNAUTHORIZED=0`, `PYTHONHTTPSVERIFY=0`, `GIT_SSL_NO_VERIFY=true`, `CURL_CA_BUNDLE=""` (empty), and similar. Emit an explicit warning naming the flag, explain what it does, and point at the correct path (`NODE_EXTRA_CA_CERTS` etc.).
2. **The `recondo cert install` flow must set `NODE_EXTRA_CA_CERTS` (and its siblings) in `~/.recondorc`** — never `NODE_TLS_REJECT_UNAUTHORIZED=0`. If shell exports are incomplete for the user's stack, that is a bug to fix, not a footgun to tolerate.
3. **Every troubleshooting doc must call this out.** If a user search-engines a TLS error and pastes `NODE_TLS_REJECT_UNAUTHORIZED=0` from Stack Overflow, Recondo's docs must rank high enough on the alternate query to redirect them. Publish a page titled "Why you should never set `NODE_TLS_REJECT_UNAUTHORIZED=0` with Recondo" and link it from every install guide.

---

## The Trust-Store Landscape

Understanding what Recondo is up against requires knowing where each runtime looks for trusted CAs. There are two layers:

### Layer 1 — OS System Trust Store

Most applications defer to the operating system for trust decisions.

| OS | Trust store location | Install command |
|---|---|---|
| macOS | System Keychain (`/Library/Keychains/System.keychain`) | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain recondo-ca.crt` |
| Windows | Trusted Root Certification Authorities | `certutil -addstore -f "ROOT" recondo-ca.crt` (elevated) |
| Linux (Debian/Ubuntu) | `/usr/local/share/ca-certificates/` | `sudo cp recondo-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates` |
| Linux (RHEL/Fedora) | `/etc/pki/ca-trust/source/anchors/` | `sudo cp recondo-ca.crt /etc/pki/ca-trust/source/anchors/ && sudo update-ca-trust` |
| Alpine (containers) | `/usr/local/share/ca-certificates/` | `cp recondo-ca.crt /usr/local/share/ca-certificates/ && update-ca-certificates` |

### Layer 2 — Language-Runtime Trust Stores

Several language runtimes ship their own CA bundle and ignore the OS trust store. This is the source of most developer confusion.

| Runtime | Uses OS trust store? | Override mechanism |
|---|---|---|
| Node.js | No (bundled Mozilla list) | `NODE_EXTRA_CA_CERTS=/path/to/recondo-ca.crt` (additive — trusts system + extra) |
| Python `requests` | No (bundled `certifi`) | `REQUESTS_CA_BUNDLE=/path/to/recondo-ca.crt` |
| Python `urllib` / `httpx` | No (bundled `certifi`) | `SSL_CERT_FILE=/path/to/recondo-ca.crt` |
| Go | Yes (uses OS trust store on macOS/Windows/Linux) | System install is sufficient |
| Rust `native-tls` | Yes | System install is sufficient |
| Rust `rustls` | No (uses `webpki-roots` by default) | Per-tool config; often requires rebuild or env var like `SSL_CERT_FILE` |
| Java / JVM | No (uses `cacerts` keystore) | `keytool -importcert -keystore $JAVA_HOME/lib/security/cacerts -alias recondo -file recondo-ca.crt -storepass changeit` |
| Ruby | No (uses `rubygems/ssl_certs` bundle) | `SSL_CERT_FILE=/path/to/recondo-ca.crt` |
| .NET | Yes (uses OS trust store) | System install is sufficient |
| `curl` | Depends on build (often OS) | `CURL_CA_BUNDLE=/path/to/recondo-ca.crt` or `--cacert` |
| `git` | Usually uses OS via `libcurl` | `GIT_SSL_CAINFO=/path/to/recondo-ca.crt` or `git config http.sslCAInfo` |
| Codex (Rust CLI) | No (custom `rustls` build) | `CODEX_CA_CERTIFICATE=/path/to/recondo-ca.crt` |

The critical insight: **installing into the OS trust store solves ~60% of cases for free** (Go, Rust `native-tls`, .NET, `curl` on many platforms). The remaining 40% need a per-runtime environment variable. Node.js is the most important of these because Claude Code, Cursor, and most JavaScript tooling depend on it.

---

## Deployment Contexts and Strategies

Recondo meets users in five distinct contexts. Each has a different correct deployment pattern. Never ship one-size-fits-all instructions.

### Context 1 — Enterprise Production (Managed Fleet)

**Who:** F500 / F1000 engineering organizations with MDM-managed laptops.
**Pattern:** MDM-pushed CA to system trust store + corporate proxy config.

**Apple devices (Jamf, Kandji, Mosyle):**
- Ship a signed `.mobileconfig` Configuration Profile containing:
  - Certificate payload (Recondo CA)
  - HTTP Proxy payload (auto-configure via PAC URL or manual host/port)
  - Optional: SSL Trust settings to enable the CA for specific apps
- Admin deploys via MDM push. Users see no prompt if profile is signed and the MDM is trusted.

**Windows devices (Intune, SCCM, Group Policy):**
- Intune: "Trusted Root Certificate" profile type + "VPN" or "Network" profile for proxy
- Group Policy: import CA to `Computer Configuration > Windows Settings > Security Settings > Public Key Policies > Trusted Root Certification Authorities`
- Proxy via `netsh winhttp set proxy` or Group Policy network settings

**Linux devices (Ansible, MDM-for-Linux like JumpCloud):**
- Ansible role that copies CA to `/usr/local/share/ca-certificates/` and runs `update-ca-certificates`
- Sets `https_proxy` / `HTTPS_PROXY` in `/etc/environment`

**Recondo ships:**
- Pre-built `.mobileconfig` template with signature placeholder (customer signs with their own MDM signing cert)
- Intune-ready certificate `.cer` + configuration XML
- Ansible role published as a Git repository
- Documentation with copy-paste snippets per MDM platform

**Result:** developer laptop already trusts Recondo CA on day one. Developer launches Claude Code / Cursor / whatever. Recondo just works. No env vars. No manual steps. No insecure flags.

### Context 2 — Enterprise POC (Pre-Deployment)

**Who:** Platform Engineering lead running a 5–10 developer pilot before fleet rollout.
**Pattern:** Per-developer manual CA install via Recondo CLI + documented env vars for language runtimes.

**Flow:**
1. `curl -fsSL https://recondo.ai/install | sh` (or Windows/Linux equivalent)
2. Installer prompts for elevation, installs CA to OS trust store, and writes per-runtime env var exports to a `.recondorc` file that the user sources from their shell profile.
3. Sets `HTTPS_PROXY=http://recondo.tenant.internal:8443` (or `.recondorc`-sourced)

**What `.recondorc` contains (added to `~/.zshrc` / `~/.bashrc` / PowerShell profile):**
```bash
export HTTPS_PROXY=http://recondo.tenant.internal:8443
export NODE_EXTRA_CA_CERTS="$HOME/.recondo/ca/ca.crt"
export SSL_CERT_FILE="$HOME/.recondo/ca/ca.crt"
export REQUESTS_CA_BUNDLE="$HOME/.recondo/ca/ca.crt"
export CURL_CA_BUNDLE="$HOME/.recondo/ca/ca.crt"
export GIT_SSL_CAINFO="$HOME/.recondo/ca/ca.crt"
export CODEX_CA_CERTIFICATE="$HOME/.recondo/ca/ca.crt"
```

**What `.recondorc` explicitly does NOT contain:**
- `NODE_TLS_REJECT_UNAUTHORIZED=0`
- `PYTHONHTTPSVERIFY=0`
- `GIT_SSL_NO_VERIFY=true`
- Any other TLS-disabling flag

If the product ever surfaces one of those, it is a bug — file it, fix it, ship a version bump.

### Context 3 — Containerized Agents and CI/CD

**Who:** Agents running inside Docker containers, Kubernetes pods, or CI runners.
**Pattern:** Build-time CA injection via Dockerfile layer.

**Base pattern:**
```dockerfile
# Install Recondo CA into the OS trust store
COPY recondo-ca.crt /usr/local/share/ca-certificates/recondo.crt
RUN update-ca-certificates

# For Node.js-based agents, set env var at image level
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/recondo.crt

# For Python-based agents
ENV SSL_CERT_FILE=/usr/local/share/ca-certificates/recondo.crt
ENV REQUESTS_CA_BUNDLE=/usr/local/share/ca-certificates/recondo.crt

# Set proxy
ENV HTTPS_PROXY=http://recondo-gateway.internal:8443
```

**Recondo ships:**
- Dockerfile snippet library for Alpine, Debian, RHEL-based base images
- Kubernetes `ConfigMap` + init-container pattern for CA injection without rebuilding images
- GitHub Actions / GitLab CI example workflows showing CA injection for test pipelines

### Context 4 — Cloud-Hosted Agents (Bedrock, Azure AI, Vertex)

**Who:** Agent workloads that don't run on employee laptops at all — they run in AWS Lambda, Azure Functions, Vertex AI endpoints, Cloud Run, etc.
**Pattern:** Network-level redirect via VPC egress, with Recondo deployed as an egress gateway in the same VPC.

**AWS example:**
- Recondo deployed as ECS/EKS service in customer VPC
- VPC route table sends outbound `*.anthropic.com` / `*.openai.com` / `*.googleapis.com` traffic to Recondo gateway ENI
- Gateway has Recondo CA installed; customer workloads trust it via VPC-distributed config or base image
- Outbound internet egress from Recondo → provider (re-encrypted, inspected)

**Recondo ships:**
- Terraform modules for AWS VPC egress redirect
- CloudFormation templates as fallback
- Azure equivalent (Application Gateway / NVA)
- GCP equivalent (Cloud Load Balancer + Private Service Connect)

This context is an advanced deployment pattern. Architecting for it from day one keeps the design coherent.

### Context 5 — Developer POC (5-Minute Smoke Test)

**Who:** An individual developer trying Recondo for 5 minutes to see if it works before escalating to their Platform Eng team.
**Pattern:** Single-command install with immediate correct behavior.

**Target UX:**
```bash
$ curl -fsSL https://recondo.ai/quick | sh
Installing Recondo CA to system trust store... done.
Writing env var exports to ~/.recondorc... done.
Starting local test proxy on :8443... done.

To use: run `source ~/.recondorc` in a new terminal, then launch your AI tool.
Try: `source ~/.recondorc && claude`

Recondo does NOT disable TLS validation. Your TLS trust for every other
site is unchanged — we only add our CA to the trusted list.

$ source ~/.recondorc && claude
# Claude Code works. Recondo captures the session. No insecure flags anywhere.
```

The 5-minute developer experience is the hook that leads to the Platform Eng conversation. It has to work, and it has to not embarrass anyone in a security review.

---

## Why Recondo's CA Is Not a Security Risk

Common question in security reviews: *"If I add Recondo's CA, doesn't that let Recondo intercept any HTTPS traffic on my machine?"*

The honest, defensible answer:

1. **Technically yes — Recondo's CA can issue a certificate for any hostname the machine subsequently validates.** That's how MITM works.
2. **This is the same trust model customers already extend to Zscaler, Netskope, Bluecoat, and any other corporate TLS inspection product.** It's a known, accepted enterprise pattern.
3. **Recondo's gateway only performs MITM on hostnames explicitly configured in the proxy allowlist** (Anthropic, OpenAI, Gemini, etc.). All other traffic is passed through via CONNECT tunnel without MITM — Recondo never sees the plaintext.
4. **The CA private key is scoped to a single deployment** — either in the operator's VPC (BYOC mode) or in a tenant-isolated environment under the operator's KMS key.
5. **Full audit trail.** Every leaf certificate Recondo issues is logged with its hostname, issuance timestamp, and originating session. The answer to "show me every hostname Recondo ever issued a cert for" is a SQL query.
6. **Bring Your Own CA mode** — the operator generates their own CA, gives Recondo only the private key file, and rotates at will. Recondo never persists the key to disk outside the operator-controlled key store.

This is the same trust model that organizations running SASE products (Zscaler, Netskope, Bluecoat) already accept.

---

## Coexistence with Existing Corporate CA Inspection

A real-world constraint: many Recondo customers already have Zscaler or Netskope installed. That means their developer laptops already have a corporate MITM CA. Recondo must coexist, not conflict.

**The layering model:**
```
Developer machine
  → (HTTPS_PROXY=http://recondo.gateway) Recondo (MITM layer 1)
    → (upstream proxy) Zscaler (MITM layer 2, optional)
      → (internet) Anthropic / OpenAI / Gemini
```

**What Recondo ships to support this:**
- **Canonical auto-discovery path: `~/.recondo/ca/extra_roots.pem`** (see Canonical Filesystem Layout above). Drop the corporate CA bundle there once and the gateway's upstream TLS client trusts it on next startup.
- `RECONDO_EXTRA_CA_CERTS` environment variable for per-session override without modifying the on-disk file.
- Documentation specifically for "we already use Zscaler/Netskope" customers, with proxy chaining examples and the one-line `cp` command for `extra_roots.pem`.
- Test suite that validates MITM works when an upstream TLS-inspecting proxy is present.

This is already implemented at the code level (`Loaded extra CA certificates for upstream TLS` log message on startup). The product-level requirement is making it visible and well-documented — every page that mentions Zscaler / Netskope coexistence must reference `~/.recondo/ca/extra_roots.pem` as the canonical drop-in location.

---

## Handling Edge Cases

### Edge Case 1 — Closed Binary with TLS Pinning

Rare today but non-zero risk. If an agent binary ships with TLS pinning (validating against a hardcoded certificate rather than the OS trust store), neither CA install nor proxy redirection works.

**Mitigation (not MVP, but ready):**
- Per-binary shim: an LD_PRELOAD / DYLD_INSERT_LIBRARIES / Windows DLL that overrides the pinning check for known agent binaries. MDM-deployed. Signed by the customer's code-signing cert.
- This is a Ring 2 feature. Build the capability but don't lead with it.

### Edge Case 2 — SDK Doesn't Respect `HTTPS_PROXY`

Some SDKs ignore proxy env vars and do their own DNS + TCP directly. Rare in mainstream agents but has happened.

**Mitigation:**
- DNS-level redirect: customer's internal DNS returns Recondo's gateway IP for LLM provider hostnames. Used for agents that bypass proxy env vars but honor DNS.
- Documented as an advanced deployment option.

### Edge Case 3 — Developer Works on macOS but Agent Runs in Docker

Very common. Developer's Mac has Recondo CA, but the Docker container they're running an agent in doesn't.

**Mitigation:**
- Recondo CLI emits a `Dockerfile.recondo` snippet the developer can `COPY` or `INCLUDE` into their existing Dockerfile.
- Development docker-compose example that mounts the CA file into containers via volume.

### Edge Case 4 — Browser Traffic

Browsers (Chrome, Safari, Firefox) use their own certificate validation layers. If the customer wants to capture browser-initiated agent traffic (e.g., Claude.ai in a tab, ChatGPT in a tab — out-of-scope for MVP, but Ring 3), that requires additional browser-level CA installation.

- Chrome uses OS trust store on macOS/Windows — system install works.
- Firefox uses its own NSS store — requires manual import or enterprise policy.
- Documented but not core to Ring 1.

---

## What the Recondo CLI Must Do (Implementation Requirements)

For the MVP, the Recondo CLI needs these commands to make the deployment story work cleanly:

| Command | Behavior |
|---|---|
| `recondo init` | Generate a CA for this tenant (or fetch from SaaS control plane). Create `~/.recondo/ca/` directory with correct permissions. |
| `recondo cert install` | Install the CA into the OS trust store with appropriate elevation prompt. Detects OS and picks the right method. |
| `recondo cert install --output=mobileconfig` | Emit a `.mobileconfig` for MDM distribution (Apple). |
| `recondo cert install --output=intune` | Emit `.cer` + configuration XML for Intune. |
| `recondo cert uninstall` | Remove the CA cleanly. Important for security reviewers and for uninstall scenarios. |
| `recondo env` | Print shell exports for `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, etc. Pipeable into `.recondorc`. |
| `recondo env --shell=powershell` | Same but for PowerShell. |
| `recondo dockerfile` | Emit a Dockerfile snippet for CA injection. |
| `recondo doctor` | Diagnose: is CA installed? Is proxy reachable? Does `curl https://api.anthropic.com` work through the gateway? Are any insecure env vars (`NODE_TLS_REJECT_UNAUTHORIZED=0`) set? |
| `recondo doctor --fix` | Attempt automated remediation. |

`recondo doctor` is especially important: it's the tool that catches users who pasted `NODE_TLS_REJECT_UNAUTHORIZED=0` from a Stack Overflow answer, warns them, and shows them the correct path. This is one of the highest-leverage features for the security-review narrative — the tool *actively discourages* insecure patterns.

---

## Documentation Requirements

Every doc page that references deployment must lead with the correct pattern. The following pages must exist by MVP ship:

| Page | Content |
|---|---|
| `/docs/quickstart` | 5-minute install: `curl \| sh` → CA installed → env vars set → first capture |
| `/docs/install/macos` | Step-by-step install on macOS, both manual and scripted |
| `/docs/install/linux` | Same for Ubuntu, Debian, RHEL, Fedora, Alpine |
| `/docs/install/windows` | Same for Windows 10 / 11 and Server |
| `/docs/install/mdm/jamf` | Jamf configuration profile + deployment guide |
| `/docs/install/mdm/intune` | Intune configuration guide |
| `/docs/install/mdm/kandji` | Kandji certificate library guide |
| `/docs/install/docker` | Dockerfile snippets and compose patterns |
| `/docs/install/kubernetes` | ConfigMap + init-container pattern |
| `/docs/language/node` | Node.js-specific: `NODE_EXTRA_CA_CERTS`, **never** the insecure flag |
| `/docs/language/python` | Python-specific: `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE` |
| `/docs/language/go` | Go-specific: system trust store works |
| `/docs/language/java` | Java-specific: `keytool` import |
| `/docs/coexistence/zscaler` | How Recondo coexists with Zscaler |
| `/docs/coexistence/netskope` | How Recondo coexists with Netskope |
| `/docs/security/ca-trust-faq` | The "is Recondo's CA a security risk?" FAQ for security reviewers |
| `/docs/security/audit-log` | How to audit every certificate Recondo has ever issued |
| `/docs/troubleshooting` | Common errors and their fixes. Top entry: "I see `NODE_TLS_REJECT_UNAUTHORIZED=0` in a tutorial — should I use it? → No, here's why and what to use instead." |

Every one of these pages must end with a visible warning box: *"Recondo does not require disabling TLS validation. If instructions anywhere tell you to set `NODE_TLS_REJECT_UNAUTHORIZED=0` or similar, that is not the correct path — please contact support."*

---

## Security-Review Playbook

When a customer's security team asks hard questions, Recondo's response should be pre-staged and consistent. These are the top ten questions and the canonical answers:

1. **Q: Does Recondo see our plaintext LLM traffic?**
   A: Yes — that is how observability works. Traffic is plaintext only within the Recondo gateway process, in memory. It is hashed, optionally redacted, then encrypted at rest with the operator's KMS key.

2. **Q: Is your CA private key on every developer laptop?**
   A: No. The CA private key lives in the gateway process only. Developer laptops carry only the CA *public* certificate, which is what they need to trust the gateway's leaf certs.

3. **Q: Can Recondo issue a certificate for arbitrary hostnames?**
   A: Technically yes — that's inherent to how a CA works. Recondo's gateway only issues certs for allowlisted hostnames (Anthropic, OpenAI, Gemini, etc.) and logs every issuance. Audit log is exportable to your SIEM.

4. **Q: What happens if your gateway is compromised?**
   A: Gateway is multi-tenant isolated. Each tenant's CA key is encrypted at rest. Compromise of one tenant's key does not affect others. Full incident response runbook in your security review packet.

5. **Q: Can we bring our own CA?**
   A: Yes. Generate the CA in your own infrastructure, hand Recondo the key material via your KMS, and rotate on your schedule.

7. **Q: Do you persist the plaintext of prompts/responses?**
   A: Configurable. Default: hashed metadata in our Postgres, raw bodies in your S3 bucket with your KMS key. Metadata-only mode is also available (no bodies persisted anywhere).

8. **Q: What about TLS pinning — will this stop working?**
   A: LLM providers are strongly commercially disincentivized to pin (TLS inspection is mandatory in most regulated enterprises). If any provider pins, Recondo ships a signed per-binary shim via MDM within a week. Defense-in-depth, not a single point of failure.

9. **Q: What if a developer pastes `NODE_TLS_REJECT_UNAUTHORIZED=0` into their shell?**
   A: `recondo doctor` detects this and warns. It is not a supported path and never appears in our documentation. Our position: disabling TLS validation is a security regression and we actively discourage it.

10. **Q: Is there an airgapped deployment option?**
    A: BYOC mode supports fully airgapped deployment with zero outbound connectivity from the operator's environment. Gateway + data plane run entirely in the operator's VPC.

---

## Implementation Priorities for MVP

For the 6–8 week MVP window, the CA/MITM strategy must deliver:

| Priority | Deliverable | Why |
|---|---|---|
| **P0** | `recondo cert install` works on macOS, Linux, Windows | Table stakes for any onboarding |
| **P0** | Quickstart flow never mentions `NODE_TLS_REJECT_UNAUTHORIZED=0` | Security-review defensibility |
| **P0** | `recondo doctor` diagnoses installation and warns on insecure env vars | Prevents user self-harm |
| **P0** | `.recondorc` shell export file generated by installer | Clean developer UX |
| **P0** | Documentation for Node.js, Python, Go, Rust with correct env vars | Covers 95% of tooling |
| **P1** | Jamf `.mobileconfig` template | First MDM integration — macOS dominant in target segment |
| **P1** | `recondo cert uninstall` works cleanly | Uninstall story matters for security reviews |
| **P1** | Zscaler / Netskope coexistence documented and tested | Most enterprise targets run one of these |
| **P2** | Intune configuration guide | Windows-heavy accounts (fintech, health-tech) |
| **P2** | Dockerfile snippet library | Containerized agents in CI |
| **P3** | Kandji / other MDM platforms | Long tail |
| **P3** | Per-binary shim scaffold (not shipped, not documented externally) | Insurance against TLS pinning |
| **P3** | VPC egress Terraform modules (AWS) | Advanced deployment |

---

## The Single Most Important Rule

**`NODE_TLS_REJECT_UNAUTHORIZED=0` must never appear in any Recondo-authored doc, tutorial, blog post, example, or CLI output.**

If a user asks "why can't I just use `NODE_TLS_REJECT_UNAUTHORIZED=0`?" the answer is a documentation link explaining what it does (disables all TLS validation, not just Recondo's) and pointing them at `NODE_EXTRA_CA_CERTS` instead.

This is the single cleanest signal to security reviewers that Recondo is built correctly. Every competitor tool that shows up with a `REJECT_UNAUTHORIZED=0` in their quickstart — and several do — loses that review on the first page.

---

*Technical strategy document. Review quarterly or on material change to the trust-distribution landscape (new mainstream runtime with a novel trust-store model, meaningful shift in MDM landscape, vendor TLS pinning event, etc.).*
