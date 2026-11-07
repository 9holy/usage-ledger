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
    // A turn's authentication describes requests served after its observation.
    // A cumulative interval may include earlier turns or sign-ins, even when the
    // counter snapshot itself has a timestamp inside the current turn.
    if !usage.has_period_timestamp() {
        return Ok(None);
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
    // A quota period observed in the same client home does not identify the
    // credentials used by this historical request. Keep its billing mode unknown.
    Ok(None)
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

fn is_unadjusted_subscription_quote(usage: &UsageRecord, api: &CostEstimate) -> bool {
    if usage.billing_scope.as_deref() != Some("subscription")
        || usage.model.as_deref().and_then(|model| model.rsplit('/').next()) != Some("gpt-6.1-sol")
        || usage.context_tokens != Some(usage.input_tokens)
        || usage.input_tokens <= 272_000
        || [usage.input_tokens, usage.output_tokens, usage.cache_read_tokens]
            .into_iter().any(|tokens| !(0..=store::MAX_EXACT_TOKENS).contains(&tokens))
        || usage.input_tokens.checked_add(usage.output_tokens).is_none_or(|total| total > store::MAX_EXACT_TOKENS)
        || usage.cache_read_tokens > usage.input_tokens
        || usage.cache_write_tokens != 0
        || usage.cache_write_5m_tokens.is_some_and(|tokens| tokens != 0)
        || usage.cache_write_1h_tokens.is_some_and(|tokens| tokens != 0)
        || usage.unknown_fields.iter().any(|field| matches!(field.as_str(),
            "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens" | "per_request_input_tokens")
            || field.starts_with("unsupported_pricing_modifier:"))
        || api.cny.is_some()
    {
        return false;
    }
    // An existing amount is frozen unless its own saved evidence proves it is
    // exactly the API long-context tariff. Do not consult today's catalog or
    // reinterpret a manually quoted, differently sourced or incomplete amount.
    let proven = |evidence: &super::types::PriceEvidence, amount: f64| {
        let Some(cached) = evidence.cached_per_million else { return false; };
        if evidence.model != "gpt-6.1-sol" || evidence.currency != "USD"
            || !evidence.pricing_provider.eq_ignore_ascii_case("openai")
            || evidence.context_tier != ">272000 input tokens"
            || !matches!(evidence.pricing_basis.as_deref(), Some("official_equivalent" | "catalog_provider_reference"))
            || !evidence.excluded_components.is_empty() || evidence.time_band.is_some()
            || [amount, evidence.input_per_million, cached, evidence.output_per_million]
                .into_iter().any(|value| !value.is_finite() || value < 0.)
        {
            return false;
        }
        let saved_amount = ((usage.input_tokens - usage.cache_read_tokens) as f64 * evidence.input_per_million
            + usage.cache_read_tokens as f64 * cached + usage.output_tokens as f64 * evidence.output_per_million) / 1_000_000.;
        amount == saved_amount
    };
    let adjusted = pricing::subscription_quote(usage, api);
    match (api.usd, api.evidence.as_ref(), api.scenarios.is_empty()) {
        (Some(amount), Some(evidence), true) => proven(evidence, amount)
            && adjusted.usd.is_some_and(|next| next < amount)
            && adjusted.evidence.as_ref().is_some_and(|next| next.pricing_basis.as_deref() == Some("codex_subscription_reference")),
        (None, None, false) => api.scenarios.len() == adjusted.scenarios.len()
            && api.scenarios.iter().zip(&adjusted.scenarios).all(|(old, next)| {
                old.mode == old.evidence.mode && proven(&old.evidence, old.amount)
                    && next.amount < old.amount
                    && next.evidence.pricing_basis.as_deref() == Some("codex_subscription_reference")
            }),
        _ => false,
    }
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
    let scope_changed = kind != usage.billing_scope;
    if !scope_changed && kind.as_deref() != Some("subscription") {
        return Ok(false);
    }
    let old: CostEstimate = serde_json::from_str(&old_json).map_err(|e| e.to_string())?;
    if !scope_changed && !is_unadjusted_subscription_quote(&usage, &old) {
        return Ok(false);
    }
    let old_usage = usage.clone();
    usage.billing_scope = kind;
    let api_json = original_api(tx, "codex", id)?.unwrap_or_else(|| old_json.clone());
    let api: CostEstimate = serde_json::from_str(&api_json).map_err(|e| e.to_string())?;
    if !scope_changed && serde_json::to_value(&api).map_err(|e| e.to_string())?
        != serde_json::to_value(&old).map_err(|e| e.to_string())?
    {
        // Conflicting saved quotations cannot establish which historical amount
        // should be transformed. Preserve both rather than replacing the backup.
        return Ok(false);
    }
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
    if scope_changed {
        tx.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope',?2),cost=?3 WHERE tool='codex' AND id=?1",
            params![id,usage.billing_scope,next_json]).map_err(|e|e.to_string())?;
    } else {
        tx.execute("UPDATE monitor_requests SET cost=?2 WHERE tool='codex' AND id=?1", params![id,next_json])
            .map_err(|e| e.to_string())?;
    }
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
    apply_batch_in_transaction(&tx, path, rows, next)?;
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn apply_batch_in_transaction(
    tx: &Transaction<'_>,
    path: &str,
    rows: &[Observation],
    next: &store::RuntimeModeCursor,
) -> Result<(), String> {
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
        repair_ids(tx, ids.iter().map(String::as_str))?;
    }
    tx.execute(
        "INSERT INTO monitor_state VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        params![
            format!("codex_billing_cursor:{path}"),
            serde_json::to_string(next).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn seed_proxy_requests(conn: &mut Connection) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let ids = super::request_accounts::EvidenceIndex::load(&tx)?.api_request_ids();
    let previous = {
        let mut query = tx.prepare("SELECT id FROM monitor_api_requests")
            .map_err(|e| e.to_string())?;
        let rows = query.query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<BTreeSet<_>, _>>().map_err(|e| e.to_string())?
    };
    for id in previous.difference(&ids) {
        tx.execute("DELETE FROM monitor_api_requests WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        repair_one(&tx, id)?;
    }
    for id in ids.difference(&previous) {
        tx.execute("INSERT INTO monitor_api_requests VALUES(?1)", [id])
            .map_err(|e| e.to_string())?;
        repair_one(&tx, id)?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO monitor_state VALUES('billing_proxy_seed_v4','1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

// Matching depends on both proxy metadata and monitor usage. Persist the dirty
// checkpoint with the usage write so a restart cannot strand an unmatched row.
pub(super) fn invalidate_proxy_matches(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM monitor_state WHERE key='billing_proxy_seed_v4'", [])
        .map(|_| ())
        .map_err(|error| error.to_string())
}

pub(super) fn reconcile_proxy_requests(conn: &mut Connection) -> Result<(), String> {
    let done: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='billing_proxy_seed_v4')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !done {
        seed_proxy_requests(conn)?;
    }
    Ok(())
}

pub(super) fn bootstrap(conn: &mut Connection) -> Result<(), String> {
    reconcile_proxy_requests(conn)?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let done: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='billing_strict_evidence_v3')",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if done {
        return Ok(());
    }
    // Older releases inferred subscription billing from a shared home/plan/reset
    // or applied one turn's authentication to a cumulative usage interval.
    // Re-evaluate saved classifications once and restore their frozen API quote
    // whenever no request-specific or explicit runtime evidence supports them.
    // Also repair old unquoted backfills that saved a provable API tariff despite
    // an already-confirmed subscription scope, preserving the original quote.
    let ids = {
        let mut q=tx.prepare("SELECT id FROM monitor_requests WHERE tool='codex'
            AND json_extract(usage,'$.billingScope') IS NOT NULL").map_err(|e|e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    repair_ids(&tx, ids.iter().map(String::as_str))?;
    tx.execute("INSERT INTO monitor_state VALUES('billing_strict_evidence_v3','1')", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model_catalog::CatalogSnapshot;
    #[test]
    fn proxy_evidence_arriving_before_usage_is_reconciled_without_new_proxy_rows() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        conn.execute("INSERT INTO monitor_request_account_evidence VALUES('fixture',1,'thread','account:actual','gpt-6.1-sol',NULL,1000,3000,100,20,80)", []).unwrap();
        bootstrap(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_api_requests", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        let usage = UsageRecord {
            id: "response:late".into(), tool: "codex".into(), session_id: "thread".into(), turn_id: "turn".into(),
            timestamp_ms: 2000, model: Some("gpt-6.1-sol".into()), mode: Some("standard".into()),
            mode_basis: "response_reported".into(), input_tokens: 100, context_tokens: Some(100),
            cache_read_tokens: 80, output_tokens: 20, ..Default::default()
        };
        let tx = conn.transaction().unwrap();
        store::save_usage_with_catalog(&tx, &usage, i64::MAX, 3000, &CatalogSnapshot::default()).unwrap();
        tx.commit().unwrap();
        let original_cost: String = conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1", [&usage.id], |r| r.get(0)).unwrap();
        // The persisted reconciliation checkpoint must be invalidated by new usage,
        // even if no further proxy rows arrive before the next restart/refresh.
        bootstrap(&mut conn).unwrap();
        let (scope, cost): (Option<String>, String) = conn.query_row(
            "SELECT json_extract(usage,'$.billingScope'),cost FROM monitor_requests WHERE id=?1",
            [&usage.id], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(scope.as_deref(), Some("api"));
        assert_eq!(cost, original_cost);
        bootstrap(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_api_requests", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap()).request_count, 1);
    }

    #[test]
    fn quota_period_match_does_not_prove_billing_and_old_inferences_restore_the_api_quote() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let usage = UsageRecord {
            id: "response:quota-only".into(), tool: "codex".into(),
            session_id: "thread".into(), turn_id: "turn".into(), timestamp_ms: 2000,
            model: Some("gpt-6.1-sol".into()), mode: Some("standard".into()),
            mode_basis: "response_reported".into(), input_tokens: 300_000,
            cache_read_tokens: 200_000, output_tokens: 100, context_tokens: Some(300_000),
            ..Default::default()
        };
        conn.execute("INSERT INTO monitor_request_quota_evidence VALUES(?1,'home',604800000,'pro')", [&usage.id]).unwrap();
        conn.execute("INSERT INTO monitor_codex_quota_accounts VALUES('home',604800000,'pro','account:creator',1000,0)", []).unwrap();
        assert_eq!(classify(&conn, &usage).unwrap(), None);
        let tx = conn.transaction().unwrap();
        store::save_usage_with_catalog(&tx, &usage, i64::MAX, 3000, &CatalogSnapshot::default()).unwrap();
        tx.commit().unwrap();
        let api_quote: String = conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1", [&usage.id], |row| row.get(0)).unwrap();

        // Construct the durable state written by the old quota-only classifier,
        // including its frozen original API quote, without altering price rules.
        apply_batch(&mut conn, "runtime", &[Observation {
            session_key: "codex:thread".into(), turn_id: "turn".into(),
            kind: "subscription".into(), observed_ms: 1000,
        }], &store::RuntimeModeCursor::default()).unwrap();
        assert_eq!(original_api(&conn, "codex", &usage.id).unwrap().as_deref(), Some(api_quote.as_str()));
        conn.execute("DELETE FROM monitor_turn_billing", []).unwrap();
        conn.execute("INSERT INTO monitor_state VALUES('billing_proxy_seed_v2','1')", []).unwrap();

        for _ in 0..2 {
            bootstrap(&mut conn).unwrap();
            let (scope, cost): (Option<String>, String) = conn.query_row(
                "SELECT json_extract(usage,'$.billingScope'),cost FROM monitor_requests WHERE id=?1",
                [&usage.id], |row| Ok((row.get(0)?, row.get(1)?)),
            ).unwrap();
            assert_eq!(scope, None);
            assert_eq!(cost, api_quote);
            let totals = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
            assert_eq!((totals.request_count, totals.input_tokens, totals.output_tokens), (1, 300_000, 100));
        }
    }

    #[test]
    fn proxy_classification_is_revoked_when_a_late_request_makes_the_match_ambiguous() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        conn.execute("INSERT INTO monitor_request_account_evidence VALUES('fixture',1,'thread','account:actual','gpt-6.1-sol',NULL,1000,3000,100,20,80)", []).unwrap();
        let mut usage = UsageRecord {
            id: "response:first".into(), tool: "codex".into(), session_id: "thread".into(),
            turn_id: "turn".into(), timestamp_ms: 2000, model: Some("gpt-6.1-sol".into()),
            input_tokens: 100, output_tokens: 20, cache_read_tokens: 80, context_tokens: Some(100),
            ..Default::default()
        };
        let tx = conn.transaction().unwrap();
        store::save_usage_with_catalog(&tx, &usage, i64::MAX, 3000, &CatalogSnapshot::default()).unwrap();
        tx.commit().unwrap();
        bootstrap(&mut conn).unwrap();
        assert_eq!(classify(&conn, &usage).unwrap().as_deref(), Some("api"));

        usage.id = "response:late-identical".into();
        let tx = conn.transaction().unwrap();
        store::save_usage_with_catalog(&tx, &usage, i64::MAX, 3000, &CatalogSnapshot::default()).unwrap();
        tx.commit().unwrap();
        reconcile_proxy_requests(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_api_requests", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests WHERE json_extract(usage,'$.billingScope') IS NOT NULL", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        let totals = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
        assert_eq!((totals.request_count, totals.input_tokens, totals.output_tokens), (2, 200, 40));
    }

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
    #[test]
    fn legacy_proxy_cache_rechecks_both_directions_and_restores_frozen_subscription_quotes() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        apply_batch(&mut conn, "runtime", &[Observation {
            session_key: "codex:thread".into(), turn_id: "turn".into(),
            kind: "subscription".into(), observed_ms: 1000,
        }], &store::RuntimeModeCursor::default()).unwrap();
        let tx = conn.transaction().unwrap();
        for (id, timestamp_ms) in [("response:first-overlap", 2000), ("response:second-overlap", 4000)] {
            let usage = UsageRecord {
                id: id.into(), tool: "codex".into(), session_id: "thread".into(), turn_id: "turn".into(),
                timestamp_ms, model: Some("gpt-6.1-sol".into()), mode: Some("standard".into()),
                mode_basis: "response_reported".into(), input_tokens: 300_000, cache_read_tokens: 200_000,
                output_tokens: 100, context_tokens: Some(300_000), ..Default::default()
            };
            store::save_usage_with_catalog(&tx, &usage, i64::MAX, 5000, &CatalogSnapshot::default()).unwrap();
        }
        tx.commit().unwrap();
        let saved_quotes = |conn: &Connection| conn.prepare("SELECT id,cost FROM monitor_requests ORDER BY id").unwrap()
            .query_map([], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap()
            .collect::<Result<Vec<_>,_>>().unwrap();
        let original = saved_quotes(&conn);
        let original_api_quotes: Vec<String> = ["response:first-overlap", "response:second-overlap"].into_iter()
            .map(|id|original_api(&conn, "codex", id).unwrap().unwrap()).collect();
        for (_, quote) in &original {
            assert!((serde_json::from_str::<CostEstimate>(quote).unwrap().usd.unwrap() - 0.221).abs() < 1e-10);
        }
        conn.execute_batch("INSERT INTO monitor_request_account_evidence VALUES
            ('fixture',1,'thread','account:wide','gpt-6.1-sol',NULL,1000,5000,300000,100,200000),
            ('fixture',2,'thread','account:narrow','gpt-6.1-sol',NULL,1000,3000,300000,100,200000);
            INSERT INTO monitor_api_requests VALUES('response:first-overlap');").unwrap();
        let tx = conn.transaction().unwrap();
        repair_ids(&tx, ["response:first-overlap"]).unwrap();
        tx.commit().unwrap();
        assert_ne!(saved_quotes(&conn), original);
        // Existing installations may already have the old successful checkpoint.
        conn.execute_batch("INSERT INTO monitor_state VALUES('billing_proxy_seed_v3','1');
            INSERT INTO monitor_state VALUES('billing_strict_evidence_v1','1');").unwrap();
        bootstrap(&mut conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_api_requests", [], |r|r.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests WHERE json_extract(usage,'$.billingScope')='subscription'", [], |r|r.get::<_,i64>(0)).unwrap(), 2);
        assert_eq!(saved_quotes(&conn), original);
        for (id, expected) in ["response:first-overlap", "response:second-overlap"].into_iter().zip(original_api_quotes) {
            assert_eq!(original_api(&conn, "codex", id).unwrap().unwrap(), expected);
        }
        let totals = store::sum_sessions(&store::sessions(&conn, None, 5000).unwrap());
        assert_eq!((totals.request_count, totals.input_tokens, totals.output_tokens, totals.cache_read_tokens), (2, 600_000, 200, 400_000));
        assert!((totals.priced_cost_usd - 0.442).abs() < 1e-10);
        assert_eq!((totals.input_unknown_requests, totals.output_unknown_requests, totals.unpriced_requests), (0,0,0));
    }

    #[test]
    fn turn_authentication_does_not_classify_cumulative_usage_intervals() {
        for kind in ["api", "subscription"] {
            let mut conn = Connection::open_in_memory().unwrap();
            store::initialize(&conn).unwrap();
            let tx = conn.transaction().unwrap();
            for (id, basis) in [("initial", "legacy_initial_cumulative"), ("delta", "legacy_cumulative_delta")] {
                let usage = UsageRecord {
                    id: id.into(), tool: "codex".into(), session_id: "thread".into(), turn_id: "turn".into(),
                    timestamp_ms: 2000, model: Some("gpt-6.1-sol".into()), mode: Some("standard".into()),
                    mode_basis: "response_reported".into(), input_tokens: 100, output_tokens: 20,
                    cache_read_tokens: 80, usage_basis: basis.into(),
                    unknown_fields: vec!["per_request_input_tokens".into()], ..Default::default()
                };
                store::save_usage_with_catalog(&tx, &usage, i64::MAX, 3000, &CatalogSnapshot::default()).unwrap();
            }
            tx.commit().unwrap();
            let saved = |conn: &Connection| conn.prepare("SELECT id,cost FROM monitor_requests ORDER BY id").unwrap()
                .query_map([], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap()
                .collect::<Result<Vec<_>,_>>().unwrap();
            let before = saved(&conn);
            let totals = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
            assert_eq!((totals.request_count, totals.unitemized_records, totals.input_tokens, totals.output_tokens, totals.cache_read_tokens), (2,2,200,40,160));
            let before_totals = serde_json::to_value(totals).unwrap();
            apply_batch(&mut conn, "runtime", &[Observation {
                session_key: "codex:thread".into(), turn_id: "turn".into(), kind: kind.into(), observed_ms: 1000,
            }], &store::RuntimeModeCursor::default()).unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests WHERE json_extract(usage,'$.billingScope') IS NOT NULL", [], |r|r.get::<_,i64>(0)).unwrap(), 0, "{kind}");
            let after = conn.prepare("SELECT id,cost FROM monitor_requests ORDER BY id").unwrap()
                .query_map([], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap()
                .collect::<Result<Vec<_>,_>>().unwrap();
            assert_eq!(after, before);
            assert_eq!(serde_json::to_value(store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap())).unwrap(), before_totals);
            // Re-evaluate stale classifications written before the stronger check.
            conn.execute_batch("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope','subscription');
                INSERT INTO monitor_state VALUES('billing_strict_evidence_v1','1');").unwrap();
            bootstrap(&mut conn).unwrap();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests WHERE json_extract(usage,'$.billingScope') IS NOT NULL", [], |r|r.get::<_,i64>(0)).unwrap(), 0);
        }
    }

    #[test]
    fn unquoted_subscription_backfill_applies_billing_and_keeps_frozen_api_reversal() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        apply_batch(&mut conn, "runtime", &[Observation {
            session_key: "codex:thread".into(), turn_id: "turn".into(),
            kind: "subscription".into(), observed_ms: 1000,
        }], &store::RuntimeModeCursor::default()).unwrap();
        let usage = UsageRecord {
            id: "legacy-unquoted-subscription".into(), tool: "codex".into(), session_id: "thread".into(),
            turn_id: "turn".into(), billing_scope: Some("subscription".into()), timestamp_ms: 2000,
            model: Some("gpt-6.1-sol".into()), mode: Some("standard".into()),
            mode_basis: "response_reported".into(), input_tokens: 300_000, context_tokens: Some(300_000),
            cache_read_tokens: 200_000, output_tokens: 100, usage_basis: "token_usage_record".into(),
            ..Default::default()
        };
        assert_eq!(classify(&conn, &usage).unwrap().as_deref(), Some("subscription"));
        let api = pricing::estimate_with_catalog(&usage, &crate::model_catalog::snapshot());
        assert!((api.usd.unwrap() - 0.4415).abs() < 1e-10);
        let api_json = serde_json::to_string(&api).unwrap();
        let missing = CostEstimate { reason: Some("legacy_model_not_priced".into()), ..Default::default() };
        let mut frozen = api.clone();
        frozen.usd = Some(9.875);
        frozen.reason = Some("saved_historical_reference".into());
        let frozen_json = format!(" {}\n", serde_json::to_string(&frozen).unwrap());
        // A valid older ledger may already know the subscription mode while its
        // installed price catalog did not yet quote this model. Seed that state.
        let tx = conn.transaction().unwrap();
        store::save_session(&tx, &super::super::types::SessionMeta {
            tool: "codex".into(), id: "thread".into(), started_at_ms: 2000, updated_at_ms: 2000,
            ..Default::default()
        }).unwrap();
        for (id, cost, json) in [
            (usage.id.as_str(), &missing, serde_json::to_string(&missing).unwrap()),
            ("already-quoted-subscription", &frozen, frozen_json.clone()),
        ] {
            let mut row = usage.clone();
            row.id = id.into();
            tx.execute("INSERT INTO monitor_requests VALUES('codex',?1,'codex:thread',2000,?2,?3)",
                params![id,serde_json::to_string(&row).unwrap(),json]).unwrap();
            store::adjust(&tx, &row, cost, 1).unwrap();
        }
        tx.commit().unwrap();
        let before_usage: Vec<(String, String)> = conn.prepare("SELECT id,usage FROM monitor_requests ORDER BY id").unwrap()
            .query_map([], |r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
        let before = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
        assert_eq!((before.request_count, before.input_tokens, before.output_tokens, before.cache_read_tokens, before.unpriced_requests), (2,600_000,200,400_000,1));
        store::backfill_unquoted(&mut conn).unwrap();
        let filled: String = conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1", [&usage.id], |r|r.get(0)).unwrap();
        let cost: CostEstimate = serde_json::from_str(&filled).unwrap();
        assert!((cost.usd.unwrap() - 0.221).abs() < 1e-10);
        assert_eq!(cost.evidence.unwrap().pricing_basis.as_deref(), Some("codex_subscription_reference"));
        assert_eq!(original_api(&conn, "codex", &usage.id).unwrap().as_deref(), Some(api_json.as_str()));
        assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id='already-quoted-subscription'", [], |r|r.get::<_,String>(0)).unwrap(), frozen_json);
        let after_usage: Vec<(String, String)> = conn.prepare("SELECT id,usage FROM monitor_requests ORDER BY id").unwrap()
            .query_map([], |r|Ok((r.get(0)?,r.get(1)?))).unwrap().collect::<Result<_,_>>().unwrap();
        assert_eq!(after_usage, before_usage);
        let after = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
        assert_eq!((after.request_count, after.input_tokens, after.output_tokens, after.cache_read_tokens, after.unpriced_requests), (2,600_000,200,400_000,0));
        assert!((after.priced_cost_usd - 10.096).abs() < 1e-10);
        assert_eq!((after.input_unknown_requests, after.output_unknown_requests, after.cache_read_unknown_requests, after.cache_write_unknown_requests), (0,0,0,0));
        // A later contradictory auth observation must restore the exact API quote
        // produced by backfill, while already-published historical quotes stay frozen.
        apply_batch(&mut conn, "runtime", &[Observation {
            session_key: "codex:thread".into(), turn_id: "turn".into(), kind: "api".into(), observed_ms: 1001,
        }], &store::RuntimeModeCursor::default()).unwrap();
        assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1", [&usage.id], |r|r.get::<_,String>(0)).unwrap(), api_json);
        assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id='already-quoted-subscription'", [], |r|r.get::<_,String>(0)).unwrap(), frozen_json);
        let restored = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
        assert_eq!((restored.request_count, restored.input_tokens, restored.output_tokens, restored.cache_read_tokens, restored.unpriced_requests), (2,600_000,200,400_000,0));
        assert!((restored.priced_cost_usd - 10.3165).abs() < 1e-10);
    }

    #[test]
    fn quoted_subscription_backfill_repairs_proven_api_prices_and_preserves_raw_reversal() {
        for scenarios in [false, true] {
            let mut conn = Connection::open_in_memory().unwrap();
            store::initialize(&conn).unwrap();
            apply_batch(&mut conn, "runtime", &[Observation {
                session_key: "codex:thread".into(), turn_id: "turn".into(),
                kind: "subscription".into(), observed_ms: 1000,
            }], &store::RuntimeModeCursor::default()).unwrap();
            let usage = UsageRecord {
                id: "previously-backfilled-subscription".into(), tool: "codex".into(), session_id: "thread".into(),
                turn_id: "turn".into(), billing_scope: Some("subscription".into()), timestamp_ms: 2000,
                model: Some("gpt-6.1-sol".into()), mode: (!scenarios).then(|| "standard".into()),
                mode_basis: if scenarios { "unknown" } else { "response_reported" }.into(),
                input_tokens: 300_000, context_tokens: Some(300_000), cache_read_tokens: 200_000,
                output_tokens: 100, usage_basis: "token_usage_record".into(), ..Default::default()
            };
            assert_eq!(classify(&conn, &usage).unwrap().as_deref(), Some("subscription"));
            // This is exactly the quote the old backfill wrote without applying
            // the already-confirmed subscription scope. No current catalog lookup
            // is necessary to recognize its stored rates and arithmetic later.
            let api = pricing::estimate_with_catalog(&usage, &CatalogSnapshot::default());
            let expected = pricing::subscription_quote(&usage, &api);
            if scenarios {
                assert_eq!(api.scenarios.len(), 4);
                assert!(api.usd.is_none());
                assert!(api.scenarios.iter().zip(&expected.scenarios)
                    .all(|(old, next)| old.amount > next.amount && next.amount > 0.));
                for (mode, amount) in [("standard",0.221),("fast",0.442),("ultrafast",1.326),("flex",0.1105)] {
                    assert!((expected.scenarios.iter().find(|quote|quote.mode==mode).unwrap().amount - amount).abs() < 1e-10);
                }
            } else {
                assert!((api.usd.unwrap() - 0.4415).abs() < 1e-10);
                assert!((expected.usd.unwrap() - 0.221).abs() < 1e-10);
            }
            let mut api_value = serde_json::to_value(&api).unwrap();
            api_value["historicalExtension"] = serde_json::json!({"keep":"original API evidence"});
            let api_json = format!(" {}\n", api_value);
            let mut frozen = api.clone();
            frozen.usd = Some(9.875);
            frozen.scenarios.clear();
            frozen.evidence = api.evidence.clone().or_else(|| api.scenarios.first().map(|quote| quote.evidence.clone()));
            frozen.reason = Some("saved_historical_reference".into());
            let frozen_json = format!(" {}\n", serde_json::to_string(&frozen).unwrap());
            let mut usage_value = serde_json::to_value(&usage).unwrap();
            usage_value["historicalExtension"] = serde_json::json!({"keep":true});
            let usage_json = format!(" {}\n", usage_value);
            let tx = conn.transaction().unwrap();
            store::save_session(&tx, &super::super::types::SessionMeta {
                tool: "codex".into(), id: "thread".into(), started_at_ms: 2000, updated_at_ms: 2000,
                ..Default::default()
            }).unwrap();
            for (id, cost, raw, saved_usage) in [
                (usage.id.as_str(), &api, api_json.clone(), usage_json.clone()),
                ("unrelated-frozen-price", &frozen, frozen_json.clone(), {
                    let mut row = usage.clone(); row.id = "unrelated-frozen-price".into();
                    serde_json::to_string(&row).unwrap()
                }),
            ] {
                let mut row = usage.clone(); row.id = id.into();
                tx.execute("INSERT INTO monitor_requests VALUES('codex',?1,'codex:thread',2000,?2,?3)", params![id,saved_usage,raw]).unwrap();
                store::adjust(&tx, &row, cost, 1).unwrap();
            }
            tx.execute_batch("INSERT INTO monitor_state VALUES('billing_proxy_seed_v4','1');
                INSERT INTO monitor_state VALUES('billing_strict_evidence_v1','1');
                INSERT INTO monitor_state VALUES('billing_strict_evidence_v2','1');").unwrap();
            tx.commit().unwrap();
            let before = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
            let unpriced = i64::from(scenarios);
            assert_eq!((before.request_count, before.input_tokens, before.output_tokens, before.cache_read_tokens, before.unpriced_requests), (2,600_000,200,400_000,unpriced));
            bootstrap(&mut conn).unwrap();
            let (after_usage, after_cost): (String, String) = conn.query_row(
                "SELECT usage,cost FROM monitor_requests WHERE id=?1", [&usage.id], |row|Ok((row.get(0)?,row.get(1)?))).unwrap();
            let corrected: CostEstimate = serde_json::from_str(&after_cost).unwrap();
            assert_eq!(serde_json::to_value(corrected).unwrap(), serde_json::to_value(&expected).unwrap());
            assert_eq!(after_usage, usage_json, "a price-only repair must preserve original usage bytes");
            assert_eq!(original_api(&conn, "codex", &usage.id).unwrap().as_deref(), Some(api_json.as_str()));
            assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id='unrelated-frozen-price'", [], |r|r.get::<_,String>(0)).unwrap(), frozen_json);
            assert!(original_api(&conn, "codex", "unrelated-frozen-price").unwrap().is_none());
            let after = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
            assert_eq!((after.request_count, after.input_tokens, after.output_tokens, after.cache_read_tokens, after.unpriced_requests), (2,600_000,200,400_000,unpriced));
            assert_eq!((after.input_unknown_requests, after.output_unknown_requests, after.cache_read_unknown_requests, after.cache_write_unknown_requests), (0,0,0,0));
            assert!((after.priced_cost_usd - 9.875 - expected.usd.unwrap_or(0.)).abs() < 1e-10);
            if scenarios {
                assert_eq!(after.scenario_requests, 1);
                for expected in &expected.scenarios {
                    let actual = after.scenarios.iter().find(|quote| quote.mode == expected.mode && quote.currency == "USD").unwrap();
                    assert!((actual.amount - expected.amount).abs() < 1e-10);
                }
            }
            let tx = conn.transaction().unwrap();
            repair_ids(&tx, [usage.id.as_str(), "unrelated-frozen-price"]).unwrap();
            tx.commit().unwrap();
            assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1", [&usage.id], |r|r.get::<_,String>(0)).unwrap(), after_cost);
            assert_eq!(original_api(&conn, "codex", &usage.id).unwrap().as_deref(), Some(api_json.as_str()));
            apply_batch(&mut conn, "runtime", &[Observation {
                session_key: "codex:thread".into(), turn_id: "turn".into(), kind: "api".into(), observed_ms: 1001,
            }], &store::RuntimeModeCursor::default()).unwrap();
            assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1", [&usage.id], |r|r.get::<_,String>(0)).unwrap(), api_json);
            assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id='unrelated-frozen-price'", [], |r|r.get::<_,String>(0)).unwrap(), frozen_json);
            let restored = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
            assert_eq!((restored.request_count, restored.input_tokens, restored.output_tokens, restored.cache_read_tokens, restored.unpriced_requests), (2,600_000,200,400_000,unpriced));
            assert!((restored.priced_cost_usd - before.priced_cost_usd).abs() < 1e-10);
            assert_eq!(restored.scenario_requests, before.scenario_requests);
            assert_eq!(restored.scenarios.len(), before.scenarios.len());
            for old in &before.scenarios {
                let restored = restored.scenarios.iter().find(|quote| quote.mode == old.mode && quote.currency == old.currency).unwrap();
                assert!((restored.amount - old.amount).abs() < 1e-10);
                assert_eq!(restored.request_count, old.request_count);
            }
        }
    }

    #[test]
    fn quoted_subscription_migration_preserves_unproven_prices_and_conflicting_saved_quotes() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        apply_batch(&mut conn, "runtime", &[Observation {
            session_key: "codex:thread".into(), turn_id: "turn".into(), kind: "subscription".into(), observed_ms: 1000,
        }], &store::RuntimeModeCursor::default()).unwrap();
        let usage = UsageRecord {
            tool: "codex".into(), session_id: "thread".into(), turn_id: "turn".into(), billing_scope: Some("subscription".into()),
            timestamp_ms: 2000, model: Some("gpt-6.1-sol".into()), mode: Some("standard".into()), mode_basis: "response_reported".into(),
            input_tokens: 300_000, context_tokens: Some(300_000), cache_read_tokens: 200_000, output_tokens: 100,
            usage_basis: "token_usage_record".into(), ..Default::default()
        };
        let api = pricing::estimate_with_catalog(&usage, &CatalogSnapshot::default());
        let tx = conn.transaction().unwrap();
        store::save_session(&tx, &super::super::types::SessionMeta {
            tool: "codex".into(), id: "thread".into(), started_at_ms: 2000, updated_at_ms: 2000, ..Default::default()
        }).unwrap();
        for kind in ["frozen-amount", "wrong-tier", "manual-basis", "other-provider", "changed-rates", "unknown-output", "native-currency", "conflicting-original"] {
            let mut row = usage.clone(); row.id = kind.into();
            let mut cost = api.clone();
            match kind {
                "frozen-amount" => cost.usd = Some(9.875),
                "wrong-tier" => cost.evidence.as_mut().unwrap().context_tier = "full published context window".into(),
                "manual-basis" => cost.evidence.as_mut().unwrap().pricing_basis = Some("manual_reference".into()),
                "other-provider" => cost.evidence.as_mut().unwrap().pricing_provider = "other-provider".into(),
                "changed-rates" => { cost.evidence.as_mut().unwrap().input_per_million = 8.; cost.usd = Some(0.8415); },
                "unknown-output" => row.unknown_fields.push("output_tokens".into()),
                "native-currency" => { cost.usd = None; cost.cny = Some(13.); cost.evidence.as_mut().unwrap().currency = "CNY".into(); },
                "conflicting-original" => {
                    let mut conflicting = api.clone(); conflicting.usd = Some(9.875);
                    tx.execute("INSERT INTO monitor_original_api_quotes VALUES('codex',?1,?2)", params![kind,serde_json::to_string(&conflicting).unwrap()]).unwrap();
                },
                _ => unreachable!(),
            }
            tx.execute("INSERT INTO monitor_requests VALUES('codex',?1,'codex:thread',2000,?2,?3)",
                params![kind,serde_json::to_string(&row).unwrap(),format!(" {}\n",serde_json::to_string(&cost).unwrap())]).unwrap();
            store::adjust(&tx, &row, &cost, 1).unwrap();
        }
        tx.commit().unwrap();
        let snapshot = |conn: &Connection| {
            let rows = conn.prepare("SELECT id,usage,cost FROM monitor_requests ORDER BY id").unwrap()
                .query_map([], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).unwrap()
                .collect::<Result<Vec<_>,_>>().unwrap();
            let originals = conn.prepare("SELECT id,cost FROM monitor_original_api_quotes ORDER BY id").unwrap()
                .query_map([], |r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap()
                .collect::<Result<Vec<_>,_>>().unwrap();
            (rows, originals, serde_json::to_value(store::sum_sessions(&store::sessions(conn, None, 3000).unwrap())).unwrap())
        };
        let before = snapshot(&conn);
        let totals = store::sum_sessions(&store::sessions(&conn, None, 3000).unwrap());
        assert_eq!((totals.request_count, totals.input_tokens, totals.output_tokens, totals.cache_read_tokens, totals.output_unknown_requests), (8,2_400_000,800,1_600_000,1));
        assert_eq!(totals.priced_cost_cny, 13.);
        bootstrap(&mut conn).unwrap();
        assert_eq!(snapshot(&conn), before, "migration must not reinterpret unproven or unrelated historical quotes");
    }

}
