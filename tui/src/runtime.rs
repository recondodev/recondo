use crossterm::event::{self, Event};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use recondo_tui::app::keymap::{dispatch_key, KeyAction};
use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::state::{
    AgentsQueryVars, AppState, CostBreakdownQueryVars, CostDailyQueryVars, CostTotalQueryVars,
    SessionsQueryVars,
};
use recondo_tui::config::Config;
use recondo_tui::error::Result;
use recondo_tui::gql::marshal::build_sessions_variables;
use recondo_tui::gql::queries::{
    agent_framework_distribution as q_agent_framework_distribution,
    agent_summary as q_agent_summary, daily_spend as q_daily_spend,
    gateway_status as q_gateway_status, realtime_feed as q_realtime_feed,
    realtime_stats as q_realtime_stats, session_detail as q_session_detail, sessions as q_sessions,
    spend_by_framework as q_spend_by_framework, spend_by_model as q_spend_by_model,
    spend_by_provider as q_spend_by_provider, top_developers as q_top_developers,
    top_repositories as q_top_repositories, turn as q_turn, usage_summary as q_usage_summary,
    AgentFrameworkDistribution, AgentSummary, DailySpend, GatewayStatus, RealtimeFeed,
    RealtimeStats, SessionDetail, Sessions, SpendByFramework, SpendByModel, SpendByProvider,
    TopDevelopers, TopRepositories, Turn, UsageSummary,
};
use recondo_tui::lenses::cost::GroupBy;
use recondo_tui::poll::agents::{
    poll_agent_framework_distribution_once, poll_agent_summary_once, poll_top_developers_once,
    poll_top_repositories_once,
};
use recondo_tui::poll::cost::{
    poll_cost_breakdown_framework_once, poll_cost_breakdown_model_once, poll_cost_breakdown_once,
    poll_cost_daily_once, poll_cost_total_once,
};
use recondo_tui::poll::realtime::{
    poll_gateway_status_once, poll_realtime_feed_once, poll_realtime_stats_once,
};
use recondo_tui::poll::session_detail::poll_session_detail_once;
use recondo_tui::poll::sessions::poll_sessions_once;
use recondo_tui::poll::turn_detail::poll_turn_detail_once;
use recondo_tui::poll::PollIntervals;
use recondo_tui::ui::draw::draw_app;
use std::io::stdout;
use std::time::Duration;
use tokio::sync::{mpsc, watch};
use tokio::time::interval;

