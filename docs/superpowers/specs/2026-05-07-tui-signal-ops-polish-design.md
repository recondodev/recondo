# TUI Signal Ops Polish - Design

**Status:** approved for implementation
**Date:** 2026-05-07

## Goal

Make the Recondo TUI feel more polished, colorful, and engaging while preserving its operational character. The approved direction is **Signal Ops**: a restrained dark terminal UI with cyan and teal accents, clear semantic status colors, stronger selected states, and better scan hierarchy across existing lenses.

This is a visual polish pass for the existing Ratatui surface. It does not add new lenses, navigation behavior, data fetching, animations, or browser-only design effects.

## Design Direction

Signal Ops should feel like a credible daily ops/debugging tool: readable, dense, and intentionally styled. The TUI should avoid theatrical neon treatment, marketing-style branding, oversized headers, or anything that reduces long-session usability.

The palette centers on:

- Cyan for primary focus, active controls, and selected emphasis.
- Teal for secondary accents and successful active states.
- Green, amber, and red for success, warning, and error states.
- Muted blue-gray for secondary labels, hints, inactive borders, and low-priority metadata.
- Dark blue/near-black terminal surfaces for contrast without a flat black default.

## Architecture

Styling should be centralized in `tui/src/ui/theme.rs`. Existing widgets and lenses should consume named theme helpers or constants instead of choosing ad hoc `Style`, `Color`, and `Modifier` values inline.

The theme layer should cover:

- Base colors for background, panel surface, border, muted text, title text, and body text.
- Semantic colors for success, warning, error, info, and accent states.
- Reusable styles for panel blocks, selected table rows, table headers, metric values, modal borders, search input, and help text.
- Helpers where Ratatui APIs make full style objects clearer than raw constants.

The implementation should stay close to the current widget structure. Refactor only enough to prevent style duplication and make the new look consistent.

## Components

The polish pass should update these existing surfaces:

- App chrome: title/header, search bar, loading/error states, and overlay framing.
- Tables: header styling, selected-row styling, muted metadata, and border/title treatment.
- Metric cards: accented titles, stronger values, muted labels, and consistent panel borders.
- Status pills: compact badge-like styling for success, warning, error, running, queued, and unknown states.
- Charts: cyan/teal/amber accents for sparklines and bar charts while preserving snapshot readability.
- Modals and help screens: more deliberate borders, titles, hints, and selected command states.
- Lens-specific panels in realtime, sessions, session detail, turn detail, cost, agents, stubs, and help where they currently create raw Ratatui blocks.

## Data Flow

No data flow changes are expected. The TUI continues to render the same application state and API results; only style construction and rendering attributes change.

## Error Handling

Error and loading states should become visually clearer but retain the same behavior. Error text should use semantic red with a readable panel frame. Loading text should use muted body copy with an accent title or border so it does not look like an unstyled fallback.

## Testing

Testing should be snapshot-driven. Existing TUI snapshots will change intentionally, so the implementation should:

- Run the narrow TUI snapshot/update flow used by the crate.
- Inspect snapshot diffs for unintended layout shifts, truncated text, or inconsistent style output.
- Run the relevant TUI/Rust tests after accepting intentional snapshot updates.

The change is complete when the TUI uses the shared theme consistently, snapshots match the approved Signal Ops direction, and no unrelated code paths are modified.
