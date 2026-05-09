use recondo_tui::app::keymap::{KeyAction, Mode};
use recondo_tui::app::lens::Lens;
use recondo_tui::app::state::AppState;

#[test]
fn opening_lens_pushes_history() {
    let mut s = AppState::new();
    assert_eq!(s.lens(), Lens::Realtime);
    s.handle(KeyAction::OpenSessions);
    assert_eq!(s.lens(), Lens::Sessions);
    s.handle(KeyAction::OpenCost);
    assert_eq!(s.lens(), Lens::Cost);
    s.handle(KeyAction::HistoryBack);
    assert_eq!(s.lens(), Lens::Sessions);
}

#[test]
fn open_palette_switches_mode() {
    let mut s = AppState::new();
    assert_eq!(s.mode(), Mode::Normal);
    s.handle(KeyAction::OpenPalette);
    assert_eq!(s.mode(), Mode::Palette);
    s.handle(KeyAction::ClosePalette);
    assert_eq!(s.mode(), Mode::Normal);
}

#[test]
fn palette_submit_routes_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenPalette);
    for c in "sessions".chars() {
        s.handle(KeyAction::PaletteInput(c));
    }
    s.handle(KeyAction::Submit);
    assert_eq!(s.lens(), Lens::Sessions);
    assert_eq!(s.mode(), Mode::Normal);
}

#[test]
fn palette_submit_routes_audit_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenPalette);
    for c in "audit".chars() {
        s.handle(KeyAction::PaletteInput(c));
    }
    s.handle(KeyAction::Submit);
    assert_eq!(s.lens(), Lens::Audit);
    assert_eq!(s.mode(), Mode::Normal);
}

#[test]
fn quit_flag_set_only_in_normal_mode() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenPalette);
    s.handle(KeyAction::PaletteInput('q'));
    assert!(!s.should_quit());
    s.handle(KeyAction::ClosePalette);
    s.handle(KeyAction::Quit);
    assert!(s.should_quit());
}

#[test]
fn pin_and_jump_round_trip() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenSessions);
    s.handle(KeyAction::PinTab);
    s.handle(KeyAction::OpenCost);
    s.handle(KeyAction::JumpTab(1));
    assert_eq!(s.lens(), Lens::Sessions);
}
