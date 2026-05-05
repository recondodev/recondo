use ratatui::{
    layout::Rect,
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

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
                .block(Block::default().borders(Borders::ALL).title("Turn"))
                .wrap(Wrap { trim: false }),
            area,
        );
    }
}
