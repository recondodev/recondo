mod config;
mod error;

use clap::Parser;
use config::Config;

fn main() -> error::Result<()> {
    let cfg = Config::parse();
    eprintln!("recondo-tui starting against {}", cfg.api_url);
    Ok(())
}
