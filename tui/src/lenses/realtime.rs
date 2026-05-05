use crate::format::{format_compact_count, format_cost};
use crate::search::fuzzy::fuzzy_match;
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimePane {
    Cards,
    Feed,
}

pub struct RealtimeLens {
    snapshot: RealtimeSnapshot,
    pub provider_filter: Option<String>,
    pub selected_row: usize,
    focused: RealtimePane,
    search_filter: Option<String>,
}

impl Default for RealtimeLens {
    fn default() -> Self {
        Self::new()
    }
}

impl RealtimeLens {
    pub fn new() -> Self {
        Self::with_snapshot(RealtimeSnapshot {
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

    pub fn with_snapshot(snapshot: RealtimeSnapshot) -> Self {
        Self {
            snapshot,
            provider_filter: None,
            selected_row: 0,
            focused: RealtimePane::Cards,
            search_filter: None,
        }
    }

    /// Sets the fuzzy search filter applied on top of the provider filter.
    /// An empty / whitespace-only needle clears the filter.
    pub fn set_search_filter(&mut self, needle: Option<String>) {
        self.search_filter = needle.and_then(|s| {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        });
    }

    pub fn search_filter(&self) -> Option<&str> {
        self.search_filter.as_deref()
    }

    pub fn snapshot(&self) -> &RealtimeSnapshot {
        &self.snapshot
    }

    pub fn set_snapshot(&mut self, s: RealtimeSnapshot) {
        self.snapshot = s;
    }

    /// Bulk-replace the live feed rows. Resets row selection to the top.
    pub fn set_rows(&mut self, rows: Vec<FeedRow>) {
        self.snapshot.rows = rows;
        self.selected_row = 0;
    }

    /// Partial update: replace just the stats portion of the snapshot. Leaves
    /// `rows`, `healthy`, `port` untouched so the realtime stats polling task
    /// does not clobber data owned by the feed or gateway-status tasks.
    #[allow(clippy::too_many_arguments)]
    pub fn apply_stats(
        &mut self,
        active_providers: i32,
        active_sessions: i32,
        user_turns_per_min: i64,
        tokens_last_hour: f64,
        cost_last_hour: f64,
        p50_ms: Option<i32>,
        p99_ms: Option<i32>,
        sample_count: i32,
    ) {
        let s = &mut self.snapshot;
        s.active_providers = active_providers;
        s.active_sessions = active_sessions;
        s.user_turns_per_min = user_turns_per_min;
        s.tokens_last_hour = tokens_last_hour;
        s.cost_last_hour = cost_last_hour;
        s.p50_ms = p50_ms;
        s.p99_ms = p99_ms;
        s.sample_count = sample_count;
    }

    /// Partial update: replace just the live-feed rows. Preserves the user's
    /// cursor where possible — only clamps `selected_row` if the new row set
    /// is shorter than the previous selection.
    pub fn apply_feed_rows(&mut self, rows: Vec<FeedRow>) {
        self.snapshot.rows = rows;
        if self.selected_row >= self.snapshot.rows.len() {
            self.selected_row = self.snapshot.rows.len().saturating_sub(1);
        }
    }

    /// Partial update: replace just gateway health + port. Independent of
    /// stats and feed so the 15s status cadence can run without disturbing
    /// the 5s stats / feed cadences.
    pub fn apply_gateway_status(&mut self, healthy: bool, port: i32) {
        self.snapshot.healthy = healthy;
        self.snapshot.port = port;
    }

    pub fn provider_filter(&self) -> Option<&str> {
        self.provider_filter.as_deref()
    }

    pub fn focused_pane(&self) -> RealtimePane {
        self.focused
    }

    pub fn cycle_focus(&mut self) {
        self.focused = match self.focused {
            RealtimePane::Cards => RealtimePane::Feed,
            RealtimePane::Feed => RealtimePane::Cards,
        };
    }

    /// Returns the rows visible after applying `provider_filter` and
    /// the fuzzy search filter.
    pub fn visible_rows(&self) -> Vec<&FeedRow> {
        self.snapshot
            .rows
            .iter()
            .filter(|r| {
                self.provider_filter
                    .as_deref()
                    .is_none_or(|p| r.provider == p)
            })
            .filter(|r| match self.search_filter.as_deref() {
                None => true,
                Some(needle) => {
                    let label = format!("{} {} {}", r.provider, r.model, r.agent);
                    fuzzy_match(needle, &label).is_some()
                }
            })
            .collect()
    }

    pub fn select_next(&mut self) {
        let len = self.visible_rows().len();
        if len == 0 {
            self.selected_row = 0;
            return;
        }
        self.selected_row = (self.selected_row + 1).min(len - 1);
    }

    pub fn select_prev(&mut self) {
        self.selected_row = self.selected_row.saturating_sub(1);
    }

    pub fn select_top(&mut self) {
        self.selected_row = 0;
    }

    pub fn select_bottom(&mut self) {
        let n = self.visible_rows().len();
        if n > 0 {
            self.selected_row = n - 1;
        } else {
            self.selected_row = 0;
        }
    }

    pub fn cycle_provider_filter(&mut self) {
        self.provider_filter = match self.provider_filter.as_deref() {
            None => Some("anthropic".into()),
            Some("anthropic") => Some("openai".into()),
            Some("openai") => Some("gemini".into()),
            _ => None,
        };
        // Reset selection so it stays in-range relative to the new visible set.
        self.selected_row = 0;
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

        // Feed table — rows are filtered by `provider_filter`. The filter is
        // also reflected in the User Turns / Min card subtitle as
        // "filter: <name>" so operators see both the active narrowing and the
        // resulting row set together.
        let visible: Vec<Vec<String>> = self
            .visible_rows()
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
