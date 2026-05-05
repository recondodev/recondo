use thiserror::Error;

#[derive(Debug, Error)]
#[expect(dead_code, reason = "scaffolding; variants consumed by subsequent TUI tasks")]
pub enum AppError {
    #[error("cannot reach Recondo API at {url}: {source}\n(For local dev: is `just api-dev` running? For deployed installs: check the URL and your network.)")]
    ApiUnreachable {
        url: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("GraphQL error: {0}")]
    GraphQl(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("config: {0}")]
    Config(String),
}

pub type Result<T> = std::result::Result<T, AppError>;
