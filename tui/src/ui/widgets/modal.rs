use ratatui::{
    buffer::Buffer,
    layout::Rect,
    widgets::{Block, Borders, Clear, Paragraph, Widget},
};

/// Centered modal overlay used by lenses to surface filter/help dialogs over
/// their main content. The modal occupies 60% width × 40% height of the area
/// it is rendered into and clears the underlying buffer cells before drawing.
pub struct Modal<'a> {
    pub title: &'a str,
    pub body: Vec<String>,
}

impl<'a> Widget for Modal<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let w = (area.width as f32 * 0.6) as u16;
        let h = (area.height as f32 * 0.4) as u16;
        let x = area.x + area.width.saturating_sub(w) / 2;
        let y = area.y + area.height.saturating_sub(h) / 2;
        let r = Rect::new(x, y, w, h);
        Clear.render(r, buf);
        let text = self.body.join("\n");
        Paragraph::new(text)
            .block(Block::default().borders(Borders::ALL).title(self.title))
            .render(r, buf);
    }
}
