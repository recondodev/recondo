# Recondo TUI — Complete Keybindings

The Recondo TUI uses k9s-style vim navigation with a command palette and lens-specific shortcuts. Below is the complete keybinding reference.

## Global Keybindings

These work in any lens:

| Key | Action | Notes |
|-----|--------|-------|
| `:` | Command palette | Navigate to lenses, set time windows, run commands. Type `:realtime`, `:sessions`, `:cost`, `:agents`, `:today`, `:week`, etc. Escape closes the palette. |
| `/` | Fuzzy search | Search within the current view. Escape closes the search. |
| `?` | Help overlay | Shows this keybinding table. |
| `q` | Quit | Only works outside the command palette. Inside the palette, use `Esc`. |
| `Esc` | Exit mode | Close overlays, search, or the command palette. Return to the main lens. |
| `Enter` | Drill in / Open selection | Open the selected row (e.g., a session in the sessions lens opens that session's detail view). |
| `j` / `k` | Move cursor down / up | Navigate rows in lists and tables. |
| `gg` / `G` | Jump to top / bottom | `gg` goes to the first row; `G` jumps to the last row. |
| `H` / `L` | Browser-style history back / forward | Navigate through previously visited lenses. |
| `Tab` / `Shift-Tab` | Cycle focus between panels | For lenses with multiple panels (e.g., realtime header ↔ traffic feed, cost breakdown ↔ sparkline), cycle focus. Single-panel lenses ignore this. |

## Lens Navigation

Open a lens directly by pressing the key. These are shortcuts to the command palette equivalents.

| Key | Lens | What It Shows | Command Equiv. |
|-----|------|---------------|----------------|
| `d` | Realtime Monitor | Live metrics, traffic table, gateway status. (Default landing page.) | `:realtime` |
| `s` | Sessions | List of all captured sessions with metadata (model, framework, cost, turn count). | `:sessions` |
| `c` | Cost & Usage | Total spend, breakdown by provider/model/framework, daily sparkline. | `:cost` |
| `a` | Agent Analytics | Agent summary metrics, framework distribution, top developers, top repositories. | `:agents` |
| `A` | Audit Trail | (v1.5) Audit log of API/MCP calls and governance changes. Opens a stub in v1 directing to the web dashboard. | `:audit` |
| `r` | Replay / Diff | (v1.5) Compare two turns side-by-side. Opens a stub in v1. | `:replay` |

## Filtering and Sorting

| Key | Action | Lens-Specific Behavior |
|-----|--------|------------------------|
| `f` | Apply filter | **Realtime Monitor:** Cycles provider filter (All → Anthropic → OpenAI → Gemini → All). **Sessions, Cost, Agents:** Opens a multi-dimensional filter modal (provider, model, framework, project, time range). |
| `o` | Sort forward | Cycles through valid sort keys for the current lens. Default sort (descending) for each lens is shown below. |
| `O` (Shift-O) | Sort reverse | Reverses the current sort direction. |
| `g` | Group-by cycle | (Cost lens only) Cycles grouping: provider → model → framework → provider. No-op in other lenses. |

### Realtime Monitor (`d`) Lens-Specific

- **Filter (`f`):** Fixed-value cycle through providers. No modal.
- **Sort (`o`):** Not applicable (the live table is chronologically sorted, newest first).
- **Focus (`Tab`):** Cycle between header pills and the traffic table.

### Sessions (`s`) Lens-Specific

- **Filter (`f`):** Opens a modal with dimensions: provider, model, framework, project, time range.
- **Sort (`o`):** Cycles through sort keys: recency → cost → turn count → model → framework → recency (default: descending, recent first).
- **Drill (`Enter` on a row):** Opens the session detail view with a list of turns. Within that detail, `Enter` on a turn shows the full prompt, response, and tool calls.

### Cost (`c`) Lens-Specific

- **Filter (`f`):** Opens a modal for time-range and project filters (provider/model/framework filters affect the grouped breakdown).
- **Sort (`o`):** Cycles sort keys within the breakdown table (most relevant to least).
- **Group-by (`g`):** Cycles grouping: provider → model → framework → provider.
- **Focus (`Tab`):** Cycle between the breakdown panel and the daily sparkline.
- **Drill (`Enter` on a row):** Scope the Sessions lens to that group. For example, "Enter" on "Anthropic: $85.20" jumps to sessions that contributed to Anthropic's spend.

### Agent Analytics (`a`) Lens-Specific

- **Filter (`f`):** Opens a modal to override the time period (today, week, month, all-time).
- **Sort (`o`):** Cycles sort keys in the top-developers and top-repositories tables.
- **No group-by (`g`):** This lens doesn't have a group-by feature.

## Time Windows

Time windows are set via the command palette (no numeric keys to avoid collisions with pinned tabs `1`–`9`). They persist across lens switches.

| Command | Scope |
|---------|-------|
| `:today` | Midnight to now (local time) |
| `:week` | Last 7 days from now |
| `:month` | Last 30 days from now |
| `:all` | All-time (no filter) |
| `:since <YYYY-MM-DD>` | From that date to now (e.g., `:since 2026-04-01`) |
| `:between <YYYY-MM-DD> <YYYY-MM-DD>` | From date1 to date2 inclusive (e.g., `:between 2026-04-01 2026-04-15`) |

## Pinned Tabs and Selection

| Key | Action | Notes |
|-----|--------|-------|
| `*` | Pin current view as a tab | Bookmarks the current lens and time window. You can pin up to 9 tabs. |
| `1`–`9` | Jump to pinned tab N | Quickly switch to a pre-saved lens / time-window combination. |
| *Selection follows* | Cross-lens selection registry | Highlight a session in `s`, switch to `c` (cost), and the cost lens scopes to that session. Switch back to `s` — the selection is preserved. |

### Example Workflow

```
1. Press 's' to open Sessions lens
2. Navigate to a session with 'j'/'k'
3. Press '*' to pin this view as tab 1
4. Press 'c' to open Cost lens (selection follows — cost now scoped to that session)
5. Press '1' to jump back to the pinned sessions view
6. Selection is still on the same session
```

## Command Palette Syntax

The command palette (`:`) accepts a mix of navigation commands and flags:

```
:realtime        # Jump to realtime lens
:sessions
:cost
:agents
:audit
:today           # Set time window to today
:week
:month
:all
:pin             # Pin current view
:help            # Show help
:search term     # Open fuzzy search with initial term
```

Press `Esc` to close the palette without executing.

## Common Multi-Key Sequences

| Sequence | Action |
|----------|--------|
| `gg` | Jump to top of list |
| `G` | Jump to bottom of list |
| `H` | Go back to previous lens |
| `L` | Go forward to next lens |

(Note: `gg` is two presses of `g`, not one chord. The TUI detects the sequence as you type.)

## Exit Modes

There are multiple ways to exit the TUI:

- **From any lens:** Press `q`
- **From the command palette:** Press `Esc` (does not quit; returns to the lens) or type `:q`
- **From an overlay (help, modal, etc.):** Press `Esc` or `q`

## Tips

- **Muscle memory:** If you use vim or k9s, navigation will feel familiar. `j/k` for up/down, `/` for search, `:` for commands.
- **Quick switches:** `d` → `s` → `c` → `a` cycle through the main lenses. Use `H` to undo.
- **Time windows persist:** Set `:week` once; all subsequent lens switches stay in the week view until you change it with `:today`, `:month`, etc.
- **Selection isolation:** Each lens maintains its own cursor position, but *selection* (highlighted session, highlighted cost row) is shared. This means pinning a view and returning to it doesn't reset your position.
