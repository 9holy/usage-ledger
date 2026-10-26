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
    checked_at_ms: Option<i64>,
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
    start_ms: i64,
    end_ms: i64,
    observed_end_ms: i64,
    totals: Totals,
}

impl AccountUsagePeriod {
    fn new(start_ms: i64, end_ms: i64, now_ms: i64) -> Self {
        Self {
            start_ms,
            end_ms,
            observed_end_ms: end_ms.min(now_ms),
            totals: Totals::default(),
        }
    }

    fn contains(&self, time: i64) -> bool {
        self.start_ms <= time && time < self.observed_end_ms
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
struct AccountUsage {
    account_key: String,
    account_label: String,
    tool: String,
    attribution: &'static str,
    subscription: AccountSubscription,
    calendar_week: AccountUsagePeriod,
    subscription_month: Option<AccountUsagePeriod>,
    current_cycle: Option<AccountUsageCycle>,
    previous_cycle: Option<AccountUsageCycle>,
    quota_cycles: Vec<AccountUsageCycle>,
    month_cycles: Vec<AccountUsageCycle>,
    unsegmented_month: Totals,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageReport {
    collected_at_ms: i64,
    week_start_ms: i64,
    current_account_key: Option<String>,
    accounts: Vec<AccountUsage>,
    unassigned_week: Totals,
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
        cycle.quota_snapshot = Some(snapshot);
        cycle
    }
}

pub(super) fn is_account_weekly_pool(tool: &str, limit_id: &str, window_minutes: Option<i64>) -> bool {
    window_minutes == Some(10080)
        && matches!((tool, limit_id), ("codex", "codex") | ("claude", "seven_day"))
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS monitor_account_cycles (
           id INTEGER PRIMARY KEY, tool TEXT NOT NULL, account_key TEXT NOT NULL,
           slot TEXT NOT NULL, window_minutes INTEGER NOT NULL,
           start_ms INTEGER NOT NULL, end_ms INTEGER, reset_ms INTEGER NOT NULL,
           observed_ms INTEGER NOT NULL, used_percent REAL, exhausted_ms INTEGER,
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
    // Existing installations already have a latest quota snapshot, but no historical rounds.
    let mut statement = conn
        .prepare(
            "SELECT tool,account_key,slot,observed_ms,
               limit_id,
               json_extract(data,'$.resets_at_ms'),json_extract(data,'$.used_percent')
             FROM monitor_quotas q WHERE window_minutes=10080
               AND json_extract(data,'$.attribution')='account'
               AND json_extract(data,'$.source_error') IS NULL
               AND NOT EXISTS(SELECT 1 FROM monitor_account_cycles c
                 WHERE c.tool=q.tool AND c.account_key=q.account_key)
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
                     WHERE tool=?1 AND account_key=?2 AND start_ms<?3 AND end_ms IS NOT NULL
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
           (tool,account_key,slot,window_minutes,start_ms,reset_ms,observed_ms,used_percent,exhausted_ms)
         VALUES(?1,?2,?3,10080,?4,?5,?6,?7,?8)",
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
         FROM monitor_account_cycles WHERE tool=?1 AND account_key=?2 ORDER BY start_ms DESC LIMIT 1",
        params![tool, account],
        Cycle::from_row,
    )
    .optional()
    .map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct AuthFile {
    tokens: Option<AuthTokens>,
}

#[derive(Deserialize)]
struct AuthTokens {
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
    let Some(token) = file.tokens.and_then(|tokens| tokens.id_token) else {
        return Ok(None);
    };
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
    let start = claim_time(claims.chatgpt_subscription_active_start.as_ref());
    let end = claim_time(claims.chatgpt_subscription_active_until.as_ref());
    let checked = claim_time(claims.chatgpt_subscription_last_checked.as_ref());
    let invalid = start.is_err() || end.is_err() || checked.is_err();
    let mut subscription = AccountSubscription {
        start_ms: start.ok().flatten(),
        end_ms: end.ok().flatten(),
        checked_at_ms: checked.ok().flatten(),
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
    if let Some(profile) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
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
                    checked_at_ms: saved.checked_at_ms,
                    source: "local_auth",
                    error: None,
                },
            );
        }
    }
    Ok(result)
}

fn subscription_month(subscription: &AccountSubscription, now: i64) -> Option<(i64, i64)> {
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
) -> Result<BTreeMap<(String, String), BTreeSet<String>>, String> {
    let mut statement = conn.prepare(
        "SELECT tool,json_extract(state,'$.session.id'),json_extract(state,'$.quota_account_id')
         FROM monitor_files WHERE json_type(state,'$.session.id')='text'
           AND json_extract(state,'$.quota_identity_error') IS NULL",
    ).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
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

fn read(
    conn: &Connection,
    week_start: i64,
    now: i64,
    subscriptions: &LocalSubscriptions,
) -> Result<AccountUsageReport, String> {
    let current_account = if subscriptions.error.is_none() && subscriptions.accounts.len() == 1 {
        subscriptions.accounts.keys().next()
    } else {
        None
    };
    let subscriptions = with_subscription_history(conn, subscriptions)?;
    let mut statement = conn
        .prepare(
            "SELECT tool,account_key,MIN(id),MIN(json_extract(data,'$.account_label'))
         FROM monitor_quotas GROUP BY tool,account_key
         HAVING MAX(json_extract(data,'$.attribution')='account')=1 ORDER BY tool,MIN(id)",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut accounts = Vec::new();
    let mut current_account_key = None;
    let mut indices = BTreeMap::new();
    let mut ranges = vec![(week_start, now)];
    for row in rows {
        let (tool, raw_account, id, label) = row.map_err(|error| error.to_string())?;
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
        let mut cycle_statement = conn
            .prepare(
                "SELECT id,start_ms,end_ms,reset_ms,observed_ms,used_percent,exhausted_ms
             FROM monitor_account_cycles WHERE tool=?1 AND account_key=?2
               AND start_ms<=?3 AND observed_ms>0
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
            if let Some(month) = month.as_ref().filter(|month| {
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
        let account_key = format!("{tool}:{id}");
        if tool == "codex" && current_account == Some(&raw_account) {
            current_account_key = Some(account_key.clone());
        }
        indices.insert((tool.clone(), raw_account), accounts.len());
        accounts.push(AccountUsage {
            account_key,
            account_label: label.unwrap_or_else(|| format!("Account {id}")),
            tool,
            attribution: "session_creator",
            subscription,
            calendar_week: AccountUsagePeriod::new(week_start, now, now),
            subscription_month: month,
            current_cycle: None,
            previous_cycle: None,
            quota_cycles,
            month_cycles,
            unsegmented_month: Totals::default(),
        });
    }
    let creators = session_creators(conn)?;
    let mut unassigned_week = Totals::default();
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
        "SELECT tool,timestamp_ms,usage,cost FROM monitor_requests WHERE {where_clause} ORDER BY timestamp_ms",
    )).map_err(|error| error.to_string())?;
    let parameters = merged.iter().flat_map(|(start, end)| [*start, *end]);
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
        let index = creators
            .get(&(tool.clone(), usage.session_id))
            .filter(|creators| creators.len() == 1)
            .and_then(|creators| indices.get(&(tool, creators.first().unwrap().clone())));
        let Some(index) = index else {
            if time >= week_start {
                store::merge_totals(&mut unassigned_week, &totals);
            }
            continue;
        };
        let account = &mut accounts[*index];
        if account.calendar_week.contains(time) {
            store::merge_totals(&mut account.calendar_week.totals, &totals);
        }
        if let Some(cycle) = account
            .quota_cycles
            .iter_mut()
            .find(|cycle| cycle.period.contains(time))
        {
            store::merge_totals(&mut cycle.period.totals, &totals);
            if let Some(snapshot) = cycle
                .quota_snapshot
                .as_mut()
                .filter(|snapshot| snapshot.contains(time))
            {
                store::merge_totals(&mut snapshot.totals, &totals);
            }
        }
        if let Some(month) = account
            .subscription_month
            .as_mut()
            .filter(|month| month.contains(time))
        {
            store::merge_totals(&mut month.totals, &totals);
            if let Some(cycle) = account
                .month_cycles
                .iter_mut()
                .find(|cycle| cycle.period.contains(time))
            {
                store::merge_totals(&mut cycle.period.totals, &totals);
            } else {
                store::merge_totals(&mut account.unsegmented_month, &totals);
            }
        }
    }
    for account in &mut accounts {
        store::finish_totals(&mut account.calendar_week.totals);
        if let Some(month) = &mut account.subscription_month {
            store::finish_totals(&mut month.totals);
        }
        for cycle in &mut account.quota_cycles {
            store::finish_totals(&mut cycle.period.totals);
            if let Some(snapshot) = &mut cycle.quota_snapshot {
                store::finish_totals(&mut snapshot.totals);
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
            store::finish_totals(&mut cycle.period.totals);
        }
        store::finish_totals(&mut account.unsegmented_month);
    }
    store::finish_totals(&mut unassigned_week);
    Ok(AccountUsageReport {
        collected_at_ms: now,
        week_start_ms: week_start,
        current_account_key,
        accounts,
        unassigned_week,
    })
}

#[tauri::command]
pub async fn usage_monitor_accounts(
    week_start_ms: i64,
    now_ms: i64,
) -> Result<AccountUsageReport, String> {
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
        read(
            &transaction,
            week_start_ms,
            now_ms,
            &read_local_subscriptions(),
        )
    })
    .await
    .map_err(|error| error.to_string())?
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

    fn request(conn: &Connection, id: &str, session: &str, stamp: i64, cost: Value) {
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

    fn subscriptions(start: i64, end: Option<i64>) -> LocalSubscriptions {
        LocalSubscriptions {
            accounts: [(
                "account:a".into(),
                AccountSubscription {
                    start_ms: Some(start),
                    end_ms: end,
                    checked_at_ms: Some(start),
                    source: "local_auth",
                    error: None,
                },
            )]
            .into(),
            error: None,
        }
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
            request(&conn, id, session, stamp, json!({"usd":1.0}));
        }
        let report = read(&conn, start, start + 100, &LocalSubscriptions::default()).unwrap();
        assert_eq!(report.accounts.len(), 2);
        assert_eq!(report.accounts[0].calendar_week.totals.request_count, 1);
        assert_eq!(report.accounts[1].calendar_week.totals.request_count, 1);
        assert_eq!(report.unassigned_week.request_count, 2);
        assert_eq!(report.accounts[0].account_key, "codex:1");
        assert_eq!(report.accounts[0].subscription.source, "none");
        assert!(report.accounts[0].subscription_month.is_none());
        assert!(report.accounts[0].previous_cycle.is_none());
        assert_eq!(report.accounts[0].calendar_week.totals.total_tokens, 120);
        let json = serde_json::to_value(report).unwrap();
        assert_eq!(json["accounts"][0]["attribution"], "session_creator");
        assert!(json["accounts"][0]["previousCycle"].is_null());
        assert!(json.to_string().find("account:a").is_none());
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
            let payload = json!({"rate_limits":{"limit_id":"codex","plan_type":"pro",
                "primary":{"window_minutes":10080,"resets_at":next_reset / 1000,"used_percent":used}}});
            for observation in
                super::super::quota::codex_observations(&payload, Some("a"), "a", Some(observed))
            {
                super::super::quota::save(&conn, &observation).unwrap();
            }
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
        let payload = json!({"rate_limits":{"limit_id":"codex",
            "primary":{"window_minutes":10080,"resets_at":1793386876i64,"used_percent":100.}}});
        for observation in
            super::super::quota::codex_observations(&payload, Some("a"), "a", Some(stale_observed))
        {
            super::super::quota::save(&conn, &observation).unwrap();
        }
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
                "INSERT INTO monitor_account_cycles(tool,account_key,slot,window_minutes,start_ms,end_ms,reset_ms,observed_ms,used_percent)
                 VALUES('codex','account:a','primary',10080,?1,?2,?3,?4,?5)",
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
        let snapshot = capped.accounts[0]
            .current_cycle
            .as_ref()
            .unwrap()
            .quota_snapshot
            .as_ref()
            .unwrap();
        assert_eq!(
            (snapshot.observed_end_ms, snapshot.totals.priced_cost_usd),
            (observed, 1.)
        );

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
            "INSERT INTO monitor_account_cycles(tool,account_key,slot,window_minutes,start_ms,reset_ms,observed_ms,used_percent)
             VALUES('codex','account:a','secondary',10080,?1,?2,?1,10),
                   ('codex','account:a','secondary',10080,?3,?4,0,10)",
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
        let report = read(&conn, start, start + DAY, &live).unwrap();
        assert_eq!(report.current_account_key.as_deref(), Some("codex:1"));

        let mut switched = live.accounts.remove("account:a").unwrap();
        switched.start_ms = None;
        switched.error = Some("Invalid local subscription date metadata".into());
        live.accounts.insert("account:b".into(), switched);
        let report = read(&conn, start, start + DAY, &live).unwrap();
        assert_eq!(report.current_account_key.as_deref(), Some("codex:2"));
        assert_eq!(report.accounts[0].subscription.source, "local_auth");
        assert!(report.accounts[0].subscription_month.is_some());
        assert!(report.accounts[1].subscription.error.is_some());
        let output = serde_json::to_value(report).unwrap();
        assert_eq!(output["currentAccountKey"], "codex:2");
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
                json!({"attribution":"account","resets_at_ms":reset,"used_percent":25.})
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
        for account in &report.accounts {
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
        for account in &report.accounts {
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
            "unassignedWeek":report.unassigned_week,"globalWeek":global})
        );
    }
}
