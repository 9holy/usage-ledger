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
        COALESCE(json_extract(r.usage,'$.usageBasis'),'') IN ('legacy_initial_cumulative','legacy_cumulative_delta')
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
        ) = row.map_err(|e| e.to_string())?;
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
    store::enrich_session_outputs(conn, &mut [&mut sessions])?;
    let mut latest = BTreeMap::new();
    for source in ["codex", "claude", "antigravity", "deepseek-harness"] {
        let stamp: Option<i64> = conn
            .query_row(
                "SELECT MAX(timestamp_ms) FROM monitor_requests WHERE tool=?1 AND timestamp_ms>0 AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='timestamp') AND COALESCE(json_extract(usage,'$.usageBasis'),'') NOT IN ('legacy_initial_cumulative','legacy_cumulative_delta')",
                [source],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        latest.insert(source.to_owned(), stamp);
    }
    Ok(MonitorAnalysis {
        start_ms: period.start_ms,
        end_ms: end,
        totals,
        unlocated_totals,
        unlocated_by_tool,
        timeline,
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
                }
            })
            .collect(),
        by_model: by_model
            .into_iter()
            .map(|((tool, model), mut totals)| {
                store::finish_totals(&mut totals);
                UsageBreakdown {
                    tool,
                    model,
                    totals,
                }
            })
            .collect(),
    })
}


