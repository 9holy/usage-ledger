use super::{request_accounts::AccountMatch, types::UsageRecord};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(super) struct ClaudeOwner {
    pub session: String,
    pub account: String,
    pub organization: Option<String>,
}

pub(super) fn claude_account_key(account: &str, organization: Option<&str>) -> String {
    match organization.filter(|value| !value.is_empty()) {
        Some(organization) => format!("account:{account}:organization:{organization}"),
        None => format!("account:{account}"),
    }
}

#[derive(Debug)]
pub(super) struct ClaudeContext {
    pub reference: String,
    pub session: String,
    pub kind: &'static str,
    pub account: Option<String>,
}

#[derive(Debug)]
pub(super) struct ClaudeLink {
    pub id: String,
    pub reference: String,
    pub session: String,
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS monitor_claude_request_identity (
      source TEXT NOT NULL,reference TEXT NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,
      account_key TEXT,conflicted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(source,reference));
      CREATE TABLE IF NOT EXISTS monitor_request_identity (
      tool TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,kind TEXT NOT NULL,
      account_key TEXT,conflicted INTEGER NOT NULL DEFAULT 0,reference TEXT NOT NULL,native_session TEXT NOT NULL,
      PRIMARY KEY(tool,id,source));
      CREATE INDEX IF NOT EXISTS monitor_request_identity_account ON monitor_request_identity(tool,account_key);").map_err(|e|e.to_string())
}

