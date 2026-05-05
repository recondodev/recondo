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
