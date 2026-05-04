---
name: Bug report
about: Report a bug in the gateway, API, dashboard, or CLI
title: ''
labels: bug
assignees: ''
---

## What happened

<!-- A clear, concise description of the bug. -->

## Expected behavior

<!-- What you expected to happen instead. -->

## Reproduction

Steps to reproduce:

1.
2.
3.

Minimal repro (if applicable):

```
<paste a minimal command, request, or config that triggers the bug>
```

## Environment

- Component: <!-- gateway / API / dashboard / CLI -->
- Version or commit: <!-- `cargo --version` and `git rev-parse HEAD` -->
- Operating system:
- Storage backend: <!-- sqlite / postgres -->
- Object store: <!-- local / s3 -->
- Agent (if applicable): <!-- e.g. Claude Code 1.0.5, Codex 0.4.2 -->

## Logs

<!--
Paste relevant gateway logs (`RUST_LOG=recondo_gateway=debug just run` is helpful).
Redact any tokens, API keys, or sensitive data before pasting.
-->

```
<logs here>
```

## Additional context

<!-- Anything else that might help: screenshots, related issues, recent changes. -->
