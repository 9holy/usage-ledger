use super::{pricing, types::*};
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS monitor_sessions (
            key TEXT PRIMARY KEY, tool TEXT NOT NULL, meta TEXT NOT NULL,
            totals TEXT NOT NULL, updated_ms INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS monitor_sessions_recent ON monitor_sessions(tool,updated_ms DESC);
         CREATE TABLE IF NOT EXISTS monitor_requests (
            tool TEXT NOT NULL, id TEXT NOT NULL, session_key TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL, usage TEXT NOT NULL, cost TEXT NOT NULL,
            PRIMARY KEY(tool,id));
         CREATE INDEX IF NOT EXISTS monitor_requests_session ON monitor_requests(session_key,timestamp_ms DESC);
         CREATE INDEX IF NOT EXISTS monitor_requests_turn ON monitor_requests(session_key,json_extract(usage,'$.turnId'));
         CREATE INDEX IF NOT EXISTS monitor_requests_time ON monitor_requests(timestamp_ms);
         CREATE INDEX IF NOT EXISTS monitor_requests_tool_time ON monitor_requests(tool,timestamp_ms);
         CREATE INDEX IF NOT EXISTS monitor_requests_request_timing ON monitor_requests(session_key,timestamp_ms DESC)
           WHERE json_extract(usage,'$.requestTiming.durationMs')>0;
         CREATE TABLE IF NOT EXISTS monitor_turns (
           session_key TEXT NOT NULL,turn_id TEXT NOT NULL,data TEXT NOT NULL,
           PRIMARY KEY(session_key,turn_id));
         CREATE TABLE IF NOT EXISTS monitor_turn_mode_evidence (
           session_key TEXT NOT NULL,turn_id TEXT NOT NULL,data TEXT NOT NULL,
           source_path TEXT NOT NULL,source_row_id INTEGER NOT NULL,
           PRIMARY KEY(session_key,turn_id));
         CREATE TABLE IF NOT EXISTS monitor_aliases (tool TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(tool,id));
         CREATE TABLE IF NOT EXISTS monitor_state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS monitor_files (
            path TEXT PRIMARY KEY, tool TEXT NOT NULL, offset INTEGER NOT NULL,
            signature TEXT NOT NULL, state TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS monitor_sources (
            root TEXT PRIMARY KEY, data TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS monitor_observations (
            tool TEXT NOT NULL, id TEXT NOT NULL, session_key TEXT NOT NULL,
            observed_ms INTEGER NOT NULL, output_tokens INTEGER NOT NULL);
         CREATE INDEX IF NOT EXISTS monitor_observations_time ON monitor_observations(observed_ms);",
    ).map_err(|e| e.to_string())?;
    super::quota::initialize(conn)?;
    super::live::initialize(conn)?;
    supplement_cache_cohort(conn)?;
    supplement_completeness(conn)
}

fn supplement_cache_cohort(conn: &Connection) -> Result<(), String> {
    let tx = Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let done: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='cache_cohort_totals_v1')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !done {
        // One grouped history pass; json_set preserves all existing aggregate and extension fields.
        tx.execute_batch("WITH cohort AS MATERIALIZED (
            SELECT session_key,SUM(json_extract(usage,'$.inputTokens')) AS input,
              SUM(json_extract(usage,'$.cacheReadTokens')) AS reads,COUNT(*) AS requests
            FROM monitor_requests
            WHERE NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields')
              WHERE value IN ('input_tokens','cache_read_tokens'))
            GROUP BY session_key
          )
          UPDATE monitor_sessions SET totals=json_set(totals,
            '$.knownCacheInputTokens',COALESCE((SELECT input FROM cohort WHERE session_key=monitor_sessions.key),0),
            '$.knownCacheReadTokens',COALESCE((SELECT reads FROM cohort WHERE session_key=monitor_sessions.key),0),
            '$.cacheKnownRequests',COALESCE((SELECT requests FROM cohort WHERE session_key=monitor_sessions.key),0),
            '$.knownCacheHitRatio',(SELECT reads*1.0/NULLIF(input,0) FROM cohort WHERE session_key=monitor_sessions.key));
          INSERT INTO monitor_state(key,data) VALUES('cache_cohort_totals_v1','1');").map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn mode_key(mode: Option<&str>) -> &str {
    match mode {
        Some("normal" | "default") => "standard",
        Some("priority") => "fast",
        Some(value) if !value.is_empty() => value,
        _ => "unknown",
    }
}

pub(super) fn price_summary<'a>(
    usd: Option<f64>,
    cny: Option<f64>,
    scenarios: impl Iterator<Item = (&'a str, &'a str, f64)>,
) -> PriceSummary {
    let mut result = PriceSummary::default();
    if usd.is_some() || cny.is_some() {
        for (currency, amount) in [("USD", usd), ("CNY", cny)] {
            if let Some(amount) = amount.filter(|amount| amount.is_finite() && *amount >= 0.) {
                result.by_currency.insert(
                    currency.into(),
                    CurrencyPriceSummary {
                        confirmed_subtotal: amount,
                        confirmed_requests: 1,
                        ..Default::default()
                    },
                );
            }
        }
        result.covered_requests = i64::from(!result.by_currency.is_empty());
        return result;
    }
    let Some((currency, amount)) = unique_mode_quote("standard", scenarios) else {
        return result;
    };
    result.by_currency.insert(
        currency.into(),
        CurrencyPriceSummary {
            standard_subtotal: amount,
            standard_requests: 1,
            ..Default::default()
        },
    );
    result.covered_requests = 1;
    result
}

fn unique_mode_quote<'a>(
    mode: &str,
    scenarios: impl Iterator<Item = (&'a str, &'a str, f64)>,
) -> Option<(&'a str, f64)> {
    let mut matching = scenarios.filter(|(candidate, _, _)| mode_key(Some(candidate)) == mode);
    let (_, currency, amount) = matching.next()?;
    (!currency.is_empty()
        && amount.is_finite()
        && amount >= 0.
        && matching.all(|(_, other_currency, other_amount)| {
            other_currency == currency && other_amount == amount
        }))
    .then_some((currency, amount))
}
fn recognized_mode(value: Option<&str>) -> Option<&str> {
    match mode_key(value) {
        mode @ ("standard" | "fast" | "ultrafast" | "flex" | "scale") => Some(mode),
        _ => None,
    }
}

pub(super) fn effective_client_mode<'a>(
    requested: Option<&'a str>,
    ambiguous: bool,
    runtime: Option<&'a RuntimeModeEvidence>,
) -> Option<&'a str> {
    if ambiguous {
        return None;
    }
    if let Some(runtime) = runtime {
        if runtime.conflicted {
            return None;
        }
        return recognized_mode(runtime.mode.as_deref());
    }
    requested
}

pub(super) fn automatic_price_summary<'a>(
    actual: Option<&str>,
    requested: Option<&str>,
    usd: Option<f64>,
    cny: Option<f64>,
    evidence_mode: Option<&str>,
    reason: Option<&str>,
    scenarios: impl Iterator<Item = (&'a str, &'a str, f64)>,
) -> AutomaticPriceSummary {
    let mut result = AutomaticPriceSummary::default();
    let actual = recognized_mode(actual);
    let selected = actual.or_else(|| recognized_mode(requested));
    let mode = result
        .by_mode
        .entry(selected.unwrap_or("unknown").into())
        .or_default();
    if actual.is_some() {
        mode.response_requests = 1;
    } else if selected.is_some() {
        mode.requested_requests = 1;
    } else {
        mode.unknown_requests = 1;
        let reference = price_summary(usd, cny, scenarios);
        for (currency, row) in reference.by_currency {
            result.by_currency.insert(
                currency,
                AutomaticCurrencySummary {
                    unknown_reference_subtotal: row.confirmed_subtotal + row.standard_subtotal,
                    unknown_reference_requests: 1,
                    ..Default::default()
                },
            );
        }
        return result;
    }
    let selected = selected.unwrap();
    let quotes: Vec<_> = if recognized_mode(evidence_mode) == Some(selected)
        || reason.is_some_and(|reason| reason.contains("same_amount_for_all_published_tariffs"))
    {
        [("USD", usd), ("CNY", cny)]
            .into_iter()
            .filter_map(|(currency, amount)| {
                amount
                    .filter(|amount| amount.is_finite() && *amount >= 0.)
                    .map(|amount| (currency, amount))
            })
            .collect()
    } else {
        Vec::new()
    };
    let quotes = if quotes.is_empty() {
        unique_mode_quote(selected, scenarios).into_iter().collect()
    } else {
        quotes
    };
    mode.covered_requests = i64::from(!quotes.is_empty());
    for (currency, amount) in quotes {
        mode.by_currency.insert(
            currency.into(),
            AutomaticModeAmount {
                amount,
                request_count: 1,
            },
        );
        let row = result.by_currency.entry(currency.into()).or_default();
        if actual.is_some() {
            row.response_subtotal = amount;
            row.response_requests = 1;
        } else {
            row.requested_subtotal = amount;
            row.requested_requests = 1;
        }
    }
    result
}

fn merge_automatic_price_summary(
    target: &mut AutomaticPriceSummary,
    source: &AutomaticPriceSummary,
    sign: i64,
) {
    for (mode, value) in &source.by_mode {
        let row = target.by_mode.entry(mode.clone()).or_default();
        row.response_requests += sign * value.response_requests;
        row.requested_requests += sign * value.requested_requests;
        row.unknown_requests += sign * value.unknown_requests;
        row.covered_requests += sign * value.covered_requests;
        for (currency, value) in &value.by_currency {
            let amount = row.by_currency.entry(currency.clone()).or_default();
            amount.amount += sign as f64 * value.amount;
            amount.request_count += sign * value.request_count;
        }
        row.by_currency
            .retain(|_, amount| amount.request_count != 0);
    }
    target.by_mode.retain(|_, row| {
        row.response_requests != 0 || row.requested_requests != 0 || row.unknown_requests != 0
    });
    for (currency, value) in &source.by_currency {
        let row = target.by_currency.entry(currency.clone()).or_default();
        row.response_subtotal += sign as f64 * value.response_subtotal;
        row.response_requests += sign * value.response_requests;
        row.requested_subtotal += sign as f64 * value.requested_subtotal;
        row.requested_requests += sign * value.requested_requests;
        row.unknown_reference_subtotal += sign as f64 * value.unknown_reference_subtotal;
        row.unknown_reference_requests += sign * value.unknown_reference_requests;
    }
    target.by_currency.retain(|_, row| {
        row.response_requests != 0
            || row.requested_requests != 0
            || row.unknown_reference_requests != 0
    });
}

fn merge_price_summary(target: &mut PriceSummary, source: &PriceSummary, sign: i64) {
    target.covered_requests += sign * source.covered_requests;
    for (currency, value) in &source.by_currency {
        let row = target.by_currency.entry(currency.clone()).or_default();
        row.confirmed_subtotal += sign as f64 * value.confirmed_subtotal;
        row.confirmed_requests += sign * value.confirmed_requests;
        row.standard_subtotal += sign as f64 * value.standard_subtotal;
        row.standard_requests += sign * value.standard_requests;
    }
    target
        .by_currency
        .retain(|_, row| row.confirmed_requests != 0 || row.standard_requests != 0);
}
pub(super) fn unpriced_reason(
    unpriced: bool,
    scenarios: bool,
    reason: Option<&str>,
) -> Option<&str> {
    if !unpriced {
        return None;
    }
    let reason = reason.unwrap_or("");
    if reason.contains("actual_mode_unknown") || reason == "unknown_actual_mode" {
        return Some("actual_mode_unknown");
    }
    if scenarios {
        return Some(
            if reason.contains("time_band_scenarios")
                || reason.contains("holiday_calendar_or_timestamp_unknown")
            {
                "time_band_unknown"
            } else {
                "multiple_price_scenarios"
            },
        );
    }
    Some(
        reason
            .split(';')
            .next()
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("unspecified_pricing_gap"),
    )
}

pub(super) fn add_completeness(
    totals: &mut Totals,
    reasoning: Option<i64>,
    actual: Option<&str>,
    requested: Option<&str>,
    unpriced_tokens: Option<i64>,
    unpriced_reason: Option<&str>,
    sign: i64,
) {
    if let Some(tokens) = reasoning {
        totals.reasoning_tokens += sign * tokens;
        totals.reasoning_known_requests += sign;
    }
    for (counts, mode) in [
        (&mut totals.actual_mode_counts, actual),
        (&mut totals.requested_mode_counts, requested),
    ] {
        *counts.entry(mode_key(mode).into()).or_default() += sign;
        counts.retain(|_, count| *count != 0);
    }
    if let Some(tokens) = unpriced_tokens {
        totals.unpriced_tokens += sign * tokens;
        totals.unpriced_token_known_requests += sign;
    }
    if let Some(reason) = unpriced_reason {
        *totals
            .unpriced_reason_counts
            .entry(reason.into())
            .or_default() += sign;
        totals.unpriced_reason_counts.retain(|_, count| *count != 0);
    }
}

