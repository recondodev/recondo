use recondo_tui::palette::commands::Command;
use recondo_tui::palette::parser::parse_command;

#[test]
fn parses_lens_commands() {
    assert_eq!(parse_command("realtime"), Ok(Command::OpenRealtime));
    assert_eq!(parse_command("sessions"), Ok(Command::OpenSessions));
    assert_eq!(parse_command("cost"), Ok(Command::OpenCost));
    assert_eq!(parse_command("agents"), Ok(Command::OpenAgents));
    assert_eq!(parse_command("audit"), Ok(Command::OpenAudit));
}

#[test]
fn parses_time_window_commands() {
    assert_eq!(parse_command("today"), Ok(Command::WindowToday));
    assert_eq!(parse_command("week"), Ok(Command::WindowWeek));
    assert_eq!(parse_command("month"), Ok(Command::WindowMonth));
    assert_eq!(parse_command("all"), Ok(Command::WindowAll));
}

#[test]
fn parses_since_and_between() {
    assert_eq!(
        parse_command("since 2026-04-01"),
        Ok(Command::WindowSince("2026-04-01".into()))
    );
    assert_eq!(
        parse_command("between 2026-04-01 2026-04-15"),
        Ok(Command::WindowBetween(
            "2026-04-01".into(),
            "2026-04-15".into()
        ))
    );
}

#[test]
fn parses_pin_and_quit() {
    assert_eq!(parse_command("pin"), Ok(Command::Pin));
    assert_eq!(parse_command("q"), Ok(Command::Quit));
}

#[test]
fn unknown_command_errors() {
    assert!(parse_command("bogus").is_err());
}
