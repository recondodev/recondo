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
    AppState, CostBreakdownQueryVars, CostDailyQueryVars, CostTotalQueryVars, SessionsQueryVars,
};
use recondo_tui::config::Config;
use recondo_tui::error::Result;
use recondo_tui::gql::marshal::build_sessions_variables;
use recondo_tui::gql::queries::{
    daily_spend as q_daily_spend, session_detail as q_session_detail, sessions as q_sessions,
    spend_by_framework as q_spend_by_framework, spend_by_model as q_spend_by_model,
    spend_by_provider as q_spend_by_provider, turn as q_turn, usage_summary as q_usage_summary,
    DailySpend, SessionDetail, Sessions, SpendByFramework, SpendByModel, SpendByProvider, Turn,
    UsageSummary,
};
use recondo_tui::lenses::cost::GroupBy;
use recondo_tui::lenses::realtime::RealtimeSnapshot;
use recondo_tui::poll::cost::{
    poll_cost_breakdown_framework_once, poll_cost_breakdown_model_once, poll_cost_breakdown_once,
    poll_cost_daily_once, poll_cost_total_once,
};
use recondo_tui::poll::session_detail::poll_session_detail_once;
use recondo_tui::poll::sessions::poll_sessions_once;
use recondo_tui::poll::turn_detail::poll_turn_detail_once;
use recondo_tui::poll::{spawn_loop, PollIntervals};
use recondo_tui::ui::draw::draw_app;
use std::io::stdout;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

pub async fn run(cfg: Config) -> Result<()> {
    let url = cfg.api_url.clone();
    let api_key = cfg.api_key.clone();

    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut term = Terminal::new(CrosstermBackend::new(out))?;
    let mut state = AppState::new();

    // Spawn realtime stats polling. The fallback `RealtimeSnapshot { healthy: false, .. }`
    // when a fetch fails is acceptable here: this is display-time data, not capture data.
    // Operators see "OFFLINE" in the status pill and zeroed metrics until the API recovers.
    let intervals = PollIntervals::default();
    let (tx, mut rx) = mpsc::channel::<RealtimeSnapshot>(8);
    let _stats_task = {
        let url = url.clone();
        let api_key = api_key.clone();
        spawn_loop(intervals.stats_secs, tx.clone(), move || {
            let url = url.clone();
            let api_key = api_key.clone();
            async move {
                fetch_realtime_snapshot(&url, &api_key)
                    .await
                    .unwrap_or_else(|_| RealtimeSnapshot {
                        healthy: false,
                        port: 8443,
                        active_providers: 0,
                        active_sessions: 0,
                        user_turns_per_min: 0,
                        tokens_last_hour: 0.0,
                        cost_last_hour: 0.0,
                        p50_ms: None,
                        p99_ms: None,
                        sample_count: 0,
                        rows: vec![],
                    })
            }
        })
    };

    // Sessions polling. The watch channel carries the latest query vars so
    // changes from the main loop (filter modal apply, palette window switch,
    // selection drill) take effect on the next tick. The mpsc channel
    // delivers marshalled LensUpdates back to the main loop, which applies
    // them via `state.apply_update(...)` — the production entry point.
    let initial_session_vars = state.sessions_query_vars();
    let (vars_tx, vars_rx) = watch::channel(initial_session_vars);
    let (update_tx, mut update_rx) = mpsc::channel::<LensUpdate>(16);
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

    while !state.should_quit() {
        while let Ok(snap) = rx.try_recv() {
            state.realtime_mut().set_snapshot(snap);
        }
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
            }
        }
    }

    disable_raw_mode()?;
    execute!(term.backend_mut(), LeaveAlternateScreen).ok();
    term.show_cursor().ok();
    Ok(())
}

async fn fetch_realtime_snapshot(url: &str, api_key: &Option<String>) -> Result<RealtimeSnapshot> {
    let client = recondo_tui::gql::client::HttpClient::new(url.into(), api_key.clone())?;
    let stats = client
        .query::<recondo_tui::gql::queries::RealtimeStats>(
            recondo_tui::gql::queries::realtime_stats::Variables {},
        )
        .await?
        .realtime_stats;
    // graphql_client maps GraphQL `Int` to `i64`; the TUI snapshot uses `i32`
    // for counts and `i64` only for the per-minute turn metric. We saturate
    // i64 -> i32 via `try_from(...).unwrap_or(i32::MAX)` so values above
    // `i32::MAX` clamp to the maximum instead of wrapping (`as i32` would
    // truncate with two's-complement wrap). Acceptable for display-only
    // counts that won't realistically exceed ~10^4.
    Ok(RealtimeSnapshot {
        healthy: true,
        port: 8443,
        active_providers: i32::try_from(stats.active_provider_count).unwrap_or(i32::MAX),
        active_sessions: i32::try_from(stats.active_sessions).unwrap_or(i32::MAX),
        user_turns_per_min: stats.user_turns_per_minute,
        tokens_last_hour: stats.tokens_last_hour,
        cost_last_hour: stats.cost_last_hour,
        p50_ms: stats
            .latency_p50_ms
            .map(|v| i32::try_from(v).unwrap_or(i32::MAX)),
        p99_ms: stats
            .latency_p99_ms
            .map(|v| i32::try_from(v).unwrap_or(i32::MAX)),
        sample_count: i32::try_from(stats.latency_sample_count).unwrap_or(i32::MAX),
        rows: vec![],
    })
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
