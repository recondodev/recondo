use crate::format::format_cost;
use crate::search::fuzzy::fuzzy_match;
use crate::ui::theme;
use crate::ui::widgets::table::VirtTable;
use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    widgets::Paragraph,
    Frame,
};

#[derive(Debug, Clone)]
pub struct TurnRow {
    pub id: String,
    pub sequence: i64,
    pub model: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost: f64,
    pub tool_calls: i32,
}

#[derive(Debug, Clone)]
pub struct SessionDetailLens {
    session_id: String,
    turns: Vec<TurnRow>,
    selected: usize,
    search_filter: Option<String>,
}

impl SessionDetailLens {
    pub fn new(session_id: String, turns: Vec<TurnRow>, deep_link_turn: Option<String>) -> Self {
        let selected = deep_link_turn
            .as_deref()
            .and_then(|tid| turns.iter().position(|t| t.id == tid))
            .unwrap_or(0);
        Self {
            session_id,
            turns,
            selected,
            search_filter: None,
        }
    }

    /// Sets the fuzzy search filter applied to turn rows. An empty /
    /// whitespace-only needle clears the filter. Resets selection to 0 to
    /// avoid a stale OOB index against the newly filtered set.
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

    /// Turns visible after applying the fuzzy search filter (id + model).
    pub fn visible_turns(&self) -> Vec<&TurnRow> {
        self.turns
            .iter()
            .filter(|t| match self.search_filter.as_deref() {
                None => true,
                Some(needle) => {
                    let label = format!("{} {}", t.id, t.model);
                    fuzzy_match(needle, &label).is_some()
                }
            })
            .collect()
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    pub fn select_next(&mut self) {
        let len = self.visible_turns().len();
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
        let len = self.visible_turns().len();
        if len == 0 {
            self.selected = 0;
        } else {
            self.selected = len - 1;
        }
    }

    pub fn selected_turn_id(&self) -> Option<&str> {
        self.visible_turns()
            .get(self.selected)
            .map(|t| t.id.as_str())
    }

    /// Sets the selection cursor to the position of the turn with the given id
    /// within the (unfiltered) turns list. Falls back to 0 if not found.
    pub fn set_selected_to_id(&mut self, id: &str) {
        self.selected = self.turns.iter().position(|t| t.id == id).unwrap_or(0);
    }

    pub fn turns(&self) -> &[TurnRow] {
        &self.turns
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Length(3), Constraint::Min(0)])
            .split(area);
        f.render_widget(
            Paragraph::new(format!("Session {}", self.session_id))
                .style(theme::body_style())
                .block(theme::panel_block("Session")),
            chunks[0],
        );
        let display: Vec<Vec<String>> = self
            .visible_turns()
            .iter()
            .map(|t| {
                vec![
                    t.id.clone(),
                    t.sequence.to_string(),
                    t.model.clone(),
                    t.prompt_tokens.to_string(),
                    t.completion_tokens.to_string(),
                    format_cost(t.cost),
                    t.tool_calls.to_string(),
                ]
            })
            .collect();
        let table = VirtTable {
            headers: vec![
                "Turn ID",
                "Seq",
                "Model",
                "Prompt",
                "Completion",
                "Cost",
                "Tools",
            ],
            rows: display,
            // Model col fits "claude-3-5-sonnet" (17 chars)
            widths: vec![
                Constraint::Length(8),
                Constraint::Length(5),
                Constraint::Length(20),
                Constraint::Length(8),
                Constraint::Length(11),
                Constraint::Length(8),
                Constraint::Length(6),
            ],
            selected: self.selected,
            title: "Turns",
        };
        f.render_widget(table, chunks[1]);
    }
}
