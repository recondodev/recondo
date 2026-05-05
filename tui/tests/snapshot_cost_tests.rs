use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::app::selection::{GroupKey, SelectionRegistry};
use recondo_tui::lenses::cost::{drill_target, BreakdownRow, CostLens, GroupBy};

fn rows() -> Vec<BreakdownRow> {
    vec![
        BreakdownRow {
            key: "anthropic".into(),
            label: "Anthropic".into(),
            cost: 8.20,
            sessions: 14,
        },
        BreakdownRow {
            key: "openai".into(),
            label: "OpenAI".into(),
            cost: 3.10,
            sessions: 6,
        },
    ]
}

// ---------- Task 15 ----------

#[test]
fn group_by_cycles() {
    let mut lens = CostLens::new();
    assert_eq!(lens.group_by(), GroupBy::Provider);
    lens.cycle_group_by();
    assert_eq!(lens.group_by(), GroupBy::Model);
    lens.cycle_group_by();
    assert_eq!(lens.group_by(), GroupBy::Framework);
    lens.cycle_group_by();
    assert_eq!(lens.group_by(), GroupBy::Provider);
}

#[test]
fn renders_breakdown_and_sparkline() {
    let mut lens = CostLens::new();
    lens.set_total(11.30, Some(0.42));
    lens.set_breakdown(rows());
    lens.set_daily(vec![1.0, 2.0, 3.0, 1.5, 2.5, 4.0, 3.0]);
    let backend = TestBackend::new(120, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| lens.draw(f, f.area())).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("$11.30"));
    assert!(dump.contains("Anthropic"));
    assert!(dump.contains("$8.20"));
    assert!(dump.contains("Daily Spend"));
}

// ---------- Task 16 ----------

#[test]
fn drill_writes_group_key_to_selection() {
    let mut lens = CostLens::new();
    lens.set_breakdown(rows());
    let mut sel = SelectionRegistry::default();
    drill_target(&lens, &mut sel);
    assert_eq!(sel.group(), Some(&GroupKey::Provider("anthropic".into())));
    lens.cycle_group_by(); // Model
    drill_target(&lens, &mut sel);
    assert_eq!(sel.group(), Some(&GroupKey::Model("anthropic".into())));
}