pub(super) fn save_context(
    conn: &rusqlite::Transaction<'_>,
    source: &str,
    value: &ClaudeContext,
) -> Result<(), String> {
    conn.prepare_cached("INSERT INTO monitor_claude_request_identity(source,reference,session_id,kind,account_key)
      VALUES(?1,?2,?3,?4,?5) ON CONFLICT(source,reference) DO UPDATE SET
      conflicted=conflicted OR session_id<>excluded.session_id OR kind<>excluded.kind
        OR (account_key IS NOT NULL AND excluded.account_key IS NOT NULL AND account_key<>excluded.account_key),
      account_key=COALESCE(account_key,excluded.account_key)")
      .map_err(|e|e.to_string())?.execute(params![source,value.reference,value.session,value.kind,value.account]).map_err(|e|e.to_string())?;
    let links = {
        let mut query=conn.prepare_cached("SELECT id FROM monitor_request_identity WHERE tool='claude' AND source=?1 AND reference=?2 AND native_session=?3").map_err(|e|e.to_string())?;
        let rows = query
            .query_map(params![source, value.reference, value.session], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for id in links {
        if save_link(
            conn,
            source,
            &ClaudeLink {
                id: id.clone(),
                reference: value.reference.clone(),
                session: value.session.clone(),
            },
        )? {
            super::billing::repair_request(conn, "claude", &id)?;
        }
    }
    Ok(())
}

pub(super) fn save_link(
    conn: &Connection,
    source: &str,
    value: &ClaudeLink,
) -> Result<bool, String> {
    let context: Option<(String, Option<String>, bool)> = conn
        .prepare_cached(
            "SELECT kind,account_key,conflicted FROM monitor_claude_request_identity
       WHERE source=?1 AND reference=?2 AND session_id=?3",
        )
        .map_err(|e| e.to_string())?
        .query_row(params![source, value.reference, value.session], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let (kind, account, conflicted) = context.unwrap_or_else(|| ("unknown".into(), None, false));
    let changed=conn.prepare_cached("INSERT INTO monitor_request_identity(tool,id,source,kind,account_key,conflicted,reference,native_session)
      VALUES('claude',?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(tool,id,source) DO UPDATE SET
      conflicted=monitor_request_identity.conflicted OR excluded.conflicted
        OR (kind<>'unknown' AND excluded.kind<>'unknown' AND kind<>excluded.kind)
        OR reference<>excluded.reference OR native_session<>excluded.native_session
        OR (account_key IS NOT NULL AND excluded.account_key IS NOT NULL AND account_key<>excluded.account_key),
      account_key=COALESCE(account_key,excluded.account_key),kind=CASE WHEN kind='unknown' THEN excluded.kind ELSE kind END
      WHERE (excluded.kind<>'unknown' AND kind<>excluded.kind) OR reference<>excluded.reference OR native_session<>excluded.native_session
        OR (account_key IS NULL AND excluded.account_key IS NOT NULL)
        OR (account_key IS NOT NULL AND excluded.account_key IS NOT NULL AND account_key<>excluded.account_key)
        OR (excluded.conflicted AND NOT monitor_request_identity.conflicted)")
      .map_err(|e|e.to_string())?.execute(params![value.id,source,kind,account,conflicted,value.reference,value.session]).map_err(|e|e.to_string())?;
    Ok(changed > 0)
}

pub(super) enum KindMatch {
    Missing,
    Known(String),
    Conflict,
}

pub(super) fn kind(conn: &Connection, tool: &str, id: &str) -> Result<KindMatch, String> {
    let mut query = conn
        .prepare_cached(
            "SELECT DISTINCT kind,conflicted FROM monitor_request_identity WHERE tool=?1 AND id=?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map(params![tool, id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut kinds = BTreeSet::new();
    let mut conflict = false;
    for row in rows {
        let (kind, bad) = row.map_err(|e| e.to_string())?;
        if kind != "unknown" {
            kinds.insert(kind);
        }
        conflict |= bad;
    }
    if kinds.is_empty() && !conflict {
        return Ok(KindMatch::Missing);
    }
    Ok(if !conflict && kinds.len() == 1 {
        KindMatch::Known(kinds.pop_first().unwrap())
    } else {
        KindMatch::Conflict
    })
}

pub(super) fn native_accounts(conn: &Connection, tool: &str) -> Result<Vec<String>, String> {
    let aliases = super::account_names::native_keys(conn, tool)?;
    let mut query = conn
        .prepare(
            "SELECT DISTINCT account_key FROM monitor_request_identity
      WHERE tool=?1 AND kind='subscription' AND account_key IS NOT NULL AND NOT conflicted",
        )
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map([tool], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let key = row.map_err(|e| e.to_string())?;
        Ok(aliases.get(&key).cloned().unwrap_or(key))
    })
    .collect()
}

pub(super) struct Owners(BTreeMap<(String, String), Option<String>>);
impl Owners {
    pub fn load(conn: &Connection, ids: Option<&str>) -> Result<Self, String> {
        let aliases = super::account_names::native_keys(conn, "claude")?;
        let filter = if ids.is_some() {
            " AND id IN (SELECT value FROM json_each(?1))"
        } else {
            ""
        };
        let mut query=conn.prepare(&format!("SELECT tool,id,kind,account_key,conflicted FROM monitor_request_identity WHERE tool='claude'{filter}")).map_err(|e|e.to_string())?;
        let rows = query
            .query_map(rusqlite::params_from_iter(ids), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, bool>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut groups = BTreeMap::<_, (BTreeSet<String>, BTreeSet<String>, bool)>::new();
        for row in rows {
            let (tool, id, kind, account, conflict) = row.map_err(|e| e.to_string())?;
            let group = groups.entry((tool, id)).or_default();
            if kind != "unknown" {
                group.0.insert(kind);
            }
            if let Some(account) = account {
                group
                    .1
                    .insert(aliases.get(&account).cloned().unwrap_or(account));
            }
            group.2 |= conflict;
        }
        Ok(Self(
            groups
                .into_iter()
                .filter_map(|(key, (kinds, mut accounts, conflict))| {
                    if !conflict && kinds.len() == 1 && kinds.contains("api") {
                        return None;
                    }
                    if !conflict && accounts.is_empty() {
                        return None;
                    }
                    Some((
                        key,
                        (!conflict && kinds.len() == 1 && accounts.len() == 1)
                            .then(|| accounts.pop_first().unwrap()),
                    ))
                })
                .collect(),
        ))
    }
    pub fn account_for(&self, usage: &UsageRecord) -> AccountMatch<'_> {
        match self.0.get(&(usage.tool.clone(), usage.id.clone())) {
            Some(Some(account)) => AccountMatch::Verified(account),
            Some(None) => AccountMatch::Conflict,
            None => AccountMatch::None,
        }
    }
    pub(super) fn contains_account(&self, tool:&str, account:&str)->bool {
        self.0.iter().any(|((source,_),owner)|source==tool&&owner.as_deref()==Some(account))
    }
}

pub(super) fn repair_link(
    conn: &rusqlite::Transaction<'_>,
    source: &str,
    link: &ClaudeLink,
    usage: &UsageRecord,
) -> Result<(), String> {
    let saved: Option<String> = conn
        .prepare_cached("SELECT usage FROM monitor_requests WHERE tool='claude' AND id=?1")
        .map_err(|e| e.to_string())?
        .query_row([&usage.id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(saved) = saved else { return Ok(()) };
    let saved: UsageRecord = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
    if (
        saved.session_id,
        saved.timestamp_ms,
        saved.model,
        saved.input_tokens,
        saved.output_tokens,
        saved.cache_read_tokens,
        saved.cache_write_tokens,
    ) != (
        usage.session_id.clone(),
        usage.timestamp_ms,
        usage.model.clone(),
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.cache_write_tokens,
    ) {
        return Ok(());
    }
    if save_link(conn, source, link)? {
        super::billing::repair_request(conn, "claude", &usage.id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_monitor::{collector, parser, store};
    use serde_json::json;
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ledger-auth-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn assistant(id: &str, reference: &str, time: &str, output: i64) -> serde_json::Value {
        json!({"type":"assistant","sessionId":"native-session","timestamp":time,"requestRef":reference,"message":{"id":id,"model":"claude-opus-5-5","usage":{"input_tokens":60,"cache_read_input_tokens":40,"cache_creation_input_tokens":0,"output_tokens":output,"service_tier":"default"}}})
    }
    fn context(id: &str, oauth: bool) -> serde_json::Value {
        json!({"type":"api-request","sessionId":"native-session","id":id,"params":{"betas":if oauth{vec!["oauth-2025-04-20"]}else{vec![]}}})
    }
    fn ingest(conn: &mut Connection, path: &std::path::Path, rows: Vec<serde_json::Value>) {
        fs::write(
            path,
            rows.into_iter()
                .map(|row| format!("{row}\n"))
                .collect::<String>(),
        )
        .unwrap();
        while collector::ingest_file(conn, "claude", path, 0).unwrap() {}
    }
    #[test]
    fn exact_native_request_links_keep_oauth_api_switches_and_all_account_views_consistent() {
        let fixture = Fixture::new();
        let path = fixture.0.join("session.jsonl");
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        conn.execute("INSERT INTO monitor_account_native_keys VALUES('claude','account:owner-a','cockpit:stable')",[]).unwrap();
        conn.execute(
            "INSERT INTO monitor_account_profiles VALUES('claude','cockpit:stable','Example A',0)",
            [],
        )
        .unwrap();
        ingest(
            &mut conn,
            &path,
            vec![
                json!({"type":"session-owner","sessionId":"native-session","accountUuid":"owner-a"}),
                context("sub", true),
                assistant("sub", "sub", "2026-11-01T00:00:00Z", 20),
                context("api", false),
                assistant("api", "api", "2026-11-01T00:00:01Z", 30),
                json!({"type":"session-owner","sessionId":"native-session","accountUuid":"owner-b"}),
                context("other", true),
                assistant("other", "other", "2026-11-01T00:00:02Z", 40),
            ],
        );
        let read = |id: &str| {
            conn.query_row(
                "SELECT usage FROM monitor_requests WHERE tool='claude' AND id=?1",
                [format!("claude:message:{id}")],
                |r| r.get::<_, String>(0),
            )
            .unwrap()
        };
        let requests = ["sub", "api", "other"]
            .map(|id| serde_json::from_str::<UsageRecord>(&read(id)).unwrap());
        assert_eq!(
            requests
                .iter()
                .map(|r| r.billing_scope.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("subscription"), Some("api"), Some("subscription")]
        );
        let members =
            crate::usage_monitor::accounts::request_memberships(&conn, &requests).unwrap();
        assert_eq!(
            members[0].2,
            crate::usage_monitor::quota::report_account_key("claude", "cockpit:stable")
        );
        assert_eq!(members[1].2, "api:all");
        assert_ne!(members[0].2, members[2].2);
        let (rows, _, _) =
            crate::usage_monitor::accounts::local_cost_usage(&conn, 0, 2_000_000_000_000).unwrap();
        assert_eq!(
            rows.iter().map(|row| row.totals.request_count).sum::<i64>(),
            3
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.id == "api:all")
                .unwrap()
                .totals
                .output_tokens,
            30
        );
        assert_eq!(
            rows.iter()
                .find(|row| row.id == members[0].2)
                .unwrap()
                .totals
                .output_tokens,
            20
        );
        let mut foreign = requests[0].clone();
        foreign.tool = "codex".into();
        assert!(matches!(
            kind(&conn, "codex", &foreign.id).unwrap(),
            KindMatch::Missing
        ));
        let before = crate::usage_monitor::live::read_scoped(
            &conn,
            crate::ledger_db::now_ms(),
            0,
            crate::ledger_db::now_ms(),
            Some("api"),
        )
        .unwrap();
        assert_eq!(before.windows[0].observed_output_tokens, 30);
    }
    #[test]
    fn pending_context_is_resolved_durably_and_a_different_native_session_cannot_claim_it() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let usage = UsageRecord {
            tool: "claude".into(),
            id: "late".into(),
            session_id: "native-session".into(),
            timestamp_ms: 1000,
            ..Default::default()
        };
        let cost = serde_json::to_string(&crate::usage_monitor::types::CostEstimate {
            usd: Some(7.),
            ..Default::default()
        })
        .unwrap();
        conn.execute("INSERT INTO monitor_requests VALUES('claude','late','claude:native-session',1000,?1,?2)",params![serde_json::to_string(&usage).unwrap(),cost]).unwrap();
        let tx = conn.transaction().unwrap();
        let link = ClaudeLink {
            id: "late".into(),
            reference: "ref".into(),
            session: "native-session".into(),
        };
        save_link(&tx, "source", &link).unwrap();
        assert!(matches!(
            kind(&tx, "claude", "late").unwrap(),
            KindMatch::Missing
        ));
        save_context(
            &tx,
            "source",
            &ClaudeContext {
                reference: "ref".into(),
                session: "foreign".into(),
                kind: "subscription",
                account: Some("account:wrong".into()),
            },
        )
        .unwrap();
        assert!(matches!(
            kind(&tx, "claude", "late").unwrap(),
            KindMatch::Missing
        ));
        tx.execute("DELETE FROM monitor_claude_request_identity", [])
            .unwrap();
        save_context(
            &tx,
            "source",
            &ClaudeContext {
                reference: "ref".into(),
                session: "native-session".into(),
                kind: "api",
                account: None,
            },
        )
        .unwrap();
        assert!(matches!(kind(&tx,"claude","late").unwrap(),KindMatch::Known(kind)if kind=="api"));
        tx.commit().unwrap();
        assert_eq!(
            conn.query_row(
                "SELECT json_extract(usage,'$.billingScope'),cost FROM monitor_requests",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            )
            .unwrap(),
            ("api".into(), cost)
        );
        let tx = conn.transaction().unwrap();
        save_context(
            &tx,
            "source",
            &ClaudeContext {
                reference: "ref".into(),
                session: "native-session".into(),
                kind: "subscription",
                account: Some("account:conflict".into()),
            },
        )
        .unwrap();
        assert!(matches!(
            kind(&tx, "claude", "late").unwrap(),
            KindMatch::Conflict
        ));
        tx.commit().unwrap();
    }
    #[test]
    fn historical_identity_replay_never_reprices_partial_messages_or_changes_the_usage_cursor() {
        let fixture = Fixture::new();
        let path = fixture.0.join("session.jsonl");
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        ingest(
            &mut conn,
            &path,
            vec![
                json!({"type":"session-owner","sessionId":"native-session","accountUuid":"owner-a"}),
                context("ref", true),
                assistant("one", "ref", "2026-11-01T00:00:00Z", 1),
                assistant("one", "ref", "2026-11-01T00:00:01Z", 20),
            ],
        );
        let quote = serde_json::to_string(&crate::usage_monitor::types::CostEstimate {
            usd: Some(123.456),
            ..Default::default()
        })
        .unwrap();
        conn.execute(
            "UPDATE monitor_requests SET usage=json_remove(usage,'$.billingScope'),cost=?1",
            [&quote],
        )
        .unwrap();
        conn.execute_batch("DELETE FROM monitor_request_identity;DELETE FROM monitor_claude_request_identity;UPDATE monitor_files SET state=json_remove(state,'$.identity_replayed','$.claude_owner');").unwrap();
        let before: (i64, String) = conn
            .query_row("SELECT offset,signature FROM monitor_files", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert!(collector::replay_claude_identities(&mut conn)
            .unwrap()
            .is_empty());
        assert!(collector::replay_claude_identities(&mut conn)
            .unwrap()
            .is_empty());
        assert_eq!(
            conn.query_row("SELECT offset,signature FROM monitor_files", [], |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?
            )))
            .unwrap(),
            before
        );
        assert_eq!(conn.query_row("SELECT json_extract(usage,'$.outputTokens'),cost,json_extract(usage,'$.billingScope') FROM monitor_requests",[],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap(),(20,quote,"subscription".into()));
        fs::remove_file(path).unwrap();
        assert!(
            matches!(kind(&conn,"claude","claude:message:one").unwrap(),KindMatch::Known(value)if value=="subscription")
        );
    }
    #[test]
    fn a_creator_or_owner_without_a_matching_native_request_does_not_classify_an_api_call() {
        let mut state = parser::ParserState::default();
        let path = std::path::Path::new("session.jsonl");
        parser::parse_line(
            &mut state,
            "claude",
            path,
            &json!({"type":"session-owner","sessionId":"native-session","accountUuid":"old-owner"})
                .to_string(),
            0,
        )
        .unwrap();
        let missing = parser::parse_line(
            &mut state,
            "claude",
            path,
            &assistant("unknown", "missing", "2026-11-01T00:00:00Z", 20).to_string(),
            0,
        )
        .unwrap();
        assert!(missing.identity_contexts.is_empty());
        assert!(missing.usage[0].billing_scope.is_none());
        let api = parser::parse_line(
            &mut state,
            "claude",
            path,
            &context("api", false).to_string(),
            0,
        )
        .unwrap();
        assert_eq!(api.identity_contexts[0].kind, "api");
        assert!(api.identity_contexts[0].account.is_none());
    }
    #[test]
    fn the_same_claude_user_in_different_organizations_is_not_one_billing_account() {
        let mut state = parser::ParserState::default();
        let path = std::path::Path::new("session.jsonl");
        let mut keys = Vec::new();
        for organization in ["personal", "team"] {
            parser::parse_line(&mut state,"claude",path,&json!({"type":"session-owner","sessionId":"native-session","accountUuid":"same-user","organizationUuid":organization}).to_string(),0).unwrap();
            let parsed = parser::parse_line(
                &mut state,
                "claude",
                path,
                &context(organization, true).to_string(),
                0,
            )
            .unwrap();
            keys.push(parsed.identity_contexts[0].account.clone().unwrap());
        }
        assert_ne!(keys[0], keys[1]);
    }
}
