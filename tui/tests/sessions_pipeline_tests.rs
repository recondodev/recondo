//! Deliverable pipeline tests for Chunk 2 (Sessions data wiring).
//!
//! Tests drive the Sessions polling pipeline: AppState → query vars →
//! fake fetcher → marshal → LensUpdate → apply_update → state.sessions.
//!
//! Pipeline tests in this file MUST go through `apply_update` to mutate
//! lens state — they may NOT call `sessions_mut().set_rows(...)` directly.
//! The `apply_update` path is the production entry point for polled data;
//! direct setter use would mask broken polling glue.

use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::app::keymap::KeyAction;
use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::selection::GroupKey;
use recondo_tui::app::state::AppState;
use recondo_tui::app::time_window::TimeWindow;
use recondo_tui::lenses::sessions::{SessionFilter, SessionRow, SortKey};
use recondo_tui::ui::draw::draw_app;

fn three_rows() -> Vec<SessionRow> {
    vec![
        SessionRow {
            id: "ses_a".into(),
            provider: "anthropic".into(),
            project: Some("proj-a".into()),
            started_at: "12:00".into(),
            model: "claude-3-5-sonnet".into(),
            framework: "claude-code".into(),
            turns: 12,
            cost: 1.20,
        },
        SessionRow {
            id: "ses_b".into(),
            provider: "openai".into(),
            project: Some("proj-b".into()),
            started_at: "11:30".into(),
            model: "gpt-4o".into(),
            framework: "cursor".into(),
            turns: 5,
            cost: 0.40,
        },
        SessionRow {
            id: "ses_c".into(),
            provider: "anthropic".into(),
            project: Some("proj-a".into()),
            started_at: "10:00".into(),
            model: "claude-3-5-sonnet".into(),
            framework: "codex".into(),
            turns: 8,
            cost: 0.80,
        },
    ]
}

// ---------- D-S1, D-S3: apply_update populates state.sessions ----------

#[test]
fn apply_sessions_update_populates_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    assert!(
        s.sessions().rows().is_empty(),
        "fresh sessions lens should have no rows; got {}",
        s.sessions().rows().len()
    );

    s.apply_update(LensUpdate::Sessions(three_rows()));

    assert_eq!(s.sessions().rows().len(), 3);
    let ids: Vec<&str> = s.sessions().rows().iter().map(|r| r.id.as_str()).collect();
    assert!(ids.contains(&"ses_a"));
    assert!(ids.contains(&"ses_b"));
    assert!(ids.contains(&"ses_c"));
}

#[test]
fn apply_sessions_update_renders_in_draw() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_rows()));

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
    assert!(
        dump.contains("ses_a"),
        "first session id missing from render: {dump}"
    );
    assert!(dump.contains("claude-3-5-sonnet"));
}

// ---------- D-S2, D-S6: query vars honor selection.group() and window ----------

#[test]
fn sessions_query_vars_reflect_default_state() {
    let s = AppState::new();
    let vars = s.sessions_query_vars();
    assert!(
        vars.filter.provider.is_none(),
        "default filter.provider should be None"
    );
    assert!(vars.filter.framework.is_none());
    assert_eq!(vars.period, TimeWindow::Today, "default window is Today");
    assert!(vars.limit > 0, "limit must be positive");
    assert_eq!(vars.offset, 0);
}

#[test]
fn sessions_query_vars_provider_from_selection_group() {
    let mut s = AppState::new();
    s.selection_mut()
        .set_group(Some(GroupKey::Provider("anthropic".into())));
    let vars = s.sessions_query_vars();
    assert_eq!(vars.filter.provider.as_deref(), Some("anthropic"));
}

#[test]
fn sessions_query_vars_model_from_selection_group() {
    let mut s = AppState::new();
    s.selection_mut()
        .set_group(Some(GroupKey::Model("claude-3-5-sonnet".into())));
    let vars = s.sessions_query_vars();
    assert_eq!(vars.filter.model.as_deref(), Some("claude-3-5-sonnet"));
}

#[test]
fn sessions_query_vars_framework_from_selection_group() {
    let mut s = AppState::new();
    s.selection_mut()
        .set_group(Some(GroupKey::Framework("claude-code".into())));
    let vars = s.sessions_query_vars();
    assert_eq!(vars.filter.framework.as_deref(), Some("claude-code"));
}

#[test]
fn sessions_query_vars_explicit_filter_overrides_or_extends_selection() {
    // If the user explicitly opens the filter modal and sets a model filter,
    // and the selection has a Provider group, both should be applied.
    let mut s = AppState::new();
    s.selection_mut()
        .set_group(Some(GroupKey::Provider("anthropic".into())));
    s.sessions_mut().set_filter(SessionFilter {
        model: Some("gpt-4o".into()),
        ..Default::default()
    });
    let vars = s.sessions_query_vars();
    assert_eq!(vars.filter.provider.as_deref(), Some("anthropic"));
    assert_eq!(vars.filter.model.as_deref(), Some("gpt-4o"));
}

#[test]
fn sessions_query_vars_period_changes_with_window() {
    let mut s = AppState::new();
    // Use a palette command to change the window — exercise the production path.
    s.handle(KeyAction::OpenPalette);
    for c in "week".chars() {
        s.handle(KeyAction::PaletteInput(c));
    }
    s.handle(KeyAction::Submit);
    assert_eq!(s.window(), TimeWindow::Week);
    let vars = s.sessions_query_vars();
    assert_eq!(vars.period, TimeWindow::Week);
}

// ---------- D-S4: o then redraw shows new sort order ----------

