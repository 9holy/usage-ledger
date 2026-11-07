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
    billing_totals: BTreeMap<String,Totals>,
    start_ms: i64,
    end_ms: i64,
    forecast_end_ms: Option<i64>,
    first_record_at_ms: Option<i64>,
    last_record_at_ms: Option<i64>,
    totals: Totals,
    unlocated_totals: Totals,
    unlocated_by_tool: BTreeMap<String, Totals>,
    reference: Vec<ReferenceSummary>,
    forecast: Vec<ForecastSummary>,
    by_tool: Vec<WeeklyTool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WeeklyTool {
    billing_totals: BTreeMap<String,Totals>,
    tool: String,
    model: Option<String>,
    totals: Totals,
    unlocated_totals: Totals,
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
    billing_totals: BTreeMap<String,Totals>,
    totals: Totals,
    unlocated_totals: Totals,
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
        unitemized_records: i64::from(usage.is_unitemized()),
        input_unknown_requests: i64::from(usage.unknown_fields.iter().any(|field| field == "input_tokens")),
        output_unknown_requests: i64::from(usage.unknown_fields.iter().any(|field| field == "output_tokens")),
        cache_read_unknown_requests: i64::from(usage.unknown_fields.iter().any(|field| field == "cache_read_tokens")),
        cache_write_unknown_requests: i64::from(usage.unknown_fields.iter().any(|field| field == "cache_write_tokens")),
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
) -> (Totals, Vec<ReferenceSummary>, Vec<ForecastSummary>, BTreeMap<String, Totals>, Totals) {
    store::finish_totals(&mut group.totals);
    store::finish_totals(&mut group.unlocated_totals);
    for totals in group.billing_totals.values_mut(){store::finish_totals(totals);}
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
    (group.totals, references, forecasts, group.billing_totals, group.unlocated_totals)
}

