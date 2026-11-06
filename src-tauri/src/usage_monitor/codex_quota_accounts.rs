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
                if let Err(error) = subscription.and_then(|payload| super::accounts::save_official_subscription(conn,&result.account,&payload,now)) {
                    eprintln!("Official Codex subscription unavailable: {error}");
                }
            }
            match result.payload {
                Ok(payload) => {
                    save_authenticated(conn, &result.home, &result.account, &payload, result.observed_ms)?
                }
                Err(error) => eprintln!("Official Codex account quota unavailable: {error}"),
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
        let reset = window["reset_at"]
            .as_i64()
            .and_then(|v| v.checked_mul(1000))
            .filter(|v| *v > now)
            .ok_or("Official weekly quota has no valid reset time")?;
        tx.execute("INSERT INTO monitor_codex_quota_accounts(home,reset_ms,plan,account_key,observed_ms)
            VALUES(?1,?2,?3,?4,?5) ON CONFLICT(home,reset_ms,plan,account_key) DO UPDATE SET observed_ms=excluded.observed_ms",
            params![home.to_string_lossy(),reset,plan,format!("account:{account}"),now]).map_err(|e| e.to_string())?;
        super::quota::save_authenticated_codex(&tx, account, payload, now)?;
    }
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
    fn superseded_creator_quota_keeps_its_id_but_is_not_a_second_live_account() {
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
        assert_eq!(report.quotas.len(), 1);
        assert_eq!(report.quotas[0].billing_account_verified, Some(true));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM monitor_quotas WHERE id=1 AND account_key='account:creator'",
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
    fn authenticated_cycle_is_not_the_session_creator_and_collisions_are_not_merged() {
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
            AccountMatch::Verified("account:new-login")
        ));
        save_authenticated(&conn, Path::new("fixture"), "other-login", &payload, 2000).unwrap();
        assert!(matches!(
            EvidenceIndex::load(&conn).unwrap().account_for(&usage),
            AccountMatch::Conflict
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
}
