use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::lenses::help::HelpOverlay;

#[test]
fn help_overlay_lists_only_live_lens_keys() {
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
    assert!(dump.contains("Audit Trail"));
    assert!(
        !dump.contains("Replay"),
        "help advertises non-live replay screen"
    );
    assert!(!dump.contains("stub"), "help advertises stub screens");
}
