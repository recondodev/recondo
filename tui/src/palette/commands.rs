#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    OpenRealtime,
    OpenSessions,
    OpenCost,
    OpenAgents,
    OpenAudit,
    WindowToday,
    WindowWeek,
    WindowMonth,
    WindowAll,
    WindowSince(String),
    WindowBetween(String, String),
    Pin,
    Quit,
}
