//! Deliverable pipeline tests for Chunk 3 (SessionDetail + TurnDetail + drill).

use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::app::keymap::KeyAction;
use recondo_tui::app::lens::Lens;
use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::state::AppState;
use recondo_tui::lenses::session_detail::{SessionDetailLens, TurnRow};
use recondo_tui::lenses::sessions::SessionRow;
use recondo_tui::lenses::turn_detail::TurnDetailLens;
use recondo_tui::ui::draw::draw_app;

fn three_sessions() -> Vec<SessionRow> {
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
    ]
}

fn fake_session_detail_lens() -> SessionDetailLens {
    SessionDetailLens::new(
        "ses_a".into(),
        vec![
            TurnRow {
                id: "trn_1".into(),
                sequence: 1,
                model: "claude-3-5-sonnet".into(),
                prompt_tokens: 100,
                completion_tokens: 200,
                cost: 0.05,
                tool_calls: 0,
            },
            TurnRow {
                id: "trn_2".into(),
                sequence: 2,
                model: "claude-3-5-sonnet".into(),
                prompt_tokens: 150,
                completion_tokens: 300,
                cost: 0.10,
                tool_calls: 1,
            },
        ],
        None,
    )
}

fn fake_turn_detail_lens() -> TurnDetailLens {
    TurnDetailLens {
        id: "trn_1".into(),
        model: "claude-3-5-sonnet".into(),
        prompt: "Hello, world".into(),
        response: "Hi back".into(),
        tool_calls: vec![],
    }
}

// ---------- D-SD1: drill into session detail triggers fetch_id ----------

#[test]
fn drilling_into_sessions_sets_session_detail_fetch_id() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_sessions()));
    // Default Recency desc → ses_a is at row 0 (12:00 > 11:30).
    s.handle(KeyAction::Drill);
    assert_eq!(s.lens(), Lens::SessionDetail);
    assert_eq!(s.session_detail_fetch_id(), Some("ses_a".into()));
}

#[test]
fn session_detail_fetch_id_is_none_outside_session_detail_lens() {
    let s = AppState::new();
    // Default lens is Realtime — no fetch needed.
    assert!(s.session_detail_fetch_id().is_none());
}

// ---------- D-SD1: apply_update populates state.session_detail ----------

#[test]
fn apply_session_detail_update_populates_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_sessions()));
    s.handle(KeyAction::Drill);
    assert!(s.session_detail().is_none(), "fetch hasn't completed yet");

    s.apply_update(LensUpdate::SessionDetail(fake_session_detail_lens()));
    let sd = s
        .session_detail()
        .expect("after apply_update, session_detail is populated");
    assert_eq!(sd.session_id(), "ses_a");
    assert_eq!(sd.turns().len(), 2);
}

// ---------- D-SD2: SessionDetail render shows session id + turns ----------

#[test]
fn session_detail_renders_id_and_turns() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_sessions()));
    s.handle(KeyAction::Drill);
    s.apply_update(LensUpdate::SessionDetail(fake_session_detail_lens()));

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
    assert!(dump.contains("ses_a"), "session id missing from render");
    assert!(dump.contains("trn_1"), "first turn id missing from render");
}

// ---------- D-TD1: drill into TurnDetail triggers fetch_id ----------

#[test]
fn drilling_into_session_detail_sets_turn_detail_fetch_id() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_sessions()));
    s.handle(KeyAction::Drill); // → SessionDetail, sets selection.session
    s.apply_update(LensUpdate::SessionDetail(fake_session_detail_lens()));

    s.handle(KeyAction::Drill); // → TurnDetail, sets selection.turn

    assert_eq!(s.lens(), Lens::TurnDetail);
    assert_eq!(s.turn_detail_fetch_id(), Some("trn_1".into()));
}

// ---------- D-TD1: apply_update populates state.turn_detail ----------

