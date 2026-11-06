use super::types::UsageRecord;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    super::codex_quota_accounts::initialize(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS monitor_request_account_evidence (
        source TEXT NOT NULL,log_id INTEGER NOT NULL,session_id TEXT NOT NULL,
        account_key TEXT NOT NULL,model TEXT NOT NULL,requested_model TEXT,
        started_ms INTEGER NOT NULL,finished_ms INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,cached_tokens INTEGER NOT NULL,
        PRIMARY KEY(source,log_id,session_id));
        CREATE INDEX IF NOT EXISTS monitor_request_account_identity
          ON monitor_request_account_evidence(account_key);",
    )
    .map_err(|e| e.to_string())
}

pub(super) fn collect(conn: &mut Connection, now: i64) -> Result<usize, String> {
    let path = crate::cockpit_logs_db::request_log_db_path()?;
    if !path.exists() {
        return Ok(0);
    }
    let source = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    collect_from(conn, &source, &path.to_string_lossy(), now)
}

pub(super) fn collect_from(
    conn: &mut Connection,
    source: &Connection,
    name: &str,
    now: i64,
) -> Result<usize, String> {
    let key = format!("request_account_cursor:{:x}", md5::compute(name));
    let last: Option<String> = conn
        .query_row("SELECT data FROM monitor_state WHERE key=?1", [&key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let last = last.and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    let high: i64 = source
        .query_row("SELECT COALESCE(MAX(id),0) FROM request_logs", [], |r| {
            r.get(0)
        })
        .map_err(|e| e.to_string())?;
    let last = if high < last { 0 } else { last };
    // Revisit recent rows because diagnostics or local usage may arrive after the proxy row.
    let mut statement = source
        .prepare(
            "SELECT r.id,r.timestamp,r.latency_ms,r.input_tokens,r.output_tokens,
        r.cached_tokens,r.model_id,r.requested_model,r.official_account_id,
        d.client_thread_id,d.client_session_id,l.effective_session_id
        FROM request_logs r LEFT JOIN request_diagnostics d ON d.request_id=r.request_id
        LEFT JOIN request_session_lookup l ON l.request_id=r.request_id
        WHERE (r.id>?1 OR r.timestamp>=?2) AND r.success=1
          AND r.official_account_id IS NOT NULL AND r.official_account_id<>''",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![last, now.saturating_sub(600_000)], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, String>(8)?,
                [
                    r.get::<_, Option<String>>(9)?,
                    r.get::<_, Option<String>>(11)?,
                    r.get::<_, Option<String>>(10)?,
                ],
            ))
        })
        .map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut count = 0;
    for row in rows {
        let (id, started, duration, input, output, cached, model, requested, account, sessions) =
            row.map_err(|e| e.to_string())?;
        if account.trim().is_empty()
            || input < cached
            || input < 0
            || cached < 0
            || output < 0
            || duration < 0
        {
            continue;
        }
        let Some(finished) = started
            .checked_add(duration)
            .and_then(|v| v.checked_add(3000))
        else {
            continue;
        };
        for session in sessions
            .into_iter()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .take(1)
        {
            count += tx.execute("INSERT INTO monitor_request_account_evidence VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                ON CONFLICT(source,log_id,session_id) DO UPDATE SET
                account_key=excluded.account_key,model=excluded.model,requested_model=excluded.requested_model,
                started_ms=excluded.started_ms,finished_ms=excluded.finished_ms,
                input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens
                WHERE account_key<>excluded.account_key OR model<>excluded.model OR requested_model IS NOT excluded.requested_model
                  OR started_ms<>excluded.started_ms OR finished_ms<>excluded.finished_ms
                  OR input_tokens<>excluded.input_tokens OR output_tokens<>excluded.output_tokens OR cached_tokens<>excluded.cached_tokens",
                params![name,id,session,format!("account:{account}"),model,requested,started.saturating_sub(1000),finished,input,output,cached])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.execute("INSERT INTO monitor_state(key,data) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        params![key,high.to_string()]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

struct Evidence {
    source: String,
    log_id: i64,
    account: String,
    model: String,
    requested: Option<String>,
    start: i64,
    end: i64,
    monitor_id: Option<String>,
}

type Fingerprint = (String, i64, i64, i64);
pub(super) struct EvidenceIndex {
    proxy: BTreeMap<Fingerprint, Vec<Evidence>>,
    quota: BTreeMap<String, (BTreeSet<String>, i64)>,
}

pub(super) enum AccountMatch<'a> {
    None,
    Conflict,
    Verified(&'a str),
}

impl EvidenceIndex {
    pub(super) fn api_request_ids(&self)->BTreeSet<String>{
        self.proxy.values().flatten().filter_map(|row|row.monitor_id.clone()).collect()
    }
    pub(super) fn account_bounds(&self) -> BTreeMap<String, (i64, i64)> {
        let mut bounds: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for evidence in self.proxy.values().flatten().filter(|row| row.monitor_id.is_some()) {
            let range = bounds.entry(evidence.account.clone()).or_insert((evidence.start,evidence.end));
            range.0=range.0.min(evidence.start);
            range.1=range.1.max(evidence.end.saturating_add(1));
        }
        let proxy_ids:BTreeSet<_>=self.proxy.values().flatten().filter_map(|row|row.monitor_id.as_deref()).collect();
        for (id,(accounts, time)) in self.quota.iter().filter(|(_, (accounts,_))| accounts.len()==1) {
            if proxy_ids.contains(id.as_str()) { continue; }
            let range = bounds.entry(accounts.first().unwrap().clone()).or_insert((*time,*time+1));
            range.0=range.0.min(*time);
            range.1=range.1.max(*time+1);
        }
        bounds
    }

    pub(super) fn load(conn: &Connection) -> Result<Self, String> {
        let mut index: BTreeMap<Fingerprint, Vec<Evidence>> = BTreeMap::new();
        let mut statement = conn.prepare("SELECT source,log_id,session_id,account_key,model,requested_model,
            started_ms,finished_ms,input_tokens,output_tokens,cached_tokens FROM monitor_request_account_evidence")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    (r.get(2)?, r.get(8)?, r.get(9)?, r.get(10)?),
                    Evidence {
                        source: r.get(0)?,
                        log_id: r.get(1)?,
                        account: r.get(3)?,
                        model: r.get(4)?,
                        requested: r.get(5)?,
                        start: r.get(6)?,
                        end: r.get(7)?,
                        monitor_id: None,
                    },
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (key, evidence) = row.map_err(|e| e.to_string())?;
            index.entry(key).or_default().push(evidence);
        }
        let mut usage_rows = conn.prepare("SELECT usage FROM monitor_requests WHERE session_key=?1 AND timestamp_ms>=?2 AND timestamp_ms<=?3")
            .map_err(|e| e.to_string())?;
        for (key, records) in &mut index {
            for evidence in records {
                let mut ids = BTreeSet::new();
                let rows = usage_rows
                    .query_map(
                        params![format!("codex:{}", key.0), evidence.start, evidence.end],
                        |r| r.get::<_, String>(0),
                    )
                    .map_err(|e| e.to_string())?;
                for row in rows {
                    let usage: UsageRecord = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                    if valid_usage(&usage)
                        && (
                            usage.input_tokens,
                            usage.output_tokens,
                            usage.cache_read_tokens,
                        ) == (key.1, key.2, key.3)
                        && usage.model.as_deref().is_some_and(|model| {
                            model == evidence.model || Some(model) == evidence.requested.as_deref()
                        })
                    {
                        ids.insert(usage.id);
                    }
                }
                if ids.len() == 1 {
                    evidence.monitor_id = ids.into_iter().next();
                }
            }
        }
        let mut quota = BTreeMap::<String,(BTreeSet<String>,i64)>::new();
        let mut query = conn.prepare("SELECT r.id,r.timestamp_ms,a.account_key FROM monitor_request_quota_evidence e
            JOIN monitor_codex_quota_accounts a ON a.home=e.home AND a.reset_ms=e.reset_ms AND a.plan=e.plan
            JOIN monitor_requests r ON r.tool='codex' AND r.id=e.id")
            .map_err(|e|e.to_string())?;
        let rows = query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?)))
            .map_err(|e|e.to_string())?;
        for row in rows {
            let (id,time,account)=row.map_err(|e|e.to_string())?;
            quota.entry(id).or_insert_with(||(BTreeSet::new(),time)).0.insert(account);
        }
        Ok(Self { proxy:index, quota })
    }

    pub(super) fn account_for(&self, usage: &UsageRecord) -> AccountMatch<'_> {
        if !valid_usage(usage) {
            return AccountMatch::None;
        }
        match self.proxy_account_for(usage) {
            AccountMatch::None => {},
            matched => return matched,
        }
        match self.quota.get(&usage.id) {
            Some((accounts,_)) if accounts.len()==1 => AccountMatch::Verified(accounts.first().unwrap()),
            Some(_) => AccountMatch::Conflict,
            None => AccountMatch::None,
        }
    }

    fn proxy_account_for(&self, usage: &UsageRecord) -> AccountMatch<'_> {
        let Some(rows) = self.proxy.get(&(
            usage.session_id.clone(),
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_tokens,
        )) else {
            return AccountMatch::None;
        };
        let mut matches = rows.iter().filter(|r| {
            r.monitor_id.as_deref() == Some(usage.id.as_str())
                && usage.timestamp_ms >= r.start
                && usage.timestamp_ms <= r.end
                && usage
                    .model
                    .as_deref()
                    .is_some_and(|model| model == r.model || Some(model) == r.requested.as_deref())
        });
        let Some(first) = matches.next() else {
            return AccountMatch::None;
        };
        if matches.any(|r| r.source != first.source || r.log_id != first.log_id) {
            return AccountMatch::Conflict;
        }
        AccountMatch::Verified(&first.account)
    }
}

