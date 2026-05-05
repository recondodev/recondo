use crate::app::keymap::Mode;
use crate::app::lens::Lens;
use crate::app::state::AppState;
use crate::lenses::help::HelpOverlay;
use crate::lenses::stub::StubLens;
use ratatui::{
    layout::Rect,
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

/// Top-level draw dispatcher. Picks the lens (or stub/help overlay) for the
/// current `AppState::lens()` and renders it into the frame, then layers any
/// modal overlay on top (palette / search prompt).
///
/// All lens state lives on `AppState`; this function is a pure projection
/// from state to frame and does not own a separate cache.
pub fn draw_app(f: &mut Frame<'_>, state: &AppState) {
    let area = f.area();
    match state.lens() {
        Lens::Realtime => state.realtime().draw(f, area),
        Lens::Sessions => state.sessions().draw(f, area),
        Lens::SessionDetail => {
            if let Some(sd) = state.session_detail() {
                sd.draw(f, area);
            } else {
                f.render_widget(
                    Paragraph::new("Loading session detail...")
                        .block(Block::default().borders(Borders::ALL).title("Session")),
                    area,
                );
            }
        }
        Lens::TurnDetail => {
            if let Some(td) = state.turn_detail() {
                td.draw(f, area);
            } else {
                f.render_widget(
                    Paragraph::new("Loading turn detail...")
                        .block(Block::default().borders(Borders::ALL).title("Turn")),
                    area,
                );
            }
        }
        Lens::Cost => state.cost().draw(f, area),
        Lens::Agents => state.agents().draw(f, area),
        Lens::AuditStub => StubLens::audit().draw(f, area),
        Lens::ReplayStub => StubLens::replay().draw(f, area),
        Lens::Help => HelpOverlay.draw(f, area),
    }
    // Overlays.
    match state.mode() {
        Mode::Palette => state.palette().draw(f, area),
        Mode::Search => {
            let h = 3.min(area.height);
            let r = Rect::new(
                area.x,
                area.y + area.height.saturating_sub(h),
                area.width,
                h,
            );
            f.render_widget(Clear, r);
            f.render_widget(
                Paragraph::new(format!("/{}", state.search()))
                    .block(Block::default().borders(Borders::ALL).title("Search")),
                r,
            );
        }
        Mode::Normal => {}
    }
}
