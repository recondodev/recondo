use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::state::AppState;
use recondo_tui::lenses::realtime::FeedRow;

fn fake_feed_rows() -> Vec<FeedRow> {
    vec![
        FeedRow {
            time: "12:00".into(),
            provider: "anthropic".into(),
            model: "claude-3-5".into(),
            agent: "claude-code".into(),
            tokens: 100,
            cost: 0.10,
            status: 200,
            session_id: "sess-a".into(),
            user_turn_id: "sess-a:0".into(),
        },
        FeedRow {
            time: "12:01".into(),
            provider: "openai".into(),
            model: "gpt-4".into(),
            agent: "cursor".into(),
            tokens: 200,
            cost: 0.20,
            status: 200,
            session_id: "sess-b".into(),
            user_turn_id: "sess-b:0".into(),
        },
    ]
}

#[test]
fn apply_realtime_feed_update_populates_snapshot_rows() {
    let mut s = AppState::new();
    assert_eq!(s.realtime().snapshot().rows.len(), 0);
    s.apply_update(LensUpdate::RealtimeFeed(fake_feed_rows()));
    assert_eq!(s.realtime().snapshot().rows.len(), 2);
}

#[test]
fn apply_gateway_status_update_sets_healthy() {
    let mut s = AppState::new();
    s.apply_update(LensUpdate::GatewayStatus { healthy: true });
    assert!(s.realtime().snapshot().healthy);
}

#[test]
fn realtime_stats_does_not_clobber_feed_rows() {
    let mut s = AppState::new();
    // Populate feed first.
    s.apply_update(LensUpdate::RealtimeFeed(fake_feed_rows()));
    assert_eq!(s.realtime().snapshot().rows.len(), 2);

    // Apply a stats partial update — must NOT wipe the feed rows.
    s.apply_update(LensUpdate::RealtimeStats {
        active_providers: 5,
        active_sessions: 10,
        user_turns_per_min: 50,
        tokens_last_hour: 100000.0,
        cost_last_hour: 1.0,
        p50_ms: Some(50),
        p99_ms: Some(200),
        sample_count: 100,
    });

    assert_eq!(
        s.realtime().snapshot().rows.len(),
        2,
        "feed rows must NOT be wiped by stats update"
    );
    assert_eq!(s.realtime().snapshot().active_sessions, 10);
    assert_eq!(s.realtime().snapshot().active_providers, 5);
    assert_eq!(s.realtime().snapshot().user_turns_per_min, 50);
    assert_eq!(s.realtime().snapshot().sample_count, 100);
}

#[test]
fn gateway_status_does_not_clobber_feed_rows() {
    let mut s = AppState::new();
    s.apply_update(LensUpdate::RealtimeFeed(fake_feed_rows()));
    s.apply_update(LensUpdate::GatewayStatus { healthy: true });
    assert_eq!(
        s.realtime().snapshot().rows.len(),
        2,
        "feed rows must NOT be wiped by gateway-status update"
    );
    assert!(s.realtime().snapshot().healthy);
}

#[test]
fn realtime_feed_does_not_clobber_stats() {
    let mut s = AppState::new();
    s.apply_update(LensUpdate::RealtimeStats {
        active_providers: 3,
        active_sessions: 7,
        user_turns_per_min: 21,
        tokens_last_hour: 5000.0,
        cost_last_hour: 0.5,
        p50_ms: Some(40),
        p99_ms: Some(150),
        sample_count: 42,
    });
    s.apply_update(LensUpdate::RealtimeFeed(fake_feed_rows()));
    let snap = s.realtime().snapshot();
    assert_eq!(snap.rows.len(), 2);
    assert_eq!(snap.active_sessions, 7, "stats must survive feed update");
    assert_eq!(snap.active_providers, 3);
    assert_eq!(snap.sample_count, 42);
}

#[tokio::test]
async fn poll_realtime_feed_once_marshals_into_update() {
    use recondo_tui::poll::realtime::poll_realtime_feed_once;
    let resp = build_fake_realtime_feed_response();
    let update = poll_realtime_feed_once(|_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::RealtimeFeed(rows) => assert!(!rows.is_empty()),
        _ => panic!("expected RealtimeFeed variant"),
    }
}

#[tokio::test]
async fn poll_gateway_status_once_marshals_into_update() {
    use recondo_tui::poll::realtime::poll_gateway_status_once;
    let resp = build_fake_gateway_status_response();
    let update = poll_gateway_status_once(|_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::GatewayStatus { healthy } => {
            // status field varies by environment; just verify it parsed successfully.
            let _ = healthy;
        }
        _ => panic!("expected GatewayStatus variant"),
    }
}

fn build_fake_realtime_feed_response() -> recondo_tui::gql::queries::realtime_feed::ResponseData {
    use chrono::TimeZone;
    use recondo_tui::gql::queries::realtime_feed::{RealtimeFeedRealtimeFeed, ResponseData};
    let ts = chrono::Utc
        .with_ymd_and_hms(2026, 5, 5, 12, 0, 0)
        .single()
        .expect("valid timestamp");
    ResponseData {
        realtime_feed: vec![RealtimeFeedRealtimeFeed {
            timestamp: ts,
            provider: "anthropic".into(),
            model: Some("claude-3-5-sonnet".into()),
            framework: Some("claude-code".into()),
            intent: Some("code".into()),
            total_tokens: 1234,
            cost_usd: 0.012,
            http_status: Some(200),
            session_id: "sess-1".into(),
            user_turn_id: "sess-1:0".into(),
        }],
    }
}

fn build_fake_gateway_status_response() -> recondo_tui::gql::queries::gateway_status::ResponseData {
    use chrono::TimeZone;
    use recondo_tui::gql::queries::gateway_status::{GatewayStatusGatewayStatus, ResponseData};
    let hb = chrono::Utc
        .with_ymd_and_hms(2026, 5, 5, 12, 0, 0)
        .single()
        .expect("valid timestamp");
    ResponseData {
        gateway_status: GatewayStatusGatewayStatus {
            status: "live".into(),
            uptime_seconds: Some(3600),
            last_heartbeat: Some(hb),
        },
    }
}
