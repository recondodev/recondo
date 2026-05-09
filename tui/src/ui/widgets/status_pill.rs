use crate::ui::theme;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    text::Span,
    widgets::{Paragraph, Widget},
};

pub struct StatusPill {
    pub healthy: bool,
}

impl Widget for StatusPill {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let (text, tone) = if self.healthy {
            (" LIVE ".to_string(), theme::StatusTone::Ok)
        } else {
            (" OFFLINE ".to_string(), theme::StatusTone::Err)
        };
        Paragraph::new(Span::styled(text, theme::status_badge_style(tone)))
            .style(theme::app_style())
            .render(area, buf);
    }
}
