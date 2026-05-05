use clap::Parser;
use recondo_tui::config::Config;
use recondo_tui::error::Result;

fn main() -> Result<()> {
    let cfg = Config::parse();
    eprintln!("recondo-tui starting against {}", cfg.api_url);
    Ok(())
}
