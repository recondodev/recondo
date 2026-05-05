use recondo_tui::search::fuzzy::{fuzzy_filter, fuzzy_match};

#[test]
fn match_returns_score_for_subsequences() {
    assert!(fuzzy_match("ssn", "sessions").is_some());
    assert!(fuzzy_match("cl3", "claude-3-5-sonnet").is_some());
    assert!(fuzzy_match("xyz", "claude").is_none());
}

#[test]
fn empty_needle_matches_everything() {
    assert_eq!(fuzzy_match("", "anything"), Some(0));
}

#[test]
fn filter_orders_by_score() {
    let items = vec!["sessions", "session_id", "ses_zzz"];
    let out = fuzzy_filter("ses", &items);
    assert_eq!(out[0], "ses_zzz"); // exact prefix scores highest
    assert!(out.contains(&"sessions"));
}
