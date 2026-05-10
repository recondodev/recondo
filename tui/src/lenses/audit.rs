use crate::format::format_compact_count;
use crate::ui::widgets::table::VirtTable;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    widgets::Paragraph,
    Frame,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditType {
    All,
    Requests,
    Responses,
    Anomalies,
}

impl AuditType {
    pub fn label(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Requests => "requests",
            Self::Responses => "responses",
            Self::Anomalies => "anomalies",
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuditRow {
    pub time: String,
    pub session_id: String,
    pub sequence_num: i32,
    pub provider: String,
    pub model: Option<String>,
    pub request_hash: Option<String>,
    pub response_hash: Option<String>,
    pub tokens: i32,
    pub integrity: String,
    pub http_status: Option<i32>,
    pub capture_complete: bool,
}

pub struct AuditLens {
    rows: Vec<AuditRow>,
    total: i32,
    selected_row: usize,
    type_filter: AuditType,
    search_filter: Option<String>,
}

impl Default for AuditLens {
    fn default() -> Self {
        Self::new()
    }
}

impl AuditLens {
    pub fn new() -> Self {
        Self {
            rows: vec![],
            total: 0,
            selected_row: 0,
            type_filter: AuditType::All,
            search_filter: None,
        }
    }

    pub fn rows(&self) -> &[AuditRow] {
        &self.rows
    }

    pub fn total(&self) -> i32 {
        self.total
    }

    pub fn type_filter(&self) -> AuditType {
        self.type_filter
    }

    pub fn search_filter(&self) -> Option<&str> {
        self.search_filter.as_deref()
    }

    pub fn set_rows(&mut self, rows: Vec<AuditRow>, total: i32) {
        self.rows = rows;
        self.total = total;
        if self.selected_row >= self.rows.len() {
            self.selected_row = self.rows.len().saturating_sub(1);
        }
    }

    pub fn set_search_filter(&mut self, needle: Option<String>) {
        self.search_filter = needle.and_then(|s| {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        });
        self.selected_row = 0;
    }

    pub fn cycle_type_filter(&mut self) {
        self.type_filter = match self.type_filter {
            AuditType::All => AuditType::Requests,
            AuditType::Requests => AuditType::Responses,
            AuditType::Responses => AuditType::Anomalies,
            AuditType::Anomalies => AuditType::All,
        };
        self.selected_row = 0;
    }

    pub fn select_next(&mut self) {
        if !self.rows.is_empty() {
            self.selected_row = (self.selected_row + 1).min(self.rows.len() - 1);
        }
    }

    pub fn select_prev(&mut self) {
        self.selected_row = self.selected_row.saturating_sub(1);
    }

    pub fn select_top(&mut self) {
        self.selected_row = 0;
    }

    pub fn select_bottom(&mut self) {
        if !self.rows.is_empty() {
            self.selected_row = self.rows.len() - 1;
        }
    }

    pub fn selected_session_id(&self) -> Option<&str> {
        self.rows
            .get(self.selected_row)
            .map(|row| row.session_id.as_str())
    }

    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(0)])
            .split(area);

        let search = self.search_filter.as_deref().unwrap_or("none");
        let header = format!(
            "Audit Trail | {} total | filter: {} | search: {}",
            format_compact_count(f64::from(self.total)),
            self.type_filter.label(),
            search
        );
        f.render_widget(
            Paragraph::new(header).block(crate::ui::theme::panel_block("Audit")),
            chunks[0],
        );

        let rows: Vec<Vec<String>> = self
            .rows
            .iter()
            .map(|row| {
                vec![
                    row.time.clone(),
                    format!("{} #{}", compact_id(&row.session_id), row.sequence_num),
                    row.model.clone().unwrap_or_else(|| row.provider.clone()),
                    row.request_hash
                        .as_ref()
                        .map(|h| compact_id(h))
                        .unwrap_or_else(|| "--".into()),
                    row.response_hash
                        .as_ref()
                        .map(|h| compact_id(h))
                        .unwrap_or_else(|| "--".into()),
                    format_compact_count(f64::from(row.tokens)),
                    row.integrity.clone(),
                    row.http_status
                        .map(|status| status.to_string())
                        .unwrap_or_else(|| {
                            if row.capture_complete {
                                "complete".into()
                            } else {
                                "incomplete".into()
                            }
                        }),
                ]
            })
            .collect();

        f.render_widget(
            VirtTable {
                headers: vec![
                    "Time",
                    "Session",
                    "Model",
                    "Req Hash",
                    "Resp Hash",
                    "Tokens",
                    "Integrity",
                    "Status",
                ],
                rows,
                selected: self.selected_row,
                widths: vec![
                    Constraint::Length(10),
                    Constraint::Length(18),
                    Constraint::Length(22),
                    Constraint::Length(12),
                    Constraint::Length(12),
                    Constraint::Length(10),
                    Constraint::Length(12),
                    Constraint::Length(10),
                ],
                title: "Audit Entries",
            },
            chunks[1],
        );
    }
}

fn compact_id(value: &str) -> String {
    if value.len() <= 10 {
        value.to_string()
    } else {
        format!("{}..", &value[..8])
    }
}
