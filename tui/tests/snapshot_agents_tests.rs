use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::lenses::agents::{AgentSummaryStats, AgentsLens, FrameworkSlice, TopRow};

#[test]
fn renders_summary_chart_and_tables() {
    let mut lens = AgentsLens::new();
    lens.set_summary(AgentSummaryStats {
        total_agents: 12,
        total_sessions: 47,
        average_turns_per_session: 8.5,
        unique_developers: 5,
    });
    lens.set_framework_distribution(vec![
        FrameworkSlice {
            label: "claude-code".into(),
            cost: 8.0,
        },
        FrameworkSlice {
            label: "cursor".into(),
            cost: 4.5,
        },
        FrameworkSlice {
            label: "codex".into(),
            cost: 1.7,
        },
    ]);
    lens.set_top_devs(vec![TopRow {
        label: "andmer".into(),
        sessions: 14,
        cost: 6.20,
    }]);
    lens.set_top_repos(vec![TopRow {
        label: "recondo".into(),
        sessions: 22,
        cost: 9.40,
    }]);
    let backend = TestBackend::new(140, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| lens.draw(f, f.area())).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("Agents"));
    assert!(dump.contains("8.5"));
    assert!(dump.contains("Developers"));
    assert!(!dump.contains("$0.00"));
    assert!(dump.contains("claude-code"));
    assert!(dump.contains("andmer"));
    assert!(dump.contains("recondo"));
}
