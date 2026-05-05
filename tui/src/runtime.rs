use crossterm::event::{self, Event};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use recondo_tui::app::keymap::{dispatch_key, KeyAction};
use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::state::{AppState, SessionsQueryVars};
use recondo_tui::config::Config;
use recondo_tui::error::Result;
use recondo_tui::gql::marshal::build_sessions_variables;
use recondo_tui::gql::queries::{
    session_detail as q_session_detail, sessions as q_sessions, turn as q_turn, SessionDetail,
    Sessions, Turn,
};
use recondo_tui::lenses::realtime::RealtimeSnapshot;
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
