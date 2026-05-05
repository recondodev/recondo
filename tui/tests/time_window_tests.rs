use recondo_tui::app::time_window::{days_for_window, parse_window, TimeWindow};

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
