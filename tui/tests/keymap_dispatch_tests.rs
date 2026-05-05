use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use recondo_tui::app::keymap::{dispatch_key, KeyAction, Mode};

fn k(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
}
fn shift(c: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(c), KeyModifiers::SHIFT)
}

#[test]
fn lens_keys_route_correctly() {
    assert_eq!(dispatch_key(k('d'), Mode::Normal), KeyAction::OpenRealtime);
    assert_eq!(dispatch_key(k('s'), Mode::Normal), KeyAction::OpenSessions);
    assert_eq!(dispatch_key(k('c'), Mode::Normal), KeyAction::OpenCost);
    assert_eq!(dispatch_key(k('a'), Mode::Normal), KeyAction::OpenAgents);
    assert_eq!(
        dispatch_key(shift('A'), Mode::Normal),
        KeyAction::OpenAuditStub
    );
    assert_eq!(
        dispatch_key(k('r'), Mode::Normal),
        KeyAction::OpenReplayStub
    );
}

#[test]
fn navigation_keys() {
    assert_eq!(dispatch_key(k('q'), Mode::Normal), KeyAction::Quit);
    assert_eq!(dispatch_key(k(':'), Mode::Normal), KeyAction::OpenPalette);
    assert_eq!(dispatch_key(k('/'), Mode::Normal), KeyAction::OpenSearch);
    assert_eq!(dispatch_key(k('?'), Mode::Normal), KeyAction::OpenHelp);
    assert_eq!(
        dispatch_key(shift('H'), Mode::Normal),
        KeyAction::HistoryBack
    );
    assert_eq!(
        dispatch_key(shift('L'), Mode::Normal),
        KeyAction::HistoryForward
    );
}

#[test]
fn palette_mode_swallows_keys() {
    // Inside palette: q is literal text, Esc closes.
    assert_eq!(
        dispatch_key(k('q'), Mode::Palette),
        KeyAction::PaletteInput('q')
    );
    assert_eq!(
        dispatch_key(
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
            Mode::Palette
        ),
        KeyAction::ClosePalette
    );
}
