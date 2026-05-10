use chrono::{Duration, Utc};
use recondo_tui::format::{format_compact_count, format_cost, format_time_ago};

#[test]
fn cost_uses_dollar_with_two_decimals() {
    assert_eq!(format_cost(0.0), "$0.00");
    assert_eq!(format_cost(1.234), "$1.23");
    assert_eq!(format_cost(1234.5), "$1234.50");
}

#[test]
fn compact_count_uses_kmg() {
    assert_eq!(format_compact_count(999.0), "999");
    assert_eq!(format_compact_count(1_500.0), "1.5K");
    assert_eq!(format_compact_count(2_000_000.0), "2.0M");
    assert_eq!(format_compact_count(1_500_000_000.0), "1.5B");
}

#[test]
fn time_ago_short_form() {
    let t = Utc::now() - Duration::seconds(45);
    assert_eq!(format_time_ago(t), "45s");
    let t = Utc::now() - Duration::minutes(3);
    assert_eq!(format_time_ago(t), "3m");
    let t = Utc::now() - Duration::hours(2);
    assert_eq!(format_time_ago(t), "2h");
}
