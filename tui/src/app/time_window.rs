#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TimeWindow {
    #[default]
    Today,
    Week,
    Month,
    All,
}

pub fn days_for_window(w: TimeWindow) -> i32 {
    match w {
        TimeWindow::Today => 7,
        TimeWindow::Week => 14,
        TimeWindow::Month => 60,
        TimeWindow::All => 90,
    }
}

pub fn parse_window(s: &str) -> Option<TimeWindow> {
    match s.trim().to_ascii_lowercase().as_str() {
        "today" => Some(TimeWindow::Today),
        "week" => Some(TimeWindow::Week),
        "month" => Some(TimeWindow::Month),
        "all" => Some(TimeWindow::All),
        _ => None,
    }
}

/// GraphQL Period enum value (string form expected by the API).
///
/// Must stay in sync with the `Period` enum in `tui/graphql/schema.graphql`.
pub fn period_for_window(w: TimeWindow) -> &'static str {
    match w {
        TimeWindow::Today => "DAY_1",
        TimeWindow::Week => "DAY_7",
        TimeWindow::Month => "DAY_30",
        TimeWindow::All => "DAY_90",
    }
}
