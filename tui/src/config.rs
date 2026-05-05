use clap::Parser;

#[derive(Debug, Clone, Parser)]
#[command(name = "recondo-tui", about = "Recondo terminal UI")]
pub struct Config {
    #[arg(long, env = "RECONDO_API_URL", default_value = "http://localhost:4000/graphql")]
    pub api_url: String,
    #[arg(long, env = "RECONDO_API_KEY")]
    pub api_key: Option<String>,
}
