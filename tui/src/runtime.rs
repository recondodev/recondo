use crossterm::event::{self, Event};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use recondo_tui::app::keymap::{dispatch_key, KeyAction};
use recondo_tui::app::state::AppState;
use recondo_tui::config::Config;
use recondo_tui::error::Result;
use recondo_tui::lenses::realtime::RealtimeSnapshot;
use recondo_tui::poll::{spawn_loop, PollIntervals};
use recondo_tui::ui::draw::{draw_app, UiCache};
use std::io::stdout;
use std::time::Duration;
use tokio::sync::mpsc;

pub async fn run(cfg: Config) -> Result<()> {
    let url = cfg.api_url.clone();
    let api_key = cfg.api_key.clone();

    enable_raw_mode()?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen)?;
    let mut term = Terminal::new(CrosstermBackend::new(out))?;
    let mut state = AppState::new();
    let mut cache = UiCache {
        realtime: None,
        sessions: None,
        cost: None,
        agents: None,
        session_detail: None,
        turn_detail: None,
    };

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

    while !state.should_quit() {
        while let Ok(snap) = rx.try_recv() {
            cache.realtime = Some(snap);
        }
        term.draw(|f| draw_app(f, &state, Some(&cache)))?;
        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(k) = event::read()? {
                let action = dispatch_key(k, state.mode());
                if matches!(action, KeyAction::Noop) {
                    continue;
                }
                state.handle(action);
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
