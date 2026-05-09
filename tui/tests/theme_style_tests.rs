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
    let selected = cell_with_symbol(cells, "1");

    assert_eq!(selected.fg, theme::SELECTED_FG);
    assert_eq!(selected.bg, theme::SELECTED_BG);
    assert!(!selected.modifier.contains(Modifier::REVERSED));
}

#[test]
fn status_pill_renders_badge_backgrounds_for_live_and_offline() {
    let backend = TestBackend::new(32, 3);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| {
        f.render_widget(StatusPill { healthy: true }, Rect::new(0, 0, 16, 1));
        f.render_widget(StatusPill { healthy: false }, Rect::new(0, 1, 18, 1));
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
