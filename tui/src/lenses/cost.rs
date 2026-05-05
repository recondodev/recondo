use crate::app::selection::{GroupKey, SelectionRegistry};
use crate::format::format_cost;
use crate::search::fuzzy::fuzzy_match;
use crate::ui::widgets::sparkline::DailySpark;
use crate::ui::widgets::table::VirtTable;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    widgets::{Block, Borders, Paragraph},
    Frame,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GroupBy {
    Provider,
    Model,
    Framework,
}

#[derive(Debug, Clone)]
pub struct BreakdownRow {
    pub key: String,
    pub label: String,
    pub cost: f64,
    pub sessions: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CostPane {
    Header,
    Breakdown,
    Sparkline,
}

pub struct CostLens {
    group: GroupBy,
    total: f64,
    delta: Option<f64>,
    breakdown: Vec<BreakdownRow>,
    daily: Vec<f64>,
    selected: usize,
    focused: CostPane,
    search_filter: Option<String>,
}

impl Default for CostLens {
    fn default() -> Self {
        Self::new()
    }
}

impl CostLens {
    pub fn new() -> Self {
        Self {
            group: GroupBy::Provider,
            total: 0.0,
            delta: None,
            breakdown: vec![],
            daily: vec![],
            selected: 0,
            focused: CostPane::Breakdown,
            search_filter: None,
        }
    }

    /// Sets the fuzzy search filter applied to the breakdown rows.
    /// An empty / whitespace-only needle clears the filter. Resets the
    /// selection cursor to 0 to avoid a stale OOB index against the newly
    /// filtered set.
    pub fn set_search_filter(&mut self, needle: Option<String>) {
        self.search_filter = needle.and_then(|s| {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        });
        self.selected = 0;
    }

    pub fn search_filter(&self) -> Option<&str> {
        self.search_filter.as_deref()
    }

    /// Returns the breakdown rows visible after applying `search_filter`.
    pub fn visible_breakdown(&self) -> Vec<&BreakdownRow> {
        self.breakdown
            .iter()
            .filter(|r| match self.search_filter.as_deref() {
                None => true,
                Some(needle) => fuzzy_match(needle, &r.label).is_some(),
            })
            .collect()
    }

    pub fn focused_pane(&self) -> CostPane {
        self.focused
    }

    pub fn cycle_focus(&mut self) {
        self.focused = match self.focused {
            CostPane::Header => CostPane::Breakdown,
            CostPane::Breakdown => CostPane::Sparkline,
            CostPane::Sparkline => CostPane::Header,
        };
    }

    pub fn group_by(&self) -> GroupBy {
        self.group
    }

    pub fn cycle_group_by(&mut self) {
        self.group = match self.group {
            GroupBy::Provider => GroupBy::Model,
            GroupBy::Model => GroupBy::Framework,
            GroupBy::Framework => GroupBy::Provider,
        };
    }

    pub fn breakdown(&self) -> &[BreakdownRow] {
        &self.breakdown
    }

    pub fn total(&self) -> f64 {
        self.total
    }

    pub fn delta(&self) -> Option<f64> {
        self.delta
    }

    pub fn daily(&self) -> &[f64] {
        &self.daily
    }

    pub fn set_total(&mut self, total: f64, delta: Option<f64>) {
        self.total = total;
        self.delta = delta;
    }

    pub fn set_breakdown(&mut self, rows: Vec<BreakdownRow>) {
        self.breakdown = rows;
        self.selected = 0;
    }

    pub fn set_daily(&mut self, d: Vec<f64>) {
        self.daily = d;
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    pub fn select_next(&mut self) {
        let len = self.visible_breakdown().len();
        if len == 0 {
            self.selected = 0;
            return;
        }
        self.selected = (self.selected + 1).min(len - 1);
    }

    pub fn select_prev(&mut self) {
        self.selected = self.selected.saturating_sub(1);
    }

    pub fn select_top(&mut self) {
        self.selected = 0;
    }

    pub fn select_bottom(&mut self) {
        let len = self.visible_breakdown().len();
        if len == 0 {
            self.selected = 0;
        } else {
            self.selected = len - 1;
        }
    }

    pub fn selected_key(&self) -> Option<&str> {
        self.visible_breakdown()
            .get(self.selected)
            .map(|r| r.key.as_str())
    }

    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Length(3),
                Constraint::Min(0),
                Constraint::Length(8),
            ])
            .split(area);

        let delta = self
            .delta
            .map(|d| {
                let sign = if d >= 0.0 { "+" } else { "" };
                format!("  Δ {}{}", sign, format_cost(d))
            })
            .unwrap_or_default();
        let title = format!(
            "Total {}{}    [g] group: {:?}",
            format_cost(self.total),
            delta,
            self.group
        );
        f.render_widget(
            Paragraph::new(title).block(Block::default().borders(Borders::ALL).title("Cost")),
            chunks[0],
        );

        let display: Vec<Vec<String>> = self
            .visible_breakdown()
            .iter()
            .map(|r| vec![r.label.clone(), format_cost(r.cost), r.sessions.to_string()])
            .collect();
        f.render_widget(
            VirtTable {
                headers: vec!["Group", "Cost", "Sessions"],
                rows: display,
                widths: vec![
                    Constraint::Length(20),
                    Constraint::Length(10),
                    Constraint::Length(10),
                ],
                selected: self.selected,
                title: "Breakdown",
            },
            chunks[1],
        );

        // Sparkline takes integer data; scale floats to a u64 visualization band.
        let data_u64: Vec<u64> = self
            .daily
            .iter()
            .map(|v| (v * 100.0).round().max(0.0) as u64)
            .collect();
        f.render_widget(
            DailySpark {
                title: "Daily Spend",
                data: &data_u64,
            },
            chunks[2],
        );
    }
}

/// Task 16 — write the selected breakdown row's `key` into the shared selection,
/// tagged by the lens's current GroupBy.
pub fn drill_target(lens: &CostLens, sel: &mut SelectionRegistry) {
    if let Some(key) = lens.selected_key() {
        let gk = match lens.group_by() {
            GroupBy::Provider => GroupKey::Provider(key.into()),
            GroupBy::Model => GroupKey::Model(key.into()),
            GroupBy::Framework => GroupKey::Framework(key.into()),
        };
        sel.set_group(Some(gk));
    }
}
