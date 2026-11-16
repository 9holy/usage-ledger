use super::{store, types::Totals, types::UsageRecord, weekly};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Datelike, Months, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::PathBuf,
};

const DAY: i64 = 86_400_000;
const WEEK: i64 = 7 * DAY;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountSubscription {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    renewal_at_ms: Option<i64>,
    checked_at_ms: Option<i64>,
    active: Option<bool>,
    billing_period: Option<String>,
    source: &'static str,
    error: Option<String>,
}

impl AccountSubscription {
    fn unknown(error: Option<String>) -> Self {
        Self {
            source: "none",
            error,
            ..Self::default()
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountUsagePeriod {
    billing_totals: BTreeMap<String,Totals>,
    source_coverage_incomplete: bool,
    start_ms: i64,
    end_ms: i64,
    observed_end_ms: i64,
    totals: Totals,
}

impl AccountUsagePeriod {
    fn new(start_ms: i64, end_ms: i64, now_ms: i64) -> Self {
        Self {
            billing_totals:BTreeMap::new(),
            source_coverage_incomplete:false,
            start_ms,
            end_ms,
            observed_end_ms: end_ms.min(now_ms),
            totals: Totals::default(),
        }
    }

    fn contains(&self, time: i64) -> bool {
        self.start_ms <= time && time < self.observed_end_ms
    }

    fn add(&mut self,usage:&UsageRecord,totals:&Totals){
        self.add_as(totals, super::billing::key(usage));
    }

    fn add_as(&mut self,totals:&Totals,kind:&str){
        store::merge_totals(&mut self.totals,totals);
        store::merge_totals(self.billing_totals.entry(kind.into()).or_default(),totals);
    }

    fn finish(&mut self){
        store::finish_totals(&mut self.totals);
        for totals in self.billing_totals.values_mut(){store::finish_totals(totals);}
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountUsageCycle {
    #[serde(flatten)]
    period: AccountUsagePeriod,
    #[serde(skip_serializing_if = "Option::is_none")]
    quota_snapshot: Option<AccountUsagePeriod>,
    reset_at_ms: i64,
    quota_observed_at_ms: i64,
    exhausted_at_ms: Option<i64>,
    exhaustion_unknown: bool,
    used_percent: Option<f64>,
    current: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountReferenceUsage {
    calendar_week: AccountUsagePeriod,
    subscription_month: Option<AccountUsagePeriod>,
    current_cycle: Option<AccountUsageCycle>,
    previous_cycle: Option<AccountUsageCycle>,
    quota_cycles: Vec<AccountUsageCycle>,
    month_cycles: Vec<AccountUsageCycle>,
    unsegmented_month: Totals,
    unsegmented_month_billing_totals: BTreeMap<String, Totals>,
}

impl AccountReferenceUsage {
    fn add(&mut self, time: i64, usage: &UsageRecord, totals: &Totals) {
        if self.calendar_week.contains(time) { self.calendar_week.add(usage, totals); }
        if let Some(cycle) = self.quota_cycles.iter_mut().find(|cycle| cycle.period.contains(time)) {
            cycle.period.add(usage, totals);
            if let Some(snapshot) = cycle.quota_snapshot.as_mut().filter(|snapshot| snapshot.contains(time)) {
                snapshot.add(usage, totals);
            }
        }
        if let Some(month) = self.subscription_month.as_mut().filter(|month| month.contains(time)) {
            month.add(usage, totals);
            if let Some(cycle) = self.month_cycles.iter_mut().find(|cycle| cycle.period.contains(time)) {
                cycle.period.add(usage, totals);
            } else {
                store::merge_totals(&mut self.unsegmented_month, totals);
                store::merge_totals(self.unsegmented_month_billing_totals.entry(super::billing::key(usage).into()).or_default(), totals);
            }
        }
    }

    fn finish(&mut self, now: i64) {
        self.calendar_week.finish();
        if let Some(month) = &mut self.subscription_month { month.finish(); }
        for cycle in &mut self.quota_cycles {
            cycle.period.finish();
            if let Some(snapshot) = &mut cycle.quota_snapshot { snapshot.finish(); }
        }
        self.current_cycle = self.quota_cycles.iter().find(|cycle| cycle.current).cloned();
        self.previous_cycle = self.quota_cycles.iter().filter(|cycle| cycle.period.end_ms <= now)
            .max_by_key(|cycle| (cycle.period.end_ms, cycle.period.start_ms)).cloned();
        for cycle in &mut self.month_cycles { cycle.period.finish(); }
        store::finish_totals(&mut self.unsegmented_month);
        for totals in self.unsegmented_month_billing_totals.values_mut() { store::finish_totals(totals); }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountUsage {
    account_key: String,
    account_label: String,
    tool: String,
    billing_kind: &'static str,
    calendar_month: Option<AccountUsagePeriod>,
    client_tools: BTreeSet<String>,
    attribution: &'static str,
    billing_account_verified: bool,
    verified_week_requests: i64,
    creator_reference_week_requests: i64,
    creator_reference: AccountReferenceUsage,
    verified_history: Option<AccountUsagePeriod>,
    subscription: AccountSubscription,
    calendar_week: AccountUsagePeriod,
    subscription_month: Option<AccountUsagePeriod>,
    current_cycle: Option<AccountUsageCycle>,
    previous_cycle: Option<AccountUsageCycle>,
    quota_cycles: Vec<AccountUsageCycle>,
    month_cycles: Vec<AccountUsageCycle>,
    unsegmented_month: Totals,
    unsegmented_month_billing_totals: BTreeMap<String,Totals>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageReport {
    collected_at_ms: i64,
    week_start_ms: i64,
    current_account_key: Option<String>,
    accounts: Vec<AccountUsage>,
    unassigned_week: Totals,
    unassigned_by_tool: BTreeMap<String, Totals>,
    unlocated_totals: Totals,
    unlocated_by_tool: BTreeMap<String, Totals>,
    api_usage: Option<ApiUsage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiUsage {
    week: AccountUsagePeriod,
    month: Option<AccountUsagePeriod>,
}

fn read_api_usage(conn:&Connection,week_start:i64,now:i64,month_start:Option<i64>)->Result<Option<ApiUsage>,String>{
    let mut api=ApiUsage{
        week:AccountUsagePeriod::new(week_start,now,now),
        month:month_start.map(|start|AccountUsagePeriod::new(start,now,now)),
    };
    let start=month_start.map_or(week_start,|start|start.min(week_start));
    let mut query=conn.prepare("SELECT usage,cost FROM monitor_requests WHERE timestamp_ms>=?1 AND timestamp_ms<?2 AND json_extract(usage,'$.billingScope')='api'")
        .map_err(|e|e.to_string())?;
    let rows=query.query_map(params![start,now],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
    for row in rows{
        let (usage,cost)=row.map_err(|e|e.to_string())?;
        let usage:UsageRecord=serde_json::from_str(&usage).map_err(|e|e.to_string())?;
        if !usage.has_period_timestamp() { continue; }
        let totals=weekly::saved_request_totals(&usage,&cost)?;
        if api.week.contains(usage.timestamp_ms){api.week.add(&usage,&totals);}
        if let Some(month)=api.month.as_mut().filter(|p|p.contains(usage.timestamp_ms)){month.add(&usage,&totals);}
    }
    api.week.finish();
    if let Some(month)=&mut api.month{month.finish();}
    let recorded=api.week.totals.request_count>0 || api.month.as_ref().is_some_and(|p|p.totals.request_count>0)
        || conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_requests WHERE json_extract(usage,'$.billingScope')='api' AND timestamp_ms<?1)",[now],|r|r.get::<_,bool>(0)).map_err(|e|e.to_string())?;
    Ok(recorded.then_some(api))
}

#[derive(Debug)]
struct Cycle {
    id: i64,
    start: i64,
    end: Option<i64>,
    reset: i64,
    observed: i64,
    used: Option<f64>,
    // Zero preserves an unknown first-100 boundary across later percentage corrections.
    exhausted: Option<i64>,
}

impl Cycle {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            start: row.get(1)?,
            end: row.get(2)?,
            reset: row.get(3)?,
            observed: row.get(4)?,
            used: row.get(5)?,
            exhausted: row.get(6)?,
        })
    }

    fn is_current(&self, now: i64) -> bool {
        self.end.is_none() && self.start <= now && now < self.reset
    }

    fn report(&self, start: i64, end: i64, now: i64) -> AccountUsageCycle {
        AccountUsageCycle {
            period: AccountUsagePeriod::new(start, end, now),
            quota_snapshot: None,
            reset_at_ms: self.reset,
            quota_observed_at_ms: self.observed,
            exhausted_at_ms: self.exhausted.filter(|time| *time > 0),
            exhaustion_unknown: self.exhausted == Some(0)
                || (self.exhausted.is_none() && self.used.is_some_and(|used| used >= 100.)),
            used_percent: self.used,
            current: self.is_current(now),
        }
    }

    fn quota_report(&self, now: i64) -> AccountUsageCycle {
        let mut cycle = self.report(self.start, self.end.unwrap_or(self.reset), now);
        if cycle.exhaustion_unknown {
            cycle.period.observed_end_ms = self.start;
        } else if let Some(exhausted) = cycle.exhausted_at_ms {
            cycle.period.observed_end_ms = cycle
                .period
                .observed_end_ms
                .min(exhausted.saturating_add(1));
        }
        let mut snapshot = cycle.period.clone();
        snapshot.observed_end_ms = snapshot
            .observed_end_ms
            .min(self.observed.saturating_add(1));
        let cutoff = if cycle.used_percent == Some(100.) {
            cycle.exhausted_at_ms.unwrap_or(self.observed)
        } else {
            self.observed
        }.saturating_add(1);
        if !cycle.exhaustion_unknown && snapshot.observed_end_ms == cutoff {
            cycle.quota_snapshot = Some(snapshot);
        }
        cycle
    }
}

pub(super) fn is_account_weekly_pool(tool: &str, limit_id: &str, window_minutes: Option<i64>) -> bool {
    window_minutes == Some(10080)
        && matches!((tool, limit_id), ("codex", "codex") | ("claude", "seven_day"))
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    // Acquire the writer lock before inspecting the old schema. Concurrent API
    // and collector connections must not both decide to add the same column.
    let transaction = if conn.is_autocommit() {
        Some(Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|error| error.to_string())?)
    } else { None };
    super::request_accounts::initialize(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS monitor_account_cycles (
           id INTEGER PRIMARY KEY, tool TEXT NOT NULL, account_key TEXT NOT NULL,
           slot TEXT NOT NULL, window_minutes INTEGER NOT NULL,
           start_ms INTEGER NOT NULL, end_ms INTEGER, reset_ms INTEGER NOT NULL,
           observed_ms INTEGER NOT NULL, used_percent REAL, exhausted_ms INTEGER,
           attribution_verified INTEGER NOT NULL DEFAULT 0,
           UNIQUE(tool,account_key,start_ms));",
    )
    .map_err(|error| error.to_string())?;
    let has_exhausted: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('monitor_account_cycles') WHERE name='exhausted_ms')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !has_exhausted {
        conn.execute(
            "ALTER TABLE monitor_account_cycles ADD COLUMN exhausted_ms INTEGER",
            [],
        )
        .map_err(|error| error.to_string())?;
    }
    let has_verified: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('monitor_account_cycles') WHERE name='attribution_verified')",
        [], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !has_verified {
        // Older cycles have no provenance: keep them, but do not present them as
        // verified account periods. A later authenticated observation can upgrade
        // its own boundary without treating session-creator history as proof.
        conn.execute("ALTER TABLE monitor_account_cycles ADD COLUMN attribution_verified INTEGER NOT NULL DEFAULT 0", [])
            .map_err(|error| error.to_string())?;
    }
    // Existing installations already have a latest quota snapshot, but no historical rounds.
    let mut statement = conn
        .prepare(
            "SELECT tool,account_key,slot,observed_ms,
               limit_id,
               json_extract(data,'$.resets_at_ms'),json_extract(data,'$.used_percent')
             FROM monitor_quotas q WHERE window_minutes=10080
               AND (json_extract(data,'$.window_seconds') IS NULL OR json_extract(data,'$.window_seconds')=604800)
               AND json_extract(data,'$.attribution')='account'
               AND json_extract(data,'$.source_error') IS NULL
               AND (json_extract(data,'$.billing_account_verified')=1
                 OR (tool<>'codex' AND json_extract(data,'$.source')='cockpit_snapshot'))
               AND NOT EXISTS(SELECT 1 FROM monitor_account_cycles c
                 WHERE c.tool=q.tool AND c.account_key=q.account_key AND c.attribution_verified=1)
             ORDER BY observed_ms DESC,CASE slot WHEN 'primary' THEN 0 ELSE 1 END,id",
        )
        .map_err(|error| error.to_string())?;
    let snapshots = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<i64>>(5)?,
                row.get::<_, Option<f64>>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    for (tool, account, slot, observed, limit_id, reset, used) in snapshots {
        if !is_account_weekly_pool(&tool, &limit_id, Some(10080)) {
            continue;
        }
        observe_quota(
            conn,
            &tool,
            &account,
            &slot,
            Some(10080),
            observed,
            reset,
            used,
        )?;
    }
    if let Some(transaction) = transaction {
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn observe_quota(
    conn: &Connection,
    tool: &str,
    account_key: &str,
    slot: &str,
    window_minutes: Option<i64>,
    observed_ms: Option<i64>,
    reset_ms: Option<i64>,
    used_percent: Option<f64>,
) -> Result<(), String> {
    let Some((observed, reset)) = observed_ms.zip(reset_ms).filter(|(observed, reset)| {
        window_minutes == Some(10080)
            && *observed > 0
            && *reset > *observed
            && reset.saturating_sub(WEEK) <= *observed
    }) else {
        return Ok(());
    };
    let used = used_percent.filter(|used| used.is_finite() && (0.0..=100.0).contains(used));
    // Collector calls are already transactional; offline snapshot writes are not.
    let transaction = if conn.is_autocommit() {
        Some(
            Transaction::new_unchecked(conn, TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    let previous = latest_cycle(conn, tool, account_key)?;
    let mut start = reset - WEEK;
    if let Some(previous) = previous {
        // A snapshot can repeat across slots; weekly windows may also change slots.
        if observed <= previous.observed {
            return Ok(());
        }
        if reset < previous.reset {
            let predecessor_observed: Option<i64> = conn
                .query_row(
                    "SELECT observed_ms FROM monitor_account_cycles
                     WHERE tool=?1 AND account_key=?2 AND attribution_verified=1 AND start_ms<?3 AND end_ms IS NOT NULL
                     ORDER BY start_ms DESC LIMIT 1",
                    params![tool, account_key, previous.start],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            // A prior round's observations exclude older windows, without fixing this round's clock.
            if predecessor_observed
                .is_some_and(|floor| previous.reset - WEEK > floor && start <= floor)
            {
                return Ok(());
            }
        }
        // Before expiry, a moving clock alone is ambiguous even when its inferred start passes the last sample.
        let new_window = start > previous.observed
            && (observed >= previous.reset
                || used
                    .zip(previous.used)
                    .is_some_and(|(next, old)| next < old));
        if !new_window {
            // Unconfirmed or expired snapshots must not replace the last valid cycle evidence.
            if used.is_none() || observed >= previous.reset {
                return Ok(());
            }
            let exhausted = if previous.used == Some(100.) {
                Some(0)
            } else if used == Some(100.) {
                Some(
                    if previous
                        .used
                        .is_some_and(|used| used.is_finite() && used < 100.)
                    {
                        observed
                    } else {
                        0
                    },
                )
            } else {
                None
            };
            conn.execute(
                "UPDATE monitor_account_cycles SET observed_ms=?2,used_percent=COALESCE(?3,used_percent),slot=?4,
                   exhausted_ms=COALESCE(exhausted_ms,?5) WHERE id=?1",
                params![previous.id, observed, used, slot, exhausted],
            )
            .map_err(|error| error.to_string())?;
            if let Some(transaction) = transaction {
                transaction.commit().map_err(|error| error.to_string())?;
            }
            return Ok(());
        }
        if start <= previous.observed || start > observed {
            start = observed;
        }
        conn.execute(
            "UPDATE monitor_account_cycles SET end_ms=?2 WHERE id=?1",
            params![previous.id, start.min(previous.reset)],
        )
        .map_err(|error| error.to_string())?;
    }
    conn.execute(
        "INSERT INTO monitor_account_cycles
           (tool,account_key,slot,window_minutes,start_ms,reset_ms,observed_ms,used_percent,exhausted_ms,attribution_verified)
         VALUES(?1,?2,?3,10080,?4,?5,?6,?7,?8,1)
         ON CONFLICT(tool,account_key,start_ms) DO UPDATE SET
           slot=excluded.slot,end_ms=NULL,reset_ms=excluded.reset_ms,observed_ms=excluded.observed_ms,
           used_percent=excluded.used_percent,exhausted_ms=excluded.exhausted_ms,attribution_verified=1
         WHERE monitor_account_cycles.attribution_verified=0",
        params![tool, account_key, slot, start, reset, observed, used, (used == Some(100.)).then_some(0)],
    )
    .map_err(|error| error.to_string())?;
    if let Some(transaction) = transaction {
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn latest_cycle(conn: &Connection, tool: &str, account: &str) -> Result<Option<Cycle>, String> {
    conn.query_row(
        "SELECT id,start_ms,end_ms,reset_ms,observed_ms,used_percent,exhausted_ms
         FROM monitor_account_cycles WHERE tool=?1 AND account_key=?2 AND attribution_verified=1 ORDER BY start_ms DESC LIMIT 1",
        params![tool, account],
        Cycle::from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

pub(super) fn record_upstream_reset(conn:&Connection,account:&str,source:&str,event:&str,at:i64)->Result<bool,String>{
    let key=format!("account_reset_event:{account}:{source}:{event}");
    let inserted=conn.execute("INSERT OR IGNORE INTO monitor_state VALUES(?1,?2)",params![key,at.to_string()]).map_err(|e|e.to_string())?;
    Ok(anchor_upstream_reset(conn,account,at)?||inserted>0)
}

pub(super) fn apply_saved_resets(conn:&Connection,account:&str)->Result<bool,String>{
    let prefix=format!("account_reset_event:{account}");
    let mut query=conn.prepare("SELECT CAST(data AS INTEGER) FROM monitor_state WHERE key>=?1 AND key<?2 ORDER BY CAST(data AS INTEGER)").map_err(|e|e.to_string())?;
    let times=query.query_map(params![format!("{prefix}:"),format!("{prefix};")],|r|r.get::<_,i64>(0)).map_err(|e|e.to_string())?;
    let mut changed=false;
    for time in times{changed|=anchor_upstream_reset(conn,account,time.map_err(|e|e.to_string())?)?;}
    Ok(changed)
}

fn anchor_upstream_reset(conn:&Connection,account:&str,at:i64)->Result<bool,String>{
    let cycle:Option<(i64,i64)>=conn.query_row("SELECT id,start_ms FROM monitor_account_cycles WHERE tool='codex' AND account_key=?1 AND observed_ms>=?2 AND COALESCE(end_ms,reset_ms)>?2 AND reset_ms<=?3 ORDER BY start_ms LIMIT 1",params![account,at,at.saturating_add(WEEK+300_000)],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
    let Some((id,start))=cycle else{return Ok(false);};
    if start==at{return Ok(false);}
    conn.execute("UPDATE monitor_account_cycles SET end_ms=MIN(reset_ms,?3) WHERE tool='codex' AND account_key=?1 AND id<>?2 AND start_ms<?4 AND end_ms IS NOT NULL AND end_ms>?3",params![account,id,at,start]).map_err(|e|e.to_string())?;
    conn.execute("UPDATE monitor_account_cycles SET start_ms=?2 WHERE id=?1",params![id,at]).map_err(|e|e.to_string())?;
    Ok(true)
}

#[derive(Deserialize)]
struct AuthFile {
    auth_mode: Option<String>,
    tokens: Option<AuthTokens>,
}

#[derive(Deserialize)]
struct AuthTokens {
    account_id: Option<String>,
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct IdClaims {
    #[serde(rename = "https://api.openai.com/auth")]
    auth: Option<EntitlementClaims>,
}

#[derive(Deserialize)]
struct EntitlementClaims {
    chatgpt_account_id: Option<String>,
    chatgpt_subscription_active_start: Option<serde_json::Value>,
    chatgpt_subscription_active_until: Option<serde_json::Value>,
    chatgpt_subscription_last_checked: Option<serde_json::Value>,
}

#[derive(Default)]
struct LocalSubscriptions {
    accounts: BTreeMap<String, AccountSubscription>,
    error: Option<String>,
}

fn claim_time(value: Option<&serde_json::Value>) -> Result<Option<i64>, ()> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let time = if let Some(value) = value.as_str() {
        DateTime::parse_from_rfc3339(value)
            .map_err(|_| ())?
            .timestamp_millis()
    } else {
        value.as_i64().ok_or(())?.checked_mul(1000).ok_or(())?
    };
    (time > 0 && DateTime::from_timestamp_millis(time).is_some())
        .then_some(Some(time))
        .ok_or(())
}

fn decode_subscription(bytes: &[u8]) -> Result<Option<(String, AccountSubscription)>, ()> {
    let file: AuthFile = serde_json::from_slice(bytes).map_err(|_| ())?;
    if file.auth_mode.as_deref().is_some_and(|mode| mode != "chatgpt") {
        return Ok(None);
    }
    let Some(tokens) = file.tokens else { return Ok(None); };
    let selected_account = tokens.account_id;
    let Some(token) = tokens.id_token else { return Ok(None); };
    let payload = token.split('.').nth(1).ok_or(())?;
    let decoded = URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .map_err(|_| ())?;
    let claims: IdClaims = serde_json::from_slice(&decoded).map_err(|_| ())?;
    let Some(claims) = claims.auth else {
        return Ok(None);
    };
    let Some(account) = claims
        .chatgpt_account_id
        .filter(|account| !account.trim().is_empty())
    else {
        return Ok(None);
    };
    if selected_account.as_deref().is_some_and(|selected| selected != account) {
        // An organization selection must not inherit another account's token dates.
        return Err(());
    }
    let start = claim_time(claims.chatgpt_subscription_active_start.as_ref());
    let end = claim_time(claims.chatgpt_subscription_active_until.as_ref());
    let checked = claim_time(claims.chatgpt_subscription_last_checked.as_ref());
    let invalid = start.is_err() || end.is_err() || checked.is_err();
    let mut subscription = AccountSubscription {
        start_ms: start.ok().flatten(),
        end_ms: end.ok().flatten(),
        renewal_at_ms: None,
        checked_at_ms: checked.ok().flatten(),
        active: None,
        billing_period: None,
        source: "local_auth",
        error: invalid.then(|| "Invalid local subscription date metadata".into()),
    };
    if subscription
        .start_ms
        .zip(subscription.end_ms)
        .is_some_and(|(start, end)| start >= end)
    {
        subscription.error = Some("Invalid local subscription date range".into());
    }
    Ok(Some((format!("account:{account}"), subscription)))
}

fn read_local_subscriptions() -> LocalSubscriptions {
    let mut paths = Vec::new();
    if let Some(profile) = std::env::var_os("USERPROFILE").filter(|home| !home.is_empty()).or_else(|| std::env::var_os("HOME").filter(|home| !home.is_empty())) {
        paths.push(PathBuf::from(profile).join(".codex").join("auth.json"));
    }
    if let Some(home) = std::env::var_os("CODEX_HOME").filter(|home| !home.is_empty()) {
        let path = PathBuf::from(home).join("auth.json");
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    let mut result = LocalSubscriptions::default();
    for path in paths {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                result.error = Some("Local subscription metadata could not be read".into());
                continue;
            }
        };
        let mut bytes = Vec::new();
        if file.take(1_048_577).read_to_end(&mut bytes).is_err() || bytes.len() > 1_048_576 {
            result.error = Some("Local subscription metadata could not be read".into());
            continue;
        }
        match decode_subscription(&bytes) {
            Ok(Some((account, subscription))) => {
                let replace = result
                    .accounts
                    .get(&account)
                    .is_none_or(|previous| subscription.checked_at_ms >= previous.checked_at_ms);
                if replace {
                    result.accounts.insert(account, subscription);
                }
            }
            Ok(None) => {}
            Err(()) => result.error = Some("Local subscription metadata is invalid".into()),
        }
    }
    result
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionDates {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    checked_at_ms: Option<i64>,
}

fn save_subscription_dates(conn: &Connection, current: &LocalSubscriptions) -> Result<(), String> {
    for (account, subscription) in &current.accounts {
        if subscription.start_ms.is_none() || subscription.error.is_some() {
            continue;
        }
        let dates = SubscriptionDates {
            start_ms: subscription.start_ms,
            end_ms: subscription.end_ms,
            checked_at_ms: subscription.checked_at_ms,
        };
        conn.execute(
            "INSERT INTO monitor_state(key,data) VALUES(?1,?2)
             ON CONFLICT(key) DO UPDATE SET data=excluded.data
             WHERE excluded.data!=monitor_state.data
               AND COALESCE(json_extract(excluded.data,'$.checkedAtMs'),0)>=COALESCE(json_extract(monitor_state.data,'$.checkedAtMs'),0)",
            params![format!("account_subscription:{account}"), serde_json::to_string(&dates).map_err(|error| error.to_string())?],
        ).map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub(super) fn capture_subscription_dates(conn: &Connection) -> Result<(), String> {
    save_subscription_dates(conn, &read_local_subscriptions())
}

fn legacy_active_subscription() -> Option<bool> { Some(true) }
fn legacy_monthly_subscription() -> Option<String> { Some("monthly".into()) }

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OfficialBillingCycle {
    renewal_at_ms: Option<i64>,
    checked_at_ms: i64,
    // Legacy records were written only after explicit active/monthly responses.
    #[serde(default = "legacy_active_subscription")]
    active: Option<bool>,
    #[serde(default = "legacy_monthly_subscription")]
    billing_period: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
struct UpstreamSubscription {
    end_ms:i64,
    checked_at_ms:i64,
    source:String,
}

pub(super) fn save_upstream_subscription(conn:&Connection,account:&str,source:&str,end:i64,observed:i64)->Result<bool,String>{
    if end<=0 || end>8_640_000_000_000_000 {return Err("Invalid upstream subscription expiry".into());}
    let data=serde_json::to_string(&UpstreamSubscription{end_ms:end,checked_at_ms:observed,source:source.into()}).map_err(|e|e.to_string())?;
    conn.execute("INSERT INTO monitor_state(key,data) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data
      WHERE json_extract(excluded.data,'$.checkedAtMs')>json_extract(monitor_state.data,'$.checkedAtMs')
      AND (json_extract(excluded.data,'$.endMs') IS NOT json_extract(monitor_state.data,'$.endMs')
        OR json_extract(excluded.data,'$.source') IS NOT json_extract(monitor_state.data,'$.source'))",
      params![format!("account_upstream_subscription:{account}"),data]).map(|count|count>0).map_err(|e|e.to_string())
}

pub(super) fn subscription_check_due(conn: &Connection, account: &str, now: i64) -> Result<bool, String> {
    let saved: Option<String> = conn.query_row(
        "SELECT data FROM monitor_state WHERE key=?1", [format!("account_billing_cycle:account:{account}")], |r| r.get(0),
    ).optional().map_err(|e| e.to_string())?;
    let saved = saved.map(|data| serde_json::from_str::<OfficialBillingCycle>(&data))
        .transpose().map_err(|e| e.to_string())?;
    Ok(saved.is_none_or(|saved| {
        let retry_after = if saved.error.is_some() { 300_000 } else { DAY };
        now < saved.checked_at_ms || now.saturating_sub(saved.checked_at_ms) >= retry_after
            || saved.renewal_at_ms.is_some_and(|renewal| renewal <= now)
    }))
}

fn store_official_subscription(conn: &Connection, account: &str, mut next: OfficialBillingCycle) -> Result<(), String> {
    let transaction = if conn.is_autocommit() {
        Some(Transaction::new_unchecked(conn, TransactionBehavior::Immediate).map_err(|e| e.to_string())?)
    } else { None };
    let key = format!("account_billing_cycle:account:{account}");
    let previous: Option<String> = conn.query_row("SELECT data FROM monitor_state WHERE key=?1", [&key], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    if let Some(previous) = previous {
        let saved: OfficialBillingCycle = serde_json::from_str(&previous).map_err(|e| e.to_string())?;
        if saved.checked_at_ms > next.checked_at_ms { return Ok(()); }
        if saved.checked_at_ms == next.checked_at_ms && saved != next {
            // Equally timed contradictory observations cannot establish eligibility.
            next.active = None;
            next.billing_period = None;
            next.renewal_at_ms = None;
            next.error = Some("Conflicting official subscription observations".into());
        }
        let history_key = format!("account_billing_cycle_history:account:{account}:{}:{:x}", saved.checked_at_ms, md5::compute(&previous));
        conn.execute("INSERT OR IGNORE INTO monitor_state(key,data) VALUES(?1,?2)", params![history_key,previous])
            .map_err(|e| e.to_string())?;
    }
    conn.execute("INSERT INTO monitor_state(key,data) VALUES(?1,?2)
        ON CONFLICT(key) DO UPDATE SET data=excluded.data", params![key,serde_json::to_string(&next).map_err(|e| e.to_string())?])
        .map_err(|e| e.to_string())?;
    if let Some(transaction) = transaction { transaction.commit().map_err(|e| e.to_string())?; }
    Ok(())
}

pub(super) fn save_official_subscription(conn: &Connection, account: &str, payload: &serde_json::Value, now: i64) -> Result<(), String> {
    let record = &payload["accounts"][account];
    if record["account"]["account_id"].as_str() != Some(account) {
        return Err("Official subscription account does not match the requested account".into());
    }
    let entitlement = &record["entitlement"];
    let active = entitlement["has_active_subscription"].as_bool();
    let billing_period = entitlement["billing_period"].as_str().filter(|period| !period.trim().is_empty()).map(str::to_owned);
    let monthly = active == Some(true) && billing_period.as_deref() == Some("monthly");
    let renewal_at_ms = if monthly {
        claim_time(entitlement.get("renews_at")).map_err(|_| "Invalid official subscription renewal time")?
    } else { None };
    let explicitly_ineligible = active == Some(false) || billing_period.as_deref().is_some_and(|period| period != "monthly");
    let error = (!explicitly_ineligible && (!monthly || renewal_at_ms.is_none()))
        .then(|| "Official metadata does not establish an active monthly subscription cycle".into());
    store_official_subscription(conn, account, OfficialBillingCycle {
        renewal_at_ms, checked_at_ms: now, active, billing_period, error,
    })
}

pub(super) fn subscription_unavailable(conn: &Connection, account: &str, observed_ms: i64) -> Result<(), String> {
    // Keep the last successful record in history. Failure means unknown, never
    // inactive, and cannot keep a formerly valid monthly period marked current.
    store_official_subscription(conn, account, OfficialBillingCycle {
        renewal_at_ms: None, checked_at_ms: observed_ms, active: None, billing_period: None,
        error: Some("Official subscription metadata could not be refreshed".into()),
    })
}

fn with_subscription_history(
    conn: &Connection,
    current: &LocalSubscriptions,
) -> Result<LocalSubscriptions, String> {
    let mut result = LocalSubscriptions {
        accounts: current.accounts.clone(),
        error: current.error.clone(),
    };
    let mut statement = conn
        .prepare("SELECT key,data FROM monitor_state WHERE key GLOB 'account_subscription:*'")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (key, data) = row.map_err(|error| error.to_string())?;
        let saved: SubscriptionDates =
            serde_json::from_str(&data).map_err(|error| error.to_string())?;
        let account = key.trim_start_matches("account_subscription:").to_owned();
        if result.accounts.get(&account).is_none_or(|current| {
            current.start_ms.is_none() || saved.checked_at_ms > current.checked_at_ms
        }) {
            result.accounts.insert(
                account,
                AccountSubscription {
                    start_ms: saved.start_ms,
                    end_ms: saved.end_ms,
                    renewal_at_ms: None,
                    checked_at_ms: saved.checked_at_ms,
                    active: None,
                    billing_period: None,
                    source: "local_auth",
                    error: None,
                },
            );
        }
    }
    let mut statement = conn.prepare("SELECT key,data FROM monitor_state WHERE key GLOB 'account_billing_cycle:*'")
        .map_err(|e|e.to_string())?;
    let rows = statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))
        .map_err(|e|e.to_string())?;
    for row in rows {
        let (key,data)=row.map_err(|e|e.to_string())?;
        let saved:OfficialBillingCycle=serde_json::from_str(&data).map_err(|e|e.to_string())?;
        let subscription=result.accounts.entry(key.trim_start_matches("account_billing_cycle:").to_owned()).or_default();
        subscription.renewal_at_ms = saved.renewal_at_ms;
        if saved.renewal_at_ms.is_some() { subscription.end_ms = saved.renewal_at_ms; }
        subscription.checked_at_ms = Some(saved.checked_at_ms);
        subscription.active = saved.active;
        subscription.billing_period = saved.billing_period;
        subscription.source = "official";
        subscription.error = saved.error;
    }
    let mut statement=conn.prepare("SELECT key,data FROM monitor_state WHERE key GLOB 'account_upstream_subscription:*'").map_err(|e|e.to_string())?;
    let rows=statement.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
    for row in rows {
        let(key,data)=row.map_err(|e|e.to_string())?;
        let saved:UpstreamSubscription=serde_json::from_str(&data).map_err(|e|e.to_string())?;
        let source=match saved.source.as_str(){"sub2api"=>"sub2api","cliproxy"=>"cliproxy",_=>return Err("Invalid upstream subscription source".into())};
        result.accounts.entry(key.trim_start_matches("account_upstream_subscription:").to_owned()).or_insert(AccountSubscription{
            end_ms:Some(saved.end_ms),checked_at_ms:Some(saved.checked_at_ms),source,..Default::default()
        });
    }
    Ok(result)
}

fn subscription_month(subscription: &AccountSubscription, now: i64) -> Option<(i64, i64)> {
    if subscription.error.is_some() || subscription.active == Some(false)
        || subscription.billing_period.as_deref().is_some_and(|period| period != "monthly") {
        return None;
    }
    if let Some(renewal) = subscription.renewal_at_ms {
        // The original activation date can precede changes to the monthly billing schedule.
        let target = DateTime::<Utc>::from_timestamp_millis(now.min(renewal - 1))?;
        let anchor = DateTime::<Utc>::from_timestamp_millis(renewal)?;
        let mut months = (anchor.year() - target.year()) * 12 + anchor.month() as i32 - target.month() as i32;
        if anchor.checked_sub_months(Months::new(u32::try_from(months).ok()?))? <= target { months -= 1; }
        let start = anchor.checked_sub_months(Months::new(u32::try_from(months + 1).ok()?))?.timestamp_millis();
        let end = anchor.checked_sub_months(Months::new(u32::try_from(months).ok()?))?.timestamp_millis();
        let start = subscription.start_ms.map_or(start, |active| start.max(active));
        return (start <= now && start < end).then_some((start,end));
    }
    let start = subscription.start_ms?;
    let end = subscription.end_ms;
    if now < start || end.is_some_and(|end| end <= start) {
        return None;
    }
    let target = end.map_or(now, |end| now.min(end - 1));
    let anchor = DateTime::<Utc>::from_timestamp_millis(start)?;
    let target = DateTime::<Utc>::from_timestamp_millis(target)?;
    let mut months =
        (target.year() - anchor.year()) * 12 + target.month() as i32 - anchor.month() as i32;
    let mut month_start = anchor.checked_add_months(Months::new(u32::try_from(months).ok()?))?;
    if month_start > target {
        months -= 1;
        month_start = anchor.checked_add_months(Months::new(u32::try_from(months).ok()?))?;
    }
    let month_end = anchor
        .checked_add_months(Months::new(u32::try_from(months + 1).ok()?))?
        .timestamp_millis();
    Some((
        month_start.timestamp_millis(),
        end.map_or(month_end, |end| end.min(month_end)),
    ))
}

fn session_creators(
    conn: &Connection,
    sessions:Option<&str>,
) -> Result<BTreeMap<(String, String), BTreeSet<String>>, String> {
    let filter=if sessions.is_some(){" AND json_extract(state,'$.session.id') IN (SELECT value FROM json_each(?1))"}else{""};
    let mut statement = conn.prepare(&format!(
        "SELECT tool,json_extract(state,'$.session.id'),json_extract(state,'$.quota_account_id')
         FROM monitor_files WHERE json_type(state,'$.session.id')='text'
           AND json_extract(state,'$.quota_identity_error') IS NULL{filter}",
    )).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(sessions), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut creators = BTreeMap::<_, BTreeSet<_>>::new();
    for row in rows {
        let (tool, session, account) = row.map_err(|error| error.to_string())?;
        if let Some(account) = account.filter(|account| !account.trim().is_empty()) {
            creators
                .entry((tool, session))
                .or_default()
                .insert(format!("account:{account}"));
        }
    }
    Ok(creators)
}

fn request_owner(evidence:&super::request_accounts::EvidenceIndex,creators:&BTreeMap<(String,String),BTreeSet<String>>,usage:&UsageRecord)->(Option<String>,bool){
    match evidence.account_for(usage){
        super::request_accounts::AccountMatch::Verified(account)=>(Some(account.to_owned()),true),
        super::request_accounts::AccountMatch::Conflict=>(None,false),
        super::request_accounts::AccountMatch::None=>(creators.get(&(usage.tool.clone(),usage.session_id.clone())).filter(|owners|owners.len()==1).and_then(|owners|owners.first().cloned()),false),
    }
}

fn unverified_source(usage:&UsageRecord)->&'static str{
    match usage.billing_scope.as_deref(){Some("subscription")=>"direct",Some("api")=>"api",_=>"unknown"}
}

#[cfg(test)]
pub(super) fn request_memberships(conn:&Connection,requests:&[UsageRecord])->Result<Vec<(String,String,String)>,String>{
    Ok(request_assignments(conn,requests)?.into_iter().map(|(tool,id,account,_)|(tool,id,account)).collect())
}

pub(super) fn request_assignments(conn:&Connection,requests:&[UsageRecord])->Result<Vec<(String,String,String,String)>,String>{
    let evidence=super::request_accounts::EvidenceIndex::load_for_requests(conn,requests)?;
    let sessions=serde_json::to_string(&requests.iter().map(|r|r.session_id.as_str()).collect::<BTreeSet<_>>()).map_err(|e|e.to_string())?;
    let creators=session_creators(conn,Some(&sessions))?;
    Ok(requests.iter().map(|usage|{
        let owner=evidence.upstream_owner(usage);
        let source=owner.as_ref().filter(|owner|!owner.conflict).map(|owner|owner.sources.iter().cloned().collect::<Vec<_>>().join("+")).unwrap_or_else(||unverified_source(usage).into());
        let key=if let Some(owner)=owner {
            if owner.conflict { if usage.billing_scope.as_deref()==Some("api"){"api:all".into()}else{"unassigned".into()} }
            else {super::quota::report_account_key(&owner.account_tool,&owner.account)}
        }else if usage.billing_scope.as_deref()==Some("api"){"api:all".into()}else{
            request_owner(&evidence,&creators,usage).0.map(|raw|super::quota::report_account_key(&usage.tool,&raw)).unwrap_or_else(||"unassigned".into())
        };
        (usage.tool.clone(),usage.id.clone(),key,source)
    }).collect())
}

#[cfg(test)]
fn read(
    conn: &Connection,
    week_start: i64,
    now: i64,
    subscriptions: &LocalSubscriptions,
) -> Result<AccountUsageReport, String> {
    read_with_usage(conn, week_start, now, subscriptions, None, |_, _, _, _| {})
}

fn read_with_usage(
    conn: &Connection,
    week_start: i64,
    now: i64,
    subscriptions: &LocalSubscriptions,
    month_start: Option<i64>,
    mut consume: impl FnMut(&str, &str, &UsageRecord, &Totals),
) -> Result<AccountUsageReport, String> {
    let current_account = if subscriptions.error.is_none() && subscriptions.accounts.len() == 1 {
        subscriptions.accounts.keys().next()
    } else {
        None
    };
    let subscriptions = with_subscription_history(conn, subscriptions)?;
    let evidence = super::request_accounts::EvidenceIndex::load(conn)?;
    let verified_bounds = evidence.account_bounds();
    let mut pending=BTreeMap::<(String,String),Vec<i64>>::new();
    let mut query=conn.prepare("SELECT CASE WHEN account_tool='' THEN tool ELSE account_tool END,account_key,timestamp_ms
      FROM monitor_upstream_receipts WHERE (monitor_id IS NULL OR conflicted) AND subscription AND quota_eligible AND account_key<>''").map_err(|e|e.to_string())?;
    let pending_rows=query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).map_err(|e|e.to_string())?;
    for row in pending_rows {let(tool,account,time)=row.map_err(|e|e.to_string())?;pending.entry((tool,account)).or_default().push(time);}
    let pending=pending.into_iter().map(|((tool,account),times)|(super::quota::report_account_key(&tool,&account),times)).collect::<BTreeMap<_,_>>();
    let mut rows=Vec::new();
    for tool in ["codex","claude","antigravity","deepseek-harness"] {
        for(raw,id,_)in super::quota::account_identity_rows(conn,tool)?{rows.push((tool.to_owned(),raw,id));}
    }
    rows.sort_by(|a,b|(&a.0,a.2).cmp(&(&b.0,b.2)));
    let mut accounts = Vec::new();
    let mut current_account_key = None;
    let mut indices = BTreeMap::new();
    let mut ranges = vec![(week_start, now)];
    let mut report_identities = BTreeMap::new();
    for (tool, raw_account, _id) in rows {
        if !report_identities.contains_key(&tool) {
            report_identities.insert(tool.clone(), super::quota::account_identity_report(conn, &tool)?.accounts);
        }
        let subscription = if tool == "codex" {
            subscriptions
                .accounts
                .get(&raw_account)
                .cloned()
                .unwrap_or_else(|| AccountSubscription::unknown(subscriptions.error.clone()))
        } else {
            AccountSubscription::unknown(None)
        };
        let month = subscription_month(&subscription, now)
            .map(|(start, end)| AccountUsagePeriod::new(start, end, now));
        let calendar_fallback=month_start.map(|start|AccountUsagePeriod::new(start,now,now));
        let reporting_month=month.as_ref().or(calendar_fallback.as_ref());
        let verified_history = (tool=="codex").then(|| verified_bounds.get(&raw_account)).flatten()
            .map(|(start,end)| AccountUsagePeriod::new(*start,*end,now));
        let mut cycle_statement = conn
            .prepare(
                "SELECT id,start_ms,end_ms,reset_ms,observed_ms,used_percent,exhausted_ms
             FROM monitor_account_cycles WHERE tool=?1 AND account_key=?2
               AND attribution_verified=1 AND start_ms<=?3 AND observed_ms>0
               AND COALESCE(end_ms,reset_ms)>start_ms ORDER BY start_ms DESC",
            )
            .map_err(|error| error.to_string())?;
        let cycles = cycle_statement
            .query_map(params![tool, raw_account, now], Cycle::from_row)
            .map_err(|error| error.to_string())?;
        let mut quota_cycles = Vec::new();
        let mut month_cycles = Vec::new();
        for cycle in cycles {
            let cycle = cycle.map_err(|error| error.to_string())?;
            let quota = cycle.quota_report(now);
            ranges.push((quota.period.start_ms, quota.period.observed_end_ms));
            quota_cycles.push(quota);
            if let Some(month) = reporting_month.filter(|month| {
                cycle.start < month.observed_end_ms
                    && cycle.end.unwrap_or(cycle.reset) > month.start_ms
            }) {
                let start = cycle.start.max(month.start_ms);
                let end = cycle.end.unwrap_or(cycle.reset).min(month.end_ms);
                month_cycles.push(cycle.report(start, end, now));
            }
        }
        month_cycles.reverse();
        if let Some(month) = &month {
            ranges.push((month.start_ms, month.observed_end_ms));
        }
        let (account_key, default_label) = report_identities
            .get(&tool)
            .and_then(|identities| identities.get(&raw_account))
            .cloned()
            .unwrap_or_else(|| (format!("{tool}:{raw_account}"), format!("Account {_id}")));
        let billing_kind=if quota_cycles.is_empty() && subscription.start_ms.is_none() && evidence.account_is_api_only(&tool,&raw_account){"api"}else{"subscription"};
        let calendar_month=if billing_kind=="api" || month.is_none(){calendar_fallback}else{None};
        if let Some(month)=&calendar_month{ranges.push((month.start_ms,month.observed_end_ms));}
        if tool == "codex" && current_account == Some(&raw_account) {
            current_account_key = Some(account_key.clone());
        }
        indices.insert((tool.clone(), raw_account.clone()), accounts.len());
        accounts.push(AccountUsage {
            account_key,
            account_label: default_label,
            tool,
            billing_kind,
            calendar_month,
            client_tools:BTreeSet::new(),
            attribution: "session_creator",
            // Session creation metadata does not identify the account used after a sign-in change.
            billing_account_verified: false,
            verified_week_requests: 0,
            creator_reference_week_requests: 0,
            creator_reference: AccountReferenceUsage {
                calendar_week: AccountUsagePeriod::new(week_start, now, now),
                subscription_month: month.clone(), current_cycle: None, previous_cycle: None,
                quota_cycles: quota_cycles.clone(), month_cycles: month_cycles.clone(),
                unsegmented_month: Totals::default(), unsegmented_month_billing_totals: BTreeMap::new(),
            },
            verified_history,
            subscription,
            calendar_week: AccountUsagePeriod::new(week_start, now, now),
            subscription_month: month,
            current_cycle: None,
            previous_cycle: None,
            quota_cycles,
            month_cycles,
            unsegmented_month: Totals::default(),
            unsegmented_month_billing_totals:BTreeMap::new(),
        });
    }
    let creators = session_creators(conn,None)?;
    let mut unassigned_week = Totals::default();
    let mut unassigned_by_tool = BTreeMap::<String, Totals>::new();
    let mut unlocated_totals = Totals::default();
    let mut unlocated_by_tool = BTreeMap::<String, Totals>::new();
    let mut recent_upstream:Option<(i64,usize)>=None;
    let mut api_usage:Option<ApiUsage>=None;
    ranges.retain(|(start, end)| start < end);
    ranges.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (start, end) in ranges {
        if let Some(previous) = merged.last_mut().filter(|previous| start <= previous.1) {
            previous.1 = previous.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    // Disjoint expired subscription months must not pull years of unrelated requests into memory.
    let where_clause = if merged.is_empty() {
        "0".into()
    } else {
        merged
            .iter()
            .map(|_| "(timestamp_ms>=? AND timestamp_ms<?)")
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    let mut statement = conn.prepare(&format!(
        "SELECT tool,timestamp_ms,usage,cost FROM monitor_requests WHERE ({where_clause})
           OR (tool='codex' AND timestamp_ms<? AND id IN (SELECT value FROM json_each(?)))
           OR EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='timestamp')
           OR json_extract(usage,'$.usageBasis') IN ('legacy_initial_cumulative','legacy_cumulative_delta') ORDER BY timestamp_ms",
    )).map_err(|error| error.to_string())?;
    // The display bounds of verified history may span years. Read only the
    // actually matched requests between them, not every unrelated intervening row.
    let mut parameters: Vec<rusqlite::types::Value> = merged.iter()
        .flat_map(|(start, end)| [rusqlite::types::Value::Integer(*start), rusqlite::types::Value::Integer(*end)]).collect();
    parameters.push(rusqlite::types::Value::Integer(now));
    parameters.push(rusqlite::types::Value::Text(serde_json::to_string(&evidence.api_request_ids()).map_err(|error| error.to_string())?));
    let rows = statement
        .query_map(rusqlite::params_from_iter(parameters), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (tool, time, usage, cost) = row.map_err(|error| error.to_string())?;
        let usage: UsageRecord = serde_json::from_str(&usage).map_err(|error| error.to_string())?;
        let totals = weekly::saved_request_totals(&usage, &cost)?;
        if !usage.has_period_timestamp() {
            store::merge_totals(&mut unlocated_totals, &totals);
            store::merge_totals(unlocated_by_tool.entry(tool).or_default(), &totals);
            continue;
        }
        let upstream = evidence.upstream_owner(&usage);
        let source = upstream.as_ref().filter(|owner|!owner.conflict).map(|owner|owner.sources.iter().cloned().collect::<Vec<_>>().join("+"))
            .unwrap_or_else(||unverified_source(&usage).into());
        if usage.billing_scope.as_deref()==Some("api") {
            if week_start<=time && time<now {
                api_usage.get_or_insert_with(||ApiUsage{week:AccountUsagePeriod::new(week_start,now,now),month:None}).week.add(&usage,&totals);
            }
            if upstream.as_ref().is_none_or(|owner|owner.conflict) {
                if week_start<=time && time<now {
                consume("api:all", &source, &usage, &totals);
                }
                continue;
            }
        }
        let quota_tool=upstream.as_ref().map_or(usage.tool.as_str(),|owner|owner.account_tool.as_str());
        let quota_eligible = usage.billing_scope.as_deref()!=Some("api") || upstream.as_ref().is_some_and(|owner|!owner.conflict&&owner.subscription&&owner.quota_eligible)
            && !(quota_tool=="codex"&&usage.model.as_deref().is_some_and(|model|model.ends_with("-spark")));
        let (owner_tool,account_key, verified) = if let Some(owner)=upstream {
            if owner.conflict {(tool,None,false)}else{(owner.account_tool,Some(owner.account),true)}
        } else {let(account,verified)=request_owner(&evidence,&creators,&usage);(tool,account,verified)};
        let index = account_key.and_then(|account| indices.get(&(owner_tool, account))).filter(|_| verified);
        let Some(index) = index else {
            // A creator is useful provenance for a conversation, never proof of
            // the login that paid for a later request. References are a subset
            // of unassigned records and must not be added to confirmed totals.
            if week_start <= time && time < now {
                store::merge_totals(&mut unassigned_week, &totals);
                store::merge_totals(unassigned_by_tool.entry(usage.tool.clone()).or_default(), &totals);
                consume("unassigned", &source, &usage, &totals);
            }
            if let Some(reference) = creators.get(&(usage.tool.clone(), usage.session_id.clone()))
                .filter(|creators| creators.len() == 1).and_then(|creators| creators.first())
                .and_then(|creator| indices.get(&(usage.tool.clone(), creator.clone()))) {
                accounts[*reference].creator_reference.add(time, &usage, &totals);
            }
            continue;
        };
        let account = &mut accounts[*index];
        if verified && usage.billing_scope.as_deref()==Some("api") && time>=now-30*60_000 && time<=now && recent_upstream.is_none_or(|(previous,_)|time>previous){recent_upstream=Some((time,*index));}
        if let Some(month)=account.calendar_month.as_mut().filter(|month|month.contains(time)){month.add(&usage,&totals);}
        if verified {
            if let Some(history) = account.verified_history.as_mut().filter(|range|range.contains(time)) {
                history.add(&usage,&totals);
            }
        }
        if account.calendar_week.contains(time) {
            if !account.client_tools.contains(&usage.tool){account.client_tools.insert(usage.tool.clone());}
            account.calendar_week.add(&usage,&totals);
            consume(&account.account_key, &source, &usage, &totals);
            if verified { account.verified_week_requests += 1; }
            else { account.creator_reference_week_requests += 1; }
        }
        let quota_kind = if usage.billing_scope.as_deref()==Some("api") && quota_eligible {"subscription"}else{super::billing::key(&usage)};
        if let Some(cycle) = account
            .quota_cycles
            .iter_mut()
            .find(|cycle| quota_eligible && cycle.period.contains(time))
        {
            cycle.period.add_as(&totals,quota_kind);
            if let Some(snapshot) = cycle
                .quota_snapshot
                .as_mut()
                .filter(|snapshot| snapshot.contains(time))
            {
                snapshot.add_as(&totals,quota_kind);
            }
        }
        let in_month=match account.subscription_month.as_mut(){
            Some(month) if month.contains(time)=>{month.add(&usage,&totals);true},
            Some(_)=>false,
            None=>account.calendar_month.as_ref().is_some_and(|month|month.contains(time)),
        };
        if in_month {
            if let Some(cycle) = account
                .month_cycles
                .iter_mut()
                .find(|cycle| cycle.period.contains(time))
            {
                cycle.period.add(&usage,&totals);
            } else {
                store::merge_totals(&mut account.unsegmented_month, &totals);
                store::merge_totals(account.unsegmented_month_billing_totals.entry(super::billing::key(&usage).into()).or_default(),&totals);
            }
        }
    }
    for account in &mut accounts {
        account.creator_reference.finish(now);
        account.creator_reference_week_requests = account.creator_reference.calendar_week.totals.request_count;
        account.billing_account_verified = account.calendar_week.totals.request_count > 0
            || account.subscription_month.as_ref().is_some_and(|period| period.totals.request_count > 0)
            || account.calendar_month.as_ref().is_some_and(|period| period.totals.request_count > 0)
            || account.quota_cycles.iter().any(|cycle| cycle.period.totals.request_count > 0);
        if account.billing_account_verified { account.attribution = "request_evidence_with_creator_reference"; }
        if account.calendar_week.billing_totals.get("subscription").is_some_and(|totals|totals.request_count>0){account.billing_kind="subscription";}
        if let Some(month)=&mut account.calendar_month{month.finish();}
        if let Some(history) = &mut account.verified_history {
            history.finish();
            if history.totals.request_count > 0 {
                account.attribution = "request_evidence_with_creator_reference";
                account.billing_account_verified = true;
            }
        }
        account.calendar_week.finish();
        if let Some(month) = &mut account.subscription_month {
            month.finish();
        }
        for cycle in &mut account.quota_cycles {
            cycle.period.finish();
            if let Some(times)=pending.get(&account.account_key){cycle.period.source_coverage_incomplete=times.iter().any(|time|cycle.period.contains(*time));}
            if let Some(snapshot) = &mut cycle.quota_snapshot {
                snapshot.finish();
                if let Some(times)=pending.get(&account.account_key){snapshot.source_coverage_incomplete=times.iter().any(|time|snapshot.contains(*time));}
            }
        }
        account.current_cycle = account
            .quota_cycles
            .iter()
            .find(|cycle| cycle.current)
            .cloned();
        account.previous_cycle = account
            .quota_cycles
            .iter()
            .filter(|cycle| cycle.period.end_ms <= now)
            .max_by_key(|cycle| (cycle.period.end_ms, cycle.period.start_ms))
            .cloned();
        for cycle in &mut account.month_cycles {
            cycle.period.finish();
        }
        store::finish_totals(&mut account.unsegmented_month);
        for totals in account.unsegmented_month_billing_totals.values_mut(){store::finish_totals(totals);}
    }
    store::finish_totals(&mut unassigned_week);
    store::finish_totals(&mut unlocated_totals);
    for totals in unassigned_by_tool.values_mut().chain(unlocated_by_tool.values_mut()) { store::finish_totals(totals); }
    if current_account_key.is_none(){current_account_key=recent_upstream.map(|(_,index)|accounts[index].account_key.clone());}
    if let Some(api)=&mut api_usage {api.week.finish();}
    Ok(AccountUsageReport {
        collected_at_ms: now,
        week_start_ms: week_start,
        current_account_key,
        accounts,
        unassigned_week,
        unassigned_by_tool,
        unlocated_totals,
        unlocated_by_tool,
        api_usage,
    })
}

#[tauri::command]
pub async fn usage_monitor_accounts(
    week_start_ms: i64,
    now_ms: i64,
    month_start_ms: Option<i64>,
) -> Result<AccountUsageReport, String> {
    if month_start_ms.is_some_and(|start|start<0 || start>now_ms || now_ms-start>32*DAY){
        return Err("Invalid API usage month".into());
    }
    if week_start_ms < 0
        || now_ms <= 0
        || week_start_ms > now_ms
        || now_ms - week_start_ms > 8 * DAY
        || DateTime::from_timestamp_millis(now_ms).is_none()
    {
        return Err("Invalid account usage week range".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = super::connection()?;
        let transaction = conn
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        let mut report=read_with_usage(
            &transaction,
            week_start_ms,
            now_ms,
            &read_local_subscriptions(),
            month_start_ms,
            |_,_,_,_|{},
        )?;
        report.api_usage=read_api_usage(&transaction,week_start_ms,now_ms,month_start_ms)?;
        Ok(report)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct LocalCostUsage {
    pub id:String,
    pub label:String,
    pub tool:String,
    pub billing_kind:&'static str,
    pub client_tools:BTreeSet<String>,
    pub totals:Totals,
    pub verified_requests:i64,
    pub reference_requests:i64,
    pub billing_counts:BTreeMap<String,i64>,
    pub periods:Option<LocalCostPeriods>,
    pub analytics:super::local_cost::UsageAnalytics,
    pub sources:BTreeMap<String,super::local_cost::UsageAnalytics>,
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct LocalCostPeriods {
    subscription:AccountSubscription,
    current_cycle:Option<AccountUsageCycle>,
    previous_cycle:Option<AccountUsageCycle>,
    quota_cycles:Vec<AccountUsageCycle>,
    subscription_month:Option<AccountUsagePeriod>,
    calendar_month:Option<AccountUsagePeriod>,
    billing_account_verified:bool,
    verified_history:Option<AccountUsagePeriod>,
    month_cycles:Vec<AccountUsageCycle>,
    unsegmented_month:Totals,
}

#[cfg(test)]
pub(super) fn local_cost_usage(conn:&Connection,start:i64,end:i64)->Result<(Vec<LocalCostUsage>,super::local_cost::UsageAnalytics,Option<String>),String>{
    local_cost_usage_with_month(conn,start,end,None)
}

pub(super) fn local_cost_usage_with_month(conn:&Connection,start:i64,end:i64,month_start:Option<i64>)->Result<(Vec<LocalCostUsage>,super::local_cost::UsageAnalytics,Option<String>),String>{
    let mut groups=BTreeMap::<String,super::local_cost::UsageAnalyticsBuilder>::new();
    let mut billing_counts=BTreeMap::<String,BTreeMap<String,i64>>::new();
    let mut sources=BTreeMap::<String,BTreeMap<String,super::local_cost::UsageAnalyticsBuilder>>::new();
    let mut all=super::local_cost::UsageAnalyticsBuilder::default();
    let mut samples=super::local_cost::observed_samples(conn,start,end)?;
    let coverage=super::live::history_coverage(conn,start,end)?;
    let first=if start==0 {conn.query_row("SELECT COALESCE(MIN(timestamp_ms),?1) FROM monitor_requests",[end],|row|row.get::<_,i64>(0)).map_err(|error|error.to_string())?}else{start};
    let history_start=if start==0{first/60_000*60_000}else{(start+59_999)/60_000*60_000};
    let bucket=((end-first+239)/240).max(3_600_000);
    let report=read_with_usage(conn,start,end,&read_local_subscriptions(),month_start,|id,source,usage,totals|{
        *billing_counts.entry(id.into()).or_default().entry(super::billing::key(usage).into()).or_default()+=1;
        all.add(usage,totals,first,bucket);
        groups.entry(id.into()).or_default().add(usage,totals,first,bucket);
        sources.entry(id.into()).or_default().entry(source.into()).or_default().add(usage,totals,first,bucket);
        if let Some(samples)=samples.remove(&(usage.tool.clone(),usage.id.clone())){
            all.observe(&usage.tool,&samples,history_start,bucket);groups.get_mut(id).unwrap().observe(&usage.tool,&samples,history_start,bucket);
            sources.get_mut(id).unwrap().get_mut(source).unwrap().observe(&usage.tool,&samples,history_start,bucket);
        }
    })?;
    // Output history uses observation time even when the request falls outside this period.
    if !samples.is_empty(){
        let keys=serde_json::to_string(&samples.keys().collect::<Vec<_>>()).map_err(|e|e.to_string())?;
        let mut query=conn.prepare("SELECT usage FROM monitor_requests WHERE (tool,id) IN
            (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?1))").map_err(|e|e.to_string())?;
        let rows=query.query_map([keys],|row|row.get::<_,String>(0)).map_err(|e|e.to_string())?;
        let requests=rows.map(|row|serde_json::from_str::<UsageRecord>(&row.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect::<Result<Vec<_>,String>>()?;
        for(tool,id,account,source)in request_assignments(conn,&requests)?{
            let output=&samples[&(tool.clone(),id)];
            all.observe(&tool,output,history_start,bucket);
            groups.entry(account.clone()).or_default().observe(&tool,output,history_start,bucket);
            sources.entry(account).or_default().entry(source).or_default().observe(&tool,output,history_start,bucket);
        }
    }
    let current=report.current_account_key;
    let mut rows=report.accounts.into_iter().map(|a|{
        let analytics=groups.remove(&a.account_key).unwrap_or_default().finish(&coverage,end);
        let billing_counts=billing_counts.remove(&a.account_key).unwrap_or_default();
        let account_sources=sources.remove(&a.account_key).unwrap_or_default().into_iter().map(|(source,builder)|(source,builder.finish(&coverage,end))).collect();
        LocalCostUsage{
            id:a.account_key,label:a.account_label,tool:a.tool,billing_kind:a.billing_kind,client_tools:a.client_tools,totals:a.calendar_week.totals,
            verified_requests:a.verified_week_requests,reference_requests:a.creator_reference_week_requests,
            billing_counts,
            periods:Some(LocalCostPeriods{subscription:a.subscription,current_cycle:a.current_cycle,previous_cycle:a.previous_cycle,quota_cycles:a.quota_cycles,subscription_month:a.subscription_month,calendar_month:a.calendar_month,billing_account_verified:a.billing_account_verified,verified_history:a.verified_history,month_cycles:a.month_cycles,unsegmented_month:a.unsegmented_month}),
            analytics,
            sources:account_sources,
        }
    }).collect::<Vec<_>>();
    let api=groups.remove("api:all").unwrap_or_default().finish(&coverage,end);
    let api_clients=api.client_tools();
    rows.push(LocalCostUsage{id:"api:all".into(),label:"API".into(),tool:"api".into(),billing_kind:"api",client_tools:api_clients,totals:api.totals.clone(),verified_requests:api.totals.request_count,reference_requests:0,billing_counts:billing_counts.remove("api:all").unwrap_or_default(),periods:None,analytics:api,sources:sources.remove("api:all").unwrap_or_default().into_iter().map(|(source,builder)|(source,builder.finish(&coverage,end))).collect()});
    if report.unassigned_week.request_count>0 || groups.contains_key("unassigned") {
        let analytics=groups.remove("unassigned").unwrap_or_default().finish(&coverage,end);let clients=analytics.client_tools();
        rows.push(LocalCostUsage{id:"unassigned".into(),label:"unassigned".into(),tool:"unknown".into(),billing_kind:"unknown",client_tools:clients,totals:report.unassigned_week,verified_requests:0,reference_requests:0,billing_counts:billing_counts.remove("unassigned").unwrap_or_default(),periods:None,analytics,sources:sources.remove("unassigned").unwrap_or_default().into_iter().map(|(source,builder)|(source,builder.finish(&coverage,end))).collect()});
    }
    Ok((rows,all.finish(&coverage,end),current))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn time(date: &str) -> i64 {
        DateTime::parse_from_rfc3339(date)
            .unwrap()
            .timestamp_millis()
    }

    fn database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        conn
    }

    fn account(conn: &Connection, id: i64, creator: &str) {
        let data = json!({ "attribution": "account" });
        conn.execute(
            "INSERT INTO monitor_quotas(id,tool,account_key,limit_id,slot,window_minutes,data)
             VALUES(?1,'codex',?2,'codex','secondary',10080,?3)",
            params![id, format!("account:{creator}"), data.to_string()],
        )
        .unwrap();
    }

    fn session(
        conn: &Connection,
        path: &str,
        session: &str,
        creator: Option<&str>,
        parent: Option<&str>,
    ) {
        let state = json!({"session":{"id":session,"parentId":parent},"quota_account_id":creator});
        conn.execute(
            "INSERT INTO monitor_files VALUES(?1,'codex',0,'fixture',?2)",
            params![path, state.to_string()],
        )
        .unwrap();
    }

    fn unverified_request(conn: &Connection, id: &str, session: &str, stamp: i64, cost: Value) {
        let usage = UsageRecord {
            id: id.into(),
            tool: "codex".into(),
            session_id: session.into(),
            timestamp_ms: stamp,
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 40,
            requested_mode: Some("fast".into()),
            mode_basis: "unknown".into(),
            ..Default::default()
        };
        conn.execute(
            "INSERT INTO monitor_requests VALUES('codex',?1,?2,?3,?4,?5)",
            params![
                id,
                format!("codex:{session}"),
                stamp,
                serde_json::to_string(&usage).unwrap(),
                cost.to_string()
            ],
        )
        .unwrap();
    }

    fn request(conn: &Connection, id: &str, session: &str, stamp: i64, cost: Value) {
        unverified_request(conn, id, session, stamp, cost);
        if let Some(creators) = session_creators(conn, None).unwrap().get(&("codex".into(), session.into())) {
            if let [creator] = creators.iter().collect::<Vec<_>>().as_slice() {
                prove_request(conn, id, creator);
            }
        }
    }

    fn prove_request(conn: &Connection, id: &str, account: &str) {
        let (session, time): (String, i64) = conn.query_row(
            "SELECT json_extract(usage,'$.sessionId'),timestamp_ms FROM monitor_requests WHERE tool='codex' AND id=?1",
            [id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        let model = format!("fixture-model:{id}");
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.model',?2) WHERE tool='codex' AND id=?1",
            params![id,model]).unwrap();
        conn.execute("INSERT INTO monitor_request_account_evidence
            SELECT 'account-period-fixture',COALESCE(MAX(log_id),0)+1,?1,?2,?3,NULL,?4,?4,100,20,40
            FROM monitor_request_account_evidence WHERE source='account-period-fixture'", params![session,account,model,time]).unwrap();
    }

    fn subscriptions(start: i64, end: Option<i64>) -> LocalSubscriptions {
        LocalSubscriptions {
            accounts: [(
                "account:a".into(),
                AccountSubscription {
                    start_ms: Some(start),
                    end_ms: end,
                    renewal_at_ms: None,
                    checked_at_ms: Some(start),
                    active: None,
                    billing_period: None,
                    source: "local_auth",
                    error: None,
                },
            )]
            .into(),
            error: None,
        }
    }

    #[test]
    fn local_cost_details_keep_account_models_api_and_cycles_isolated() {
        let conn=database();
        account(&conn,1,"a"); account(&conn,2,"b");
        session(&conn,"path-a","a",Some("a"),None);
        session(&conn,"path-b","b",Some("b"),None);
        for(id,session,time,model)in [("a-request","a",1000,"model-a"),("b-request","b",2000,"model-b"),("api-request","a",3000,"model-api")] {
            if id=="api-request" { unverified_request(&conn,id,session,time,json!({"usd":1,"evidence":{"currency":"USD","mode":"fast"}})); }
            else { request(&conn,id,session,time,json!({"usd":1,"evidence":{"currency":"USD","mode":"fast"}})); }
            conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.model',?2) WHERE id=?1",params![id,model]).unwrap();
            conn.execute("UPDATE monitor_request_account_evidence SET model=?2 WHERE model=?1", params![format!("fixture-model:{id}"),model]).unwrap();
        }
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope','api') WHERE id='api-request'",[]).unwrap();
        conn.execute("INSERT INTO monitor_account_cycles(tool,account_key,slot,window_minutes,start_ms,reset_ms,observed_ms,used_percent,attribution_verified) VALUES('codex','account:a','secondary',10080,0,10000,4000,20,1)",[]).unwrap();
        let ids=super::super::quota::account_report_identities(&conn,"codex").unwrap();
        let (rows,all,_)=local_cost_usage(&conn,0,5000).unwrap();
        let a=serde_json::to_value(rows.iter().find(|row|row.id==ids["account:a"].0).unwrap()).unwrap();
        let b=serde_json::to_value(rows.iter().find(|row|row.id==ids["account:b"].0).unwrap()).unwrap();
        let api=serde_json::to_value(rows.iter().find(|row|row.id=="api:all").unwrap()).unwrap();
        assert_eq!(a["analytics"]["models"][0]["model"],"model-a");
        assert_eq!(b["analytics"]["models"][0]["model"],"model-b");
        assert_eq!(api["analytics"]["models"][0]["model"],"model-api");
        assert_eq!(api["periods"],Value::Null);
        assert_eq!(a["periods"]["currentCycle"]["usedPercent"],20.);
        assert_eq!(a["periods"]["currentCycle"]["totals"]["requestCount"],1);
        assert_eq!(serde_json::to_value(all).unwrap()["totals"]["requestCount"],3);
    }

    fn observe(conn: &Connection, stamp: i64, reset: i64, used: f64) {
        observe_quota(
            conn,
            "codex",
            "account:a",
            "secondary",
            Some(10080),
            Some(stamp),
            Some(reset),
            Some(used),
        )
        .unwrap();
    }

    #[test]
    fn account_reports_use_the_same_private_identity_as_each_tools_quota_report() {
        let conn = database();
        let stamp = time("2026-11-06T00:00:00Z");
        for (tool, raw, label) in [("codex", "account:shared", None),
            ("claude", "cockpit:shared", Some("c***")),
            ("antigravity", "cockpit:shared", Some("a***"))] {
            let data = json!({"tool":tool,"account_key":raw,"account_label":label,
                "attribution":"account","limit_id":"model","slot":"primary",
                "window_minutes":300,"plan":null,"model_id":null,"pool_label":null,
                "observed_at_ms":stamp,"resets_at_ms":stamp+DAY,"used_percent":25,
                "source":"fixture","source_error":null,"stale_after_ms":300000});
            conn.execute("INSERT INTO monitor_quotas(tool,account_key,limit_id,slot,window_minutes,observed_ms,data)
                VALUES(?1,?2,'model','primary',300,?3,?4)", params![tool,raw,stamp,data.to_string()]).unwrap();
        }
        let quotas = super::super::quota::read(&conn, stamp).unwrap();
        let accounts = read(&conn, stamp-1, stamp, &LocalSubscriptions::default()).unwrap();
        assert_eq!(accounts.accounts.len(), 3);
        for account in accounts.accounts {
            let quota = quotas.quotas.iter().find(|row| row.tool == account.tool).unwrap();
            assert_eq!(account.account_key, quota.account_key);
            assert_eq!(account.account_label, quota.account_label);
            assert!(!account.account_key.contains("shared"));
        }
    }

    #[test]
    fn request_account_evidence_corrects_only_proven_rows_and_conserves_saved_amounts() {
        let conn = database();
        account(&conn,1,"creator");
        session(&conn,"old-chat","old-chat",Some("creator"),None);
        let start = time("2026-11-02T00:00:00Z");
        unverified_request(&conn,"matched","old-chat",start+1000,json!({"usd":3.0}));
        unverified_request(&conn,"unmatched","old-chat",start+3000,json!({"usd":2.0}));
        let before = read(&conn,start,start+5000,&LocalSubscriptions::default()).unwrap();
        assert_eq!(before.accounts[0].calendar_week.totals.priced_cost_usd,0.0);
        assert_eq!(before.accounts[0].creator_reference.calendar_week.totals.priced_cost_usd,5.0);
        assert_eq!(before.unassigned_week.priced_cost_usd,5.0);
        conn.execute("INSERT INTO monitor_request_account_evidence VALUES('fixture',1,'old-chat','account:actual','model',NULL,?1,?2,100,20,40)",
            params![start,start+2000]).unwrap();
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.model','model') WHERE id='matched'",[]).unwrap();
        let after = read(&conn,start,start+5000,&LocalSubscriptions::default()).unwrap();
        assert_eq!(after.accounts.len(),2);
        let actual = after.accounts.iter().find(|a| a.verified_week_requests==1).unwrap();
        assert_eq!(actual.calendar_week.totals.priced_cost_usd,3.0);
        assert_eq!(actual.creator_reference_week_requests,0);
        assert_eq!(actual.verified_history.as_ref().unwrap().totals.priced_cost_usd,3.0);
        let creator = after.accounts.iter().find(|a|a.creator_reference_week_requests==1).unwrap();
        assert_eq!(creator.calendar_week.totals.priced_cost_usd,0.0);
        assert_eq!(creator.creator_reference.calendar_week.totals.priced_cost_usd,2.0);
        assert_eq!(after.unassigned_week.priced_cost_usd,2.0);
        assert_eq!(after.accounts.iter().map(|a|a.calendar_week.totals.priced_cost_usd).sum::<f64>() + after.unassigned_week.priced_cost_usd,5.0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),2);
        let later = read(&conn,start+DAY,start+2*DAY,&LocalSubscriptions::default()).unwrap();
        let actual = later.accounts.iter().find(|account| account.verified_history.as_ref().is_some_and(|h|h.totals.request_count>0)).unwrap();
        assert_eq!(actual.calendar_week.totals.request_count,0);
        assert_eq!(actual.verified_history.as_ref().unwrap().totals.priced_cost_usd,3.0);
    }

    #[test]
    fn explicit_creators_deduplicate_files_keep_conflicts_unknown_and_do_not_inherit_parents() {
        let conn = database();
        account(&conn, 1, "a");
        account(&conn, 2, "b");
        session(&conn, "parent", "parent", Some("a"), None);
        session(&conn, "parent-copy", "parent", Some("a"), None);
        session(&conn, "child", "child", Some("b"), Some("parent"));
        session(
            &conn,
            "unknown-child",
            "unknown-child",
            None,
            Some("parent"),
        );
        session(&conn, "conflict-a", "conflict", Some("a"), None);
        session(&conn, "conflict-b", "conflict", Some("b"), None);
        let start = time("2026-10-19T00:00:00Z");
        for (id, session, stamp) in [
            ("parent", "parent", start),
            ("child", "child", start + 1),
            ("unknown", "unknown-child", start + 2),
            ("conflict", "conflict", start + 3),
            ("future", "parent", start + 100),
            ("before", "parent", start - 1),
        ] {
            unverified_request(&conn, id, session, stamp, json!({"usd":1.0}));
        }
        let report = read(&conn, start, start + 100, &LocalSubscriptions::default()).unwrap();
        assert_eq!(report.accounts.len(), 2);
        assert_eq!(report.accounts[0].calendar_week.totals.request_count, 0);
        assert_eq!(report.accounts[0].creator_reference.calendar_week.totals.request_count, 1);
        assert_eq!(report.accounts[1].calendar_week.totals.request_count, 0);
        assert_eq!(report.accounts[1].creator_reference.calendar_week.totals.request_count, 1);
        assert_eq!(report.unassigned_week.request_count, 4);
        assert!(report.accounts[0].account_key.starts_with("codex:account-"));
        assert_eq!(report.accounts[0].subscription.source, "none");
        assert!(report.accounts[0].subscription_month.is_none());
        assert!(report.accounts[0].previous_cycle.is_none());
        assert_eq!(report.accounts[0].calendar_week.totals.total_tokens, 0);
        assert_eq!(report.accounts[0].creator_reference.calendar_week.totals.total_tokens, 120);
        assert_eq!((report.unassigned_week.total_tokens, report.unassigned_week.priced_cost_usd), (480, 4.0));
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["accounts"][0]["attribution"], "session_creator");
        assert_eq!(json["accounts"][0]["billingAccountVerified"], false);
        assert!(json["accounts"][0]["previousCycle"].is_null());
        assert!(json.to_string().find("account:a").is_none());
    }

    #[test]
    fn api_account_is_a_cross_tool_summary_not_a_quota_account_or_an_additional_global_charge() {
        let conn=database();
        let month=time("2026-11-01T00:00:00+08:00");
        let week=month-4*DAY;
        let now=month+DAY;
        for(id,tool,at,scope,cost)in [
            ("old-api","codex",month-DAY,Some("api"),10.),
            ("codex-api","codex",month+100,Some("api"),20.),
            ("claude-api","claude",month+200,Some("api"),30.),
            ("subscription","codex",month+300,Some("subscription"),100.),
            ("unknown","claude",month+400,None,200.),
        ]{
            let usage=UsageRecord{id:id.into(),tool:tool.into(),session_id:"s".into(),timestamp_ms:at,billing_scope:scope.map(str::to_owned),..Default::default()};
            conn.execute("INSERT INTO monitor_requests VALUES(?1,?2,?3,?4,?5,?6)",params![tool,id,format!("{tool}:s"),at,serde_json::to_string(&usage).unwrap(),json!({"usd":cost}).to_string()]).unwrap();
        }
        let api=read_api_usage(&conn,week,now,Some(month)).unwrap().unwrap();
        assert_eq!((api.week.totals.request_count,api.week.totals.priced_cost_usd),(3,60.));
        assert_eq!((api.month.as_ref().unwrap().totals.request_count,api.month.as_ref().unwrap().totals.priced_cost_usd),(2,50.));
        assert_eq!(api.month.as_ref().unwrap().start_ms,month);
        let report=read(&conn,week,now,&LocalSubscriptions::default()).unwrap();
        assert!(report.accounts.is_empty());
        assert_eq!((report.unassigned_week.request_count,report.unassigned_week.priced_cost_usd),(2,300.));
        assert_eq!(report.api_usage.as_ref().unwrap().week.totals.priced_cost_usd,60.);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_quotas",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(read_api_usage(&conn,now,now+DAY,None).unwrap().unwrap().week.totals.request_count,0);
        assert!(read_api_usage(&database(),week,now,Some(month)).unwrap().is_none());
    }

    #[test]
    fn proven_upstream_accounts_own_api_calls_without_adding_the_api_activity_subtotal_twice() {
        let conn=database();
        account(&conn,1,"a");
        account(&conn,2,"actual");
        session(&conn,"history","reused",Some("a"),None);
        let start=time("2026-11-01T00:00:00Z");
        for (id,amount) in [("subscription",7.),("api",50.),("proven-api",3.),("legacy",2.)] {
            if id=="api" || id=="proven-api" { unverified_request(&conn,id,"reused",start+1000,json!({"usd":amount})); }
            else { request(&conn,id,"reused",start+1000,json!({"usd":amount})); }
        }
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope',CASE id WHEN 'subscription' THEN 'subscription' ELSE 'api' END) WHERE id!='legacy'",[]).unwrap();
        conn.execute("INSERT INTO monitor_codex_quota_accounts VALUES('fixture',?1,'pro','account:actual',?2,2)",params![start+WEEK,start]).unwrap();
        conn.execute("INSERT INTO monitor_request_quota_evidence VALUES('proven-api','fixture',?1,'pro')",[start+WEEK]).unwrap();
        observe(&conn,start+2000,start+WEEK,20.);
        let report=read(&conn,start,start+3000,&subscriptions(start,Some(start+30*DAY))).unwrap();
        let creator=&report.accounts[0];
        assert_eq!(creator.calendar_week.totals.priced_cost_usd,9.);
        assert_eq!(creator.subscription_month.as_ref().unwrap().totals.priced_cost_usd,9.);
        assert_eq!(creator.current_cycle.as_ref().unwrap().period.totals.priced_cost_usd,9.);
        assert_eq!(report.accounts[1].calendar_week.totals.priced_cost_usd,3.);
        assert_eq!((report.unassigned_week.request_count,report.unassigned_week.priced_cost_usd),(0,0.));
        let api=&report.api_usage.as_ref().unwrap().week.totals;
        assert_eq!((api.request_count,api.priced_cost_usd),(2,53.));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_request_quota_evidence",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),4);
        let requests=conn.prepare("SELECT usage FROM monitor_requests").unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().map(|r|serde_json::from_str::<UsageRecord>(&r.unwrap()).unwrap()).collect::<Vec<_>>();
        let memberships=request_memberships(&conn,&requests).unwrap();
        assert_eq!(memberships.iter().find(|(_,id,_)|id=="proven-api").unwrap().2,super::super::quota::report_account_key("codex","account:actual"));
        assert_eq!(memberships.iter().filter(|(_,_,key)|key=="api:all").count(),1);
        assert_eq!(report.accounts.iter().map(|a|a.calendar_week.totals.priced_cost_usd).sum::<f64>()+report.unassigned_week.priced_cost_usd+50.,62.);
    }

    #[test]
    fn reset_boundaries_ignore_duplicate_slots_out_of_order_and_nonweekly_windows() {
        let conn = database();
        let start = time("2026-10-01T00:00:00Z");
        observe(&conn, start + DAY, start + WEEK, 50.);
        observe_quota(
            &conn,
            "codex",
            "account:a",
            "primary",
            Some(10080),
            Some(start + DAY),
            Some(start + 8 * DAY),
            Some(0.),
        )
        .unwrap();
        observe_quota(
            &conn,
            "codex",
            "account:a",
            "secondary",
            Some(300),
            Some(start + 2 * DAY),
            Some(start + 2 * DAY + 1000),
            Some(0.),
        )
        .unwrap();
        observe(&conn, start + 2 * DAY, start + WEEK, 70.);
        observe(&conn, start + 2 * DAY, start + 8 * DAY, 0.);
        observe(&conn, start + DAY + 1, start + 8 * DAY, 0.);
        // A known new seven-day start after the prior observation is the exact boundary.
        observe(&conn, start + 3 * DAY, start + 10 * DAY, 1.);
        // A same-reset return to zero does not establish a new window.
        observe(&conn, start + 4 * DAY, start + 10 * DAY, 0.);
        // A delayed observation can still identify the preceding reset's exact start.
        observe(&conn, start + 11 * DAY, start + 17 * DAY, 2.);
        let rows = conn.prepare(
            "SELECT start_ms,COALESCE(end_ms,reset_ms),observed_ms FROM monitor_account_cycles ORDER BY start_ms",
        ).unwrap().query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?)))
            .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0], (start, start + 3 * DAY, start + 2 * DAY));
        assert_eq!(rows[1].0, start + 3 * DAY);
        assert_eq!(rows[1].1, start + 10 * DAY);
        assert_eq!(rows[2].0, start + 10 * DAY);
        assert!(rows.windows(2).all(|rows| rows[0].1 == rows[1].0));
        assert!(rows.iter().all(|(start, end, _)| start < end));
    }

    #[test]
    fn quota_usage_corrections_and_same_window_zeros_keep_saved_usage_in_the_same_cycle() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-10-18T00:00:00Z");
        let reset = start + WEEK;
        let now = start + 5 * DAY;
        request(&conn, "before-dip", "a", start + DAY, json!({"usd":1.}));
        request(&conn, "after-dip", "a", start + 3 * DAY, json!({"usd":2.}));
        for (offset, used) in [
            (DAY, 8.),
            (2 * DAY, 7.),
            (2 * DAY + 1, 0.),
            (3 * DAY, 1.),
            (3 * DAY + 1, 0.),
            (4 * DAY, 1.),
            (4 * DAY + 1, 8.),
        ] {
            let observed = start + offset;
            observe(&conn, observed, reset, used);
            let latest = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
            assert_eq!(
                (latest.start, latest.reset, latest.observed, latest.used),
                (start, reset, observed, Some(used))
            );
            assert!(latest.end.is_none());
            let report = read(&conn, start, now, &subscriptions(start, None)).unwrap();
            let account = &report.accounts[0];
            let cycle = account.current_cycle.as_ref().unwrap();
            assert_eq!(cycle.period.start_ms, start);
            assert_eq!(cycle.period.end_ms, reset);
            assert_eq!(cycle.used_percent, Some(used));
            assert_eq!(cycle.period.totals.request_count, 2);
            assert_eq!(cycle.period.totals.priced_cost_usd, 3.);
            assert_eq!(account.month_cycles.len(), 1);
            assert_eq!(account.month_cycles[0].period.totals.priced_cost_usd, 3.);
            assert_eq!(account.unsegmented_month.request_count, 0);
        }
    }

    #[test]
    fn observed_october_reset_rejects_old_window_updates_and_keeps_same_window_zeros_together() {
        let conn = database();
        session(&conn, "a", "a", Some("a"), None);
        let start = 1_792_782_076_000;
        let old_observed = 1_792_908_632_176;
        let boundary = 1_792_908_633_000;
        let reset = 1_793_513_433_000;
        observe(&conn, old_observed, 1_793_386_876_000, 31.);
        let mut accepted_observed = old_observed;
        for (observed, next_reset, used, accepted) in [
            (1_792_908_693_732, reset, 0., true),
            (1_792_908_703_803, 1_793_513_494_000, 0., true),
            (1_792_908_712_447, 1_793_386_876_000, 31., false),
            (1_792_908_716_636, 1_793_387_064_000, 30., false),
            (1_792_908_736_960, 1_793_513_494_000, 0., true),
            (1_792_909_057_724, 1_793_513_494_000, 1., true),
            (1_792_909_058_924, 1_793_513_494_000, 0., true),
            (1_792_909_120_464, 1_793_513_494_000, 1., true),
            (1_792_909_122_624, 1_793_513_494_000, 0., true),
            (1_792_909_132_650, 1_793_513_494_000, 1., true),
        ] {
            let payload = json!({"plan_type":"pro","rate_limit":{"primary_window":{
                "limit_window_seconds":604800,"reset_at":next_reset / 1000,"used_percent":used}}});
            super::super::quota::save_authenticated_codex(&conn, "a", &payload, observed).unwrap();
            if accepted {
                accepted_observed = observed;
            }
            let cycle = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
            assert_eq!((cycle.start, cycle.reset), (boundary, reset));
            assert_eq!(cycle.observed, accepted_observed);
            assert_eq!(cycle.exhausted, None);
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row
                    .get::<_, i64>(0))
                    .unwrap(),
                2
            );
        }

        // A later stale-window 100% must remain raw evidence, not exhaust the new round.
        let stale_observed = accepted_observed + 1_000;
        let payload = json!({"plan_type":"pro","rate_limit":{"primary_window":{
            "limit_window_seconds":604800,"reset_at":1793386876i64,"used_percent":100.}}});
        super::super::quota::save_authenticated_codex(&conn, "a", &payload, stale_observed).unwrap();
        let cycle = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!(
            (cycle.observed, cycle.used, cycle.exhausted),
            (accepted_observed, Some(1.), None)
        );
        let raw: (i64, f64) = conn.query_row(
            "SELECT observed_ms,json_extract(data,'$.used_percent') FROM monitor_quotas WHERE slot='primary'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(raw, (stale_observed, 100.));

        for (id, stamp, amount) in [
            ("old-round", boundary - 1, 1.),
            ("new-start", boundary, 2.),
            ("new-later", accepted_observed, 4.),
        ] {
            request(&conn, id, "a", stamp, json!({"usd":amount}));
        }
        let report = read(
            &conn,
            start,
            stale_observed + 1,
            &subscriptions(start, None),
        )
        .unwrap();
        let account = &report.accounts[0];
        assert_eq!(account.quota_cycles.len(), 2);
        assert_eq!(
            account
                .current_cycle
                .as_ref()
                .unwrap()
                .period
                .totals
                .priced_cost_usd,
            6.
        );
        let previous = account.previous_cycle.as_ref().unwrap();
        assert_eq!(
            (
                previous.period.end_ms,
                previous.quota_observed_at_ms,
                previous.used_percent
            ),
            (boundary, old_observed, Some(31.))
        );
        assert_eq!(previous.period.totals.priced_cost_usd, 1.);
        assert_eq!(
            account
                .subscription_month
                .as_ref()
                .unwrap()
                .totals
                .priced_cost_usd,
            7.
        );
        assert_eq!(
            account
                .month_cycles
                .iter()
                .map(|cycle| cycle.period.totals.priced_cost_usd)
                .sum::<f64>(),
            7.
        );
    }

    #[test]
    fn predecessor_evidence_floor_rejects_old_windows_but_allows_backward_clock_corrections() {
        let conn = database();
        let start = time("2026-10-01T00:00:00Z");
        observe(&conn, start + DAY, start + WEEK, 80.);
        observe(&conn, start + 3 * DAY, start + 10 * DAY, 5.);
        // This inferred start is before the current canonical start but above the prior evidence.
        observe(&conn, start + 4 * DAY, start + 9 * DAY, 6.);
        for reset in [start + 8 * DAY, start + WEEK] {
            observe(&conn, start + 5 * DAY, reset, 100.);
            let cycle = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
            assert_eq!(
                (cycle.start, cycle.reset),
                (start + 3 * DAY, start + 10 * DAY)
            );
            assert_eq!(
                (cycle.observed, cycle.used, cycle.exhausted),
                (start + 4 * DAY, Some(6.), None)
            );
        }
        observe(&conn, start + 6 * DAY, start + 9 * DAY, 7.);
        let cycle = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!(
            (cycle.observed, cycle.used, cycle.exhausted),
            (start + 6 * DAY, Some(7.), None)
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn legacy_same_window_fragment_remains_updateable_without_a_proven_predecessor_floor() {
        let conn = database();
        let reset = 1_793_513_494_000;
        for (start, end, observed, used) in [
            (
                1_792_909_058_924i64,
                Some(1_792_909_122_624i64),
                1_792_909_120_464i64,
                1.,
            ),
            (1_792_909_122_624, None, 1_792_909_122_624, 0.),
        ] {
            conn.execute(
                "INSERT INTO monitor_account_cycles(tool,account_key,slot,window_minutes,start_ms,end_ms,reset_ms,observed_ms,used_percent,attribution_verified)
                 VALUES('codex','account:a','primary',10080,?1,?2,?3,?4,?5,1)",
                params![start, end, reset, observed, used],
            ).unwrap();
        }
        let observed = 1_792_909_132_650;
        observe(&conn, observed, reset - 61_000, 27.);
        let cycle = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!((cycle.start, cycle.reset), (1_792_909_122_624, reset));
        assert_eq!(
            (cycle.observed, cycle.used, cycle.exhausted),
            (observed, Some(27.), None)
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn reset_time_jitter_preserves_the_canonical_cycle_and_saved_usage() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-10-18T00:00:00Z");
        let reset = start + WEEK;
        let now = start + 5 * DAY;
        request(&conn, "before-jitter", "a", start + DAY, json!({"usd":1.}));
        request(
            &conn,
            "after-jitter",
            "a",
            start + 3 * DAY,
            json!({"usd":2.}),
        );
        observe(&conn, start + DAY, reset, 8.);
        for (offset, jitter, used) in [
            (2 * DAY, 2_000, 8.),
            (3 * DAY, -2_000, 8.),
            (4 * DAY, 60_000, 8.),
            (4 * DAY + 1, 60_001, 8.),
            (4 * DAY + 2, 229_000, 9.),
            (4 * DAY + 3, 300_000, 9.),
            (4 * DAY + 4, 300_001, 9.),
            (4 * DAY + 5, 3_600_000, 8.),
            (4 * DAY + 6, -3_600_000, 10.),
        ] {
            observe(&conn, start + offset, reset + jitter, used);
            let latest = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
            assert_eq!((latest.start, latest.reset), (start, reset));
            let report = read(&conn, start, now, &subscriptions(start, None)).unwrap();
            let account = &report.accounts[0];
            let cycle = account.current_cycle.as_ref().unwrap();
            assert_eq!((cycle.period.start_ms, cycle.reset_at_ms), (start, reset));
            assert_eq!(cycle.period.totals.priced_cost_usd, 3.);
            assert_eq!(account.month_cycles.len(), 1);
            assert_eq!(account.month_cycles[0].period.totals.priced_cost_usd, 3.);
            assert_eq!(
                account
                    .subscription_month
                    .as_ref()
                    .unwrap()
                    .totals
                    .priced_cost_usd,
                3.
            );
        }
        let changed_at = start + 6 * DAY;
        observe(&conn, changed_at, changed_at + WEEK, 9.);
        let latest = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!(
            (latest.start, latest.reset),
            (changed_at, changed_at + WEEK)
        );
    }

    #[test]
    fn expired_clock_drift_preserves_evidence_for_the_next_confirmed_round() {
        let start = time("2026-10-18T00:00:00Z");
        let reset = start + WEEK;
        for expired_used in [9., 0.] {
            let conn = database();
            observe(&conn, start + DAY, reset, 8.);
            observe(&conn, reset + 100_000, reset + 229_000, expired_used);
            let previous = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
            assert_eq!(
                (previous.start, previous.reset, previous.observed, previous.used, previous.exhausted),
                (start, reset, start + DAY, Some(8.), None)
            );
            assert!(!previous.is_current(reset + 100_000));

            observe(&conn, reset + 240_000, reset + WEEK, 1.);
            let next = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
            assert_eq!(
                (next.start, next.reset, next.observed, next.used),
                (reset, reset + WEEK, reset + 240_000, Some(1.))
            );
            assert_eq!(
                conn.query_row(
                    "SELECT end_ms FROM monitor_account_cycles WHERE id=?1",
                    [previous.id],
                    |row| row.get::<_, i64>(0),
                ).unwrap(),
                reset
            );
            assert_eq!(
                conn.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row.get::<_, i64>(0)).unwrap(),
                2
            );
        }
    }

    #[test]
    fn unknown_quota_snapshot_does_not_hide_a_later_confirmed_early_reset() {
        let conn = database();
        let start = time("2026-10-18T00:00:00Z");
        let reset = start + WEEK;
        observe(&conn, start + DAY, reset, 8.);
        observe_quota(
            &conn,
            "codex",
            "account:a",
            "primary",
            Some(10080),
            Some(start + 3 * DAY),
            Some(start + 9 * DAY),
            None,
        ).unwrap();
        let previous = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!(
            (previous.start, previous.reset, previous.observed, previous.used, previous.exhausted),
            (start, reset, start + DAY, Some(8.), None)
        );
        assert_eq!(
            conn.query_row("SELECT slot FROM monitor_account_cycles WHERE id=?1", [previous.id], |row| row.get::<_, String>(0)).unwrap(),
            "secondary"
        );

        observe(&conn, start + 3 * DAY + 1, start + 9 * DAY, 1.);
        let next = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!(
            (next.start, next.reset, next.observed, next.used),
            (start + 2 * DAY, start + 9 * DAY, start + 3 * DAY + 1, Some(1.))
        );
        assert_eq!(
            conn.query_row(
                "SELECT end_ms FROM monitor_account_cycles WHERE id=?1",
                [previous.id],
                |row| row.get::<_, i64>(0),
            ).unwrap(),
            start + 2 * DAY
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row.get::<_, i64>(0)).unwrap(),
            2
        );
    }

    #[test]
    fn reset_window_identity_not_clock_shift_or_usage_corrections_defines_a_new_cycle() {
        let start = time("2026-10-18T00:00:00Z");
        let reset = start + WEEK;
        for (case, observed, shift, old_used, used, boundary) in [
            (
                "returned_to_zero",
                start + 2 * DAY,
                0,
                Some(8.),
                Some(0.),
                None,
            ),
            (
                "decreased",
                start + 2 * DAY,
                60_001,
                Some(8.),
                Some(7.),
                None,
            ),
            (
                "unknown_new",
                start + 2 * DAY,
                3_600_000,
                Some(8.),
                None,
                None,
            ),
            (
                "unknown_old",
                start + 2 * DAY,
                3_600_000,
                None,
                Some(9.),
                None,
            ),
            (
                "expired_clock_only",
                reset + 1,
                229_000,
                Some(8.),
                Some(9.),
                None,
            ),
            (
                "new_window_increasing",
                start + 3 * DAY,
                2 * DAY,
                Some(8.),
                Some(9.),
                None,
            ),
            (
                "new_window_unknown",
                start + 3 * DAY,
                2 * DAY,
                None,
                None,
                None,
            ),
            (
                "new_window_decreasing",
                start + 3 * DAY,
                2 * DAY,
                Some(8.),
                Some(7.),
                Some(start + 2 * DAY),
            ),
            (
                "natural_week",
                reset + DAY,
                WEEK,
                Some(8.),
                Some(9.),
                Some(reset),
            ),
            (
                "natural_week_unknown",
                reset + DAY,
                WEEK,
                None,
                None,
                Some(reset),
            ),
        ] {
            let conn = database();
            for (stamp, next_reset, next_used) in [
                (start + DAY, reset, old_used),
                (observed, reset + shift, used),
            ] {
                observe_quota(
                    &conn,
                    "codex",
                    "account:a",
                    "secondary",
                    Some(10080),
                    Some(stamp),
                    Some(next_reset),
                    next_used,
                )
                .unwrap();
            }
            let rows = conn
                .prepare(
                    "SELECT start_ms,end_ms,reset_ms FROM monitor_account_cycles ORDER BY start_ms",
                )
                .unwrap()
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            let expected = if let Some(boundary) = boundary {
                vec![
                    (start, Some(boundary.min(reset)), reset),
                    (boundary, None, reset + shift),
                ]
            } else {
                vec![(start, None, reset)]
            };
            assert_eq!(rows, expected, "{case}");
            if case == "expired_clock_only" {
                assert!(!latest_cycle(&conn, "codex", "account:a")
                    .unwrap()
                    .unwrap()
                    .is_current(observed));
            }
        }
    }

    #[test]
    fn reset_clock_bounce_near_week_start_needs_replenishment_evidence() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-10-18T00:00:00Z");
        let reset = start + WEEK;
        request(&conn, "before-bounce", "a", start + 1, json!({"usd":1.}));
        request(
            &conn,
            "after-bounce",
            "a",
            start + 245_000,
            json!({"usd":2.}),
        );
        for (offset, shift, used) in [(10_000, 0, 1.), (240_000, 229_000, 1.), (250_000, 0, 2.)] {
            let observed = start + offset;
            observe(&conn, observed, reset + shift, used);
            let report = read(&conn, start, observed + 1, &subscriptions(start, None)).unwrap();
            let account = &report.accounts[0];
            assert_eq!(account.quota_cycles.len(), 1);
            let cycle = account.current_cycle.as_ref().unwrap();
            assert_eq!((cycle.period.start_ms, cycle.reset_at_ms), (start, reset));
            assert_eq!(cycle.quota_observed_at_ms, observed);
            assert_eq!(cycle.used_percent, Some(used));
            assert_eq!(
                cycle.period.totals.priced_cost_usd,
                if offset >= 245_000 { 3. } else { 1. }
            );
        }
    }

    #[test]
    fn observed_october_reset_clock_bounce_keeps_the_complete_weekly_round() {
        let conn = database();
        account(&conn, 2, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = 1_792_782_076_000;
        let reset = 1_793_386_876_000;
        for (id, stamp, amount) in [
            ("before-bounce", start + 1, 1.),
            ("during-bounce", 1_792_859_218_055, 2.),
            ("after-bounce", 1_792_859_250_939, 4.),
        ] {
            request(&conn, id, "a", stamp, json!({"usd":amount}));
        }
        for (observed, next_reset, used) in [
            (1_792_859_188_273, reset, 1.),
            (1_792_859_218_055, 1_793_387_273_000, 1.),
            (1_792_859_250_939, reset, 1.),
            (1_792_861_665_043, reset, 2.),
        ] {
            observe(&conn, observed, next_reset, used);
            let report = read(&conn, start, observed + 1, &subscriptions(start, None)).unwrap();
            let account = &report.accounts[0];
            assert_eq!(account.quota_cycles.len(), 1);
            let cycle = account.current_cycle.as_ref().unwrap();
            assert_eq!((cycle.period.start_ms, cycle.reset_at_ms), (start, reset));
            assert_eq!(cycle.quota_observed_at_ms, observed);
            assert_eq!(cycle.used_percent, Some(used));
        }
        let report = read(&conn, start, 1_792_861_665_044, &subscriptions(start, None)).unwrap();
        let account = &report.accounts[0];
        let cycle = account.current_cycle.as_ref().unwrap();
        assert_eq!(
            (
                cycle.period.totals.request_count,
                cycle.period.totals.priced_cost_usd
            ),
            (3, 7.)
        );
        assert_eq!(account.month_cycles.len(), 1);
        assert_eq!(account.month_cycles[0].period.totals.priced_cost_usd, 7.);
        assert_eq!(
            serde_json::to_value(cycle).unwrap()["quotaObservedAtMs"],
            1_792_861_665_043_i64
        );
    }

    #[test]
    fn legacy_exhausted_usage_has_unknown_quota_boundary_but_stays_in_the_month_once() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "s", "s", Some("a"), None);
        let start = time("2026-10-01T00:00:00Z");
        observe(&conn, start + DAY, start + WEEK, 100.);
        for (id, stamp, amount) in [
            ("included", start + DAY, 2.),
            ("credits-period", start + 2 * DAY, 3.),
        ] {
            request(
                &conn,
                id,
                "s",
                stamp,
                json!({"usd":amount,"evidence":{"currency":"USD","mode":"fast"}}),
            );
        }
        for (offset, used) in [(2 * DAY, 99.), (3 * DAY, 100.)] {
            observe(&conn, start + offset, start + WEEK + 3_600_000, used);
            let report = read(
                &conn,
                start,
                start + offset + 1,
                &subscriptions(start, None),
            )
            .unwrap();
            let cycle = report.accounts[0].current_cycle.as_ref().unwrap();
            assert!(cycle.exhaustion_unknown);
            assert_eq!(
                (
                    cycle.period.observed_end_ms,
                    cycle.period.totals.request_count
                ),
                (start, 0)
            );
            assert_eq!(cycle.exhausted_at_ms, None);
        }
        let report = read(&conn, start, start + 4 * DAY, &subscriptions(start, None)).unwrap();
        let account = &report.accounts[0];
        let month = &account.subscription_month.as_ref().unwrap().totals;
        assert_eq!(month.request_count, 2);
        assert_eq!(
            month.automatic_price_summary.by_currency["USD"].requested_subtotal,
            5.
        );
        let cycle = account.current_cycle.as_ref().unwrap();
        assert!(cycle.exhaustion_unknown);
        assert_eq!(cycle.exhausted_at_ms, None);
        assert_eq!(cycle.period.observed_end_ms, start);
        assert_eq!(cycle.period.totals.request_count, 0);
        assert_eq!(account.quota_cycles.len(), 1);
        assert_eq!(
            account
                .month_cycles
                .iter()
                .map(|cycle| cycle.period.totals.request_count)
                .sum::<i64>()
                + account.unsegmented_month.request_count,
            2
        );
        let json = serde_json::to_value(cycle).unwrap();
        assert_eq!(json["exhaustionUnknown"], true);
        assert!(json["exhaustedAtMs"].is_null());

        let next = start + 4 * DAY;
        observe(&conn, next, next + WEEK, 0.);
        let fresh = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!((fresh.start, fresh.exhausted), (next, None));
        observe(&conn, next + 1_000, next + WEEK, 100.);
        request(&conn, "fresh-100", "s", next + 1_000, json!({"usd":7.}));
        request(&conn, "fresh-credit", "s", next + 1_001, json!({"usd":11.}));
        let report = read(&conn, start, next + 2_000, &subscriptions(start, None)).unwrap();
        let account = &report.accounts[0];
        let cycle = account.current_cycle.as_ref().unwrap();
        assert!(!cycle.exhaustion_unknown);
        assert_eq!(cycle.exhausted_at_ms, Some(next + 1_000));
        assert_eq!(cycle.period.totals.priced_cost_usd, 7.);
        assert!(account.previous_cycle.as_ref().unwrap().exhaustion_unknown);
        assert_eq!(
            account
                .subscription_month
                .as_ref()
                .unwrap()
                .totals
                .priced_cost_usd,
            23.
        );
    }

    #[test]
    fn proven_reset_card_anchors_the_current_cycle_without_claiming_an_old_unknown_week(){
        let conn=database();account(&conn,1,"a");session(&conn,"a","a",Some("a"),None);
        let inferred=time("2026-11-16T01:48:56Z");
        let redeemed=inferred-42_000;
        observe(&conn,inferred+DAY,inferred+WEEK,20.);
        request(&conn,"after-card-before-inferred-start","a",redeemed+1000,json!({"usd":3.}));
        assert!(record_upstream_reset(&conn,"account:a","sub2api","audit-1",redeemed).unwrap());
        assert!(!record_upstream_reset(&conn,"account:a","sub2api","audit-1",redeemed).unwrap());
        let report=read(&conn,inferred,inferred+2*DAY,&LocalSubscriptions::default()).unwrap();
        let cycle=report.accounts[0].current_cycle.as_ref().unwrap();
        assert_eq!((cycle.period.start_ms,cycle.period.totals.priced_cost_usd),(redeemed,3.));
        record_upstream_reset(&conn,"account:a","sub2api","unobserved-old-week",redeemed-2*WEEK).unwrap();
        assert_eq!(latest_cycle(&conn,"codex","account:a").unwrap().unwrap().start,redeemed);
        let pending=database();account(&pending,1,"a");
        record_upstream_reset(&pending,"account:a","sub2api","arrived-before-quota",redeemed).unwrap();
        observe(&pending,inferred+DAY,inferred+WEEK,20.);
        assert!(apply_saved_resets(&pending,"account:a").unwrap());
        assert_eq!(latest_cycle(&pending,"codex","account:a").unwrap().unwrap().start,redeemed);
    }

    #[test]
    fn calendar_month_keeps_pre_reset_usage_when_subscription_dates_are_unreported(){
        let conn=database();account(&conn,1,"a");session(&conn,"a","a",Some("a"),None);
        let start=time("2026-11-01T00:00:00Z");
        let reset_card=start+DAY;
        let now=reset_card+2*DAY;
        observe(&conn,reset_card+DAY,reset_card+WEEK,20.);
        request(&conn,"before-card","a",start+DAY/2,json!({"usd":5.}));
        request(&conn,"after-card","a",reset_card+DAY,json!({"usd":3.}));
        let report=read_with_usage(&conn,reset_card,now,&LocalSubscriptions::default(),Some(start),|_,_,_,_|{}).unwrap();
        let account=&report.accounts[0];
        assert!(account.subscription_month.is_none());
        assert_eq!(account.calendar_month.as_ref().unwrap().totals.priced_cost_usd,8.);
        assert_eq!(account.month_cycles.len(),1);
        assert_eq!(account.month_cycles[0].period.totals.priced_cost_usd,3.);
        assert_eq!(account.unsegmented_month.priced_cost_usd,5.);
        assert_eq!(account.unsegmented_month.request_count,1);
        assert_eq!(account.month_cycles.iter().map(|cycle|cycle.period.totals.priced_cost_usd).sum::<f64>()+account.unsegmented_month.priced_cost_usd,8.);
    }

    #[test]
    fn quota_snapshot_pairs_amount_with_inclusive_observation_without_freezing_live_totals() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-10-01T00:00:00Z");
        let observed = start + DAY;
        observe(&conn, observed, start + WEEK, 20.);
        for (id, stamp, amount) in [
            ("before", observed - 1, 1.),
            ("at-quota", observed, 2.),
            ("after-quota", observed + 1, 4.),
            ("at-now", observed + 10, 8.),
        ] {
            request(&conn, id, "a", stamp, json!({"usd":amount}));
        }
        let report = read(&conn, start, observed + 10, &subscriptions(start, None)).unwrap();
        let account = &report.accounts[0];
        let cycle = account.current_cycle.as_ref().unwrap();
        let snapshot = cycle.quota_snapshot.as_ref().unwrap();
        assert_eq!(
            (snapshot.start_ms, snapshot.end_ms, snapshot.observed_end_ms),
            (start, start + WEEK, observed + 1)
        );
        assert_eq!(
            (
                snapshot.totals.request_count,
                snapshot.totals.priced_cost_usd
            ),
            (2, 3.)
        );
        assert_eq!(
            (
                cycle.period.totals.request_count,
                cycle.period.totals.priced_cost_usd
            ),
            (3, 7.)
        );
        assert_eq!(account.calendar_week.totals.priced_cost_usd, 7.);
        assert_eq!(
            account
                .subscription_month
                .as_ref()
                .unwrap()
                .totals
                .priced_cost_usd,
            7.
        );
        assert_eq!(account.month_cycles[0].period.totals.priced_cost_usd, 7.);
        assert!(account.month_cycles[0].quota_snapshot.is_none());
        let json = serde_json::to_value(cycle).unwrap();
        assert_eq!(json["quotaSnapshot"]["observedEndMs"], observed + 1);
        assert_eq!(json["quotaSnapshot"]["totals"]["requestCount"], 2);

        let capped = read(&conn, start, observed, &subscriptions(start, None)).unwrap();
        let capped_cycle = capped.accounts[0]
            .current_cycle
            .as_ref()
            .unwrap();
        assert!(capped_cycle.quota_snapshot.is_none());
        assert_eq!((capped_cycle.period.observed_end_ms,capped_cycle.period.totals.priced_cost_usd),(observed,1.));

        let historical = read(&conn, start, observed - 1, &subscriptions(start, None)).unwrap();
        assert!(historical.accounts[0].current_cycle.as_ref().unwrap().quota_snapshot.is_none());

        observe(&conn, observed + 5, start + WEEK, 20.);
        let newer = read(&conn, start, observed + 10, &subscriptions(start, None)).unwrap();
        let snapshot = newer.accounts[0]
            .current_cycle
            .as_ref()
            .unwrap()
            .quota_snapshot
            .as_ref()
            .unwrap();
        assert_eq!(
            (snapshot.observed_end_ms, snapshot.totals.priced_cost_usd),
            (observed + 6, 7.)
        );
    }

    #[test]
    fn first_exhausted_request_is_included_but_later_credits_only_remain_in_the_month() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-10-01T00:00:00Z");
        let reset = start + WEEK;
        let exhausted = start + 2 * DAY;
        let next = start + 4 * DAY;
        observe(&conn, start + DAY, reset, 20.);
        observe(&conn, exhausted, reset, 100.);
        observe(&conn, start + 3 * DAY, reset + 3_600_000, 100.);
        for (id, stamp, amount) in [
            ("before", start + DAY, 1.),
            ("first-100", exhausted, 2.),
            ("credit", exhausted + 1, 4.),
            ("repeated-100", start + 3 * DAY, 8.),
            ("late-credit", next - 1, 16.),
        ] {
            request(&conn, id, "a", stamp, json!({"usd":amount}));
        }
        let first = read(&conn, start, next, &subscriptions(start, None)).unwrap();
        let account = &first.accounts[0];
        let cycle = account.current_cycle.as_ref().unwrap();
        assert_eq!(
            (cycle.exhausted_at_ms, cycle.period.observed_end_ms),
            (Some(exhausted), exhausted + 1)
        );
        assert_eq!(
            (
                cycle.period.totals.request_count,
                cycle.period.totals.priced_cost_usd
            ),
            (2, 3.)
        );
        assert_eq!(
            account
                .subscription_month
                .as_ref()
                .unwrap()
                .totals
                .priced_cost_usd,
            31.
        );
        assert_eq!(account.month_cycles[0].period.totals.priced_cost_usd, 31.);
        let snapshot = cycle.quota_snapshot.as_ref().unwrap();
        assert_eq!(
            (snapshot.observed_end_ms, snapshot.totals.priced_cost_usd),
            (exhausted + 1, 3.)
        );

        observe(&conn, next, next + WEEK, 0.);
        let reset_cycle = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!((reset_cycle.start, reset_cycle.exhausted), (next, None));
        observe(&conn, next + 1_000, next + WEEK, 100.);
        for (id, stamp, amount) in [
            ("next-start", next, 32.),
            ("next-100", next + 1_000, 64.),
            ("next-credit", next + 1_001, 128.),
        ] {
            request(&conn, id, "a", stamp, json!({"usd":amount}));
        }
        let second = read(&conn, start, next + 2_000, &subscriptions(start, None)).unwrap();
        let account = &second.accounts[0];
        assert_eq!(account.quota_cycles.len(), 2);
        let current = account.current_cycle.as_ref().unwrap();
        let previous = account.previous_cycle.as_ref().unwrap();
        assert_eq!(
            (current.period.start_ms, current.exhausted_at_ms),
            (next, Some(next + 1_000))
        );
        assert_eq!(current.period.totals.priced_cost_usd, 96.);
        assert_eq!(
            (
                previous.period.start_ms,
                previous.period.end_ms,
                previous.exhausted_at_ms
            ),
            (start, next, Some(exhausted))
        );
        assert_eq!(previous.period.totals.priced_cost_usd, 3.);
        let month = &account.subscription_month.as_ref().unwrap().totals;
        assert_eq!((month.request_count, month.priced_cost_usd), (8, 255.));
        assert_eq!(
            account
                .month_cycles
                .iter()
                .map(|cycle| cycle.period.totals.priced_cost_usd)
                .sum::<f64>(),
            255.
        );
    }

    #[test]
    fn quota_history_is_full_newest_first_and_current_previous_reuse_finished_totals() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-09-20T00:00:00Z");
        let now = start + 16 * DAY;
        for (offset, used) in [(0, 50.), (WEEK, 40.), (2 * WEEK, 20.)] {
            observe(&conn, start + offset + DAY, start + offset + WEEK, used);
        }
        for (id, offset, cost) in [
            ("oldest", 2 * DAY, json!({"usd":1.})),
            ("previous", 9 * DAY, json!({"cny":2.})),
            ("current", 15 * DAY, json!({"usd":3.})),
            ("at-report-now", 16 * DAY, json!({"usd":999.})),
        ] {
            request(&conn, id, "a", start + offset, cost);
        }
        conn.execute(
            "UPDATE monitor_account_cycles SET observed_ms=?1 WHERE start_ms=?2",
            params![now + 1, start + 2 * WEEK],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO monitor_account_cycles(tool,account_key,slot,window_minutes,start_ms,reset_ms,observed_ms,used_percent,attribution_verified)
             VALUES('codex','account:a','secondary',10080,?1,?2,?1,10,1),
                   ('codex','account:a','secondary',10080,?3,?4,0,10,1)",
            params![now + DAY, now + WEEK, start - 2 * WEEK, start - WEEK],
        ).unwrap();
        let report = read(
            &conn,
            start + 14 * DAY,
            now,
            &subscriptions(start + 14 * DAY, None),
        )
        .unwrap();
        let account = &report.accounts[0];
        assert_eq!(
            account
                .quota_cycles
                .iter()
                .map(|cycle| (cycle.period.start_ms, cycle.period.end_ms))
                .collect::<Vec<_>>(),
            vec![
                (start + 2 * WEEK, start + 3 * WEEK),
                (start + WEEK, start + 2 * WEEK),
                (start, start + WEEK),
            ]
        );
        assert_eq!(
            account
                .quota_cycles
                .iter()
                .map(|cycle| (
                    cycle.period.totals.priced_cost_usd,
                    cycle.period.totals.priced_cost_cny
                ))
                .collect::<Vec<_>>(),
            vec![(3., 0.), (0., 2.), (1., 0.)]
        );
        assert_eq!(
            serde_json::to_value(&account.current_cycle).unwrap(),
            serde_json::to_value(&account.quota_cycles[0]).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&account.previous_cycle).unwrap(),
            serde_json::to_value(&account.quota_cycles[1]).unwrap()
        );
        assert_eq!(
            account
                .subscription_month
                .as_ref()
                .unwrap()
                .totals
                .priced_cost_usd,
            3.
        );
    }

    #[test]
    fn exhausted_column_migration_is_additive_idempotent_and_does_not_guess_legacy_cutoffs() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE monitor_account_cycles (
               id INTEGER PRIMARY KEY,tool TEXT NOT NULL,account_key TEXT NOT NULL,
               slot TEXT NOT NULL,window_minutes INTEGER NOT NULL,
               start_ms INTEGER NOT NULL,end_ms INTEGER,reset_ms INTEGER NOT NULL,
               observed_ms INTEGER NOT NULL,used_percent REAL,
               UNIQUE(tool,account_key,start_ms));",
        )
        .unwrap();
        let start = time("2026-10-01T00:00:00Z");
        conn.execute(
            "INSERT INTO monitor_account_cycles VALUES(9,'codex','account:a','primary',10080,?1,NULL,?2,?3,100)",
            params![start, start + WEEK, start + DAY],
        ).unwrap();
        store::initialize(&conn).unwrap();
        initialize(&conn).unwrap();
        assert!(latest_cycle(&conn, "codex", "account:a").unwrap().is_none());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_account_cycles WHERE id=9 AND attribution_verified=0", [], |r| r.get::<_,i64>(0)).unwrap(), 1);
        // This test now supplies independent provenance before testing the old
        // exhaustion migration; initialization itself must never assume it.
        conn.execute("UPDATE monitor_account_cycles SET attribution_verified=1 WHERE id=9", []).unwrap();
        let cycle = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!(
            (
                cycle.id,
                cycle.start,
                cycle.reset,
                cycle.observed,
                cycle.used,
                cycle.exhausted
            ),
            (9, start, start + WEEK, start + DAY, Some(100.), None)
        );
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('monitor_account_cycles') WHERE name='exhausted_ms'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        for (offset, used) in [(2 * DAY, 99.), (3 * DAY, 100.)] {
            observe(&conn, start + offset, start + WEEK, used);
            let updated = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
            assert_eq!(updated.exhausted, Some(0));
            let report = updated.quota_report(start + offset + 1);
            assert!(report.exhaustion_unknown);
            assert_eq!(
                (report.period.observed_end_ms, report.exhausted_at_ms),
                (start, None)
            );
        }
        let report = cycle.quota_report(start + 3 * DAY);
        assert!(report.exhaustion_unknown);
        assert_eq!(
            (report.period.observed_end_ms, report.exhausted_at_ms),
            (start, None)
        );
    }

    #[test]
    fn subscription_dates_survive_account_switches_without_storing_credentials() {
        let conn = database();
        account(&conn, 1, "a");
        let start = time("2026-10-01T00:00:00Z");
        let current = subscriptions(start, Some(start + 60 * DAY));
        save_subscription_dates(&conn, &current).unwrap();
        save_subscription_dates(&conn, &LocalSubscriptions::default()).unwrap();
        let report = read(
            &conn,
            start,
            start + 2 * DAY,
            &LocalSubscriptions::default(),
        )
        .unwrap();
        assert_eq!(report.accounts[0].subscription.start_ms, Some(start));
        assert!(report.accounts[0].subscription_month.is_some());
        let mut missing_fields = subscriptions(start, None);
        missing_fields
            .accounts
            .get_mut("account:a")
            .unwrap()
            .start_ms = None;
        save_subscription_dates(&conn, &missing_fields).unwrap();
        assert_eq!(
            read(&conn, start, start + 2 * DAY, &missing_fields)
                .unwrap()
                .accounts[0]
                .subscription
                .start_ms,
            Some(start)
        );
        let json: String = conn
            .query_row(
                "SELECT data FROM monitor_state WHERE key='account_subscription:account:a'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 3);
        assert!(value.get("startMs").is_some());
        assert!(value.get("id_token").is_none());
    }

    #[test]
    fn current_account_tracks_live_auth_instead_of_cached_subscription_dates() {
        let conn = database();
        account(&conn, 1, "a");
        account(&conn, 2, "b");
        let start = time("2026-10-01T00:00:00Z");
        let mut live = subscriptions(start, None);
        save_subscription_dates(&conn, &live).unwrap();
        let identities = super::super::quota::account_report_identities(&conn, "codex").unwrap();
        let report = read(&conn, start, start + DAY, &live).unwrap();
        assert_eq!(report.current_account_key.as_deref(), Some(identities["account:a"].0.as_str()));

        let mut switched = live.accounts.remove("account:a").unwrap();
        switched.start_ms = None;
        switched.error = Some("Invalid local subscription date metadata".into());
        live.accounts.insert("account:b".into(), switched);
        let report = read(&conn, start, start + DAY, &live).unwrap();
        assert_eq!(report.current_account_key.as_deref(), Some(identities["account:b"].0.as_str()));
        assert_eq!(report.accounts[0].subscription.source, "local_auth");
        assert!(report.accounts[0].subscription_month.is_some());
        assert!(report.accounts[1].subscription.error.is_some());
        let output = serde_json::to_value(report).unwrap();
        assert_eq!(output["currentAccountKey"], identities["account:b"].0);
        let output = output.to_string();
        for raw_account in ["account:a", "account:b"] {
            assert!(!output.contains(raw_account));
        }
    }

    #[test]
    fn current_account_is_unknown_without_unambiguous_available_live_codex_auth() {
        let conn = database();
        account(&conn, 1, "a");
        account(&conn, 2, "b");
        account(&conn, 3, "c");
        conn.execute("UPDATE monitor_quotas SET tool='claude' WHERE id=3", [])
            .unwrap();
        let start = time("2026-10-01T00:00:00Z");
        save_subscription_dates(&conn, &subscriptions(start, None)).unwrap();
        for (keys, error) in [
            (vec![], None),
            (vec!["account:a", "account:b"], None),
            (vec!["account:a"], Some("Local auth could not be read")),
            (vec!["account:c"], None),
            (vec!["account:missing"], None),
        ] {
            let live = LocalSubscriptions {
                accounts: keys
                    .into_iter()
                    .map(|key| {
                        (
                            key.into(),
                            AccountSubscription {
                                source: "local_auth",
                                ..Default::default()
                            },
                        )
                    })
                    .collect(),
                error: error.map(str::to_owned),
            };
            let report = read(&conn, start, start + DAY, &live).unwrap();
            assert!(report.current_account_key.is_none());
            assert!(serde_json::to_value(report).unwrap()["currentAccountKey"].is_null());
        }
    }

    #[test]
    fn weekly_window_can_move_slots_without_stopping_cycle_collection() {
        let conn = database();
        let start = time("2026-10-01T00:00:00Z");
        observe(&conn, start + DAY, start + WEEK, 100.);
        observe_quota(
            &conn,
            "codex",
            "account:a",
            "primary",
            Some(10080),
            Some(start + 2 * DAY),
            Some(start + 9 * DAY),
            Some(0.),
        )
        .unwrap();
        // The same snapshot's other window must not count as a second reset.
        observe(&conn, start + 2 * DAY, start + 9 * DAY, 0.);
        observe_quota(
            &conn,
            "codex",
            "account:a",
            "secondary",
            Some(300),
            Some(start + 3 * DAY),
            Some(start + 3 * DAY + 1000),
            Some(2.),
        )
        .unwrap();
        let latest = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!(latest.start, start + 2 * DAY);
        assert_eq!(latest.reset, start + 9 * DAY);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn initialization_seeds_only_the_latest_missing_account_snapshot() {
        let conn = database();
        account(&conn, 1, "a");
        let observed = time("2026-10-20T00:00:00Z");
        let reset = observed + 3 * DAY;
        conn.execute(
            "UPDATE monitor_quotas SET observed_ms=?1,data=?2 WHERE id=1",
            params![
                observed,
                json!({"attribution":"account","billing_account_verified":true,"source":"codex_official_usage","resets_at_ms":reset,"used_percent":25.})
                    .to_string()
            ],
        )
        .unwrap();
        initialize(&conn).unwrap();
        let first = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!((first.start, first.reset), (reset - WEEK, reset));
        conn.execute(
            "UPDATE monitor_quotas SET observed_ms=?1,data=json_set(data,'$.used_percent',0)",
            [observed + 1],
        )
        .unwrap();
        initialize(&conn).unwrap();
        let unchanged = latest_cycle(&conn, "codex", "account:a").unwrap().unwrap();
        assert_eq!(
            (first.id, first.observed, first.used),
            (unchanged.id, unchanged.observed, unchanged.used)
        );
        let tx = conn.unchecked_transaction().unwrap();
        observe(&tx, observed + 2, reset, 30.);
        tx.commit().unwrap();
        assert_eq!(
            latest_cycle(&conn, "codex", "account:a")
                .unwrap()
                .unwrap()
                .used,
            Some(30.)
        );
    }

    #[test]
    fn missed_resets_leave_the_unobserved_gap_unsegmented() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-10-01T00:00:00Z");
        observe(&conn, start + DAY, start + WEEK, 20.);
        observe(&conn, start + 23 * DAY, start + 28 * DAY, 30.);
        for (id, offset, amount) in [
            ("old", 2 * DAY, 1.),
            ("gap", 14 * DAY, 2.),
            ("new", 22 * DAY, 3.),
        ] {
            request(&conn, id, "a", start + offset, json!({"usd":amount}));
        }
        let report = read(
            &conn,
            start + 25 * DAY,
            start + 26 * DAY,
            &subscriptions(start, None),
        )
        .unwrap();
        let account = &report.accounts[0];
        assert_eq!(account.month_cycles.len(), 2);
        assert_eq!(account.month_cycles[0].period.end_ms, start + WEEK);
        assert_eq!(account.month_cycles[1].period.start_ms, start + 21 * DAY);
        assert_eq!(account.month_cycles[0].period.totals.priced_cost_usd, 1.);
        assert_eq!(account.month_cycles[1].period.totals.priced_cost_usd, 3.);
        assert_eq!(account.unsegmented_month.priced_cost_usd, 2.);
        assert_eq!(
            account
                .subscription_month
                .as_ref()
                .unwrap()
                .totals
                .priced_cost_usd,
            6.
        );
    }

    #[test]
    fn official_renewal_keeps_the_accounts_full_billing_month_across_sign_in_changes() {
        let conn=database();
        account(&conn,1,"a");
        account(&conn,2,"b");
        session(&conn,"pro","pro",Some("a"),None);
        session(&conn,"other","other",Some("b"),None);
        let now=time("2026-11-07T00:00:00Z");
        let old=subscriptions(time("2026-09-05T16:14:06Z"),Some(time("2026-11-08T06:41:12Z")));
        save_subscription_dates(&conn,&old).unwrap();
        request(&conn,"earlier-month","pro",time("2026-10-08T06:41:11Z"),json!({"usd":999.}));
        request(&conn,"pro-previous-weeks","pro",time("2026-10-20T00:00:00Z"),json!({"usd":11000.}));
        request(&conn,"pro-this-week","pro",now-1000,json!({"usd":58.}));
        request(&conn,"different-account","other",now-1000,json!({"usd":777.}));
        let payload=json!({"accounts":{"a":{"account":{"account_id":"a"},"entitlement":{
            "has_active_subscription":true,"billing_period":"monthly","renews_at":"2026-11-08T06:41:12Z"}}}});
        assert!(save_official_subscription(&conn,"b",&payload,now).is_err());
        save_official_subscription(&conn,"a",&payload,now).unwrap();
        assert!(!subscription_check_due(&conn,"a",now+1000).unwrap());
        let live=LocalSubscriptions {accounts:[("account:b".into(),AccountSubscription::default())].into(),error:None};
        let report=read(&conn,now-DAY,now,&live).unwrap();
        assert_eq!(report.current_account_key.as_ref(),Some(&report.accounts[1].account_key));
        let pro=&report.accounts[0];
        let month=pro.subscription_month.as_ref().unwrap();
        assert_eq!((month.start_ms,month.end_ms),(time("2026-10-08T06:41:12Z"),time("2026-11-08T06:41:12Z")));
        assert_eq!(month.totals.request_count,2);
        assert_eq!(month.totals.priced_cost_usd,11058.);
        assert_eq!(pro.subscription.source,"official");
        assert_eq!(pro.unsegmented_month.priced_cost_usd,11058.);
        let ended=read(&conn,now,now+3*DAY,&live).unwrap();
        assert_eq!(ended.accounts[0].subscription_month.as_ref().unwrap().totals.priced_cost_usd,11058.);
        let renewed=json!({"accounts":{"a":{"account":{"account_id":"a"},"entitlement":{
            "has_active_subscription":true,"billing_period":"monthly","renews_at":"2026-12-08T06:41:12Z"}}}});
        save_official_subscription(&conn,"a",&renewed,now+3*DAY).unwrap();
        let renewed_report=read(&conn,now,now+3*DAY,&live).unwrap();
        assert_eq!(renewed_report.accounts[0].subscription_month.as_ref().unwrap().start_ms,time("2026-11-08T06:41:12Z"));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),4);
    }

    #[test]
    fn month_end_anchors_do_not_drift_and_expiry_is_half_open() {
        for year in [2024, 2025] {
            let feb_days = if year == 2024 { 29 } else { 28 };
            for day in [25, 28, 29, 30, 31] {
                let start = time(&format!("{year}-01-{day:02}T12:34:56Z"));
                let sub = subscriptions(start, None)
                    .accounts
                    .remove("account:a")
                    .unwrap();
                assert_eq!(
                    subscription_month(&sub, time(&format!("{year}-03-01T00:00:00Z"))),
                    Some((
                        time(&format!("{year}-02-{:02}T12:34:56Z", day.min(feb_days))),
                        time(&format!("{year}-03-{day:02}T12:34:56Z")),
                    ))
                );
                assert_eq!(
                    subscription_month(&sub, time(&format!("{year}-03-{day:02}T12:34:56Z"))),
                    Some((
                        time(&format!("{year}-03-{day:02}T12:34:56Z")),
                        time(&format!("{year}-04-{:02}T12:34:56Z", day.min(30))),
                    ))
                );
                assert_eq!(subscription_month(&sub, start - 1), None);
            }
        }
        let anchor = time("2025-01-31T00:00:00Z");
        for expiry in ["2025-02-15T00:00:00Z", "2025-03-31T00:00:00Z"] {
            let expiry = time(expiry);
            let sub = subscriptions(anchor, Some(expiry))
                .accounts
                .remove("account:a")
                .unwrap();
            let expected_start = if expiry < time("2025-02-28T00:00:00Z") {
                anchor
            } else {
                time("2025-02-28T00:00:00Z")
            };
            assert_eq!(
                subscription_month(&sub, expiry),
                Some((expected_start, expiry))
            );
            assert_eq!(
                subscription_month(&sub, expiry + 60 * DAY),
                Some((expected_start, expiry))
            );
        }
        let invalid = subscriptions(anchor, Some(anchor))
            .accounts
            .remove("account:a")
            .unwrap();
        assert_eq!(subscription_month(&invalid, anchor), None);
    }

    #[test]
    fn month_cycles_and_unsegmented_amounts_conserve_saved_prices_after_early_resets() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-10-01T00:00:00Z");
        let now = start + 26 * DAY;
        let subscriptions = subscriptions(start, Some(start + 31 * DAY));
        for (id, offset, cost) in [
            (
                "unsegmented",
                DAY,
                json!({"usd":1.,"evidence":{"mode":"fast"}}),
            ),
            ("first", 12 * DAY, json!({"cny":2.})),
            (
                "second",
                15 * DAY,
                json!({"scenarios":[
                    {"mode":"standard","amount":3.,"evidence":{"currency":"USD"}},
                    {"mode":"fast","amount":6.,"evidence":{"currency":"USD"}}
                ]}),
            ),
            (
                "unknown",
                16 * DAY,
                json!({"usd":null,"reason":"model_unknown"}),
            ),
            (
                "third",
                17 * DAY,
                json!({"usd":4.,"evidence":{"mode":"fast"}}),
            ),
            ("after", 24 * DAY, json!({"cny":5.})),
            ("future", 26 * DAY, json!({"usd":999.})),
            ("before", -1, json!({"usd":999.})),
        ] {
            request(&conn, id, "a", start + offset, cost);
        }
        conn.execute(
            "UPDATE monitor_requests SET usage=json_set(usage,'$.mode','fast','$.modeBasis','response_reported')
             WHERE id IN ('unsegmented','third')",
            [],
        ).unwrap();
        let before = read(&conn, start + 18 * DAY, now, &subscriptions).unwrap();
        let before_total = serde_json::to_value(
            &before.accounts[0]
                .subscription_month
                .as_ref()
                .unwrap()
                .totals,
        )
        .unwrap();
        observe(&conn, start + 14 * DAY, start + 19 * DAY, 70.);
        observe(&conn, start + 15 * DAY, start + 22 * DAY, 1.);
        observe(&conn, start + 17 * DAY, start + 24 * DAY, 0.);
        let after = read(&conn, start + 18 * DAY, now, &subscriptions).unwrap();
        let account = &after.accounts[0];
        let month = &account.subscription_month.as_ref().unwrap().totals;
        assert_eq!(serde_json::to_value(month).unwrap(), before_total);
        assert_eq!(month.request_count, 6);
        assert_eq!((month.priced_cost_usd, month.priced_cost_cny), (5., 7.));
        assert_eq!(month.unpriced_requests, 2);
        assert_eq!(
            month.automatic_price_summary.by_currency["USD"].requested_subtotal,
            6.
        );
        assert_eq!(
            month.automatic_price_summary.by_currency["USD"].response_subtotal,
            5.
        );
        assert_eq!(account.month_cycles.len(), 3);
        assert_eq!(
            account
                .month_cycles
                .iter()
                .map(|cycle| cycle.period.totals.request_count)
                .collect::<Vec<_>>(),
            vec![1, 2, 1]
        );
        assert_eq!(account.unsegmented_month.request_count, 2);
        assert!(account.current_cycle.is_none());
        let mut parts = account.unsegmented_month.clone();
        for cycle in &account.month_cycles {
            store::merge_totals(&mut parts, &cycle.period.totals);
        }
        store::finish_totals(&mut parts);
        assert_eq!(
            serde_json::to_value(parts).unwrap(),
            serde_json::to_value(month).unwrap()
        );
    }

    #[test]
    fn current_cycle_is_complete_not_limited_to_the_calendar_week_or_month() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-09-28T00:00:00Z");
        let now = start + 5 * DAY;
        observe(&conn, start + DAY, start + WEEK, 20.);
        request(&conn, "before-month", "a", start + DAY, json!({"usd":1.}));
        request(&conn, "in-month", "a", start + 4 * DAY, json!({"usd":2.}));
        let report = read(
            &conn,
            start + 4 * DAY,
            now,
            &subscriptions(start + 3 * DAY, None),
        )
        .unwrap();
        let account = &report.accounts[0];
        assert!(account.previous_cycle.is_none());
        let cycle = account.current_cycle.as_ref().unwrap();
        assert_eq!(cycle.period.start_ms, start);
        assert_eq!(cycle.period.end_ms, start + WEEK);
        assert_eq!(cycle.period.observed_end_ms, now);
        assert_eq!(cycle.period.totals.priced_cost_usd, 3.);
        assert_eq!(account.calendar_week.totals.priced_cost_usd, 2.);
        assert_eq!(
            account
                .subscription_month
                .as_ref()
                .unwrap()
                .totals
                .priced_cost_usd,
            2.
        );
        assert_eq!(account.month_cycles[0].period.start_ms, start + 3 * DAY);
        let json = serde_json::to_value(cycle).unwrap();
        assert!(json.get("period").is_none());
        assert_eq!(json["startMs"], start);
    }

    #[test]
    fn previous_cycle_keeps_full_cross_month_totals_and_excludes_the_early_reset_boundary() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-09-28T00:00:00Z");
        let boundary = start + 5 * DAY;
        let now = boundary + DAY;
        observe(&conn, start + DAY, start + WEEK, 70.);
        observe(&conn, boundary, boundary + WEEK, 0.);
        for (id, stamp, amount) in [
            ("before", start - 1, 999.),
            ("start", start, 1.),
            ("before-month", start + 2 * DAY, 2.),
            ("last", boundary - 1, 4.),
            ("boundary", boundary, 8.),
            ("future", now, 999.),
        ] {
            request(&conn, id, "a", stamp, json!({"usd":amount}));
        }
        let report = read(&conn, boundary, now, &subscriptions(start + 3 * DAY, None)).unwrap();
        let account = &report.accounts[0];
        let previous = account.previous_cycle.as_ref().unwrap();
        assert_eq!(
            (
                previous.period.start_ms,
                previous.period.end_ms,
                previous.period.observed_end_ms
            ),
            (start, boundary, boundary)
        );
        assert_eq!(
            (
                previous.reset_at_ms,
                previous.used_percent,
                previous.current
            ),
            (start + WEEK, Some(70.), false)
        );
        assert_eq!(
            (
                previous.period.totals.request_count,
                previous.period.totals.priced_cost_usd
            ),
            (3, 7.)
        );
        assert_eq!(
            account
                .current_cycle
                .as_ref()
                .unwrap()
                .period
                .totals
                .priced_cost_usd,
            8.
        );
        assert_eq!(account.calendar_week.totals.priced_cost_usd, 8.);
        assert_eq!(
            account
                .subscription_month
                .as_ref()
                .unwrap()
                .totals
                .priced_cost_usd,
            12.
        );
        assert_eq!(account.month_cycles[0].period.start_ms, start + 3 * DAY);
        let json = serde_json::to_value(account).unwrap();
        assert_eq!(json["previousCycle"]["startMs"], start);
        assert!(json["previousCycle"].get("period").is_none());
    }

    #[test]
    fn previous_cycle_includes_the_latest_naturally_expired_round_without_subscription_dates() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let start = time("2026-09-20T00:00:00Z");
        let reset = start + WEEK;
        observe(&conn, start - 6 * DAY, start, 90.);
        observe(&conn, start + DAY, reset, 20.);
        request(&conn, "older-round", "a", start - DAY, json!({"usd":999.}));
        request(&conn, "previous", "a", start, json!({"usd":2.}));
        request(&conn, "boundary", "a", reset, json!({"usd":999.}));
        for now in [reset, time("2026-10-20T00:00:00Z")] {
            let report = read(&conn, now - DAY, now, &LocalSubscriptions::default()).unwrap();
            let account = &report.accounts[0];
            assert!(account.subscription_month.is_none());
            assert!(account.month_cycles.is_empty());
            assert!(account.current_cycle.is_none());
            let previous = account.previous_cycle.as_ref().unwrap();
            assert_eq!(
                (previous.period.start_ms, previous.period.end_ms),
                (start, reset)
            );
            assert_eq!(previous.period.observed_end_ms, reset);
            assert!(!previous.current);
            assert_eq!(
                (
                    previous.period.totals.request_count,
                    previous.period.totals.priced_cost_usd
                ),
                (1, 2.)
            );
        }
    }

    #[test]
    fn previous_cycle_reuses_saved_native_currencies_and_references_for_each_session_creator() {
        let conn = database();
        account(&conn, 1, "a");
        account(&conn, 2, "b");
        session(&conn, "a", "a", Some("a"), None);
        session(&conn, "a-copy", "a", Some("a"), None);
        session(&conn, "b", "b", Some("b"), Some("a"));
        let start = time("2026-09-20T00:00:00Z");
        observe(&conn, start + DAY, start + WEEK, 50.);
        observe_quota(
            &conn,
            "codex",
            "account:b",
            "secondary",
            Some(10080),
            Some(start + 2 * DAY),
            Some(start + 8 * DAY),
            Some(80.),
        )
        .unwrap();
        for (id, session, cost) in [
            (
                "response",
                "a",
                json!({"usd":1.,"evidence":{"mode":"fast"}}),
            ),
            ("reference", "a", json!({"cny":2.})),
            (
                "scenario",
                "a",
                json!({"scenarios":[
                    {"mode":"standard","amount":3.,"evidence":{"currency":"USD"}},
                    {"mode":"fast","amount":6.,"evidence":{"currency":"USD"}}
                ]}),
            ),
            ("unknown", "a", json!({"usd":null,"reason":"model_unknown"})),
            ("other-account", "b", json!({"usd":9.})),
        ] {
            request(&conn, id, session, start + 2 * DAY, cost);
        }
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.mode','fast','$.modeBasis','response_reported') WHERE id='response'", []).unwrap();
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.requestedMode',NULL) WHERE id='reference'", []).unwrap();
        let report = read(
            &conn,
            start + 8 * DAY,
            start + 9 * DAY,
            &LocalSubscriptions::default(),
        )
        .unwrap();
        let a = &report.accounts[0]
            .previous_cycle
            .as_ref()
            .unwrap()
            .period
            .totals;
        let b = &report.accounts[1]
            .previous_cycle
            .as_ref()
            .unwrap()
            .period
            .totals;
        assert_eq!(
            (a.request_count, a.priced_cost_usd, a.priced_cost_cny),
            (4, 1., 2.)
        );
        assert_eq!(
            (a.unpriced_requests, a.scenario_requests, a.total_tokens),
            (2, 1, 480)
        );
        assert_eq!(
            a.automatic_price_summary.by_currency["USD"].response_subtotal,
            1.
        );
        assert_eq!(
            a.automatic_price_summary.by_currency["USD"].requested_subtotal,
            6.
        );
        assert_eq!(
            a.automatic_price_summary.by_currency["CNY"].unknown_reference_subtotal,
            2.
        );
        assert_eq!(
            (b.request_count, b.priced_cost_usd, b.priced_cost_cny),
            (1, 9., 0.)
        );
    }

    #[test]
    fn local_subscriptions_use_home_only_and_preserve_profile_and_codex_home_precedence() {
        let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let root = std::env::temp_dir().join(format!(
            "ledger-subscription-paths-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let home = root.join("home");
        let profile = root.join("profile");
        let codex = root.join("custom-codex");
        let write_auth = |base: &std::path::Path, account: &str, checked: i64| {
            std::fs::create_dir_all(base).unwrap();
            let payload = json!({"https://api.openai.com/auth":{
                "chatgpt_account_id":account,
                "chatgpt_subscription_active_start":"2026-10-01T00:00:00Z",
                "chatgpt_subscription_last_checked":checked
            }});
            let encoded = URL_SAFE_NO_PAD.encode(payload.to_string());
            std::fs::write(base.join("auth.json"), json!({"tokens":{"id_token":format!("header.{encoded}.signature")}}).to_string()).unwrap();
        };
        write_auth(&home.join(".codex"), "home", 1_792_368_000);
        write_auth(&profile.join(".codex"), "profile", 1_792_368_000);
        write_auth(&codex, "profile", 1_792_368_001);
        let _home = crate::EnvGuard::set("HOME", &home);
        let profile_guard = crate::EnvGuard::remove("USERPROFILE");
        let codex_guard = crate::EnvGuard::remove("CODEX_HOME");
        let result = read_local_subscriptions();
        assert!(result.error.is_none());
        assert_eq!(result.accounts.keys().map(String::as_str).collect::<Vec<_>>(), ["account:home"]);
        drop(profile_guard);
        let _profile = crate::EnvGuard::set("USERPROFILE", &profile);
        let result = read_local_subscriptions();
        assert_eq!(result.accounts.keys().map(String::as_str).collect::<Vec<_>>(), ["account:profile"]);
        drop(codex_guard);
        let _codex = crate::EnvGuard::set("CODEX_HOME", &codex);
        assert_eq!(read_local_subscriptions().accounts["account:profile"].checked_at_ms, Some(1_792_368_001_000));
        write_auth(&codex, "profile", 1_792_367_999);
        assert_eq!(read_local_subscriptions().accounts["account:profile"].checked_at_ms, Some(1_792_368_000_000));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_auth_matches_only_native_account_and_never_infers_start_from_expiry() {
        let payload = json!({"email":"secret@example.invalid","https://api.openai.com/auth":{
            "chatgpt_account_id":"a",
            "chatgpt_subscription_active_start":"2026-10-01T00:00:00Z",
            "chatgpt_subscription_active_until":"2026-11-01T00:00:00Z",
            "chatgpt_subscription_last_checked":1_792_368_000,
        }});
        let encoded = URL_SAFE_NO_PAD.encode(payload.to_string());
        let bytes = json!({"tokens":{"id_token":format!("header.{encoded}.signature"),"access_token":"access-secret","refresh_token":"refresh-secret"}}).to_string();
        let (key, subscription) = decode_subscription(bytes.as_bytes()).unwrap().unwrap();
        assert_eq!(key, "account:a");
        assert_eq!(subscription.source, "local_auth");
        assert_eq!(subscription.start_ms, Some(time("2026-10-01T00:00:00Z")));
        assert_eq!(subscription.checked_at_ms, Some(1_792_368_000_000));
        let conn = database();
        account(&conn, 1, "a");
        account(&conn, 2, "b");
        let sources = LocalSubscriptions {
            accounts: [(key, subscription)].into(),
            error: None,
        };
        let report = read(
            &conn,
            time("2026-10-19T00:00:00Z"),
            time("2026-10-20T00:00:00Z"),
            &sources,
        )
        .unwrap();
        assert_eq!(report.accounts[0].subscription.source, "local_auth");
        assert_eq!(report.accounts[1].subscription.source, "none");
        assert!(report.accounts[1].subscription_month.is_none());
        let output = serde_json::to_string(&report).unwrap();
        for secret in [
            "secret@example.invalid",
            "access-secret",
            "refresh-secret",
            &encoded,
            "account:a",
        ] {
            assert!(!output.contains(secret));
        }
        let encoded = URL_SAFE_NO_PAD.encode(
            json!({"https://api.openai.com/auth":{
                "chatgpt_account_id":"a","chatgpt_subscription_active_until":"2026-11-01T00:00:00Z"
            }})
            .to_string(),
        );
        let bytes =
            json!({"tokens":{"id_token":format!("header.{encoded}.signature")}}).to_string();
        let (_, subscription) = decode_subscription(bytes.as_bytes()).unwrap().unwrap();
        assert!(subscription.start_ms.is_none());
        assert!(subscription_month(&subscription, time("2026-10-20T00:00:00Z")).is_none());
    }

    #[test]
    fn expired_month_reads_only_its_range_and_week_not_the_intervening_history() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "a", "a", Some("a"), None);
        let expiry = time("2025-02-15T00:00:00Z");
        let now = time("2026-10-20T00:00:00Z");
        let week = time("2026-10-19T00:00:00Z");
        request(&conn, "history", "a", expiry - 1, json!({"usd":2.}));
        request(&conn, "expired-boundary", "a", expiry, json!({"usd":999.}));
        request(&conn, "week", "a", week, json!({"cny":3.}));
        conn.execute(
            "INSERT INTO monitor_requests VALUES('codex','gap','codex:a',?1,'{}','{}')",
            [time("2025-06-01T00:00:00Z")],
        )
        .unwrap();
        let report = read(
            &conn,
            week,
            now,
            &subscriptions(time("2025-01-31T00:00:00Z"), Some(expiry)),
        )
        .unwrap();
        let account = &report.accounts[0];
        let month = account.subscription_month.as_ref().unwrap();
        assert_eq!(month.end_ms, expiry);
        assert_eq!(month.observed_end_ms, expiry);
        assert_eq!(month.totals.priced_cost_usd, 2.);
        assert_eq!(month.totals.request_count, 1);
        assert_eq!(account.calendar_week.totals.priced_cost_cny, 3.);
        let history = account.verified_history.as_ref().unwrap();
        assert_eq!(history.totals.request_count, 3);
        assert_eq!((history.totals.priced_cost_usd, history.totals.priced_cost_cny), (1001., 3.));
    }

    #[test]
    #[ignore = "Requires explicit ledger-audit-work.sqlite and read-only source copy"]
    fn reconcile_explicit_account_copies() {
        let copy = PathBuf::from(std::env::var_os("MONITOR_ACCOUNT_REPAIR_COPY").unwrap()).canonicalize().unwrap();
        assert_eq!(copy.file_name().unwrap(), "ledger-audit-work.sqlite");
        if let Ok(live) = crate::ledger_db::ledger_db_path() {
            if let Ok(live) = live.canonicalize() { assert_ne!(copy,live); }
        }
        let source_path = PathBuf::from(std::env::var_os("MONITOR_ACCOUNT_SOURCE_COPY").unwrap());
        let source = Connection::open_with_flags(&source_path,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut conn = Connection::open_with_flags(&copy,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        super::super::request_accounts::initialize(&conn).unwrap();
        let now: i64 = conn.query_row("SELECT MAX(timestamp_ms)+1 FROM monitor_requests",[],|r|r.get(0)).unwrap();
        let before = read(&conn,0,now,&LocalSubscriptions::default()).unwrap();
        super::super::request_accounts::collect_from(&mut conn,&source,&source_path.to_string_lossy(),now).unwrap();
        let evidence = super::super::request_accounts::EvidenceIndex::load(&conn).unwrap();
        let creators = session_creators(&conn,None).unwrap();
        let mut verified = 0;
        let mut reassigned = 0;
        let mut newly_attributed = 0;
        let mut already_correct = 0;
        let mut conflicts = 0;
        let mut statement = conn.prepare("SELECT usage FROM monitor_requests WHERE tool='codex'").unwrap();
        for row in statement.query_map([],|r|r.get::<_,String>(0)).unwrap() {
            let usage: UsageRecord = serde_json::from_str(&row.unwrap()).unwrap();
            match evidence.account_for(&usage) {
                super::super::request_accounts::AccountMatch::Verified(account) => {
                    verified+=1;
                    match creators.get(&(usage.tool,usage.session_id)).filter(|owners| owners.len()==1) {
                        Some(owners) if !owners.contains(account) => reassigned+=1,
                        Some(_) => already_correct+=1,
                        None => newly_attributed+=1,
                    }
                },
                super::super::request_accounts::AccountMatch::Conflict => conflicts+=1,
                _ => (),
            }
        }
        let after = read(&conn,0,now,&LocalSubscriptions::default()).unwrap();
        let total = |report: &AccountUsageReport| {
            let mut totals = report.unassigned_week.clone();
            if let Some(api)=&report.api_usage {store::merge_totals(&mut totals,&api.week.totals);}
            for account in &report.accounts { store::merge_totals(&mut totals,&account.calendar_week.totals); }
            store::finish_totals(&mut totals);
            totals
        };
        let a = total(&before); let b = total(&after);
        assert_eq!((a.request_count,a.input_tokens,a.output_tokens,a.cache_read_tokens),
            (b.request_count,b.input_tokens,b.output_tokens,b.cache_read_tokens));
        assert!((a.priced_cost_usd-b.priced_cost_usd).abs()<1e-8);
        assert!((a.priced_cost_cny-b.priced_cost_cny).abs()<1e-8);
        let output = json!({"verifiedRequests":verified,"reassignedRequests":reassigned,
            "newlyAttributedRequests":newly_attributed,"alreadyCorrectRequests":already_correct,"conflicts":conflicts,
            "before":before,"after":after,"globalBefore":a,"globalAfter":b});
        std::fs::write(std::env::var_os("MONITOR_ACCOUNT_REPAIR_REPORT").unwrap(),serde_json::to_vec_pretty(&output).unwrap()).unwrap();
        println!("verified={verified} reassigned={reassigned} conflicts={conflicts}");
    }

    #[test]
    #[ignore = "Requires an explicit writable ledger copy and week bounds"]
    fn copied_ledger_diagnostic() {
        let path = PathBuf::from(
            std::env::var_os("MONITOR_ACCOUNT_DIAGNOSTIC_COPY")
                .expect("Set an explicit copied ledger path"),
        );
        assert!(
            path.is_file(),
            "The diagnostic ledger copy must already exist"
        );
        if let Ok(production) = crate::ledger_db::ledger_db_path() {
            if let Ok(production) = production.canonicalize() {
                assert_ne!(
                    path.canonicalize().unwrap(),
                    production,
                    "Do not run diagnostics against the production ledger"
                );
            }
        }
        let week = std::env::var("MONITOR_ACCOUNT_DIAGNOSTIC_WEEK_START_MS")
            .unwrap()
            .parse::<i64>()
            .unwrap();
        let now = std::env::var("MONITOR_ACCOUNT_DIAGNOSTIC_NOW_MS")
            .unwrap()
            .parse::<i64>()
            .unwrap();
        assert!(week >= 0 && now >= week && now - week <= 8 * DAY);
        let conn = Connection::open(path).unwrap();
        initialize(&conn).unwrap();
        let report = read(&conn, week, now, &read_local_subscriptions()).unwrap();
        let mut assigned = report.unassigned_week.clone();
        if let Some(api)=&report.api_usage {store::merge_totals(&mut assigned,&api.week.totals);}
        for account in &report.accounts {
            for period in [Some(&account.calendar_week),account.subscription_month.as_ref(),account.current_cycle.as_ref().map(|cycle|&cycle.period)].into_iter().flatten(){
                assert!(!period.billing_totals.contains_key("api"),"API calls leaked into subscription-account amounts");
            }
            store::merge_totals(&mut assigned, &account.calendar_week.totals);
        }
        store::finish_totals(&mut assigned);
        let mut global = Totals::default();
        let mut statement = conn.prepare("SELECT usage,cost FROM monitor_requests WHERE timestamp_ms>=?1 AND timestamp_ms<?2 ORDER BY timestamp_ms").unwrap();
        let rows = statement
            .query_map(params![week, now], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap();
        for row in rows {
            let (usage, cost) = row.unwrap();
            let usage = serde_json::from_str::<UsageRecord>(&usage).unwrap();
            store::merge_totals(
                &mut global,
                &weekly::saved_request_totals(&usage, &cost).unwrap(),
            );
        }
        store::finish_totals(&mut global);
        let same = |a: &Totals, b: &Totals| {
            assert_eq!(
                (
                    a.request_count,
                    a.total_tokens,
                    a.cache_read_tokens,
                    a.unpriced_requests,
                    a.scenario_requests
                ),
                (
                    b.request_count,
                    b.total_tokens,
                    b.cache_read_tokens,
                    b.unpriced_requests,
                    b.scenario_requests
                )
            );
            assert!((a.priced_cost_usd - b.priced_cost_usd).abs() < 1e-8);
            assert!((a.priced_cost_cny - b.priced_cost_cny).abs() < 1e-8);
            for currency in a
                .automatic_price_summary
                .by_currency
                .keys()
                .chain(b.automatic_price_summary.by_currency.keys())
            {
                let a = &a.automatic_price_summary.by_currency[currency];
                let b = &b.automatic_price_summary.by_currency[currency];
                assert!((a.response_subtotal - b.response_subtotal).abs() < 1e-8);
                assert!((a.requested_subtotal - b.requested_subtotal).abs() < 1e-8);
                assert!((a.unknown_reference_subtotal - b.unknown_reference_subtotal).abs() < 1e-8);
            }
        };
        same(&assigned, &global);
        if let Some(api)=&report.api_usage {
            let direct=read_api_usage(&conn,week,now,None).unwrap().unwrap();
            same(&api.week.totals,&direct.week.totals);
        }
        for account in &report.accounts {
            for cycle in account.quota_cycles.iter().chain(&account.month_cycles){
                assert!(!cycle.period.billing_totals.contains_key("api"));
                if let Some(snapshot)=&cycle.quota_snapshot{assert!(!snapshot.billing_totals.contains_key("api"));}
            }
            if let Some(month) = &account.subscription_month {
                let mut parts = account.unsegmented_month.clone();
                for cycle in &account.month_cycles {
                    store::merge_totals(&mut parts, &cycle.period.totals);
                }
                store::finish_totals(&mut parts);
                same(&parts, &month.totals);
            }
        }
        let accounts = report.accounts.iter().map(|account| json!({
            "accountKey":account.account_key, "tool":account.tool,
            "subscription":account.subscription, "calendarWeek":account.calendar_week,
            "subscriptionMonth":account.subscription_month, "currentCycle":account.current_cycle,
            "previousCycle":account.previous_cycle,
            "quotaCycles":account.quota_cycles,
            "monthCycles":account.month_cycles, "unsegmentedMonth":account.unsegmented_month,
        })).collect::<Vec<_>>();
        println!(
            "{}",
            json!({"collectedAtMs":now,"weekStartMs":week,"accounts":accounts,
            "unassignedWeek":report.unassigned_week,"apiUsage":report.api_usage,"globalWeek":global})
        );
    }
    #[test]
    fn same_session_switch_keeps_creator_references_out_of_confirmed_accounts() {
        let conn = database();
        account(&conn, 1, "creator");
        account(&conn, 2, "actual");
        session(&conn, "chat", "same-chat", Some("creator"), None);
        let start = time("2026-11-02T00:00:00Z");
        unverified_request(&conn, "unknown-before", "same-chat", start + 1000, json!({"usd":2.0}));
        unverified_request(&conn, "proven-after-switch", "same-chat", start + 2000, json!({"usd":3.0}));
        unverified_request(&conn, "unknown-after", "same-chat", start + 3000, json!({"usd":5.0}));
        prove_request(&conn, "proven-after-switch", "account:actual");
        let report = read(&conn, start, start + 5000, &LocalSubscriptions::default()).unwrap();
        let ids = super::super::quota::account_report_identities(&conn, "codex").unwrap();
        let creator = report.accounts.iter().find(|a| a.account_key == ids["account:creator"].0).unwrap();
        let actual = report.accounts.iter().find(|a| a.account_key == ids["account:actual"].0).unwrap();
        assert_eq!((creator.calendar_week.totals.request_count, creator.calendar_week.totals.priced_cost_usd), (0, 0.0));
        assert!(!creator.billing_account_verified);
        assert_eq!((actual.calendar_week.totals.request_count, actual.calendar_week.totals.priced_cost_usd), (1, 3.0));
        assert!(actual.billing_account_verified);
        assert_eq!((report.unassigned_week.request_count, report.unassigned_week.total_tokens, report.unassigned_week.priced_cost_usd), (2, 240, 7.0));
        assert_eq!(report.accounts.iter().map(|a| a.calendar_week.totals.request_count).sum::<i64>() + report.unassigned_week.request_count, 3);
        assert_eq!(report.accounts.iter().map(|a| a.calendar_week.totals.priced_cost_usd).sum::<f64>() + report.unassigned_week.priced_cost_usd, 10.0);
        let value = serde_json::to_value(report).unwrap();
        let creator = value["accounts"].as_array().unwrap().iter().find(|a| a["accountKey"] == ids["account:creator"].0).unwrap();
        assert_eq!(creator["creatorReference"]["calendarWeek"]["totals"]["requestCount"], 2);
        assert_eq!(creator["creatorReference"]["calendarWeek"]["totals"]["pricedCostUsd"], 7.0);
        assert_eq!(value["unassignedByTool"]["codex"]["requestCount"], 2);
        assert!(!value.to_string().contains("account:creator"));
    }

    #[test]
    fn creator_without_quota_has_reference_identity_but_no_confirmed_usage() {
        let conn = database();
        session(&conn, "one", "shared-chat", Some("same-name"), None);
        session(&conn, "copy", "shared-chat", Some("same-name"), None);
        let start = time("2026-11-02T00:00:00Z");
        unverified_request(&conn, "reference", "shared-chat", start + 1, json!({"usd":4.25}));
        let report = read(&conn, start, start + 1000, &LocalSubscriptions::default()).unwrap();
        assert_eq!(report.accounts.len(), 1);
        assert_eq!(report.accounts[0].calendar_week.totals.request_count, 0);
        assert_eq!((report.unassigned_week.request_count, report.unassigned_week.priced_cost_usd), (1, 4.25));
        let value = serde_json::to_value(report).unwrap();
        assert_eq!(value["accounts"][0]["creatorReference"]["calendarWeek"]["totals"]["pricedCostUsd"], 4.25);
        session(&conn, "conflicting-copy", "shared-chat", Some("different-account"), None);
        let conflict = serde_json::to_value(read(&conn, start, start + 1000, &LocalSubscriptions::default()).unwrap()).unwrap();
        assert_eq!(conflict["unassignedWeek"]["requestCount"], 1);
        for account in conflict["accounts"].as_array().unwrap() {
            assert_eq!(account["calendarWeek"]["totals"]["requestCount"], 0);
            assert_eq!(account["creatorReference"]["calendarWeek"]["totals"]["requestCount"], 0);
        }
    }

    #[test]
    fn account_periods_do_not_locate_unknown_times_or_cumulative_intervals() {
        let conn = database();
        account(&conn, 1, "a");
        session(&conn, "one", "chat", Some("a"), None);
        let start = time("2026-11-02T00:00:00Z");
        for (id, stamp, basis) in [("unknown-time", start - DAY, ""),
            ("cumulative", start + 10, "legacy_initial_cumulative"),
            ("delta", start + 20, "legacy_cumulative_delta")] {
            unverified_request(&conn, id, "chat", stamp, json!({"usd":2.0}));
            conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.usageBasis',?2) WHERE id=?1", params![id,basis]).unwrap();
        }
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.unknownFields',json('[\"timestamp\",\"cache_read_tokens\"]')) WHERE id='unknown-time'", []).unwrap();
        let report = read(&conn, start, start + 1000, &LocalSubscriptions::default()).unwrap();
        assert_eq!(report.accounts[0].calendar_week.totals.request_count, 0);
        assert_eq!(report.unassigned_week.request_count, 0);
        let value = serde_json::to_value(report).unwrap();
        assert_eq!(value["unlocatedTotals"]["requestCount"], 3);
        assert_eq!(value["unlocatedTotals"]["totalTokens"], 360);
        assert_eq!(value["unlocatedTotals"]["pricedCostUsd"], 6.0);
        assert_eq!(value["unlocatedTotals"]["unitemizedRecords"], 2);
        assert_eq!(value["unlocatedTotals"]["cacheReadUnknownRequests"], 1);
        assert_eq!(value["unlocatedByTool"]["codex"]["requestCount"], 3);
        assert_eq!(value["accounts"][0]["creatorReference"]["calendarWeek"]["totals"]["requestCount"], 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |r| r.get::<_,i64>(0)).unwrap(), 3);
    }

    #[test]
    fn selected_account_conflicts_and_non_chatgpt_modes_do_not_reuse_token_dates() {
        let claims = json!({"https://api.openai.com/auth":{"chatgpt_account_id":"personal",
            "chatgpt_subscription_active_start":"2026-10-01T00:00:00Z"}});
        let token = format!("header.{}.signature", URL_SAFE_NO_PAD.encode(claims.to_string()));
        let selected_other = json!({"auth_mode":"chatgpt","tokens":{"account_id":"organization","id_token":token}});
        assert!(decode_subscription(selected_other.to_string().as_bytes()).is_err());
        let api_mode = json!({"auth_mode":"apikey","tokens":{"account_id":"personal","id_token":token}});
        assert!(decode_subscription(api_mode.to_string().as_bytes()).unwrap().is_none());
        let invalid = AccountSubscription { start_ms: Some(time("2026-10-01T00:00:00Z")),
            error: Some("Invalid end metadata".into()), ..Default::default() };
        assert!(subscription_month(&invalid, time("2026-10-15T00:00:00Z")).is_none());
    }

    #[test]
    fn official_subscription_denials_and_unknown_responses_revoke_only_current_eligibility() {
        let start = time("2026-10-01T00:00:00Z");
        let now = time("2026-10-20T00:00:00Z");
        let active = json!({"accounts":{"a":{"account":{"account_id":"a"},"entitlement":{
            "has_active_subscription":true,"billing_period":"monthly","renews_at":"2026-11-01T00:00:00Z"}}}});
        for (entitlement, expected_active, expected_period, unknown) in [
            (json!({"has_active_subscription":false,"billing_period":"monthly"}), json!(false), json!("monthly"), false),
            (json!({"has_active_subscription":true,"billing_period":"yearly"}), json!(true), json!("yearly"), false),
            (json!({}), Value::Null, Value::Null, true),
        ] {
            let conn = database();
            account(&conn, 1, "a");
            session(&conn, "chat", "chat", Some("a"), None);
            request(&conn, "kept", "chat", now - 1000, json!({"usd":9.0}));
            let original: (String, String) = conn.query_row("SELECT usage,cost FROM monitor_requests", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap();
            save_official_subscription(&conn, "a", &active, now).unwrap();
            let before = read(&conn, now-DAY, now, &subscriptions(start, None)).unwrap();
            assert_eq!(before.accounts[0].subscription_month.as_ref().unwrap().totals.priced_cost_usd, 9.0);
            let response = json!({"accounts":{"a":{"account":{"account_id":"a"},"entitlement":entitlement}}});
            save_official_subscription(&conn, "a", &response, now + 1000).unwrap();
            // A delayed older successful response cannot undo newer denial/unknown evidence.
            save_official_subscription(&conn, "a", &active, now + 500).unwrap();
            let after = read(&conn, now-DAY, now+2000, &subscriptions(start, None)).unwrap();
            assert!(after.accounts[0].subscription_month.is_none());
            assert_eq!(after.accounts[0].calendar_week.totals.priced_cost_usd, 9.0);
            assert_eq!(after.accounts[0].subscription.error.is_some(), unknown);
            let value = serde_json::to_value(after).unwrap();
            assert_eq!(value["accounts"][0]["subscription"]["active"], expected_active);
            assert_eq!(value["accounts"][0]["subscription"]["billingPeriod"], expected_period);
            let history: String = conn.query_row("SELECT data FROM monitor_state WHERE key GLOB 'account_billing_cycle_history:*'", [], |r|r.get(0)).unwrap();
            let history: Value = serde_json::from_str(&history).unwrap();
            assert_eq!(history["renewalAtMs"], time("2026-11-01T00:00:00Z"));
            assert_eq!(history["active"], true);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
            assert_eq!(conn.query_row("SELECT usage,cost FROM monitor_requests", [], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap(), original);
        }
    }

    #[test]
    fn concurrent_account_schema_upgrade_serializes_before_column_checks() {
        let path = std::env::temp_dir().join(format!("account-schema-{}-{}.sqlite", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let conn = Connection::open(&path).unwrap();
        store::initialize(&conn).unwrap();
        let start = time("2026-10-01T00:00:00Z");
        conn.execute("INSERT INTO monitor_account_cycles(id,tool,account_key,slot,window_minutes,start_ms,reset_ms,observed_ms,used_percent)
            VALUES(9,'codex','account:old','primary',10080,?1,?2,?3,99)", params![start,start+WEEK,start+DAY]).unwrap();
        conn.execute("ALTER TABLE monitor_account_cycles DROP COLUMN attribution_verified", []).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('monitor_account_cycles')", [], |r|r.get::<_,i64>(0)).unwrap(), 11);
        drop(conn);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2).map(|_| {
            let path = path.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                let conn = Connection::open(path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
                barrier.wait();
                super::super::quota::initialize(&conn)
            })
        }).collect();
        for worker in workers { worker.join().unwrap().unwrap(); }
        let conn = Connection::open(&path).unwrap();
        let row: (i64,i64,i64,i64,f64,Option<i64>,i64) = conn.query_row(
            "SELECT id,start_ms,reset_ms,observed_ms,used_percent,exhausted_ms,attribution_verified FROM monitor_account_cycles", [],
            |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).unwrap();
        assert_eq!(row, (9,start,start+WEEK,start+DAY,99.0,None,0));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('monitor_account_cycles') WHERE name='attribution_verified'", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
        assert!(latest_cycle(&conn, "codex", "account:old").unwrap().is_none());
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

}
