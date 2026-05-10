use ratatui::{
    style::{Color, Modifier, Style},
    widgets::{Block, Borders},
};

pub const BG: Color = Color::Rgb(7, 17, 31);
pub const SURFACE: Color = Color::Rgb(10, 25, 43);
pub const SURFACE_ELEVATED: Color = Color::Rgb(13, 33, 54);
pub const TEXT: Color = Color::Rgb(219, 234, 254);
pub const MUTED: Color = Color::Rgb(143, 164, 189);
pub const BORDER: Color = Color::Rgb(55, 78, 104);
pub const BORDER_ACTIVE: Color = Color::Rgb(45, 212, 191);

pub const ACCENT: Color = Color::Rgb(56, 189, 248);
pub const ACCENT_2: Color = Color::Rgb(45, 212, 191);
pub const OK: Color = Color::Rgb(74, 222, 128);
pub const WARN: Color = Color::Rgb(251, 191, 36);
pub const ERR: Color = Color::Rgb(251, 113, 133);
pub const INFO: Color = ACCENT;

pub const SELECTED_FG: Color = Color::Rgb(224, 242, 254);
pub const SELECTED_BG: Color = Color::Rgb(14, 76, 101);
pub const OK_BG: Color = Color::Rgb(18, 78, 54);
pub const WARN_BG: Color = Color::Rgb(91, 63, 15);
pub const ERR_BG: Color = Color::Rgb(96, 31, 49);
pub const INFO_BG: Color = Color::Rgb(14, 70, 100);
pub const MUTED_BG: Color = Color::Rgb(31, 45, 62);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusTone {
    Ok,
    Warn,
    Err,
    Info,
    Muted,
}

pub fn app_style() -> Style {
    Style::default().fg(TEXT).bg(BG)
}

pub fn body_style() -> Style {
    Style::default().fg(TEXT).bg(SURFACE)
}

pub fn elevated_body_style() -> Style {
    Style::default().fg(TEXT).bg(SURFACE_ELEVATED)
}

pub fn muted_style() -> Style {
    Style::default().fg(MUTED).bg(SURFACE)
}

pub fn title_style() -> Style {
    Style::default()
        .fg(ACCENT)
        .bg(SURFACE)
        .add_modifier(Modifier::BOLD)
}

pub fn elevated_title_style() -> Style {
    Style::default()
        .fg(ACCENT_2)
        .bg(SURFACE_ELEVATED)
        .add_modifier(Modifier::BOLD)
}

pub fn border_style() -> Style {
    Style::default().fg(BORDER).bg(SURFACE)
}

pub fn elevated_border_style() -> Style {
    Style::default().fg(BORDER_ACTIVE).bg(SURFACE_ELEVATED)
}

pub fn panel_block<'a>(title: &'a str) -> Block<'a> {
    Block::default()
        .borders(Borders::ALL)
        .title(title)
        .style(body_style())
        .border_style(border_style())
        .title_style(title_style())
}

pub fn elevated_block<'a>(title: &'a str) -> Block<'a> {
    Block::default()
        .borders(Borders::ALL)
        .title(title)
        .style(elevated_body_style())
        .border_style(elevated_border_style())
        .title_style(elevated_title_style())
}

pub fn table_header_style() -> Style {
    Style::default()
        .fg(ACCENT_2)
        .bg(SURFACE)
        .add_modifier(Modifier::BOLD)
}

pub fn selected_row_style() -> Style {
    Style::default()
        .fg(SELECTED_FG)
        .bg(SELECTED_BG)
        .add_modifier(Modifier::BOLD)
}

pub fn metric_value_style() -> Style {
    Style::default()
        .fg(ACCENT)
        .bg(SURFACE)
        .add_modifier(Modifier::BOLD)
}

pub fn chart_style() -> Style {
    Style::default().fg(ACCENT_2).bg(SURFACE)
}

pub fn status_badge_style(tone: StatusTone) -> Style {
    let (fg, bg) = match tone {
        StatusTone::Ok => (OK, OK_BG),
        StatusTone::Warn => (WARN, WARN_BG),
        StatusTone::Err => (ERR, ERR_BG),
        StatusTone::Info => (INFO, INFO_BG),
        StatusTone::Muted => (MUTED, MUTED_BG),
    };

    Style::default().fg(fg).bg(bg).add_modifier(Modifier::BOLD)
}
