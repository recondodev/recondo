# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Recondo, please report it privately. **Do not file a public GitHub issue.**

Email: **andmer@gmail.com**

Please include:

- A description of the issue and its potential impact
- Steps to reproduce (or a proof-of-concept, if available)
- The affected component (gateway / API / dashboard / dependency) and version or commit hash
- Any suggested mitigations

You should expect an acknowledgement within **3 business days** and a resolution timeline within **7 business days**.

## Scope

In-scope:

- The `recondo-gateway` Rust binary and library (`gateway/`)
- The TypeScript GraphQL API (`api/`)
- The React dashboard (`dashboard/`)
- The Terraform module (`deploy/terraform/aws/`)

Out of scope:

- Third-party dependencies (please report directly to the upstream maintainer)
- Vulnerabilities in agents that route through the gateway (Claude Code, Codex, Cursor, Aider, Gemini-based agents)
- Vulnerabilities in upstream LLM providers (Anthropic, OpenAI, Google)

## Supported versions

This project is pre-1.0 and ships from `main`. Only the current `main` branch receives security fixes.

## Disclosure

We follow coordinated disclosure: once a fix is available, a CVE will be requested where applicable, and details will be published in the release notes after users have had a reasonable window to upgrade.
