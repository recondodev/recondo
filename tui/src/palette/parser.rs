use crate::palette::commands::Command;

pub fn parse_command(input: &str) -> Result<Command, String> {
    let trimmed = input.trim();
    let head = trimmed.split_whitespace().next().unwrap_or("");
    match head {
        "realtime" => Ok(Command::OpenRealtime),
        "sessions" => Ok(Command::OpenSessions),
        "cost" => Ok(Command::OpenCost),
        "agents" => Ok(Command::OpenAgents),
        "audit" => Ok(Command::OpenAudit),
        "today" => Ok(Command::WindowToday),
        "week" => Ok(Command::WindowWeek),
        "month" => Ok(Command::WindowMonth),
        "all" => Ok(Command::WindowAll),
        "pin" => Ok(Command::Pin),
        "q" | "quit" => Ok(Command::Quit),
        other => Err(format!("unknown command: {other}")),
    }
}