#[test]
fn cycling_sort_changes_render_order() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.apply_update(LensUpdate::Sessions(three_rows()));

    // Default sort: Recency descending → ses_a (12:00) is row 0.
    assert_eq!(s.sessions().sort_key(), SortKey::Recency);
    let backend = TestBackend::new(120, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| draw_app(f, &s)).unwrap();
    let dump_recency: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    let pos_a_recency = dump_recency.find("ses_a").unwrap();
    let pos_b_recency = dump_recency.find("ses_b").unwrap();
    assert!(
        pos_a_recency < pos_b_recency,
        "by Recency desc, ses_a (12:00) is above ses_b (11:30)"
    );

    // Cycle to Cost. Descending → ses_a ($1.20) is still on top, but the relative
    // order of ses_b (0.40) and ses_c (0.80) flips: ses_c now above ses_b.
    s.handle(KeyAction::CycleSort);
    assert_eq!(s.sessions().sort_key(), SortKey::Cost);
    term.draw(|f| draw_app(f, &s)).unwrap();
    let dump_cost: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    let pos_b_cost = dump_cost.find("ses_b").unwrap();
    let pos_c_cost = dump_cost.find("ses_c").unwrap();
    assert!(
        pos_c_cost < pos_b_cost,
        "by Cost desc, ses_c ($0.80) is above ses_b ($0.40)"
    );
}

// ---------- poll_sessions_once with fake fetcher ----------

#[tokio::test]
async fn poll_sessions_once_marshals_response_into_lens_update() {
    use recondo_tui::poll::sessions::poll_sessions_once;

    let s = AppState::new();
    let vars = s.sessions_query_vars();

    // Fake fetcher returns a hand-crafted graphql_client response.
    // Implementer: use the actual ResponseData type from the codegen at
    // recondo_tui::gql::queries::sessions::ResponseData.
    let fake_response = build_fake_sessions_response();

    let update = poll_sessions_once(vars, |_| async { Ok(fake_response) }).await;
    let update = update.expect("fetcher returned Ok; poll should produce an update");

    match update {
        LensUpdate::Sessions(rows) => {
            assert!(!rows.is_empty(), "marshalled rows should be non-empty");
            // Verify at least one expected field came through
            assert!(
                rows.iter().any(|r| !r.id.is_empty()),
                "row ids should be populated"
            );
        }
        #[allow(unreachable_patterns)]
        _ => panic!("expected LensUpdate::Sessions, got {update:?}"),
    }
}

#[tokio::test]
async fn poll_sessions_once_returns_none_on_fetch_error() {
    use recondo_tui::error::AppError;
    use recondo_tui::poll::sessions::poll_sessions_once;

    let s = AppState::new();
    let vars = s.sessions_query_vars();

    let update = poll_sessions_once(vars, |_| async {
        Err::<recondo_tui::gql::queries::sessions::ResponseData, AppError>(AppError::GraphQl(
            "simulated network failure".into(),
        ))
    })
    .await;

    assert!(
        update.is_none(),
        "fetcher Err should return None — caller decides retry policy"
    );
}

// ---------- Helper for the fake response ----------
//
// The implementer should provide the exact construction shape that matches
// `recondo_tui::gql::queries::sessions::ResponseData`. graphql_client codegen
// produces a nested struct hierarchy mirroring the `.graphql` query.
//
// Minimum: 1 session item with id/startedAt/model/framework/totalTurns/totalCostUsd.
// The marshalling fn `marshal_sessions` should produce a SessionRow with at
// least the id field populated.

// ---------- build_sessions_variables: period → started_after ----------

#[test]
fn build_sessions_variables_uses_period_for_started_after() {
    use recondo_tui::app::state::SessionsQueryVars;
    use recondo_tui::app::time_window::TimeWindow;
    use recondo_tui::gql::marshal::build_sessions_variables;

    let vars = SessionsQueryVars {
        filter: Default::default(),
        period: TimeWindow::Week,
        limit: 20,
        offset: 0,
    };
    let q_vars = build_sessions_variables(vars);
    let f = q_vars.filter.expect("filter should be present");
    assert!(
        f.started_after.is_some(),
        "period TimeWindow::Week must produce started_after"
    );
    // Approximate sanity: started_after should be in the past (within ~14 days).
    let now = chrono::Utc::now();
    let started = f.started_after.unwrap();
    assert!(started < now);
    let diff = now - started;
    assert!(
        diff.num_days() >= 13 && diff.num_days() <= 15,
        "Week → ~14 days back, got {} days",
        diff.num_days()
    );
}

#[test]
fn build_sessions_variables_period_all_is_none() {
    use recondo_tui::app::state::SessionsQueryVars;
    use recondo_tui::app::time_window::TimeWindow;
    use recondo_tui::gql::marshal::build_sessions_variables;

    let vars = SessionsQueryVars {
        filter: Default::default(),
        period: TimeWindow::All,
        limit: 20,
        offset: 0,
    };
    let q_vars = build_sessions_variables(vars);
    let f = q_vars.filter.expect("filter should be present");
    assert!(
        f.started_after.is_none(),
        "TimeWindow::All means no lower bound"
    );
}

fn build_fake_sessions_response() -> recondo_tui::gql::queries::sessions::ResponseData {
    use recondo_tui::gql::queries::sessions as q;
    q::ResponseData {
        sessions: q::SessionsSessions {
            total: 1,
            limit: 20,
            offset: 0,
            items: vec![q::SessionsSessionsItems {
                id: "ses_fake".into(),
                project_id: Some("proj-a".into()),
                started_at: chrono::Utc::now(),
                ended_at: None,
                model: Some("claude-3-5-sonnet".into()),
                framework: Some("claude-code".into()),
                provider: "anthropic".into(),
                total_turns: 5,
                total_cost_usd: 0.50,
                total_tokens: 1000,
            }],
        },
    }
}
