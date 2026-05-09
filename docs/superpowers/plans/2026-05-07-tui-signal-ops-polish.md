# TUI Signal Ops Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved Signal Ops visual direction to the existing Ratatui TUI.

**Architecture:** Centralize the palette and reusable styles in `tui/src/ui/theme.rs`, then update widgets and lens-owned blocks to consume that theme. The change is render-only: it preserves existing app state, polling, key handling, and data flow.

**Tech Stack:** Rust 2021, Ratatui 0.28, Crossterm, existing `recondo-tui` test suite.

---

## File Structure

- Modify `tui/src/ui/theme.rs`: define Signal Ops colors and reusable style/block helpers.
- Modify `tui/src/ui/widgets/{metric_card,table,status_pill,bar_chart,sparkline,modal}.rs`: apply theme helpers to shared widgets.
- Modify `tui/src/ui/draw.rs`: render the base background and style loading/search overlays.
- Modify `tui/src/palette/overlay.rs`: style command palette overlay.
- Modify `tui/src/lenses/{agents,cost,help,realtime,session_detail,sessions,stub,turn_detail}.rs`: replace raw blocks/paragraphs with themed blocks and text styles where lenses own Ratatui widgets directly.
- Add `tui/tests/theme_style_tests.rs`: style-focused regression tests that inspect Ratatui buffer cell colors/modifiers.

## Task 1: Add Rendered Style Contract Tests

**Files:**
- Create: `tui/tests/theme_style_tests.rs`

- [ ] **Step 1: Write the failing tests**

Create `tui/tests/theme_style_tests.rs`:

```rust
use ratatui::{
    backend::TestBackend,
    layout::{Constraint, Rect},
    style::Modifier,
    Terminal,
};
use recondo_tui::ui::{
    theme,
    widgets::{metric_card::MetricCard, status_pill::StatusPill, table::VirtTable},
};

fn cell_with_symbol<'a>(
    cells: &'a [ratatui::buffer::Cell],
    symbol: &str,
) -> &'a ratatui::buffer::Cell {
    cells
        .iter()
        .find(|cell| cell.symbol() == symbol)
        .unwrap_or_else(|| panic!("missing cell symbol {symbol:?}"))
}

#[test]
fn metric_card_uses_signal_ops_value_and_muted_subtitle_styles() {
    let backend = TestBackend::new(28, 5);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| {
        f.render_widget(
            MetricCard::new("Active", "42", Some("3 providers")),
            Rect::new(0, 0, 28, 5),
        );
    })
    .unwrap();

    let cells = &term.backend().buffer().content;
    let value = cell_with_symbol(cells, "4");
    let subtitle = cell_with_symbol(cells, "3");

    assert_eq!(value.fg, theme::ACCENT);
    assert!(value.modifier.contains(Modifier::BOLD));
    assert_eq!(subtitle.fg, theme::MUTED);
}

#[test]
fn table_selected_row_uses_accent_background_without_reverse_video() {
    let backend = TestBackend::new(40, 8);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| {
        f.render_widget(
            VirtTable {
                headers: vec!["ID", "Status"],
                widths: vec![Constraint::Length(10), Constraint::Length(10)],
                rows: vec![
                    vec!["s1".to_string(), "running".to_string()],
                    vec!["s2".to_string(), "queued".to_string()],
                ],
                selected: 0,
                title: "Sessions",
            },
            Rect::new(0, 0, 40, 8),
        );
    })
    .unwrap();

    let cells = &term.backend().buffer().content;
    let selected = cell_with_symbol(cells, "s");

    assert_eq!(selected.fg, theme::SELECTED_FG);
    assert_eq!(selected.bg, theme::SELECTED_BG);
    assert!(!selected.modifier.contains(Modifier::REVERSED));
}

#[test]
fn status_pill_renders_badge_backgrounds_for_live_and_offline() {
    let backend = TestBackend::new(32, 3);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| {
        f.render_widget(
            StatusPill {
                healthy: true,
                port: 8443,
            },
            Rect::new(0, 0, 16, 1),
        );
        f.render_widget(
            StatusPill {
                healthy: false,
                port: 9443,
            },
            Rect::new(0, 1, 18, 1),
        );
    })
    .unwrap();

    let cells = &term.backend().buffer().content;
    let live = cell_with_symbol(cells, "L");
    let offline = cell_with_symbol(cells, "O");

    assert_eq!(live.fg, theme::OK);
    assert_eq!(live.bg, theme::OK_BG);
    assert_eq!(offline.fg, theme::ERR);
    assert_eq!(offline.bg, theme::ERR_BG);
}
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cargo test -p recondo-tui --test theme_style_tests`

