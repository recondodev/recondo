use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::palette::overlay::PaletteOverlay;

#[test]
fn palette_renders_prompt_and_buffer() {
    let mut p = PaletteOverlay::new();
    for c in "sess".chars() {
        p.input(c);
    }
    let backend = TestBackend::new(80, 12);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| p.draw(f, f.area())).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(
        dump.contains(":sess"),
        "expected `:sess` prompt, got: {dump}"
    );
}

#[test]
fn backspace_removes_last_char() {
    let mut p = PaletteOverlay::new();
    for c in "abc".chars() {
        p.input(c);
    }
    p.backspace();
    assert_eq!(p.buffer(), "ab");
}

#[test]
fn submit_returns_command() {
    let mut p = PaletteOverlay::new();
    for c in "today".chars() {
        p.input(c);
    }
    let cmd = p.submit().expect("parses");
    assert!(matches!(
        cmd,
        recondo_tui::palette::commands::Command::WindowToday
    ));
}
