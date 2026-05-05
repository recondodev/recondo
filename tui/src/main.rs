use clap::Parser;
use recondo_tui::config::Config;
use recondo_tui::error::Result;

mod runtime;

fn main() -> Result<()> {
    let cfg = Config::parse();
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(recondo_tui::error::AppError::from)?;
    rt.block_on(runtime::run(cfg))
}
