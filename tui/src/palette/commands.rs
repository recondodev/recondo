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
    Pin,
    Quit,
}
