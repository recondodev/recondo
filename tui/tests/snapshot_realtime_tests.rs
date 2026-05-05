use ratatui::{backend::TestBackend, layout::Rect, Terminal};
use recondo_tui::lenses::realtime::{FeedRow, RealtimeLens, RealtimeSnapshot};
use recondo_tui::ui::widgets::metric_card::MetricCard;

// ---------- Task 8 ----------

#[test]
fn metric_card_renders_label_and_value() {
    let backend = TestBackend::new(20, 5);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| {
        let card = MetricCard::new("Active", "42", Some("3 providers"));
        f.render_widget(card, Rect::new(0, 0, 20, 5));
    })
    .unwrap();
    let buf = term.backend().buffer().clone();
    let dump = buf.content.iter().map(|c| c.symbol()).collect::<String>();
    assert!(dump.contains("Active"), "label not rendered: {dump}");
    assert!(dump.contains("42"), "value not rendered: {dump}");
    assert!(
        dump.contains("3 providers"),
        "subtitle not rendered: {dump}"
    );
}

// ---------- Task 9 ----------

fn fixture() -> RealtimeSnapshot {
    RealtimeSnapshot {
        healthy: true,
        port: 8443,
        active_providers: 3,
        active_sessions: 4,
        user_turns_per_min: 12,
        tokens_last_hour: 250_000.0,
        cost_last_hour: 1.42,
        p50_ms: Some(120),
        p99_ms: Some(420),
        sample_count: 88,
        rows: vec![],
    }
}

#[test]
fn realtime_lens_renders_metrics_and_status() {
    let backend = TestBackend::new(120, 30);
    let mut term = Terminal::new(backend).unwrap();
    let lens = RealtimeLens::with_snapshot(fixture());
    term.draw(|f| lens.draw(f, f.area())).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("LIVE"));
    assert!(dump.contains("8443"));
    assert!(dump.contains("12")); // user turns
    assert!(dump.contains("$1.42")); // cost last hour
    assert!(dump.contains("250.0K")); // tokens last hour
}

// ---------- Task 10 ----------

#[test]
fn realtime_lens_renders_feed_rows_and_filter_cycle() {
    let mut snap = fixture();
    snap.rows = (0..3)
        .map(|i| FeedRow {
            time: format!("12:0{i}"),
            provider: "anthropic".into(),
            model: "claude-3-5-sonnet".into(),
            agent: "claude-code".into(),
            tokens: 1234 * (i + 1) as i64,
            cost: 0.10 * (i + 1) as f64,
            status: 200,
        })
        .collect();

    let mut lens = RealtimeLens::with_snapshot(snap);
    lens.cycle_provider_filter();
    assert_eq!(lens.provider_filter.as_deref(), Some("anthropic"));
    lens.cycle_provider_filter();
    assert_eq!(lens.provider_filter.as_deref(), Some("openai"));

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
    assert!(dump.contains("12:00"));
    assert!(dump.contains("claude-3-5-sonnet"));
    assert!(dump.contains("filter: openai"));
}
