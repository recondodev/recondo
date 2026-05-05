use crate::format::{format_compact_count, format_cost};
use crate::ui::widgets::{metric_card::MetricCard, status_pill::StatusPill, table::VirtTable};
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    Frame,
};

/// Column widths for the live-traffic table. Sized to fit the longest realistic
/// values: timestamp (`HH:MM:SS`), provider name (`anthropic`, `gemini`),
/// model id (`claude-3-5-sonnet`, `gpt-4o-2024-11-20`), agent label, token
/// count, formatted cost, and HTTP status.
const FEED_WIDTHS: [Constraint; 7] = [
    Constraint::Length(10),
    Constraint::Length(12),
    Constraint::Length(22),
    Constraint::Length(14),
    Constraint::Length(10),
    Constraint::Length(10),
    Constraint::Length(8),
];

#[derive(Debug, Clone)]
pub struct FeedRow {
    pub time: String,
    pub provider: String,
    pub model: String,
    pub agent: String,
    pub tokens: i64,
    pub cost: f64,
    pub status: i32,
}

#[derive(Debug, Clone)]
pub struct RealtimeSnapshot {
    pub healthy: bool,
    pub port: i32,
    pub active_providers: i32,
    pub active_sessions: i32,
    pub user_turns_per_min: i64,
    pub tokens_last_hour: f64,
    pub cost_last_hour: f64,
    pub p50_ms: Option<i32>,
    pub p99_ms: Option<i32>,
    pub sample_count: i32,
    pub rows: Vec<FeedRow>,
}

pub struct RealtimeLens {
    snapshot: RealtimeSnapshot,
    pub provider_filter: Option<String>,
    pub selected_row: usize,
}

impl RealtimeLens {
    pub fn with_snapshot(snapshot: RealtimeSnapshot) -> Self {
        Self {
            snapshot,
            provider_filter: None,
            selected_row: 0,
        }
    }

    pub fn snapshot(&self) -> &RealtimeSnapshot {
        &self.snapshot
    }

    pub fn set_snapshot(&mut self, s: RealtimeSnapshot) {
        self.snapshot = s;
    }

    pub fn cycle_provider_filter(&mut self) {
        self.provider_filter = match self.provider_filter.as_deref() {
            None => Some("anthropic".into()),
            Some("anthropic") => Some("openai".into()),
            Some("openai") => Some("gemini".into()),
            _ => None,
        };
    }

    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(1),
                Constraint::Length(7),
                Constraint::Min(0),
            ])
            .split(area);

        // Header status pill.
        f.render_widget(
            StatusPill {
                healthy: self.snapshot.healthy,
                port: self.snapshot.port,
            },
            chunks[0],
        );

        // Metric cards row.
        let cards = Layout::default()
            .direction(Direction::Horizontal)
            .constraints(vec![Constraint::Percentage(20); 5])
            .split(chunks[1]);
        let s = &self.snapshot;
        let p50 = s
            .p50_ms
            .map(|v| v.to_string())
            .unwrap_or_else(|| "-".into());
        let p99 = s
            .p99_ms
            .map(|v| v.to_string())
            .unwrap_or_else(|| "-".into());
        let lat_sub = format!("p99 {} ms · n={}", p99, s.sample_count);
        let active_sub = format!("{} providers", s.active_providers);
        let provider_sub = self
            .provider_filter
            .as_deref()
            .map(|p| format!("filter: {p}"))
            .unwrap_or_else(|| "filter: All".into());

        f.render_widget(
            MetricCard::new(
                "User Turns / Min",
                &format!("{}", s.user_turns_per_min),
                Some(&provider_sub),
            ),
            cards[0],
        );
        f.render_widget(
            MetricCard::new(
                "Active Sessions",
                &format!("{}", s.active_sessions),
                Some(&active_sub),
            ),
            cards[1],
        );
        f.render_widget(
            MetricCard::new(
                "Tokens (1h)",
                &format_compact_count(s.tokens_last_hour),
                Some("incl. cache reads"),
            ),
            cards[2],
        );
        f.render_widget(
            MetricCard::new(
                "Cost (1h)",
                &format_cost(s.cost_last_hour),
                Some("projected today"),
            ),
            cards[3],
        );
        f.render_widget(
            MetricCard::new("Latency p50", &format!("{} ms", p50), Some(&lat_sub)),
            cards[4],
        );

        // Feed table.
        // Provider filter is reflected in the User Turns / Min card subtitle
        // ("filter: <name>") but does not remove rows from the live feed —
        // operators want to see all activity even while a filter narrows
        // a downstream view.
        let visible: Vec<Vec<String>> = self
            .snapshot
            .rows
            .iter()
            .map(|r| {
                vec![
                    r.time.clone(),
                    r.provider.clone(),
                    r.model.clone(),
                    r.agent.clone(),
                    r.tokens.to_string(),
                    format_cost(r.cost),
                    r.status.to_string(),
                ]
            })
            .collect();
        let table = VirtTable {
            headers: vec![
                "Time", "Provider", "Model", "Agent", "Tokens", "Cost", "Status",
            ],
            widths: FEED_WIDTHS.to_vec(),
            rows: visible,
            selected: self.selected_row,
            title: "Live Traffic",
        };
        f.render_widget(table, chunks[2]);
    }
}
