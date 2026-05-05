use crate::palette::commands::Command;

pub fn parse_command(input: &str) -> Result<Command, String> {
    let trimmed = input.trim();
    let mut parts = trimmed.split_whitespace();
    let head = parts.next().unwrap_or("");
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
        "since" => parts
            .next()
            .map(|d| Command::WindowSince(d.to_string()))
            .ok_or_else(|| "since: missing date".into()),
        "between" => {
            let a = parts.next().ok_or("between: missing start date")?;
            let b = parts.next().ok_or("between: missing end date")?;
            Ok(Command::WindowBetween(a.into(), b.into()))
        }
        "pin" => Ok(Command::Pin),
        "q" | "quit" => Ok(Command::Quit),
        other => Err(format!("unknown command: {other}")),
    }
}
