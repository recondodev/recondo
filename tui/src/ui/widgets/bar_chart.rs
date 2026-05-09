use crate::ui::theme;
use ratatui::{buffer::Buffer, layout::Rect, style::Style, widgets::Widget};

pub struct HBarChart<'a> {
    pub title: &'a str,
    pub items: &'a [(String, f64)],
}

impl<'a> Widget for HBarChart<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let block = theme::panel_block(self.title);
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
            let y = inner.y + i as u16;
            let label_text = format!("{label:<14}");
            let value_text = format!(" {v:>6.2}  ");
            let x = write_styled(buf, inner, y, inner.x, &label_text, theme::muted_style());
            let x = write_styled(buf, inner, y, x, &value_text, theme::body_style());
            write_styled(
                buf,
                inner,
                y,
                x,
                &"█".repeat(bar_w as usize),
                theme::chart_style(),
            );
        }
    }
}

fn write_styled(
    buf: &mut Buffer,
    bounds: Rect,
    y: u16,
    start_x: u16,
    text: &str,
    style: Style,
) -> u16 {
    let mut x = start_x;
    for ch in text.chars() {
        if x >= bounds.x + bounds.width {
            break;
        }
        buf[(x, y)].set_symbol(&ch.to_string()).set_style(style);
        x += 1;
    }
    x
}
