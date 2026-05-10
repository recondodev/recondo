use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::lenses::session_detail::{SessionDetailLens, TurnRow};

fn turns() -> Vec<TurnRow> {
    (1..=4)
        .map(|i| TurnRow {
            id: format!("trn_{i}"),
            sequence: i,
            model: "claude-3-5-sonnet".into(),
            prompt_tokens: 100 * i,
            completion_tokens: 200 * i,
            cost: 0.05 * i as f64,
            tool_calls: i as i32,
        })
        .collect()
}

#[test]
fn deep_link_selects_turn() {
    let lens = SessionDetailLens::new("ses_a".into(), turns(), Some("trn_3".into()));
    assert_eq!(lens.selected_turn_id(), Some("trn_3"));
}

#[test]
fn renders_turn_ladder() {
    let lens = SessionDetailLens::new("ses_a".into(), turns(), None);
    let backend = TestBackend::new(120, 20);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| lens.draw(f, f.area())).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("ses_a"));
    assert!(dump.contains("trn_1"));
    assert!(dump.contains("Turns"));
}
