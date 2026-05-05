use crate::ui::theme;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::Style,
    text::Span,
    widgets::{Paragraph, Widget},
};

pub struct StatusPill {
    pub healthy: bool,
    pub port: i32,
}

impl Widget for StatusPill {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let (text, color) = if self.healthy {
            (format!(" LIVE :{} ", self.port), theme::OK)
        } else {
            (format!(" OFFLINE :{} ", self.port), theme::ERR)
        };
        Paragraph::new(Span::styled(text, Style::default().fg(color))).render(area, buf);
    }
}
