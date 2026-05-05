use graphql_client::GraphQLQuery;

pub type DateTime = chrono::DateTime<chrono::Utc>;
#[allow(clippy::upper_case_acronyms)]
pub type ID = String;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/realtime_stats.graphql",
    response_derives = "Debug, Clone"
)]
pub struct RealtimeStats;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/realtime_feed.graphql",
    response_derives = "Debug, Clone"
)]
pub struct RealtimeFeed;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/gateway_status.graphql",
    response_derives = "Debug, Clone"
)]
pub struct GatewayStatus;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/sessions.graphql",
    response_derives = "Debug, Clone"
)]
pub struct Sessions;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/session_detail.graphql",
    response_derives = "Debug, Clone"
)]
pub struct SessionDetail;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/turn.graphql",
    response_derives = "Debug, Clone"
)]
pub struct Turn;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/spend_by_provider.graphql",
    response_derives = "Debug, Clone"
)]
pub struct SpendByProvider;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/spend_by_model.graphql",
    response_derives = "Debug, Clone"
)]
pub struct SpendByModel;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/spend_by_framework.graphql",
    response_derives = "Debug, Clone"
)]
pub struct SpendByFramework;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/daily_spend.graphql",
    response_derives = "Debug, Clone"
)]
pub struct DailySpend;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/usage_summary.graphql",
    response_derives = "Debug, Clone"
)]
pub struct UsageSummary;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/agent_summary.graphql",
    response_derives = "Debug, Clone"
)]
pub struct AgentSummary;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/agent_framework_distribution.graphql",
    response_derives = "Debug, Clone"
)]
pub struct AgentFrameworkDistribution;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/top_developers.graphql",
    response_derives = "Debug, Clone"
)]
pub struct TopDevelopers;

#[derive(GraphQLQuery)]
#[graphql(
    schema_path = "graphql/schema.graphql",
    query_path = "graphql/top_repositories.graphql",
    response_derives = "Debug, Clone"
)]
pub struct TopRepositories;
