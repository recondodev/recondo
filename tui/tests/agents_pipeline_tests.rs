use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::app::keymap::KeyAction;
use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::state::AppState;
use recondo_tui::app::time_window::TimeWindow;
use recondo_tui::lenses::agents::{AgentSummaryStats, FrameworkSlice, TopRow};
use recondo_tui::ui::draw::draw_app;

fn fake_summary() -> AgentSummaryStats {
    AgentSummaryStats {
        total_agents: 12,
        total_sessions: 47,
        average_turns_per_session: 8.5,
        unique_developers: 5,
    }
}
fn fake_framework_dist() -> Vec<FrameworkSlice> {
    vec![
        FrameworkSlice {
            label: "claude-code".into(),
            cost: 8.0,
        },
        FrameworkSlice {
            label: "cursor".into(),
            cost: 4.5,
        },
    ]
}
fn fake_top_devs() -> Vec<TopRow> {
    vec![TopRow {
        label: "andmer".into(),
        sessions: 14,
        cost: 6.20,
    }]
}
fn fake_top_repos() -> Vec<TopRow> {
    vec![TopRow {
        label: "recondo".into(),
        sessions: 22,
        cost: 9.40,
    }]
}

// ---------- D-A1: apply_update populates each piece ----------

#[test]
fn apply_agents_summary_update_populates() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAgents);
    s.apply_update(LensUpdate::AgentsSummary(fake_summary()));
    assert_eq!(s.agents().summary().total_sessions, 47);
    assert_eq!(s.agents().summary().total_agents, 12);
    assert_eq!(s.agents().summary().average_turns_per_session, 8.5);
    assert_eq!(s.agents().summary().unique_developers, 5);
}

#[test]
fn apply_agents_framework_dist_update_populates() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAgents);
    s.apply_update(LensUpdate::AgentsFrameworkDist(fake_framework_dist()));
    assert_eq!(s.agents().framework().len(), 2);
    assert_eq!(s.agents().framework()[0].label, "claude-code");
}

#[test]
fn apply_agents_top_devs_update_populates() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAgents);
    s.apply_update(LensUpdate::AgentsTopDevs(fake_top_devs()));
    assert_eq!(s.agents().top_devs().len(), 1);
    assert_eq!(s.agents().top_devs()[0].label, "andmer");
}

#[test]
fn apply_agents_top_repos_update_populates() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAgents);
    s.apply_update(LensUpdate::AgentsTopRepos(fake_top_repos()));
    assert_eq!(s.agents().top_repos().len(), 1);
    assert_eq!(s.agents().top_repos()[0].label, "recondo");
}

// ---------- D-A2: render shows polled values ----------

#[test]
fn agents_render_after_polling_shows_data() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAgents);
    s.apply_update(LensUpdate::AgentsSummary(fake_summary()));
    s.apply_update(LensUpdate::AgentsFrameworkDist(fake_framework_dist()));
    s.apply_update(LensUpdate::AgentsTopDevs(fake_top_devs()));
    s.apply_update(LensUpdate::AgentsTopRepos(fake_top_repos()));

    let backend = TestBackend::new(140, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| draw_app(f, &s)).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("47"), "session count missing: {dump}");
    assert!(dump.contains("8.5"), "average turns metric missing: {dump}");
    assert!(
        dump.contains("5"),
        "unique developers metric missing: {dump}"
    );
    assert!(
        !dump.contains("$0.00"),
        "agents cards must not render a phantom aggregate cost: {dump}"
    );
    assert!(dump.contains("claude-code"));
    assert!(dump.contains("andmer"));
    assert!(dump.contains("recondo"));
}

// ---------- D-A1: query vars only Some when Lens::Agents active ----------

#[test]
fn agents_query_vars_some_when_active() {
    let mut s = AppState::new();
    assert!(
        s.agents_query_vars().is_none(),
        "default lens is Realtime → None"
    );
    s.handle(KeyAction::OpenAgents);
    let vars = s
        .agents_query_vars()
        .expect("should be Some on Agents lens");
    assert_eq!(vars.period, TimeWindow::Today);
}

#[test]
fn agents_query_vars_period_changes_with_window() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenAgents);
    s.handle(KeyAction::OpenPalette);
    for c in "month".chars() {
        s.handle(KeyAction::PaletteInput(c));
    }
    s.handle(KeyAction::Submit);
    let vars = s.agents_query_vars().expect("on Agents lens");
    assert_eq!(vars.period, TimeWindow::Month);
}

// ---------- poll_*_once tests ----------

