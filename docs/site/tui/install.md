# Recondo TUI — Installation

The Recondo TUI (`recondo-tui`) is a terminal user interface that gives you a god-view of all your AI agent traffic in real-time. It displays live metrics, session histories, cost breakdowns, and agent analytics with a fluid, tmux-friendly interface.

## Option 1: From Source (Current v1)

While Recondo TUI is in v1 development, the recommended install path is from source:

```bash
git clone https://github.com/anthropics/recondo
cd recondo
cargo run -p recondo-tui
```

The TUI will compile (30–60 seconds on first run) and launch immediately with the realtime lens active. Subsequent runs are instant.

**Requirements:**
- Rust toolchain 1.80+ ([install via rustup](https://rustup.rs/))
- Running Recondo gateway on port 8443 (fixed, not configurable)
- Running Recondo API on port 4000 (or set `RECONDO_API_URL` to point elsewhere)

## Option 2: From crates.io (Once Published)

Once Recondo v1 ships publicly, install from crates.io:

```bash
cargo install recondo-tui
recondo-tui
```

Then upgrade to the latest version anytime:

```bash
cargo install --force recondo-tui
```

## Option 3: Prebuilt Binaries

Prebuilt binaries for macOS and Linux are coming soon. This will enable install without a Rust toolchain.

## Next Steps

After installation, see [first-run.md](./first-run.md) for a quick tour of the TUI interface and keybindings.
