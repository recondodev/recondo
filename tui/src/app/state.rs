use crate::app::history::HistoryStack;
use crate::app::keymap::{KeyAction, Mode};
use crate::app::lens::Lens;
use crate::app::selection::SelectionRegistry;
use crate::app::tabs::PinnedTabs;
use crate::app::time_window::TimeWindow;
use crate::lenses::agents::AgentsLens;
use crate::lenses::cost::{drill_target, CostLens};
use crate::lenses::realtime::RealtimeLens;
use crate::lenses::session_detail::SessionDetailLens;
use crate::lenses::sessions::SessionsLens;
use crate::lenses::turn_detail::TurnDetailLens;
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
    // Lens state — owned by AppState so handle() can mutate the active lens.
    realtime: RealtimeLens,
    sessions: SessionsLens,
    cost: CostLens,
    agents: AgentsLens,
    session_detail: Option<SessionDetailLens>,
    turn_detail: Option<TurnDetailLens>,
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
            realtime: RealtimeLens::new(),
            sessions: SessionsLens::new(),
            cost: CostLens::new(),
            agents: AgentsLens::new(),
            session_detail: None,
            turn_detail: None,
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

    // ---- Lens accessors ----------------------------------------------------

    pub fn realtime(&self) -> &RealtimeLens {
        &self.realtime
    }
    pub fn realtime_mut(&mut self) -> &mut RealtimeLens {
        &mut self.realtime
    }

    pub fn sessions(&self) -> &SessionsLens {
        &self.sessions
    }
    pub fn sessions_mut(&mut self) -> &mut SessionsLens {
        &mut self.sessions
    }

    pub fn cost(&self) -> &CostLens {
        &self.cost
    }
    pub fn cost_mut(&mut self) -> &mut CostLens {
        &mut self.cost
    }

    pub fn agents(&self) -> &AgentsLens {
        &self.agents
    }
    pub fn agents_mut(&mut self) -> &mut AgentsLens {
        &mut self.agents
    }

    pub fn session_detail(&self) -> Option<&SessionDetailLens> {
        self.session_detail.as_ref()
    }
    pub fn session_detail_mut(&mut self) -> Option<&mut SessionDetailLens> {
        self.session_detail.as_mut()
    }
    pub fn set_session_detail(&mut self, v: Option<SessionDetailLens>) {
        self.session_detail = v;
    }

    pub fn turn_detail(&self) -> Option<&TurnDetailLens> {
        self.turn_detail.as_ref()
    }
    pub fn turn_detail_mut(&mut self) -> Option<&mut TurnDetailLens> {
        self.turn_detail.as_mut()
    }
    pub fn set_turn_detail(&mut self, v: Option<TurnDetailLens>) {
        self.turn_detail = v;
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

            // ---- Lens-aware list navigation -------------------------------
            (Mode::Normal, MoveDown) => self.dispatch_move_down(),
            (Mode::Normal, MoveUp) => self.dispatch_move_up(),
            (Mode::Normal, Top) => self.dispatch_top(),
            (Mode::Normal, Bottom) => self.dispatch_bottom(),

            // ---- Lens-aware actions ---------------------------------------
            (Mode::Normal, CycleSort) => {
                if matches!(self.history.current(), Lens::Sessions) {
                    self.sessions.cycle_sort();
                }
            }
            (Mode::Normal, CycleSortReverse) => {
                if matches!(self.history.current(), Lens::Sessions) {
                    self.sessions.cycle_sort_reverse();
                }
            }
            (Mode::Normal, CycleFilter) => self.dispatch_cycle_filter(),
            (Mode::Normal, CycleFocus) => self.dispatch_cycle_focus(),
            (Mode::Normal, Drill) => self.dispatch_drill(),
            (Mode::Normal, Pop) => self.dispatch_pop(),

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

    // ---- Lens-aware dispatch helpers --------------------------------------

    fn dispatch_move_down(&mut self) {
        match self.history.current() {
            Lens::Sessions => self.sessions.select_next(),
            Lens::Cost => self.cost.select_next(),
            Lens::Realtime => self.realtime.select_next(),
            Lens::SessionDetail => {
                if let Some(sd) = self.session_detail.as_mut() {
                    sd.select_next();
                }
            }
            Lens::Agents => self.agents.select_next(),
            _ => {}
        }
    }

    fn dispatch_move_up(&mut self) {
        match self.history.current() {
            Lens::Sessions => self.sessions.select_prev(),
            Lens::Cost => self.cost.select_prev(),
            Lens::Realtime => self.realtime.select_prev(),
            Lens::SessionDetail => {
                if let Some(sd) = self.session_detail.as_mut() {
                    sd.select_prev();
                }
            }
            Lens::Agents => self.agents.select_prev(),
            _ => {}
        }
    }

    fn dispatch_top(&mut self) {
        match self.history.current() {
            Lens::Sessions => self.sessions.select_top(),
            // Cost lens: `g` cycles group-by (advertised in `[g] group:` chip
            // and help overlay) instead of jumping selection to top.
            Lens::Cost => self.cost.cycle_group_by(),
            Lens::Realtime => self.realtime.select_top(),
            Lens::SessionDetail => {
                if let Some(sd) = self.session_detail.as_mut() {
                    sd.select_top();
                }
            }
            Lens::Agents => self.agents.select_top(),
            _ => {}
        }
    }

    fn dispatch_bottom(&mut self) {
        match self.history.current() {
            Lens::Sessions => self.sessions.select_bottom(),
            Lens::Cost => self.cost.select_bottom(),
            Lens::Realtime => self.realtime.select_bottom(),
            Lens::SessionDetail => {
                if let Some(sd) = self.session_detail.as_mut() {
                    sd.select_bottom();
                }
            }
            Lens::Agents => self.agents.select_bottom(),
            _ => {}
        }
    }

    fn dispatch_cycle_filter(&mut self) {
        match self.history.current() {
            Lens::Sessions => self.sessions.open_filter(),
            Lens::Realtime => self.realtime.cycle_provider_filter(),
            _ => {}
        }
    }

    fn dispatch_cycle_focus(&mut self) {
        match self.history.current() {
            Lens::Realtime => self.realtime.cycle_focus(),
            Lens::Cost => self.cost.cycle_focus(),
            Lens::Agents => self.agents.cycle_focus(),
            _ => {}
        }
    }

    fn dispatch_drill(&mut self) {
        match self.history.current() {
            Lens::Sessions => {
                let id = self.sessions.selected_id().map(|s| s.to_string());
                if let Some(id) = id {
                    self.selection.set_session(Some(id));
                    self.history.push(Lens::SessionDetail);
                }
            }
            Lens::SessionDetail => {
                let id = self
                    .session_detail
                    .as_ref()
                    .and_then(|sd| sd.selected_turn_id())
                    .map(|s| s.to_string());
                if let Some(id) = id {
                    self.selection.set_turn(Some(id));
                    self.history.push(Lens::TurnDetail);
                }
            }
            Lens::Cost => {
                drill_target(&self.cost, &mut self.selection);
                self.history.push(Lens::Sessions);
            }
            _ => {}
        }
    }

    fn dispatch_pop(&mut self) {
        // If a modal is open on the active lens, close it first instead of
        // popping history. Esc-twice pops both.
        if matches!(self.history.current(), Lens::Sessions) && self.sessions.filter_open() {
            self.sessions.close_filter();
            return;
        }
        self.history.back();
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