#[test]
fn apply_turn_detail_update_populates_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_sessions()));
    s.handle(KeyAction::Drill);
    s.apply_update(LensUpdate::SessionDetail(fake_session_detail_lens()));
    s.handle(KeyAction::Drill);
    assert!(s.turn_detail().is_none(), "fetch hasn't completed yet");

    s.apply_update(LensUpdate::TurnDetail(fake_turn_detail_lens()));
    let td = s
        .turn_detail()
        .expect("after apply_update, turn_detail is populated");
    assert_eq!(td.id, "trn_1");
}

// ---------- D-TD2: TurnDetail renders prompt or id ----------

#[test]
fn turn_detail_renders_id_and_prompt() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_sessions()));
    s.handle(KeyAction::Drill);
    s.apply_update(LensUpdate::SessionDetail(fake_session_detail_lens()));
    s.handle(KeyAction::Drill);
    s.apply_update(LensUpdate::TurnDetail(fake_turn_detail_lens()));

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
    assert!(dump.contains("trn_1"), "turn id missing from render");
    assert!(
        dump.contains("Hello, world"),
        "prompt text missing from render"
    );
}

// ---------- D-NAV1, D-NAV2: Esc pops history ----------

#[test]
fn esc_on_session_detail_pops_to_sessions() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_sessions()));
    s.handle(KeyAction::Drill);
    assert_eq!(s.lens(), Lens::SessionDetail);
    s.handle(KeyAction::Pop);
    assert_eq!(s.lens(), Lens::Sessions);
}

#[test]
fn esc_on_turn_detail_pops_to_session_detail() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_sessions()));
    s.handle(KeyAction::Drill);
    s.apply_update(LensUpdate::SessionDetail(fake_session_detail_lens()));
    s.handle(KeyAction::Drill);
    assert_eq!(s.lens(), Lens::TurnDetail);
    s.handle(KeyAction::Pop);
    assert_eq!(s.lens(), Lens::SessionDetail);
}

// ---------- D-RT1: drill from realtime feed deep-links to a turn ----------

#[test]
fn drilling_from_realtime_feed_sets_session_and_turn_selection() {
    use recondo_tui::lenses::realtime::FeedRow;
    let mut s = AppState::new();
    // Default lens is Realtime. Seed two feed rows; cursor starts at row 0.
    s.realtime_mut().set_rows(vec![
        FeedRow {
            time: "12:00".into(),
            provider: "anthropic".into(),
            model: "claude-3-5-sonnet".into(),
            agent: "claude-code".into(),
            tokens: 100,
            cost: 0.10,
            status: 200,
            session_id: "ses_a".into(),
            user_turn_id: "ses_a:1".into(),
        },
        FeedRow {
            time: "12:01".into(),
            provider: "openai".into(),
            model: "gpt-4o".into(),
            agent: "cursor".into(),
            tokens: 200,
            cost: 0.20,
            status: 200,
            session_id: "ses_b".into(),
            user_turn_id: "ses_b:0".into(),
        },
    ]);
    // Move cursor to row 1 to prove the row's IDs (not the first row's) are
    // what get pushed into the selection registry.
    s.handle(KeyAction::MoveDown);
    s.handle(KeyAction::Drill);
    assert_eq!(s.lens(), Lens::SessionDetail);
    assert_eq!(s.session_detail_fetch_id(), Some("ses_b".into()));
    // selection.turn is staged so the SessionDetail apply path can deep-link.
    assert_eq!(s.selection().turn(), Some("ses_b:0"));
}

