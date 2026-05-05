use crate::app::keymap::Mode;
use crate::app::lens::Lens;
use crate::app::state::AppState;
use crate::lenses::{
    agents::AgentsLens,
    cost::CostLens,
    help::HelpOverlay,
    realtime::{RealtimeLens, RealtimeSnapshot},
    session_detail::SessionDetailLens,
    sessions::SessionsLens,
    stub::StubLens,
    turn_detail::TurnDetailLens,
};
use ratatui::{
    layout::Rect,
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

/// Cached UI data the runtime keeps in sync with poll results. Optional:
/// passing `None` for the whole cache, or `None` for any individual lens
/// field, renders a minimal scaffold using the lens's empty/default state.
/// This is used by tests that want to exercise `draw_app` without spinning
/// up the polling layer or any network.
pub struct UiCache {
    pub realtime: Option<RealtimeSnapshot>,
    pub sessions: Option<SessionsLens>,
    pub cost: Option<CostLens>,
    pub agents: Option<AgentsLens>,
    pub session_detail: Option<SessionDetailLens>,
    pub turn_detail: Option<TurnDetailLens>,
}

/// Top-level draw dispatcher. Picks the lens (or stub/help overlay) for the
/// current `AppState::lens()` and renders it into the frame, then layers any
/// modal overlay on top (palette / search prompt).
pub fn draw_app(f: &mut Frame<'_>, state: &AppState, cache: Option<&UiCache>) {
    let area = f.area();
    match state.lens() {
        Lens::Realtime => {
            let snap = cache
                .and_then(|c| c.realtime.clone())
                .unwrap_or(RealtimeSnapshot {
                    healthy: false,
                    port: 8443,
                    active_providers: 0,
                    active_sessions: 0,
                    user_turns_per_min: 0,
                    tokens_last_hour: 0.0,
                    cost_last_hour: 0.0,
                    p50_ms: None,
                    p99_ms: None,
                    sample_count: 0,
                    rows: vec![],
                });
            RealtimeLens::with_snapshot(snap).draw(f, area);
        }
        Lens::Sessions => {
            if let Some(c) = cache.and_then(|c| c.sessions.as_ref()) {
                c.draw(f, area);
            } else {
                SessionsLens::with_rows(vec![]).draw(f, area);
            }
        }
        Lens::SessionDetail => {
            if let Some(c) = cache.and_then(|c| c.session_detail.as_ref()) {
                c.draw(f, area);
            }
        }
        Lens::TurnDetail => {
            if let Some(c) = cache.and_then(|c| c.turn_detail.as_ref()) {
                c.draw(f, area);
            }
        }
        Lens::Cost => {
            if let Some(c) = cache.and_then(|c| c.cost.as_ref()) {
                c.draw(f, area);
            } else {
                CostLens::new().draw(f, area);
            }
        }
        Lens::Agents => {
            if let Some(c) = cache.and_then(|c| c.agents.as_ref()) {
                c.draw(f, area);
            } else {
                AgentsLens::new().draw(f, area);
            }
        }
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