Expected: FAIL because `theme::SELECTED_FG`, `theme::SELECTED_BG`, `theme::OK_BG`, and `theme::ERR_BG` are not defined yet, or because existing widgets do not apply the styles.

## Task 2: Implement Theme Primitives and Shared Widget Styling

**Files:**
- Modify: `tui/src/ui/theme.rs`
- Modify: `tui/src/ui/widgets/metric_card.rs`
- Modify: `tui/src/ui/widgets/table.rs`
- Modify: `tui/src/ui/widgets/status_pill.rs`
- Modify: `tui/src/ui/widgets/bar_chart.rs`
- Modify: `tui/src/ui/widgets/sparkline.rs`
- Modify: `tui/src/ui/widgets/modal.rs`

- [ ] **Step 1: Replace the minimal palette with Signal Ops styles**

In `tui/src/ui/theme.rs`, define RGB constants for text, background, borders, accent colors, semantic colors, selected row colors, and badge backgrounds. Add helpers named `app_style`, `body_style`, `muted_style`, `title_style`, `panel_block`, `elevated_block`, `table_header_style`, `selected_row_style`, `metric_value_style`, `status_badge_style`, and `chart_style`.

- [ ] **Step 2: Apply the theme to shared widgets**

Update the six widget files so:

- `MetricCard` uses `theme::panel_block`, accent bold value text, and muted subtitle text.
- `VirtTable` uses a themed block, cyan/teal bold headers, normal body text, and selected-row background styling without `Modifier::REVERSED`.
- `StatusPill` renders live/offline as badge-style spans using semantic foreground and background colors.
- `HBarChart` styles labels as muted, values as body text, and bar glyphs with `theme::ACCENT_2`.
- `DailySpark` uses `theme::panel_block` and `theme::chart_style`.
- `Modal` uses `theme::elevated_block` and body text style.

- [ ] **Step 3: Run the focused style test**

Run: `cargo test -p recondo-tui --test theme_style_tests`

Expected: PASS with all three style contract tests green.

## Task 3: Apply Themed Blocks to Lens-Owned UI

**Files:**
- Modify: `tui/src/ui/draw.rs`
- Modify: `tui/src/palette/overlay.rs`
- Modify: `tui/src/lenses/agents.rs`
- Modify: `tui/src/lenses/cost.rs`
- Modify: `tui/src/lenses/help.rs`
- Modify: `tui/src/lenses/realtime.rs`
- Modify: `tui/src/lenses/session_detail.rs`
- Modify: `tui/src/lenses/sessions.rs`
- Modify: `tui/src/lenses/stub.rs`
- Modify: `tui/src/lenses/turn_detail.rs`

- [ ] **Step 1: Replace raw blocks and plain paragraphs**

Use `theme::panel_block` for normal panels, `theme::elevated_block` for overlays, `theme::body_style` for ordinary body text, `theme::muted_style` for hints, and `theme::app_style` to paint the base frame in `draw_app`.

- [ ] **Step 2: Preserve all displayed text and layout constraints**

Do not change lens data, key handling, sort/filter behavior, table columns, or layout row heights except where a style call requires a local import update.

- [ ] **Step 3: Run existing render/snapshot-oriented tests**

Run:

```bash
cargo test -p recondo-tui \
  --test snapshot_realtime_tests \
  --test snapshot_sessions_tests \
  --test snapshot_cost_tests \
  --test snapshot_agents_tests \
  --test snapshot_session_detail_tests \
  --test snapshot_stub_tests \
  --test snapshot_palette_tests \
  --test draw_dispatch_tests
```

Expected: PASS. These tests assert rendered content rather than exact style snapshots, so they should remain stable after the visual style pass.

## Task 4: Final Verification

**Files:**
- Verify all changed TUI files.

- [ ] **Step 1: Format**

Run: `cargo fmt -p recondo-tui -- --check`

Expected: PASS.

- [ ] **Step 2: Run the TUI crate tests**

Run: `cargo test -p recondo-tui`

Expected: PASS.

- [ ] **Step 3: Run clippy for the TUI crate**

Run: `cargo clippy -p recondo-tui -- -D warnings`

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff -- tui docs/superpowers/plans/2026-05-07-tui-signal-ops-polish.md`

Expected: The diff is limited to the plan and TUI visual styling changes. Existing unrelated workspace changes, such as `justfile`, remain untouched.
