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
fn since_and_between_are_unimplemented_in_v1() {
    assert!(
        parse_command("since 2026-04-01").is_err(),
        "since is excised in v1; implement properly before re-adding"
    );
    assert!(
        parse_command("between 2026-04-01 2026-04-15").is_err(),
        "between is excised in v1; implement properly before re-adding"
    );
}

#[test]
fn replay_is_not_a_palette_command_until_it_has_a_live_data_path() {
    assert!(
        parse_command("replay").is_err(),
        "replay must not be reachable until it has a live TUI data path"
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
