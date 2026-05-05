use ratatui::{
    buffer::Buffer,
    layout::{Constraint, Rect},
    style::{Modifier, Style},
    widgets::{Block, Borders, Cell, Row, Table, Widget},
};

pub struct VirtTable<'a> {
    pub headers: Vec<&'a str>,
    pub widths: Vec<Constraint>,
    pub rows: Vec<Vec<String>>,
    pub selected: usize,
    pub title: &'a str,
}

impl<'a> Widget for VirtTable<'a> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        let widths: Vec<Constraint> = if self.widths.is_empty() {
            self.headers
                .iter()
                .map(|_| Constraint::Length(16))
                .collect()
        } else {
            self.widths.clone()
        };
        let header = Row::new(
            self.headers
                .iter()
                .map(|h| Cell::from(*h))
                .collect::<Vec<_>>(),
        )
        .style(Style::default().add_modifier(Modifier::BOLD));
        let body: Vec<Row> = self
            .rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let style = if i == self.selected {
                    Style::default().add_modifier(Modifier::REVERSED)
                } else {
                    Style::default()
                };
                Row::new(r.iter().map(|c| Cell::from(c.clone())).collect::<Vec<_>>()).style(style)
            })
            .collect();
        Table::new(body, widths)
            .header(header)
            .block(Block::default().borders(Borders::ALL).title(self.title))
            .render(area, buf);
    }
}
