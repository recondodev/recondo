use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::lenses::help::HelpOverlay;
use recondo_tui::lenses::stub::StubLens;

#[test]
fn audit_stub_carries_v15_message() {
    let lens = StubLens::audit();
    let backend = TestBackend::new(80, 10);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| lens.draw(f, f.area())).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("Audit lens lives at /audit"));
    assert!(dump.contains("future release"));
}

#[test]
fn help_overlay_lists_lens_keys() {
    let backend = TestBackend::new(80, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| HelpOverlay.draw(f, f.area())).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    for k in &["d ", "s ", "c ", "a ", ": ", "/ "] {
        assert!(dump.contains(*k), "help overlay missing key: {k:?}\n{dump}");
    }
}