fn supplement_completeness(conn: &Connection) -> Result<(), String> {
    let tx = Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let (done,legacy_complete,legacy_price):(bool,bool,bool) = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='completeness_totals_v4'),EXISTS(SELECT 1 FROM monitor_state WHERE key='completeness_totals_v2'),EXISTS(SELECT 1 FROM monitor_state WHERE key='completeness_totals_v3')",
            [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?)),
        )
        .map_err(|error| error.to_string())?;
    if !done {
        let mut totals = std::collections::BTreeMap::<String, Totals>::new();
        {
            let mut statement=tx.prepare("SELECT session_key,json_extract(usage,'$.reasoningTokens'),CASE WHEN json_extract(usage,'$.modeBasis')='response_reported' THEN json_extract(usage,'$.mode') END,json_extract(usage,'$.requestedMode'),CASE WHEN json_extract(cost,'$.usd') IS NULL AND json_extract(cost,'$.cny') IS NULL AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value IN ('input_tokens','output_tokens')) THEN json_extract(usage,'$.inputTokens')+json_extract(usage,'$.outputTokens') END,json_extract(cost,'$.usd') IS NULL AND json_extract(cost,'$.cny') IS NULL,COALESCE(json_array_length(cost,'$.scenarios'),0)>0,json_extract(cost,'$.reason'),json_extract(cost,'$.usd'),json_extract(cost,'$.cny'),(SELECT json_group_array(json_object('mode',json_extract(s.value,'$.mode'),'currency',COALESCE(json_extract(s.value,'$.evidence.currency'),'USD'),'amount',json_extract(s.value,'$.amount'),'requestCount',1)) FROM json_each(cost,'$.scenarios') s),json_extract(cost,'$.evidence.mode'),EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='requested_mode_ambiguous'),json_extract(usage,'$.runtimeMode') FROM monitor_requests").map_err(|error|error.to_string())?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<i64>>(4)?,
                        row.get::<_, bool>(5)?,
                        row.get::<_, bool>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<f64>>(8)?,
                        row.get::<_, Option<f64>>(9)?,
                        row.get::<_, String>(10)?,
                        row.get::<_, Option<String>>(11)?,
                        row.get::<_, bool>(12)?,
                        row.get::<_, Option<String>>(13)?,
                    ))
                })
                .map_err(|error| error.to_string())?;
            for row in rows {
                let (
                    key,
                    reasoning,
                    actual,
                    requested,
                    unpriced,
                    single_missing,
                    scenarios,
                    reason,
                    usd,
                    cny,
                    price_scenarios,
                    evidence_mode,
                    requested_ambiguous,
                    runtime,
                ) = row.map_err(|error| error.to_string())?;
                add_completeness(
                    totals.entry(key.clone()).or_default(),
                    reasoning,
                    actual.as_deref(),
                    requested.as_deref(),
                    unpriced,
                    unpriced_reason(single_missing, scenarios, reason.as_deref()),
                    1,
                );
                let price_scenarios: Vec<ScenarioTotal> =
                    serde_json::from_str(&price_scenarios).map_err(|error| error.to_string())?;
                let summary = price_summary(
                    usd,
                    cny,
                    price_scenarios.iter().map(|scenario| {
                        (
                            scenario.mode.as_str(),
                            scenario.currency.as_str(),
                            scenario.amount,
                        )
                    }),
                );
                merge_price_summary(
                    &mut totals.entry(key.clone()).or_default().price_summary,
                    &summary,
                    1,
                );
                let runtime: Option<RuntimeModeEvidence> = runtime
                    .map(|json| serde_json::from_str(&json))
                    .transpose()
                    .map_err(|error| error.to_string())?;
                let automatic = automatic_price_summary(
                    actual.as_deref(),
                    effective_client_mode(
                        requested.as_deref(),
                        requested_ambiguous,
                        runtime.as_ref(),
                    ),
                    usd,
                    cny,
                    evidence_mode.as_deref(),
                    reason.as_deref(),
                    price_scenarios.iter().map(|scenario| {
                        (
                            scenario.mode.as_str(),
                            scenario.currency.as_str(),
                            scenario.amount,
                        )
                    }),
                );
                merge_automatic_price_summary(
                    &mut totals.entry(key).or_default().automatic_price_summary,
                    &automatic,
                    1,
                );
            }
        }
        let keys = {
            let mut query = tx
                .prepare("SELECT key FROM monitor_sessions")
                .map_err(|error| error.to_string())?;
            let rows = query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        for key in keys {
            let total = totals.remove(&key).unwrap_or_default();
            if !legacy_complete {
                tx.execute("UPDATE monitor_sessions SET totals=json_set(totals,'$.reasoningTokens',?2,'$.reasoningKnownRequests',?3,'$.actualModeCounts',json(?4),'$.requestedModeCounts',json(?5),'$.unpricedTokens',?6,'$.unpricedTokenKnownRequests',?7,'$.unpricedReasonCounts',json(?8)) WHERE key=?1",params![key,total.reasoning_tokens,total.reasoning_known_requests,serde_json::to_string(&total.actual_mode_counts).map_err(|error|error.to_string())?,serde_json::to_string(&total.requested_mode_counts).map_err(|error|error.to_string())?,total.unpriced_tokens,total.unpriced_token_known_requests,serde_json::to_string(&total.unpriced_reason_counts).map_err(|error|error.to_string())?]).map_err(|error|error.to_string())?;
            }
            if !legacy_price {
                tx.execute("UPDATE monitor_sessions SET totals=json_set(totals,'$.priceSummary',json(?2)) WHERE key=?1",params![key,serde_json::to_string(&total.price_summary).map_err(|error|error.to_string())?]).map_err(|error|error.to_string())?;
            }
            tx.execute("UPDATE monitor_sessions SET totals=json_set(totals,'$.automaticPriceSummary',json(?2)) WHERE key=?1",params![key,serde_json::to_string(&total.automatic_price_summary).map_err(|error|error.to_string())?]).map_err(|error|error.to_string())?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO monitor_state(key,data) VALUES('completeness_totals_v2','1'),('completeness_totals_v3','1'),('completeness_totals_v4','1')",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

pub fn session_key(tool: &str, id: &str) -> String {
    format!("{tool}:{id}")
}

#[derive(Clone, Debug)]
pub struct RuntimeModeObservation {
    pub session_key: String,
    pub turn_id: String,
    pub mode: String,
    pub observed_at_ms: i64,
    pub source_row_id: i64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModeCursor {
    pub id: i64,
    pub ts: Option<i64>,
    pub ts_nanos: Option<i64>,
}

pub fn runtime_mode_cursor(
    conn: &Connection,
    source_path: &str,
) -> Result<RuntimeModeCursor, String> {
    let value: Option<String> = conn
        .query_row(
            "SELECT data FROM monitor_state WHERE key=?1",
            [format!("codex_runtime_mode_cursor:{source_path}")],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    value
        .map(|value| {
            serde_json::from_str::<RuntimeModeCursor>(&value).map_err(|error| error.to_string())
        })
        .transpose()
        .map(|value| value.unwrap_or_default())
}

fn runtime_mode_for_usage(
    usage: &UsageRecord,
    evidence: RuntimeModeEvidence,
) -> Option<RuntimeModeEvidence> {
    let known_time = !usage
        .unknown_fields
        .iter()
        .any(|field| field == "timestamp")
        && usage.timestamp_ms >= evidence.observed_at_ms
        && usage
            .request_timing
            .as_ref()
            .and_then(|timing| timing.started_at_ms)
            .is_none_or(|start| start >= evidence.observed_at_ms);
    // A conflicting exact turn cannot fall back to either client setting, even for older rows.
    (evidence.conflicted || known_time).then_some(evidence)
}

fn usage_automatic_price_summary(
    usage: &UsageRecord,
    cost: &CostEstimate,
) -> AutomaticPriceSummary {
    automatic_price_summary(
        usage
            .mode
            .as_deref()
            .filter(|_| usage.mode_basis == "response_reported"),
        effective_client_mode(
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
            .map(|evidence| evidence.mode.as_str()),
        cost.reason.as_deref(),
        cost.scenarios.iter().map(|scenario| {
            (
                scenario.mode.as_str(),
                scenario.evidence.currency.as_str(),
                scenario.amount,
            )
        }),
    )
}

pub fn apply_runtime_mode_batch(
    conn: &mut Connection,
    source_path: &str,
    observations: &[RuntimeModeObservation],
    next_cursor: &RuntimeModeCursor,
) -> Result<(), String> {
    if source_path.is_empty() || next_cursor.id < 0 {
        return Err("Invalid runtime mode source cursor".into());
    }
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut changed = std::collections::BTreeSet::new();
    for observation in observations {
        let mode = if matches!(observation.mode.as_str(), "auto" | "unknown") {
            None
        } else {
            Some(
                recognized_mode(Some(&observation.mode))
                    .ok_or("Unsupported runtime client mode")?,
            )
        };
        if !observation.session_key.starts_with("codex:")
            || observation.session_key == "codex:"
            || observation.turn_id.is_empty()
            || observation.observed_at_ms <= 0
            || observation.source_row_id <= 0
            || observation.source_row_id > next_cursor.id
        {
            return Err("Invalid runtime client mode observation".into());
        }
        let previous: Option<String> = tx
            .query_row(
                "SELECT data FROM monitor_turn_mode_evidence WHERE session_key=?1 AND turn_id=?2",
                params![observation.session_key, observation.turn_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let old: Option<RuntimeModeEvidence> = previous
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| error.to_string())?;
        let mut evidence = RuntimeModeEvidence {
            mode: mode.map(str::to_owned),
            conflicted: false,
            observed_at_ms: observation.observed_at_ms,
            source: "codex_turn_feedback_tag".into(),
        };
        if let Some(old) = &old {
            evidence.observed_at_ms = evidence.observed_at_ms.min(old.observed_at_ms);
            evidence.conflicted = old.conflicted || old.mode.as_deref() != mode;
            if evidence.conflicted {
                evidence.mode = None;
            }
            if old == &evidence {
                continue;
            }
        }
        tx.execute("INSERT INTO monitor_turn_mode_evidence(session_key,turn_id,data,source_path,source_row_id) VALUES(?1,?2,?3,?4,?5)
            ON CONFLICT(session_key,turn_id) DO UPDATE SET data=excluded.data,source_path=excluded.source_path,source_row_id=excluded.source_row_id",
            params![observation.session_key, observation.turn_id, serde_json::to_string(&evidence).map_err(|error| error.to_string())?, source_path, observation.source_row_id]).map_err(|error| error.to_string())?;
        changed.insert((observation.session_key.clone(), observation.turn_id.clone()));
    }
    for (key, turn) in changed {
        let evidence: String = tx
            .query_row(
                "SELECT data FROM monitor_turn_mode_evidence WHERE session_key=?1 AND turn_id=?2",
                params![key, turn],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let evidence: RuntimeModeEvidence =
            serde_json::from_str(&evidence).map_err(|error| error.to_string())?;
        let rows = {
            let mut query = tx.prepare("SELECT id,usage,cost FROM monitor_requests WHERE session_key=?1 AND json_extract(usage,'$.turnId')=?2").map_err(|error| error.to_string())?;
            let rows = query
                .query_map(params![key, turn], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        if rows.is_empty() {
            continue;
        }
        let json: Option<String> = tx.query_row("SELECT json_extract(totals,'$.automaticPriceSummary') FROM monitor_sessions WHERE key=?1", [&key], |row| row.get(0)).map_err(|error| error.to_string())?;
        let mut summary: AutomaticPriceSummary = json
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or_default();
        let mut enriched = false;
        for (id, json, cost) in rows {
            let usage: UsageRecord =
                serde_json::from_str(&json).map_err(|error| error.to_string())?;
            let runtime = runtime_mode_for_usage(&usage, evidence.clone());
            if usage.runtime_mode == runtime {
                continue;
            }
            let cost: CostEstimate =
                serde_json::from_str(&cost).map_err(|error| error.to_string())?;
            merge_automatic_price_summary(
                &mut summary,
                &usage_automatic_price_summary(&usage, &cost),
                -1,
            );
            let mut next = usage;
            next.runtime_mode = runtime;
            merge_automatic_price_summary(
                &mut summary,
                &usage_automatic_price_summary(&next, &cost),
                1,
            );
            tx.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.runtimeMode',json(?3)) WHERE tool='codex' AND id=?1 AND session_key=?2",
                params![id,key,serde_json::to_string(&next.runtime_mode).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
            enriched = true;
        }
        if enriched {
            tx.execute("UPDATE monitor_sessions SET totals=json_set(totals,'$.automaticPriceSummary',json(?2)) WHERE key=?1",
                params![key,serde_json::to_string(&summary).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
        }
    }
    tx.execute("INSERT INTO monitor_state(key,data) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        params![format!("codex_runtime_mode_cursor:{source_path}"),serde_json::to_string(next_cursor).map_err(|error| error.to_string())?]).map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

pub fn save_session(tx: &Transaction<'_>, meta: &SessionMeta) -> Result<(), String> {
    let key = session_key(&meta.tool, &meta.id);
    if let Some(timing) = meta
        .turn_timing
        .as_ref()
        .filter(|timing| !timing.turn_id.is_empty())
    {
        let old: Option<String> = tx
            .query_row(
                "SELECT data FROM monitor_turns WHERE session_key=?1 AND turn_id=?2",
                params![key, timing.turn_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let mut timing = timing.clone();
        if let Some(old) = old {
            let old: TurnTiming = serde_json::from_str(&old).map_err(|error| error.to_string())?;
            timing.started_at_ms = timing.started_at_ms.or(old.started_at_ms);
            timing.completed_at_ms = timing.completed_at_ms.or(old.completed_at_ms);
            timing.duration_ms = timing.duration_ms.or(old.duration_ms);
            timing.ttft_ms = timing.ttft_ms.or(old.ttft_ms);
        }
        tx.execute("INSERT INTO monitor_turns(session_key,turn_id,data) VALUES(?1,?2,?3) ON CONFLICT(session_key,turn_id) DO UPDATE SET data=excluded.data",params![key,timing.turn_id,serde_json::to_string(&timing).map_err(|error|error.to_string())?]).map_err(|error|error.to_string())?;
    }
    let previous: Option<String> = tx
        .query_row(
            "SELECT meta FROM monitor_sessions WHERE key=?1",
            [&key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut next = meta.clone();
    if let Some(json) = previous {
        let old: SessionMeta = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        if next.updated_at_ms < old.updated_at_ms {
            return Ok(());
        }
        if next.parent_id.is_none() {
            next.parent_id = old.parent_id;
        }
        if next.root_id.is_none() {
            next.root_id = old.root_id;
        }
        if next.project.is_none() {
            next.project = old.project;
        }
        if next.model.is_none() {
            next.model = old.model;
        }
        if next.started_at_ms == 0 {
            next.started_at_ms = old.started_at_ms;
        }
    }
    tx.execute(
        "INSERT INTO monitor_sessions(key,tool,meta,totals,updated_ms) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(key) DO UPDATE SET meta=excluded.meta, updated_ms=excluded.updated_ms",
        params![
            key,
            next.tool,
            serde_json::to_string(&next).map_err(|e| e.to_string())?,
            serde_json::to_string(&Totals::default()).map_err(|e| e.to_string())?,
            next.updated_at_ms
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn adjust(
    tx: &Transaction<'_>,
    usage: &UsageRecord,
    cost: &CostEstimate,
    sign: i64,
) -> Result<(), String> {
    let key = session_key(&usage.tool, &usage.session_id);
    let json: String = tx
        .query_row(
            "SELECT totals FROM monitor_sessions WHERE key=?1",
            [&key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let mut totals: Totals = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let summary = price_summary(
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
    merge_price_summary(&mut totals.price_summary, &summary, sign);
    let automatic = usage_automatic_price_summary(usage, cost);
    merge_automatic_price_summary(&mut totals.automatic_price_summary, &automatic, sign);
    totals.input_tokens += sign * usage.input_tokens;
    totals.output_tokens += sign * usage.output_tokens;
    totals.cache_read_tokens += sign * usage.cache_read_tokens;
    totals.cache_write_tokens += sign * usage.cache_write_tokens;
    totals.request_count += sign;
    totals.priced_cost_usd += sign as f64 * cost.usd.unwrap_or(0.0);
    totals.priced_cost_cny += sign as f64 * cost.cny.unwrap_or(0.0);
    totals.unpriced_requests += sign * i64::from(cost.usd.is_none() && cost.cny.is_none());
    totals.scenario_requests += sign * i64::from(!cost.scenarios.is_empty());
    for scenario in &cost.scenarios {
        add_scenario(
            &mut totals.scenarios,
            &scenario.mode,
            &scenario.evidence.currency,
            scenario.scenario_key.as_deref(),
            scenario.amount * sign as f64,
            sign,
        );
    }
    totals.incomplete_requests += sign * i64::from(!usage.unknown_fields.is_empty());
    let cache_known = !usage
        .unknown_fields
        .iter()
        .any(|f| matches!(f.as_str(), "input_tokens" | "cache_read_tokens"));
    totals.cache_unknown_requests += sign * i64::from(!cache_known);
    if cache_known {
        totals.known_cache_input_tokens += sign * usage.input_tokens;
        totals.known_cache_read_tokens += sign * usage.cache_read_tokens;
        totals.cache_known_requests += sign;
    }
    totals.known_cache_hit_ratio = cache_ratio(
        totals.known_cache_input_tokens,
        totals.known_cache_read_tokens,
    );
    totals.total_tokens = totals.input_tokens + totals.output_tokens;
    let unpriced = cost.usd.is_none() && cost.cny.is_none();
    let tokens_known = !usage
        .unknown_fields
        .iter()
        .any(|field| matches!(field.as_str(), "input_tokens" | "output_tokens"));
    add_completeness(
        &mut totals,
        usage.reasoning_tokens,
        usage
            .mode
            .as_deref()
            .filter(|_| usage.mode_basis == "response_reported"),
        usage.requested_mode.as_deref(),
        (unpriced && tokens_known).then_some(usage.input_tokens + usage.output_tokens),
        unpriced_reason(unpriced, !cost.scenarios.is_empty(), cost.reason.as_deref()),
        sign,
    );
    tx.execute(
        "UPDATE monitor_sessions SET totals=?2 WHERE key=?1",
        params![
            key,
            serde_json::to_string(&totals).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn add_scenario(
    rows: &mut Vec<ScenarioTotal>,
    mode: &str,
    currency: &str,
    scenario_key: Option<&str>,
    amount: f64,
    count: i64,
) {
    if let Some(row) = rows.iter_mut().find(|r| {
        r.mode == mode
            && r.currency == currency
            && r.scenario_key.as_deref().unwrap_or(&r.mode) == scenario_key.unwrap_or(mode)
    }) {
        row.amount += amount;
        row.request_count += count;
    } else {
        rows.push(ScenarioTotal {
            mode: mode.into(),
            currency: currency.into(),
            scenario_key: scenario_key.map(str::to_owned),
            amount,
            request_count: count,
        });
    }
    rows.retain(|r| r.request_count != 0);
}

/// Revisit only previously unquoted records. Published estimates retain their saved price evidence.
pub fn backfill_unquoted(conn: &mut Connection) -> Result<(), String> {
    backfill_unquoted_with_catalog(conn, &crate::model_catalog::snapshot())
}

fn backfill_unquoted_with_catalog(
    conn: &mut Connection,
    catalog: &crate::model_catalog::CatalogSnapshot,
) -> Result<(), String> {
    let next_version = pricing::revision(catalog);
    let version: Option<String> = conn
        .query_row(
            "SELECT data FROM monitor_state WHERE key='pricing_version'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if version.as_deref() == Some(next_version.as_str()) {
        return Ok(());
    }
    let mut after_tool = String::new();
    let mut after_id = String::new();
    loop {
        let rows = {
            let mut stmt=conn.prepare("SELECT tool,id FROM monitor_requests WHERE
                (tool>?1 OR (tool=?1 AND id>?2)) AND json_extract(cost,'$.usd') IS NULL AND json_extract(cost,'$.cny') IS NULL
                AND COALESCE(json_array_length(json_extract(cost,'$.scenarios')),0)=0 ORDER BY tool,id LIMIT 500").map_err(|e|e.to_string())?;
            let result = stmt
                .query_map(params![after_tool, after_id], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;
            result
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        if rows.is_empty() {
            break;
        }
        let tx = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        for (tool, id) in rows {
            after_tool = tool.clone();
            after_id = id.clone();
            let Some((usage, old)) = previous(&tx, &tool, &id)? else {
                continue;
            };
            if old.usd.is_some() || old.cny.is_some() || !old.scenarios.is_empty() {
                continue;
            }
            let next = pricing::estimate_with_catalog(&usage, catalog);
            if serde_json::to_string(&old).map_err(|e| e.to_string())?
                == serde_json::to_string(&next).map_err(|e| e.to_string())?
            {
                continue;
            }
            adjust(&tx, &usage, &old, -1)?;
            tx.execute(
                "UPDATE monitor_requests SET cost=?3 WHERE tool=?1 AND id=?2",
                params![
                    tool,
                    id,
                    serde_json::to_string(&next).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
            adjust(&tx, &usage, &next, 1)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    conn.execute("INSERT INTO monitor_state(key,data) VALUES('pricing_version',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[next_version]).map_err(|e|e.to_string())?;
    Ok(())
}

fn previous(
    conn: &Connection,
    tool: &str,
    id: &str,
) -> Result<Option<(UsageRecord, CostEstimate)>, String> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT usage,cost FROM monitor_requests WHERE tool=?1 AND id=?2",
            params![tool, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    row.map(|(u, c)| {
        Ok((
            serde_json::from_str(&u).map_err(|e| e.to_string())?,
            serde_json::from_str(&c).map_err(|e| e.to_string())?,
        ))
    })
    .transpose()
}

fn same_pricing_inputs(left: &UsageRecord, right: &UsageRecord) -> bool {
    left.model == right.model
        && left.timestamp_ms == right.timestamp_ms
        && left.provider == right.provider
        && left.provider_basis == right.provider_basis
        && left.mode == right.mode
        && left.mode_basis == right.mode_basis
        && left.input_tokens == right.input_tokens
        && left.output_tokens == right.output_tokens
        && left.cache_read_tokens == right.cache_read_tokens
        && left.cache_write_tokens == right.cache_write_tokens
        && left.cache_write_5m_tokens == right.cache_write_5m_tokens
        && left.cache_write_1h_tokens == right.cache_write_1h_tokens
        && left.context_tokens == right.context_tokens
        && [
            "input_tokens",
            "output_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "per_request_input_tokens",
            "timestamp",
        ]
        .iter()
        .all(|key| {
            left.unknown_fields.iter().any(|s| s == key)
                == right.unknown_fields.iter().any(|s| s == key)
        })
        && left
            .unknown_fields
            .iter()
            .filter(|s| s.starts_with("unsupported_pricing_modifier:"))
            .eq(right
                .unknown_fields
                .iter()
                .filter(|s| s.starts_with("unsupported_pricing_modifier:")))
}

pub fn delete_request(tx: &Transaction<'_>, tool: &str, id: &str) -> Result<(), String> {
    // Canonical response records permanently supersede legacy aliases, including later archive replays.
    tx.execute(
        "INSERT OR IGNORE INTO monitor_aliases(tool,id) VALUES(?1,?2)",
        params![tool, id],
    )
    .map_err(|e| e.to_string())?;
    remove_snapshot_request(tx, tool, id)
}

/// Remove a superseded snapshot row without permanently blacklisting its identity.
/// Unlike legacy alias suppression, a later authoritative snapshot may restore it.
pub(super) fn remove_snapshot_request(
    tx: &Transaction<'_>,
    tool: &str,
    id: &str,
) -> Result<(), String> {
    if let Some((usage, cost)) = previous(tx, tool, id)? {
        adjust(tx, &usage, &cost, -1)?;
        tx.execute(
            "DELETE FROM monitor_requests WHERE tool=?1 AND id=?2",
            params![tool, id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM monitor_observations WHERE tool=?1 AND id=?2",
            params![tool, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn save_usage(
    tx: &Transaction<'_>,
    incoming: &UsageRecord,
    live_after_ms: i64,
    observed_ms: i64,
) -> Result<(), String> {
    save_usage_with_catalog(
        tx,
        incoming,
        live_after_ms,
        observed_ms,
        &crate::model_catalog::snapshot(),
    )
}

pub fn save_usage_with_catalog(
    tx: &Transaction<'_>,
    incoming: &UsageRecord,
    live_after_ms: i64,
    observed_ms: i64,
    catalog: &crate::model_catalog::CatalogSnapshot,
) -> Result<(), String> {
    save_usage_impl(tx, incoming, live_after_ms, observed_ms, catalog, true)
}

/// Complete snapshot samples replace prior evidence, unlike partial stream chunks.
pub(super) fn save_snapshot_usage_with_catalog(
    tx: &Transaction<'_>,
    incoming: &UsageRecord,
    live_after_ms: i64,
    observed_ms: i64,
    catalog: &crate::model_catalog::CatalogSnapshot,
) -> Result<(), String> {
    save_usage_impl(tx, incoming, live_after_ms, observed_ms, catalog, false)
}

fn save_usage_impl(
    tx: &Transaction<'_>,
    incoming: &UsageRecord,
    live_after_ms: i64,
    observed_ms: i64,
    catalog: &crate::model_catalog::CatalogSnapshot,
    enrich_partial: bool,
) -> Result<(), String> {
    let superseded: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM monitor_aliases WHERE tool=?1 AND id=?2)",
            params![incoming.tool, incoming.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if superseded {
        return Ok(());
    }
    let old = previous(tx, &incoming.tool, &incoming.id)?;
    let mut merged = incoming.clone();
    if let Some((known, _)) = old.as_ref().filter(|_| enrich_partial) {
        // Late partial chunks may enrich a completed request, but cannot erase known usage.
        for field in incoming.unknown_fields.iter() {
            if known.unknown_fields.contains(field) {
                continue;
            }
            match field.as_str() {
                "input_tokens" => {
                    merged.input_tokens = known.input_tokens;
                    merged.context_tokens = known.context_tokens;
                }
                "output_tokens" => merged.output_tokens = known.output_tokens,
                "cache_read_tokens" => merged.cache_read_tokens = known.cache_read_tokens,
                "cache_write_tokens" => {
                    merged.cache_write_tokens = known.cache_write_tokens;
                    merged.cache_write_5m_tokens = known.cache_write_5m_tokens;
                    merged.cache_write_1h_tokens = known.cache_write_1h_tokens;
                }
                "per_request_input_tokens" => merged.context_tokens = known.context_tokens,
                _ => continue,
            }
            merged.unknown_fields.retain(|v| v != field);
        }
        if merged.model.is_none() {
            merged.model = known.model.clone();
            merged.model_basis = known.model_basis.clone();
        }
        if merged.source_input_tokens.is_none() {
            merged.source_input_tokens = known.source_input_tokens;
        }
        if merged.mode.is_none() {
            merged.mode = known.mode.clone();
            merged.mode_basis = known.mode_basis.clone();
        }
        if merged.provider.is_none() {
            merged.provider = known.provider.clone();
            merged.provider_basis = known.provider_basis.clone();
        }
        if merged.reasoning_tokens.is_none() {
            merged.reasoning_tokens = known.reasoning_tokens;
        }
        if merged.runtime_mode.is_none()
            && merged.session_id == known.session_id
            && merged.turn_id == known.turn_id
        {
            merged.runtime_mode = known.runtime_mode.clone();
        }
        if merged.duration_ms.is_none() {
            merged.duration_ms = known.duration_ms;
        }
        if let Some(old) = &known.request_timing {
            if let Some(timing) = &mut merged.request_timing {
                timing.started_at_ms = timing.started_at_ms.or(old.started_at_ms);
                timing.completed_at_ms = timing.completed_at_ms.or(old.completed_at_ms);
                timing.duration_ms = timing.duration_ms.or(old.duration_ms);
                timing.ttft_ms = timing.ttft_ms.or(old.ttft_ms);
                timing.streaming_duration_ms =
                    timing.streaming_duration_ms.or(old.streaming_duration_ms);
            } else {
                merged.request_timing = Some(old.clone());
            }
        }
    }
    if merged.tool == "codex" && !merged.turn_id.is_empty() {
        let evidence: Option<String> = tx
            .query_row(
                "SELECT data FROM monitor_turn_mode_evidence WHERE session_key=?1 AND turn_id=?2",
                params![
                    session_key(&merged.tool, &merged.session_id),
                    merged.turn_id
                ],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let evidence = evidence
            .map(|json| serde_json::from_str(&json))
            .transpose()
            .map_err(|error| error.to_string())?
            .or_else(|| merged.runtime_mode.clone());
        merged.runtime_mode =
            evidence.and_then(|evidence| runtime_mode_for_usage(&merged, evidence));
    }
    let usage = &merged;
    let json = serde_json::to_string(usage).map_err(|e| e.to_string())?;
    if let Some((ref u, _)) = old {
        if serde_json::to_string(u).map_err(|e| e.to_string())? == json {
            return Ok(());
        }
    }
    let key = session_key(&usage.tool, &usage.session_id);
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM monitor_sessions WHERE key=?1)",
            [&key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        save_session(
            tx,
            &SessionMeta {
                tool: usage.tool.clone(),
                id: usage.session_id.clone(),
                model: usage.model.clone(),
                status: "unknown".into(),
                started_at_ms: usage.timestamp_ms,
                updated_at_ms: usage.timestamp_ms,
                ..Default::default()
            },
        )?;
    }
    let prior_output = old.as_ref().map_or(0, |(u, _)| u.output_tokens);
    let cost = old
        .as_ref()
        .filter(|(known, _)| same_pricing_inputs(known, usage))
        .map(|(_, cost)| cost.clone())
        .unwrap_or_else(|| pricing::estimate_with_catalog(usage, catalog));
    if let Some((u, c)) = old {
        adjust(tx, &u, &c, -1)?;
    }
    tx.execute("INSERT INTO monitor_requests(tool,id,session_key,timestamp_ms,usage,cost) VALUES(?1,?2,?3,?4,?5,?6)
        ON CONFLICT(tool,id) DO UPDATE SET session_key=excluded.session_key,timestamp_ms=excluded.timestamp_ms,usage=excluded.usage,cost=excluded.cost",
        params![usage.tool,usage.id,key,usage.timestamp_ms,json,serde_json::to_string(&cost).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    adjust(tx, usage, &cost, 1)?;
    let delta = usage.output_tokens - prior_output;
    // LS timestamps identify request start. Only its reported full duration can establish
    // a later freshness endpoint; this arithmetic endpoint is not an observed timestamp.
    let output_time = (usage.tool == "antigravity" && usage.timestamp_ms > 0)
        .then_some(usage.duration_ms)
        .flatten()
        .filter(|duration| *duration >= 0)
        .and_then(|duration| usage.timestamp_ms.checked_add(duration))
        .unwrap_or(usage.timestamp_ms);
    // Old history/catch-up is durable usage, but is not output generated since this collector started.
    if delta > 0
        && usage.usage_basis != "legacy_initial_cumulative"
        && !usage.unknown_fields.iter().any(|f| f == "timestamp")
        && output_time >= live_after_ms
        && output_time <= observed_ms + 5_000
        && output_time >= observed_ms - 60_000
    {
        tx.execute("INSERT INTO monitor_observations(tool,id,session_key,observed_ms,output_tokens) VALUES(?1,?2,?3,?4,?5)",
            params![usage.tool,usage.id,key,observed_ms,delta]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn cache_ratio(input: i64, read: i64) -> Option<f64> {
    (input > 0).then(|| read as f64 / input as f64)
}

pub(super) fn finish_totals(t: &mut Totals) {
    t.total_tokens = t.input_tokens + t.output_tokens;
    t.cache_hit_ratio = if t.cache_unknown_requests == 0 {
        cache_ratio(t.input_tokens, t.cache_read_tokens)
    } else {
        None
    };
    t.known_cache_hit_ratio = cache_ratio(t.known_cache_input_tokens, t.known_cache_read_tokens);
    if t.priced_cost_usd.abs() < 1e-12 {
        t.priced_cost_usd = 0.0;
    }
    if t.priced_cost_cny.abs() < 1e-12 {
        t.priced_cost_cny = 0.0;
    }
}

fn speed_sample(usage: &UsageRecord) -> Option<RequestSpeedSample> {
    let timing = usage.request_timing.as_ref()?;
    let duration = timing.duration_ms.filter(|duration| *duration > 0)?;
    if timing.basis.is_empty()
        || usage
            .unknown_fields
            .iter()
            .any(|field| field == "output_tokens")
    {
        return None;
    }
    Some(RequestSpeedSample {
        request_id: usage.id.clone(),
        timestamp_ms: usage.timestamp_ms,
        output_tokens: usage.output_tokens,
        duration_ms: duration,
        output_tokens_per_second: usage.output_tokens as f64 * 1_000. / duration as f64,
        basis: timing.basis.clone(),
        started_at_ms: timing.started_at_ms,
        completed_at_ms: timing.completed_at_ms,
        ttft_ms: timing.ttft_ms,
        streaming_duration_ms: timing.streaming_duration_ms,
        streaming_tokens_per_second: timing
            .streaming_duration_ms
            .filter(|duration| *duration > 0)
            .map(|duration| usage.output_tokens as f64 * 1_000. / duration as f64),
    })
}
fn add_speed(total: &mut WeightedRequestSpeed, sample: &RequestSpeedSample) {
    total.valid_samples += 1;
    total.output_tokens += sample.output_tokens;
    total.duration_ms += sample.duration_ms;
    total.output_tokens_per_second =
        Some(total.output_tokens as f64 * 1_000. / total.duration_ms as f64);
}
fn request_summary(
    conn: &Connection,
    key: &str,
) -> Result<(Option<RecentRequest>, RequestSpeed), String> {
    let mut query=conn.prepare("SELECT usage FROM monitor_requests WHERE session_key=?1 ORDER BY timestamp_ms DESC,id DESC LIMIT 10").map_err(|error|error.to_string())?;
    let rows = query
        .query_map([key], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut recent = None;
    let mut speed = RequestSpeed::default();
    let mut groups = std::collections::BTreeMap::<String, WeightedRequestSpeed>::new();
    for row in rows {
        let usage: UsageRecord = serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())?;
        if recent.is_none() {
            recent = Some(RecentRequest {
                id: usage.id.clone(),
                timestamp_ms: usage.timestamp_ms,
                model: usage.model.clone(),
                model_basis: usage.model_basis.clone(),
                mode: usage.mode.clone(),
                mode_basis: usage.mode_basis.clone(),
                requested_mode: usage.requested_mode.clone(),
                requested_model: usage.requested_model.clone(),
                request_timing: usage.request_timing.clone(),
                runtime_mode: usage.runtime_mode.clone(),
                unknown_fields: usage.unknown_fields.clone(),
            });
        }
        speed.last10.total_samples += 1;
        if let Some(timing) = usage
            .request_timing
            .as_ref()
            .filter(|timing| !timing.basis.is_empty())
        {
            groups
                .entry(timing.basis.clone())
                .or_insert_with(|| WeightedRequestSpeed {
                    basis: Some(timing.basis.clone()),
                    ..Default::default()
                })
                .total_samples += 1;
        }
        if let Some(sample) = speed_sample(&usage) {
            if speed.latest.is_none() {
                speed.latest = Some(sample.clone());
            }
            add_speed(&mut speed.last10, &sample);
            let group =
                groups
                    .entry(sample.basis.clone())
                    .or_insert_with(|| WeightedRequestSpeed {
                        basis: Some(sample.basis.clone()),
                        ..Default::default()
                    });
            add_speed(group, &sample);
        }
    }
    speed.by_basis = groups.into_values().collect();
    speed.last10.basis = match speed.by_basis.as_slice() {
        [group] => group.basis.clone(),
        [] => None,
        _ => Some("mixed_request_timing_bases".into()),
    };
    if speed.latest.is_none() {
        let json:Option<String>=conn.query_row("SELECT usage FROM monitor_requests WHERE session_key=?1 AND json_extract(usage,'$.requestTiming.durationMs')>0 AND COALESCE(json_extract(usage,'$.requestTiming.basis'),'')!='' AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='output_tokens') ORDER BY timestamp_ms DESC,id DESC LIMIT 1",[key],|row|row.get(0)).optional().map_err(|error|error.to_string())?;
        if let Some(json) = json {
            speed.latest =
                speed_sample(&serde_json::from_str(&json).map_err(|error| error.to_string())?);
        }
    }
    Ok((recent, speed))
}

fn completed_turn_summaries(
    conn: &Connection,
    keys: &std::collections::BTreeSet<String>,
    turn_id: Option<&str>,
) -> Result<std::collections::BTreeMap<String, CompletedTurnSummary>, String> {
    let mut summaries = std::collections::BTreeMap::new();
    if keys.is_empty() {
        return Ok(summaries);
    }
    let turn_filter = if turn_id.is_some() {
        "t.turn_id=?2"
    } else {
        "?2 IS NULL"
    };
    let sql = format!("WITH wanted(session_key) AS (SELECT value FROM json_each(?1)), ranked AS (
            SELECT t.session_key,t.turn_id,t.data,
              ROW_NUMBER() OVER(PARTITION BY t.session_key ORDER BY json_extract(t.data,'$.completedAtMs') DESC,t.turn_id DESC) AS rank
            FROM wanted w JOIN monitor_turns t ON t.session_key=w.session_key
            WHERE json_extract(t.data,'$.completedAtMs')>0 AND {turn_filter}
          ), latest AS (SELECT session_key,turn_id,data FROM ranked WHERE rank=1)
          SELECT l.session_key,l.data,COUNT(r.id),SUM(json_extract(r.usage,'$.outputTokens')),
            SUM(CASE WHEN json_type(r.usage,'$.outputTokens') IS NOT 'integer'
              OR json_extract(r.usage,'$.usageBasis')='legacy_initial_cumulative'
              OR EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='output_tokens') THEN 1 ELSE 0 END)
          FROM latest l LEFT JOIN monitor_requests r
            ON r.session_key=l.session_key AND json_extract(r.usage,'$.turnId')=l.turn_id
          GROUP BY l.session_key,l.data");
    let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![
                serde_json::to_string(keys).map_err(|error| error.to_string())?,
                turn_id
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (key, json, count, output, unknown) = row.map_err(|error| error.to_string())?;
        let timing: TurnTiming = serde_json::from_str(&json).map_err(|error| error.to_string())?;
        let output_tokens = (count > 0 && unknown == 0).then_some(output).flatten();
        // Whole-turn wall time includes reasoning/tool waits; never substitute for request speed.
        let output_tokens_per_second = output_tokens
            .zip(timing.duration_ms.filter(|duration| *duration > 0))
            .map(|(tokens, duration)| tokens as f64 * 1000. / duration as f64);
        summaries.insert(
            key,
            CompletedTurnSummary {
                timing,
                output_tokens,
                output_tokens_per_second,
            },
        );
    }
    Ok(summaries)
}

pub fn enrich_session_outputs(
    conn: &Connection,
    outputs: &mut [&mut [SessionSummary]],
) -> Result<(), String> {
    let keys = outputs
        .iter()
        .flat_map(|rows| rows.iter().map(|row| row.key.clone()))
        .collect();
    let completed = completed_turn_summaries(conn, &keys, None)?;
    let mut enriched = std::collections::BTreeMap::new();
    for sessions in outputs {
        for session in sessions.iter_mut() {
            if !enriched.contains_key(&session.key) {
                enriched.insert(session.key.clone(), request_summary(conn, &session.key)?);
            }
            let (recent, speed) = &enriched[&session.key];
            session.recent_request = recent.clone();
            session.request_speed = speed.clone();
            session.latest_completed_turn = completed.get(&session.key).cloned();
        }
    }
    Ok(())
}

pub fn sessions(
    conn: &Connection,
    tool: Option<&str>,
    now: i64,
) -> Result<Vec<SessionSummary>, String> {
    let mut stmt=conn.prepare("SELECT key,meta,totals FROM monitor_sessions WHERE (?1 IS NULL OR tool=?1) ORDER BY updated_ms DESC").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([tool], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (key, meta, totals) = row.map_err(|e| e.to_string())?;
        let mut meta: SessionMeta = serde_json::from_str(&meta).map_err(|e| e.to_string())?;
        let mut totals: Totals = serde_json::from_str(&totals).map_err(|e| e.to_string())?;
        finish_totals(&mut totals);
        if matches!(meta.status.as_str(), "running" | "active")
            && meta.updated_at_ms < now - 120_000
        {
            meta.status = "stale".into();
        }
        out.push(SessionSummary {
            key,
            meta,
            totals,
            recent_request: None,
            request_speed: RequestSpeed::default(),
            latest_completed_turn: None,
        });
    }
    let mut rates=conn.prepare("SELECT r.session_key,SUM(o.output_tokens)/60.0 FROM monitor_observations o JOIN monitor_requests r ON r.tool=o.tool AND r.id=o.id WHERE o.observed_ms>?1 AND o.observed_ms<=?2 AND COALESCE(json_extract(r.usage,'$.usageBasis'),'')!='legacy_initial_cumulative' GROUP BY r.session_key").map_err(|e|e.to_string())?;
    let rate_rows = rates
        .query_map(params![now - 60_000, now], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut by_key = std::collections::HashMap::new();
    for row in rate_rows {
        let (k, v) = row.map_err(|e| e.to_string())?;
        by_key.insert(k, v);
    }
    for row in &mut out {
        row.totals.output_tokens_per_second = *by_key.get(&row.key).unwrap_or(&0.0);
        if row.meta.status == "unknown" && row.totals.output_tokens_per_second > 0.0 {
            row.meta.status = "recent".into();
        }
    }
    out.sort_by_key(|s| {
        (
            !matches!(s.meta.status.as_str(), "running" | "active" | "recent"),
            std::cmp::Reverse(s.meta.updated_at_ms),
        )
    });
    Ok(out)
}

/// `sessions` supplies unique keys in stable display order; no second rate query or rollup.
pub fn rate_sessions(rows: &[SessionSummary]) -> Vec<SessionSummary> {
    rows.iter()
        .filter(|row| {
            matches!(
                row.meta.status.as_str(),
                "running" | "active" | "stale" | "recent"
            ) || row.totals.output_tokens_per_second > 0.0
        })
        .cloned()
        .collect()
}

pub fn sum_sessions(rows: &[SessionSummary]) -> Totals {
    let mut t = Totals::default();
    for row in rows {
        merge_totals(&mut t, &row.totals);
    }
    finish_totals(&mut t);
    t
}

pub(super) fn merge_totals(t: &mut Totals, s: &Totals) {
    merge_price_summary(&mut t.price_summary, &s.price_summary, 1);
    merge_automatic_price_summary(
        &mut t.automatic_price_summary,
        &s.automatic_price_summary,
        1,
    );
    t.input_tokens += s.input_tokens;
    t.output_tokens += s.output_tokens;
    t.cache_read_tokens += s.cache_read_tokens;
    t.cache_write_tokens += s.cache_write_tokens;
    t.request_count += s.request_count;
    t.priced_cost_usd += s.priced_cost_usd;
    t.priced_cost_cny += s.priced_cost_cny;
    t.scenario_requests += s.scenario_requests;
    for scenario in &s.scenarios {
        add_scenario(
            &mut t.scenarios,
            &scenario.mode,
            &scenario.currency,
            scenario.scenario_key.as_deref(),
            scenario.amount,
            scenario.request_count,
        );
    }
    t.unpriced_requests += s.unpriced_requests;
    t.incomplete_requests += s.incomplete_requests;
    t.output_tokens_per_second += s.output_tokens_per_second;
    t.cache_unknown_requests += s.cache_unknown_requests;
    t.known_cache_input_tokens += s.known_cache_input_tokens;
    t.known_cache_read_tokens += s.known_cache_read_tokens;
    t.cache_known_requests += s.cache_known_requests;
    t.reasoning_tokens += s.reasoning_tokens;
    t.reasoning_known_requests += s.reasoning_known_requests;
    t.unpriced_tokens += s.unpriced_tokens;
    t.unpriced_token_known_requests += s.unpriced_token_known_requests;
    for (target, source) in [
        (&mut t.actual_mode_counts, &s.actual_mode_counts),
        (&mut t.requested_mode_counts, &s.requested_mode_counts),
        (&mut t.unpriced_reason_counts, &s.unpriced_reason_counts),
    ] {
        for (mode, count) in source {
            *target.entry(mode.clone()).or_default() += count;
        }
    }
}

pub fn filter_sessions(
    rows: &mut Vec<SessionSummary>,
    search: &str,
    active: Option<bool>,
    unpriced_only: bool,
) {
    let search = search.trim().to_lowercase();
    rows.retain(|row| {
        let running = matches!(
            row.meta.status.as_str(),
            "running" | "active" | "stale" | "recent"
        );
        active.map_or(true, |expected| expected == running)
            && (!unpriced_only || current_unpriced_requests(&row.totals) > 0)
            && (search.is_empty()
                || [
                    Some(row.meta.id.as_str()),
                    row.meta.project.as_deref(),
                    row.meta.model.as_deref(),
                ]
                .into_iter()
                .flatten()
                .any(|value| value.to_lowercase().contains(&search)))
    });
}

pub(super) fn current_unpriced_requests(totals: &Totals) -> i64 {
    (totals.request_count
        - totals
            .automatic_price_summary
            .by_mode
            .values()
            .map(|mode| mode.covered_requests)
            .sum::<i64>())
    .max(0)
}

#[cfg(test)]
pub fn session_detail(
    conn: &Connection,
    key: &str,
    offset: u32,
    limit: u32,
    now: i64,
    unpriced_only: bool,
    period: &MonitorPeriod,
) -> Result<SessionDetail, String> {
    session_detail_with_descendants(conn, key, offset, limit, now, unpriced_only, period, false)
}

pub fn session_detail_with_descendants(
    conn: &Connection,
    key: &str,
    offset: u32,
    limit: u32,
    now: i64,
    unpriced_only: bool,
    period: &MonitorPeriod,
    include_descendants: bool,
) -> Result<SessionDetail, String> {
    let all = sessions(conn, None, now)?;
    let mut session = all
        .iter()
        .find(|session| session.key == key)
        .cloned()
        .ok_or("Session not found")?;
    let mut children = std::collections::BTreeMap::<&str, Vec<&SessionSummary>>::new();
    for row in all.iter().filter(|row| row.meta.tool == session.meta.tool) {
        if let Some(parent) = row.meta.parent_id.as_deref() {
            children.entry(parent).or_default().push(row);
        }
    }
    let mut members = vec![session.clone()];
    let mut visited = std::collections::BTreeSet::from([key.to_owned()]);
    let mut index = 0;
    while index < members.len() {
        if let Some(descendants) = children.get(members[index].meta.id.as_str()) {
            for child in descendants {
                if visited.insert(child.key.clone()) {
                    members.push((*child).clone());
                }
            }
        }
        index += 1;
    }
    enrich_session_outputs(conn, &mut [std::slice::from_mut(&mut session)])?;
    members[0] = session.clone();
    let scope_keys: Vec<_> = if include_descendants {
        members.iter().map(|member| member.key.clone()).collect()
    } else {
        vec![key.to_owned()]
    };
    let selected_completed_turn = if let Some(turn_id) = period.turn_id.as_deref() {
        completed_turn_summaries(
            conn,
            &std::collections::BTreeSet::from([key.to_owned()]),
            Some(turn_id),
        )?
        .remove(key)
    } else {
        None
    };
    let saved_timings = {
        let mut query = conn
            .prepare("SELECT turn_id,data FROM monitor_turns WHERE session_key=?1")
            .map_err(|error| error.to_string())?;
        let rows = query
            .query_map([key], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        rows.map(|row| {
            let (id, json) = row.map_err(|error| error.to_string())?;
            Ok((
                id,
                serde_json::from_str::<TurnTiming>(&json).map_err(|error| error.to_string())?,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?
    };
    let mut known_turns: std::collections::BTreeSet<_> = saved_timings
        .iter()
        .map(|(id, _)| id.clone())
        .filter(|id| !id.is_empty())
        .collect();
    if include_descendants && members.len() > 1 {
        let mut query = conn.prepare("SELECT DISTINCT json_extract(usage,'$.turnId') FROM monitor_requests WHERE session_key=?1").map_err(|error| error.to_string())?;
        let rows = query
            .query_map([key], |row| row.get::<_, Option<String>>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            if let Some(id) = row
                .map_err(|error| error.to_string())?
                .filter(|id| !id.is_empty())
            {
                known_turns.insert(id);
            }
        }
    }
    let mut page_ids = Vec::new();
    let mut by_turn = std::collections::BTreeMap::<String, TurnSummary>::new();
    let mut filtered_totals = Totals::default();
    let mut request_count = 0;
    let mut unlinked_child_requests = 0;
    super::analysis::each_usage_in_sessions(conn, &scope_keys, period, |row| {
        merge_totals(&mut filtered_totals, &row.totals);
        let display_turn = if row.key == key {
            Some(row.turn_id.clone())
        } else {
            row.root_turn_id.filter(|turn| known_turns.contains(turn))
        };
        if display_turn.is_none() {
            unlinked_child_requests += 1;
        }
        if period
            .turn_id
            .as_ref()
            .map_or(true, |id| display_turn.as_ref() == Some(id))
            && (!unpriced_only || current_unpriced_requests(&row.totals) > 0)
            && period.pricing_reason.as_ref().map_or(true, |reason| {
                row.totals.unpriced_reason_counts.contains_key(reason)
            })
        {
            if request_count >= i64::from(offset) && page_ids.len() < limit as usize {
                page_ids.push(row.id);
            }
            request_count += 1;
        }
        let Some(turn_id) = display_turn else {
            return;
        };
        let turn = by_turn
            .entry(turn_id.clone())
            .or_insert_with(|| TurnSummary {
                id: turn_id,
                started_at_ms: row.timestamp_ms,
                updated_at_ms: row.timestamp_ms,
                totals: Totals::default(),
                timing: None,
            });
        turn.started_at_ms = turn.started_at_ms.min(row.timestamp_ms);
        turn.updated_at_ms = turn.updated_at_ms.max(row.timestamp_ms);
        merge_totals(&mut turn.totals, &row.totals);
    })?;
    let mut query = conn
        .prepare(
            "SELECT r.usage,r.cost FROM json_each(?1) page
        JOIN monitor_requests r ON r.tool=?2 AND r.id=page.value
          AND r.session_key IN (SELECT value FROM json_each(?3))
        ORDER BY CAST(page.key AS INTEGER)",
        )
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map(
            params![
                serde_json::to_string(&page_ids).map_err(|error| error.to_string())?,
                session.meta.tool,
                serde_json::to_string(&scope_keys).map_err(|error| error.to_string())?
            ],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let mut requests = Vec::new();
    for row in rows {
        let (usage, cost) = row.map_err(|error| error.to_string())?;
        requests.push(RequestDetail {
            usage: serde_json::from_str(&usage).map_err(|error| error.to_string())?,
            cost: serde_json::from_str(&cost).map_err(|error| error.to_string())?,
        });
    }
    finish_totals(&mut filtered_totals);
    let mut turns: Vec<_> = by_turn.into_values().collect();
    for (id, timing) in saved_timings {
        if let Some(turn) = turns.iter_mut().find(|turn| turn.id == id) {
            turn.timing = Some(timing);
        } else if period.model.is_none() {
            if let Some(time) = timing
                .completed_at_ms
                .or(timing.started_at_ms)
                .filter(|time| {
                    period.start_ms.map_or(true, |start| *time >= start)
                        && period.end_ms.map_or(true, |end| *time < end)
                })
            {
                turns.push(TurnSummary {
                    id,
                    started_at_ms: timing.started_at_ms.unwrap_or(time),
                    updated_at_ms: time,
                    totals: Totals::default(),
                    timing: Some(timing),
                });
            }
        }
    }
    for turn in &mut turns {
        finish_totals(&mut turn.totals);
    }
    turns.sort_by_key(|turn| std::cmp::Reverse(turn.updated_at_ms));
    Ok(SessionDetail {
        request_count,
        session,
        members,
        include_descendants,
        unlinked_child_requests,
        requests,
        turns,
        filtered_totals,
        selected_completed_turn,
    })
}

#[cfg(test)]
mod completeness_tests {
    use super::*;
    fn record(id: &str, tool: &str, output: i64) -> UsageRecord {
        UsageRecord {
            id: id.into(),
            tool: tool.into(),
            session_id: "session".into(),
            turn_id: "turn1".into(),
            timestamp_ms: 1000,
            input_tokens: 100,
            context_tokens: Some(100),
            output_tokens: output,
            model: Some("unpriced-fixture".into()),
            ..Default::default()
        }
    }
    fn save(conn: &mut Connection, usage: &UsageRecord) {
        let tx = conn.transaction().unwrap();
        save_usage_with_catalog(
            &tx,
            usage,
            i64::MAX,
            0,
            &crate::model_catalog::CatalogSnapshot::default(),
        )
        .unwrap();
        tx.commit().unwrap();
    }
    #[test]
    fn full_session_aggregation_leaves_unreturned_request_history_unenriched() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let good = record("good", "codex", 50);
        save(&mut conn, &good);
        let tx = conn.transaction().unwrap();
        save_session(
            &tx,
            &SessionMeta {
                tool: "codex".into(),
                id: "unreturned".into(),
                status: "idle".into(),
                updated_at_ms: 1,
                ..Default::default()
            },
        )
        .unwrap();
        tx.commit().unwrap();
        conn.execute("INSERT INTO monitor_requests(tool,id,session_key,timestamp_ms,usage,cost) VALUES('codex','old-schema','codex:unreturned',1,'{}','{}')",[]).unwrap();
        let rows = sessions(&conn, None, 2000).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(
            rows.iter()
                .all(|row| row.recent_request.is_none()
                    && row.request_speed.last10.total_samples == 0)
        );
        let selected = rows
            .into_iter()
            .find(|row| row.key == "codex:session")
            .unwrap();
        let mut page = vec![selected.clone()];
        let mut rates = vec![selected];
        enrich_session_outputs(&conn, &mut [&mut page, &mut rates]).unwrap();
        assert_eq!(page[0].recent_request.as_ref().unwrap().id, "good");
        assert_eq!(rates[0].recent_request.as_ref().unwrap().id, "good");
    }
    #[test]
    fn unpriced_reason_counts_and_filter_follow_automatic_quote_coverage() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut scenario = record("scenario", "codex", 50);
        scenario.model = Some("gpt-6.1-sol".into());
        let mut missing = record("missing", "codex", 50);
        missing.model = Some("qianfan-code-latest".into());
        let mut priced = record("priced", "codex", 50);
        priced.model = Some("gpt-6.1-sol".into());
        priced.mode = Some("standard".into());
        priced.mode_basis = "response_reported".into();
        for usage in [&scenario, &missing, &priced] {
            save(&mut conn, usage);
        }
        let totals = sum_sessions(&sessions(&conn, None, 2000).unwrap());
        assert_eq!((totals.unpriced_requests, totals.scenario_requests), (2, 1));
        assert_eq!(
            totals.unpriced_reason_counts.get("actual_mode_unknown"),
            Some(&1)
        );
        assert_eq!(
            totals
                .unpriced_reason_counts
                .get("subscription_routing_alias_needs_model"),
            Some(&1)
        );
        assert_eq!(totals.unpriced_reason_counts.values().sum::<i64>(), 2);
        let detail = session_detail(
            &conn,
            "codex:session",
            0,
            100,
            2000,
            true,
            &MonitorPeriod::default(),
        )
        .unwrap();
        assert_eq!(detail.request_count, 2);
        let mut ids = detail.requests.iter().map(|request| request.usage.id.as_str()).collect::<Vec<_>>();
        ids.sort_unstable();
        assert_eq!(ids, ["missing", "scenario"]);
        let analysis = super::super::analysis::read(
            &conn,
            None,
            &MonitorPeriod::default(),
            "",
            None,
            false,
            0,
            100,
            2000,
        )
        .unwrap();
        assert_eq!(
            analysis.totals.unpriced_reason_counts,
            totals.unpriced_reason_counts
        );
        let tx = conn.transaction().unwrap();
        delete_request(&tx, "codex", "scenario").unwrap();
        tx.commit().unwrap();
        let totals = sum_sessions(&sessions(&conn, None, 2000).unwrap());
        assert!(!totals
            .unpriced_reason_counts
            .contains_key("actual_mode_unknown"));
    }
    #[test]
    fn period_metrics_preserve_mode_evidence_reasoning_coverage_and_all_tool_overview() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut a = record("a", "codex", 50);
        a.reasoning_tokens = Some(10);
        a.mode = Some("fast".into());
        a.mode_basis = "response_reported".into();
        a.requested_mode = Some("standard".into());
        let mut b = record("b", "codex", 0);
        b.mode = Some("fast".into());
        b.mode_basis = "requested".into();
        b.requested_mode = Some("fast".into());
        b.unknown_fields.push("output_tokens".into());
        let mut c = record("c", "claude", 50);
        c.model = Some("gpt-6.1-sol".into());
        c.reasoning_tokens = Some(0);
        c.mode = Some("standard".into());
        c.mode_basis = "response_reported".into();
        for usage in [&a, &b, &c] {
            save(&mut conn, usage);
        }
        let result = super::super::analysis::read(
            &conn,
            Some("codex"),
            &MonitorPeriod::default(),
            "",
            None,
            false,
            0,
            100,
            2000,
        )
        .unwrap();
        assert_eq!(
            (
                result.totals.request_count,
                result.totals.reasoning_tokens,
                result.totals.reasoning_known_requests
            ),
            (2, 10, 1)
        );
        assert_eq!(result.totals.actual_mode_counts.get("fast"), Some(&1));
        assert_eq!(result.totals.actual_mode_counts.get("unknown"), Some(&1));
        assert_eq!(result.totals.requested_mode_counts.get("fast"), Some(&1));
        assert_eq!(
            (
                result.totals.unpriced_tokens,
                result.totals.unpriced_token_known_requests
            ),
            (150, 1)
        );
        assert_eq!(result.by_tool.len(), 1);
        assert_eq!(result.tool_overview.len(), 4);
        assert_eq!(
            result
                .tool_overview
                .iter()
                .find(|row| row.tool == "claude")
                .unwrap()
                .totals
                .request_count,
            1
        );
        let tx = conn.transaction().unwrap();
        delete_request(&tx, "codex", "a").unwrap();
        tx.commit().unwrap();
        b.unknown_fields.clear();
        b.output_tokens = 20;
        b.reasoning_tokens = Some(5);
        save(&mut conn, &b);
        let totals = sum_sessions(&sessions(&conn, None, 2000).unwrap());
        assert_eq!(
            (totals.reasoning_tokens, totals.reasoning_known_requests),
            (5, 2)
        );
        assert_eq!(
            (totals.unpriced_tokens, totals.unpriced_token_known_requests),
            (120, 1)
        );
        assert!(!totals.actual_mode_counts.contains_key("fast"));
    }
    #[test]
    fn completeness_migration_is_once_only_and_never_rewrites_quotes() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut usage = record("a", "codex", 50);
        usage.reasoning_tokens = Some(12);
        save(&mut conn, &usage);
        let before: String = conn
            .query_row("SELECT cost FROM monitor_requests", [], |row| row.get(0))
            .unwrap();
        conn.execute_batch("DELETE FROM monitor_state WHERE key IN ('completeness_totals_v2','completeness_totals_v3','completeness_totals_v4');UPDATE monitor_sessions SET totals=json_remove(totals,'$.reasoningTokens','$.reasoningKnownRequests','$.actualModeCounts','$.requestedModeCounts','$.unpricedTokens','$.unpricedTokenKnownRequests','$.unpricedReasonCounts','$.priceSummary','$.automaticPriceSummary');").unwrap();
        initialize(&conn).unwrap();
        let totals = sum_sessions(&sessions(&conn, None, 2000).unwrap());
        assert_eq!(
            (
                totals.reasoning_tokens,
                totals.reasoning_known_requests,
                totals.unpriced_tokens
            ),
            (12, 1, 150)
        );
        assert_eq!(totals.actual_mode_counts.get("unknown"), Some(&1));
        let after: String = conn
            .query_row("SELECT cost FROM monitor_requests", [], |row| row.get(0))
            .unwrap();
        assert_eq!(before, after);
        conn.execute_batch("CREATE TRIGGER no_repeat BEFORE UPDATE ON monitor_sessions BEGIN SELECT RAISE(ABORT,'unexpected repeat'); END;").unwrap();
        initialize(&conn).unwrap();
    }
    #[test]
    fn request_speed_is_weighted_while_turn_timing_is_separate_and_retained() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut a = record("a", "antigravity", 100);
        a.timestamp_ms = 1000;
        a.request_timing = Some(RequestTiming {
            duration_ms: Some(1000),
            basis: "fixture_request".into(),
            ..Default::default()
        });
        let mut b = record("b", "antigravity", 900);
        b.timestamp_ms = 2000;
        b.request_timing = Some(RequestTiming {
            duration_ms: Some(3000),
            ttft_ms: Some(200),
            streaming_duration_ms: Some(2800),
            basis: "fixture_request".into(),
            ..Default::default()
        });
        let mut c = record("c", "antigravity", 500);
        c.timestamp_ms = 3000;
        c.duration_ms = Some(1000);
        c.turn_id = "turn2".into();
        c.requested_mode = Some("fast".into());
        for usage in [&a, &b, &c] {
            save(&mut conn, usage);
        }
        let tx = conn.transaction().unwrap();
        for meta in [
            SessionMeta {
                tool: "antigravity".into(),
                id: "session".into(),
                updated_at_ms: 1000,
                turn_timing: Some(TurnTiming {
                    turn_id: "turn1".into(),
                    started_at_ms: Some(1000),
                    basis: "fixture_turn".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            SessionMeta {
                tool: "antigravity".into(),
                id: "session".into(),
                updated_at_ms: 4000,
                turn_timing: Some(TurnTiming {
                    turn_id: "turn2".into(),
                    started_at_ms: Some(4000),
                    basis: "fixture_turn".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            SessionMeta {
                tool: "antigravity".into(),
                id: "session".into(),
                updated_at_ms: 3000,
                turn_timing: Some(TurnTiming {
                    turn_id: "turn1".into(),
                    completed_at_ms: Some(3000),
                    duration_ms: Some(2000),
                    basis: "fixture_turn".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ] {
            save_session(&tx, &meta).unwrap();
        }
        tx.commit().unwrap();
        let mut rows = sessions(&conn, None, 5000).unwrap();
        enrich_session_outputs(&conn, &mut [&mut rows]).unwrap();
        let session = &rows[0];
        assert_eq!(
            (
                session.request_speed.last10.valid_samples,
                session.request_speed.last10.total_samples
            ),
            (2, 3)
        );
        assert_eq!(
            session.request_speed.last10.output_tokens_per_second,
            Some(250.)
        );
        assert_eq!(
            session.request_speed.latest.as_ref().unwrap().request_id,
            "b"
        );
        assert_eq!(session.recent_request.as_ref().unwrap().id, "c");
        assert_eq!(
            session
                .recent_request
                .as_ref()
                .unwrap()
                .requested_mode
                .as_deref(),
            Some("fast")
        );
        b.request_timing = Some(RequestTiming {
            basis: "fixture_request".into(),
            ..Default::default()
        });
        save(&mut conn, &b);
        let mut refreshed = sessions(&conn, None, 5000).unwrap();
        enrich_session_outputs(&conn, &mut [&mut refreshed]).unwrap();
        assert_eq!(
            refreshed[0]
                .request_speed
                .latest
                .as_ref()
                .unwrap()
                .duration_ms,
            3000
        );
        let detail = session_detail(
            &conn,
            "antigravity:session",
            0,
            100,
            5000,
            false,
            &MonitorPeriod::default(),
        )
        .unwrap();
        let timing = detail
            .turns
            .iter()
            .find(|turn| turn.id == "turn1")
            .unwrap()
            .timing
            .as_ref()
            .unwrap();
        assert_eq!(
            (
                timing.started_at_ms,
                timing.completed_at_ms,
                timing.duration_ms
            ),
            (Some(1000), Some(3000), Some(2000))
        );
        assert_eq!(
            detail.session.meta.turn_timing.as_ref().unwrap().turn_id,
            "turn2"
        );
    }
}

#[cfg(test)]
mod cache_cohort_tests {
    use super::*;

    fn usage(id: &str, input: i64, read: i64, unknown: &[&str], timestamp: i64) -> UsageRecord {
        UsageRecord {
            tool: "codex".into(),
            id: id.into(),
            session_id: "session".into(),
            model: Some("gpt-6.1-sol".into()),
            input_tokens: input,
            context_tokens: Some(input),
            cache_read_tokens: read,
            output_tokens: 10,
            timestamp_ms: timestamp,
            unknown_fields: unknown.iter().map(|s| (*s).into()).collect(),
            ..Default::default()
        }
    }
    fn save(conn: &mut Connection, usage: &UsageRecord) {
        let tx = conn.transaction().unwrap();
        save_usage_with_catalog(
            &tx,
            usage,
            i64::MAX,
            0,
            &crate::model_catalog::CatalogSnapshot::default(),
        )
        .unwrap();
        tx.commit().unwrap();
    }
    fn projected(conn: &Connection, period: &MonitorPeriod) -> Totals {
        let mut totals = Totals::default();
        super::super::analysis::each_usage(conn, None, None, period, |row| {
            merge_totals(&mut totals, &row.totals)
        })
        .unwrap();
        finish_totals(&mut totals);
        totals
    }
    fn assert_cohort(totals: &Totals, input: i64, read: i64, count: i64) {
        assert_eq!(
            (
                totals.known_cache_input_tokens,
                totals.known_cache_read_tokens,
                totals.cache_known_requests
            ),
            (input, read, count)
        );
        assert_eq!(totals.known_cache_hit_ratio, cache_ratio(input, read));
    }
    #[test]
    fn mixed_records_keep_a_matched_cache_cohort_in_sessions_and_filtered_analysis() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        for usage in [
            usage("a", 100, 80, &[], 1000),
            usage("b", 300, 30, &["output_tokens"], 2000),
            usage("c", 1000, 900, &["input_tokens"], 3000),
            usage("d", 2000, 1000, &["cache_read_tokens"], 4000),
        ] {
            save(&mut conn, &usage);
        }
        let totals = sum_sessions(&sessions(&conn, None, 0).unwrap());
        assert_eq!(
            (totals.request_count, totals.cache_unknown_requests),
            (4, 2)
        );
        assert!(totals.cache_hit_ratio.is_none());
        assert_cohort(&totals, 400, 110, 2);
        let all = projected(&conn, &MonitorPeriod::default());
        assert!(all.cache_hit_ratio.is_none());
        assert_cohort(&all, 400, 110, 2);
        let window = projected(
            &conn,
            &MonitorPeriod {
                start_ms: Some(2000),
                end_ms: Some(4000),
                ..Default::default()
            },
        );
        assert_eq!(
            (window.request_count, window.cache_unknown_requests),
            (2, 1)
        );
        assert!(window.cache_hit_ratio.is_none());
        assert_cohort(&window, 300, 30, 1);
        let mut zero = Totals {
            cache_known_requests: 1,
            ..Default::default()
        };
        finish_totals(&mut zero);
        assert_eq!(zero.known_cache_hit_ratio, None);
    }
    #[test]
    fn enriching_and_deleting_records_do_not_drift_cache_cohort_totals() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut partial = usage("partial", 1000, 900, &["input_tokens"], 3000);
        for usage in [
            usage("a", 100, 80, &[], 1000),
            partial.clone(),
            usage("missing-read", 2000, 1000, &["cache_read_tokens"], 4000),
        ] {
            save(&mut conn, &usage);
        }
        partial.unknown_fields.clear();
        save(&mut conn, &partial);
        save(&mut conn, &partial);
        let totals = sum_sessions(&sessions(&conn, None, 0).unwrap());
        assert!(totals.cache_hit_ratio.is_none());
        assert_cohort(&totals, 1100, 980, 2);
        let tx = conn.transaction().unwrap();
        delete_request(&tx, "codex", "partial").unwrap();
        delete_request(&tx, "codex", "partial").unwrap();
        tx.commit().unwrap();
        let totals = sum_sessions(&sessions(&conn, None, 0).unwrap());
        assert!(totals.cache_hit_ratio.is_none());
        assert_cohort(&totals, 100, 80, 1);
        let tx = conn.transaction().unwrap();
        delete_request(&tx, "codex", "missing-read").unwrap();
        tx.commit().unwrap();
        let totals = sum_sessions(&sessions(&conn, None, 0).unwrap());
        assert_eq!(totals.cache_hit_ratio, Some(0.8));
        assert_cohort(&totals, 100, 80, 1);
        assert_cohort(&projected(&conn, &MonitorPeriod::default()), 100, 80, 1);
        let persisted: String = conn
            .query_row("SELECT totals FROM monitor_sessions", [], |r| r.get(0))
            .unwrap();
        assert_cohort(&serde_json::from_str(&persisted).unwrap(), 100, 80, 1);
    }
    #[test]
    fn legacy_supplement_is_atomic_idempotent_and_preserves_old_fields_and_quotes() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut priced = usage("a", 100, 80, &[], 1000);
        priced.mode = Some("standard".into());
        priced.mode_basis = "response_reported".into();
        for usage in [
            priced,
            usage("b", 300, 30, &[], 2000),
            usage("c", 1000, 900, &["input_tokens"], 3000),
        ] {
            save(&mut conn, &usage);
        }
        conn.execute_batch("DELETE FROM monitor_state WHERE key='cache_cohort_totals_v1';
            UPDATE monitor_sessions SET totals=json_remove(json_set(totals,'$.legacyExtra',json('{\"keep\":true}')),
              '$.knownCacheInputTokens','$.knownCacheReadTokens','$.knownCacheHitRatio','$.cacheKnownRequests');
            INSERT INTO monitor_files VALUES('fixture','codex',42,'unchanged','{}');
            CREATE TRIGGER block_supplement BEFORE UPDATE ON monitor_sessions BEGIN SELECT RAISE(ABORT,'fixture-blocked'); END;").unwrap();
        let read_totals = |conn: &Connection| -> serde_json::Value {
            let json: String = conn
                .query_row("SELECT totals FROM monitor_sessions", [], |r| r.get(0))
                .unwrap();
            serde_json::from_str(&json).unwrap()
        };
        let old = read_totals(&conn);
        let quotes: Vec<String> = conn
            .prepare("SELECT cost FROM monitor_requests ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(initialize(&conn).is_err());
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM monitor_state WHERE key='cache_cohort_totals_v1'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(read_totals(&conn), old);
        conn.execute_batch("DROP TRIGGER block_supplement").unwrap();
        initialize(&conn).unwrap();
        let mut next = read_totals(&conn);
        assert_cohort(&serde_json::from_value(next.clone()).unwrap(), 400, 110, 2);
        for key in [
            "knownCacheInputTokens",
            "knownCacheReadTokens",
            "knownCacheHitRatio",
            "cacheKnownRequests",
        ] {
            next.as_object_mut().unwrap().remove(key);
        }
        assert_eq!(next, old);
        let saved: Vec<String> = conn
            .prepare("SELECT cost FROM monitor_requests ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(saved, quotes);
        assert_eq!(
            conn.query_row("SELECT offset FROM monitor_files", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            42
        );
        conn.execute_batch("CREATE TRIGGER block_supplement BEFORE UPDATE ON monitor_sessions BEGIN SELECT RAISE(ABORT,'must-not-rescan'); END;").unwrap();
        initialize(&conn).unwrap();
        assert_eq!(read_totals(&conn)["cacheKnownRequests"], 2);
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    use crate::model_catalog::CatalogSnapshot;

    fn catalog(revision: &str, include_pending: bool) -> CatalogSnapshot {
        let mut models = serde_json::json!({"priced":{"cost":{"input":1,"output":2,"cache_read":0},"experimental":{"modes":{"fast":{"cost":{"input":2,"output":4,"cache_read":0}}}}}});
        if include_pending {
            models["priced"]["cost"]["input"] = serde_json::json!(99);
            models["pending"] = serde_json::json!({"cost":{"input":3,"output":5,"cache_read":0}});
        }
        CatalogSnapshot::parse(
            &serde_json::json!({"vendor":{"models":models}}).to_string(),
            revision.into(),
            1000,
        )
        .unwrap()
    }
    fn usage(id: &str, model: &str, mode: Option<&str>) -> UsageRecord {
        UsageRecord {
            tool: "claude".into(),
            id: id.into(),
            session_id: "session".into(),
            timestamp_ms: 1000,
            model: Some(model.into()),
            provider: Some("vendor".into()),
            provider_basis: "response_reported".into(),
            mode: mode.map(str::to_owned),
            mode_basis: "response_reported".into(),
            input_tokens: 1000,
            context_tokens: Some(1000),
            output_tokens: 100,
            ..Default::default()
        }
    }
    #[test]
    fn catalog_backfill_only_fills_unquoted_and_preserves_saved_amounts_and_scenarios() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let old = catalog("old", false);
        let new = catalog("new", true);
        let tx = conn.transaction().unwrap();
        for usage in [
            usage("saved", "priced", Some("standard")),
            usage("scenarios", "priced", None),
            usage("missing", "pending", Some("standard")),
        ] {
            save_usage_with_catalog(&tx, &usage, 0, 0, &old).unwrap();
        }
        tx.commit().unwrap();
        let before = previous(&conn, "claude", "saved").unwrap().unwrap().1;
        let before_scenarios = previous(&conn, "claude", "scenarios").unwrap().unwrap().1;
        assert!(before.usd.is_some());
        assert_eq!(before_scenarios.scenarios.len(), 2);
        backfill_unquoted_with_catalog(&mut conn, &new).unwrap();
        let after = previous(&conn, "claude", "saved").unwrap().unwrap().1;
        let after_scenarios = previous(&conn, "claude", "scenarios").unwrap().unwrap().1;
        assert_eq!(
            serde_json::to_string(&before).unwrap(),
            serde_json::to_string(&after).unwrap()
        );
        assert_eq!(
            serde_json::to_string(&before_scenarios).unwrap(),
            serde_json::to_string(&after_scenarios).unwrap()
        );
        assert_eq!(
            previous(&conn, "claude", "missing").unwrap().unwrap().1.usd,
            Some(0.0035)
        );
        let marker: String = conn
            .query_row(
                "SELECT data FROM monitor_state WHERE key='pricing_version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(marker, pricing::revision(&new));
    }
    #[test]
    fn time_band_scenarios_never_merge_just_because_the_mode_matches() {
        let mut totals = Vec::new();
        add_scenario(
            &mut totals,
            "standard",
            "USD",
            Some("standard:off_peak"),
            1.,
            1,
        );
        add_scenario(&mut totals, "standard", "USD", Some("standard:peak"), 2., 1);
        add_scenario(
            &mut totals,
            "standard",
            "USD",
            Some("standard:off_peak"),
            3.,
            1,
        );
        assert_eq!(totals.len(), 2);
        assert_eq!(totals[0].amount, 4.);
        assert_eq!(totals[1].amount, 2.);
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let usage = usage("time-band", "priced", None);
        let cost = serde_json::json!({"usd":null,"cny":null,"scenarios":[
            {"mode":"standard","scenarioKey":"standard:off_peak","amount":1,"evidence":{"currency":"USD"}},
            {"mode":"standard","scenarioKey":"standard:peak","amount":2,"evidence":{"currency":"USD"}}
        ]});
        conn.execute("INSERT INTO monitor_requests(tool,id,session_key,timestamp_ms,usage,cost) VALUES('claude','time-band','claude:session',1000,?1,?2)",params![serde_json::to_string(&usage).unwrap(),cost.to_string()]).unwrap();
        let mut projected = Totals::default();
        super::super::analysis::each_usage(&conn, None, None, &MonitorPeriod::default(), |row| {
            merge_totals(&mut projected, &row.totals)
        })
        .unwrap();
        assert_eq!(projected.scenarios.len(), 2);
        assert_eq!(
            projected.scenarios[0].scenario_key.as_deref(),
            Some("standard:off_peak")
        );
        assert_eq!(
            projected.scenarios[1].scenario_key.as_deref(),
            Some("standard:peak")
        );
    }
}

#[cfg(test)]
mod price_summary_tests {
    use super::*;
    #[test]
    fn automatic_modes_select_once_by_evidence_and_keep_unknown_reference_separate() {
        let prices = [
            ("standard", "USD", 1.),
            ("fast", "USD", 2.),
            ("ultrafast", "USD", 6.),
        ];
        let choose = |actual, requested| {
            automatic_price_summary(
                actual,
                requested,
                None,
                None,
                None,
                None,
                prices.into_iter(),
            )
        };
        let response = automatic_price_summary(
            Some("standard"),
            Some("priority"),
            Some(99.),
            None,
            Some("fast"),
            None,
            prices.into_iter(),
        );
        assert_eq!(response.by_currency["USD"].response_subtotal, 1.);
        assert_eq!(response.by_mode.len(), 1);
        assert_eq!(response.by_mode["standard"].response_requests, 1);
        let mut combined = AutomaticPriceSummary::default();
        for requested in ["default", "priority", "ultrafast"] {
            merge_automatic_price_summary(&mut combined, &choose(None, Some(requested)), 1);
        }
        assert_eq!(combined.by_currency["USD"].requested_subtotal, 9.);
        for (mode, amount) in [("standard", 1.), ("fast", 2.), ("ultrafast", 6.)] {
            assert_eq!(combined.by_mode[mode].covered_requests, 1);
            assert_eq!(combined.by_mode[mode].by_currency["USD"].amount, amount);
        }
        let unknown = choose(None, Some("auto"));
        assert_eq!(unknown.by_mode["unknown"].unknown_requests, 1);
        assert_eq!(unknown.by_mode["unknown"].covered_requests, 0);
        assert_eq!(unknown.by_currency["USD"].unknown_reference_subtotal, 1.);
        assert_eq!(unknown.by_currency["USD"].requested_requests, 0);
        let missing_mode_tariff = choose(None, Some("flex"));
        assert_eq!(missing_mode_tariff.by_mode["flex"].requested_requests, 1);
        assert!(missing_mode_tariff.by_currency.is_empty());
        for alternatives in [
            vec![("fast", "USD", 2.), ("fast", "USD", 4.)],
            vec![("fast", "USD", 2.), ("fast", "CNY", 2.)],
        ] {
            let ambiguous = automatic_price_summary(
                None,
                Some("fast"),
                None,
                None,
                None,
                None,
                alternatives.into_iter(),
            );
            assert_eq!(ambiguous.by_mode["fast"].covered_requests, 0);
            assert!(ambiguous.by_currency.is_empty());
        }
        let zero = automatic_price_summary(
            Some("default"),
            Some("fast"),
            None,
            Some(0.),
            Some("standard"),
            None,
            std::iter::empty(),
        );
        assert_eq!(zero.by_currency["CNY"].response_requests, 1);
        assert_eq!(zero.by_mode["standard"].by_currency["CNY"].amount, 0.);
        assert!(!zero.by_currency.contains_key("USD"));
        let flat = automatic_price_summary(
            None,
            Some("fast"),
            Some(0.),
            None,
            Some("standard"),
            Some("same_amount_for_all_published_tariffs"),
            std::iter::empty(),
        );
        assert_eq!(flat.by_currency["USD"].requested_requests, 1);
        merge_automatic_price_summary(&mut combined, &choose(None, Some("priority")), -1);
        assert!(!combined.by_mode.contains_key("fast"));
        assert_eq!(combined.by_currency["USD"].requested_subtotal, 7.);
    }
    #[test]
    fn automatic_mode_update_and_deletion_preserve_saved_tariffs() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut usage = UsageRecord {
            id: "mode".into(),
            tool: "codex".into(),
            session_id: "s".into(),
            model: Some("gpt-6.1-sol".into()),
            requested_mode: Some("standard".into()),
            timestamp_ms: 1000,
            input_tokens: 1000,
            output_tokens: 100,
            context_tokens: Some(1000),
            ..Default::default()
        };
        let save = |conn: &mut Connection, usage: &UsageRecord| {
            let tx = conn.transaction().unwrap();
            save_usage_with_catalog(
                &tx,
                usage,
                i64::MAX,
                2000,
                &crate::model_catalog::CatalogSnapshot::default(),
            )
            .unwrap();
            tx.commit().unwrap();
        };
        save(&mut conn, &usage);
        let original: String = conn
            .query_row("SELECT cost FROM monitor_requests", [], |row| row.get(0))
            .unwrap();
        usage.requested_mode = Some("priority".into());
        save(&mut conn, &usage);
        save(&mut conn, &usage);
        let totals = sum_sessions(&sessions(&conn, None, 2000).unwrap());
        assert_eq!(
            totals.automatic_price_summary.by_mode["fast"].requested_requests,
            1
        );
        assert_eq!(
            totals.automatic_price_summary.by_mode["fast"].covered_requests,
            1
        );
        assert!(!totals
            .automatic_price_summary
            .by_mode
            .contains_key("standard"));
        assert_eq!(
            conn.query_row("SELECT cost FROM monitor_requests", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            original
        );
        usage.unknown_fields.push("requested_mode_ambiguous".into());
        save(&mut conn, &usage);
        let totals = sum_sessions(&sessions(&conn, None, 2000).unwrap());
        assert_eq!(
            totals.automatic_price_summary.by_mode["unknown"].unknown_requests,
            1
        );
        assert_eq!(
            totals.automatic_price_summary.by_currency["USD"].requested_requests,
            0
        );
        let tx = conn.transaction().unwrap();
        delete_request(&tx, "codex", "mode").unwrap();
        tx.commit().unwrap();
        let totals = sum_sessions(&sessions(&conn, None, 2000).unwrap());
        assert!(totals.automatic_price_summary.by_mode.is_empty());
        assert!(totals.automatic_price_summary.by_currency.is_empty());
    }
    #[test]
    fn saved_single_quotes_win_and_standard_alternatives_are_not_summed() {
        let standard = price_summary(
            None,
            None,
            [("standard", "USD", 5.), ("fast", "USD", 10.)].into_iter(),
        );
        assert_eq!(
            (
                standard.covered_requests,
                standard.by_currency["USD"].standard_subtotal
            ),
            (1, 5.)
        );
        let fast = price_summary(Some(20.), None, [("standard", "USD", 10.)].into_iter());
        assert_eq!(
            (
                fast.by_currency["USD"].confirmed_subtotal,
                fast.by_currency["USD"].standard_requests
            ),
            (20., 0)
        );
        assert_eq!(
            price_summary(
                None,
                None,
                [("standard", "USD", 7.), ("standard", "USD", 14.)].into_iter()
            )
            .covered_requests,
            0
        );
        assert_eq!(
            price_summary(
                None,
                None,
                [("standard", "USD", 7.), ("standard", "CNY", 7.)].into_iter()
            )
            .covered_requests,
            0
        );
        let same = price_summary(
            None,
            None,
            [("standard", "USD", 0.), ("standard", "USD", 0.)].into_iter(),
        );
        assert_eq!(
            (
                same.covered_requests,
                same.by_currency["USD"].standard_requests,
                same.by_currency["USD"].standard_subtotal
            ),
            (1, 1, 0.)
        );
        let zero = price_summary(None, Some(0.), std::iter::empty());
        assert!(!zero.by_currency.contains_key("USD"));
        assert_eq!(zero.by_currency["CNY"].confirmed_requests, 1);
        assert_eq!(
            price_summary(None, None, std::iter::empty()).covered_requests,
            0
        );
        let mut combined = PriceSummary::default();
        merge_price_summary(&mut combined, &fast, 1);
        merge_price_summary(&mut combined, &standard, 1);
        merge_price_summary(&mut combined, &zero, 1);
        assert_eq!(combined.covered_requests, 3);
        assert_eq!(
            combined.by_currency["USD"].confirmed_subtotal
                + combined.by_currency["USD"].standard_subtotal,
            25.
        );
        merge_price_summary(&mut combined, &standard, -1);
        assert_eq!(combined.by_currency["USD"].standard_requests, 0);
        assert_eq!(combined.covered_requests, 2);
    }
    #[test]
    fn legacy_summary_is_replayed_once_without_touching_any_saved_fact_or_quote() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let original = serde_json::json!({"inputTokens":5000,"outputTokens":500,"totalTokens":5500,"requestCount":5,"pricedCostUsd":20,"pricedCostCny":0,"unpricedRequests":3,"scenarioRequests":2,"extension":{"keep":true},"priceSummary":{"coveredRequests":3,"byCurrency":{"USD":{"confirmedSubtotal":20,"confirmedRequests":1,"standardSubtotal":5,"standardRequests":1},"CNY":{"confirmedSubtotal":0,"confirmedRequests":1,"standardSubtotal":0,"standardRequests":0}}}});
        conn.execute(
            "INSERT INTO monitor_sessions VALUES('codex:s','codex','{}',?1,5)",
            [original.to_string()],
        )
        .unwrap();
        let scenario = |amount| serde_json::json!({"mode":"standard","amount":amount,"evidence":{"currency":"USD"}});
        let costs = [
            serde_json::json!({"usd":20,"evidence":{"mode":"standard"}}),
            serde_json::json!({"scenarios":[scenario(5),{"mode":"fast","amount":10,"evidence":{"currency":"USD"}}]}),
            serde_json::json!({"scenarios":[scenario(7),scenario(14)]}),
            serde_json::json!({"cny":0,"evidence":{"mode":"standard"}}),
            serde_json::json!({}),
        ];
        for (index, cost) in costs.iter().enumerate() {
            let usage = UsageRecord {
                id: index.to_string(),
                tool: "codex".into(),
                session_id: "s".into(),
                timestamp_ms: index as i64 + 1,
                input_tokens: 1000,
                output_tokens: 100,
                mode: matches!(index, 0 | 3).then(|| "standard".into()),
                mode_basis: "response_reported".into(),
                requested_mode: (index < 3)
                    .then(|| if index == 2 { "standard" } else { "fast" }.into()),
                ..Default::default()
            };
            conn.execute(
                "INSERT INTO monitor_requests VALUES('codex',?1,'codex:s',?2,?3,?4)",
                params![
                    usage.id,
                    usage.timestamp_ms,
                    serde_json::to_string(&usage).unwrap(),
                    cost.to_string()
                ],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO monitor_files VALUES('fixture','codex',42,'unchanged','{}')",
            [],
        )
        .unwrap();
        let original_usage: Vec<String> = conn
            .prepare("SELECT usage FROM monitor_requests ORDER BY timestamp_ms")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        conn.execute(
            "DELETE FROM monitor_state WHERE key='completeness_totals_v4'",
            [],
        )
        .unwrap();
        initialize(&conn).unwrap();
        let json: String = conn
            .query_row("SELECT totals FROM monitor_sessions", [], |row| row.get(0))
            .unwrap();
        let mut next: serde_json::Value = serde_json::from_str(&json).unwrap();
        let saved: PriceSummary = serde_json::from_value(next["priceSummary"].clone()).unwrap();
        let automatic: AutomaticPriceSummary = serde_json::from_value(
            next.as_object_mut()
                .unwrap()
                .remove("automaticPriceSummary")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(next, original);
        assert_eq!(saved.covered_requests, 3);
        assert_eq!(automatic.by_mode["standard"].response_requests, 2);
        assert_eq!(automatic.by_mode["standard"].requested_requests, 1);
        assert_eq!(automatic.by_mode["standard"].covered_requests, 2);
        assert_eq!(automatic.by_mode["fast"].covered_requests, 1);
        assert_eq!(automatic.by_mode["unknown"].unknown_requests, 1);
        assert_eq!(automatic.by_currency["USD"].response_subtotal, 20.);
        assert_eq!(automatic.by_currency["USD"].requested_subtotal, 10.);
        assert_eq!(automatic.by_currency["CNY"].response_requests, 1);
        assert_eq!(
            saved.by_currency["USD"].confirmed_subtotal
                + saved.by_currency["USD"].standard_subtotal,
            25.
        );
        let mut projected = Totals::default();
        super::super::analysis::each_usage(&conn, None, None, &MonitorPeriod::default(), |row| {
            merge_totals(&mut projected, &row.totals)
        })
        .unwrap();
        assert_eq!(
            serde_json::to_value(&projected.price_summary).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&projected.automatic_price_summary).unwrap(),
            serde_json::to_value(&automatic).unwrap()
        );
        let quotes: Vec<String> = conn
            .prepare("SELECT cost FROM monitor_requests ORDER BY timestamp_ms")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            quotes,
            costs
                .iter()
                .map(serde_json::Value::to_string)
                .collect::<Vec<_>>()
        );
        let retained_usage: Vec<String> = conn
            .prepare("SELECT usage FROM monitor_requests ORDER BY timestamp_ms")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(retained_usage, original_usage);
        assert_eq!(
            conn.query_row(
                "SELECT offset,signature FROM monitor_files WHERE path='fixture'",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            )
            .unwrap(),
            (42, "unchanged".into())
        );
        conn.execute_batch("CREATE TRIGGER no_replay BEFORE UPDATE ON monitor_sessions BEGIN SELECT RAISE(ABORT,'unexpected replay'); END;").unwrap();
        initialize(&conn).unwrap();
    }
}

#[cfg(test)]
mod pricing_reason_tests {
    use super::*;

    #[test]
    fn pricing_reason_drilldown_is_exact_scoped_and_paginated_without_shrinking_totals() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        for (id, session, stamp, model, reason) in [
            ("before", "one", 999, "gpt-6.1-sol", "missing_price"),
            ("a1", "one", 1000, "gpt-6.1-sol", "missing_price; detail"),
            ("a2", "one", 1200, "gpt-6.1-sol", "missing_price"),
            (
                "same-prefix",
                "one",
                1300,
                "gpt-6.1-sol",
                "missing_price_extra",
            ),
            (
                "resolved-fast",
                "one",
                1400,
                "gpt-6.1-sol",
                "actual_mode_unknown; requested_mode_only",
            ),
            ("other-model", "one", 1500, "gpt-6-luna", "missing_price"),
            (
                "second-session",
                "two",
                1600,
                "gpt-6.1-sol",
                "missing_price",
            ),
            (
                "second-prefix",
                "two",
                1700,
                "gpt-6.1-sol",
                "missing_price_extra",
            ),
            ("quoted-zero", "three", 1800, "gpt-6.1-sol", "missing_price"),
            ("at-end", "one", 2000, "gpt-6.1-sol", "missing_price"),
        ] {
            let mut usage = UsageRecord {
                id: id.into(),
                tool: "codex".into(),
                session_id: session.into(),
                turn_id: "turn".into(),
                timestamp_ms: stamp,
                model: Some(model.into()),
                input_tokens: 1000,
                output_tokens: 100,
                context_tokens: Some(1000),
                ..Default::default()
            };
            let mut cost = CostEstimate {
                reason: Some(reason.into()),
                ..Default::default()
            };
            if id == "resolved-fast" {
                usage.runtime_mode = Some(RuntimeModeEvidence {
                    mode: Some("fast".into()),
                    conflicted: false,
                    observed_at_ms: 500,
                    source: "codex_turn_feedback_tag".into(),
                });
                cost = pricing::estimate_with_catalog(
                    &usage,
                    &crate::model_catalog::CatalogSnapshot::default(),
                );
                cost.reason = Some(reason.into());
            } else if id == "quoted-zero" {
                cost.usd = Some(0.);
            }
            let tx = conn.transaction().unwrap();
            save_session(
                &tx,
                &SessionMeta {
                    tool: "codex".into(),
                    id: session.into(),
                    updated_at_ms: stamp,
                    ..Default::default()
                },
            )
            .unwrap();
            tx.execute(
                "INSERT INTO monitor_requests VALUES('codex',?1,?2,?3,?4,?5)",
                params![
                    id,
                    session_key("codex", session),
                    stamp,
                    serde_json::to_string(&usage).unwrap(),
                    serde_json::to_string(&cost).unwrap()
                ],
            )
            .unwrap();
            adjust(&tx, &usage, &cost, 1).unwrap();
            tx.commit().unwrap();
        }
        let period = MonitorPeriod {
            start_ms: Some(1000),
            end_ms: Some(2000),
            model: Some("gpt-6.1-sol".into()),
            ..Default::default()
        };
        let full = super::super::analysis::read(
            &conn,
            Some("codex"),
            &period,
            "",
            None,
            false,
            0,
            100,
            3000,
        )
        .unwrap();
        assert_eq!((full.totals.request_count, full.session_count), (7, 3));
        let filtered = MonitorPeriod {
            pricing_reason: Some("missing_price".into()),
            ..period.clone()
        };
        let first = super::super::analysis::read(
            &conn,
            Some("codex"),
            &filtered,
            "",
            None,
            false,
            0,
            1,
            3000,
        )
        .unwrap();
        let next = super::super::analysis::read(
            &conn,
            Some("codex"),
            &filtered,
            "",
            None,
            false,
            1,
            1,
            3000,
        )
        .unwrap();
        assert_eq!(
            (
                first.session_count,
                first.sessions[0].meta.id.as_str(),
                next.sessions[0].meta.id.as_str()
            ),
            (2, "two", "one")
        );
        assert_eq!(
            serde_json::to_value(&first.totals).unwrap(),
            serde_json::to_value(&full.totals).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&first.timeline).unwrap(),
            serde_json::to_value(&full.timeline).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&first.by_model).unwrap(),
            serde_json::to_value(&full.by_model).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&first.tool_overview).unwrap(),
            serde_json::to_value(&full.tool_overview).unwrap()
        );
        let page = session_detail(&conn, "codex:one", 0, 1, 3000, false, &filtered).unwrap();
        let next_page = session_detail(&conn, "codex:one", 1, 1, 3000, false, &filtered).unwrap();
        assert_eq!(
            (
                page.request_count,
                page.requests[0].usage.id.as_str(),
                next_page.requests[0].usage.id.as_str()
            ),
            (2, "a2", "a1")
        );
        assert_eq!(page.filtered_totals.request_count, 4);
        assert_eq!(page.turns[0].totals.request_count, 4);
        let resolved = MonitorPeriod {
            pricing_reason: Some("actual_mode_unknown".into()),
            ..period.clone()
        };
        let scenario = session_detail(&conn, "codex:one", 0, 100, 3000, false, &resolved).unwrap();
        assert_eq!(
            (
                scenario.request_count,
                scenario.requests[0].usage.id.as_str()
            ),
            (1, "resolved-fast")
        );
        assert_eq!(
            scenario.requests[0].cost.reason.as_deref(),
            Some("actual_mode_unknown; requested_mode_only")
        );
        assert_eq!(
            scenario.filtered_totals.automatic_price_summary.by_mode["fast"].covered_requests,
            1
        );
        assert!(!scenario.requests[0].cost.scenarios.is_empty());
        assert_eq!(
            session_detail(&conn, "codex:one", 0, 100, 3000, true, &resolved)
                .unwrap()
                .request_count,
            0
        );
        let near = MonitorPeriod {
            pricing_reason: Some("missing_price_extra".into()),
            ..period.clone()
        };
        let near = session_detail(&conn, "codex:one", 0, 100, 3000, false, &near).unwrap();
        assert_eq!(
            (near.request_count, near.requests[0].usage.id.as_str()),
            (1, "same-prefix")
        );
        let cleared = session_detail(&conn, "codex:one", 0, 100, 3000, false, &period).unwrap();
        assert_eq!((cleared.request_count, cleared.requests.len()), (4, 4));
    }
}

#[cfg(test)]
mod runtime_mode_tests {
    use super::*;
    fn usage(id: &str) -> UsageRecord {
        UsageRecord {
            id: id.into(),
            tool: "codex".into(),
            session_id: "thread".into(),
            turn_id: "turn".into(),
            timestamp_ms: 30_000,
            model: Some("gpt-6.1-sol".into()),
            input_tokens: 28_627,
            output_tokens: 1523,
            context_tokens: Some(28_627),
            ..Default::default()
        }
    }
    fn save(conn: &mut Connection, usage: &UsageRecord) {
        let tx = conn.transaction().unwrap();
        save_usage_with_catalog(
            &tx,
            usage,
            i64::MAX,
            40_000,
            &crate::model_catalog::CatalogSnapshot::default(),
        )
        .unwrap();
        tx.commit().unwrap();
    }
    fn observation(mode: &str, row: i64) -> RuntimeModeObservation {
        RuntimeModeObservation {
            session_key: "codex:thread".into(),
            turn_id: "turn".into(),
            mode: mode.into(),
            observed_at_ms: 20_000,
            source_row_id: row,
        }
    }
    fn cursor(id: i64) -> RuntimeModeCursor {
        if id == 0 {
            RuntimeModeCursor::default()
        } else {
            RuntimeModeCursor {
                id,
                ts: Some(id * 10),
                ts_nanos: Some(id),
            }
        }
    }
    fn stored(conn: &Connection, id: &str) -> (serde_json::Value, String) {
        conn.query_row(
            "SELECT usage,cost FROM monitor_requests WHERE id=?1",
            [id],
            |row| {
                Ok((
                    serde_json::from_str(&row.get::<_, String>(0)?).unwrap(),
                    row.get(1)?,
                ))
            },
        )
        .unwrap()
    }
    #[test]
    fn runtime_mode_late_enrichment_preserves_tariffs_tokens_cursor_and_restart() {
        let path = std::env::temp_dir().join(format!(
            "2api-runtime-mode-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let source = "missing-source-logs.sqlite";
        let record = usage("real-fast-shape");
        let original_cost;
        {
            let mut conn = Connection::open(&path).unwrap();
            initialize(&conn).unwrap();
            conn.execute(
                "INSERT INTO monitor_files VALUES('fixture','codex',42,'unchanged','{}')",
                [],
            )
            .unwrap();
            save(&mut conn, &record);
            let (mut original_usage, cost) = stored(&conn, &record.id);
            original_cost = cost;
            original_usage
                .as_object_mut()
                .unwrap()
                .remove("runtimeMode");
            let read_totals = |conn: &Connection| -> serde_json::Value {
                serde_json::from_str(
                    &conn
                        .query_row("SELECT totals FROM monitor_sessions", [], |row| {
                            row.get::<_, String>(0)
                        })
                        .unwrap(),
                )
                .unwrap()
            };
            let mut original_totals = read_totals(&conn);
            original_totals
                .as_object_mut()
                .unwrap()
                .remove("automaticPriceSummary");
            let observed = observation("priority", 12);
            apply_runtime_mode_batch(&mut conn, source, &[observed.clone()], &cursor(12)).unwrap();
            apply_runtime_mode_batch(&mut conn, source, &[observed], &cursor(12)).unwrap();
            let mut next_totals = read_totals(&conn);
            let automatic: AutomaticPriceSummary = serde_json::from_value(
                next_totals
                    .as_object_mut()
                    .unwrap()
                    .remove("automaticPriceSummary")
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(next_totals, original_totals);
            assert_eq!(automatic.by_mode["fast"].requested_requests, 1);
            assert!((automatic.by_currency["USD"].requested_subtotal - 0.144968).abs() < 1e-12);
            let (mut next_usage, cost) = stored(&conn, &record.id);
            assert_eq!(cost, original_cost);
            assert_eq!(next_usage["requestedMode"], serde_json::Value::Null);
            assert_eq!(next_usage["runtimeMode"]["mode"], "fast");
            assert_eq!(
                next_usage["runtimeMode"]["source"],
                "codex_turn_feedback_tag"
            );
            next_usage.as_object_mut().unwrap().remove("runtimeMode");
            assert_eq!(next_usage, original_usage);
            let mut projected = Totals::default();
            super::super::analysis::each_usage(
                &conn,
                None,
                None,
                &MonitorPeriod::default(),
                |row| merge_totals(&mut projected, &row.totals),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(&projected.automatic_price_summary).unwrap(),
                serde_json::to_value(&automatic).unwrap()
            );
            let mut sessions = sessions(&conn, None, 40_000).unwrap();
            enrich_session_outputs(&conn, &mut [&mut sessions]).unwrap();
            assert_eq!(
                sessions[0]
                    .recent_request
                    .as_ref()
                    .unwrap()
                    .runtime_mode
                    .as_ref()
                    .unwrap()
                    .mode
                    .as_deref(),
                Some("fast")
            );
            assert_eq!(runtime_mode_cursor(&conn, source).unwrap(), cursor(12));
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM monitor_turn_mode_evidence",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
                1
            );
        }
        {
            let mut conn = Connection::open(&path).unwrap();
            initialize(&conn).unwrap();
            // Source deletion/reset only changes its cursor; persisted exact-turn evidence survives.
            apply_runtime_mode_batch(&mut conn, source, &[], &cursor(0)).unwrap();
            save(&mut conn, &record);
            let totals = sum_sessions(&sessions(&conn, None, 40_000).unwrap());
            assert_eq!(totals.request_count, 1);
            assert_eq!(
                totals.automatic_price_summary.by_mode["fast"].covered_requests,
                1
            );
            assert_eq!(stored(&conn, &record.id).1, original_cost);
            assert_eq!(runtime_mode_cursor(&conn, source).unwrap(), cursor(0));
            assert_eq!(
                conn.query_row("SELECT offset,signature FROM monitor_files", [], |row| Ok(
                    (row.get::<_, i64>(0)?, row.get::<_, String>(1)?)
                ))
                .unwrap(),
                (42, "unchanged".into())
            );
        }
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn runtime_mode_conflicts_time_and_exact_turn_never_override_response_evidence() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let mut automatic = observation("unknown", 2);
        automatic.turn_id = "auto".into();
        apply_runtime_mode_batch(
            &mut conn,
            "source",
            &[observation("fast", 1), automatic.clone()],
            &cursor(2),
        )
        .unwrap();
        automatic.mode = "auto".into();
        apply_runtime_mode_batch(&mut conn, "source", &[automatic], &cursor(2)).unwrap();
        let mut selected = usage("selected");
        selected.requested_mode = Some("default".into());
        let mut before = usage("before");
        before.timestamp_ms = 19_000;
        let mut started = usage("started");
        started.request_timing = Some(RequestTiming {
            started_at_ms: Some(15_000),
            ..Default::default()
        });
        let mut response = usage("response");
        response.mode = Some("standard".into());
        response.mode_basis = "response_reported".into();
        response.requested_mode = Some("priority".into());
        response
            .unknown_fields
            .push("requested_mode_ambiguous".into());
        let mut other = usage("other-turn");
        other.turn_id = "other".into();
        let mut auto = usage("auto");
        auto.turn_id = "auto".into();
        auto.requested_mode = Some("default".into());
        for record in [&selected, &before, &started, &response, &other, &auto] {
            save(&mut conn, record);
        }
        assert_eq!(stored(&conn, "auto").0["requestedMode"], "default");
        assert_eq!(stored(&conn, "auto").0["runtimeMode"]["conflicted"], false);
        assert!(stored(&conn, "auto").0["runtimeMode"]["mode"].is_null());
        assert_eq!(stored(&conn, "selected").0["requestedMode"], "default");
        assert_eq!(stored(&conn, "selected").0["runtimeMode"]["mode"], "fast");
        for id in ["before", "started", "other-turn"] {
            assert!(stored(&conn, id).0["runtimeMode"].is_null());
        }
        let totals = sum_sessions(&sessions(&conn, None, 40_000).unwrap());
        assert_eq!(
            totals.automatic_price_summary.by_mode["standard"].response_requests,
            1
        );
        assert_eq!(
            totals.automatic_price_summary.by_mode["fast"].requested_requests,
            1
        );
        selected
            .unknown_fields
            .push("requested_mode_ambiguous".into());
        save(&mut conn, &selected);
        assert_eq!(stored(&conn, "selected").0["runtimeMode"]["mode"], "fast");
        assert!(!sum_sessions(&sessions(&conn, None, 40_000).unwrap())
            .automatic_price_summary
            .by_mode
            .contains_key("fast"));
        selected.unknown_fields.clear();
        save(&mut conn, &selected);
        selected.request_timing = Some(RequestTiming {
            started_at_ms: Some(15_000),
            ..Default::default()
        });
        save(&mut conn, &selected);
        assert!(stored(&conn, "selected").0["runtimeMode"].is_null());
        let (mut prior_usage, prior_cost) = stored(&conn, "selected");
        prior_usage.as_object_mut().unwrap().remove("runtimeMode");
        apply_runtime_mode_batch(
            &mut conn,
            "source",
            &[observation("unknown", 3)],
            &cursor(3),
        )
        .unwrap();
        // A reused source row id cannot resolve a conflicting exact turn by last-write-wins.
        apply_runtime_mode_batch(&mut conn, "source", &[observation("fast", 1)], &cursor(1))
            .unwrap();
        let totals = sum_sessions(&sessions(&conn, None, 40_000).unwrap());
        assert_eq!(
            totals.automatic_price_summary.by_mode["standard"].response_requests,
            1
        );
        assert_eq!(
            totals.automatic_price_summary.by_mode["unknown"].unknown_requests,
            5
        );
        assert!(stored(&conn, "selected").0["runtimeMode"]["conflicted"]
            .as_bool()
            .unwrap());
        assert_eq!(stored(&conn, "selected").0["requestedMode"], "default");
        let (mut retained_usage, retained_cost) = stored(&conn, "selected");
        retained_usage
            .as_object_mut()
            .unwrap()
            .remove("runtimeMode");
        assert_eq!((retained_usage, retained_cost), (prior_usage, prior_cost));
        let mut valid = observation("fast", 3);
        valid.turn_id = "new".into();
        let mut invalid = observation("fast", 4);
        invalid.session_key = "claude:wrong".into();
        assert!(
            apply_runtime_mode_batch(&mut conn, "source", &[valid, invalid], &cursor(4)).is_err()
        );
        assert_eq!(runtime_mode_cursor(&conn, "source").unwrap(), cursor(1));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM monitor_turn_mode_evidence",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
    }
}

#[cfg(test)]
mod current_quote_filter_tests {
    use super::*;
    #[test]
    fn current_quote_filter_uses_selected_tariff_before_paging_and_keeps_whole_scope() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let catalog = crate::model_catalog::CatalogSnapshot::default();
        for (id, session, time) in [
            ("unknown", "gaps", 1000),
            ("missing-fast", "gaps", 3000),
            ("no-quotes", "gaps", 3000),
            ("zero", "gaps", 4000),
            ("response", "quoted", 4500),
            ("runtime", "quoted", 5000),
        ] {
            let mut usage = UsageRecord {
                id: id.into(),
                tool: "codex".into(),
                session_id: session.into(),
                turn_id: "turn".into(),
                timestamp_ms: time,
                model: Some("gpt-6.1-sol".into()),
                input_tokens: 1000,
                output_tokens: 100,
                context_tokens: Some(1000),
                ..Default::default()
            };
            match id {
                "response" => {
                    usage.mode = Some("priority".into());
                    usage.mode_basis = "response_reported".into();
                    usage.requested_mode = Some("standard".into());
                }
                "runtime" => {
                    usage.runtime_mode = Some(RuntimeModeEvidence {
                        mode: Some("fast".into()),
                        conflicted: false,
                        observed_at_ms: 100,
                        source: "codex_turn_feedback_tag".into(),
                    });
                }
                "missing-fast" => usage.requested_mode = Some("priority".into()),
                "zero" => {
                    usage.mode = Some("standard".into());
                    usage.mode_basis = "response_reported".into();
                    usage.input_tokens = 0;
                    usage.output_tokens = 0;
                    usage.context_tokens = Some(0);
                }
                _ => {}
            }
            let mut cost = pricing::estimate_with_catalog(&usage, &catalog);
            if id == "missing-fast" {
                cost.scenarios.retain(|quote| quote.mode == "standard");
            }
            if id == "no-quotes" {
                cost = CostEstimate {
                    reason: Some("unknown_catalog_model".into()),
                    ..Default::default()
                };
            }
            let tx = conn.transaction().unwrap();
            save_session(
                &tx,
                &SessionMeta {
                    tool: "codex".into(),
                    id: session.into(),
                    updated_at_ms: time,
                    ..Default::default()
                },
            )
            .unwrap();
            tx.execute(
                "INSERT INTO monitor_requests VALUES('codex',?1,?2,?3,?4,?5)",
                params![
                    id,
                    session_key("codex", session),
                    time,
                    serde_json::to_string(&usage).unwrap(),
                    serde_json::to_string(&cost).unwrap()
                ],
            )
            .unwrap();
            adjust(&tx, &usage, &cost, 1).unwrap();
            tx.commit().unwrap();
        }
        let period = MonitorPeriod {
            start_ms: Some(1000),
            end_ms: Some(6000),
            ..Default::default()
        };
        let first = session_detail(&conn, "codex:gaps", 0, 1, 6000, true, &period).unwrap();
        let second = session_detail(&conn, "codex:gaps", 1, 1, 6000, true, &period).unwrap();
        let third = session_detail(&conn, "codex:gaps", 2, 1, 6000, true, &period).unwrap();
        let end = session_detail(&conn, "codex:gaps", 3, 1, 6000, true, &period).unwrap();
        assert_eq!(
            (
                first.request_count,
                second.request_count,
                third.request_count,
                end.request_count
            ),
            (3, 3, 3, 3)
        );
        assert_eq!(
            (
                first.requests[0].usage.id.as_str(),
                second.requests[0].usage.id.as_str(),
                third.requests[0].usage.id.as_str()
            ),
            ("missing-fast", "no-quotes", "unknown")
        );
        assert!(end.requests.is_empty());
        assert!(!first.requests[0].cost.scenarios.is_empty());
        assert_eq!(first.filtered_totals.request_count, 4);
        assert_eq!(first.turns[0].totals.request_count, 4);
        assert_eq!(current_unpriced_requests(&first.filtered_totals), 3);
        assert_eq!(
            first.filtered_totals.unpriced_requests - first.filtered_totals.scenario_requests,
            1
        );
        let quoted = session_detail(&conn, "codex:quoted", 0, 100, 6000, true, &period).unwrap();
        assert_eq!(
            (
                quoted.request_count,
                quoted.requests.len(),
                quoted.filtered_totals.request_count
            ),
            (0, 0, 2)
        );
        assert_eq!(
            quoted.filtered_totals.automatic_price_summary.by_mode["fast"].covered_requests,
            2
        );
        let mut sessions = sessions(&conn, None, 6000).unwrap();
        filter_sessions(&mut sessions, "", None, true);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].meta.id, "gaps");
        let analysis = super::super::analysis::read(
            &conn,
            Some("codex"),
            &period,
            "",
            None,
            true,
            0,
            100,
            6000,
        )
        .unwrap();
        assert_eq!(
            (analysis.session_count, analysis.totals.request_count),
            (1, 6)
        );
        let reason = MonitorPeriod {
            pricing_reason: Some("actual_mode_unknown".into()),
            ..period
        };
        let saved_hint = super::super::analysis::read(
            &conn,
            Some("codex"),
            &reason,
            "",
            None,
            false,
            0,
            100,
            6000,
        )
        .unwrap();
        let current_gap = super::super::analysis::read(
            &conn,
            Some("codex"),
            &reason,
            "",
            None,
            true,
            0,
            100,
            6000,
        )
        .unwrap();
        assert_eq!(
            (saved_hint.session_count, current_gap.session_count),
            (2, 1)
        );
        assert_eq!(current_gap.sessions[0].meta.id, "gaps");
    }
}

#[cfg(test)]
mod descendant_detail_tests {
    use super::*;

    fn fixture() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let tx = conn.transaction().unwrap();
        for (id, parent, model) in [
            ("ancestor", None, "gpt-6-astra"),
            ("parent", Some("ancestor"), "gpt-6-astra"),
            ("child", Some("parent"), "gpt-6.1-sol"),
            ("nested", Some("child"), "gpt-6-luna"),
            ("empty", Some("nested"), "gpt-6-luna"),
            ("other", None, "gpt-6-astra"),
        ] {
            save_session(
                &tx,
                &SessionMeta {
                    tool: "codex".into(),
                    id: id.into(),
                    parent_id: parent.map(str::to_owned),
                    model: Some(model.into()),
                    status: "idle".into(),
                    updated_at_ms: 7000,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        save_session(
            &tx,
            &SessionMeta {
                tool: "claude".into(),
                id: "foreign".into(),
                parent_id: Some("parent".into()),
                ..Default::default()
            },
        )
        .unwrap();
        for (turn, end, duration) in [("parent-a", 3500, 2000), ("parent-c", 5500, 1000)] {
            save_session(
                &tx,
                &SessionMeta {
                    tool: "codex".into(),
                    id: "parent".into(),
                    updated_at_ms: end,
                    turn_timing: Some(TurnTiming {
                        turn_id: turn.into(),
                        started_at_ms: Some(end - duration),
                        completed_at_ms: Some(end),
                        duration_ms: Some(duration),
                        basis: "codex_turn_events".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let catalog = crate::model_catalog::CatalogSnapshot::default();
        for (id, session, turn, root_turn, time, output, model, unpriced) in [
            (
                "ancestor-request",
                "ancestor",
                "ancestor-turn",
                None,
                1000,
                9000,
                "gpt-6-astra",
                false,
            ),
            (
                "parent-a-request",
                "parent",
                "parent-a",
                Some("parent-a"),
                1800,
                100,
                "gpt-6-astra",
                false,
            ),
            (
                "parent-b-outside",
                "parent",
                "parent-b",
                Some("parent-b"),
                9000,
                200,
                "gpt-6-astra",
                false,
            ),
            (
                "child-a",
                "child",
                "native-child-a",
                Some("parent-a"),
                2000,
                20,
                "gpt-6.1-sol",
                false,
            ),
            (
                "nested-a",
                "nested",
                "native-nested-a",
                Some("parent-a"),
                3000,
                3,
                "gpt-6-luna",
                true,
            ),
            (
                "child-unlinked",
                "child",
                "native-unlinked",
                None,
                3500,
                7,
                "gpt-6.1-sol",
                true,
            ),
            (
                "nested-invalid",
                "nested",
                "native-invalid",
                Some("not-a-parent-turn"),
                3600,
                8,
                "gpt-6-luna",
                false,
            ),
            (
                "child-b",
                "child",
                "native-child-b",
                Some("parent-b"),
                4000,
                40,
                "gpt-6.1-sol",
                false,
            ),
            (
                "nested-c",
                "nested",
                "native-nested-c",
                Some("parent-c"),
                4500,
                4,
                "gpt-6-luna",
                false,
            ),
            (
                "future-child",
                "child",
                "native-future",
                Some("parent-a"),
                6000,
                60,
                "gpt-6.1-sol",
                false,
            ),
            (
                "other-request",
                "other",
                "other-turn",
                None,
                2500,
                8000,
                "gpt-6-astra",
                false,
            ),
        ] {
            let usage = UsageRecord {
                id: id.into(),
                tool: "codex".into(),
                session_id: session.into(),
                turn_id: turn.into(),
                root_turn_id: root_turn.map(str::to_owned),
                timestamp_ms: time,
                model: Some(model.into()),
                model_basis: "turn_context_requested".into(),
                input_tokens: 1000,
                output_tokens: output,
                context_tokens: Some(1000),
                mode: (!unpriced).then(|| "standard".into()),
                mode_basis: if unpriced {
                    "unknown"
                } else {
                    "response_reported"
                }
                .into(),
                ..Default::default()
            };
            save_usage_with_catalog(&tx, &usage, i64::MAX, 10_000, &catalog).unwrap();
        }
        tx.commit().unwrap();
        conn
    }

    fn period() -> MonitorPeriod {
        MonitorPeriod {
            start_ms: Some(1000),
            end_ms: Some(6000),
            ..Default::default()
        }
    }

    #[test]
    fn family_detail_keeps_nested_members_unique_and_native_timing_own() {
        let conn = fixture();
        let own = session_detail(&conn, "codex:parent", 0, 100, 10_000, false, &period()).unwrap();
        assert!(!own.include_descendants);
        assert_eq!(
            (
                own.request_count,
                own.filtered_totals.request_count,
                own.session.totals.request_count
            ),
            (1, 1, 2)
        );
        assert_eq!(own.members.len(), 4);
        assert_eq!(own.unlinked_child_requests, 0);
        let all = session_detail_with_descendants(
            &conn,
            "codex:parent",
            0,
            100,
            10_000,
            false,
            &period(),
            true,
        )
        .unwrap();
        assert!(all.include_descendants);
        assert_eq!(
            (
                all.request_count,
                all.filtered_totals.request_count,
                all.filtered_totals.output_tokens
            ),
            (7, 7, 182)
        );
        assert_eq!(all.unlinked_child_requests, 2);
        assert_eq!(
            all.members
                .iter()
                .map(|member| member.meta.id.as_str())
                .collect::<Vec<_>>(),
            vec!["parent", "child", "nested", "empty"]
        );
        assert!(all
            .members
            .iter()
            .all(|member| member.meta.status == "idle"));
        assert_eq!(
            all.members
                .iter()
                .map(|member| member.totals.request_count)
                .sum::<i64>(),
            9
        );
        assert_eq!(all.session.totals.request_count, 2);
        assert_eq!(
            all.turns
                .iter()
                .map(|turn| turn.id.as_str())
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["parent-a", "parent-b", "parent-c"])
        );
        assert_eq!(
            all.turns
                .iter()
                .map(|turn| turn.totals.request_count)
                .sum::<i64>(),
            5
        );
        assert!(all
            .requests
            .iter()
            .any(|request| request.usage.id == "child-unlinked"));
        assert!(all
            .requests
            .iter()
            .any(|request| request.usage.id == "nested-invalid"));
        let selected = MonitorPeriod {
            turn_id: Some("parent-a".into()),
            ..period()
        };
        let selected = session_detail_with_descendants(
            &conn,
            "codex:parent",
            0,
            100,
            10_000,
            false,
            &selected,
            true,
        )
        .unwrap();
        assert_eq!(selected.request_count, 3);
        assert_eq!(selected.filtered_totals.request_count, 7);
        assert_eq!(selected.turns.len(), 3);
        assert_eq!(selected.unlinked_child_requests, 2);
        assert_eq!(
            selected
                .requests
                .iter()
                .map(|row| (
                    row.usage.session_id.as_str(),
                    row.usage.turn_id.as_str(),
                    row.usage.model.as_deref()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("nested", "native-nested-a", Some("gpt-6-luna")),
                ("child", "native-child-a", Some("gpt-6.1-sol")),
                ("parent", "parent-a", Some("gpt-6-astra"))
            ]
        );
        let completed = selected.selected_completed_turn.unwrap();
        assert_eq!(
            (
                completed.output_tokens,
                completed.timing.duration_ms,
                completed.output_tokens_per_second
            ),
            (Some(100), Some(2000), Some(50.))
        );
        assert_eq!(
            selected
                .turns
                .iter()
                .find(|turn| turn.id == "parent-a")
                .unwrap()
                .totals
                .output_tokens,
            123
        );
        let timing_only = MonitorPeriod {
            turn_id: Some("parent-c".into()),
            ..period()
        };
        let timing_only = session_detail_with_descendants(
            &conn,
            "codex:parent",
            0,
            100,
            10_000,
            false,
            &timing_only,
            true,
        )
        .unwrap();
        assert_eq!(
            (
                timing_only.request_count,
                timing_only.requests[0].usage.turn_id.as_str()
            ),
            (1, "native-nested-c")
        );
        assert_eq!(
            timing_only.selected_completed_turn.unwrap().output_tokens,
            None
        );
        assert_eq!(
            sum_sessions(&sessions(&conn, None, 10_000).unwrap()).request_count,
            11
        );
    }

    #[test]
    fn family_detail_filters_before_paging_without_hiding_members_or_turn_index() {
        let conn = fixture();
        let page = session_detail_with_descendants(
            &conn,
            "codex:parent",
            1,
            2,
            10_000,
            false,
            &period(),
            true,
        )
        .unwrap();
        assert_eq!(
            (
                page.request_count,
                page.requests[0].usage.id.as_str(),
                page.requests[1].usage.id.as_str()
            ),
            (7, "child-b", "nested-invalid")
        );
        let sol = MonitorPeriod {
            model: Some("gpt-6.1-sol".into()),
            ..period()
        };
        let sol = session_detail_with_descendants(
            &conn,
            "codex:parent",
            0,
            100,
            10_000,
            false,
            &sol,
            true,
        )
        .unwrap();
        assert_eq!(
            (
                sol.request_count,
                sol.members.len(),
                sol.filtered_totals.request_count,
                sol.unlinked_child_requests
            ),
            (3, 4, 3, 1)
        );
        assert_eq!(sol.session.meta.model.as_deref(), Some("gpt-6-astra"));
        let child_parent_turn = MonitorPeriod {
            model: Some("gpt-6.1-sol".into()),
            turn_id: Some("parent-b".into()),
            ..period()
        };
        let child_parent_turn = session_detail_with_descendants(
            &conn,
            "codex:parent",
            0,
            100,
            10_000,
            false,
            &child_parent_turn,
            true,
        )
        .unwrap();
        assert_eq!(
            (
                child_parent_turn.request_count,
                child_parent_turn.requests[0].usage.id.as_str()
            ),
            (1, "child-b")
        );
        assert_eq!(child_parent_turn.turns.len(), 2);
        let gap = session_detail_with_descendants(
            &conn,
            "codex:parent",
            0,
            1,
            10_000,
            true,
            &period(),
            true,
        )
        .unwrap();
        let next = session_detail_with_descendants(
            &conn,
            "codex:parent",
            1,
            1,
            10_000,
            true,
            &period(),
            true,
        )
        .unwrap();
        assert_eq!(
            (
                gap.request_count,
                gap.requests[0].usage.id.as_str(),
                next.requests[0].usage.id.as_str()
            ),
            (2, "child-unlinked", "nested-a")
        );
        let reason = MonitorPeriod {
            pricing_reason: Some("actual_mode_unknown".into()),
            turn_id: Some("parent-a".into()),
            ..period()
        };
        let reason = session_detail_with_descendants(
            &conn,
            "codex:parent",
            0,
            100,
            10_000,
            true,
            &reason,
            true,
        )
        .unwrap();
        assert_eq!(
            (
                reason.request_count,
                reason.requests[0].usage.id.as_str(),
                reason.filtered_totals.request_count,
                reason.turns.len()
            ),
            (1, "nested-a", 7, 3)
        );
        let time = MonitorPeriod {
            start_ms: Some(3000),
            end_ms: Some(4500),
            ..Default::default()
        };
        let time = session_detail_with_descendants(
            &conn,
            "codex:parent",
            0,
            100,
            10_000,
            false,
            &time,
            true,
        )
        .unwrap();
        assert_eq!(
            (
                time.request_count,
                time.members.len(),
                time.unlinked_child_requests
            ),
            (4, 4, 2)
        );
    }

    #[test]
    #[ignore = "explicit opt-in: production metadata read-only; no initialization or migrations"]
    fn local_family_detail_read_only_probe() {
        let path =
            std::env::var("USAGE_MONITOR_DETAIL_QA_DB").expect("explicit read-only database path");
        let key =
            std::env::var("USAGE_MONITOR_DETAIL_QA_ROOT").expect("explicit selected session key");
        let conn =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        let now = crate::ledger_db::now_ms();
        let own = session_detail_with_descendants(
            &tx,
            &key,
            0,
            1,
            now,
            false,
            &MonitorPeriod::default(),
            false,
        )
        .unwrap();
        let family = session_detail_with_descendants(
            &tx,
            &key,
            0,
            1,
            now,
            false,
            &MonitorPeriod::default(),
            true,
        )
        .unwrap();
        assert!(family.members.len() > 1);
        assert_eq!(
            family.filtered_totals.request_count,
            family
                .members
                .iter()
                .map(|member| member.totals.request_count)
                .sum::<i64>()
        );
        println!(
            "READ_ONLY_FAMILY own_requests={} family_requests={} members={} unlinked={}",
            own.filtered_totals.request_count,
            family.filtered_totals.request_count,
            family.members.len(),
            family.unlinked_child_requests
        );
        for model in ["gpt-6.1-sol", "gpt-6-luna"] {
            let period = MonitorPeriod {
                model: Some(model.into()),
                ..Default::default()
            };
            let matching =
                session_detail_with_descendants(&tx, &key, 0, 10, now, false, &period, true)
                    .unwrap();
            assert!(matching.request_count > 0);
            assert!(matching
                .requests
                .iter()
                .all(|row| row.usage.model.as_deref() == Some(model)));
            let turn = matching
                .turns
                .iter()
                .find(|turn| turn.totals.request_count > 0)
                .expect("explicitly linked parent turn");
            let selected = MonitorPeriod {
                turn_id: Some(turn.id.clone()),
                ..period
            };
            let selected =
                session_detail_with_descendants(&tx, &key, 0, 10, now, false, &selected, true)
                    .unwrap();
            assert!(selected.request_count > 0);
            assert!(selected
                .requests
                .iter()
                .all(
                    |row| row.usage.root_turn_id.as_deref() == Some(turn.id.as_str())
                        && row.usage.turn_id != turn.id
                ));
            println!(
                "READ_ONLY_FAMILY_MODEL model={} requests={} linked_parent_turn_requests={}",
                model, matching.request_count, selected.request_count
            );
        }
        tx.commit().unwrap();
    }
}

#[cfg(test)]
mod completed_turn_tests {
    use super::*;

    fn record(session: &str, turn: &str, id: &str, output: i64) -> UsageRecord {
        UsageRecord {
            tool: "codex".into(),
            session_id: session.into(),
            turn_id: turn.into(),
            id: id.into(),
            timestamp_ms: 9000,
            output_tokens: output,
            ..Default::default()
        }
    }
    fn turn(
        tx: &Transaction<'_>,
        session: &str,
        id: &str,
        end: Option<i64>,
        duration: Option<i64>,
    ) {
        save_session(
            tx,
            &SessionMeta {
                tool: "codex".into(),
                id: session.into(),
                status: "active".into(),
                updated_at_ms: end.unwrap_or(6000),
                turn_timing: Some(TurnTiming {
                    turn_id: id.into(),
                    started_at_ms: Some(1000),
                    completed_at_ms: end,
                    duration_ms: duration,
                    basis: "codex_turn_events".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .unwrap();
    }

    #[test]
    fn scoped_turn_index_keeps_timing_only_siblings_when_selected() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let tx = conn.transaction().unwrap();
        turn(&tx, "one", "a", Some(5000), Some(2000));
        turn(&tx, "one", "b", Some(6000), Some(1000));
        let mut usage = record("one", "a", "request", 100);
        usage.timestamp_ms = 4000;
        usage.model = Some("model-a".into());
        save_usage(&tx, &usage, i64::MAX, 7000).unwrap();
        tx.commit().unwrap();
        let period = MonitorPeriod {
            start_ms: Some(1000),
            end_ms: Some(7000),
            ..Default::default()
        };
        for selected in [None, Some("a"), Some("b")] {
            let selected_period = MonitorPeriod {
                turn_id: selected.map(str::to_owned),
                ..period.clone()
            };
            let detail =
                session_detail(&conn, "codex:one", 0, 100, 7000, false, &selected_period).unwrap();
            assert_eq!(detail.turns.len(), 2);
            assert_eq!(detail.filtered_totals.request_count, 1);
            assert_eq!(
                detail
                    .turns
                    .iter()
                    .map(|turn| turn.totals.request_count)
                    .sum::<i64>(),
                1
            );
            assert_eq!(
                detail.request_count,
                if selected == Some("b") { 0 } else { 1 }
            );
            if selected == Some("b") {
                let completed = detail.selected_completed_turn.unwrap();
                assert_eq!(completed.timing.turn_id, "b");
                assert_eq!(completed.output_tokens, None);
            }
        }
        let model_scope = MonitorPeriod {
            model: Some("model-a".into()),
            turn_id: Some("a".into()),
            ..period.clone()
        };
        assert_eq!(
            session_detail(&conn, "codex:one", 0, 100, 7000, false, &model_scope)
                .unwrap()
                .turns
                .len(),
            1
        );
        let time_scope = MonitorPeriod {
            end_ms: Some(5500),
            turn_id: Some("a".into()),
            ..period
        };
        assert_eq!(
            session_detail(&conn, "codex:one", 0, 100, 7000, false, &time_scope)
                .unwrap()
                .turns
                .len(),
            1
        );
    }

    #[test]
    fn latest_completed_turn_uses_exact_whole_turn_without_replacing_current_timing() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let tx = conn.transaction().unwrap();
        turn(&tx, "one", "old", Some(2000), Some(1000));
        turn(&tx, "one", "finished", Some(5000), Some(2000));
        turn(&tx, "one", "current", None, None);
        turn(&tx, "two", "finished", Some(5000), Some(2000));
        for usage in [
            record("one", "old", "old", 100),
            record("one", "finished", "a", 900),
            record("one", "finished", "b", 300),
            record("one", "current", "current", 17),
            record("two", "finished", "other", 9000),
        ] {
            save_usage(&tx, &usage, i64::MAX, 10_000).unwrap();
        }
        tx.commit().unwrap();
        let all = sessions(&conn, None, 10_000).unwrap();
        assert!(all.iter().all(|row| row.latest_completed_turn.is_none()));
        let mut page = vec![all.iter().find(|row| row.meta.id == "one").unwrap().clone()];
        let mut active = page.clone();
        enrich_session_outputs(&conn, &mut [&mut page, &mut active]).unwrap();
        for row in page.iter().chain(active.iter()) {
            let completed = row.latest_completed_turn.as_ref().unwrap();
            assert_eq!(completed.timing.turn_id, "finished");
            assert_eq!(completed.output_tokens, Some(1200));
            assert_eq!(completed.output_tokens_per_second, Some(600.0));
            assert_eq!(row.meta.turn_timing.as_ref().unwrap().turn_id, "current");
            assert_eq!(row.meta.turn_timing.as_ref().unwrap().duration_ms, None);
        }
    }

    #[test]
    fn selected_older_completed_turn_uses_all_models_and_times_not_visible_page() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let tx = conn.transaction().unwrap();
        turn(&tx, "one", "older", Some(10_000), Some(2000));
        turn(&tx, "one", "latest", Some(12_000), Some(1000));
        turn(&tx, "one", "current", None, None);
        turn(&tx, "two", "older", Some(10_000), Some(2000));
        let mut hidden = record("one", "older", "hidden", 400);
        hidden.timestamp_ms = 2000;
        hidden.model = Some("model-a".into());
        let mut visible = record("one", "older", "visible", 600);
        visible.model = Some("model-b".into());
        for usage in [
            hidden,
            visible,
            record("one", "latest", "latest", 99),
            record("two", "older", "other-session", 30_000),
        ] {
            save_usage(&tx, &usage, i64::MAX, 20_000).unwrap();
        }
        tx.commit().unwrap();
        let period = MonitorPeriod {
            start_ms: Some(8000),
            end_ms: Some(10_000),
            model: Some("model-b".into()),
            turn_id: Some("older".into()),
            pricing_reason: None,
        };
        let detail = session_detail(&conn, "codex:one", 0, 1, 20_000, false, &period).unwrap();
        assert_eq!(detail.requests.len(), 1);
        assert_eq!(detail.filtered_totals.output_tokens, 600);
        assert_eq!(
            detail.session.latest_completed_turn.unwrap().timing.turn_id,
            "latest"
        );
        let completed = detail.selected_completed_turn.unwrap();
        assert_eq!(completed.timing.turn_id, "older");
        assert_eq!(completed.output_tokens, Some(1000));
        assert_eq!(completed.output_tokens_per_second, Some(500.0));
        let current = MonitorPeriod {
            turn_id: Some("current".into()),
            ..Default::default()
        };
        assert!(
            session_detail(&conn, "codex:one", 0, 1, 20_000, false, &current)
                .unwrap()
                .selected_completed_turn
                .is_none()
        );
    }

    #[test]
    fn selected_turn_does_not_hide_unknown_output_or_initial_baseline_behind_filters() {
        for unknown_basis in [false, true] {
            let mut conn = Connection::open_in_memory().unwrap();
            initialize(&conn).unwrap();
            let tx = conn.transaction().unwrap();
            turn(&tx, "one", "older", Some(10_000), Some(2000));
            turn(&tx, "one", "latest", Some(12_000), Some(1000));
            let mut hidden = record("one", "older", "hidden", 400);
            hidden.timestamp_ms = 2000;
            if unknown_basis {
                hidden.usage_basis = "legacy_initial_cumulative".into();
            } else {
                hidden.unknown_fields.push("output_tokens".into());
            }
            for usage in [hidden, record("one", "older", "visible", 600)] {
                save_usage(&tx, &usage, i64::MAX, 20_000).unwrap();
            }
            tx.commit().unwrap();
            let period = MonitorPeriod {
                start_ms: Some(8000),
                turn_id: Some("older".into()),
                ..Default::default()
            };
            let detail = session_detail(&conn, "codex:one", 0, 1, 20_000, false, &period).unwrap();
            assert_eq!(detail.filtered_totals.output_tokens, 600);
            let completed = detail.selected_completed_turn.unwrap();
            assert_eq!(completed.timing.duration_ms, Some(2000));
            assert_eq!(completed.output_tokens, None);
            assert_eq!(completed.output_tokens_per_second, None);
        }
    }

    #[test]
    fn completed_turn_preserves_true_zero_missing_output_and_unknown_scope() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let tx = conn.transaction().unwrap();
        for id in ["zero", "unknown", "missing", "zero-duration", "baseline"] {
            turn(
                &tx,
                id,
                "finished",
                Some(5000),
                Some(if id == "zero-duration" { 0 } else { 1000 }),
            );
        }
        let mut unknown = record("unknown", "finished", "unknown", 8);
        unknown.unknown_fields.push("output_tokens".into());
        let mut baseline = record("baseline", "finished", "baseline", 100);
        baseline.usage_basis = "legacy_initial_cumulative".into();
        for usage in [
            record("zero", "finished", "zero", 0),
            record("unknown", "finished", "known", 5),
            unknown,
            record("zero-duration", "finished", "zero-duration", 10),
            baseline,
        ] {
            save_usage(&tx, &usage, i64::MAX, 10_000).unwrap();
        }
        tx.commit().unwrap();
        let mut rows = sessions(&conn, None, 10_000).unwrap();
        enrich_session_outputs(&conn, &mut [&mut rows]).unwrap();
        for row in rows {
            let completed = row.latest_completed_turn.unwrap();
            let expected = match row.meta.id.as_str() {
                "zero" => (Some(0), Some(0.0)),
                "zero-duration" => (Some(10), None),
                _ => (None, None),
            };
            assert_eq!(
                (completed.output_tokens, completed.output_tokens_per_second),
                expected,
                "{}",
                row.meta.id
            );
        }
    }

    #[test]
    fn initial_cumulative_is_durable_but_not_live_output() {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let tx = conn.transaction().unwrap();
        let mut baseline = record("live", "turn", "baseline", 50_000);
        baseline.timestamp_ms = 1000;
        baseline.usage_basis = "legacy_initial_cumulative".into();
        save_usage(&tx, &baseline, 900, 1000).unwrap();
        assert_eq!(
            tx.query_row("SELECT COUNT(*) FROM monitor_observations", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
        let mut delta = record("live", "turn", "delta", 120);
        delta.timestamp_ms = 1100;
        delta.usage_basis = "legacy_cumulative_delta".into();
        save_usage(&tx, &delta, 900, 1100).unwrap();
        let mut canonical = record("live", "turn", "response", 30);
        canonical.timestamp_ms = 1200;
        save_usage(&tx, &canonical, 900, 1200).unwrap();
        save_usage(&tx, &canonical, 900, 1300).unwrap();
        let mut old = record("live", "turn", "old", 99);
        old.timestamp_ms = 800;
        save_usage(&tx, &old, 900, 1300).unwrap();
        tx.commit().unwrap();
        let observed = conn
            .query_row(
                "SELECT COUNT(*),SUM(output_tokens) FROM monitor_observations",
                [],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap();
        assert_eq!(observed, (2, 150));
        let stored = sum_sessions(&sessions(&conn, None, 1300).unwrap());
        assert_eq!((stored.request_count, stored.output_tokens), (4, 50_249));
    }
}
