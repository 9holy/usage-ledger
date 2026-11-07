use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::Duration,
};

struct OfficialQuota {
    home: PathBuf,
    account: String,
    payload: Result<Value, String>,
    subscription: Option<Result<Value,String>>,
    observed_ms: i64,
}

pub(super) struct Reader {
    sender: std::sync::mpsc::Sender<OfficialQuota>,
    receiver: std::sync::mpsc::Receiver<OfficialQuota>,
}

impl Reader {
    pub(super) fn new() -> Self {
        let (sender, receiver) = std::sync::mpsc::channel();
        Self { sender, receiver }
    }

    pub(super) fn collect(
        &mut self,
        conn: &Connection,
        sources: &[super::collector::SourceRoot],
        now: i64,
    ) -> Result<Vec<(PathBuf, i64)>, String> {
        for result in self.receiver.try_iter() {
            if let Some(subscription) = result.subscription {
                if let Err(error) = subscription.and_then(|payload| super::accounts::save_official_subscription(conn,&result.account,&payload,result.observed_ms)) {
                    super::accounts::subscription_unavailable(conn, &result.account, result.observed_ms)?;
                    eprintln!("Official Codex subscription unavailable: {error}");
                }
            }
            match result.payload {
                Ok(payload) => {
                    if save_authenticated(conn, &result.home, &result.account, &payload, result.observed_ms).is_err() {
                        // An invalid successful body is a failure for this
                        // account; it must not abort unrelated queued results.
                        super::quota::authenticated_codex_unavailable(conn, &result.account, result.observed_ms)?;
                    }
                }
                Err(_) => super::quota::authenticated_codex_unavailable(conn, &result.account, result.observed_ms)?,
            }
        }
        schedule(self.sender.clone(), conn, sources, now)?;
        let mut query = conn
            .prepare(
                "SELECT DISTINCT home,reset_ms FROM monitor_codex_quota_accounts WHERE replayed<?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([REPLAY_VERSION], |r| {
                Ok((PathBuf::from(r.get::<_, String>(0)?), r.get(1)?))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

pub(super) const WEEK_MS: i64 = 604_800_000;
pub(super) const REPLAY_VERSION: i64 = 2;

#[derive(Debug)]
pub(super) struct RequestQuota {
    pub id: String,
    pub reset_ms: i64,
    pub plan: String,
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS monitor_codex_quota_accounts (
        home TEXT NOT NULL,reset_ms INTEGER NOT NULL,plan TEXT NOT NULL,account_key TEXT NOT NULL,
        observed_ms INTEGER NOT NULL,replayed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(home,reset_ms,plan,account_key));
        CREATE TABLE IF NOT EXISTS monitor_request_quota_evidence (
        id TEXT NOT NULL,home TEXT NOT NULL,reset_ms INTEGER NOT NULL,plan TEXT NOT NULL,
        PRIMARY KEY(id,home,reset_ms,plan));",
    )
    .map_err(|e| e.to_string())
}

pub(super) fn home(path: &Path) -> Option<&Path> {
    path.ancestors()
        .find(|p| {
            p.file_name()
                .is_some_and(|n| n == "sessions" || n == "archived_sessions")
        })?
        .parent()
}

pub(super) fn request_quotas(payload: &Value, id: &str) -> Vec<RequestQuota> {
    let limits = &payload["rate_limits"];
    if limits["limit_id"].as_str().is_some_and(|id| id != "codex") {
        return Vec::new();
    }
    let Some(plan) = limits["plan_type"].as_str().filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    ["primary", "secondary"]
        .iter()
        .filter_map(|slot| {
            let window = &limits[slot];
            if window["window_minutes"].as_i64() != Some(10080) {
                return None;
            }
            let reset_ms = window["resets_at"]
                .as_i64()?
                .checked_mul(1000)
                .filter(|n| *n > 0)?;
            Some(RequestQuota {
                id: id.into(),
                reset_ms,
                plan: plan.into(),
            })
        })
        .collect()
}

pub(super) fn save_requests(
    conn: &Connection,
    path: &Path,
    rows: &[RequestQuota],
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let home = home(path)
        .ok_or("Codex quota evidence has no source home")?
        .to_string_lossy();
    let mut insert = conn
        .prepare_cached("INSERT OR IGNORE INTO monitor_request_quota_evidence VALUES(?1,?2,?3,?4)")
        .map_err(|e| e.to_string())?;
    for row in rows {
        insert
            .execute(params![row.id, home, row.reset_ms, row.plan])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn save_parsed(
    conn: &Connection,
    path: &Path,
    parsed: &super::parser::ParsedLine,
) -> Result<(), String> {
    save_requests(conn, path, &parsed.request_quotas)?;
    for old in &parsed.delete_ids {
        if let [usage] = parsed.usage.as_slice() {
            conn.execute("INSERT OR IGNORE INTO monitor_request_quota_evidence SELECT ?1,home,reset_ms,plan FROM monitor_request_quota_evidence WHERE id=?2",
                params![usage.id,old]).map_err(|e|e.to_string())?;
        }
        conn.execute(
            "DELETE FROM monitor_request_quota_evidence WHERE id=?1",
            [old],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(super) fn save_authenticated(
    conn: &Connection,
    home: &Path,
    account: &str,
    payload: &Value,
    now: i64,
) -> Result<(), String> {
    if account.trim().is_empty() || now <= 0 {
        return Err("Official quota has no valid account observation".into());
    }
    let plan = payload["plan_type"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Official quota has no plan")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for slot in ["primary_window", "secondary_window"] {
        let window = &payload["rate_limit"][slot];
        if window["limit_window_seconds"].as_i64() != Some(604800) {
            continue;
        }
        let Some(reset) = window["reset_at"]
            .as_i64()
            .and_then(|v| v.checked_mul(1000))
            .filter(|v| *v > now)
        else {
            // A response can cross the reset boundary in transit. Retain its
            // expired window and independent credits/status, without creating
            // a current weekly account correlation from that expired window.
            continue;
        };
        tx.execute("INSERT INTO monitor_codex_quota_accounts(home,reset_ms,plan,account_key,observed_ms)
            VALUES(?1,?2,?3,?4,?5) ON CONFLICT(home,reset_ms,plan,account_key) DO UPDATE SET observed_ms=excluded.observed_ms",
            params![home.to_string_lossy(),reset,plan,format!("account:{account}"),now]).map_err(|e| e.to_string())?;
    }
    // Some plans report only a five-hour pool. Their authenticated snapshot
    // remains useful even when no weekly correlation can be recorded.
    super::quota::save_authenticated_codex(&tx, account, payload, now)?;
    tx.commit().map_err(|e| e.to_string())
}

fn schedule(
    sender: std::sync::mpsc::Sender<OfficialQuota>,
    conn: &Connection,
    sources: &[super::collector::SourceRoot],
    now: i64,
) -> Result<(), String> {
    let homes: BTreeSet<_> = sources
        .iter()
        .filter(|s| s.tool == "codex")
        .filter_map(|s| s.path.parent())
        .collect();
    for home in homes {
        let path = home.join("auth.json");
        let auth: Value = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("Invalid Codex auth metadata: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("Cannot read Codex auth metadata: {e}")),
        };
        if auth["auth_mode"]
            .as_str()
            .is_some_and(|mode| mode != "chatgpt")
        {
            continue;
        }
        let (Some(account), Some(token)) = (
            auth["tokens"]["account_id"].as_str(),
            auth["tokens"]["access_token"].as_str(),
        ) else {
            continue;
        };
        let key = format!(
            "codex_quota_auth_check:{:x}",
            md5::compute(format!("{}:{account}", home.display()))
        );
        let last: Option<String> = conn
            .query_row("SELECT data FROM monitor_state WHERE key=?1", [&key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if last
            .and_then(|s| s.parse::<i64>().ok())
            .is_some_and(|last| now - last < 300_000)
        {
            continue;
        }
        conn.execute("INSERT INTO monitor_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
            params![key,now.to_string()]).map_err(|e| e.to_string())?;
        let sender = sender.clone();
        let home = home.to_path_buf();
        let account = account.to_owned();
        let token = token.to_owned();
        let subscription_due=super::accounts::subscription_check_due(conn,&account,now)?;
        // Only the authenticated official endpoint can bind a quota cycle to a login account.
        std::thread::spawn(move || {
            let fetch = |url: &str| -> Result<Value,String> {
                reqwest::blocking::Client::builder()
                    .timeout(Duration::from_secs(10))
                    .build()
                    .map_err(|e| e.to_string())?
                    .get(url)
                    .bearer_auth(&token)
                    .header("ChatGPT-Account-Id", &account)
                    .header("User-Agent", "Codex Desktop")
                    .header("OpenAI-Beta", "codex-1")
                    .send()
                    .and_then(|r| r.error_for_status())
                    .map_err(|e| e.to_string())?
                    .json::<Value>().map_err(|e| e.to_string())
            };
            let payload = fetch("https://chatgpt.com/backend-api/wham/usage");
            let observed_ms = crate::ledger_db::now_ms();
            let subscription = subscription_due.then(|| fetch("https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"));
            let _ = sender.send(OfficialQuota {
                home,
                account,
                payload,
                subscription,
                observed_ms,
            });
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract_audit_quota(used: i32) -> Value {
        serde_json::json!({"plan_type":"pro","rate_limit":{
            "primary_window":{"limit_window_seconds":18000,"reset_at":19000,"used_percent":used},
            "secondary_window":{"limit_window_seconds":604800,"reset_at":700000,"used_percent":20}
        }})
    }

    #[test]
    fn contract_audit_official_quota_failure_is_account_scoped_historical_and_clears_on_success() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let now = 1_000_000;
        for account in ["a", "b"] {
            save_authenticated(&conn, Path::new("fixture"), account, &contract_audit_quota(40), now).unwrap();
        }
        let id = |account: &str| conn.query_row(
            "SELECT id FROM monitor_quotas WHERE account_key=?1 AND slot='primary'",
            [format!("account:{account}")], |r| r.get::<_, i64>(0),
        ).unwrap();
        let (a, b) = (id("a"), id("b"));
        let mut reader = Reader::new();
        reader.sender.send(OfficialQuota {
            home: PathBuf::from("fixture"), account: "a".into(), observed_ms: now + 1000,
            payload: Err("Authorization: Bearer fixture-only-key".into()), subscription: None,
        }).unwrap();
        reader.collect(&conn, &[], now + 1500).unwrap();
        let report = super::super::quota::read(&conn, now + 1501).unwrap();
        let failed = report.quotas.iter().find(|q| q.id == a).unwrap();
        assert!(failed.stale);
        assert!(failed.source_error.is_some());
        assert_eq!(failed.observed_at_ms, Some(now));
        assert_eq!(failed.used_percent, Some(40.0));
        let unaffected = report.quotas.iter().find(|q| q.id == b).unwrap();
        assert!(!unaffected.stale);
        assert!(unaffected.source_error.is_none());
        assert!(!serde_json::to_string(&report).unwrap().contains("fixture-only-key"));

        reader.sender.send(OfficialQuota {
            home: PathBuf::from("fixture"), account: "a".into(), observed_ms: now + 2000,
            payload: Ok(contract_audit_quota(0)), subscription: None,
        }).unwrap();
        reader.collect(&conn, &[], now + 2500).unwrap();
        let report = super::super::quota::read(&conn, now + 2501).unwrap();
        let recovered = report.quotas.iter().find(|q| q.id == a).unwrap();
        assert!(!recovered.stale);
        assert!(recovered.source_error.is_none());
        assert_eq!(recovered.observed_at_ms, Some(now + 2000));
        assert_eq!((recovered.used_percent, recovered.remaining_percent), (Some(0.0), Some(100.0)));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_quotas", [], |r| r.get::<_, i64>(0)).unwrap(), 4);
    }

    #[test]
    fn contract_audit_official_nullable_or_changed_slots_preserve_history_without_staying_current() {
        // OpenAI Codex efdacaf... generated RateLimitStatusDetails permits
        // missing/null primary_window and secondary_window, with independent durations.
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let now = 1_000_000;
        save_authenticated(&conn, Path::new("fixture"), "a", &contract_audit_quota(40), now).unwrap();
        let changed = serde_json::json!({"plan_type":"pro","rate_limit":{
            "primary_window":null,
            "secondary_window":{"limit_window_seconds":18000,"reset_at":19000,"used_percent":0}
        }});
        save_authenticated(&conn, Path::new("fixture"), "a", &changed, now + 1000).unwrap();
        let report = super::super::quota::read(&conn, now + 1001).unwrap();
        assert_eq!(report.quotas.len(), 3);
        let current: Vec<_> = report.quotas.iter().filter(|q| !q.stale).collect();
        assert_eq!(current.len(), 1);
        assert_eq!((current[0].slot.as_str(), current[0].window_minutes, current[0].used_percent), ("secondary", Some(300), Some(0.0)));
        for old in report.quotas.iter().filter(|q| q.observed_at_ms == Some(now)) {
            assert!(old.stale);
            assert!(old.source_error.is_some());
            assert!(old.used_percent.is_some());
        }
        save_authenticated(&conn, Path::new("fixture"), "a", &serde_json::json!({"plan_type":"pro","rate_limit":null}), now + 2000).unwrap();
        assert!(super::super::quota::read(&conn, now + 2001).unwrap().quotas.iter().all(|q| q.stale));
        // A delayed older response must not revive a window omitted by a newer success.
        save_authenticated(&conn, Path::new("fixture"), "a", &contract_audit_quota(80), now + 1500).unwrap();
        assert!(super::super::quota::read(&conn, now + 2500).unwrap().quotas.iter().all(|q| q.stale));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_quotas", [], |r| r.get::<_, i64>(0)).unwrap(), 3);
    }

    #[test]
    fn contract_audit_invalid_official_success_does_not_abort_other_accounts_or_erase_prior_facts() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let now = 1_000_000;
        save_authenticated(&conn, Path::new("fixture"), "a", &contract_audit_quota(40), now).unwrap();
        let mut reader = Reader::new();
        for (account, payload) in [("a", serde_json::json!({"error":"fixture-only-key"})), ("b", contract_audit_quota(0))] {
            reader.sender.send(OfficialQuota {
                home: PathBuf::from("fixture"), account: account.into(), observed_ms: now + 1000,
                payload: Ok(payload), subscription: None,
            }).unwrap();
        }
        assert!(reader.collect(&conn, &[], now + 1500).is_ok());
        let report = super::super::quota::read(&conn, now + 1501).unwrap();
        assert_eq!(report.quotas.len(), 4);
        assert_eq!(report.quotas.iter().filter(|q| q.stale && q.source_error.is_some()).count(), 2);
        assert_eq!(report.quotas.iter().filter(|q| !q.stale && q.slot == "primary").next().unwrap().used_percent, Some(0.0));
        assert!(!serde_json::to_string(&report).unwrap().contains("fixture-only-key"));
    }

    #[test]
    fn contract_audit_first_official_failure_is_reported_without_inventing_a_quota() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let mut reader = Reader::new();
        reader.sender.send(OfficialQuota {
            home: PathBuf::from("fixture"), account: "a".into(), observed_ms: 1_000_000,
            payload: Err("https://example.test/?api_key=fixture-only-key".into()), subscription: None,
        }).unwrap();
        reader.collect(&conn, &[], 1_000_001).unwrap();
        let report = super::super::quota::read(&conn, 1_000_002).unwrap();
        assert!(report.quotas.is_empty());
        let value = serde_json::to_value(report).unwrap();
        let sources = value["sources"].as_array().unwrap();
        assert!(sources.iter().any(|source| source["source"] == "codex_official_usage" && source["status"] == "error" && source["error"].is_string()));
        assert!(!value.to_string().contains("fixture-only-key"));
    }

    #[test]
    fn quota_keeps_its_observation_time_when_subscription_check_fails_or_collection_is_delayed() {
        let conn=Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let mut reader=Reader::new();
        reader.sender.send(OfficialQuota {
            home:PathBuf::from("fixture"),account:"a".into(),observed_ms:1000,
            payload:Ok(serde_json::json!({"plan_type":"pro","rate_limit":{"primary_window":{
                "limit_window_seconds":604800,"reset_at":700000,"used_percent":20}}})),
            subscription:Some(Err("Unavailable subscription service".into())),
        }).unwrap();
        reader.collect(&conn,&[],5000).unwrap();
        assert_eq!(conn.query_row("SELECT observed_ms FROM monitor_quotas",[],|r|r.get::<_,i64>(0)).unwrap(),1000);
    }
    #[test]
    fn local_creator_quota_stays_unattributed_beside_the_authenticated_account() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let mut old = super::super::quota::codex_observations(
            &serde_json::json!({"rate_limits":{
            "limit_id":"codex","plan_type":"pro","primary":{"window_minutes":10080,"resets_at":700000,"used_percent":20}}}),
            Some("creator"),
            "thread",
            Some(1000),
        );
        super::super::quota::save(&conn, &old[0]).unwrap();
        save_authenticated(&conn,Path::new("fixture"),"current",&serde_json::json!({"plan_type":"pro",
            "rate_limit":{"primary_window":{"limit_window_seconds":604800,"reset_at":700000,"used_percent":20}}}),2000).unwrap();
        super::super::quota::bind_codex_observations(
            &conn,
            Path::new("fixture/sessions/a.jsonl"),
            &mut old,
        )
        .unwrap();
        let report = super::super::quota::read(&conn, 2001).unwrap();
        assert_eq!(report.quotas.len(), 2);
        assert_eq!(report.quotas.iter().filter(|q| q.billing_account_verified == Some(true)).count(), 1);
        assert_eq!(report.quotas.iter().filter(|q| q.attribution == "unattributed" && q.billing_account_verified == Some(false)).count(), 1);
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM monitor_quotas WHERE id=1 AND account_key='session:thread'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn canonical_promotion_preserves_quota_evidence_without_mutating_requests() {
        let conn = Connection::open_in_memory().unwrap();
        initialize(&conn).unwrap();
        let path = Path::new("fixture/sessions/rollout.jsonl");
        save_requests(
            &conn,
            path,
            &[RequestQuota {
                id: "legacy".into(),
                reset_ms: 700000000,
                plan: "pro".into(),
            }],
        )
        .unwrap();
        let parsed = super::super::parser::ParsedLine {
            delete_ids: vec!["legacy".into()],
            usage: vec![super::super::types::UsageRecord {
                id: "response:canonical".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        save_parsed(&conn, path, &parsed).unwrap();
        let id: String = conn
            .query_row("SELECT id FROM monitor_request_quota_evidence", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(id, "response:canonical");
    }

    #[test]
    fn authenticated_cycle_correlations_remain_unproven_for_historical_requests() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let payload = serde_json::json!({"plan_type":"pro","rate_limit":{"primary_window":{
            "limit_window_seconds":604800,"reset_at":700000,"used_percent":20}}});
        let scopes = request_quotas(
            &serde_json::json!({"rate_limits":{"limit_id":"codex","plan_type":"pro",
            "primary":{"window_minutes":10080,"resets_at":700000}}}),
            "response:one",
        );
        save_requests(&conn, Path::new("fixture/sessions/rollout.jsonl"), &scopes).unwrap();
        let usage = super::super::types::UsageRecord {
            id: "response:one".into(),
            tool: "codex".into(),
            timestamp_ms: 1000,
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 80,
            ..Default::default()
        };
        conn.execute("INSERT INTO monitor_requests VALUES('codex','response:one','codex:old-session',1000,?1,'{}')",
            [serde_json::to_string(&usage).unwrap()]).unwrap();
        use super::super::request_accounts::{AccountMatch, EvidenceIndex};
        assert!(matches!(
            EvidenceIndex::load(&conn).unwrap().account_for(&usage),
            AccountMatch::None
        ));
        save_authenticated(&conn, Path::new("fixture"), "new-login", &payload, 1000).unwrap();
        assert!(matches!(
            EvidenceIndex::load(&conn).unwrap().account_for(&usage),
            AccountMatch::None
        ));
        save_authenticated(&conn, Path::new("fixture"), "other-login", &payload, 2000).unwrap();
        assert!(matches!(
            EvidenceIndex::load(&conn).unwrap().account_for(&usage),
            AccountMatch::None
        ));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(DISTINCT account_key) FROM monitor_codex_quota_accounts",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row(
                "SELECT reset_ms FROM monitor_request_quota_evidence",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            700000000
        );
        assert!(request_quotas(
            &serde_json::json!({"rate_limits":{"limit_id":"other","plan_type":"pro",
            "primary":{"window_minutes":10080,"resets_at":700000}}}),
            "x"
        )
        .is_empty());
    }
    #[test]
    fn a_five_hour_only_official_plan_is_not_dropped_without_a_weekly_window() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        save_authenticated(&conn, Path::new("fixture"), "short-plan", &serde_json::json!({
            "plan_type":"free","rate_limit":{"primary_window":{
                "limit_window_seconds":18000,"reset_at":19000,"used_percent":40}}}), 1_000_000).unwrap();
        let report = super::super::quota::read(&conn, 1_000_001).unwrap();
        assert_eq!(report.quotas.len(), 1);
        let quota = &report.quotas[0];
        assert_eq!((quota.window_minutes, quota.used_percent, quota.remaining_percent), (Some(300), Some(40.0), Some(60.0)));
        assert_eq!(quota.billing_account_verified, Some(true));
        assert_eq!(quota.source, "codex_official_usage");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_codex_quota_accounts", [], |r|r.get::<_,i64>(0)).unwrap(), 0);
    }

    #[test]
    fn matching_plan_reset_and_home_do_not_identify_the_account_inside_or_outside_the_cycle() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let payload = serde_json::json!({"plan_type":"pro","rate_limit":{"primary_window":{
            "limit_window_seconds":604800,"reset_at":700000,"used_percent":20}}});
        save_authenticated(&conn, Path::new("fixture"), "current-login", &payload, 600_000_000).unwrap();
        for (id, time) in [("old-request", 1000), ("same-cycle-request", 600_001_000)] {
            save_requests(&conn, Path::new("fixture/sessions/chat.jsonl"), &[RequestQuota {
                id:id.into(),reset_ms:700_000_000,plan:"pro".into(),
            }]).unwrap();
            let usage = super::super::types::UsageRecord {
                id:id.into(),tool:"codex".into(),timestamp_ms:time,
                input_tokens:100,output_tokens:20,cache_read_tokens:80,..Default::default()
            };
            conn.execute("INSERT INTO monitor_requests VALUES('codex',?1,'codex:chat',?2,?3,'{}')",
                params![id,time,serde_json::to_string(&usage).unwrap()]).unwrap();
            assert!(matches!(super::super::request_accounts::EvidenceIndex::load(&conn).unwrap().account_for(&usage),
                super::super::request_accounts::AccountMatch::None));
        }
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
        assert!(super::super::request_accounts::EvidenceIndex::load(&conn).unwrap().account_bounds().is_empty());
    }

    #[test]
    fn unavailable_subscription_is_unknown_and_queue_delay_does_not_refresh_its_evidence_time() {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        let active = serde_json::json!({"accounts":{"a":{"account":{"account_id":"a"},"entitlement":{
            "has_active_subscription":true,"billing_period":"monthly","renews_at":"2026-11-01T00:00:00Z"}}}});
        super::super::accounts::save_official_subscription(&conn, "a", &active, 1000).unwrap();
        let mut reader = Reader::new();
        reader.sender.send(OfficialQuota {
            home: PathBuf::from("fixture"), account: "a".into(), observed_ms: 2000,
            payload: Err("Quota unavailable".into()), subscription: Some(Err("Subscription unavailable".into())),
        }).unwrap();
        reader.collect(&conn, &[], 500_000).unwrap();
        let read = || -> Value { serde_json::from_str(&conn.query_row(
            "SELECT data FROM monitor_state WHERE key='account_billing_cycle:account:a'", [], |r|r.get::<_,String>(0)).unwrap()).unwrap() };
        let unknown = read();
        assert!(unknown["renewalAtMs"].is_null());
        assert!(unknown["active"].is_null());
        assert!(unknown["error"].is_string());
        assert_eq!(unknown["checkedAtMs"], 2000);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_state WHERE key GLOB 'account_billing_cycle_history:*'", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
        reader.sender.send(OfficialQuota {
            home: PathBuf::from("fixture"), account: "a".into(), observed_ms: 3000,
            payload: Err("Quota unavailable".into()), subscription: Some(Ok(active)),
        }).unwrap();
        reader.collect(&conn, &[], 600_000).unwrap();
        let restored = read();
        assert_eq!(restored["active"], true);
        assert_eq!(restored["billingPeriod"], "monthly");
        assert_eq!(restored["checkedAtMs"], 3000);
        assert!(restored["error"].is_null());
    }

}
