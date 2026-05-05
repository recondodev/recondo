use crate::app::history::HistoryStack;
use crate::app::keymap::{KeyAction, Mode};
use crate::app::lens::Lens;
use crate::app::selection::SelectionRegistry;
use crate::app::tabs::PinnedTabs;
use crate::app::time_window::TimeWindow;
use crate::palette::commands::Command;
use crate::palette::overlay::PaletteOverlay;

pub struct AppState {
    mode: Mode,
    history: HistoryStack,
    tabs: PinnedTabs,
    selection: SelectionRegistry,
    window: TimeWindow,
    palette: PaletteOverlay,
    search_buf: String,
    quit: bool,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            mode: Mode::Normal,
            history: HistoryStack::new(Lens::Realtime),
            tabs: PinnedTabs::default(),
            selection: SelectionRegistry::default(),
            window: TimeWindow::Today,
            palette: PaletteOverlay::new(),
            search_buf: String::new(),
            quit: false,
        }
    }

    pub fn lens(&self) -> Lens {
        self.history.current()
    }
    pub fn mode(&self) -> Mode {
        self.mode
    }
    pub fn window(&self) -> TimeWindow {
        self.window
    }
    pub fn selection(&self) -> &SelectionRegistry {
        &self.selection
    }
    pub fn should_quit(&self) -> bool {
        self.quit
    }
    pub fn search(&self) -> &str {
        &self.search_buf
    }
    pub fn palette(&self) -> &PaletteOverlay {
        &self.palette
    }

    pub fn handle(&mut self, a: KeyAction) {
        use KeyAction::*;
        match (self.mode, a) {
            // Normal-mode quit handled before lens dispatch.
            (Mode::Normal, Quit) => self.quit = true,
            (Mode::Normal, OpenRealtime) => self.history.push(Lens::Realtime),
            (Mode::Normal, OpenSessions) => self.history.push(Lens::Sessions),
            (Mode::Normal, OpenCost) => self.history.push(Lens::Cost),
            (Mode::Normal, OpenAgents) => self.history.push(Lens::Agents),
            (Mode::Normal, OpenAuditStub) => self.history.push(Lens::AuditStub),
            (Mode::Normal, OpenReplayStub) => self.history.push(Lens::ReplayStub),
            (Mode::Normal, OpenHelp) => self.history.push(Lens::Help),
            (Mode::Normal, OpenPalette) => {
                self.mode = Mode::Palette;
                self.palette.clear();
            }
            (Mode::Normal, OpenSearch) => {
                self.mode = Mode::Search;
                self.search_buf.clear();
            }
            (Mode::Normal, HistoryBack) => {
                self.history.back();
            }
            (Mode::Normal, HistoryForward) => {
                self.history.forward();
            }
            (Mode::Normal, PinTab) => {
                self.tabs.pin(self.history.current());
            }
            (Mode::Normal, JumpTab(n)) => {
                if let Some(l) = self.tabs.jump(n) {
                    self.history.push(l);
                }
            }

            // Palette mode.
            (Mode::Palette, ClosePalette) => {
                self.palette.clear();
                self.mode = Mode::Normal;
            }
            (Mode::Palette, PaletteInput(c)) => self.palette.input(c),
            (Mode::Palette, Backspace) => self.palette.backspace(),
            (Mode::Palette, Submit) => {
                if let Ok(cmd) = self.palette.submit() {
                    self.apply_command(cmd);
                }
                self.mode = Mode::Normal;
            }

            // Search mode.
            (Mode::Search, CloseSearch) => {
                self.search_buf.clear();
                self.mode = Mode::Normal;
            }
            (Mode::Search, SearchInput(c)) => self.search_buf.push(c),
            (Mode::Search, Backspace) => {
                self.search_buf.pop();
            }
            (Mode::Search, Submit) => self.mode = Mode::Normal,

            _ => {}
        }
    }

    fn apply_command(&mut self, cmd: Command) {
        match cmd {
            Command::OpenRealtime => self.history.push(Lens::Realtime),
            Command::OpenSessions => self.history.push(Lens::Sessions),
            Command::OpenCost => self.history.push(Lens::Cost),
            Command::OpenAgents => self.history.push(Lens::Agents),
            Command::OpenAudit => self.history.push(Lens::AuditStub),
            Command::WindowToday => self.window = TimeWindow::Today,
            Command::WindowWeek => self.window = TimeWindow::Week,
            Command::WindowMonth => self.window = TimeWindow::Month,
            Command::WindowAll => self.window = TimeWindow::All,
            Command::WindowSince(_) | Command::WindowBetween(_, _) => {
                // v1: parsed but stored as TimeWindow::All; ad-hoc windows in v1.5+.
                self.window = TimeWindow::All;
            }
            Command::Pin => {
                self.tabs.pin(self.history.current());
            }
            Command::Quit => self.quit = true,
        }
    }
}
