use crate::format::format_cost;
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
    pub total_cost: f64,
    pub active_frameworks: i32,
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
        }
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
            AgentsPane::Devs if !self.top_devs.is_empty() => {
                self.selected_dev = (self.selected_dev + 1).min(self.top_devs.len() - 1);
            }
            AgentsPane::Repos if !self.top_repos.is_empty() => {
                self.selected_repo = (self.selected_repo + 1).min(self.top_repos.len() - 1);
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
            AgentsPane::Devs if !self.top_devs.is_empty() => {
                self.selected_dev = self.top_devs.len() - 1;
            }
            AgentsPane::Repos if !self.top_repos.is_empty() => {
                self.selected_repo = self.top_repos.len() - 1;
            }
            _ => {}
        }
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
                "Agents",
                &self.summary.total_agents.to_string(),
                Some("total"),
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
            MetricCard::new("Cost", &format_cost(self.summary.total_cost), Some("total")),
            cards[2],
        );
        f.render_widget(
            MetricCard::new(
                "Frameworks",
                &self.summary.active_frameworks.to_string(),
                Some("active"),
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
            .top_devs
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
            .top_repos
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
