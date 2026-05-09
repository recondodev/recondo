use crate::ui::theme;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    text::Span,
    widgets::{Paragraph, Widget},
};

pub struct StatusPill {
    pub healthy: bool,
    pub port: i32,
}

impl Widget for StatusPill {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let (text, tone) = if self.healthy {
            (format!(" LIVE :{} ", self.port), theme::StatusTone::Ok)
        } else {
            (format!(" OFFLINE :{} ", self.port), theme::StatusTone::Err)
        };
        Paragraph::new(Span::styled(text, theme::status_badge_style(tone)))
            .style(theme::app_style())
            .render(area, buf);
    }
}