fn read_with_catalog(
    conn: &Connection,
    start_ms: i64,
    end_ms: i64,
    forecast_end_ms: Option<i64>,
    catalog: &CatalogSnapshot,
) -> Result<WeeklyUsage, String> {
    // Keep the guard and usage projection on one snapshot, including direct
    // callers. An existing outer read transaction already provides this scope.
    if conn.is_autocommit() {
        let transaction = conn.unchecked_transaction().map_err(|error| error.to_string())?;
        let result = read_with_catalog(&transaction, start_ms, end_ms, forecast_end_ms, catalog)?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(result);
    }
    store::validate_token_totals(conn)?;
    let mut global = Group::default();
    let mut groups: BTreeMap<String, Group> =
        ["codex", "claude", "antigravity", "deepseek-harness"]
            .into_iter()
            .map(|tool| (tool.into(), Group::default()))
            .collect();
    let unlocated = "(EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='timestamp') OR COALESCE(json_extract(usage,'$.usageBasis'),'') IN ('legacy_initial_cumulative','legacy_cumulative_delta'))";
    let mut statement = conn.prepare(&format!(
        "SELECT usage,CASE WHEN timestamp_ms>=?1 OR {unlocated} THEN cost END FROM monitor_requests WHERE (timestamp_ms>=?2 AND timestamp_ms<?3) OR {unlocated} ORDER BY timestamp_ms"
    )).map_err(|error| error.to_string())?;
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
        if !usage.has_period_timestamp() {
            let saved = saved.as_ref().ok_or("Missing saved cost for unlocated record")?;
            store::merge_totals(&mut global.unlocated_totals, saved);
            store::merge_totals(&mut groups.entry(usage.tool.clone()).or_default().unlocated_totals, saved);
            continue;
        }
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
                store::merge_totals(group.billing_totals.entry(super::billing::key(&usage).into()).or_default(),saved);
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
    let (totals, reference, forecast, billing_totals, unlocated_totals) =
        finish_group(global, catalog, start_ms, end_ms, forecast_end_ms);
    let by_tool: Vec<WeeklyTool> = groups
        .into_iter()
        .map(|(tool, group)| {
            let (totals, reference, forecast, billing_totals, unlocated_totals) =
                finish_group(group, catalog, start_ms, end_ms, forecast_end_ms);
            WeeklyTool {
                billing_totals,
                tool,
                model: None,
                totals,
                unlocated_totals,
                reference,
                forecast,
            }
        })
        .collect();
    let unlocated_by_tool = by_tool.iter().map(|row| (row.tool.clone(), row.unlocated_totals.clone())).collect();
    Ok(WeeklyUsage {
        billing_totals,
        start_ms,
        end_ms,
        forecast_end_ms,
        first_record_at_ms,
        last_record_at_ms,
        totals,
        unlocated_totals,
        unlocated_by_tool,
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

    #[test]
    fn unsafe_legacy_totals_cannot_publish_a_weekly_number() {
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        insert(&conn,"unsafe","codex",1000,"gpt-6.1-sol",serde_json::json!({"usd":2.}));
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.inputTokens',?1,'$.outputTokens',1)",
            [store::MAX_EXACT_TOKENS]).unwrap();
        let result = read_with_catalog(&conn,900,2000,None,&CatalogSnapshot::default());
        assert!(result.err().unwrap().contains("exact"));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|row|row.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn billing_totals_are_disjoint_and_conserve_the_full_week() {
        let conn=Connection::open_in_memory().unwrap();store::initialize(&conn).unwrap();
        for (id,kind,amount) in [("s","subscription",2.),("a","api",10.),("u","unknown",5.)] {
            insert(&conn,id,"codex",1000,"gpt-6.1-sol",serde_json::json!({"usd":amount,"evidence":{"currency":"USD","mode":"fast"}}));
            conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope',?2) WHERE id=?1",params![id,kind]).unwrap();
        }
        let result=read_with_catalog(&conn,0,2000,None,&CatalogSnapshot::default()).unwrap();
        assert_eq!(result.totals.request_count,3);
        assert_eq!(result.billing_totals["subscription"].priced_cost_usd,2.);
        assert_eq!(result.billing_totals["api"].priced_cost_usd,10.);
        assert_eq!(result.billing_totals.values().map(|r|r.priced_cost_usd).sum::<f64>(),result.totals.priced_cost_usd);
    }
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
    fn weekly_does_not_date_unknown_times_or_cumulative_history_by_file_mtime() {
        let conn=Connection::open_in_memory().unwrap();store::initialize(&conn).unwrap();
        for (id,time,basis,unknown) in [
            ("known",1000,"provider_reported",vec![]),
            ("old-unknown",1,"provider_reported",vec!["timestamp"]),
            ("future-unknown",9000,"provider_reported",vec!["timestamp"]),
            ("initial",1200,"legacy_initial_cumulative",vec!["per_request_input_tokens"]),
            ("delta",1300,"legacy_cumulative_delta",vec!["per_request_input_tokens"]),
        ] {
            insert(&conn,id,"codex",time,"gpt-6.1-sol",serde_json::json!({"usd":2.}));
            conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.usageBasis',?2,'$.unknownFields',json(?3)) WHERE id=?1",params![id,basis,serde_json::to_string(&unknown).unwrap()]).unwrap();
        }
        let week=read_with_catalog(&conn,1000,2000,None,&CatalogSnapshot::default()).unwrap();
        assert_eq!((week.totals.request_count,week.totals.total_tokens,week.totals.priced_cost_usd),(1,1100,2.));
        assert_eq!((week.first_record_at_ms,week.last_record_at_ms),(Some(1000),Some(1000)));
        let data=serde_json::to_value(week).unwrap();
        assert_eq!(data["unlocatedTotals"]["requestCount"],4);
        assert_eq!(data["unlocatedTotals"]["totalTokens"],4400);
        assert_eq!(data["unlocatedTotals"]["pricedCostUsd"],8.);
        assert_eq!(data["unlocatedTotals"]["unitemizedRecords"],2);
        assert_eq!(data["unlocatedByTool"]["codex"]["requestCount"],4);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|row|row.get::<_,i64>(0)).unwrap(),5);
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

#[cfg(test)]
mod review3_snapshot_tests {
    use super::*;
    use std::ffi::{c_char, c_int, c_void, CStr};

    struct ConcurrentWrite {
        writer: Connection,
        fired: bool,
        error: Option<String>,
    }

    unsafe extern "C" fn change_before_usage_scan(
        context: *mut c_void,
        action: c_int,
        _table: *const c_char,
        column: *const c_char,
        _database: *const c_char,
        _trigger: *const c_char,
    ) -> c_int {
        let state = &mut *context.cast::<ConcurrentWrite>();
        if !state.fired
            && action == rusqlite::ffi::SQLITE_READ
            && !column.is_null()
            && CStr::from_ptr(column).to_bytes() == b"cost"
        {
            state.fired = true;
            // A second connection commits after the numeric guard's SELECT,
            // immediately before the week's independent usage query is prepared.
            // Both rows are individually valid. Separate session writes can
            // cross the global exact-integer boundary after the read guard.
            let usage = UsageRecord {
                id: "late".into(),
                tool: "claude".into(),
                session_id: "late".into(),
                timestamp_ms: 1500,
                input_tokens: store::MAX_EXACT_TOKENS,
                ..Default::default()
            };
            let written =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
                    let tx = state
                        .writer
                        .transaction()
                        .map_err(|error| error.to_string())?;
                    store::save_usage_with_catalog(
                        &tx,
                        &usage,
                        i64::MAX,
                        0,
                        &CatalogSnapshot::default(),
                    )?;
                    tx.commit().map_err(|error| error.to_string())
                }))
                .unwrap_or_else(|_| Err("concurrent writer panicked".to_string()));
            state.error = written.err();
        }
        rusqlite::ffi::SQLITE_OK
    }

    struct AuthorizerGuard<'a>(&'a Connection);
    impl Drop for AuthorizerGuard<'_> {
        fn drop(&mut self) {
            unsafe {
                rusqlite::ffi::sqlite3_set_authorizer(self.0.handle(), None, std::ptr::null_mut());
            }
        }
    }

    #[test]
    fn weekly_validation_and_aggregation_share_one_database_snapshot() {
        let directory = std::env::temp_dir().join(format!(
            "monitor-weekly-snapshot-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("ledger.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
        store::initialize(&conn).unwrap();
        let usage = UsageRecord {
            id: "stable".into(),
            tool: "codex".into(),
            session_id: "s".into(),
            timestamp_ms: 1000,
            input_tokens: 1000,
            output_tokens: 100,
            ..Default::default()
        };
        conn.execute(
            "INSERT INTO monitor_requests VALUES('codex','stable','codex:s',1000,?1,?2)",
            params![
                serde_json::to_string(&usage).unwrap(),
                serde_json::json!({"usd":2.}).to_string()
            ],
        )
        .unwrap();
        let mut context = Box::new(ConcurrentWrite {
            writer: Connection::open(&path).unwrap(),
            fired: false,
            error: None,
        });
        context
            .writer
            .busy_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        // SQLite's test-only authorizer provides a deterministic interleaving;
        // it does not alter the reader connection or mock any business operation.
        let installed = unsafe {
            rusqlite::ffi::sqlite3_set_authorizer(
                conn.handle(),
                Some(change_before_usage_scan),
                (&mut *context as *mut ConcurrentWrite).cast(),
            )
        };
        assert_eq!(installed, rusqlite::ffi::SQLITE_OK);
        let guard = AuthorizerGuard(&conn);
        let result = read_with_catalog(&conn, 900, 2000, None, &CatalogSnapshot::default());
        drop(guard);
        assert!(
            context.fired,
            "the writer must run between validation and aggregation"
        );
        assert!(
            context.error.is_none(),
            "writer failed: {:?}",
            context.error
        );
        let week = result.unwrap();
        assert_eq!(
            (
                week.totals.request_count,
                week.totals.total_tokens,
                week.totals.priced_cost_usd
            ),
            (1, 1100, 2.),
            "a report must not publish a newer, unvalidated snapshot"
        );
        assert!(
            read_with_catalog(&conn, 900, 2000, None, &CatalogSnapshot::default()).is_err(),
            "the next report must observe and reject the committed unsafe total"
        );
        drop(context);
        drop(conn);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