#[tokio::test]
async fn poll_agent_summary_once_marshals_into_update() {
    use recondo_tui::app::state::AgentsQueryVars;
    use recondo_tui::poll::agents::poll_agent_summary_once;
    let vars = AgentsQueryVars {
        period: TimeWindow::Today,
    };
    let resp = build_fake_agent_summary_response();
    let update = poll_agent_summary_once(vars, |_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::AgentsSummary(s) => assert!(s.total_sessions > 0),
        _ => panic!("expected AgentsSummary"),
    }
}

#[tokio::test]
async fn poll_agent_framework_distribution_once_marshals() {
    use recondo_tui::app::state::AgentsQueryVars;
    use recondo_tui::poll::agents::poll_agent_framework_distribution_once;
    let vars = AgentsQueryVars {
        period: TimeWindow::Today,
    };
    let resp = build_fake_agent_framework_distribution_response();
    let update = poll_agent_framework_distribution_once(vars, |_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::AgentsFrameworkDist(rows) => assert!(!rows.is_empty()),
        _ => panic!("expected AgentsFrameworkDist"),
    }
}

#[tokio::test]
async fn poll_top_developers_once_marshals() {
    use recondo_tui::app::state::AgentsQueryVars;
    use recondo_tui::poll::agents::poll_top_developers_once;
    let vars = AgentsQueryVars {
        period: TimeWindow::Today,
    };
    let resp = build_fake_top_developers_response();
    let update = poll_top_developers_once(vars, |_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::AgentsTopDevs(rows) => assert!(!rows.is_empty()),
        _ => panic!("expected AgentsTopDevs"),
    }
}

#[tokio::test]
async fn poll_top_repositories_once_marshals() {
    use recondo_tui::app::state::AgentsQueryVars;
    use recondo_tui::poll::agents::poll_top_repositories_once;
    let vars = AgentsQueryVars {
        period: TimeWindow::Today,
    };
    let resp = build_fake_top_repositories_response();
    let update = poll_top_repositories_once(vars, |_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::AgentsTopRepos(rows) => assert!(!rows.is_empty()),
        _ => panic!("expected AgentsTopRepos"),
    }
}

fn build_fake_agent_summary_response() -> recondo_tui::gql::queries::agent_summary::ResponseData {
    use recondo_tui::gql::queries::agent_summary::{AgentSummaryAgentSummary, ResponseData};
    ResponseData {
        agent_summary: AgentSummaryAgentSummary {
            active_agents: 12,
            framework_count: 4,
            total_sessions: 47,
            sessions_delta: 3.0,
            average_turns_per_session: 8.5,
            median_turns_per_session: 7.0,
            unique_developers: 5,
        },
    }
}
fn build_fake_agent_framework_distribution_response(
) -> recondo_tui::gql::queries::agent_framework_distribution::ResponseData {
    use recondo_tui::gql::queries::agent_framework_distribution::{
        AgentFrameworkDistributionAgentFrameworkDistribution, ResponseData,
    };
    ResponseData {
        agent_framework_distribution: vec![
            AgentFrameworkDistributionAgentFrameworkDistribution {
                name: "claude-code".into(),
                cost_usd: 8.0,
                percentage: 64.0,
                count: 30,
            },
            AgentFrameworkDistributionAgentFrameworkDistribution {
                name: "cursor".into(),
                cost_usd: 4.5,
                percentage: 36.0,
                count: 17,
            },
        ],
    }
}
fn build_fake_top_developers_response() -> recondo_tui::gql::queries::top_developers::ResponseData {
    use recondo_tui::gql::queries::top_developers::{
        ResponseData, TopDevelopersTopDevelopers, TopDevelopersTopDevelopersItems,
    };
    ResponseData {
        top_developers: TopDevelopersTopDevelopers {
            total: 1,
            limit: 20,
            offset: 0,
            items: vec![TopDevelopersTopDevelopersItems {
                account_uuid: "andmer".into(),
                session_count: 14,
                total_tokens: 1_234_567.0,
                total_cost_usd: 6.20,
                favorite_model: Some("claude-sonnet-4".into()),
                last_active: None,
            }],
        },
    }
}
fn build_fake_top_repositories_response(
) -> recondo_tui::gql::queries::top_repositories::ResponseData {
    use recondo_tui::gql::queries::top_repositories::{
        ResponseData, TopRepositoriesTopRepositories, TopRepositoriesTopRepositoriesItems,
    };
    ResponseData {
        top_repositories: TopRepositoriesTopRepositories {
            total: 1,
            limit: 20,
            offset: 0,
            items: vec![TopRepositoriesTopRepositoriesItems {
                repository: "recondo".into(),
                session_count: 22,
                branch_count: 4,
                total_cost_usd: 9.40,
                primary_framework: Some("claude-code".into()),
            }],
        },
    }
}
