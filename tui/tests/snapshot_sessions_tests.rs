use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::lenses::sessions::{SessionFilter, SessionRow, SessionsLens, SortKey};

fn rows() -> Vec<SessionRow> {
    vec![
        SessionRow {
            id: "ses_a".into(),
            provider: "anthropic".into(),
            project: Some("proj-a".into()),
            started_at: "12:00".into(),
            model: "claude-3-5-sonnet".into(),
            framework: "claude-code".into(),
            turns: 12,
            cost: 1.20,
        },
        SessionRow {
            id: "ses_b".into(),
            provider: "openai".into(),
            project: Some("proj-b".into()),
            started_at: "11:30".into(),
            model: "gpt-4o".into(),
            framework: "cursor".into(),
            turns: 5,
            cost: 0.40,
        },
    ]
}

// ---------- Task 12 ----------

#[test]
fn sort_cycle_advances_then_reverses() {
    let mut lens = SessionsLens::with_rows(rows());
    assert_eq!(lens.sort_key(), SortKey::Recency);
    // Default is descending (newest/highest first) so `sort_descending()` is
    // true; the bool now honestly reflects the sort direction.
    assert!(lens.sort_descending());
    lens.cycle_sort();
    assert_eq!(lens.sort_key(), SortKey::Cost);
    lens.cycle_sort();
    assert_eq!(lens.sort_key(), SortKey::Turns);
    let before = lens.sort_descending();
    lens.cycle_sort_reverse();
    assert_ne!(lens.sort_descending(), before, "Shift+O toggles direction");
}

#[test]
fn sessions_lens_renders_columns() {
    let lens = SessionsLens::with_rows(rows());
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
    assert!(dump.contains("claude-3-5-sonnet"));
    assert!(dump.contains("Sessions"));
}

// ---------- Task 13 ----------

#[test]
fn open_filter_modal_renders_overlay() {
    let mut lens = SessionsLens::with_rows(rows());
    lens.open_filter();
    assert!(lens.filter_open());
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
    assert!(dump.contains("Filter"));
    assert!(dump.contains("Provider"));
    assert!(dump.contains("Model"));
    assert!(dump.contains("Framework"));
    assert!(
        !dump.contains("not yet enforced"),
        "filter modal should not advertise stale phantom wiring"
    );
}

#[test]
fn apply_filter_narrows_rows() {
    let mut lens = SessionsLens::with_rows(rows());
    lens.set_filter(SessionFilter {
        framework: Some("cursor".into()),
        ..Default::default()
    });
    let visible = lens.rows_sorted();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].framework, "cursor");
}

#[test]
fn provider_and_project_filters_narrow_rows() {
    let mut lens = SessionsLens::with_rows(rows());
    lens.set_filter(SessionFilter {
        provider: Some("anthropic".into()),
        project: Some("proj-a".into()),
        ..Default::default()
    });
    let visible = lens.rows_sorted();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].id, "ses_a");
}
