use crate::ui::theme;
use ratatui::{
    layout::Rect,
    widgets::{Paragraph, Wrap},
    Frame,
};

#[derive(Debug, Clone)]
pub struct TurnDetailLens {
    pub id: String,
    pub model: String,
    pub prompt: String,
    pub response: String,
    pub tool_calls: Vec<String>, // pre-formatted
}

impl TurnDetailLens {
    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        let body = format!(
            "ID: {}\nModel: {}\n\n=== Prompt ===\n{}\n\n=== Response ===\n{}\n\n=== Tools ===\n{}",
            self.id,
            self.model,
            self.prompt,
            self.response,
            self.tool_calls.join("\n"),
        );
        f.render_widget(
            Paragraph::new(body)
                .style(theme::body_style())
                .block(theme::panel_block("Turn"))
                .wrap(Wrap { trim: false }),
            area,
        );
    }
}
