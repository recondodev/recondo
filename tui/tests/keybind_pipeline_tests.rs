//! Deliverable pipeline tests for Chunk 1 (lens-aware key dispatch).
//!
//! Every test drives state through the production entry point
//! `AppState::handle(KeyAction)` and asserts on observable state. None of these
//! tests reach into lens internals via direct method calls.
//!
//! These tests REQUIRE the AppState refactor where AppState owns the lens
//! state (sessions, cost, agents, realtime, session_detail, turn_detail) and
//! exposes accessors. The implementer will land that refactor in Chunk 1.

use recondo_tui::app::keymap::KeyAction;
use recondo_tui::app::lens::Lens;
use recondo_tui::app::selection::GroupKey;
use recondo_tui::app::state::AppState;
use recondo_tui::lenses::sessions::{SessionRow, SortKey};

fn seed_sessions_into(state: &mut AppState) {
    state.sessions_mut().set_rows(vec![
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
            model: "claude-3-5-sonnet".into(),
            framework: "codex".into(),
            turns: 8,
            cost: 0.80,
        },
    ]);
}

// ---------- D-K1, D-K2: j/k movement ----------

#[test]
fn j_advances_selected_within_list_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    seed_sessions_into(&mut s);
    assert_eq!(s.sessions().selected(), 0);
    s.handle(KeyAction::MoveDown);
    assert_eq!(s.sessions().selected(), 1);
    s.handle(KeyAction::MoveDown);
    assert_eq!(s.sessions().selected(), 2);
    // Saturate at last row.
    s.handle(KeyAction::MoveDown);
    assert_eq!(s.sessions().selected(), 2);
}

#[test]
fn k_decrements_selected_with_saturation() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    seed_sessions_into(&mut s);
    s.handle(KeyAction::MoveDown);
    s.handle(KeyAction::MoveDown);
    assert_eq!(s.sessions().selected(), 2);
    s.handle(KeyAction::MoveUp);
    assert_eq!(s.sessions().selected(), 1);
    s.handle(KeyAction::MoveUp);
    s.handle(KeyAction::MoveUp);
    s.handle(KeyAction::MoveUp);
    assert_eq!(s.sessions().selected(), 0); // saturating-sub
}

// ---------- D-K5, D-K6: o/O sort cycle ----------

#[test]
fn o_cycles_sortkey_on_sessions_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    assert_eq!(s.sessions().sort_key(), SortKey::Recency);
    s.handle(KeyAction::CycleSort);
    assert_eq!(s.sessions().sort_key(), SortKey::Cost);
    s.handle(KeyAction::CycleSort);
    assert_eq!(s.sessions().sort_key(), SortKey::Turns);
}

#[test]
fn shift_o_toggles_descending_on_sessions_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    let initial = s.sessions().sort_descending();
    s.handle(KeyAction::CycleSortReverse);
    assert_ne!(s.sessions().sort_descending(), initial);
    s.handle(KeyAction::CycleSortReverse);
    assert_eq!(s.sessions().sort_descending(), initial);
}

// ---------- D-K7, D-K8: f/Esc filter modal ----------

#[test]
fn f_opens_sessions_filter_modal() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    assert!(!s.sessions().filter_open());
    s.handle(KeyAction::CycleFilter);
    assert!(s.sessions().filter_open());
}

#[test]
fn esc_closes_sessions_filter_modal_before_history_pop() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.handle(KeyAction::CycleFilter);
    assert!(s.sessions().filter_open());
    // Esc should close the modal and NOT pop history yet.
    s.handle(KeyAction::Pop);
    assert!(!s.sessions().filter_open());
    assert_eq!(s.lens(), Lens::Sessions);
}

// ---------- D-K9: Enter on Sessions drills to SessionDetail ----------

