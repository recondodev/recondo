//! Deliverable pipeline tests for Chunk 6 (search).

use recondo_tui::app::keymap::{KeyAction, Mode};
use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::state::AppState;
use recondo_tui::lenses::cost::BreakdownRow;
use recondo_tui::lenses::sessions::SessionRow;

fn mixed_sessions() -> Vec<SessionRow> {
    vec![
        SessionRow {
            id: "ses_a".into(),
            started_at: "12:00".into(),
            model: "claude-3-5-sonnet".into(),
            framework: "claude-code".into(),
            turns: 12,
            cost: 1.20,
        },
        SessionRow {
            id: "ses_b".into(),
            started_at: "11:30".into(),
            model: "gpt-4o".into(),
            framework: "cursor".into(),
            turns: 5,
            cost: 0.40,
        },
        SessionRow {
            id: "ses_c".into(),
            started_at: "10:00".into(),
            model: "claude-3-haiku".into(),
            framework: "codex".into(),
            turns: 8,
            cost: 0.80,
        },
    ]
}

// ---------- D-Q1, D-Q2, D-Q4 ----------

#[test]
fn slash_enters_search_mode() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSearch);
    assert_eq!(s.mode(), Mode::Search);
}

#[test]
fn search_input_accumulates_in_state_search_buf() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSearch);
    for c in "cla".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    assert_eq!(s.search(), "cla");
}

#[test]
fn search_backspace_removes_last_char() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSearch);
    for c in "cla".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    s.handle(KeyAction::Backspace);
    assert_eq!(s.search(), "cl");
}

#[test]
fn esc_in_search_clears_buffer_and_returns_to_normal_without_applying() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(mixed_sessions()));
    s.handle(KeyAction::OpenSearch);
    for c in "cla".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    s.handle(KeyAction::CloseSearch);
    assert_eq!(s.mode(), Mode::Normal);
    assert!(s.search().is_empty());
    // Filter NOT applied — all 3 rows still visible.
    let visible = s.sessions().rows_sorted();
    assert_eq!(visible.len(), 3, "Esc must NOT apply the filter");
}

// ---------- D-Q3, D-Q5: Submit applies filter to Sessions ----------

#[test]
fn submit_in_search_applies_filter_to_sessions_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(mixed_sessions()));
    s.handle(KeyAction::OpenSearch);
    for c in "cl".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    s.handle(KeyAction::Submit);
    assert_eq!(s.mode(), Mode::Normal, "Submit returns to Normal mode");

    let visible = s.sessions().rows_sorted();
    // "cl" should match claude-3-5-sonnet (ses_a) and claude-3-haiku (ses_c)
    // and NOT gpt-4o (ses_b)
    assert!(visible.iter().any(|r| r.id == "ses_a"));
    assert!(visible.iter().any(|r| r.id == "ses_c"));
    assert!(
        !visible.iter().any(|r| r.id == "ses_b"),
        "ses_b (gpt-4o) should be filtered out by fuzzy 'cl'"
    );
}

// ---------- D-Q3, D-Q5: Submit applies filter to Cost ----------

#[test]
fn submit_in_search_applies_filter_to_cost_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.apply_update(LensUpdate::CostBreakdown(vec![
        BreakdownRow {
            key: "anthropic".into(),
            label: "Anthropic".into(),
            cost: 8.0,
            sessions: 14,
        },
        BreakdownRow {
            key: "openai".into(),
            label: "OpenAI".into(),
            cost: 3.0,
            sessions: 6,
        },
        BreakdownRow {
            key: "google".into(),
            label: "Google".into(),
            cost: 1.0,
            sessions: 2,
        },
    ]));
    s.handle(KeyAction::OpenSearch);
    for c in "ant".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    s.handle(KeyAction::Submit);

    // After submit, only Anthropic remains.
    let visible = s.cost().visible_breakdown();
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].label, "Anthropic");
}

// ---------- D-Q3: Empty needle clears the filter ----------

#[test]
fn submit_with_empty_search_clears_active_filter() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(mixed_sessions()));

    // First apply a filter.
    s.handle(KeyAction::OpenSearch);
    for c in "cl".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    s.handle(KeyAction::Submit);
    assert_eq!(s.sessions().rows_sorted().len(), 2, "filter applied");

    // Now submit with empty buffer.
    s.handle(KeyAction::OpenSearch);
    s.handle(KeyAction::Submit);
    assert_eq!(
        s.sessions().rows_sorted().len(),
        3,
        "empty submit clears filter"
    );
}

// ---------- D-Q5: Each list lens has set_search_filter ----------

#[test]
fn search_filter_persists_across_polled_data_refreshes() {
    // When data refreshes (apply_update), the active search filter survives —
    // it doesn't get reset by set_rows.
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(mixed_sessions()));
    s.handle(KeyAction::OpenSearch);
    for c in "cl".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    s.handle(KeyAction::Submit);

    // Simulate a polling refresh.
    s.apply_update(LensUpdate::Sessions(mixed_sessions()));
    let visible = s.sessions().rows_sorted();
    assert_eq!(
        visible.len(),
        2,
        "filter should still apply after polled refresh"
    );
}

// ---------- D-Q3: Search applies to Realtime feed too ----------

#[test]
fn submit_in_search_applies_filter_to_realtime_feed() {
    use recondo_tui::lenses::realtime::FeedRow;
    let mut s = AppState::new();
    // Default lens is Realtime.
    s.realtime_mut().set_rows(vec![
        FeedRow {
            time: "12:00".into(),
            provider: "anthropic".into(),
            model: "claude-3-5".into(),
            agent: "claude-code".into(),
            tokens: 100,
            cost: 0.10,
            status: 200,
        },
        FeedRow {
            time: "12:01".into(),
            provider: "openai".into(),
            model: "gpt-4".into(),
            agent: "cursor".into(),
            tokens: 200,
            cost: 0.20,
            status: 200,
        },
    ]);
    s.handle(KeyAction::OpenSearch);
    for c in "cl".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    s.handle(KeyAction::Submit);

    let visible = s.realtime().visible_rows();
    assert_eq!(visible.len(), 1, "search 'cl' filters out openai/gpt-4 row");
    assert_eq!(visible[0].provider, "anthropic");
}
