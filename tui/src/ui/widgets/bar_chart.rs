use ratatui::{
    buffer::Buffer,
    layout::Rect,
    widgets::{Block, Borders, Widget},
};

pub struct HBarChart<'a> {
    pub title: &'a str,
    pub items: &'a [(String, f64)],
}

impl<'a> Widget for HBarChart<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = Block::default().borders(Borders::ALL).title(self.title);
        let inner = block.inner(area);
        block.render(area, buf);
        let max = self
            .items
            .iter()
            .map(|(_, v)| *v)
            .fold(0.0_f64, f64::max)
            .max(1.0);
        for (i, (label, v)) in self.items.iter().enumerate() {
            if i as u16 >= inner.height {
                break;
            }
            let bar_w = ((v / max) * (inner.width as f64 * 0.6)) as u16;
            let line = format!("{:<14} {:>6.2}  {}", label, v, "█".repeat(bar_w as usize));
            for (xi, ch) in line.chars().enumerate() {
                let x = inner.x + xi as u16;
                if x >= inner.x + inner.width {
                    break;
                }
                buf[(x, inner.y + i as u16)].set_symbol(&ch.to_string());
            }
        }
    }
}