#[test]
fn enter_on_sessions_drills_into_session_detail() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    seed_sessions_into(&mut s);
    s.handle(KeyAction::MoveDown); // select ses_b
    s.handle(KeyAction::Drill);
    assert_eq!(s.lens(), Lens::SessionDetail);
    // After sort by Recency descending, the visible-second row is ses_b.
    assert_eq!(s.selection().session(), Some("ses_b"));
}

// ---------- D-K11: Enter on Cost drills with group key ----------

#[test]
fn enter_on_cost_drills_to_sessions_with_group_key() {
    use recondo_tui::lenses::cost::BreakdownRow;
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.cost_mut().set_breakdown(vec![
        BreakdownRow {
            key: "anthropic".into(),
            label: "Anthropic".into(),
            cost: 8.20,
            sessions: 14,
        },
        BreakdownRow {
            key: "openai".into(),
            label: "OpenAI".into(),
            cost: 3.10,
            sessions: 6,
        },
    ]);
    s.handle(KeyAction::Drill);
    assert_eq!(s.lens(), Lens::Sessions);
    assert_eq!(
        s.selection().group(),
        Some(&GroupKey::Provider("anthropic".into()))
    );
}

// ---------- D-K12: Esc pops history on non-Realtime lens ----------

#[test]
fn esc_pops_history_on_non_realtime_lens() {
    let mut s = AppState::new();
    assert_eq!(s.lens(), Lens::Realtime);
    s.handle(KeyAction::OpenSessions);
    assert_eq!(s.lens(), Lens::Sessions);
    s.handle(KeyAction::Pop);
    assert_eq!(s.lens(), Lens::Realtime);
}

// ---------- D-K14: f on Realtime cycles provider filter AND filters rows ----------

#[test]
fn f_on_realtime_cycles_provider_filter_through_handle() {
    let mut s = AppState::new();
    // Default lens is Realtime.
    assert_eq!(s.lens(), Lens::Realtime);
    assert_eq!(s.realtime().provider_filter(), None);
    s.handle(KeyAction::CycleFilter);
    assert_eq!(s.realtime().provider_filter(), Some("anthropic"));
    s.handle(KeyAction::CycleFilter);
    assert_eq!(s.realtime().provider_filter(), Some("openai"));
}

#[test]
fn realtime_provider_filter_actually_filters_visible_rows() {
    use recondo_tui::lenses::realtime::FeedRow;
    let mut s = AppState::new();
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
    assert_eq!(s.realtime().visible_rows().len(), 2);
    s.handle(KeyAction::CycleFilter); // → anthropic
    assert_eq!(s.realtime().visible_rows().len(), 1);
    assert_eq!(s.realtime().visible_rows()[0].provider, "anthropic");
}

// ---------- D-K13: Tab cycles focus per lens ----------

#[test]
fn tab_cycles_focus_per_lens() {
    let mut s = AppState::new();
    // Realtime is the default.
    let initial = s.realtime().focused_pane();
    s.handle(KeyAction::CycleFocus);
    assert_ne!(s.realtime().focused_pane(), initial);
}

// ---------- D-K3, D-K4: g/G top/bottom (resolved: lens-aware; on Cost g cycles group) ----------

#[test]
fn shift_g_jumps_selection_to_last_row() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    seed_sessions_into(&mut s);
    s.handle(KeyAction::Bottom);
    assert_eq!(s.sessions().selected(), 2);
}

#[test]
fn lowercase_g_on_cost_cycles_group_by() {
    use recondo_tui::lenses::cost::GroupBy;
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    assert_eq!(s.cost().group_by(), GroupBy::Provider);
    s.handle(KeyAction::CycleGroupBy);
    assert_eq!(s.cost().group_by(), GroupBy::Model);
}

#[test]
fn lowercase_g_on_sessions_jumps_to_top() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    seed_sessions_into(&mut s);
    s.handle(KeyAction::Bottom);
    assert_eq!(s.sessions().selected(), 2);
    s.handle(KeyAction::Top);
    assert_eq!(s.sessions().selected(), 0);
}
