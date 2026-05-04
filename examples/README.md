# Examples

Runnable scripts that route a coding agent through the local Recondo gateway.

## Prerequisites

The gateway must be running on `localhost:8443` and its CA must be generated:

```bash
just recondo init        # one-time: generate CA + install into system trust store
just run                 # start the gateway in another terminal
```

## Scripts

| Script | What it does |
|--------|--------------|
| [`claude-code.sh`](claude-code.sh) | Launch Claude Code with the gateway's CA trusted (Node-based agent) |
| [`codex.sh`](codex.sh) | Launch OpenAI Codex with the gateway's CA trusted (Rust-based agent) |
| [`gemini.sh`](gemini.sh) | Launch a Gemini-based agent with the gateway's CA trusted |

## Verifying captures

After running an agent through the gateway, captures land in:

```
~/.recondo/objects/req/    # gzipped request bodies (content-addressed)
~/.recondo/objects/resp/   # gzipped response bodies
~/.recondo/captures/       # JSON metadata linking req/resp hashes
```

Browse them with the CLI:

```bash
just recondo sessions               # list all captured sessions
just recondo session <session-id>   # show turn-by-turn trace for a session
just recondo turn <turn-id>         # show full detail for a single turn
```
