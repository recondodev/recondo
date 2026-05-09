use std::time::Duration;
use tokio::sync::mpsc::Sender;
use tokio::time::interval;

pub mod agents;
pub mod audit;
pub mod cost;
pub mod realtime;
pub mod session_detail;
pub mod sessions;
pub mod turn_detail;

#[derive(Debug, Clone, Copy)]
pub struct PollIntervals {
    pub stats_secs: u64,
    pub feed_secs: u64,
    pub status_secs: u64,
}

impl Default for PollIntervals {
    fn default() -> Self {
        Self {
            stats_secs: 5,
            feed_secs: 5,
            status_secs: 15,
        }
    }
}

/// Runs `f` every `secs` seconds until the channel send fails (consumer dropped).
pub fn spawn_loop<F, Fut, T>(secs: u64, tx: Sender<T>, mut f: F) -> tokio::task::JoinHandle<()>
where
    F: FnMut() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = T> + Send,
    T: Send + 'static,
{
    tokio::spawn(async move {
        let mut tk = interval(Duration::from_secs(secs));
        loop {
            tk.tick().await;
            let v = f().await;
            if tx.send(v).await.is_err() {
                break;
            }
        }
    })
}
