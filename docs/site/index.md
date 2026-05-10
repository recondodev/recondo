# Recondo — Visibility and Control for Coding Agents

Your god-view across every coding agent on your network. One dashboard, one vantage point, one invoice.

## Why Recondo

- **Network-Layer Visibility** — Sit between agents and LLM providers. See every request, every response, every dollar. No SDKs, no code changes.
- **Multi-Provider, One Control Plane** — Anthropic, OpenAI, and Gemini side by side. Cap spend per team, redact secrets, route by model, all from one place.
- **Audit-Grade Immutability** — SHA-256 hashed captures. Write-once schema. Compliance by design: SOC 2, ISO 42001, GDPR-ready.

## Get Started

[Quickstart →](./quickstart.md) | [Install MCP →](./mcp/install.md)

---

## TUI: Cross-Tool God-View (60s)

<!-- video: docs/site/demos/assets/tui-60s.mp4 -->

Monitor every coding agent on your network—Claude Code, Codex, Cursor, Aider, Gemini-based agents—in one place. See request/response pairs, token counts, costs, and tool calls as they happen. Search, filter, and drill down by session, model, or provider.

---

## MCP: Your Agents Introspect Their Own History (30s)

<!-- video: docs/site/demos/assets/mcp-30s.mp4 -->

Agents can query their own captured history via Recondo's MCP server. Answer questions like "how many times did I call this tool?" or "what was my last context window?" Agents stay in the loop, accountability stays automated.

---

## Architecture

```
Coding Agent (Claude Code / Codex)
  │
  │  CONNECT gateway:8443
  ▼
┌─────────────────────────────────┐
│         Recondo Gateway         │
│                                 │
│  ┌─────────┐    ┌────────────┐  │
│  │   TLS   │───▶│  Capture   │  │
│  │  MITM   │    │  Pipeline  │  │
│  └─────────┘    └─────┬──────┘  │
│                       │         │
│         ┌─────────────┼─────┐   │
│         ▼             ▼     ▼   │
│    ┌─────────┐  ┌────────┐ ┌──┐ │
│    │ Provider│  │ Object │ │DB│ │
│    │ Parser  │  │ Store  │ │  │ │
│    └─────────┘  └────────┘ └──┘ │
└─────────────────────────────────┘
         │              │       │
         ▼              ▼       ▼
    Anthropic/     S3 / Local  PostgreSQL /
    OpenAI/        Filesystem  SQLite
    Gemini
```

**Built in Rust.** Self-hosted on-prem or in your own AWS account (Terraform included). Zero-touch: agents connect through it without code modification.
