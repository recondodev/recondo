use crate::format::format_cost;
use crate::search::fuzzy::fuzzy_match;
use crate::ui::widgets::bar_chart::HBarChart;
use crate::ui::widgets::metric_card::MetricCard;
use crate::ui::widgets::table::VirtTable;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    Frame,
};

#[derive(Debug, Clone, Default)]
pub struct AgentSummaryStats {
    pub total_agents: i32,
    pub total_sessions: i32,
    pub average_turns_per_session: f64,
    pub unique_developers: i32,
}

#[derive(Debug, Clone)]
pub struct FrameworkSlice {
    pub label: String,
    pub cost: f64,
}

#[derive(Debug, Clone)]
pub struct TopRow {
    pub label: String,
    pub sessions: i32,
    pub cost: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentsPane {
    Cards,
    Chart,
    Devs,
    Repos,
}

pub struct AgentsLens {
    summary: AgentSummaryStats,
    framework: Vec<FrameworkSlice>,
    top_devs: Vec<TopRow>,
    top_repos: Vec<TopRow>,
    focused: AgentsPane,
    selected_dev: usize,
    selected_repo: usize,
    search_filter: Option<String>,
}

impl Default for AgentsLens {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentsLens {
    pub fn new() -> Self {
        Self {
            summary: AgentSummaryStats::default(),
            framework: vec![],
            top_devs: vec![],
            top_repos: vec![],
            focused: AgentsPane::Cards,
            selected_dev: 0,
            selected_repo: 0,
            search_filter: None,
        }
    }

    /// Sets the fuzzy search filter applied to top devs / top repos.
    /// An empty / whitespace-only needle clears the filter. Resets both
    /// selection cursors to 0 to avoid a stale OOB index against the newly
    /// filtered sets.
    pub fn set_search_filter(&mut self, needle: Option<String>) {
        self.search_filter = needle.and_then(|s| {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        });
        self.selected_dev = 0;
        self.selected_repo = 0;
    }

    pub fn search_filter(&self) -> Option<&str> {
        self.search_filter.as_deref()
    }

    fn filter_rows<'a>(&self, rows: &'a [TopRow]) -> Vec<&'a TopRow> {
        rows.iter()
            .filter(|r| match self.search_filter.as_deref() {
                None => true,
                Some(needle) => fuzzy_match(needle, &r.label).is_some(),
            })
            .collect()
    }

    /// Top developers visible after applying the fuzzy search filter.
    pub fn visible_top_devs(&self) -> Vec<&TopRow> {
        self.filter_rows(&self.top_devs)
    }

    /// Top repositories visible after applying the fuzzy search filter.
    pub fn visible_top_repos(&self) -> Vec<&TopRow> {
        self.filter_rows(&self.top_repos)
    }

    pub fn focused_pane(&self) -> AgentsPane {
        self.focused
    }

    pub fn cycle_focus(&mut self) {
        self.focused = match self.focused {
            AgentsPane::Cards => AgentsPane::Chart,
            AgentsPane::Chart => AgentsPane::Devs,
            AgentsPane::Devs => AgentsPane::Repos,
            AgentsPane::Repos => AgentsPane::Cards,
        };
    }

    /// Selection-cursor advance, only meaningful when focused on a table pane.
    pub fn select_next(&mut self) {
        match self.focused {
            AgentsPane::Devs => {
                let len = self.visible_top_devs().len();
                if len > 0 {
                    self.selected_dev = (self.selected_dev + 1).min(len - 1);
                }
            }
            AgentsPane::Repos => {
                let len = self.visible_top_repos().len();
                if len > 0 {
                    self.selected_repo = (self.selected_repo + 1).min(len - 1);
                }
            }
            _ => {}
        }
    }

    pub fn select_prev(&mut self) {
        match self.focused {
            AgentsPane::Devs => self.selected_dev = self.selected_dev.saturating_sub(1),
            AgentsPane::Repos => self.selected_repo = self.selected_repo.saturating_sub(1),
            _ => {}
        }
    }