pub async fn run(cfg: Config) -> Result<()> {
    let url = cfg.api_url.clone();
    let api_key = cfg.api_key.clone();

    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut term = Terminal::new(CrosstermBackend::new(out))?;
    let mut state = AppState::new();

    // The realtime lens is fed by three independent polling tasks (stats /
    // feed / status). Each writes a partial-update LensUpdate variant via
    // the shared update channel — so a 5s feed refresh never clobbers cards
    // and a 15s status refresh never clobbers feed rows. Failed fetches
    // produce no update; operators see "OFFLINE" + stale data until the
    // API recovers.
    let intervals = PollIntervals::default();

    // Sessions polling. The watch channel carries the latest query vars so
    // changes from the main loop (filter modal apply, palette window switch,
    // selection drill) take effect on the next tick. The mpsc channel
    // delivers marshalled LensUpdates back to the main loop, which applies
    // them via `state.apply_update(...)` — the production entry point.
    let initial_session_vars = state.sessions_query_vars();
    let (vars_tx, vars_rx) = watch::channel(initial_session_vars);
    let (update_tx, mut update_rx) = mpsc::channel::<LensUpdate>(16);

    // Realtime stats task — 5s cadence, partial update via RealtimeStats.
    let _realtime_stats_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        let secs = intervals.stats_secs;
        tokio::spawn(async move {
            let mut tk = interval(Duration::from_secs(secs));
            loop {
                tk.tick().await;
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_realtime_stats_once(|_| async move {
                    fetch_realtime_stats(&url, &api_key).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    // Realtime feed task — 5s cadence, partial update via RealtimeFeed.
    let _realtime_feed_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        let secs = intervals.feed_secs;
        tokio::spawn(async move {
            let mut tk = interval(Duration::from_secs(secs));
            loop {
                tk.tick().await;
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_realtime_feed_once(|_| async move {
                    fetch_realtime_feed(&url, &api_key).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    // Gateway status task — 15s cadence, partial update via GatewayStatus.
    let _gateway_status_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        let secs = intervals.status_secs;
        tokio::spawn(async move {
            let mut tk = interval(Duration::from_secs(secs));
            loop {
                tk.tick().await;
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_gateway_status_once(|_| async move {
                    fetch_gateway_status(&url, &api_key).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };
    let _sessions_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        tokio::spawn(async move {
            // First tick fires immediately so the table populates without
            // waiting 10s.
            let mut tk = tokio::time::interval(Duration::from_secs(10));
            loop {
                tk.tick().await;
                let vars = vars_rx.borrow().clone();
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_sessions_once(vars, |vars| async move {
                    fetch_sessions(&url, &api_key, vars).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    // SessionDetail polling. Triggered by drill (selection.set_session +
    // history.push(SessionDetail)). The watch channel carries the active
    // fetch id; the polling task re-fetches whenever that id changes (and
    // periodically while the user stays on the lens, so updated turns appear).
    let (sd_id_tx, sd_id_rx) = watch::channel::<Option<String>>(None);
    let _session_detail_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        let mut sd_id_rx = sd_id_rx;
        tokio::spawn(async move {
            let mut tk = tokio::time::interval(Duration::from_secs(10));
            loop {
                tokio::select! {
                    _ = tk.tick() => {}
                    res = sd_id_rx.changed() => {
                        if res.is_err() { break; }
                    }
                }
                let id = sd_id_rx.borrow().clone();
                let Some(id) = id else { continue };
                // Re-fetch on id change OR on cadence. Either way produce a
                // fresh poll; this keeps the lens current as new turns land.
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_session_detail_once(id, |id| async move {
                    fetch_session_detail(&url, &api_key, id).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    // TurnDetail polling. Same pattern as SessionDetail, keyed on selection.turn.
    let (td_id_tx, td_id_rx) = watch::channel::<Option<String>>(None);
    let _turn_detail_task =
        {
            let url = url.clone();
            let api_key = api_key.clone();
            let update_tx = update_tx.clone();
            let mut td_id_rx = td_id_rx;
            tokio::spawn(async move {
                let mut tk = tokio::time::interval(Duration::from_secs(10));
                loop {
                    tokio::select! {
                        _ = tk.tick() => {}
                        res = td_id_rx.changed() => {
                            if res.is_err() { break; }
                        }
                    }
                    let id = td_id_rx.borrow().clone();
                    let Some(id) = id else { continue };
                    let url = url.clone();
                    let api_key = api_key.clone();
                    let result = poll_turn_detail_once(id, |id| async move {
                        fetch_turn(&url, &api_key, id).await
                    })
                    .await;
                    if let Some(update) = result {
                        if update_tx.send(update).await.is_err() {
                            break;
                        }
                    }
                }
            })
        };

    // Cost-breakdown polling. Watch channel carries Option<vars>: None means
    // the user is not on the Cost lens, so the task skips the tick. The runtime
    // dispatches on the GroupBy variant because each spend_by_* query module
    // produces a distinct ResponseData type — sibling poll fns keep each path
    // type-checked end-to-end.
    let (cost_breakdown_vars_tx, mut cost_breakdown_vars_rx) =
        watch::channel::<Option<CostBreakdownQueryVars>>(state.cost_breakdown_query_vars());
    let _cost_breakdown_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        tokio::spawn(async move {
            let mut tk = tokio::time::interval(Duration::from_secs(15));
            loop {
                tokio::select! {
                    _ = tk.tick() => {}
                    res = cost_breakdown_vars_rx.changed() => {
                        if res.is_err() { break; }
                    }
                }
                let Some(vars) = *cost_breakdown_vars_rx.borrow() else {
                    continue;
                };
                let url = url.clone();
                let api_key = api_key.clone();
                let result = match vars.group {
                    GroupBy::Provider => {
                        poll_cost_breakdown_once(vars, |v| async move {
                            fetch_spend_by_provider(&url, &api_key, v).await
                        })
                        .await
                    }
                    GroupBy::Model => {
                        poll_cost_breakdown_model_once(vars, |v| async move {
                            fetch_spend_by_model(&url, &api_key, v).await
                        })
                        .await
                    }
                    GroupBy::Framework => {
                        poll_cost_breakdown_framework_once(vars, |v| async move {
                            fetch_spend_by_framework(&url, &api_key, v).await
                        })
                        .await
                    }
                };
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    // Cost-total polling (usage summary).
    let (cost_total_vars_tx, mut cost_total_vars_rx) =
        watch::channel::<Option<CostTotalQueryVars>>(state.cost_total_query_vars());
    let _cost_total_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        tokio::spawn(async move {
            let mut tk = tokio::time::interval(Duration::from_secs(15));
            loop {
                tokio::select! {
                    _ = tk.tick() => {}
                    res = cost_total_vars_rx.changed() => {
                        if res.is_err() { break; }
                    }
                }
                let Some(vars) = *cost_total_vars_rx.borrow() else {
                    continue;
                };
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_cost_total_once(vars, |v| async move {
                    fetch_usage_summary(&url, &api_key, v).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    // Cost-daily polling (sparkline).
    let (cost_daily_vars_tx, mut cost_daily_vars_rx) =
        watch::channel::<Option<CostDailyQueryVars>>(state.cost_daily_query_vars());
    let _cost_daily_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        tokio::spawn(async move {
            let mut tk = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = tk.tick() => {}
                    res = cost_daily_vars_rx.changed() => {
                        if res.is_err() { break; }
                    }
                }
                let Some(vars) = *cost_daily_vars_rx.borrow() else {
                    continue;
                };
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_cost_daily_once(vars, |v| async move {
                    fetch_daily_spend(&url, &api_key, v).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    // Agents polling. Same pattern as Cost: an Option<vars> watch channel
    // gates each task on `state.agents_query_vars()` returning Some — None
    // means the user is not on the Agents lens, so the tick is skipped.
    let (agents_summary_vars_tx, mut agents_summary_vars_rx) =
        watch::channel::<Option<AgentsQueryVars>>(state.agents_query_vars());
    let _agents_summary_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        tokio::spawn(async move {
            let mut tk = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = tk.tick() => {}
                    res = agents_summary_vars_rx.changed() => {
                        if res.is_err() { break; }
                    }
                }
                let Some(vars) = *agents_summary_vars_rx.borrow() else {
                    continue;
                };
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_agent_summary_once(vars, |v| async move {
                    fetch_agent_summary(&url, &api_key, v).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    let (agents_framework_vars_tx, mut agents_framework_vars_rx) =
        watch::channel::<Option<AgentsQueryVars>>(state.agents_query_vars());
    let _agents_framework_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        tokio::spawn(async move {
            let mut tk = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = tk.tick() => {}
                    res = agents_framework_vars_rx.changed() => {
                        if res.is_err() { break; }
                    }
                }
                let Some(vars) = *agents_framework_vars_rx.borrow() else {
                    continue;
                };
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_agent_framework_distribution_once(vars, |v| async move {
                    fetch_agent_framework_distribution(&url, &api_key, v).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    let (agents_top_devs_vars_tx, mut agents_top_devs_vars_rx) =
        watch::channel::<Option<AgentsQueryVars>>(state.agents_query_vars());
    let _agents_top_devs_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        tokio::spawn(async move {
            let mut tk = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = tk.tick() => {}
                    res = agents_top_devs_vars_rx.changed() => {
                        if res.is_err() { break; }
                    }
                }
                let Some(vars) = *agents_top_devs_vars_rx.borrow() else {
                    continue;
                };
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_top_developers_once(vars, |v| async move {
                    fetch_top_developers(&url, &api_key, v).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    let (agents_top_repos_vars_tx, mut agents_top_repos_vars_rx) =
        watch::channel::<Option<AgentsQueryVars>>(state.agents_query_vars());
    let _agents_top_repos_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        let update_tx = update_tx.clone();
        tokio::spawn(async move {
            let mut tk = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = tk.tick() => {}
                    res = agents_top_repos_vars_rx.changed() => {
                        if res.is_err() { break; }
                    }
                }
                let Some(vars) = *agents_top_repos_vars_rx.borrow() else {
                    continue;
                };
                let url = url.clone();
                let api_key = api_key.clone();
                let result = poll_top_repositories_once(vars, |v| async move {
                    fetch_top_repositories(&url, &api_key, v).await
                })
                .await;
                if let Some(update) = result {
                    if update_tx.send(update).await.is_err() {
                        break;
                    }
                }
            }
        })
    };

    while !state.should_quit() {
        while let Ok(update) = update_rx.try_recv() {
            state.apply_update(update);
        }
        term.draw(|f| draw_app(f, &state))?;
        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(k) = event::read()? {
                let action = dispatch_key(k, state.mode());
                if matches!(action, KeyAction::Noop) {
                    continue;
                }
                state.handle(action);
                // Push the latest query vars so the polling task picks up
                // any state change (filter modal apply, window switch, drill).
                let _ = vars_tx.send(state.sessions_query_vars());
                // SessionDetail / TurnDetail polling is selection-driven:
                // each task only fetches when its fetch_id() yields Some(id).
                // Pushing on every event is cheap (watch coalesces identical
                // values) and keeps the polling tasks woken up the moment a
                // drill happens.
                let _ = sd_id_tx.send(state.session_detail_fetch_id());
                let _ = td_id_tx.send(state.turn_detail_fetch_id());
                // Cost vars are Option<...> — None when the active lens is
                // not Cost, which the polling tasks treat as "skip tick".
                let _ = cost_breakdown_vars_tx.send(state.cost_breakdown_query_vars());
                let _ = cost_total_vars_tx.send(state.cost_total_query_vars());
                let _ = cost_daily_vars_tx.send(state.cost_daily_query_vars());
                // Agents vars — Option<...> with None when not on Agents lens.
                let _ = agents_summary_vars_tx.send(state.agents_query_vars());
                let _ = agents_framework_vars_tx.send(state.agents_query_vars());
                let _ = agents_top_devs_vars_tx.send(state.agents_query_vars());
                let _ = agents_top_repos_vars_tx.send(state.agents_query_vars());
            }
        }
    }

    disable_raw_mode()?;
    execute!(term.backend_mut(), LeaveAlternateScreen).ok();
    term.show_cursor().ok();
    Ok(())
}

/// One-shot RealtimeStats GraphQL fetch.
async fn fetch_realtime_stats(
    url: &str,
    api_key: &Option<String>,
) -> std::result::Result<q_realtime_stats::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    client
        .query::<RealtimeStats>(q_realtime_stats::Variables {})
        .await
}

/// One-shot RealtimeFeed GraphQL fetch. `provider`/`limit` left None so the
/// API returns its default cap; provider filtering is applied client-side
/// in the lens after marshalling.
async fn fetch_realtime_feed(
    url: &str,
    api_key: &Option<String>,
) -> std::result::Result<q_realtime_feed::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    client
        .query::<RealtimeFeed>(q_realtime_feed::Variables {
            provider: None,
            limit: None,
        })
        .await
}

/// One-shot GatewayStatus GraphQL fetch.
async fn fetch_gateway_status(
    url: &str,
    api_key: &Option<String>,
) -> std::result::Result<q_gateway_status::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    client
        .query::<GatewayStatus>(q_gateway_status::Variables {})
        .await
}

/// One-shot Sessions GraphQL fetch. Translates `SessionsQueryVars` (the lens
/// filter + selection composition) into the codegen `Variables` shape and
/// returns the raw `ResponseData` for `marshal_sessions` to map.
async fn fetch_sessions(
    url: &str,
    api_key: &Option<String>,
    vars: SessionsQueryVars,
) -> std::result::Result<q_sessions::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = build_sessions_variables(vars);
    client.query::<Sessions>(q_vars).await
}

/// One-shot SessionDetail GraphQL fetch.
async fn fetch_session_detail(
    url: &str,
    api_key: &Option<String>,
    id: String,
) -> std::result::Result<q_session_detail::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_session_detail::Variables { id };
    client.query::<SessionDetail>(q_vars).await
}

/// One-shot Turn GraphQL fetch.
async fn fetch_turn(
    url: &str,
    api_key: &Option<String>,
    id: String,
) -> std::result::Result<q_turn::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_turn::Variables { id };
    client.query::<Turn>(q_vars).await
}

// ---- Cost fetchers ----------------------------------------------------------
//
// Each query module gets its own copy of the GraphQL `Period` enum (graphql_client
// emits per-module enum copies). The mapping helpers stay near the fetchers so
// the relationship `TimeWindow → Period(of-this-query)` is local and explicit.

fn period_for_provider(
    w: recondo_tui::app::time_window::TimeWindow,
) -> q_spend_by_provider::Period {
    use recondo_tui::app::time_window::TimeWindow;
    match w {
        TimeWindow::Today => q_spend_by_provider::Period::DAY_1,
        TimeWindow::Week => q_spend_by_provider::Period::DAY_7,
        TimeWindow::Month => q_spend_by_provider::Period::DAY_30,
        TimeWindow::All => q_spend_by_provider::Period::DAY_90,
    }
}

fn period_for_model(w: recondo_tui::app::time_window::TimeWindow) -> q_spend_by_model::Period {
    use recondo_tui::app::time_window::TimeWindow;
    match w {
        TimeWindow::Today => q_spend_by_model::Period::DAY_1,
        TimeWindow::Week => q_spend_by_model::Period::DAY_7,
        TimeWindow::Month => q_spend_by_model::Period::DAY_30,
        TimeWindow::All => q_spend_by_model::Period::DAY_90,
    }
}

fn period_for_framework(
    w: recondo_tui::app::time_window::TimeWindow,
) -> q_spend_by_framework::Period {
    use recondo_tui::app::time_window::TimeWindow;
    match w {
        TimeWindow::Today => q_spend_by_framework::Period::DAY_1,
        TimeWindow::Week => q_spend_by_framework::Period::DAY_7,
        TimeWindow::Month => q_spend_by_framework::Period::DAY_30,
        TimeWindow::All => q_spend_by_framework::Period::DAY_90,
    }
}

fn period_for_usage_summary(
    w: recondo_tui::app::time_window::TimeWindow,
) -> q_usage_summary::Period {
    use recondo_tui::app::time_window::TimeWindow;
    match w {
        TimeWindow::Today => q_usage_summary::Period::DAY_1,
        TimeWindow::Week => q_usage_summary::Period::DAY_7,
        TimeWindow::Month => q_usage_summary::Period::DAY_30,
        TimeWindow::All => q_usage_summary::Period::DAY_90,
    }
}

async fn fetch_spend_by_provider(
    url: &str,
    api_key: &Option<String>,
    vars: CostBreakdownQueryVars,
) -> std::result::Result<q_spend_by_provider::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_spend_by_provider::Variables {
        period: Some(period_for_provider(vars.period)),
        from: None,
        to: None,
    };
    client.query::<SpendByProvider>(q_vars).await
}

async fn fetch_spend_by_model(
    url: &str,
    api_key: &Option<String>,
    vars: CostBreakdownQueryVars,
) -> std::result::Result<q_spend_by_model::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_spend_by_model::Variables {
        period: Some(period_for_model(vars.period)),
        from: None,
        to: None,
    };
    client.query::<SpendByModel>(q_vars).await
}

async fn fetch_spend_by_framework(
    url: &str,
    api_key: &Option<String>,
    vars: CostBreakdownQueryVars,
) -> std::result::Result<q_spend_by_framework::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_spend_by_framework::Variables {
        period: Some(period_for_framework(vars.period)),
        from: None,
        to: None,
    };
    client.query::<SpendByFramework>(q_vars).await
}

async fn fetch_usage_summary(
    url: &str,
    api_key: &Option<String>,
    vars: CostTotalQueryVars,
) -> std::result::Result<q_usage_summary::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_usage_summary::Variables {
        period: Some(period_for_usage_summary(vars.period)),
        from: None,
        to: None,
    };
    client.query::<UsageSummary>(q_vars).await
}

async fn fetch_daily_spend(
    url: &str,
    api_key: &Option<String>,
    vars: CostDailyQueryVars,
) -> std::result::Result<q_daily_spend::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_daily_spend::Variables {
        days: Some(vars.days as i64),
    };
    client.query::<DailySpend>(q_vars).await
}

// ---- Agents fetchers --------------------------------------------------------
//
// Each agents-lens query module (agent_summary, agent_framework_distribution,
// top_developers, top_repositories) emits its own copy of the GraphQL `Period`
// enum, so the TimeWindow -> Period mapping is repeated locally per query.

fn period_for_agent_summary(
    w: recondo_tui::app::time_window::TimeWindow,
) -> q_agent_summary::Period {
    use recondo_tui::app::time_window::TimeWindow;
    match w {
        TimeWindow::Today => q_agent_summary::Period::DAY_1,
        TimeWindow::Week => q_agent_summary::Period::DAY_7,
        TimeWindow::Month => q_agent_summary::Period::DAY_30,
        TimeWindow::All => q_agent_summary::Period::DAY_90,
    }
}

fn period_for_agent_framework_distribution(
    w: recondo_tui::app::time_window::TimeWindow,
) -> q_agent_framework_distribution::Period {
    use recondo_tui::app::time_window::TimeWindow;
    match w {
        TimeWindow::Today => q_agent_framework_distribution::Period::DAY_1,
        TimeWindow::Week => q_agent_framework_distribution::Period::DAY_7,
        TimeWindow::Month => q_agent_framework_distribution::Period::DAY_30,
        TimeWindow::All => q_agent_framework_distribution::Period::DAY_90,
    }
}

fn period_for_top_developers(
    w: recondo_tui::app::time_window::TimeWindow,
) -> q_top_developers::Period {
    use recondo_tui::app::time_window::TimeWindow;
    match w {
        TimeWindow::Today => q_top_developers::Period::DAY_1,
        TimeWindow::Week => q_top_developers::Period::DAY_7,
        TimeWindow::Month => q_top_developers::Period::DAY_30,
        TimeWindow::All => q_top_developers::Period::DAY_90,
    }
}

fn period_for_top_repositories(
    w: recondo_tui::app::time_window::TimeWindow,
) -> q_top_repositories::Period {
    use recondo_tui::app::time_window::TimeWindow;
    match w {
        TimeWindow::Today => q_top_repositories::Period::DAY_1,
        TimeWindow::Week => q_top_repositories::Period::DAY_7,
        TimeWindow::Month => q_top_repositories::Period::DAY_30,
        TimeWindow::All => q_top_repositories::Period::DAY_90,
    }
}

async fn fetch_agent_summary(
    url: &str,
    api_key: &Option<String>,
    vars: AgentsQueryVars,
) -> std::result::Result<q_agent_summary::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_agent_summary::Variables {
        period: Some(period_for_agent_summary(vars.period)),
        from: None,
        to: None,
    };
    client.query::<AgentSummary>(q_vars).await
}

async fn fetch_agent_framework_distribution(
    url: &str,
    api_key: &Option<String>,
    vars: AgentsQueryVars,
) -> std::result::Result<q_agent_framework_distribution::ResponseData, recondo_tui::error::AppError>
{
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_agent_framework_distribution::Variables {
        period: Some(period_for_agent_framework_distribution(vars.period)),
        from: None,
        to: None,
    };
    client.query::<AgentFrameworkDistribution>(q_vars).await
}

async fn fetch_top_developers(
    url: &str,
    api_key: &Option<String>,
    vars: AgentsQueryVars,
) -> std::result::Result<q_top_developers::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_top_developers::Variables {
        limit: Some(20),
        offset: Some(0),
        period: Some(period_for_top_developers(vars.period)),
    };
    client.query::<TopDevelopers>(q_vars).await
}

async fn fetch_top_repositories(
    url: &str,
    api_key: &Option<String>,
    vars: AgentsQueryVars,
) -> std::result::Result<q_top_repositories::ResponseData, recondo_tui::error::AppError> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let q_vars = q_top_repositories::Variables {
        limit: Some(20),
        offset: Some(0),
        period: Some(period_for_top_repositories(vars.period)),
    };
    client.query::<TopRepositories>(q_vars).await
}
