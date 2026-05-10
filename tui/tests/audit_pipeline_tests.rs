use chrono::TimeZone;
use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::app::keymap::KeyAction;
use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::state::AppState;
use recondo_tui::app::time_window::TimeWindow;
use recondo_tui::lenses::audit::{AuditRow, AuditType};
use recondo_tui::ui::draw::draw_app;

fn fake_audit_rows() -> Vec<AuditRow> {
    vec![AuditRow {
        time: "12:00:00".into(),
        session_id: "sess-abcdef012345".into(),
        sequence_num: 7,
        provider: "anthropic".into(),
        model: Some("claude-sonnet-4".into()),
        request_hash: Some("reqhashabcdef".into()),
        response_hash: Some("resphashabcdef".into()),
        tokens: 1234,
        integrity: "verified".into(),
        http_status: Some(200),
        capture_complete: true,
    }]
}

#[test]
fn apply_audit_trail_update_populates_rows_and_total() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAudit);
    s.apply_update(LensUpdate::AuditTrail {
        rows: fake_audit_rows(),
        total: 42,
    });
    assert_eq!(s.audit().rows().len(), 1);
    assert_eq!(s.audit().total(), 42);
    assert_eq!(s.audit().rows()[0].session_id, "sess-abcdef012345");
}

#[test]
fn audit_query_vars_follow_active_lens_search_type_and_window() {
    let mut s = AppState::new();
    assert!(s.audit_query_vars().is_none());

    s.handle(KeyAction::OpenAudit);
    s.handle(KeyAction::CycleFilter);
    s.handle(KeyAction::OpenSearch);
    for c in "anthropic".chars() {
        s.handle(KeyAction::SearchInput(c));
    }
    s.handle(KeyAction::Submit);
    s.handle(KeyAction::OpenPalette);
    for c in "week".chars() {
        s.handle(KeyAction::PaletteInput(c));
    }
    s.handle(KeyAction::Submit);

    let vars = s.audit_query_vars().expect("audit lens should poll");
    assert_eq!(vars.type_filter, AuditType::Requests);
    assert_eq!(vars.search.as_deref(), Some("anthropic"));
    assert_eq!(vars.period, TimeWindow::Week);
}

#[test]
fn audit_render_after_polling_shows_live_rows() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAudit);
    s.apply_update(LensUpdate::AuditTrail {
        rows: fake_audit_rows(),
        total: 42,
    });

    let backend = TestBackend::new(140, 24);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| draw_app(f, &s)).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("Audit Trail"), "{dump}");
    assert!(dump.contains("claude-sonnet-4"), "{dump}");
    assert!(dump.contains("verified"), "{dump}");
    assert!(dump.contains("sess-abc"), "{dump}");
}

#[tokio::test]
async fn poll_audit_trail_once_marshals_dashboard_query_shape() {
    use recondo_tui::app::state::AuditQueryVars;
    use recondo_tui::poll::audit::poll_audit_trail_once;
    let vars = AuditQueryVars {
        search: Some("anthropic".into()),
        type_filter: AuditType::Requests,
        period: TimeWindow::Today,
        limit: 20,
        offset: 0,
    };
    let resp = build_fake_audit_trail_response();
    let update = poll_audit_trail_once(vars, |_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::AuditTrail { rows, total } => {
            assert_eq!(total, 1);
            assert_eq!(rows[0].provider, "anthropic");
            assert_eq!(rows[0].integrity, "verified");
        }
        _ => panic!("expected AuditTrail"),
    }
}

fn build_fake_audit_trail_response() -> recondo_tui::gql::queries::audit_trail::ResponseData {
    use recondo_tui::gql::queries::audit_trail::{
        AuditTrailAuditTrail, AuditTrailAuditTrailItems, IntegrityStatus, ResponseData,
    };
    ResponseData {
        audit_trail: AuditTrailAuditTrail {
            total: 1,
            limit: 20,
            offset: 0,
            items: vec![AuditTrailAuditTrailItems {
                timestamp: chrono::Utc
                    .with_ymd_and_hms(2026, 5, 9, 12, 0, 0)
                    .single()
                    .expect("valid timestamp"),
                session_id: "sess-abcdef012345".into(),
                sequence_num: 7,
                provider: "anthropic".into(),
                model: Some("claude-sonnet-4".into()),
                request_hash: Some("reqhashabcdef".into()),
                response_hash: Some("resphashabcdef".into()),
                total_tokens: 1234,
                integrity_status: IntegrityStatus::verified,
                http_status: Some(200),
                capture_complete: true,
            }],
        },
    }
}
