//! Deliverable pipeline tests for Chunk 4 (Cost data + group + drill).

use ratatui::{backend::TestBackend, Terminal};
use recondo_tui::app::keymap::KeyAction;
use recondo_tui::app::lens::Lens;
use recondo_tui::app::lens_update::LensUpdate;
use recondo_tui::app::selection::GroupKey;
use recondo_tui::app::state::AppState;
use recondo_tui::app::time_window::TimeWindow;
use recondo_tui::lenses::cost::{BreakdownRow, GroupBy};
use recondo_tui::ui::draw::draw_app;

fn breakdown_rows() -> Vec<BreakdownRow> {
    vec![
        BreakdownRow {
            key: "anthropic".into(),
            label: "Anthropic".into(),
            cost: 8.20,
            sessions: 14,
        },
        BreakdownRow {
            key: "openai".into(),
            label: "OpenAI".into(),
            cost: 3.10,
            sessions: 6,
        },
    ]
}

// ---------- D-C1: apply_update populates cost lens ----------

#[test]
fn apply_cost_breakdown_update_populates_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.apply_update(LensUpdate::CostBreakdown(breakdown_rows()));
    let labels: Vec<&str> = s
        .cost()
        .breakdown()
        .iter()
        .map(|r| r.label.as_str())
        .collect();
    assert!(labels.contains(&"Anthropic"));
    assert!(labels.contains(&"OpenAI"));
}

#[test]
fn apply_cost_total_update_populates_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.apply_update(LensUpdate::CostTotal(11.30, Some(0.42)));
    assert_eq!(s.cost().total(), 11.30);
    assert_eq!(s.cost().delta(), Some(0.42));
}

#[test]
fn apply_cost_daily_update_populates_lens() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.apply_update(LensUpdate::CostDaily(vec![
        1.0, 2.0, 3.0, 1.5, 2.5, 4.0, 3.0,
    ]));
    assert_eq!(s.cost().daily().len(), 7);
}

// ---------- D-C2: Render shows polled values ----------

#[test]
fn cost_render_shows_total_and_breakdown() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.apply_update(LensUpdate::CostTotal(11.30, Some(0.42)));
    s.apply_update(LensUpdate::CostBreakdown(breakdown_rows()));
    s.apply_update(LensUpdate::CostDaily(vec![1.0, 2.0, 3.0]));

    let backend = TestBackend::new(120, 30);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| draw_app(f, &s)).unwrap();
    let dump: String = term
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(dump.contains("$11.30"), "total cost missing: {dump}");
    assert!(dump.contains("Anthropic"), "breakdown row missing");
    assert!(dump.contains("Daily Spend"));
}

// ---------- D-C2: query vars reflect group + period ----------

#[test]
fn cost_breakdown_vars_use_current_group_by() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    let vars = s.cost_breakdown_query_vars().expect("active on Cost lens");
    assert_eq!(vars.group, GroupBy::Provider);

    // Cycle group_by via the keymap (g key on Cost lens).
    s.handle(KeyAction::Top); // After C1's fix, Top on Cost cycles group_by.
    let vars2 = s.cost_breakdown_query_vars().expect("still on Cost");
    assert_eq!(vars2.group, GroupBy::Model);
}

#[test]
fn cost_breakdown_vars_use_current_window() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.handle(KeyAction::OpenPalette);
    for c in "month".chars() {
        s.handle(KeyAction::PaletteInput(c));
    }
    s.handle(KeyAction::Submit);
    let vars = s.cost_breakdown_query_vars().expect("active on Cost lens");
    assert_eq!(vars.period, TimeWindow::Month);
}

#[test]
fn cost_query_vars_are_none_outside_cost_lens() {
    let s = AppState::new();
    // Default lens is Realtime.
    assert!(s.cost_breakdown_query_vars().is_none());
    assert!(s.cost_daily_query_vars().is_none());
    assert!(s.cost_total_query_vars().is_none());
}

// ---------- D-C4: Enter drill target writes selection.group AND opens Sessions ----------

#[test]
fn enter_on_cost_drills_to_sessions_with_provider_group() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.apply_update(LensUpdate::CostBreakdown(breakdown_rows()));
    // Default selection is row 0 → "anthropic"
    s.handle(KeyAction::Drill);
    assert_eq!(s.lens(), Lens::Sessions);
    assert_eq!(
        s.selection().group(),
        Some(&GroupKey::Provider("anthropic".into()))
    );
}