fn valid_usage(usage: &UsageRecord) -> bool {
    usage.tool == "codex"
        && usage.cache_write_tokens == 0
        && !usage.unknown_fields.iter().any(|s| {
            matches!(
                s.as_str(),
                "timestamp"
                    | "input_tokens"
                    | "output_tokens"
                    | "cache_read_tokens"
                    | "cache_write_tokens"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE request_logs(id INTEGER PRIMARY KEY,request_id TEXT,timestamp INTEGER,latency_ms INTEGER,
          input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,model_id TEXT,requested_model TEXT,official_account_id TEXT,success INTEGER);
          CREATE TABLE request_diagnostics(request_id TEXT,client_thread_id TEXT,client_session_id TEXT);
          CREATE TABLE request_session_lookup(request_id TEXT,effective_session_id TEXT);
          INSERT INTO request_logs VALUES(1,'r1',10000,2000,100,20,80,'gpt-6.1-sol',NULL,'actual',1);
          INSERT INTO request_diagnostics VALUES('r1','thread','root-thread');").unwrap();
        conn
    }

    #[test]
    fn exact_account_evidence_is_incremental_private_and_keeps_unknowns_unknown() {
        let mut ledger = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&ledger).unwrap();
        let source = source();
        assert_eq!(
            collect_from(&mut ledger, &source, "fixture", 14000).unwrap(),
            1
        );
        assert_eq!(
            collect_from(&mut ledger, &source, "fixture", 14000).unwrap(),
            0
        );
        let mut usage = UsageRecord {
            id: "response:one".into(),
            tool: "codex".into(),
            session_id: "thread".into(),
            model: Some("gpt-6.1-sol".into()),
            timestamp_ms: 12000,
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 80,
            ..Default::default()
        };
        ledger
            .execute(
                "INSERT INTO monitor_requests VALUES('codex',?1,'codex:thread',12000,?2,'{}')",
                params![usage.id, serde_json::to_string(&usage).unwrap()],
            )
            .unwrap();
        assert!(matches!(
            EvidenceIndex::load(&ledger).unwrap().account_for(&usage),
            AccountMatch::Verified("account:actual")
        ));
        for field in ["timestamp", "cache_read_tokens"] {
            usage.unknown_fields = vec![field.into()];
            assert!(matches!(
                EvidenceIndex::load(&ledger).unwrap().account_for(&usage),
                AccountMatch::None
            ));
        }
        usage.unknown_fields.clear();
        usage.timestamp_ms = 16000;
        assert!(matches!(
            EvidenceIndex::load(&ledger).unwrap().account_for(&usage),
            AccountMatch::None
        ));
        usage.timestamp_ms = 12000;
        source.execute_batch("INSERT INTO request_logs SELECT 2,'r2',timestamp,latency_ms,input_tokens,output_tokens,cached_tokens,
            model_id,requested_model,'other',success FROM request_logs WHERE id=1;
            INSERT INTO request_diagnostics VALUES('r2','thread',NULL);").unwrap();
        collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
        assert!(matches!(
            EvidenceIndex::load(&ledger).unwrap().account_for(&usage),
            AccountMatch::Conflict
        ));
        assert_eq!(
            ledger
                .query_row("SELECT COUNT(*) FROM monitor_requests", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        usage.id = "response:two".into();
        ledger
            .execute(
                "INSERT INTO monitor_requests VALUES('codex',?1,'codex:thread',12000,?2,'{}')",
                params![usage.id, serde_json::to_string(&usage).unwrap()],
            )
            .unwrap();
        assert!(matches!(
            EvidenceIndex::load(&ledger).unwrap().account_for(&usage),
            AccountMatch::None
        ));
    }
}
