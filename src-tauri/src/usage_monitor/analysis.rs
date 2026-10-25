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
    project_usage(conn, tool, key, None, period, consume)
}

pub(super) fn each_usage_in_sessions(
    conn: &Connection,
    keys: &[String],
    period: &MonitorPeriod,
    consume: impl FnMut(UsageRow),
) -> Result<(), String> {
    project_usage(conn, None, None, Some(keys), period, consume)
}

fn project_usage(
    conn: &Connection,
    tool: Option<&str>,
    key: Option<&str>,
    keys: Option<&[String]>,
    period: &MonitorPeriod,
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
          'currency',json_extract(s.value,'$.evidence.currency'),'amount',json_extract(s.value,'$.amount'),'requestCount',1))
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
        json_extract(r.usage,'$.runtimeMode'),r.id,json_extract(r.usage,'$.rootTurnId')
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
    if let Some(start) = period.start_ms {
        clauses.push("r.timestamp_ms>=?");
        values.push(Value::Integer(start));
    }
    if let Some(end) = period.end_ms {
        clauses.push("r.timestamp_ms<?");
        values.push(Value::Integer(end));
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
    let end = period.end_ms.unwrap_or(now);
    let first: Option<i64> = if period.start_ms.is_some() {
        period.start_ms
    } else if let Some(tool) = tool {
        conn.query_row(
            "SELECT MIN(timestamp_ms) FROM monitor_requests WHERE timestamp_ms>0 AND tool=?1",
            [tool],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?
    } else {
        conn.query_row(
            "SELECT MIN(timestamp_ms) FROM monitor_requests WHERE timestamp_ms>0",
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
        ..period.clone()
    };
    each_usage(conn, None, None, &all_models, |row| {
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
        if row.timestamp_ms >= start && row.timestamp_ms < end {
            if let Some(bucket) = timeline.get_mut(((row.timestamp_ms - start) / width) as usize) {
                store::merge_totals(&mut bucket.totals, &row.totals);
            }
        }
    })?;
    store::finish_totals(&mut totals);
    for bucket in &mut timeline {
        store::finish_totals(&mut bucket.totals);
    }
    let mut sessions = store::sessions(conn, tool, now)?;
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
                "SELECT MAX(timestamp_ms) FROM monitor_requests WHERE tool=?1 AND timestamp_ms>0",
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
