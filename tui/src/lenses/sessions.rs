use crate::format::format_cost;
use crate::ui::widgets::{modal::Modal, table::VirtTable};
use ratatui::{
    layout::{Constraint, Rect},
    Frame,
};

/// Column widths for the sessions table. Sized so `claude-3-5-sonnet`
/// (17 chars) fits comfortably in the Model column on a 120-col terminal.
const SESSION_WIDTHS: [Constraint; 6] = [
    Constraint::Length(8),
    Constraint::Length(8),
    Constraint::Length(20),
    Constraint::Length(14),
    Constraint::Length(8),
    Constraint::Length(10),
];

#[derive(Debug, Clone)]
pub struct SessionRow {
    pub id: String,
    pub started_at: String,
    pub model: String,
    pub framework: String,
    pub turns: i32,
    pub cost: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SortKey {
    Recency,
    Cost,
    Turns,
    Model,
    Framework,
}

#[derive(Debug, Clone, Default)]
pub struct SessionFilter {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub framework: Option<String>,
    pub project: Option<String>,
}

pub struct SessionsLens {
    rows: Vec<SessionRow>,
    sort: SortKey,
    descending: bool,
    pub selected: usize,
    filter: SessionFilter,
    filter_open: bool,
}

impl SessionsLens {
    pub fn with_rows(rows: Vec<SessionRow>) -> Self {
        Self {
            rows,
            sort: SortKey::Recency,
            descending: false,
            selected: 0,
            filter: SessionFilter::default(),
            filter_open: false,
        }
    }

    pub fn sort_key(&self) -> SortKey {
        self.sort
    }

    pub fn sort_descending(&self) -> bool {
        self.descending
    }

    pub fn cycle_sort(&mut self) {
        self.sort = match self.sort {
            SortKey::Recency => SortKey::Cost,
            SortKey::Cost => SortKey::Turns,
            SortKey::Turns => SortKey::Model,
            SortKey::Model => SortKey::Framework,
            SortKey::Framework => SortKey::Recency,
        };
    }

    pub fn cycle_sort_reverse(&mut self) {
        self.descending = !self.descending;
    }

    pub fn open_filter(&mut self) {
        self.filter_open = true;
    }

    pub fn close_filter(&mut self) {
        self.filter_open = false;
    }

    pub fn filter_open(&self) -> bool {
        self.filter_open
    }

    pub fn set_filter(&mut self, f: SessionFilter) {
        self.filter = f;
    }

    pub fn filter(&self) -> &SessionFilter {
        &self.filter
    }

    pub fn rows_sorted(&self) -> Vec<&SessionRow> {
        let mut v: Vec<&SessionRow> = self
            .rows
            .iter()
            .filter(|r| {
                self.filter
                    .framework
                    .as_deref()
                    .is_none_or(|f| r.framework == f)
            })
            .filter(|r| self.filter.model.as_deref().is_none_or(|m| r.model == m))
            .collect();
        v.sort_by(|a, b| {
            let ord = match self.sort {
                SortKey::Recency => a.started_at.cmp(&b.started_at),
                SortKey::Cost => a
                    .cost
                    .partial_cmp(&b.cost)
                    .unwrap_or(std::cmp::Ordering::Equal),
                SortKey::Turns => a.turns.cmp(&b.turns),
                SortKey::Model => a.model.cmp(&b.model),
                SortKey::Framework => a.framework.cmp(&b.framework),
            };
            if self.descending {
                ord.reverse()
            } else {
                ord
            }
        });
        v
    }

    pub fn selected_id(&self) -> Option<&str> {
        self.rows_sorted().get(self.selected).map(|r| r.id.as_str())
    }

    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        let v = self.rows_sorted();
        let display: Vec<Vec<String>> = v
            .iter()
            .map(|r| {
                vec![
                    r.id.clone(),
                    r.started_at.clone(),
                    r.model.clone(),
                    r.framework.clone(),
                    r.turns.to_string(),
                    format_cost(r.cost),
                ]
            })
            .collect();
        let table = VirtTable {
            headers: vec!["ID", "Started", "Model", "Framework", "Turns", "Cost"],
            widths: SESSION_WIDTHS.to_vec(),
            rows: display,
            selected: self.selected,
            title: "Sessions",
        };
        f.render_widget(table, area);

        if self.filter_open {
            f.render_widget(
                Modal {
                    title: "Filter",
                    body: vec![
                        format!(
                            "Provider:  {}",
                            self.filter.provider.as_deref().unwrap_or("any")
                        ),
                        format!(
                            "Model:     {}",
                            self.filter.model.as_deref().unwrap_or("any")
                        ),
                        format!(
                            "Framework: {}",
                            self.filter.framework.as_deref().unwrap_or("any")
                        ),
                        format!(
                            "Project:   {}",
                            self.filter.project.as_deref().unwrap_or("any")
                        ),
                        "[Esc] close   [Enter] apply".into(),
                    ],
                },
                area,
            );
        }
    }
}
