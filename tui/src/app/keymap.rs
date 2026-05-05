use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Palette,
    Search,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    Quit,
    OpenRealtime,
    OpenSessions,
    OpenCost,
    OpenAgents,
    OpenAuditStub,
    OpenReplayStub,
    OpenPalette,
    OpenSearch,
    OpenHelp,
    ClosePalette,
    CloseSearch,
    CloseOverlay,
    HistoryBack,
    HistoryForward,
    Drill,
    Pop,
    MoveUp,
    MoveDown,
    Top,
    Bottom,
    CycleFocus,
    CycleSort,
    CycleSortReverse,
    CycleFilter,
    PinTab,
    JumpTab(u8),
    PaletteInput(char),
    SearchInput(char),
    Backspace,
    Submit,
    Noop,
}

pub fn dispatch_key(ev: KeyEvent, mode: Mode) -> KeyAction {
    match (mode, ev.code, ev.modifiers) {
        (Mode::Palette, KeyCode::Esc, _) => KeyAction::ClosePalette,
        (Mode::Palette, KeyCode::Enter, _) => KeyAction::Submit,
        (Mode::Palette, KeyCode::Backspace, _) => KeyAction::Backspace,
        (Mode::Palette, KeyCode::Char(c), _) => KeyAction::PaletteInput(c),
        (Mode::Search, KeyCode::Esc, _) => KeyAction::CloseSearch,
        (Mode::Search, KeyCode::Enter, _) => KeyAction::Submit,
        (Mode::Search, KeyCode::Backspace, _) => KeyAction::Backspace,
        (Mode::Search, KeyCode::Char(c), _) => KeyAction::SearchInput(c),
        (Mode::Normal, KeyCode::Char('q'), _) => KeyAction::Quit,
        (Mode::Normal, KeyCode::Char(':'), _) => KeyAction::OpenPalette,
        (Mode::Normal, KeyCode::Char('/'), _) => KeyAction::OpenSearch,
        (Mode::Normal, KeyCode::Char('?'), _) => KeyAction::OpenHelp,
        (Mode::Normal, KeyCode::Char('d'), _) => KeyAction::OpenRealtime,
        (Mode::Normal, KeyCode::Char('s'), _) => KeyAction::OpenSessions,
        (Mode::Normal, KeyCode::Char('c'), _) => KeyAction::OpenCost,
        (Mode::Normal, KeyCode::Char('a'), _) => KeyAction::OpenAgents,
        (Mode::Normal, KeyCode::Char('A'), m) if m.contains(KeyModifiers::SHIFT) => {
            KeyAction::OpenAuditStub
        }
        (Mode::Normal, KeyCode::Char('r'), _) => KeyAction::OpenReplayStub,
        (Mode::Normal, KeyCode::Char('H'), m) if m.contains(KeyModifiers::SHIFT) => {
            KeyAction::HistoryBack
        }
        (Mode::Normal, KeyCode::Char('L'), m) if m.contains(KeyModifiers::SHIFT) => {
            KeyAction::HistoryForward
        }
        (Mode::Normal, KeyCode::Char('j'), _) => KeyAction::MoveDown,
        (Mode::Normal, KeyCode::Char('k'), _) => KeyAction::MoveUp,
        (Mode::Normal, KeyCode::Char('G'), m) if m.contains(KeyModifiers::SHIFT) => {
            KeyAction::Bottom
        }
        (Mode::Normal, KeyCode::Char('g'), _) => KeyAction::Top,
        (Mode::Normal, KeyCode::Char('o'), _) => KeyAction::CycleSort,
        (Mode::Normal, KeyCode::Char('O'), m) if m.contains(KeyModifiers::SHIFT) => {
            KeyAction::CycleSortReverse
        }
        (Mode::Normal, KeyCode::Char('f'), _) => KeyAction::CycleFilter,
        (Mode::Normal, KeyCode::Char('*'), _) => KeyAction::PinTab,
        (Mode::Normal, KeyCode::Char(c @ '1'..='9'), _) => {
            KeyAction::JumpTab(c.to_digit(10).unwrap() as u8)
        }
        (Mode::Normal, KeyCode::Tab, _) => KeyAction::CycleFocus,
        (Mode::Normal, KeyCode::Enter, _) => KeyAction::Drill,
        (Mode::Normal, KeyCode::Esc, _) => KeyAction::Pop,
        _ => KeyAction::Noop,
    }
}
