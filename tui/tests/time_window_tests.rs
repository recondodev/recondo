use recondo_tui::app::time_window::{days_for_window, parse_window, period_for_window, TimeWindow};

#[test]
fn days_for_window_matches_spec() {
    assert_eq!(days_for_window(TimeWindow::Today), 7);
    assert_eq!(days_for_window(TimeWindow::Week), 14);
    assert_eq!(days_for_window(TimeWindow::Month), 60);
    assert_eq!(days_for_window(TimeWindow::All), 90);
}

#[test]
fn parse_window_recognizes_keywords() {
    assert_eq!(parse_window("today"), Some(TimeWindow::Today));
    assert_eq!(parse_window("week"), Some(TimeWindow::Week));
    assert_eq!(parse_window("month"), Some(TimeWindow::Month));
    assert_eq!(parse_window("all"), Some(TimeWindow::All));
    assert_eq!(parse_window("nonsense"), None);
}

#[test]
fn period_for_window_returns_schema_period_variants() {
    // The strings here must be exactly the variants of the GraphQL `Period`
    // enum at `tui/graphql/schema.graphql`. If those change, update both.
    assert_eq!(period_for_window(TimeWindow::Today), "DAY_1");
    assert_eq!(period_for_window(TimeWindow::Week), "DAY_7");
    assert_eq!(period_for_window(TimeWindow::Month), "DAY_30");
    assert_eq!(period_for_window(TimeWindow::All), "DAY_90");
}
