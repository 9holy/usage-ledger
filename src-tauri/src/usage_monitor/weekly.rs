use super::{
    pricing, store,
    types::{MonitorPeriod, ScenarioTotal, Totals, UsageRecord},
};
use crate::model_catalog::CatalogSnapshot;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[path = "weekly_forecast.rs"]
mod forecast;
use forecast::{ForecastSummary, PriceSeries};
const DAY: i64 = 86_400_000;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyUsage {
    start_ms: i64,
    end_ms: i64,
    forecast_end_ms: Option<i64>,
    first_record_at_ms: Option<i64>,
    last_record_at_ms: Option<i64>,
    totals: Totals,
    reference: Vec<ReferenceSummary>,
    forecast: Vec<ForecastSummary>,
    by_tool: Vec<WeeklyTool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeeklyTool {
    tool: String,
    model: Option<String>,
    totals: Totals,
    reference: Vec<ReferenceSummary>,
    forecast: Vec<ForecastSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceSummary {
    currency: String,
    amount: Option<f64>,
    known_subtotal: f64,
    priced_requests: i64,
    unpriced_requests: i64,
    requested_model_requests: i64,
    excluded_components: Vec<String>,
    catalog_revision: Option<String>,
    rule_version: &'static str,
}

#[derive(Default)]
struct ReferenceTotal {
    amount: f64,
    requests: i64,
    requested_models: i64,
    excluded_components: BTreeSet<String>,
}
#[derive(Default)]
struct Group {
    totals: Totals,
    reference: BTreeMap<String, ReferenceTotal>,
    series: BTreeMap<String, PriceSeries>,
    unpriced: i64,
    requested_unpriced_models: i64,
    first: Option<i64>,
    last: Option<i64>,
    history_start: Option<i64>,
}

// Keep old price evidence opaque; these are the only saved fields used by the existing totals.
#[derive(Deserialize)]
struct SavedCost {
    usd: Option<f64>,
    cny: Option<f64>,
    reason: Option<String>,
    evidence: Option<SavedEvidence>,
    #[serde(default)]
    scenarios: Vec<SavedScenario>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedScenario {
    scenario_key: Option<String>,
    mode: String,
    amount: f64,
    evidence: SavedEvidence,
}
#[derive(Deserialize)]
struct SavedEvidence {
    #[serde(default = "usd")]
    currency: String,
    mode: Option<String>,
}
fn usd() -> String {
    "USD".into()
}

pub(super) fn saved_request_totals(usage: &UsageRecord, cost: &str) -> Result<Totals, String> {
    let saved = serde_json::from_str(cost).map_err(|error| error.to_string())?;
    Ok(saved_totals(usage, saved))
}

fn saved_totals(usage: &UsageRecord, cost: SavedCost) -> Totals {
    let automatic_price_summary = store::automatic_price_summary(
        usage
            .mode
            .as_deref()
            .filter(|_| usage.mode_basis == "response_reported"),
        store::effective_client_mode(
            usage.requested_mode.as_deref(),
            usage
                .unknown_fields
                .iter()
                .any(|field| field == "requested_mode_ambiguous"),
            usage.runtime_mode.as_ref(),
        ),
        cost.usd,
        cost.cny,
        cost.evidence
            .as_ref()
            .and_then(|evidence| evidence.mode.as_deref()),
        cost.reason.as_deref(),
        cost.scenarios.iter().map(|scenario| {
            (
                scenario.mode.as_str(),
                scenario.evidence.currency.as_str(),
                scenario.amount,
            )
        }),
    );
    let price_summary = store::price_summary(
        cost.usd,
        cost.cny,
        cost.scenarios.iter().map(|scenario| {
            (
                scenario.mode.as_str(),
                scenario.evidence.currency.as_str(),
                scenario.amount,
            )
        }),
    );
    let unpriced_reason = store::unpriced_reason(
        cost.usd.is_none() && cost.cny.is_none(),
        !cost.scenarios.is_empty(),
        cost.reason.as_deref(),
    );
    let cache_known = !usage
        .unknown_fields
        .iter()
        .any(|field| matches!(field.as_str(), "input_tokens" | "cache_read_tokens"));
    let mut totals = Totals {
        automatic_price_summary,
        price_summary,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        cache_write_tokens: usage.cache_write_tokens,
        request_count: 1,
        priced_cost_usd: cost.usd.unwrap_or(0.),
        priced_cost_cny: cost.cny.unwrap_or(0.),
        unpriced_requests: i64::from(cost.usd.is_none() && cost.cny.is_none()),
        scenario_requests: i64::from(!cost.scenarios.is_empty()),
        scenarios: cost
            .scenarios
            .into_iter()
            .map(|quote| ScenarioTotal {
                scenario_key: quote.scenario_key,
                mode: quote.mode,
                currency: quote.evidence.currency,
                amount: quote.amount,
                request_count: 1,
            })
            .collect(),
        incomplete_requests: i64::from(!usage.unknown_fields.is_empty()),
        cache_unknown_requests: i64::from(!cache_known),
        known_cache_input_tokens: if cache_known { usage.input_tokens } else { 0 },
        known_cache_read_tokens: if cache_known {
            usage.cache_read_tokens
        } else {
            0
        },
        cache_known_requests: i64::from(cache_known),
        ..Default::default()
    };
    let tokens_known = !usage
        .unknown_fields
        .iter()
        .any(|field| matches!(field.as_str(), "input_tokens" | "output_tokens"));
    store::add_completeness(
        &mut totals,
        usage.reasoning_tokens,
        usage
            .mode
            .as_deref()
            .filter(|_| usage.mode_basis == "response_reported"),
        usage.requested_mode.as_deref(),
        (cost.usd.is_none() && cost.cny.is_none() && tokens_known)
            .then_some(usage.input_tokens + usage.output_tokens),
        unpriced_reason,
        1,
    );
    totals
}

fn finish_group(
    mut group: Group,
    catalog: &CatalogSnapshot,
    start: i64,
    end: i64,
    horizon: Option<i64>,
) -> (Totals, Vec<ReferenceSummary>, Vec<ForecastSummary>) {
    store::finish_totals(&mut group.totals);
    for series in group.series.values_mut() {
        series.seal();
    }
    if group.reference.is_empty() && group.unpriced > 0 {
        group
            .reference
            .insert("UNKNOWN".into(), ReferenceTotal::default());
    }
    let mut references = Vec::new();
    let mut forecasts = Vec::new();
    for (currency, total) in group.reference {
        let empty = PriceSeries::default();
        forecasts.push(forecast::forecast(
            &currency,
            group.series.get(&currency).unwrap_or(&empty),
            group.history_start,
            start,
            end,
            horizon,
            total.amount,
            total.requests,
            group.unpriced,
        ));
        references.push(ReferenceSummary {
            currency,
            amount: (group.unpriced == 0).then_some(total.amount),
            known_subtotal: total.amount,
            priced_requests: total.requests,
            unpriced_requests: group.unpriced,
            requested_model_requests: total.requested_models + group.requested_unpriced_models,
            excluded_components: total.excluded_components.into_iter().collect(),
            catalog_revision: (!catalog.revision.is_empty()).then(|| catalog.revision.clone()),
            rule_version: pricing::VERSION,
        });
    }
    (group.totals, references, forecasts)
}

fn read_with_catalog(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
    forecast_end_ms: Option<i64>,
    catalog: &CatalogSnapshot,
) -> Result<WeeklyUsage, String> {
    let mut global = Group::default();
    let mut groups: BTreeMap<String, Group> =
        ["codex", "claude", "antigravity", "deepseek-harness"]
            .into_iter()
            .map(|tool| (tool.into(), Group::default()))
            .collect();
    let mut statement=conn.prepare("SELECT usage,CASE WHEN timestamp_ms>=?1 THEN cost END FROM monitor_requests WHERE timestamp_ms>=?2 AND timestamp_ms<?3 ORDER BY timestamp_ms").map_err(|error|error.to_string())?;
    let rows = statement
        .query_map(
            params![start_ms, end_ms.saturating_sub(28 * DAY), end_ms],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (json, cost) = row.map_err(|error| error.to_string())?;
        let usage: UsageRecord = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let saved = cost
            .map(|json| saved_request_totals(&usage, &json))
            .transpose()?;
        let reference = pricing::standard_reference(&usage, catalog);
        let quote = reference
            .usd
            .map(|amount| ("USD", amount))
            .or_else(|| reference.cny.map(|amount| ("CNY", amount)));
        let requested = usage.model_basis == "turn_context_requested";
        let tool = groups.entry(usage.tool.clone()).or_default();
        for group in [&mut global, tool] {
            group.history_start = Some(
                group
                    .history_start
                    .map_or(usage.timestamp_ms, |old| old.min(usage.timestamp_ms)),
            );
            if let Some((currency, amount)) = quote {
                group
                    .series
                    .entry(currency.into())
                    .or_default()
                    .push(usage.timestamp_ms, amount);
            }
            if let Some(saved) = &saved {
                store::merge_totals(&mut group.totals, saved);
                group.first = Some(
                    group
                        .first
                        .map_or(usage.timestamp_ms, |old| old.min(usage.timestamp_ms)),
                );
                group.last = Some(
                    group
                        .last
                        .map_or(usage.timestamp_ms, |old| old.max(usage.timestamp_ms)),
                );
                if let Some((currency, amount)) = quote {
                    let total = group.reference.entry(currency.into()).or_default();
                    total.amount += amount;
                    total.requests += 1;
                    total.requested_models += i64::from(requested);
                    if let Some(evidence) = &reference.evidence {
                        total
                            .excluded_components
                            .extend(evidence.excluded_components.iter().cloned());
                    }
                } else {
                    let currencies: BTreeSet<_> = reference
                        .scenarios
                        .iter()
                        .map(|quote| quote.evidence.currency.as_str())
                        .collect();
                    if currencies.len() == 1 {
                        group
                            .reference
                            .entry((*currencies.first().unwrap()).into())
                            .or_default();
                    }
                    group.unpriced += 1;
                    group.requested_unpriced_models += i64::from(requested);
                }
            }
        }
    }
    let first_record_at_ms = global.first;
    let last_record_at_ms = global.last;
    let (totals, reference, forecast) =
        finish_group(global, catalog, start_ms, end_ms, forecast_end_ms);
    let by_tool = groups
        .into_iter()
        .map(|(tool, group)| {
            let (totals, reference, forecast) =
                finish_group(group, catalog, start_ms, end_ms, forecast_end_ms);
            WeeklyTool {
                tool,
                model: None,
                totals,
                reference,
                forecast,
            }
        })
        .collect();
    Ok(WeeklyUsage {
        start_ms,
        end_ms,
        forecast_end_ms,
        first_record_at_ms,
        last_record_at_ms,
        totals,
        reference,
        forecast,
        by_tool,
    })
}

#[tauri::command]
pub async fn usage_monitor_weekly(
    start_ms: i64,
    end_ms: i64,
    forecast_end_ms: Option<i64>,
) -> Result<WeeklyUsage, String> {
    let period = MonitorPeriod {
        start_ms: Some(start_ms),
        end_ms: Some(end_ms),
        ..Default::default()
    };
    super::validate_period(&period)?;
    if end_ms - start_ms > 8 * DAY {
        return Err("Weekly query exceeds eight days".into());
    }
    if forecast_end_ms.is_some_and(|end| end < end_ms || end - start_ms > 8 * DAY) {
        return Err("Invalid weekly forecast endpoint".into());
    }
    let catalog = crate::model_catalog::snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        read_with_catalog(
            &super::connection()?,
            start_ms,
            end_ms,
            forecast_end_ms,
            &catalog,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn insert(
        conn: &Connection,
        id: &str,
        tool: &str,
        time: i64,
        model: &str,
        cost: serde_json::Value,
    ) {
        let usage = UsageRecord {
            id: id.into(),
            tool: tool.into(),
            session_id: "s".into(),
            model: Some(model.into()),
            model_basis: "turn_context_requested".into(),
            timestamp_ms: time,
            input_tokens: 1000,
            context_tokens: Some(1000),
            output_tokens: 100,
            cache_read_tokens: 800,
            mode: Some("fast".into()),
            mode_basis: "response_reported".into(),
            ..Default::default()
        };
        conn.execute("INSERT INTO monitor_requests(tool,id,session_key,timestamp_ms,usage,cost) VALUES(?1,?2,'s',?3,?4,?5)",params![tool,id,time,serde_json::to_string(&usage).unwrap(),cost.to_string()]).unwrap();
    }
    #[test]
    fn weekly_keeps_saved_quotes_separate_and_uses_half_open_window() {
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        for (id, tool, stamp, cost) in [
            (
                "a",
                "codex",
                1000,
                serde_json::json!({"usd":1.0,"evidence":{"mode":"fast"}}),
            ),
            (
                "b",
                "claude",
                1500,
                serde_json::json!({"scenarios":[{"mode":"standard","scenarioKey":"standard:peak","amount":2.0,"evidence":{"currency":"USD"}},{"mode":"fast","amount":4.0,"evidence":{"currency":"USD"}}]}),
            ),
            ("c", "codex", 2000, serde_json::json!({"usd":9.0})),
        ] {
            insert(&conn, id, tool, stamp, "gpt-6.1-sol", cost);
        }
        let week =
            read_with_catalog(&conn, 1000, 2000, Some(3000), &CatalogSnapshot::default()).unwrap();
        assert_eq!(week.totals.request_count, 2);
        assert_eq!(week.totals.total_tokens, 2200);
        assert_eq!(week.totals.priced_cost_usd, 1.0);
        assert_eq!(week.totals.scenario_requests, 1);
        assert_eq!(week.totals.scenarios[0].amount, 2.0);
        assert_eq!(
            week.totals.automatic_price_summary.by_mode["fast"].response_requests,
            2
        );
        assert_eq!(
            week.totals.automatic_price_summary.by_mode["fast"].covered_requests,
            2
        );
        assert_eq!(
            week.totals.automatic_price_summary.by_currency["USD"].response_subtotal,
            5.
        );
        assert_eq!(
            week.totals.scenarios[0].scenario_key.as_deref(),
            Some("standard:peak")
        );
        assert_eq!(week.by_tool.len(), 4);
        assert_eq!(
            week.by_tool
                .iter()
                .find(|row| row.tool == "antigravity")
                .unwrap()
                .totals
                .request_count,
            0
        );
        assert_eq!(week.first_record_at_ms, Some(1000));
        assert_eq!(week.last_record_at_ms, Some(1500));
        assert!((week.reference[0].amount.unwrap() - 0.00296).abs() < 1e-12);
        assert_eq!(week.reference[0].requested_model_requests, 2);
        assert_eq!(week.reference[0].priced_requests, 2);
        assert_eq!(week.reference[0].unpriced_requests, 0);
        let saved: String = conn
            .query_row(
                "SELECT usage FROM monitor_requests WHERE id='a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<UsageRecord>(&saved)
                .unwrap()
                .mode
                .as_deref(),
            Some("fast")
        );
        let amount: f64 = conn
            .query_row(
                "SELECT json_extract(cost,'$.usd') FROM monitor_requests WHERE id='a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(amount, 1.);
    }
    #[test]
    fn runtime_client_mode_drives_weekly_totals_not_the_standard_comparison() {
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        insert(
            &conn,
            "runtime",
            "codex",
            1000,
            "gpt-6.1-sol",
            serde_json::json!({"scenarios":[{"mode":"standard","amount":1.0,"evidence":{"currency":"USD"}},{"mode":"fast","amount":2.0,"evidence":{"currency":"USD"}}]}),
        );
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.mode',NULL,'$.modeBasis','unknown','$.requestedMode','default','$.runtimeMode',json(?1))",[serde_json::json!({"mode":"fast","conflicted":false,"observedAtMs":500,"source":"codex_turn_feedback_tag"}).to_string()]).unwrap();
        let week = read_with_catalog(&conn, 1000, 2000, None, &CatalogSnapshot::default()).unwrap();
        assert_eq!(week.totals.actual_mode_counts["unknown"], 1);
        assert_eq!(week.totals.requested_mode_counts["standard"], 1);
        assert_eq!(
            week.totals.automatic_price_summary.by_mode["fast"].requested_requests,
            1
        );
        assert_eq!(
            week.totals.automatic_price_summary.by_currency["USD"].requested_subtotal,
            2.
        );
        assert!(week.reference[0].amount.unwrap() < 1.);
    }
    #[test]
    fn reference_keeps_native_currencies_and_unknown_requests_are_not_free() {
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        insert(
            &conn,
            "usd",
            "codex",
            1000,
            "gpt-6.1-sol",
            serde_json::json!({"usd":1.0}),
        );
        insert(
            &conn,
            "cny",
            "claude",
            1500,
            "doubao-seed-2.0-code",
            serde_json::json!({"cny":2.0}),
        );
        insert(
            &conn,
            "unknown",
            "codex",
            1600,
            "qianfan-code-latest",
            serde_json::json!({"usd":null}),
        );
        let week = read_with_catalog(&conn, 1000, 2000, None, &CatalogSnapshot::default()).unwrap();
        assert_eq!(
            (week.totals.priced_cost_usd, week.totals.priced_cost_cny),
            (1., 2.)
        );
        assert_eq!(week.reference.len(), 2);
        for reference in &week.reference {
            assert!(reference.amount.is_none());
            assert!(reference.known_subtotal > 0.);
            assert_eq!(reference.priced_requests, 1);
            assert_eq!(reference.unpriced_requests, 1);
        }
        assert!(week
            .forecast
            .iter()
            .all(
                |forecast| serde_json::to_value(forecast).unwrap()["projectedSubtotal"].is_null()
            ));
        let claude = week
            .by_tool
            .iter()
            .find(|row| row.tool == "claude")
            .unwrap();
        assert_eq!(claude.reference[0].currency, "CNY");
        assert!(claude.reference[0].amount.is_some());
    }
}
