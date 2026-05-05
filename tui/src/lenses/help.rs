use ratatui::{
    layout::Rect,
    widgets::{Block, Borders, Paragraph},
    Frame,
};

pub struct HelpOverlay;

impl HelpOverlay {
    pub fn draw(&self, f: &mut Frame<'_>, area: Rect) {
        let body = "\
d   Realtime Monitor
s   Sessions
c   Cost & Usage
a   Agent Analytics
A   Audit (v1.5 stub)
r   Replay/Diff (v1.5 stub)
:   Command palette
/   Fuzzy search
?   This help
q   Quit
H/L Browser-style back/forward
*   Pin tab        1-9 jump to pinned tab
o/O Sort cycle (forward/reverse)
f   Filter (cycle or modal, lens-specific)
g   Group-by cycle (Cost lens only)
Tab Cycle focus across panels";
        f.render_widget(
            Paragraph::new(body).block(Block::default().borders(Borders::ALL).title("Help")),
            area,
        );
    }
}
