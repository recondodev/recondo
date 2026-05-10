use crate::ui::theme;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    text::{Line, Span},
    widgets::{Paragraph, Widget, Wrap},
};

pub struct MetricCard<'a> {
    label: &'a str,
    value: &'a str,
    subtitle: Option<&'a str>,
}

impl<'a> MetricCard<'a> {
    pub fn new(label: &'a str, value: &'a str, subtitle: Option<&'a str>) -> Self {
        Self {
            label,
            value,
            subtitle,
        }
    }
}

impl<'a> Widget for MetricCard<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = theme::panel_block(self.label);
        let mut lines = vec![Line::from(Span::styled(
            self.value,
            theme::metric_value_style(),
        ))];
        if let Some(s) = self.subtitle {
            lines.push(Line::from(Span::styled(s, theme::muted_style())));
        }
        Paragraph::new(lines)
            .block(block)
            .style(theme::body_style())
            .wrap(Wrap { trim: true })
            .render(area, buf);
    }
}
