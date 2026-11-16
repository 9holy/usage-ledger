use super::{store, types::*};
use rusqlite::{params_from_iter, types::Value, Connection};
use std::collections::{BTreeMap, BTreeSet, HashMap};

pub(super) struct UsageRow {
    pub id: String,
    pub key: String,
    pub tool: String,
    pub model: Option<String>,
    pub turn_id: String,
    pub root_turn_id: Option<String>,
    pub timestamp_ms: i64,
    pub period_locatable: bool,
    pub totals: Totals,
    pub timing: Option<RequestTiming>,
    pub output_known: bool,
}

// Project stored evidence to small numeric records; never reprice or load response bodies.
pub(super) fn each_usage(
    conn: &Connection,
    tool: Option<&str>,
    key: Option<&str>,
    period: &MonitorPeriod,
    consume: impl FnMut(UsageRow),
) -> Result<(), String> {
    project_usage(conn, tool, key, None, period, TimeSelection::Window, consume)
}

pub(super) fn each_usage_in_sessions(
    conn: &Connection,
    keys: &[String],
    period: &MonitorPeriod,
    consume: impl FnMut(UsageRow),
) -> Result<(), String> {
    project_usage(conn, None, None, Some(keys), period, TimeSelection::Window, consume)
}

pub(super) fn each_unlocated_usage(
    conn: &Connection,
    tool: Option<&str>,
    period: &MonitorPeriod,
    consume: impl FnMut(UsageRow),
) -> Result<(), String> {
    project_usage(conn, tool, None, None, period, TimeSelection::Unlocated, consume)
}

#[derive(Clone, Copy)]
enum TimeSelection {
    Window,
    Located,
    Unlocated,
}

