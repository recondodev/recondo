//! Deliverable pipeline tests for Chunk 7 (time window propagation).

use recondo_tui::app::keymap::KeyAction;
use recondo_tui::app::state::AppState;
use recondo_tui::app::time_window::TimeWindow;

fn type_palette_command(s: &mut AppState, cmd: &str) {
    s.handle(KeyAction::OpenPalette);
    for c in cmd.chars() {
        s.handle(KeyAction::PaletteInput(c));
    }
    s.handle(KeyAction::Submit);
}

// ---------- D-W1 ----------

#[test]
fn palette_today_sets_window_to_today() {
    let mut s = AppState::new();
    type_palette_command(&mut s, "today");
    assert_eq!(s.window(), TimeWindow::Today);
}

#[test]
fn palette_week_sets_window_to_week() {
    let mut s = AppState::new();
    type_palette_command(&mut s, "week");
    assert_eq!(s.window(), TimeWindow::Week);
}

#[test]
fn palette_month_sets_window_to_month() {
    let mut s = AppState::new();
    type_palette_command(&mut s, "month");
    assert_eq!(s.window(), TimeWindow::Month);
}

#[test]
fn palette_all_sets_window_to_all() {
    let mut s = AppState::new();
    type_palette_command(&mut s, "all");
    assert_eq!(s.window(), TimeWindow::All);
}

// ---------- D-W2: window propagates to all query vars ----------

#[test]
fn window_change_updates_sessions_query_vars() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    assert_eq!(s.sessions_query_vars().period, TimeWindow::Today);
    type_palette_command(&mut s, "month");
    assert_eq!(s.sessions_query_vars().period, TimeWindow::Month);
}

#[test]
fn window_change_updates_cost_query_vars() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    assert_eq!(
        s.cost_breakdown_query_vars().unwrap().period,
        TimeWindow::Today
    );
    assert_eq!(s.cost_total_query_vars().unwrap().period, TimeWindow::Today);
    type_palette_command(&mut s, "week");
    assert_eq!(
        s.cost_breakdown_query_vars().unwrap().period,
        TimeWindow::Week
    );
    assert_eq!(s.cost_total_query_vars().unwrap().period, TimeWindow::Week);
    // cost_daily_query_vars uses days, not period — derived from window.
    let daily_days = s.cost_daily_query_vars().unwrap().days;
    assert!(daily_days > 0);
}

#[test]
fn window_change_updates_agents_query_vars() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAgents);
    assert_eq!(s.agents_query_vars().unwrap().period, TimeWindow::Today);
    type_palette_command(&mut s, "all");
    assert_eq!(s.agents_query_vars().unwrap().period, TimeWindow::All);
}

#[test]
fn window_change_propagates_to_built_sessions_variables() {
    use recondo_tui::gql::marshal::build_sessions_variables;
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    type_palette_command(&mut s, "month");
    let vars = s.sessions_query_vars();
    let q_vars = build_sessions_variables(vars);
    let f = q_vars.filter.expect("filter present");
    // TimeWindow::Month = 60 days back per days_for_window
    assert!(f.started_after.is_some());
    let now = chrono::Utc::now();
    let diff = now - f.started_after.unwrap();
    assert!(
        diff.num_days() >= 59 && diff.num_days() <= 61,
        "Month → ~60 days back, got {} days",
        diff.num_days()
    );
}

// ---------- D-W3: since/between excised in v1 ----------

#[test]
fn palette_since_command_is_rejected_in_v1() {
    use recondo_tui::palette::parser::parse_command;
    let result = parse_command("since 2026-04-01");
    assert!(
        result.is_err(),
        "v1 must not accept 'since' — implement properly or excise"
    );
}

#[test]
fn palette_between_command_is_rejected_in_v1() {
    use recondo_tui::palette::parser::parse_command;
    let result = parse_command("between 2026-04-01 2026-04-15");
    assert!(result.is_err(), "v1 must not accept 'between'");
}

#[test]
fn help_overlay_does_not_advertise_since_or_between() {
    use ratatui::{backend::TestBackend, Terminal};
    use recondo_tui::lenses::help::HelpOverlay;
    let backend = TestBackend::new(80, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| HelpOverlay.draw(f, f.area())).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(
        !dump.contains("since"),
        "help overlay must not advertise unimplemented 'since'"
    );
    assert!(
        !dump.contains("between"),
        "help overlay must not advertise unimplemented 'between'"
    );
}
