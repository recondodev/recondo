use recondo_tui::gql::queries::{GatewayStatus, RealtimeFeed, RealtimeStats};

#[test]
fn realtime_stats_struct_exists() {
    let _ = std::any::type_name::<RealtimeStats>();
    let _ = std::any::type_name::<RealtimeFeed>();
    let _ = std::any::type_name::<GatewayStatus>();
}
