use crate::palette::commands::Command;
use crate::palette::parser::parse_command;
use crate::ui::theme;
use ratatui::{
    layout::Rect,
    widgets::{Clear, Paragraph},
    Frame,
};

pub struct PaletteOverlay {
    buf: String,
}

impl Default for PaletteOverlay {
    fn default() -> Self {
        Self::new()
    }
}

impl PaletteOverlay {
    pub fn new() -> Self {
        Self { buf: String::new() }
    }
    pub fn buffer(&self) -> &str {
        &self.buf
    }
    pub fn input(&mut self, c: char) {
        self.buf.push(c);
    }
    pub fn backspace(&mut self) {
        self.buf.pop();
    }
    pub fn clear(&mut self) {
        self.buf.clear();
    }
    pub fn submit(&mut self) -> Result<Command, String> {
        let cmd = parse_command(&self.buf)?;
        self.buf.clear();
        Ok(cmd)
    }
    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        // Bottom 3-row modal showing ":<buffer>".
        let h = 3.min(area.height);
        let r = Rect::new(
            area.x,
            area.y + area.height.saturating_sub(h),
            area.width,
            h,
        );
        f.render_widget(Clear, r);
        f.render_widget(
            Paragraph::new(format!(":{}", self.buf))
                .style(theme::elevated_body_style())
                .block(theme::elevated_block("Command")),
            r,
        );
    }
}
