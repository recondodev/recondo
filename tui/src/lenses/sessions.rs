use crate::format::format_cost;
use crate::search::fuzzy::fuzzy_match;
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
    selected: usize,
    filter: SessionFilter,
    filter_open: bool,
    search_filter: Option<String>,
}

impl Default for SessionsLens {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionsLens {
    pub fn new() -> Self {
        Self::with_rows(vec![])
    }

    pub fn with_rows(rows: Vec<SessionRow>) -> Self {
        Self {
            rows,
            sort: SortKey::Recency,
            // Default to descending so the natural "newest/highest first"
            // ordering applies for Recency / Cost / Turns. The user toggles
            // direction with `O` (CycleSortReverse).
            descending: true,
            selected: 0,
            filter: SessionFilter::default(),
            filter_open: false,
            search_filter: None,
        }
    }

    /// Bulk-replace all rows. Resets selection to the top. The `descending`
    /// flag is intentionally NOT reset — that would silently clobber the
    /// user's `O` toggle on every 10s poll. Initial direction is set in
    /// `with_rows` / `new`.
    pub fn set_rows(&mut self, rows: Vec<SessionRow>) {
        self.rows = rows;
        self.selected = 0;
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

    /// Sets the fuzzy search filter applied on top of the structured filter.
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

    pub fn rows(&self) -> &[SessionRow] {
        &self.rows
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    pub fn select_next(&mut self) {
        let len = self.rows_sorted().len();
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
        let n = self.rows_sorted().len();
        if n > 0 {
            self.selected = n - 1;
        } else {
            self.selected = 0;
        }
    }

    pub fn rows_sorted(&self) -> Vec<&SessionRow> {
        // NOTE: Only `framework` and `model` filters are enforced here.
        // `SessionFilter::provider` and `SessionFilter::project` are stored on
        // the filter struct (and surfaced in the filter modal) but currently
        // have no corresponding fields on `SessionRow`, which mirrors the
        // GraphQL `Session` shape. Task 14+/Task 22 will either extend
        // `SessionRow` once GraphQL exposes `Session.provider` /
        // `Session.project`, or drop these dimensions from `SessionFilter`.
        // The filter modal annotates these as "(not yet enforced)" so users
        // see the limitation rather than a silent no-op.
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
            .filter(|r| match self.search_filter.as_deref() {
                None => true,
                Some(needle) => {
                    let label = format!("{} {} {}", r.model, r.framework, r.id);
                    fuzzy_match(needle, &label).is_some()
                }
            })
            .collect();
        v.sort_by(|a, b| {
            // Comparator returns ascending order for every key; the
            // `descending` flag (set true by default in `with_rows`) reverses
            // it so Recency / Cost / Turns show newest / highest first.
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
                            "Provider:  {} (not yet enforced)",
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
                            "Project:   {} (not yet enforced)",
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
