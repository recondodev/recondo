use recondo_tui::gql::queries::{
    AgentFrameworkDistribution, AgentSummary, AuditTrail, DailySpend, GatewayStatus, RealtimeFeed,
    RealtimeStats, SessionDetail, Sessions, SpendByFramework, SpendByModel, SpendByProvider,
    TopDevelopers, TopRepositories, Turn, UsageSummary,
};

#[test]
fn all_query_structs_exist() {
    // Touch every codegen'd type — link errors here mean a .graphql file is missing.
    let _ = (
        std::any::type_name::<RealtimeStats>(),
        std::any::type_name::<RealtimeFeed>(),
        std::any::type_name::<GatewayStatus>(),
        std::any::type_name::<Sessions>(),
        std::any::type_name::<SessionDetail>(),
        std::any::type_name::<Turn>(),
        std::any::type_name::<AuditTrail>(),
        std::any::type_name::<SpendByProvider>(),
        std::any::type_name::<SpendByModel>(),
        std::any::type_name::<SpendByFramework>(),
        std::any::type_name::<DailySpend>(),
        std::any::type_name::<UsageSummary>(),
        std::any::type_name::<AgentSummary>(),
        std::any::type_name::<AgentFrameworkDistribution>(),
        std::any::type_name::<TopDevelopers>(),
        std::any::type_name::<TopRepositories>(),
    );
}