fn project_usage(
    conn: &Connection,
    tool: Option<&str>,
    key: Option<&str>,
    keys: Option<&[String]>,
    period: &MonitorPeriod,
    time_selection: TimeSelection,
    mut consume: impl FnMut(UsageRow),
) -> Result<(), String> {
    let projection = "SELECT r.session_key,r.tool,json_extract(r.usage,'$.model'),
        COALESCE(json_extract(r.usage,'$.turnId'),''),r.timestamp_ms,
        json_extract(r.usage,'$.inputTokens'),json_extract(r.usage,'$.outputTokens'),
        json_extract(r.usage,'$.cacheReadTokens'),json_extract(r.usage,'$.cacheWriteTokens'),
        COALESCE(json_extract(r.cost,'$.usd'),0),COALESCE(json_extract(r.cost,'$.cny'),0),
        json_extract(r.cost,'$.usd') IS NULL AND json_extract(r.cost,'$.cny') IS NULL,
        COALESCE(json_array_length(r.usage,'$.unknownFields'),0)>0,
        EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value IN ('input_tokens','cache_read_tokens')),
        COALESCE(json_array_length(r.cost,'$.scenarios'),0)>0,
        (SELECT json_group_array(json_object('mode',json_extract(s.value,'$.mode'),
          'scenarioKey',json_extract(s.value,'$.scenarioKey'),
          'currency',COALESCE(json_extract(s.value,'$.evidence.currency'),'USD'),'amount',json_extract(s.value,'$.amount'),'requestCount',1))
          FROM json_each(r.cost,'$.scenarios') s),
        json_extract(r.usage,'$.reasoningTokens'),
        CASE WHEN json_extract(r.usage,'$.modeBasis')='response_reported' THEN json_extract(r.usage,'$.mode') END,
        json_extract(r.usage,'$.requestedMode'),
        CASE WHEN json_extract(r.cost,'$.usd') IS NULL AND json_extract(r.cost,'$.cny') IS NULL
          AND NOT EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value IN ('input_tokens','output_tokens'))
          THEN json_extract(r.usage,'$.inputTokens')+json_extract(r.usage,'$.outputTokens') END,
        json_extract(r.cost,'$.reason'),json_extract(r.cost,'$.usd'),json_extract(r.cost,'$.cny'),
        json_extract(r.cost,'$.evidence.mode'),
        EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='requested_mode_ambiguous'),
        json_extract(r.usage,'$.runtimeMode'),r.id,json_extract(r.usage,'$.rootTurnId'),
        (NOT EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='timestamp') AND COALESCE(json_extract(r.usage,'$.usageBasis'),'') NOT IN ('legacy_initial_cumulative','legacy_cumulative_delta')),
        EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='input_tokens'),
        EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='output_tokens'),
        EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='cache_read_tokens'),
        EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='cache_write_tokens'),
        COALESCE(json_extract(r.usage,'$.usageBasis'),'') IN ('legacy_initial_cumulative','legacy_cumulative_delta'),
        json_extract(r.usage,'$.requestTiming'),
        NOT EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='output_tokens')
        FROM monitor_requests r";
    let mut clauses = Vec::new();
    let mut values = Vec::new();
    if let Some(tool) = tool {
        clauses.push("r.tool=?");
        values.push(Value::Text(tool.into()));
    }
    if let Some(key) = key {
        clauses.push("r.session_key=?");
        values.push(Value::Text(key.into()));
    }
    if let Some(keys) = keys {
        clauses.push("r.session_key IN (SELECT value FROM json_each(?))");
        values.push(Value::Text(
            serde_json::to_string(keys).map_err(|error| error.to_string())?,
        ));
    }
    const UNLOCATED: &str = "(EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='timestamp') OR COALESCE(json_extract(r.usage,'$.usageBasis'),'') IN ('legacy_initial_cumulative','legacy_cumulative_delta'))";
    const LOCATED: &str = "(NOT EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='timestamp') AND COALESCE(json_extract(r.usage,'$.usageBasis'),'') NOT IN ('legacy_initial_cumulative','legacy_cumulative_delta'))";
    if matches!(time_selection, TimeSelection::Unlocated) {
        clauses.push(UNLOCATED);
    } else {
        let all_time = matches!(time_selection, TimeSelection::Window) && period.start_ms.is_none();
        if !all_time {
            clauses.push(LOCATED);
        }
        if let Some(start) = period.start_ms {
            clauses.push("r.timestamp_ms>=?");
            values.push(Value::Integer(start));
        }
        if let Some(end) = period.end_ms {
            clauses.push(if all_time {
                "(r.timestamp_ms<? OR EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='timestamp') OR COALESCE(json_extract(r.usage,'$.usageBasis'),'') IN ('legacy_initial_cumulative','legacy_cumulative_delta'))"
            } else {
                "r.timestamp_ms<?"
            });
            values.push(Value::Integer(end));
        }
    }
    if let Some(model) = &period.model {
        clauses.push("json_extract(r.usage,'$.model')=?");
        values.push(Value::Text(model.clone()));
    }
    if let Some(scope) = &period.billing_scope {
        clauses.push(if scope=="unknown" {"COALESCE(json_extract(r.usage,'$.billingScope'),'unknown')=?"} else {"json_extract(r.usage,'$.billingScope')=?"});
        values.push(Value::Text(scope.clone()));
    }
    let condition = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    let order = if key.is_some() || keys.is_some() {
        " ORDER BY r.timestamp_ms DESC,r.id"
    } else {
        ""
    };
    let mut stmt = conn
        .prepare(&format!("{projection}{condition}{order}"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values), |r| {
            let scenarios: String = r.get(15)?;
            let input_tokens: i64 = r.get(5)?;
            let cache_read_tokens: i64 = r.get(7)?;
            let cache_unknown_requests: i64 = r.get(13)?;
            let cache_known = cache_unknown_requests == 0;
            let mut totals = Totals {
                input_tokens,
                output_tokens: r.get(6)?,
                cache_read_tokens,
                cache_write_tokens: r.get(8)?,
                priced_cost_usd: r.get(9)?,
                priced_cost_cny: r.get(10)?,
                unpriced_requests: r.get(11)?,
                incomplete_requests: r.get(12)?,
                cache_unknown_requests,
                known_cache_input_tokens: if cache_known { input_tokens } else { 0 },
                known_cache_read_tokens: if cache_known { cache_read_tokens } else { 0 },
                cache_known_requests: i64::from(cache_known),
                scenario_requests: r.get(14)?,
                request_count: 1,
                input_unknown_requests: r.get(29)?,
                output_unknown_requests: r.get(30)?,
                cache_read_unknown_requests: r.get(31)?,
                cache_write_unknown_requests: r.get(32)?,
                unitemized_records: r.get(33)?,
                ..Default::default()
            };
            let actual: Option<String> = r.get(17)?;
            let requested: Option<String> = r.get(18)?;
            let reason: Option<String> = r.get(20)?;
            let unpriced_reason = store::unpriced_reason(
                totals.unpriced_requests > 0,
                totals.scenario_requests > 0,
                reason.as_deref(),
            );
            store::add_completeness(
                &mut totals,
                r.get(16)?,
                actual.as_deref(),
                requested.as_deref(),
                r.get(19)?,
                unpriced_reason,
                1,
            );
            Ok((
                UsageRow {
                    id: r.get(26)?,
                    key: r.get(0)?,
                    tool: r.get(1)?,
                    model: r.get(2)?,
                    turn_id: r.get(3)?,
                    root_turn_id: r.get(27)?,
                    timestamp_ms: r.get(4)?,
                    period_locatable: r.get(28)?,
                    totals,
                    timing: None,
                    output_known: r.get(35)?,
                },
                scenarios,
                r.get::<_, Option<f64>>(21)?,
                r.get::<_, Option<f64>>(22)?,
                actual,
                requested,
                reason,
                r.get::<_, Option<String>>(23)?,
                r.get::<_, bool>(24)?,
                r.get::<_, Option<String>>(25)?,
                r.get::<_, Option<String>>(34)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (
            mut row,
            scenarios,
            usd,
            cny,
            actual,
            requested,
            reason,
            evidence_mode,
            requested_ambiguous,
            runtime,
            timing,
        ) = row.map_err(|e| e.to_string())?;
        row.timing = timing.map(|json| serde_json::from_str(&json)).transpose().map_err(|e| e.to_string())?;
        row.totals.scenarios = serde_json::from_str(&scenarios).map_err(|e| e.to_string())?;
        row.totals.price_summary = store::price_summary(
            usd,
            cny,
            row.totals.scenarios.iter().map(|scenario| {
                (
                    scenario.mode.as_str(),
                    scenario.currency.as_str(),
                    scenario.amount,
                )
            }),
        );
        let runtime: Option<RuntimeModeEvidence> = runtime
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| error.to_string())?;
        row.totals.automatic_price_summary = store::automatic_price_summary(
            actual.as_deref(),
            store::effective_client_mode(
                requested.as_deref(),
                requested_ambiguous,
                runtime.as_ref(),
            ),
            usd,
            cny,
            evidence_mode.as_deref(),
            reason.as_deref(),
            row.totals.scenarios.iter().map(|scenario| {
                (
                    scenario.mode.as_str(),
                    scenario.currency.as_str(),
                    scenario.amount,
                )
            }),
        );
        consume(row);
    }
    Ok(())
}

pub fn read(
    conn: &Connection,
    tool: Option<&str>,
    period: &MonitorPeriod,
    search: &str,
    active: Option<bool>,
    unpriced_only: bool,
    offset: usize,
    limit: usize,
    now: i64,
) -> Result<MonitorAnalysis, String> {
    // Validate persisted numeric totals before any unchecked projection can merge them.
    let mut sessions = store::sessions(conn, tool, now)?;
    let end = period.end_ms.unwrap_or(now);
    let first: Option<i64> = if period.start_ms.is_some() {
        period.start_ms
    } else if let Some(tool) = tool {
        conn.query_row(
            "SELECT MIN(timestamp_ms) FROM monitor_requests WHERE timestamp_ms>0 AND tool=?1 AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='timestamp') AND COALESCE(json_extract(usage,'$.usageBasis'),'') NOT IN ('legacy_initial_cumulative','legacy_cumulative_delta')",
            [tool],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        conn.query_row(
            "SELECT MIN(timestamp_ms) FROM monitor_requests WHERE timestamp_ms>0 AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='timestamp') AND COALESCE(json_extract(usage,'$.usageBasis'),'') NOT IN ('legacy_initial_cumulative','legacy_cumulative_delta')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    };
    let start = period.start_ms.or(first).unwrap_or(end).min(end);
    let duration = end - start;
    let nominal = if duration <= 2 * 86_400_000 {
        3_600_000
    } else {
        86_400_000
    };
    let width = nominal.max((duration + 59) / 60);
    let mut timeline: Vec<_> = (0..((duration + width - 1) / width))
        .map(|index| UsageBucket {
            start_ms: start + index * width,
            end_ms: (start + (index + 1) * width).min(end),
            totals: Totals::default(),
        })
        .collect();
    let mut totals = Totals::default();
    let mut unlocated_totals = Totals::default();
    let mut unlocated_by_tool = BTreeMap::<String, Totals>::new();
    let mut by_model = BTreeMap::<(String, Option<String>), Totals>::new();
    let mut model_speeds = BTreeMap::<(String, Option<String>), BTreeMap<String, WeightedRequestSpeed>>::new();
    let mut by_tool = BTreeMap::<String, Totals>::new();
    let mut tool_overview: BTreeMap<String, Totals> =
        ["codex", "claude", "antigravity", "deepseek-harness"]
            .into_iter()
            .map(|tool| (tool.into(), Totals::default()))
            .collect();
    let mut by_session = HashMap::<String, (i64, Totals, bool)>::new();
    let mut models = BTreeSet::new();
    let all_models = MonitorPeriod {
        model: None,
        end_ms: Some(end),
        ..period.clone()
    };
    let mut consume = |row: UsageRow| {
        if !row.period_locatable {
            let model_matches = period.model.as_ref().map_or(true, |model| row.model.as_ref() == Some(model));
            if model_matches {
                store::merge_totals(unlocated_by_tool.entry(row.tool.clone()).or_default(), &row.totals);
                if tool.map_or(true, |selected| selected == row.tool) {
                    store::merge_totals(&mut unlocated_totals, &row.totals);
                }
            }
            // File modification/collection time cannot establish an event's accounting period.
            // The all-time view retains these records; a bounded period lists them separately.
            if period.start_ms.is_some() {
                return;
            }
        }
        store::merge_totals(
            tool_overview.entry(row.tool.clone()).or_default(),
            &row.totals,
        );
        if tool.is_some_and(|selected| selected != row.tool) {
            return;
        }
        if let Some(model) = &row.model {
            models.insert(model.clone());
        }
        if period
            .model
            .as_ref()
            .is_some_and(|model| row.model.as_ref() != Some(model))
        {
            return;
        }
        store::merge_totals(&mut totals, &row.totals);
        if let Some(timing) = row.timing.filter(|timing| !timing.basis.is_empty()) {
            let speeds = model_speeds.entry((row.tool.clone(), row.model.clone())).or_default();
            let speed = speeds.entry(timing.basis.clone()).or_insert_with(|| WeightedRequestSpeed { basis: Some(timing.basis.clone()), ..Default::default() });
            speed.total_samples += 1;
            let usage = UsageRecord { output_tokens: row.totals.output_tokens, request_timing: Some(timing), ..Default::default() };
            if row.output_known {
                if let Some(sample) = store::speed_sample(&usage) { store::add_speed(speed, &sample); }
            }
        }
        store::merge_totals(
            by_model.entry((row.tool.clone(), row.model)).or_default(),
            &row.totals,
        );
        store::merge_totals(by_tool.entry(row.tool).or_default(), &row.totals);
        let matches = (!unpriced_only || store::current_unpriced_requests(&row.totals) > 0)
            && period.pricing_reason.as_ref().map_or(true, |reason| {
                row.totals.unpriced_reason_counts.contains_key(reason)
            });
        let session = by_session.entry(row.key).or_default();
        session.0 = session.0.max(row.timestamp_ms);
        store::merge_totals(&mut session.1, &row.totals);
        session.2 |= matches;
        if row.period_locatable && row.timestamp_ms >= start && row.timestamp_ms < end {
            if let Some(bucket) = timeline.get_mut(((row.timestamp_ms - start) / width) as usize) {
                store::merge_totals(&mut bucket.totals, &row.totals);
            }
        }
    };
    project_usage(conn, None, None, None, &all_models, TimeSelection::Located, &mut consume)?;
    each_unlocated_usage(conn, None, &all_models, &mut consume)?;
    store::finish_totals(&mut totals);
    store::finish_totals(&mut unlocated_totals);
    for totals in unlocated_by_tool.values_mut() {
        store::finish_totals(totals);
    }
    for bucket in &mut timeline {
        store::finish_totals(&mut bucket.totals);
    }
    sessions.retain_mut(|session| {
        if let Some((stamp, mut total, matches)) = by_session.remove(&session.key) {
            if !matches {
                return false;
            }
            store::finish_totals(&mut total);
            session.totals = total;
            session.meta.updated_at_ms = stamp;
            if period.model.is_some() {
                session.meta.model = period.model.clone();
            }
            true
        } else {
            false
        }
    });
    store::filter_sessions(&mut sessions, search, active, false);
    sessions.sort_by_key(|session| std::cmp::Reverse(session.meta.updated_at_ms));
    let session_count = sessions.len();
    let mut sessions: Vec<_> = sessions.into_iter().skip(offset).take(limit).collect();
    store::enrich_session_outputs_scoped(conn, &mut [&mut sessions],period.billing_scope.as_deref())?;
    if period.billing_scope.is_some() && period.model.is_none() {
        for session in &mut sessions {
            session.meta.model=session.recent_request.as_ref().and_then(|request|request.model.clone());
        }
    }
    let mut latest = BTreeMap::new();
    for source in ["codex", "claude", "antigravity", "deepseek-harness","api"] {
        let stamp: Option<i64> = conn
            .query_row(
                "SELECT MAX(timestamp_ms) FROM monitor_requests WHERE tool=?1 AND timestamp_ms>0 AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='timestamp') AND COALESCE(json_extract(usage,'$.usageBasis'),'') NOT IN ('legacy_initial_cumulative','legacy_cumulative_delta')",
                [source],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        latest.insert(source.to_owned(), stamp);
    }
    // Rate history follows observation time, including requests that began before this period.
    let history_start = (start + 59_999) / 60_000 * 60_000;
    let history_end = end / 60_000 * 60_000;
    let history_width = (width + 59_999) / 60_000 * 60_000;
    let coverage = super::live::history_coverage(conn, history_start, history_end)?;
    let mut observed = BTreeMap::<i64, i64>::new();
    for samples in super::local_cost::observed_samples_scoped(conn, history_start, history_end, tool, period)?.into_values() {
        for (time, tokens) in samples { *observed.entry((time - history_start) / history_width).or_default() += tokens; }
    }
    let observed_timeline = (0..((history_end - history_start).max(0) + history_width - 1) / history_width).map(|index| {
        let begin = history_start + index * history_width;
        super::live::history_bucket(&coverage, tool, begin, (begin + history_width).min(history_end), observed.get(&index).copied().unwrap_or(0))
    }).collect();
    Ok(MonitorAnalysis {
        start_ms: period.start_ms,
        end_ms: end,
        totals,
        unlocated_totals,
        unlocated_by_tool,
        timeline,
        observed_timeline,
        api_expense: None,
        cny_per_usd: None,
        cost_error: None,
        available_models: models.into_iter().collect(),
        sessions,
        session_count,
        latest_request_at_ms: latest,
        tool_overview: tool_overview
            .into_iter()
            .map(|(tool, mut totals)| {
                store::finish_totals(&mut totals);
                UsageBreakdown {
                    tool,
                    model: None,
                    totals,
                    speeds: Vec::new(),
                }
            })
            .collect(),
        by_tool: by_tool
            .into_iter()
            .map(|(tool, mut totals)| {
                store::finish_totals(&mut totals);
                UsageBreakdown {
                    tool,
                    model: None,
                    totals,
                    speeds: Vec::new(),
                }
            })
            .collect(),
        by_model: by_model
            .into_iter()
            .map(|((tool, model), mut totals)| {
                store::finish_totals(&mut totals);
                UsageBreakdown {
                    speeds: model_speeds.remove(&(tool.clone(), model.clone())).unwrap_or_default().into_values().collect(),
                    tool,
                    model,
                    totals,
                }
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    #[test]
    fn model_expenses_and_rates_follow_scope_but_history_uses_observation_time() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::ledger_db::migrate(&mut conn).unwrap();
        store::initialize(&conn).unwrap();
        for (id, tool, model, scope, time, output, duration) in [
            ("a", "codex", "m", "api", 120_000, 10, 1_000),
            ("b", "codex", "m", "api", 180_000, 90, 9_000),
            ("sub", "codex", "m", "subscription", 180_000, 900, 1_000),
            ("other-tool", "claude", "m", "api", 180_000, 400, 1_000),
            ("other-model", "codex", "other", "api", 180_000, 500, 1_000),
            ("earlier", "codex", "m", "api", 30_000, 30, 1_000),
        ] {
            let usage = UsageRecord {
                id: id.into(), tool: tool.into(), model: Some(model.into()), billing_scope: Some(scope.into()),
                timestamp_ms: time, input_tokens: 100, output_tokens: output, requested_mode: Some("standard".into()),
                request_timing: Some(RequestTiming { basis: "request".into(), duration_ms: Some(duration), ..Default::default() }),
                ..Default::default()
            };
            conn.execute("INSERT INTO monitor_requests VALUES(?1,?2,'session',?3,?4,?5)", params![tool, id, time, serde_json::to_string(&usage).unwrap(), r#"{"usd":10,"evidence":{"currency":"USD","mode":"standard"}}"#]).unwrap();
        }
        conn.execute_batch("INSERT INTO monitor_output_history VALUES('codex','earlier',120000,600);
          INSERT INTO monitor_observations VALUES('codex','b','session',190000,90);
          INSERT INTO monitor_observations VALUES('codex','sub','session',190000,900);
          INSERT INTO monitor_observations VALUES('claude','other-tool','session',190000,400);
          INSERT INTO monitor_observations VALUES('codex','other-model','session',190000,500);
          INSERT INTO monitor_coverage_history VALUES('test','codex',60000,180000);
          INSERT INTO monitor_coverage_history VALUES('test','*',60000,180000);").unwrap();
        let period = MonitorPeriod { start_ms: Some(60_000), end_ms: Some(240_000), model: Some("m".into()), billing_scope: Some("api".into()), ..Default::default() };
        let result = read(&conn, Some("codex"), &period, "", None, false, 0, 100, 240_000).unwrap();
        assert_eq!((result.totals.request_count, result.totals.output_tokens), (2, 100));
        assert_eq!(result.by_model.len(), 1);
        let speed = &result.by_model[0].speeds[0];
        assert_eq!((speed.valid_samples, speed.duration_ms, speed.output_tokens_per_second), (2, 10_000, Some(10.)));
        let history = &result.observed_timeline[0];
        assert_eq!((history.observed_output_tokens, history.covered_ms, history.output_tokens), (690, 120_000, None));
        let settings: super::super::local_cost::Settings = serde_json::from_value(serde_json::json!({
            "cnyPerUsd": 7, "accounts": {}, "apiRules": [{ "model": null, "startMs": 0, "currency": "USD", "multiplier": 0.2 }]
        })).unwrap();
        let expense = super::super::local_cost::api_expense_scoped(&conn, 60_000, 240_000, &settings, Some("codex"), &period).unwrap();
        assert_eq!((expense.priced_requests, expense.missing_requests, expense.by_currency["USD"]), (2, 0, 4.));
        let subscription = MonitorPeriod { billing_scope: Some("subscription".into()), ..period };
        let expense = super::super::local_cost::api_expense_scoped(&conn, 60_000, 240_000, &settings, Some("codex"), &subscription).unwrap();
        assert_eq!(expense.priced_requests + expense.missing_requests, 0);
    }
}