#[test]
fn enter_on_cost_with_model_group_drills_to_model_keyed_sessions() {
    let mut s = AppState::new();
    s.handle(KeyAction::OpenCost);
    s.apply_update(LensUpdate::CostBreakdown(vec![BreakdownRow {
        key: "claude-3-5-sonnet".into(),
        label: "Claude 3.5 Sonnet".into(),
        cost: 5.0,
        sessions: 10,
    }]));
    s.handle(KeyAction::Top); // cycle group to Model
    s.handle(KeyAction::Drill);
    assert_eq!(s.lens(), Lens::Sessions);
    assert_eq!(
        s.selection().group(),
        Some(&GroupKey::Model("claude-3-5-sonnet".into()))
    );

    // And Sessions's polled query vars now include the Model filter from selection.
    let session_vars = s.sessions_query_vars();
    assert_eq!(
        session_vars.filter.model.as_deref(),
        Some("claude-3-5-sonnet")
    );
}

// ---------- poll_cost_*_once tests ----------

#[tokio::test]
async fn poll_cost_breakdown_once_marshals_into_update() {
    use recondo_tui::app::state::CostBreakdownQueryVars;
    use recondo_tui::poll::cost::poll_cost_breakdown_once;
    let vars = CostBreakdownQueryVars {
        group: GroupBy::Provider,
        period: TimeWindow::Today,
    };
    let resp = build_fake_spend_by_provider_response();
    let update = poll_cost_breakdown_once(vars, |_| async { Ok(resp) }).await;
    let update = update.expect("Ok fetcher → Some update");
    match update {
        LensUpdate::CostBreakdown(rows) => assert!(!rows.is_empty()),
        _ => panic!("expected CostBreakdown variant"),
    }
}

#[tokio::test]
async fn poll_cost_total_once_marshals_into_update() {
    use recondo_tui::app::state::CostTotalQueryVars;
    use recondo_tui::poll::cost::poll_cost_total_once;
    let vars = CostTotalQueryVars {
        period: TimeWindow::Today,
    };
    let resp = build_fake_usage_summary_response();
    let update = poll_cost_total_once(vars, |_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::CostTotal(total, _delta) => {
            assert!(total > 0.0);
        }
        _ => panic!("expected CostTotal variant"),
    }
}

#[tokio::test]
async fn poll_cost_daily_once_marshals_into_update() {
    use recondo_tui::app::state::CostDailyQueryVars;
    use recondo_tui::poll::cost::poll_cost_daily_once;
    let vars = CostDailyQueryVars { days: 7 };
    let resp = build_fake_daily_spend_response();
    let update = poll_cost_daily_once(vars, |_| async { Ok(resp) }).await;
    match update.expect("Ok") {
        LensUpdate::CostDaily(values) => assert!(!values.is_empty()),
        _ => panic!("expected CostDaily variant"),
    }
}

fn build_fake_spend_by_provider_response(
) -> recondo_tui::gql::queries::spend_by_provider::ResponseData {
    use recondo_tui::gql::queries::spend_by_provider::{
        ResponseData, SpendByProviderSpendByProvider,
    };
    ResponseData {
        spend_by_provider: vec![
            SpendByProviderSpendByProvider {
                name: "anthropic".into(),
                cost_usd: 8.20,
                percentage: 72.6,
                count: 14,
            },
            SpendByProviderSpendByProvider {
                name: "openai".into(),
                cost_usd: 3.10,
                percentage: 27.4,
                count: 6,
            },
        ],
    }
}
fn build_fake_usage_summary_response() -> recondo_tui::gql::queries::usage_summary::ResponseData {
    use recondo_tui::gql::queries::usage_summary::{ResponseData, UsageSummaryUsageSummary};
    ResponseData {
        usage_summary: UsageSummaryUsageSummary {
            total_cost_usd: 11.30,
            projected_monthly_cost_usd: 339.0,
            total_tokens: 1_234_567.0,
            cache_read_tokens: 456_789.0,
            cache_read_percentage: 37.0,
            average_cost_per_session: 0.56,
            average_cost_delta: 0.42,
            cache_hit_rate: 0.41,
            cache_savings_usd: 1.20,
            cost_per_developer_per_day: 2.10,
            developer_count: 4,
        },
    }
}
fn build_fake_daily_spend_response() -> recondo_tui::gql::queries::daily_spend::ResponseData {
    use recondo_tui::gql::queries::daily_spend::{DailySpendDailySpend, ResponseData};
    ResponseData {
        daily_spend: vec![
            DailySpendDailySpend {
                name: "2026-04-29".into(),
                cost_usd: 1.0,
                percentage: 10.0,
                count: 2,
            },
            DailySpendDailySpend {
                name: "2026-04-30".into(),
                cost_usd: 2.0,
                percentage: 20.0,
                count: 3,
            },
            DailySpendDailySpend {
                name: "2026-05-01".into(),
                cost_usd: 3.0,
                percentage: 30.0,
                count: 5,
            },
            DailySpendDailySpend {
                name: "2026-05-02".into(),
                cost_usd: 1.5,
                percentage: 15.0,
                count: 4,
            },
            DailySpendDailySpend {
                name: "2026-05-03".into(),
                cost_usd: 2.5,
                percentage: 25.0,
                count: 3,
            },
        ],
    }
}
