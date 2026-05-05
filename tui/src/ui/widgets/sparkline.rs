use ratatui::{
    buffer::Buffer,
    layout::Rect,
    widgets::{Block, Borders, Sparkline as RatSpark, Widget},
};

pub struct DailySpark<'a> {
    pub title: &'a str,
    pub data: &'a [u64],
}

impl<'a> Widget for DailySpark<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        RatSpark::default()
            .block(Block::default().borders(Borders::ALL).title(self.title))
            .data(self.data)
            .render(area, buf);
    }
}