#[test]
fn realtime_drill_focuses_user_turn_in_session_detail() {
    let mut s = AppState::new();
    // Build a SessionDetail payload whose ids match a feed row's user_turn_id.
    let sd = SessionDetailLens::new(
        "ses_a".into(),
        vec![
            TurnRow {
                id: "ses_a:0".into(),
                sequence: 1,
                model: "claude-3-5-sonnet".into(),
                prompt_tokens: 100,
                completion_tokens: 200,
                cost: 0.05,
                tool_calls: 0,
            },
            TurnRow {
                id: "ses_a:1".into(),
                sequence: 2,
                model: "claude-3-5-sonnet".into(),
                prompt_tokens: 150,
                completion_tokens: 300,
                cost: 0.10,
                tool_calls: 1,
            },
        ],
        None,
    );
    use recondo_tui::lenses::realtime::FeedRow;
    s.realtime_mut().set_rows(vec![FeedRow {
        time: "12:00".into(),
        provider: "anthropic".into(),
        model: "claude-3-5-sonnet".into(),
        agent: "claude-code".into(),
        tokens: 100,
        cost: 0.10,
        status: 200,
        session_id: "ses_a".into(),
        user_turn_id: "ses_a:1".into(),
    }]);
    s.handle(KeyAction::Drill);
    s.apply_update(LensUpdate::SessionDetail(sd));
    let sd = s.session_detail().expect("populated");
    // Cursor lands on the second turn (`ses_a:1`), not the default row 0.
    assert_eq!(sd.selected_turn_id(), Some("ses_a:1"));
}

// ---------- poll_session_detail_once / poll_turn_detail_once ----------

#[tokio::test]
async fn poll_session_detail_once_marshals_into_update() {
    use recondo_tui::poll::session_detail::poll_session_detail_once;
    let resp = build_fake_session_detail_response();
    let update = poll_session_detail_once("ses_a".into(), |_| async { Ok(resp) }).await;
    let update = update.expect("Ok fetcher → Some update");
    match update {
        LensUpdate::SessionDetail(sd) => {
            assert!(!sd.session_id().is_empty());
        }
        _ => panic!("expected SessionDetail variant"),
    }
}

#[tokio::test]
async fn poll_turn_detail_once_marshals_into_update() {
    use recondo_tui::poll::turn_detail::poll_turn_detail_once;
    let resp = build_fake_turn_detail_response();
    let update = poll_turn_detail_once("trn_1".into(), |_| async { Ok(resp) }).await;
    let update = update.expect("Ok fetcher → Some update");
    match update {
        LensUpdate::TurnDetail(td) => {
            assert!(!td.id.is_empty());
        }
        _ => panic!("expected TurnDetail variant"),
    }
}

// Implementer fills these in with real codegen ResponseData construction.

fn build_fake_session_detail_response() -> recondo_tui::gql::queries::session_detail::ResponseData {
    use recondo_tui::gql::queries::session_detail as q;
    q::ResponseData {
        session: Some(q::SessionDetailSession {
            id: "ses_a".into(),
            started_at: chrono::Utc::now(),
            ended_at: None,
            model: Some("claude-3-5-sonnet".into()),
            framework: Some("claude-code".into()),
            provider: "anthropic".into(),
            total_turns: 2,
            total_cost_usd: 0.15,
            total_tokens: 750,
            turns: vec![
                q::SessionDetailSessionTurns {
                    id: "trn_1".into(),
                    sequence_num: 1,
                    timestamp: chrono::Utc::now(),
                    model: Some("claude-3-5-sonnet".into()),
                    input_tokens: 100,
                    output_tokens: 200,
                    cost_usd: 0.05,
                    tool_call_count: 0,
                },
                q::SessionDetailSessionTurns {
                    id: "trn_2".into(),
                    sequence_num: 2,
                    timestamp: chrono::Utc::now(),
                    model: Some("claude-3-5-sonnet".into()),
                    input_tokens: 150,
                    output_tokens: 300,
                    cost_usd: 0.10,
                    tool_call_count: 1,
                },
            ],
        }),
    }
}

fn build_fake_turn_detail_response() -> recondo_tui::gql::queries::turn::ResponseData {
    use recondo_tui::gql::queries::turn as q;
    q::ResponseData {
        turn: Some(q::TurnTurn {
            id: "trn_1".into(),
            session_id: "ses_a".into(),
            sequence_num: 1,
            timestamp: chrono::Utc::now(),
            model: Some("claude-3-5-sonnet".into()),
            input_tokens: 100,
            output_tokens: 200,
            cost_usd: 0.05,
            user_request_text: Some("Hello, world".into()),
            response_text: Some("Hi back".into()),
            tool_calls: vec![],
        }),
    }
}
