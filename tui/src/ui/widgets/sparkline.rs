use crate::ui::theme;
use ratatui::{
    buffer::Buffer,
    layout::Rect,
    widgets::{Sparkline as RatSpark, Widget},
};

pub struct DailySpark<'a> {
    pub title: &'a str,
    pub data: &'a [u64],
}

impl<'a> Widget for DailySpark<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        RatSpark::default()
            .block(theme::panel_block(self.title))
            .style(theme::chart_style())
            .data(self.data)
            .render(area, buf);
    }
}