    pub fn select_top(&mut self) {
        match self.focused {
            AgentsPane::Devs => self.selected_dev = 0,
            AgentsPane::Repos => self.selected_repo = 0,
            _ => {}
        }
    }

    pub fn select_bottom(&mut self) {
        match self.focused {
            AgentsPane::Devs => {
                let len = self.visible_top_devs().len();
                if len > 0 {
                    self.selected_dev = len - 1;
                }
            }
            AgentsPane::Repos => {
                let len = self.visible_top_repos().len();
                if len > 0 {
                    self.selected_repo = len - 1;
                }
            }
            _ => {}
        }
    }
    pub fn summary(&self) -> &AgentSummaryStats {
        &self.summary
    }
    pub fn framework(&self) -> &[FrameworkSlice] {
        &self.framework
    }
    pub fn top_devs(&self) -> &[TopRow] {
        &self.top_devs
    }
    pub fn top_repos(&self) -> &[TopRow] {
        &self.top_repos
    }
    pub fn set_summary(&mut self, s: AgentSummaryStats) {
        self.summary = s;
    }
    pub fn set_framework_distribution(&mut self, v: Vec<FrameworkSlice>) {
        self.framework = v;
    }
    pub fn set_top_devs(&mut self, v: Vec<TopRow>) {
        self.top_devs = v;
    }
    pub fn set_top_repos(&mut self, v: Vec<TopRow>) {
        self.top_repos = v;
    }

    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        let rows = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(7),
                Constraint::Length(10),
                Constraint::Min(0),
            ])
            .split(area);

        // Top: 4 metric cards.
        let cards = Layout::default()
            .direction(Direction::Horizontal)
            .constraints(vec![Constraint::Percentage(25); 4])
            .split(rows[0]);
        // First card title is "Agents" — the test asserts dump.contains("Agents").
        f.render_widget(
            MetricCard::new(
                "Active Agents",
                &self.summary.total_agents.to_string(),
                None,
            ),
            cards[0],
        );
        f.render_widget(
            MetricCard::new(
                "Sessions",
                &self.summary.total_sessions.to_string(),
                Some("total"),
            ),
            cards[1],
        );
        f.render_widget(
            MetricCard::new(
                "Avg Turns/Session",
                &format!("{:.1}", self.summary.average_turns_per_session),
                None,
            ),
            cards[2],
        );
        f.render_widget(
            MetricCard::new(
                "Unique Developers",
                &self.summary.unique_developers.to_string(),
                None,
            ),
            cards[3],
        );

        // Middle: framework distribution bar chart.
        let bar_items: Vec<(String, f64)> = self
            .framework
            .iter()
            .map(|s| (s.label.clone(), s.cost))
            .collect();
        f.render_widget(
            HBarChart {
                title: "Framework Distribution",
                items: &bar_items,
            },
            rows[1],
        );

        // Bottom: side-by-side top devs / top repos.
        let halves = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
            .split(rows[2]);
        let dev_rows: Vec<Vec<String>> = self
            .visible_top_devs()
            .iter()
            .map(|r| vec![r.label.clone(), r.sessions.to_string(), format_cost(r.cost)])
            .collect();
        f.render_widget(
            VirtTable {
                headers: vec!["Developer", "Sessions", "Cost"],
                rows: dev_rows,
                widths: vec![
                    Constraint::Length(20),
                    Constraint::Length(10),
                    Constraint::Length(10),
                ],
                selected: self.selected_dev,
                title: "Top Developers",
            },
            halves[0],
        );
        let repo_rows: Vec<Vec<String>> = self
            .visible_top_repos()
            .iter()
            .map(|r| vec![r.label.clone(), r.sessions.to_string(), format_cost(r.cost)])
            .collect();
        f.render_widget(
            VirtTable {
                headers: vec!["Repository", "Sessions", "Cost"],
                rows: repo_rows,
                widths: vec![
                    Constraint::Length(20),
                    Constraint::Length(10),
                    Constraint::Length(10),
                ],
                selected: self.selected_repo,
                title: "Top Repositories",
            },
            halves[1],
        );
    }
}
