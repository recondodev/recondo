use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::app::keymap::KeyAction;
use recondo_tui::app::state::AppState;
use recondo_tui::lenses::realtime::RealtimeSnapshot;
use recondo_tui::ui::draw::draw_app;

// ---------- Task 23 ----------

#[test]
fn draw_realtime_shows_status() {
    let mut s = AppState::new();
    let backend = TestBackend::new(120, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| draw_app(f, &s)).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    // Realtime is the default lens; without a snapshot we expect at least header decoration.
    assert!(dump.contains("OFFLINE") || dump.contains("LIVE") || dump.contains("Live Traffic"));
    // Switching to Help via state should change what we draw.
    s.handle(KeyAction::OpenHelp);
    term.draw(|f| draw_app(f, &s)).unwrap();
    let dump2: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump2.contains("Help"));
}

// ---------- Task 24 ----------

#[test]
fn ui_cache_seeds_realtime_lens() {
    let mut s = AppState::new();
    s.realtime_mut().set_snapshot(RealtimeSnapshot {
        healthy: true,
        active_providers: 1,
        active_sessions: 2,
        user_turns_per_min: 5,
        tokens_last_hour: 1024.0,
        cost_last_hour: 0.42,
        p50_ms: Some(110),
        p99_ms: Some(300),
        sample_count: 12,
        rows: vec![],
    });
    let backend = TestBackend::new(120, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| draw_app(f, &s)).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("LIVE"));
    assert!(dump.contains("$0.42"));
}
