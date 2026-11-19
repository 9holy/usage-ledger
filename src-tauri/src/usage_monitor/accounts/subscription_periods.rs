use super::{OfficialBillingCycle, SubscriptionDates};
use crate::usage_monitor::quota;
use chrono::{DateTime, Months, Utc};
use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Serialize};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubscriptionCycle {
    pub id: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub kind: &'static str,
    pub current: bool,
}

impl SubscriptionCycle {
    fn new(start_ms: i64, end_ms: i64, kind: &'static str, current: bool) -> Self {
        let id = if kind=="unconfirmed" { format!("unconfirmed:{start_ms}") } else { format!("{start_ms}:{end_ms}") };
        Self { id, start_ms, end_ms, kind, current }
    }
}

fn states<T: DeserializeOwned>(conn: &Connection, latest: &str, history: &str) -> Result<Vec<(bool, T)>, String> {
    let mut query = conn.prepare("SELECT key=?1,data FROM monitor_state
      WHERE key=?1 OR (key>=?2 AND key<?3)").map_err(|e|e.to_string())?;
    // Every archive key suffix following the colon begins with a timestamp.
    let upper = format!("{};", &history[..history.len()-1]);
    let rows = query.query_map(params![latest,history,upper], |r|Ok((r.get(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
    rows.map(|row| {
        let (current, data) = row.map_err(|e|e.to_string())?;
        Ok((current,serde_json::from_str(&data).map_err(|e|e.to_string())?))
    }).collect()
}

fn request_bounds(conn: &Connection, tool: &str, key: &str, now: i64) -> Result<Option<(i64,i64)>, String> {
    let (first,last): (Option<i64>,Option<i64>) = conn.query_row("SELECT min(t),max(t) FROM (
        SELECT r.timestamp_ms AS t FROM monitor_session_creators c
         CROSS JOIN monitor_requests r INDEXED BY monitor_requests_session ON r.session_key=c.tool||':'||c.session_id AND r.tool=c.tool
         WHERE c.tool=?1 AND c.account_key=?2 AND r.timestamp_ms>0 AND r.timestamp_ms<?3
        UNION ALL SELECT r.timestamp_ms FROM monitor_request_identity i
         CROSS JOIN monitor_requests r ON r.tool=i.tool AND r.id=i.id
         WHERE i.tool=?1 AND i.account_key IN (SELECT ?2 UNION SELECT native_key FROM monitor_account_native_keys
             WHERE tool=?1 AND account_key=?2) AND NOT i.conflicted AND r.timestamp_ms>0 AND r.timestamp_ms<?3
        UNION ALL SELECT timestamp_ms FROM monitor_upstream_receipts
         WHERE (CASE WHEN account_tool='' THEN tool ELSE account_tool END)=?1 AND account_key=?2
           AND NOT conflicted AND timestamp_ms>0 AND timestamp_ms<?3
        UNION ALL SELECT finished_ms FROM monitor_request_account_evidence
         WHERE ?1='codex' AND account_key=?2 AND finished_ms>0 AND finished_ms<?3
        UNION ALL SELECT r.timestamp_ms FROM monitor_request_quota_evidence e
         CROSS JOIN monitor_requests r ON r.tool='codex' AND r.id=e.id
         WHERE ?1='codex' AND r.timestamp_ms>0 AND r.timestamp_ms<?3
           AND EXISTS(SELECT 1 FROM monitor_codex_quota_accounts a WHERE a.home=e.home AND a.reset_ms=e.reset_ms AND a.plan=e.plan AND a.account_key=?2)
           AND r.timestamp_ms>=e.reset_ms-604800000 AND r.timestamp_ms<e.reset_ms
      )", params![tool,key,now], |r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    Ok(first.zip(last).map(|(start,end)|(start,end+1)))
}

fn earlier(renewal: i64, months: u32) -> Option<i64> {
    Some(DateTime::<Utc>::from_timestamp_millis(renewal)?.checked_sub_months(Months::new(months))?.timestamp_millis())
}

fn subscription_dates(conn: &Connection, key: &str) -> Result<Vec<(bool,SubscriptionDates)>, String> {
    states(conn,&format!("account_subscription:{key}"),&format!("account_subscription_dates_history:{key}:"))
}

fn recorded_cycles(conn: &Connection, key: &str, now: i64, dates: &[(bool,SubscriptionDates)]) -> Result<(Vec<SubscriptionCycle>,Option<(i64,i64,Option<i64>)>), String> {
    let mut checks: Vec<(_,OfficialBillingCycle)> = states(conn,&format!("account_billing_cycle:{key}"),&format!("account_billing_cycle_history:{key}:"))?;
    checks.sort_by_key(|(latest,check)|(check.checked_at_ms,*latest));
    let mut current_end = None;
    let mut cycles: Vec<SubscriptionCycle> = Vec::new();
    let mut first_anchor = None;
    for (latest,check) in checks {
        if check.active != Some(true) || check.error.is_some() || check.billing_period.as_deref() != Some("monthly") { continue; }
        let Some(end) = check.renewal_at_ms.filter(|end| check.checked_at_ms < *end) else { continue; };
        if latest { current_end = Some(end); }
        let observed = check.checked_at_ms;
        let Some(expected_start) = earlier(end,1) else { continue; };
        let activation = dates.iter().filter_map(|(_,dates)| {
            dates.start_ms.filter(|start| *start <= observed && dates.end_ms.is_none_or(|end| observed<end))
        }).max();
        if let Some(open) = cycles.last_mut().filter(|cycle| observed < cycle.end_ms) {
            if let Some(restart) = activation.filter(|start| *start > open.start_ms) {
                *open = SubscriptionCycle::new(open.start_ms,restart,"recorded",false);
                cycles.push(SubscriptionCycle::new(restart,end,"recorded",false));
            } else if open.end_ms != end {
                // A changed renewal date revises only the still-open term.
                *open = SubscriptionCycle::new(open.start_ms,end,"recorded",false);
            }
            continue;
        }
        let start = activation.unwrap_or(expected_start).max(expected_start);
        let start = cycles.last().map_or(start, |previous| start.max(previous.end_ms));
        // Do not fold a new or disputed schedule into an earlier observed cycle.
        if observed < start || end <= start { continue; }
        first_anchor.get_or_insert((end,start,activation));
        cycles.push(SubscriptionCycle::new(start,end,"recorded",false));
    }
    if let Some(last) = cycles.last_mut() {
        last.current = current_end == Some(last.end_ms) && last.start_ms <= now && now < last.end_ms;
    }
    Ok((cycles,first_anchor))
}

pub(super) fn at_saved_cycle(conn: &Connection, key: &str, time: i64) -> Result<Option<(i64,i64)>, String> {
    let (cycles,_) = recorded_cycles(conn,key,time,&subscription_dates(conn,key)?)?;
    Ok(cycles.into_iter().find(|period|period.start_ms<=time&&time<period.end_ms)
        .map(|period|(period.start_ms,period.end_ms)))
}

fn list_for(conn: &Connection, tool: &str, key: &str, now: i64) -> Result<Vec<SubscriptionCycle>, String> {
    let bounds = request_bounds(conn,tool,key,now)?;
    let dates = subscription_dates(conn,key)?;
    let (mut cycles,first_anchor) = recorded_cycles(conn,key,now,&dates)?;

    // Estimate earlier cycles only inside the activation interval supporting the
    // earliest saved renewal. A newer schedule must not recut older history.
    if let (Some((anchor,mut end,Some(activation))),Some((first,_))) = (first_anchor,bounds) {
        let floor = activation.max(first);
        let mut months = 2;
        while end > floor {
            let Some(start) = earlier(anchor, months).map(|start|start.max(activation)) else { break; };
            if start >= end { break; }
            cycles.push(SubscriptionCycle::new(start,end,"estimated",false));
            end = start;
            months += 1;
        }
    }

    let mut validity: Vec<_> = dates.iter().filter_map(|(_,dates)| dates.start_ms.zip(dates.end_ms))
        .filter(|(start,end)| *start<now && start<end).collect();
    validity.sort_unstable_by_key(|&(start,end)|(start,std::cmp::Reverse(end)));
    for (start,end) in validity {
        if !cycles.iter().any(|cycle| start<cycle.end_ms && cycle.start_ms<end) {
            cycles.push(SubscriptionCycle::new(start,end,"validity",false));
        }
    }
    cycles.sort_by_key(|cycle|cycle.start_ms);
    if let Some((mut start,last)) = bounds {
        let mut unknown = Vec::new();
        for cycle in &cycles {
            let end = cycle.start_ms.min(last);
            if start < end { unknown.push(SubscriptionCycle::new(start,end,"unconfirmed",false)); }
            start = start.max(cycle.end_ms);
        }
        if start < last { unknown.push(SubscriptionCycle::new(start,last,"unconfirmed",false)); }
        cycles.extend(unknown);
        cycles.sort_by_key(|cycle|cycle.start_ms);
    }
    cycles.reverse();
    Ok(cycles)
}

pub(super) fn list(conn: &Connection, account_key: &str, now: i64) -> Result<Vec<SubscriptionCycle>, String> {
    for tool in ["codex","claude","antigravity","deepseek-harness"] {
        if let Some((raw,_,_)) = quota::account_identity_rows(conn,tool)?.into_iter()
            .find(|(raw,_,_)|quota::report_account_key(tool,raw)==account_key)
        {
            return list_for(conn,tool,&raw,now);
        }
    }
    Ok(Vec::new())
}
