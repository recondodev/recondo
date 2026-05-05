use ratatui::{
    buffer::Buffer,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Widget, Wrap},
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
        let block = Block::default().borders(Borders::ALL).title(self.label);
        let mut lines = vec![Line::from(Span::styled(
            self.value,
            Style::default().add_modifier(Modifier::BOLD),
        ))];
        if let Some(s) = self.subtitle {
            lines.push(Line::from(Span::raw(s)));
        }
        Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: true })
            .render(area, buf);
    }
}
