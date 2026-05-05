use ratatui::{
    layout::Rect,
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};

pub struct StubLens {
    title: &'static str,
    body: &'static str,
}

impl StubLens {
    pub fn audit() -> Self {
        Self {
            title: "Audit (v1.5)",
            body: "Audit lens lives at /audit (dashboard). Ships in a future release.",
        }
    }
    pub fn replay() -> Self {
        Self {
            title: "Replay (v1.5)",
            body: "Replay/Diff is planned for v1.5 \u{2014} `r` opens this stub in v1.",
        }
    }
    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        f.render_widget(
            Paragraph::new(self.body)
                .wrap(Wrap { trim: true })
                .block(Block::default().borders(Borders::ALL).title(self.title)),
            area,
        );
    }
}
