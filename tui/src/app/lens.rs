#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lens {
    Realtime,
    Sessions,
    SessionDetail,
    TurnDetail,
    Cost,
    Agents,
    Audit,
    Help,
}
