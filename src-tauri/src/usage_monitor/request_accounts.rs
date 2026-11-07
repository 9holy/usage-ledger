use super::types::UsageRecord;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
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
          ON monitor_request_account_evidence(account_key);
        CREATE TABLE IF NOT EXISTS monitor_request_account_source_rows (
          source TEXT NOT NULL,log_id INTEGER NOT NULL,request_id TEXT,
          PRIMARY KEY(source,log_id));",
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

#[derive(Clone, Debug, PartialEq, Eq)]
struct SourceEvidence {
    session: String,
    account: String,
    model: String,
    requested: Option<String>,
    start: i64,
    end: i64,
    input: i64,
    output: i64,
    cached: i64,
}

pub(super) fn collect_from(
    conn: &mut Connection,
    source: &Connection,
    name: &str,
    _now: i64,
) -> Result<usize, String> {
    // The source has no diagnostics update watermark. An id/time lookback misses
    // corrections and late metadata forever, so revalidate all retained rows in
    // one source snapshot. Rows pruned from the source keep their saved evidence;
    // an explicit retained-row correction can revoke it. A read error rolls back.
    let source_tx = source.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut statement = source_tx
        .prepare(
            "SELECT r.id,r.timestamp,r.latency_ms,r.input_tokens,r.output_tokens,
        r.cached_tokens,r.model_id,r.requested_model,r.official_account_id,
        d.client_thread_id,d.client_session_id,l.effective_session_id,r.success,r.request_id
        FROM request_logs r LEFT JOIN request_diagnostics d ON d.request_id=r.request_id
        LEFT JOIN request_session_lookup l ON l.request_id=r.request_id ORDER BY r.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |r| {
        let id: i64 = r.get(0)?;
        let request_id: Option<String> = r.get(13)?;
        if r.get::<_, Option<bool>>(12)? != Some(true) {
            return Ok((id, request_id, None));
        }
        let (Some(started), Some(duration), Some(input), Some(output), Some(cached), Some(model)) = (
            r.get::<_, Option<i64>>(1)?, r.get::<_, Option<i64>>(2)?,
            r.get::<_, Option<i64>>(3)?, r.get::<_, Option<i64>>(4)?,
            r.get::<_, Option<i64>>(5)?, r.get::<_, Option<String>>(6)?,
        ) else { return Ok((id, request_id, None)); };
        let requested: Option<String> = r.get(7)?;
        let account: Option<String> = r.get(8)?;
        let sessions = [r.get::<_, Option<String>>(9)?, r.get(11)?, r.get(10)?];
        let end = started.checked_add(duration).and_then(|v| v.checked_add(3000));
        let candidate = account.filter(|s| !s.trim().is_empty())
            .zip(sessions.into_iter().flatten().find(|s| !s.trim().is_empty()))
            .zip(end)
            .filter(|_| started > 0 && duration >= 0 && input >= cached && cached >= 0 && output >= 0 && !model.trim().is_empty())
            .map(|((account, session), end)| SourceEvidence {
                session, account: format!("account:{account}"), model, requested,
                start: started.saturating_sub(1000), end, input, output, cached,
            });
        Ok((id, request_id, candidate))
    }).map_err(|e| e.to_string())?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let mut count = 0;
    let mut pending: Option<(i64, Option<String>, Option<SourceEvidence>, bool)> = None;
    for row in rows {
        let (id, request_id, candidate) = row.map_err(|e| e.to_string())?;
        if let Some((old_id, old_request, old_candidate, conflict)) = pending.as_mut() {
            if *old_id == id {
                *conflict |= *old_request != request_id || *old_candidate != candidate;
                continue;
            }
        }
        if let Some((old_id, old_request, old_candidate, conflict)) = pending.take() {
            count += replace_source_row(&tx, name, old_id, old_request.as_deref(), if conflict { None } else { old_candidate.as_ref() })?;
        }
        pending = Some((id, request_id, candidate, false));
    }
    if let Some((id, request_id, candidate, conflict)) = pending {
        count += replace_source_row(&tx, name, id, request_id.as_deref(), if conflict { None } else { candidate.as_ref() })?;
    }
    if count > 0 {
        super::billing::invalidate_proxy_matches(&tx)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

fn replace_source_row(
    conn: &Connection,
    source: &str,
    id: i64,
    request_id: Option<&str>,
    candidate: Option<&SourceEvidence>,
) -> Result<usize, String> {
    let request_id = request_id.filter(|id| !id.trim().is_empty());
    let previous: Option<Option<String>> = conn.prepare_cached(
        "SELECT request_id FROM monitor_request_account_source_rows WHERE source=?1 AND log_id=?2",
    ).map_err(|e| e.to_string())?.query_row(params![source,id], |r| r.get(0))
        .optional().map_err(|e| e.to_string())?;
    let mut changed = 0;
    if let Some(Some(previous)) = previous {
        if !previous.trim().is_empty() && request_id.is_some() && Some(previous.as_str()) != request_id {
            // SQLite ids can be reused after rotation/recreation. A different
            // nonempty native request is not a correction of the archived request.
            // A cleared identity does not establish replacement and must revoke
            // the retained row's proof instead of preserving it as an archive.
            let archive = format!("{source}#request:{:x}", md5::compute(previous));
            conn.execute("INSERT OR IGNORE INTO monitor_request_account_evidence
                SELECT ?3,log_id,session_id,account_key,model,requested_model,started_ms,finished_ms,input_tokens,output_tokens,cached_tokens
                FROM monitor_request_account_evidence WHERE source=?1 AND log_id=?2", params![source,id,archive])
                .map_err(|e| e.to_string())?;
            changed += conn.execute("DELETE FROM monitor_request_account_evidence WHERE source=?1 AND log_id=?2", params![source,id])
                .map_err(|e| e.to_string())?;
        }
    }
    if let Some(request_id) = request_id {
        // Recreated/restored sources can bring back the native request under a
        // new numeric id. Its live row supersedes its own archived copy, including
        // explicit corrections that now make the request unusable as evidence.
        let archive = format!("{source}#request:{:x}", md5::compute(request_id));
        changed += conn.execute("DELETE FROM monitor_request_account_evidence WHERE source=?1", [archive])
            .map_err(|e| e.to_string())?;
    }
    conn.prepare_cached("INSERT INTO monitor_request_account_source_rows VALUES(?1,?2,?3)
        ON CONFLICT(source,log_id) DO UPDATE SET request_id=excluded.request_id
        WHERE request_id IS NOT excluded.request_id").map_err(|e| e.to_string())?
        .execute(params![source,id,request_id]).map_err(|e| e.to_string())?;
    changed += conn.prepare_cached("DELETE FROM monitor_request_account_evidence
        WHERE source=?1 AND log_id=?2 AND (?3 IS NULL OR session_id<>?3)")
        .map_err(|e| e.to_string())?.execute(params![source,id,candidate.map(|e| e.session.as_str())])
        .map_err(|e| e.to_string())?;
    if let Some(e) = candidate {
        changed += conn.prepare_cached("INSERT INTO monitor_request_account_evidence VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
            ON CONFLICT(source,log_id,session_id) DO UPDATE SET
            account_key=excluded.account_key,model=excluded.model,requested_model=excluded.requested_model,
            started_ms=excluded.started_ms,finished_ms=excluded.finished_ms,
            input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens
            WHERE account_key<>excluded.account_key OR model<>excluded.model OR requested_model IS NOT excluded.requested_model
              OR started_ms<>excluded.started_ms OR finished_ms<>excluded.finished_ms
              OR input_tokens<>excluded.input_tokens OR output_tokens<>excluded.output_tokens OR cached_tokens<>excluded.cached_tokens")
            .map_err(|e| e.to_string())?.execute(params![source,id,e.session,e.account,e.model,e.requested,e.start,e.end,e.input,e.output,e.cached])
            .map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

struct Evidence {
    source: String,
    log_id: i64,
    account: String,
    model: String,
    requested: Option<String>,
    start: i64,
    end: i64,
    monitor_ids: BTreeSet<String>,
}

type Fingerprint = (String, i64, i64, i64);
pub(super) struct EvidenceIndex {
    proxy: BTreeMap<Fingerprint, Vec<Evidence>>,
}

pub(super) enum AccountMatch<'a> {
    None,
    Conflict,
    Verified(&'a str),
}

impl EvidenceIndex {
    fn unique_matches(&self) -> BTreeMap<&str, Option<&Evidence>> {
        let mut matches = BTreeMap::new();
        for evidence in self.proxy.values().flatten() {
            for id in &evidence.monitor_ids {
                let candidate = (evidence.monitor_ids.len() == 1).then_some(evidence);
                matches.entry(id.as_str()).and_modify(|found: &mut Option<&Evidence>| {
                    if candidate.is_none() || found.is_some_and(|first| first.source != evidence.source || first.log_id != evidence.log_id || first.account != evidence.account) {
                        *found = None;
                    }
                }).or_insert(candidate);
            }
        }
        matches
    }

    pub(super) fn api_request_ids(&self) -> BTreeSet<String> {
        self.unique_matches().into_iter().filter_map(|(id, row)| row.map(|_| id.to_owned())).collect()
    }

    pub(super) fn account_bounds(&self) -> BTreeMap<String, (i64, i64)> {
        let mut bounds: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for evidence in self.unique_matches().into_values().flatten() {
            let range = bounds.entry(evidence.account.clone()).or_insert((evidence.start, evidence.end));
            range.0 = range.0.min(evidence.start);
            range.1 = range.1.max(evidence.end.saturating_add(1));
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
                        monitor_ids: BTreeSet::new(),
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
                // Keep every possible edge. A proxy row that matches several
                // usages still competes with other evidence for each usage.
                evidence.monitor_ids = ids;
            }
        }
        Ok(Self { proxy: index })
    }

    pub(super) fn account_for(&self, usage: &UsageRecord) -> AccountMatch<'_> {
        if !valid_usage(usage) {
            return AccountMatch::None;
        }
        // A shared home/plan/reset timestamp identifies a possible quota pool,
        // not the account that actually served this historical request.
        self.proxy_account_for(usage)
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
            r.monitor_ids.contains(&usage.id)
                && usage.timestamp_ms >= r.start
                && usage.timestamp_ms <= r.end
                && usage
                    .model
                    .as_deref()
                    .is_some_and(|model| model == r.model || Some(model) == r.requested.as_deref())
        });
        let Some(first) = matches.clone().find(|row| row.monitor_ids.len() == 1) else {
            return AccountMatch::None;
        };
        if matches.any(|r| r.source != first.source || r.log_id != first.log_id || r.account != first.account) {
            return AccountMatch::Conflict;
        }
        AccountMatch::Verified(&first.account)
    }
}

fn valid_usage(usage: &UsageRecord) -> bool {
    usage.tool == "codex"
        && usage.has_period_timestamp()
        && usage.timestamp_ms > 0
        && usage.input_tokens >= usage.cache_read_tokens
        && usage.cache_read_tokens >= 0
        && usage.output_tokens >= 0
        && usage.cache_write_tokens == 0
        && !usage.unknown_fields.iter().any(|s| {
            matches!(
                s.as_str(),
                "timestamp"
                    | "input_tokens"
                    | "output_tokens"
                    | "cache_read_tokens"
                    | "cache_write_tokens"
                    | "per_request_input_tokens"
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
    fn saved_usage(conn: &Connection, id: &str, session: &str, time: i64) -> UsageRecord {
        let usage = UsageRecord {
            id: id.into(), tool: "codex".into(), session_id: session.into(),
            model: Some("gpt-6.1-sol".into()), timestamp_ms: time,
            input_tokens: 100, output_tokens: 20, cache_read_tokens: 80,
            ..Default::default()
        };
        conn.execute("INSERT INTO monitor_requests VALUES('codex',?1,?2,?3,?4,'{}')",
            params![id,format!("codex:{session}"),time,serde_json::to_string(&usage).unwrap()]).unwrap();
        usage
    }

    #[test]
    fn diagnostics_arriving_after_ten_minutes_are_still_matched() {
        let mut ledger = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&ledger).unwrap();
        let source = source();
        source.execute("DELETE FROM request_diagnostics", []).unwrap();
        let usage = saved_usage(&ledger, "response:late", "thread", 12000);
        assert_eq!(collect_from(&mut ledger, &source, "fixture", 14000).unwrap(), 0);
        source.execute("INSERT INTO request_diagnostics VALUES('r1','thread',NULL)", []).unwrap();
        assert_eq!(collect_from(&mut ledger, &source, "fixture", 10_000_000).unwrap(), 1);
        assert!(matches!(EvidenceIndex::load(&ledger).unwrap().account_for(&usage), AccountMatch::Verified("account:actual")));
        assert_eq!(collect_from(&mut ledger, &source, "fixture", 10_001_000).unwrap(), 0);
    }

    #[test]
    fn retained_request_corrections_revoke_old_sessions_accounts_and_success() {
        let mut ledger = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&ledger).unwrap();
        let source = source();
        let original = saved_usage(&ledger, "response:old", "thread", 12000);
        collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
        source.execute_batch("UPDATE request_diagnostics SET client_thread_id='corrected';
            UPDATE request_logs SET official_account_id='correct-account';").unwrap();
        let corrected = saved_usage(&ledger, "response:corrected", "corrected", 12000);
        assert!(collect_from(&mut ledger, &source, "fixture", 10_000_000).unwrap() > 0);
        let index = EvidenceIndex::load(&ledger).unwrap();
        assert!(matches!(index.account_for(&original), AccountMatch::None));
        assert!(matches!(index.account_for(&corrected), AccountMatch::Verified("account:correct-account")));
        source.execute("UPDATE request_logs SET success=0", []).unwrap();
        assert!(collect_from(&mut ledger, &source, "fixture", 10_001_000).unwrap() > 0);
        assert!(matches!(EvidenceIndex::load(&ledger).unwrap().account_for(&corrected), AccountMatch::None));
        assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_request_account_evidence", [], |r|r.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_requests", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
    }

    #[test]
    fn retained_identity_conflicts_are_not_resolved_by_join_order() {
        let mut ledger = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&ledger).unwrap();
        let source = source();
        let usage = saved_usage(&ledger, "response:old", "thread", 12000);
        collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
        source.execute("INSERT INTO request_diagnostics VALUES('r1','different-thread',NULL)", []).unwrap();
        collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
        assert!(matches!(EvidenceIndex::load(&ledger).unwrap().account_for(&usage), AccountMatch::None));
    }

    #[test]
    fn retention_and_reused_ids_preserve_historical_evidence_across_restart() {
        let path = std::env::temp_dir().join(format!("account-evidence-{}-{}.sqlite", std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut ledger = Connection::open(&path).unwrap();
        super::super::store::initialize(&ledger).unwrap();
        let source = source();
        let original = saved_usage(&ledger, "response:old", "thread", 12000);
        collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
        source.execute_batch("DELETE FROM request_logs; DELETE FROM request_diagnostics;").unwrap();
        assert_eq!(collect_from(&mut ledger, &source, "fixture", 10_000_000).unwrap(), 0);
        assert!(matches!(EvidenceIndex::load(&ledger).unwrap().account_for(&original), AccountMatch::Verified("account:actual")));
        drop(ledger);
        let mut ledger = Connection::open(&path).unwrap();
        super::super::store::initialize(&ledger).unwrap();
        source.execute_batch("INSERT INTO request_logs VALUES(1,'reused',20000,2000,100,20,80,'gpt-6.1-sol',NULL,'new-account',1);
            INSERT INTO request_diagnostics VALUES('reused','thread',NULL);").unwrap();
        let next = saved_usage(&ledger, "response:new", "thread", 22000);
        collect_from(&mut ledger, &source, "fixture", 10_001_000).unwrap();
        let index = EvidenceIndex::load(&ledger).unwrap();
        assert!(matches!(index.account_for(&original), AccountMatch::Verified("account:actual")));
        assert!(matches!(index.account_for(&next), AccountMatch::Verified("account:new-account")));
        source.execute("DROP TABLE request_diagnostics", []).unwrap();
        assert!(collect_from(&mut ledger, &source, "fixture", 10_002_000).is_err());
        assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_request_account_evidence", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
        assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_requests", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
        drop(ledger);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cumulative_blocks_and_conflicting_proxy_matches_do_not_prove_requests() {
        let mut ledger = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&ledger).unwrap();
        let source = source();
        let mut usage = saved_usage(&ledger, "response:aggregate", "thread", 12000);
        collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
        usage.unknown_fields.push("per_request_input_tokens".into());
        ledger.execute("UPDATE monitor_requests SET usage=?1", [serde_json::to_string(&usage).unwrap()]).unwrap();
        let index = EvidenceIndex::load(&ledger).unwrap();
        assert!(matches!(index.account_for(&usage), AccountMatch::None));
        assert!(index.api_request_ids().is_empty());
        usage.unknown_fields.clear();
        ledger.execute("UPDATE monitor_requests SET usage=?1", [serde_json::to_string(&usage).unwrap()]).unwrap();
        source.execute_batch("INSERT INTO request_logs SELECT 2,'r2',timestamp,latency_ms,input_tokens,output_tokens,cached_tokens,
            model_id,requested_model,'other',success FROM request_logs WHERE id=1;
            INSERT INTO request_diagnostics VALUES('r2','thread',NULL);").unwrap();
        collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
        let index = EvidenceIndex::load(&ledger).unwrap();
        assert!(matches!(index.account_for(&usage), AccountMatch::Conflict));
        assert!(index.api_request_ids().is_empty());
        assert!(index.account_bounds().is_empty());
    }

    #[test]
    fn nonunique_reverse_candidates_still_block_forward_account_proof() {
        let ledger = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&ledger).unwrap();
        let first = saved_usage(&ledger, "response:first-overlap", "thread", 12000);
        let second = saved_usage(&ledger, "response:second-overlap", "thread", 14500);
        ledger.execute_batch("INSERT INTO monitor_request_account_evidence VALUES
            ('fixture',1,'thread','account:wide','gpt-6.1-sol',NULL,9000,15000,100,20,80),
            ('fixture',2,'thread','account:narrow','gpt-6.1-sol',NULL,8000,12000,100,20,80);").unwrap();
        // The wide record matches both requests. It still competes with the
        // narrow record for the first request, so neither edge is unique both ways.
        let index = EvidenceIndex::load(&ledger).unwrap();
        assert!(matches!(index.account_for(&first), AccountMatch::Conflict));
        assert!(matches!(index.account_for(&second), AccountMatch::None));
        assert!(index.api_request_ids().is_empty());
        assert!(index.account_bounds().is_empty());
        assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_requests", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
        assert_eq!((first.input_tokens + second.input_tokens, first.output_tokens + second.output_tokens,
            first.cache_read_tokens + second.cache_read_tokens), (200, 40, 160));
    }

    #[test]
    fn restored_native_request_replaces_its_archived_evidence() {
        let mut ledger = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&ledger).unwrap();
        let source = source();
        let original = saved_usage(&ledger, "response:restored", "thread", 12000);
        let later = saved_usage(&ledger, "response:later", "thread", 22000);
        collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
        source.execute_batch("DELETE FROM request_logs; DELETE FROM request_diagnostics;
            INSERT INTO request_logs VALUES(1,'reused',20000,2000,100,20,80,'gpt-6.1-sol',NULL,'later-account',1);
            INSERT INTO request_diagnostics VALUES('reused','thread',NULL);").unwrap();
        collect_from(&mut ledger, &source, "fixture", 24000).unwrap();
        // Restoring the native request reuses the numeric row id and corrects its
        // account. Its archived copy is the same request, not independent proof.
        source.execute_batch("DELETE FROM request_logs; DELETE FROM request_diagnostics;
            INSERT INTO request_logs VALUES(1,'r1',10000,2000,100,20,80,'gpt-6.1-sol',NULL,'corrected-account',1);
            INSERT INTO request_diagnostics VALUES('r1','thread',NULL);").unwrap();
        collect_from(&mut ledger, &source, "fixture", 25000).unwrap();
        let index = EvidenceIndex::load(&ledger).unwrap();
        assert!(matches!(index.account_for(&original), AccountMatch::Verified("account:corrected-account")));
        assert!(matches!(index.account_for(&later), AccountMatch::Verified("account:later-account")));
        assert_eq!(index.api_request_ids().len(), 2);
        assert!(!index.account_bounds().contains_key("account:actual"));
        assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_request_account_evidence", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
        assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_requests", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
    }

    #[test]
    fn cleared_native_identity_revokes_evidence_instead_of_archiving_it() {
        for request_id in [None, Some(""), Some("   ")] {
            let mut ledger = Connection::open_in_memory().unwrap();
            super::super::store::initialize(&ledger).unwrap();
            let source = source();
            let usage = saved_usage(&ledger, "response:cleared-identity", "thread", 12000);
            collect_from(&mut ledger, &source, "fixture", 14000).unwrap();
            source.execute("UPDATE request_logs SET request_id=?1,success=0 WHERE id=1", [request_id]).unwrap();
            collect_from(&mut ledger, &source, "fixture", 15000).unwrap();
            let index = EvidenceIndex::load(&ledger).unwrap();
            assert!(matches!(index.account_for(&usage), AccountMatch::None), "{request_id:?}");
            assert!(index.api_request_ids().is_empty());
            assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_request_account_evidence", [], |r|r.get::<_,i64>(0)).unwrap(), 0);
            assert_eq!(ledger.query_row("SELECT COUNT(*) FROM monitor_requests", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
        }
    }

}