#[cfg(test)]
mod audit_accuracy_tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;

    fn insert(conn: &Connection, id: &str, tool: &str, timestamp: i64, input: i64, unknown: &[&str], basis: &str, cost: serde_json::Value) -> UsageRecord {
        let usage = UsageRecord {
            id: id.into(), tool: tool.into(), session_id: "session".into(), turn_id: id.into(),
            timestamp_ms: timestamp, input_tokens: input, output_tokens: input / 10,
            cache_read_tokens: input / 2, model: Some(format!("model-{tool}")),
            unknown_fields: unknown.iter().map(|field| (*field).into()).collect(),
            usage_basis: basis.into(), ..Default::default()
        };
        let key = format!("{tool}:session");
        let meta = SessionMeta { tool: tool.into(), id: "session".into(), status: "idle".into(), updated_at_ms: timestamp, ..Default::default() };
        conn.execute("INSERT OR IGNORE INTO monitor_sessions(key,tool,meta,totals,updated_ms) VALUES(?1,?2,?3,?4,?5)",
            params![key,tool,serde_json::to_string(&meta).unwrap(),serde_json::to_string(&Totals::default()).unwrap(),timestamp]).unwrap();
        conn.execute("INSERT INTO monitor_requests(tool,id,session_key,timestamp_ms,usage,cost) VALUES(?1,?2,?3,?4,?5,?6)",
            params![tool,id,key,timestamp,serde_json::to_string(&usage).unwrap(),cost.to_string()]).unwrap();
        usage
    }

    #[test]
    fn legacy_scenario_currency_matches_saved_account_and_weekly_totals() {
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let mut saved = Totals::default();
        for (id,cost) in [
            ("legacy-usd",json!({"scenarios":[{"mode":"standard","amount":2.5,"evidence":{}}]})),
            ("explicit-cny",json!({"scenarios":[{"mode":"standard","amount":20.,"evidence":{"currency":"CNY"}}]})),
        ] {
            let usage = insert(&conn,id,"codex",1000,100,&[],"provider_reported",cost.clone());
            store::merge_totals(&mut saved,&super::super::weekly::saved_request_totals(&usage,&cost.to_string()).unwrap());
        }
        let mut projected = Totals::default();
        each_usage(&conn,None,None,&MonitorPeriod::default(),|row| store::merge_totals(&mut projected,&row.totals)).unwrap();
        store::finish_totals(&mut projected);
        store::finish_totals(&mut saved);
        assert_eq!(serde_json::to_value(&projected).unwrap(),serde_json::to_value(saved).unwrap());
        assert_eq!((projected.request_count,projected.total_tokens),(2,220));
        assert_eq!(projected.price_summary.by_currency["USD"].standard_subtotal,2.5);
        assert_eq!(projected.price_summary.by_currency["CNY"].standard_subtotal,20.);
    }

    #[test]
    fn bounded_periods_exclude_unlocated_usage_and_all_time_keeps_it_once() {
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        for (id,tool,time,input,unknown,basis) in [
            ("known","codex",1000,100,vec![],"provider_reported"),
            ("outside","codex",3000,200,vec![],"provider_reported"),
            ("missing-time","codex",1500,300,vec!["timestamp"],"provider_reported"),
            ("future-mtime","claude",5000,400,vec!["timestamp"],"assistant_message_usage"),
            ("old-cumulative","codex",1200,500,vec!["per_request_input_tokens"],"legacy_initial_cumulative"),
            ("cumulative-delta","codex",1300,600,vec!["per_request_input_tokens"],"legacy_cumulative_delta"),
        ] {
            insert(&conn,id,tool,time,input,&unknown,basis,json!({"usd":1.}));
        }
        let period=MonitorPeriod{start_ms:Some(900),end_ms:Some(2000),..Default::default()};
        let bounded=read(&conn,None,&period,"",None,false,0,100,2000).unwrap();
        assert_eq!((bounded.totals.request_count,bounded.totals.total_tokens),(1,110));
        assert_eq!(bounded.timeline.iter().map(|bucket|bucket.totals.total_tokens).sum::<i64>(),110);
        let data=serde_json::to_value(&bounded).unwrap();
        assert_eq!(data["unlocatedTotals"]["requestCount"],4);
        assert_eq!(data["unlocatedTotals"]["totalTokens"],1980);
        assert_eq!(data["unlocatedTotals"]["unitemizedRecords"],2);
        assert_eq!(data["unlocatedByTool"]["codex"]["totalTokens"],1540);
        assert_eq!(data["unlocatedByTool"]["claude"]["totalTokens"],440);
        let all=read(&conn,None,&MonitorPeriod{end_ms:Some(2000),..Default::default()},"",None,false,0,100,2000).unwrap();
        assert_eq!((all.totals.request_count,all.totals.total_tokens),(5,2090));
        assert_eq!(all.by_tool.iter().map(|row|row.totals.total_tokens).sum::<i64>(),2090);
        assert_eq!(all.by_model.iter().map(|row|row.totals.total_tokens).sum::<i64>(),2090);
        assert_eq!(all.timeline.iter().map(|row|row.totals.total_tokens).sum::<i64>(),110);
        let selected=read(&conn,Some("codex"),&MonitorPeriod{model:Some("model-codex".into()),..period.clone()},"",None,false,0,100,2000).unwrap();
        let data=serde_json::to_value(selected).unwrap();
        assert_eq!(data["unlocatedTotals"]["totalTokens"],1540);
        assert!(data["unlocatedByTool"].get("claude").is_none());
        let mut period_rows=0;
        each_usage_in_sessions(&conn,&["codex:session".into()],&period,|_|period_rows+=1).unwrap();
        assert_eq!(period_rows,1);
        let mut all_time_rows=0;
        each_usage_in_sessions(&conn,&["codex:session".into()],&MonitorPeriod{end_ms:Some(2000),..Default::default()},|_|all_time_rows+=1).unwrap();
        assert_eq!(all_time_rows,4,"the all-time detail must retain unknown/cumulative records just like the overview");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|row|row.get::<_,i64>(0)).unwrap(),6);
    }

    #[test]
    fn projections_keep_unknown_token_fields_and_unitemized_record_counts() {
        let conn=Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let cost=json!({"usd":null,"reason":"incomplete_token_breakdown"});
        let usage=insert(&conn,"unknown","codex",1000,0,&["input_tokens","output_tokens","cache_read_tokens","cache_write_tokens"],"legacy_initial_cumulative",cost.clone());
        let mut projected=Totals::default();
        each_usage(&conn,None,None,&MonitorPeriod::default(),|row|store::merge_totals(&mut projected,&row.totals)).unwrap();
        let saved=super::super::weekly::saved_request_totals(&usage,&cost.to_string()).unwrap();
        assert_eq!(serde_json::to_value(&projected).unwrap(),serde_json::to_value(saved).unwrap());
        let data=serde_json::to_value(projected).unwrap();
        for field in ["unitemizedRecords","inputUnknownRequests","outputUnknownRequests","cacheReadUnknownRequests","cacheWriteUnknownRequests"] {
            assert_eq!(data[field],1,"lost completeness field {field}");
        }
        assert_eq!(data["requestCount"],1);
        assert_eq!(data["inputTokens"],0);
    }

    #[test]
    fn unsafe_persisted_totals_fail_before_analysis_or_live_can_publish_a_number() {
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        insert(&conn, "large", "codex", 1000, 100, &[], "provider_reported", json!({"usd": 1.}));
        // This is a legacy/corrupt database path: bypass the new checked write API.
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.inputTokens',?1)",
            [store::MAX_EXACT_TOKENS]).unwrap();
        let period = MonitorPeriod { start_ms: Some(900), end_ms: Some(2000), ..Default::default() };
        assert!(read(&conn,None,&period,"",None,false,0,100,2000).err().unwrap().contains("exact"));
        assert!(super::super::live::read(&conn,2000,0,2000).err().unwrap().contains("exact"));
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.inputTokens',100,'$.outputTokens',-1)", []).unwrap();
        assert!(read(&conn,None,&period,"",None,false,0,100,2000).is_err());
        assert!(super::super::live::read(&conn,2000,0,2000).is_err());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|row|row.get::<_,i64>(0)).unwrap(),1,
            "a read-time integrity failure must preserve source records for repair");
    }

    #[test]
    fn mixed_updates_replays_moves_and_deletes_conserve_all_aggregate_views() {
        let mut conn=Connection::open_in_memory().unwrap();store::initialize(&conn).unwrap();
        let catalog=crate::model_catalog::CatalogSnapshot::default();
        let mut expected=Vec::new();
        for i in 0..96i64 {
            let mut record=UsageRecord {
                id:format!("audit-{}",i/4),tool:["codex","claude","antigravity","deepseek-harness"][(i%4) as usize].into(),
                session_id:format!("session-{}",i%7),turn_id:format!("turn-{i}"),timestamp_ms:1000+i,
                model:Some("not-in-any-audit-price-catalog".into()),model_basis:"response_model".into(),
                input_tokens:100+i*5,cache_read_tokens:20+i,output_tokens:i%17,
                usage_basis:if i%17==0{"legacy_initial_cumulative"}else{"provider_reported"}.into(),
                ..Default::default()
            };
            if i%11==0 {record.input_tokens=0;record.cache_read_tokens=0;record.unknown_fields.push("input_tokens".into());}
            if i%13==0 {record.output_tokens=0;record.unknown_fields.push("output_tokens".into());}
            if i%19==0 {record.unknown_fields.push("timestamp".into());}
            let tx=conn.transaction().unwrap();
            store::save_usage_with_catalog(&tx,&record,i64::MAX,2000,&catalog).unwrap();
            if i%2==0 {
                if !record.unknown_fields.iter().any(|field|field=="input_tokens") {record.input_tokens+=37;}
                if !record.unknown_fields.iter().any(|field|field=="output_tokens") {record.output_tokens+=5;}
                record.timestamp_ms+=500;
                if i%5==0 {record.session_id="moved-session".into();}
                store::save_usage_with_catalog(&tx,&record,i64::MAX,2000,&catalog).unwrap();
            }
            // A repeated identical row must not add another request, token, or completeness flag.
            store::save_usage_with_catalog(&tx,&record,i64::MAX,2000,&catalog).unwrap();
            if i%6==0 {store::delete_request(&tx,&record.tool,&record.id).unwrap();} else {expected.push(record);}
            tx.commit().unwrap();
        }
        let cached=store::sum_sessions(&store::sessions(&conn,None,3000).unwrap());
        let mut projected=Totals::default();
        each_usage(&conn,None,None,&MonitorPeriod::default(),|row|store::merge_totals(&mut projected,&row.totals)).unwrap();
        store::finish_totals(&mut projected);
        assert_eq!(serde_json::to_value(&cached).unwrap(),serde_json::to_value(&projected).unwrap(),"cached session totals must match the independent request projection");
        assert_eq!(projected.request_count,80);
        assert_eq!(projected.input_tokens,expected.iter().map(|row|row.input_tokens).sum::<i64>());
        assert_eq!(projected.output_tokens,expected.iter().map(|row|row.output_tokens).sum::<i64>());
        assert_eq!(projected.cache_read_tokens,expected.iter().map(|row|row.cache_read_tokens).sum::<i64>());
        assert_eq!(projected.total_tokens,expected.iter().map(|row|row.input_tokens+row.output_tokens).sum::<i64>());
        let data=serde_json::to_value(&projected).unwrap();
        assert_eq!(data["inputUnknownRequests"],expected.iter().filter(|row|row.unknown_fields.iter().any(|field|field=="input_tokens")).count());
        assert_eq!(data["outputUnknownRequests"],expected.iter().filter(|row|row.unknown_fields.iter().any(|field|field=="output_tokens")).count());
        assert_eq!(data["unitemizedRecords"],expected.iter().filter(|row|row.usage_basis=="legacy_initial_cumulative").count());
        let mut saved=Totals::default();
        for record in &expected {
            let cost:String=conn.query_row("SELECT cost FROM monitor_requests WHERE tool=?1 AND id=?2",params![record.tool,record.id],|row|row.get(0)).unwrap();
            store::merge_totals(&mut saved,&super::super::weekly::saved_request_totals(record,&cost).unwrap());
        }
        store::finish_totals(&mut saved);
        assert_eq!(serde_json::to_value(&projected).unwrap(),serde_json::to_value(saved).unwrap(),"weekly/account projection must retain the same totals and unknowns");
        store::initialize(&conn).unwrap();
        let reopened=store::sum_sessions(&store::sessions(&conn,None,3000).unwrap());
        assert_eq!(serde_json::to_value(cached).unwrap(),serde_json::to_value(reopened).unwrap(),"startup supplement must be idempotent");
        let period=MonitorPeriod{start_ms:Some(1000),end_ms:Some(1600),..Default::default()};
        let result=read(&conn,None,&period,"",None,false,0,100,3000).unwrap();
        let located:Vec<_>=expected.iter().filter(|row|row.usage_basis!="legacy_initial_cumulative"&&!row.unknown_fields.iter().any(|field|field=="timestamp")).collect();
        assert_eq!(result.totals.request_count,located.len() as i64);
        assert_eq!(result.totals.total_tokens,located.iter().map(|row|row.input_tokens+row.output_tokens).sum::<i64>());
        for grouped in [&result.by_tool,&result.by_model,&result.tool_overview] {
            assert_eq!(grouped.iter().map(|row|row.totals.total_tokens).sum::<i64>(),result.totals.total_tokens);
            assert_eq!(grouped.iter().map(|row|row.totals.request_count).sum::<i64>(),result.totals.request_count);
        }
        assert_eq!(result.timeline.iter().map(|row|row.totals.total_tokens).sum::<i64>(),result.totals.total_tokens);
    }
}
