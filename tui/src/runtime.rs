use recondo_tui::config::Config;
use recondo_tui::error::{AppError, Result};
use recondo_tui::gql::client::HttpClient;
use recondo_tui::gql::queries::{realtime_stats, RealtimeStats};

pub async fn run(cfg: Config) -> Result<()> {
    let client = HttpClient::new(cfg.api_url.clone(), cfg.api_key.clone())?;
    // Preflight: fail fast if the API is unreachable.
    let _ = client
        .query::<RealtimeStats>(realtime_stats::Variables {})
        .await
        .map_err(|e| AppError::Config(format!("preflight: {e}")))?;
    eprintln!("recondo-tui: preflight OK against {}", cfg.api_url);
    Ok(())
}
