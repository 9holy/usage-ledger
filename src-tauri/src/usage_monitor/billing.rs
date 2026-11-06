use super::{
    pricing, store,
    types::{CostEstimate, UsageRecord},
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::BTreeSet;

#[derive(Debug)]
pub(super) struct Observation {
    pub session_key: String,
    pub turn_id: String,
    pub kind: String,
    pub observed_ms: i64,
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS monitor_turn_billing (
        session_key TEXT NOT NULL,turn_id TEXT NOT NULL,kind TEXT NOT NULL,observed_ms INTEGER NOT NULL,
        PRIMARY KEY(session_key,turn_id));
        CREATE TABLE IF NOT EXISTS monitor_api_requests(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS monitor_original_api_quotes(tool TEXT NOT NULL,id TEXT NOT NULL,cost TEXT NOT NULL,
        PRIMARY KEY(tool,id));").map_err(|e|e.to_string())
}

pub(super) fn key(usage: &UsageRecord) -> &str {
    match usage.billing_scope.as_deref() {
        Some("subscription") => "subscription",
        Some("api") => "api",
        _ => "unknown",
    }
}

pub(super) fn classify(conn: &Connection, usage: &UsageRecord) -> Result<Option<String>, String> {
    if usage.tool != "codex" {
        return Ok(usage.billing_scope.clone());
    }
    let api: bool = conn
        .prepare_cached("SELECT EXISTS(SELECT 1 FROM monitor_api_requests WHERE id=?1)")
        .map_err(|e| e.to_string())?
        .query_row([&usage.id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if api {
        return Ok(Some("api".into()));
    }
    let typed: Option<(String, i64)> = conn
        .prepare_cached(
            "SELECT kind,observed_ms FROM monitor_turn_billing WHERE session_key=?1 AND turn_id=?2",
        )
        .map_err(|e| e.to_string())?
        .query_row(
            params![
                store::session_key("codex", &usage.session_id),
                usage.turn_id
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some((kind, observed)) = typed {
        if kind == "unknown" {
            return Ok(None);
        }
        if usage.timestamp_ms >= observed
            && !usage.unknown_fields.iter().any(|s| s == "timestamp")
            && usage
                .request_timing
                .as_ref()
                .and_then(|t| t.started_at_ms)
                .is_none_or(|start| start >= observed)
        {
            return Ok(Some(kind));
        }
    }
    // An authenticated quota match is request evidence, not the account that created a conversation.
    let accounts:i64=conn.prepare_cached("SELECT COUNT(DISTINCT a.account_key) FROM monitor_request_quota_evidence e
        JOIN monitor_codex_quota_accounts a ON a.home=e.home AND a.reset_ms=e.reset_ms AND a.plan=e.plan WHERE e.id=?1")
        .map_err(|e|e.to_string())?.query_row([&usage.id],|r|r.get(0)).map_err(|e|e.to_string())?;
    Ok((accounts == 1).then(|| "subscription".into()))
}

pub(super) fn original_api(
    conn: &Connection,
    tool: &str,
    id: &str,
) -> Result<Option<String>, String> {
    conn.prepare_cached("SELECT cost FROM monitor_original_api_quotes WHERE tool=?1 AND id=?2")
        .map_err(|e| e.to_string())?
        .query_row(params![tool, id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())
}

pub(super) fn price(
    conn: &Connection,
    usage: &UsageRecord,
    api: &CostEstimate,
    api_json: Option<&str>,
) -> Result<CostEstimate, String> {
    if usage.billing_scope.as_deref() != Some("subscription") {
        return Ok(api.clone());
    }
    let adjusted = pricing::subscription_quote(usage, api);
    if adjusted.usd != api.usd
        || adjusted.cny != api.cny
        || adjusted
            .scenarios
            .iter()
            .zip(&api.scenarios)
            .any(|(a, b)| a.amount != b.amount)
    {
        conn.execute("INSERT INTO monitor_original_api_quotes VALUES(?1,?2,?3) ON CONFLICT(tool,id) DO UPDATE SET cost=excluded.cost",
            params![usage.tool,usage.id,api_json.map(str::to_owned).unwrap_or(serde_json::to_string(api).map_err(|e|e.to_string())?)]).map_err(|e|e.to_string())?;
    }
    Ok(adjusted)
}

fn repair_one(tx: &Transaction<'_>, id: &str) -> Result<bool, String> {
    let row: Option<(String, String)> = tx
        .prepare_cached("SELECT usage,cost FROM monitor_requests WHERE tool='codex' AND id=?1")
        .map_err(|e| e.to_string())?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((json, old_json)) = row else {
        return Ok(false);
    };
    let mut usage: UsageRecord = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let kind = classify(tx, &usage)?;
    if kind == usage.billing_scope {
        return Ok(false);
    }
    let old_usage = usage.clone();
    usage.billing_scope = kind;
    let old: CostEstimate = serde_json::from_str(&old_json).map_err(|e| e.to_string())?;
    let api_json = original_api(tx, "codex", id)?.unwrap_or_else(|| old_json.clone());
    let api: CostEstimate = serde_json::from_str(&api_json).map_err(|e| e.to_string())?;
    let next = price(tx, &usage, &api, Some(&api_json))?;
    let cost_changed = serde_json::to_value(&next).map_err(|e| e.to_string())?
        != serde_json::to_value(&old).map_err(|e| e.to_string())?;
    let next_json = if cost_changed {
        if usage.billing_scope.as_deref() != Some("subscription") {
            api_json
        } else {
            serde_json::to_string(&next).map_err(|e| e.to_string())?
        }
    } else {
        old_json
    };
    if cost_changed {
        store::adjust(tx, &old_usage, &old, -1)?;
    }
    tx.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope',?2),cost=?3 WHERE tool='codex' AND id=?1",
        params![id,usage.billing_scope,next_json]).map_err(|e|e.to_string())?;
    if cost_changed {
        store::adjust(tx, &usage, &next, 1)?;
    }
    Ok(true)
}

pub(super) fn repair_ids<'a>(
    tx: &Transaction<'_>,
    ids: impl IntoIterator<Item = &'a str>,
) -> Result<(), String> {
    for id in ids {
        repair_one(tx, id)?;
    }
    Ok(())
}

pub(super) fn cursor(conn: &Connection, path: &str) -> Result<store::RuntimeModeCursor, String> {
    let json: Option<String> = conn
        .query_row(
            "SELECT data FROM monitor_state WHERE key=?1",
            [format!("codex_billing_cursor:{path}")],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    json.map(|v| serde_json::from_str(&v))
        .transpose()
        .map(|v| v.unwrap_or_default())
        .map_err(|e| e.to_string())
}

pub(super) fn apply_batch(
    conn: &mut Connection,
    path: &str,
    rows: &[Observation],
    next: &store::RuntimeModeCursor,
) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut changed = BTreeSet::new();
    for row in rows {
        let old:Option<(String,i64)>=tx.query_row("SELECT kind,observed_ms FROM monitor_turn_billing WHERE session_key=?1 AND turn_id=?2",
            params![row.session_key,row.turn_id],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|e|e.to_string())?;
        let kind = if old.as_ref().is_some_and(|(kind, _)| kind != &row.kind) {
            "unknown"
        } else {
            &row.kind
        };
        let observed = old
            .as_ref()
            .map_or(row.observed_ms, |(_, t)| (*t).min(row.observed_ms));
        if old.as_ref() == Some(&(kind.to_owned(), observed)) {
            continue;
        }
        tx.execute("INSERT INTO monitor_turn_billing VALUES(?1,?2,?3,?4) ON CONFLICT(session_key,turn_id) DO UPDATE SET kind=excluded.kind,observed_ms=excluded.observed_ms",
            params![row.session_key,row.turn_id,kind,observed]).map_err(|e|e.to_string())?;
        changed.insert((&row.session_key, &row.turn_id));
    }
    for (session, turn) in changed {
        let ids = {
            let mut q=tx.prepare("SELECT id FROM monitor_requests WHERE tool='codex' AND session_key=?1 AND json_extract(usage,'$.turnId')=?2").map_err(|e|e.to_string())?;
            let r = q
                .query_map(params![session, turn], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            r.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        repair_ids(&tx, ids.iter().map(String::as_str))?;
    }
    tx.execute(
        "INSERT INTO monitor_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        params![
            format!("codex_billing_cursor:{path}"),
            serde_json::to_string(next).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn seed_proxy_requests(conn: &mut Connection) -> Result<(), String> {
    let ids = super::request_accounts::EvidenceIndex::load(conn)?.api_request_ids();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for id in &ids {
        if tx
            .execute(
                "INSERT OR IGNORE INTO monitor_api_requests VALUES(?1)",
                [id],
            )
            .map_err(|e| e.to_string())?
            > 0
        {
            repair_one(&tx, id)?;
        }
    }
    tx.execute(
        "INSERT OR REPLACE INTO monitor_state VALUES('billing_proxy_seed_v1','1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn bootstrap(conn: &mut Connection) -> Result<(), String> {
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='billing_proxy_seed_v1')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !done {
        seed_proxy_requests(conn)?;
    }
    let ids = {
        let mut q=conn.prepare("SELECT DISTINCT r.id FROM monitor_requests r JOIN monitor_request_quota_evidence e ON e.id=r.id
        WHERE r.tool='codex' AND json_extract(r.usage,'$.billingScope') IS NULL").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    repair_ids(&tx, ids.iter().map(String::as_str))?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::CatalogSnapshot;
    #[test]
    fn subscription_sol_is_corrected_api_is_unchanged_and_conflicts_restore_original_quote() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let usage = |id: &str, turn: &str| UsageRecord {
            id: id.into(),
            tool: "codex".into(),
            session_id: "thread".into(),
            turn_id: turn.into(),
            timestamp_ms: 2000,
            model: Some("gpt-6.1-sol".into()),
            mode: Some("standard".into()),
            mode_basis: "response_reported".into(),
            input_tokens: 300_000,
            cache_read_tokens: 200_000,
            output_tokens: 100,
            context_tokens: Some(300_000),
            ..Default::default()
        };
        let tx = conn.transaction().unwrap();
        for row in [usage("sub", "sub-turn"), usage("api", "api-turn")] {
            store::save_usage_with_catalog(&tx, &row, 3000, 3000, &CatalogSnapshot::default())
                .unwrap();
        }
        tx.commit().unwrap();
        let read = |conn: &Connection, id: &str| {
            conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1", [id], |r| {
                r.get::<_, String>(0)
            })
            .unwrap()
        };
        let old_sub = read(&conn, "sub");
        let old_api = read(&conn, "api");
        let rows = [
            Observation {
                session_key: "codex:thread".into(),
                turn_id: "sub-turn".into(),
                kind: "subscription".into(),
                observed_ms: 1000,
            },
            Observation {
                session_key: "codex:thread".into(),
                turn_id: "api-turn".into(),
                kind: "api".into(),
                observed_ms: 1000,
            },
        ];
        let cursor = store::RuntimeModeCursor {
            id: 1,
            ..Default::default()
        };
        apply_batch(&mut conn, "source", &rows, &cursor).unwrap();
        assert_eq!(read(&conn, "api"), old_api);
        assert_eq!(
            original_api(&conn, "codex", "sub").unwrap().unwrap(),
            old_sub
        );
        let corrected: CostEstimate = serde_json::from_str(&read(&conn, "sub")).unwrap();
        assert!((corrected.usd.unwrap() - 0.221).abs() < 1e-10);
        assert_eq!(
            corrected.evidence.unwrap().pricing_basis.as_deref(),
            Some("codex_subscription_reference")
        );
        let frozen = read(&conn, "sub");
        apply_batch(&mut conn, "source", &rows, &cursor).unwrap();
        assert_eq!(read(&conn, "sub"), frozen);
        apply_batch(
            &mut conn,
            "source",
            &[Observation {
                session_key: "codex:thread".into(),
                turn_id: "sub-turn".into(),
                kind: "api".into(),
                observed_ms: 1001,
            }],
            &cursor,
        )
        .unwrap();
        assert_eq!(read(&conn, "sub"), old_sub);
        let total: super::super::types::Totals = serde_json::from_str(
            &conn
                .query_row(
                    "SELECT totals FROM monitor_sessions WHERE key='codex:thread'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            (total.request_count, total.input_tokens, total.output_tokens),
            (2, 600_000, 200)
        );
    }

    #[test]
    #[ignore = "Requires an explicit writable ledger copy and read-only local runtime metadata"]
    fn reconcile_copied_subscription_prices() {
        let copy =
            std::path::PathBuf::from(std::env::var_os("MONITOR_BILLING_REPAIR_COPY").unwrap())
                .canonicalize()
                .unwrap();
        assert_eq!(copy.file_name().unwrap(), "ledger-audit-work.sqlite");
        assert_ne!(
            copy,
            crate::ledger_db::ledger_db_path()
                .unwrap()
                .canonicalize()
                .unwrap()
        );
        let home =
            std::path::PathBuf::from(std::env::var_os("MONITOR_BILLING_SOURCE_HOME").unwrap());
        let mut conn =
            Connection::open_with_flags(copy, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        store::initialize(&conn).unwrap();
        bootstrap(&mut conn).unwrap();
        let paths =
            super::super::codex_mode_logs::discover(&[super::super::collector::SourceRoot {
                tool: "codex".into(),
                path: home.join("sessions"),
            }])
            .0;
        assert!(!paths.is_empty());
        for path in paths {
            let source =
                Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .unwrap();
            let upper: i64 = source
                .query_row("SELECT COALESCE(MAX(id),0) FROM logs", [], |r| r.get(0))
                .unwrap();
            while cursor(&conn, &path.to_string_lossy()).unwrap().id < upper {
                let before = cursor(&conn, &path.to_string_lossy()).unwrap().id;
                let status = super::super::codex_mode_logs::collect(&mut conn, &[path.clone()]);
                assert!(
                    cursor(&conn, &path.to_string_lossy()).unwrap().id > before,
                    "{:?}",
                    status[0].error
                );
            }
        }
        println!(
            "subscription_repriced={}",
            conn.query_row(
                "SELECT COUNT(*) FROM monitor_original_api_quotes",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap()
        );
    }
}
