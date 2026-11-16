use super::{collector, store, types::*};
use rusqlite::Connection;
use serde_json::json;
use std::{fs, io::Write};

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let id = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("2api-monitor-test-{}-{id}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn connection(&self) -> Connection {
        let c = Connection::open(self.0.join("monitor.sqlite")).unwrap();
        store::initialize(&c).unwrap();
        c
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn lines(rows: Vec<serde_json::Value>) -> String {
    rows.into_iter().map(|v| format!("{v}\n")).collect()
}
fn header() -> Vec<serde_json::Value> {
    vec![
        json!({"type":"session_meta","timestamp":"2026-10-15T00:00:00Z","payload":{"id":"s","timestamp":"2026-10-15T00:00:00Z"}}),
        json!({"type":"turn_context","timestamp":"2026-10-15T00:00:01Z","payload":{"turn_id":"t","model":"gpt-6.1-sol"}}),
    ]
}
fn usage(n: i64) -> serde_json::Value {
    json!({"input_tokens":100*n,"output_tokens":20*n,"cached_input_tokens":50*n,"cache_write_input_tokens":0,"reasoning_output_tokens":5*n,"total_tokens":120*n})
}

#[test]
fn scoped_activity_uses_current_auth_and_activity_instead_of_the_last_usage_receipt() {
    let f = Fixture::new();
    let mut conn = f.connection();
    let now = 1_794_673_857_176;
    let tx = conn.transaction().unwrap();
    for (tool, id, kind, has_usage) in [
        ("codex", "old-api", "api", true),
        ("codex", "new-api", "api", false),
        ("codex", "switched", "subscription", true),
        ("claude", "claude-api", "api", true),
        ("claude", "claude-switched", "subscription", true),
        ("codex", "unknown-newest", "api", true),
    ] {
        if has_usage {
            let usage = UsageRecord { tool: tool.into(), id: id.into(), session_id: id.into(),
                timestamp_ms: now - 300_000, output_tokens: 20, ..Default::default() };
            store::save_usage_with_catalog(&tx, &usage, i64::MAX, now, &crate::model_catalog::CatalogSnapshot::default()).unwrap();
            tx.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope','api') WHERE tool=?1 AND id=?2", rusqlite::params![tool,id]).unwrap();
        }
        store::save_session(&tx, &SessionMeta { tool: tool.into(), id: id.into(), status: "active".into(),
            updated_at_ms: now - 1000, model: Some("current-model".into()), ..Default::default() }).unwrap();
        let source = format!("{id}.jsonl");
        let state = json!({"session":{"id":id,"updatedAtMs":now-1000},"turn_id":"current","claude_request_ref":"request"});
        tx.execute("INSERT INTO monitor_files VALUES(?1,?2,0,'',?3)", rusqlite::params![source,tool,state.to_string()]).unwrap();
        if tool == "codex" {
            tx.execute("INSERT INTO monitor_turn_billing VALUES(?1,'current',?2,?3)",rusqlite::params![store::session_key(tool,id),kind,now]).unwrap();
        } else {
            super::request_identity::save_context(&tx, &source, &super::request_identity::ClaudeContext {
                reference: "request".into(), session: id.into(), kind, account: None,
            }).unwrap();
        }
    }
    let newest = json!({"session":{"id":"unknown-newest","updatedAtMs":now},"turn_id":"unconfirmed"});
    tx.execute("INSERT INTO monitor_files VALUES('new-alias','codex',0,'',?1)",[newest.to_string()]).unwrap();
    tx.commit().unwrap();
    let api = store::sessions_scoped(&conn, None, now, Some("api")).unwrap();
    let (counts, by_tool) = super::status_counts(&api, now);
    assert_eq!(counts.running, 3);
    assert_eq!(by_tool["codex"].running, 2);
    assert_eq!(by_tool["claude"].running, 1);
    for row in api.iter().filter(|row| row.meta.status == "active") {
        assert_eq!(row.meta.updated_at_ms, now - 1000);
        assert_eq!(row.meta.model.as_deref(), Some("current-model"));
        assert_eq!(row.totals.output_tokens_per_second, 0.);
    }
    assert_eq!(api.iter().find(|row|row.meta.id=="new-api").unwrap().totals.request_count, 0);
    for id in ["switched", "claude-switched", "unknown-newest"] {
        let row = api.iter().find(|row|row.meta.id==id).unwrap();
        assert_eq!(row.meta.status, "unknown");
        assert_eq!(row.meta.updated_at_ms, now-300_000);
        assert_eq!(row.totals.request_count, 1);
    }
    let subscription = store::sessions_scoped(&conn, None, now, Some("subscription")).unwrap();
    assert_eq!(super::status_counts(&subscription,now).0.running, 2);
    assert_eq!(store::sum_sessions(&api).request_count, 5);
    assert_eq!(store::sum_sessions(&subscription).request_count, 0);
    assert_eq!(store::sum_sessions(&store::sessions(&conn,None,now+121_000).unwrap()).request_count,5);
    assert_eq!(super::status_counts(&store::sessions_scoped(&conn,None,now+121_000,Some("api")).unwrap(),now+121_000).0.running,0);
}

#[test]
fn claude_activity_and_current_auth_follow_request_boundaries() {
    let f = Fixture::new();
    let mut conn = f.connection();
    let path = f.0.join("claude.jsonl");
    let now = 1_794_673_857_176;
    for (offset,row,status,scope) in [
        (0,json!({"type":"user","uuid":"turn","message":{"content":"hello"}}),"active",None),
        (1,json!({"type":"api-request","id":"request","params":{"betas":[]}}),"active",Some("api")),
        (2,json!({"type":"assistant","message":{"stop_reason":"tool_use"}}),"active",Some("api")),
        (3,json!({"type":"user","message":{"content":[{"type":"tool_result"}]}}),"active",Some("api")),
        (4,json!({"type":"assistant","message":{"stop_reason":"end_turn"}}),"idle",Some("api")),
        (5,json!({"type":"user","uuid":"next","message":{"content":"next"}}),"active",None),
        (6,json!({"type":"api-request","id":"oauth","params":{"betas":["oauth-2025-04-20"]}}),"active",Some("subscription")),
        (7,json!({"type":"system","subtype":"turn_duration","durationMs":3000}),"idle",Some("subscription")),
        (8,json!({"type":"api-request","id":"again","params":{"betas":[]}}),"active",Some("api")),
        (9,json!({"type":"system","subtype":"stop_hook_summary"}),"idle",Some("api")),
        (10,json!({"type":"api-request","id":"legacy-without-betas","params":{}}),"active",None),
    ] {
        let mut row = row;
        row["sessionId"] = json!("claude-session");
        row["timestamp"] = json!(chrono::DateTime::from_timestamp_millis(now+offset*1000).unwrap().to_rfc3339());
        fs::OpenOptions::new().create(true).append(true).open(&path).unwrap().write_all(format!("{row}\n").as_bytes()).unwrap();
        collector::ingest_file(&mut conn,"claude",&path,i64::MAX).unwrap();
        let sessions = store::sessions(&conn,Some("claude"),now+offset*1000).unwrap();
        assert_eq!(sessions[0].meta.status,status,"{row}");
        assert_eq!(super::billing::session_kind(&conn,&sessions[0]).unwrap().as_deref(),scope,"{row}");
    }
}

#[test]
fn api_group_spans_tools_and_filters_mixed_session_drilldowns_without_repricing() {
    let f=Fixture::new();
    let mut conn=f.connection();
    let tx=conn.transaction().unwrap();
    let catalog=crate::model_catalog::CatalogSnapshot::default();
    for (tool,id,scope,output,at) in [("codex","subscription",Some("subscription"),900,9000),("codex","api-codex",Some("api"),20,8000),("claude","api-claude",Some("api"),30,7000),("claude","unconfirmed",None,500,9500)] {
        let u=UsageRecord{id:id.into(),tool:tool.into(),session_id:"mixed".into(),turn_id:"turn".into(),timestamp_ms:at,model:Some("model".into()),output_tokens:output,billing_scope:scope.map(str::to_owned),..Default::default()};
        store::save_usage_with_catalog(&tx,&u,i64::MAX,10000,&catalog).unwrap();
        // Exact runtime billing evidence is maintained independently of these test usage rows.
        tx.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope',?3) WHERE tool=?1 AND id=?2",rusqlite::params![tool,id,scope]).unwrap();
    }
    tx.commit().unwrap();
    let p=MonitorPeriod{billing_scope:Some("api".into()),start_ms:Some(0),end_ms:Some(10000),..Default::default()};
    let report=super::analysis::read(&conn,None,&p,"",None,false,0,100,10000).unwrap();
    assert_eq!((report.totals.request_count,report.totals.output_tokens),(2,50));
    assert_eq!(report.by_tool.len(),2);
    assert_eq!(report.sessions.len(),2);
    let live_sessions=store::sessions_scoped(&conn,None,10000,Some("api")).unwrap();
    let live_totals=store::sum_sessions(&live_sessions);
    assert_eq!((live_totals.request_count,live_totals.output_tokens),(2,50));
    for s in &report.sessions {
        assert!(s.recent_request.as_ref().unwrap().id.starts_with("api-"));
        assert!(s.latest_completed_turn.is_none());
        let detail=store::session_detail(&conn,&s.key,0,1,10000,false,&p).unwrap();
        assert_eq!(detail.request_count,1);
        assert_eq!(detail.requests.len(),1);
        assert_eq!(detail.requests[0].usage.billing_scope.as_deref(),Some("api"));
        assert_eq!(detail.session.totals.request_count,1);
    }
    let page=super::analysis::read(&conn,None,&p,"",None,false,1,1,10000).unwrap();
    assert_eq!((page.session_count,page.sessions.len(),page.totals.output_tokens),(2,1,50));
    let all=super::analysis::read(&conn,None,&MonitorPeriod{billing_scope:None,..p.clone()},"",None,false,0,100,10000).unwrap();
    assert_eq!((all.totals.request_count,all.totals.output_tokens),(4,1450));
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),4);
}

#[test]
fn a_malformed_claude_append_keeps_its_cursor_and_does_not_block_codex_or_erase_prior_usage() {
    let f=Fixture::new();
    let mut conn=f.connection();
    let codex=f.0.join("codex.jsonl");
    let claude=f.0.join("claude.jsonl");
    let mut rows=header();rows.push(canonical("one",1));
    fs::write(&codex,lines(rows)).unwrap();
    let good=json!({"type":"assistant","sessionId":"c","timestamp":"2026-11-13T10:00:00Z","message":{"id":"one","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}});
    fs::write(&claude,format!("{good}\n")).unwrap();
    collector::ingest_file(&mut conn,"codex",&codex,i64::MAX).unwrap();
    collector::ingest_file(&mut conn,"claude",&claude,i64::MAX).unwrap();
    let cursor:u64=conn.query_row("SELECT offset FROM monitor_files WHERE path=?1",[claude.to_string_lossy()],|r|r.get(0)).unwrap();
    fs::OpenOptions::new().append(true).open(&claude).unwrap().write_all(b"{invalid}\n").unwrap();
    assert!(collector::ingest_file(&mut conn,"claude",&claude,i64::MAX).is_err());
    fs::OpenOptions::new().append(true).open(&codex).unwrap().write_all(format!("{}\n",canonical("two",2)).as_bytes()).unwrap();
    collector::ingest_file(&mut conn,"codex",&codex,i64::MAX).unwrap();
    assert_eq!(conn.query_row("SELECT offset FROM monitor_files WHERE path=?1",[claude.to_string_lossy()],|r|r.get::<_,u64>(0)).unwrap(),cursor);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests WHERE tool='claude'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests WHERE tool='codex'",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    assert_eq!(store::sum_sessions(&store::sessions(&conn,None,i64::MAX).unwrap()).output_tokens,70);
}

#[test]
#[ignore = "Requires an explicit isolated ledger copy for complete monitor conservation checks"]
fn copied_framework_conservation() {
    let path=std::path::PathBuf::from(std::env::var_os("MONITOR_FRAMEWORK_COPY").unwrap()).canonicalize().unwrap();
    assert_eq!(path.file_name().unwrap(),"ledger-audit-work.sqlite");
    assert_ne!(path,crate::ledger_db::ledger_db_path().unwrap().canonicalize().unwrap());
    let conn=Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    store::initialize(&conn).unwrap();
    let tx=conn.unchecked_transaction().unwrap();
    let now=crate::ledger_db::now_ms();
    let cached=store::sum_sessions(&store::sessions(&tx,None,now).unwrap());
    let all=super::analysis::read(&tx,None,&MonitorPeriod::default(),"",None,false,0,1,now).unwrap();
    let same=|a:&Totals,b:&Totals| {
        assert_eq!((a.request_count,a.input_tokens,a.output_tokens,a.cache_read_tokens,a.cache_write_tokens),(b.request_count,b.input_tokens,b.output_tokens,b.cache_read_tokens,b.cache_write_tokens));
        for(currency,x)in &a.automatic_price_summary.by_currency {
            let y=&b.automatic_price_summary.by_currency[currency];
            assert!((x.requested_subtotal-y.requested_subtotal).abs()<1e-6,"requested subtotal cache={} raw={}",x.requested_subtotal,y.requested_subtotal);
            assert!((x.response_subtotal-y.response_subtotal).abs()<1e-6,"response subtotal cache={} raw={}",x.response_subtotal,y.response_subtotal);
            assert!((x.unknown_reference_subtotal-y.unknown_reference_subtotal).abs()<1e-6);
        }
    };
    same(&cached,&all.totals);
    let mut by_tool=Totals::default();
    for row in &all.by_tool{store::merge_totals(&mut by_tool,&row.totals);}
    store::finish_totals(&mut by_tool);same(&all.totals,&by_tool);
    let api=super::analysis::read(&tx,None,&MonitorPeriod{billing_scope:Some("api".into()),..Default::default()},"",None,false,0,10,now).unwrap();
    let direct:(i64,i64)=tx.query_row("SELECT COUNT(*),COALESCE(SUM(json_extract(usage,'$.outputTokens')),0) FROM monitor_requests WHERE json_extract(usage,'$.billingScope')='api'",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!((api.totals.request_count,api.totals.output_tokens),direct);
    let clock=std::time::Instant::now();
    let scoped=store::sum_sessions(&store::sessions_scoped(&tx,None,now,Some("api")).unwrap());
    let scoped_ms=clock.elapsed().as_millis();
    same(&scoped,&api.totals);
    let api_live=super::live::read_scoped(&tx,now,0,now,Some("api")).unwrap();
    let observed_api:i64=tx.query_row("SELECT COALESCE(SUM(o.output_tokens),0) FROM monitor_observations o JOIN monitor_requests r ON r.tool=o.tool AND r.id=o.id WHERE o.observed_ms>?1 AND o.observed_ms<=?2 AND json_extract(r.usage,'$.billingScope')='api' AND COALESCE(json_extract(r.usage,'$.usageBasis'),'')!='legacy_initial_cumulative'",rusqlite::params![now-60000,now],|r|r.get(0)).unwrap();
    assert_eq!(api_live.windows[0].observed_output_tokens,observed_api);
    let live=super::live::read(&tx,now,0,now).unwrap();
    for(index,window)in live.windows.iter().enumerate(){
        for groups in [&live.by_tool,&live.by_model,&live.by_session]{
            assert_eq!(window.observed_output_tokens,groups.iter().map(|g|g.windows[index].observed_output_tokens).sum::<i64>());
        }
    }
    println!("{}",json!({"cachedEqualsRaw":true,"toolTotalsConserve":true,"liveGroupsConserve":true,"apiSnapshotMatchesAnalysis":true,"apiSessionReadMs":scoped_ms,"apiObservedOutput60":observed_api,"totalRequests":all.totals.request_count,"apiRequests":api.totals.request_count,"apiSessions":api.session_count,"tokens":all.totals.total_tokens,"usdAutomatic":all.totals.automatic_price_summary.by_currency.get("USD")}));
}
fn legacy(n: i64) -> serde_json::Value {
    json!({"type":"event_msg","timestamp":"2026-10-15T00:00:03Z","payload":{"type":"token_count","info":{"total_token_usage":usage(n),"last_token_usage":usage(1)}}})
}
fn canonical(id: &str, n: i64) -> serde_json::Value {
    json!({"type":"token_usage_record","timestamp":"2026-10-15T00:00:03Z","payload":{"thread_id":"s","turn_id":"t","response_id":id,"usage":usage(1),"thread_token_usage":usage(n)}})
}

#[test]
fn restart_rotation_and_archived_prefix_cannot_resurrect_legacy_charges() {
    let f = Fixture::new();
    let active = f.0.join("active.jsonl");
    let archive = f.0.join("archive.jsonl");
    let mut rows = header();
    rows.push(legacy(1));
    rows.push(canonical("r1", 1));
    fs::write(&active, lines(rows)).unwrap();
    let mut conn = f.connection();
    collector::ingest_file(&mut conn, "codex", &active, i64::MAX).unwrap();
    let mut rows = header();
    rows.push(legacy(1));
    fs::write(&archive, lines(rows)).unwrap();
    collector::ingest_file(&mut conn, "codex", &archive, i64::MAX).unwrap();
    let t = store::sum_sessions(&store::sessions(&conn, None, i64::MAX).unwrap());
    assert_eq!(
        (t.request_count, t.input_tokens, t.output_tokens),
        (1, 100, 20)
    );
    assert_eq!(t.output_tokens_per_second, 0.0);
    drop(conn);
    fs::remove_file(&active).unwrap();
    fs::remove_file(&archive).unwrap();
    let conn = f.connection();
    let detail = store::session_detail(
        &conn,
        "codex:s",
        0,
        1,
        i64::MAX,
        false,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert_eq!(detail.request_count, 1);
    assert_eq!(detail.turns[0].totals.total_tokens, 120);
    assert!(detail.requests[0].cost.usd.is_none());
}

#[test]
fn partial_append_is_not_committed_until_newline_and_file_rewrite_is_idempotent() {
    let f = Fixture::new();
    let path = f.0.join("stream.jsonl");
    let mut rows = header();
    rows.push(canonical("r1", 1));
    fs::write(&path, lines(rows)).unwrap();
    let mut conn = f.connection();
    collector::ingest_file(&mut conn, "codex", &path, i64::MAX).unwrap();
    let next = format!("{}\n", canonical("r2", 2));
    let middle = next.len() / 2;
    let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(&next.as_bytes()[..middle]).unwrap();
    collector::ingest_file(&mut conn, "codex", &path, i64::MAX).unwrap();
    assert_eq!(
        store::sessions(&conn, None, 0).unwrap()[0]
            .totals
            .request_count,
        1
    );
    file.write_all(&next.as_bytes()[middle..]).unwrap();
    drop(file);
    collector::ingest_file(&mut conn, "codex", &path, i64::MAX).unwrap();
    let mut rows = header();
    rows.push(canonical("r1", 1));
    rows.push(canonical("r2", 2));
    fs::write(&path, lines(rows)).unwrap();
    collector::ingest_file(&mut conn, "codex", &path, i64::MAX).unwrap();
    let detail =
        store::session_detail(&conn, "codex:s", 0, 1, 0, false, &MonitorPeriod::default()).unwrap();
    assert_eq!(detail.request_count, 2);
    assert_eq!(detail.requests.len(), 1);
    assert_eq!(detail.turns[0].totals.request_count, 2);
    assert_eq!(detail.turns[0].totals.total_tokens, 240);
}

#[test]
fn late_incomplete_usage_preserves_known_counts_price_and_weighted_cache_ratio() {
    let f = Fixture::new();
    let mut conn = f.connection();
    let tx = conn.transaction().unwrap();
    let mut u = UsageRecord {
        id: "r".into(),
        tool: "claude".into(),
        session_id: "s".into(),
        turn_id: "t".into(),
        model: Some("claude-opus-5-5".into()),
        mode: Some("standard".into()),
        mode_basis: "response_reported".into(),
        input_tokens: 100,
        context_tokens: Some(100),
        output_tokens: 20,
        cache_read_tokens: 80,
        ..Default::default()
    };
    store::save_usage(&tx, &u, i64::MAX, 0).unwrap();
    u.input_tokens = 0;
    u.output_tokens = 0;
    u.cache_read_tokens = 0;
    u.context_tokens = None;
    u.unknown_fields = vec![
        "input_tokens".into(),
        "output_tokens".into(),
        "cache_read_tokens".into(),
        "per_request_input_tokens".into(),
        "timestamp".into(),
    ];
    store::save_usage(&tx, &u, i64::MAX, 0).unwrap();
    tx.commit().unwrap();
    let detail = store::session_detail(
        &conn,
        "claude:s",
        0,
        100,
        0,
        false,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert_eq!(detail.session.totals.input_tokens, 100);
    assert_eq!(detail.session.totals.request_count, 1);
    assert_eq!(detail.session.totals.cache_hit_ratio, Some(0.8));
    assert_eq!(detail.turns[0].totals.cache_hit_ratio, Some(0.8));
    assert!(detail.requests[0].cost.usd.is_some());
    assert!(detail.requests[0].cost.evidence.is_some());
}

#[test]
fn active_sessions_sort_first_and_abandoned_activity_becomes_stale() {
    let f = Fixture::new();
    let mut conn = f.connection();
    let tx = conn.transaction().unwrap();
    for (id, status, updated) in [
        ("new-idle", "completed", 999_999),
        ("old-active", "active", 1),
        ("live", "active", 999_998),
    ] {
        store::save_session(
            &tx,
            &SessionMeta {
                tool: "codex".into(),
                id: id.into(),
                status: status.into(),
                updated_at_ms: updated,
                ..Default::default()
            },
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let rows = store::sessions(&conn, None, 1_000_000).unwrap();
    assert_eq!(rows[0].meta.id, "live");
    assert_eq!(
        rows.iter()
            .find(|s| s.meta.id == "old-active")
            .unwrap()
            .meta
            .status,
        "stale"
    );
}

#[test]
fn pricing_backfill_preserves_known_quotes_and_totals_do_not_add_alternative_scenarios() {
    let f = Fixture::new();
    let mut conn = f.connection();
    let mut u = UsageRecord {
        id: "unknown".into(),
        tool: "codex".into(),
        session_id: "s".into(),
        turn_id: "t".into(),
        model: Some("gpt-6.1-sol".into()),
        input_tokens: 1000,
        context_tokens: Some(1000),
        output_tokens: 100,
        cache_read_tokens: 800,
        ..Default::default()
    };
    let tx = conn.transaction().unwrap();
    store::save_usage(&tx, &u, i64::MAX, 0).unwrap();
    tx.commit().unwrap();
    // Recreate the previous version's unquoted row and aggregate, not a second request.
    let old = Totals {
        input_tokens: 1000,
        output_tokens: 100,
        cache_read_tokens: 800,
        request_count: 1,
        unpriced_requests: 1,
        ..Default::default()
    };
    conn.execute(
        "UPDATE monitor_requests SET cost=?1",
        [r#"{"usd":null,"reason":"unknown_actual_mode","evidence":null}"#],
    )
    .unwrap();
    conn.execute(
        "UPDATE monitor_sessions SET totals=?1",
        [serde_json::to_string(&old).unwrap()],
    )
    .unwrap();
    u.id = "known".into();
    u.mode = Some("standard".into());
    u.mode_basis = "response_reported".into();
    let tx = conn.transaction().unwrap();
    store::save_usage(&tx, &u, i64::MAX, 0).unwrap();
    tx.commit().unwrap();
    conn.execute("UPDATE monitor_requests SET cost=json_set(cost,'$.evidence.version','frozen-old-snapshot') WHERE id='known'",[]).unwrap();
    store::backfill_unquoted(&mut conn).unwrap();
    let detail = store::session_detail(
        &conn,
        "codex:s",
        0,
        100,
        0,
        false,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert_eq!(detail.session.totals.request_count, 2);
    assert_eq!(detail.session.totals.unpriced_requests, 1);
    assert_eq!(detail.session.totals.scenario_requests, 1);
    assert!(detail
        .session
        .totals
        .scenarios
        .iter()
        .any(|s| s.mode == "fast" && s.request_count == 1));
    assert_eq!(detail.turns[0].totals.scenario_requests, 1);
    let known = detail
        .requests
        .iter()
        .find(|r| r.usage.id == "known")
        .unwrap();
    assert_eq!(
        known.cost.evidence.as_ref().unwrap().version,
        "frozen-old-snapshot"
    );
    assert_eq!(
        detail.session.totals.priced_cost_usd,
        known.cost.usd.unwrap()
    );
    let unknown = detail
        .requests
        .iter()
        .find(|r| r.usage.id == "unknown")
        .unwrap();
    assert!(unknown.usage.mode.is_none());
    assert!(unknown.cost.usd.is_none());
    assert!(!unknown.cost.scenarios.is_empty());
    store::backfill_unquoted(&mut conn).unwrap();
    assert_eq!(
        store::sessions(&conn, None, 0).unwrap()[0]
            .totals
            .scenario_requests,
        1
    );
    u.duration_ms = Some(1234);
    let tx = conn.transaction().unwrap();
    store::save_usage(&tx, &u, i64::MAX, 0).unwrap();
    tx.commit().unwrap();
    let frozen = store::session_detail(
        &conn,
        "codex:s",
        0,
        100,
        0,
        false,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert_eq!(
        frozen
            .requests
            .iter()
            .find(|r| r.usage.id == "known")
            .unwrap()
            .cost
            .evidence
            .as_ref()
            .unwrap()
            .version,
        "frozen-old-snapshot"
    );
    u.id = "cny".into();
    u.tool = "claude".into();
    u.model = Some("doubao-seed-2.0-code".into());
    let tx = conn.transaction().unwrap();
    store::save_usage(&tx, &u, i64::MAX, 0).unwrap();
    tx.commit().unwrap();
    let cny = store::session_detail(
        &conn,
        "claude:s",
        0,
        100,
        0,
        false,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert!(cny.session.totals.priced_cost_cny > 0.0);
    assert_eq!(cny.session.totals.priced_cost_usd, 0.0);
    assert_eq!(cny.session.totals.unpriced_requests, 0);
    assert!(cny.requests[0].cost.usd.is_none());
}

#[test]
fn monitor_filters_use_all_sessions_and_unpriced_pages_keep_full_turn_totals() {
    let fixture = Fixture::new();
    let mut conn = fixture.connection();
    let tx = conn.transaction().unwrap();
    for (id, state, project) in [
        ("alpha", "active", "E:/Target Project"),
        ("beta", "completed", "E:/Other"),
    ] {
        store::save_session(
            &tx,
            &SessionMeta {
                tool: "codex".into(),
                id: id.into(),
                status: state.into(),
                project: Some(project.into()),
                updated_at_ms: 1000,
                ..Default::default()
            },
        )
        .unwrap();
    }
    let mut record = UsageRecord {
        tool: "codex".into(),
        session_id: "alpha".into(),
        turn_id: "turn".into(),
        input_tokens: 1000,
        output_tokens: 100,
        context_tokens: Some(1000),
        model: Some("unverified-provider-model".into()),
        ..Default::default()
    };
    for (id, stamp) in [("unknown-1", 1), ("unknown-2", 2)] {
        record.id = id.into();
        record.timestamp_ms = stamp;
        store::save_usage(&tx, &record, i64::MAX, 1000).unwrap();
    }
    record.id = "scenario".into();
    record.model = Some("gpt-6.1-sol".into());
    store::save_usage(&tx, &record, i64::MAX, 1000).unwrap();
    record.id = "priced-zero".into();
    record.mode = Some("standard".into());
    record.mode_basis = "response_reported".into();
    record.input_tokens = 0;
    record.output_tokens = 0;
    record.context_tokens = Some(0);
    store::save_usage(&tx, &record, i64::MAX, 1000).unwrap();
    tx.commit().unwrap();

    let all = store::sessions(&conn, None, 1000).unwrap();
    assert_eq!(store::sum_sessions(&all).request_count, 4);
    let mut filtered = all.clone();
    store::filter_sessions(&mut filtered, "TARGET PROJECT", Some(true), true);
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].meta.id, "alpha");
    let mut historical = all.clone();
    store::filter_sessions(&mut historical, "BETA", Some(false), false);
    assert_eq!(historical.len(), 1);
    assert_eq!(historical[0].meta.id, "beta");
    assert_eq!(all.len(), 2);

    let first = store::session_detail(
        &conn,
        "codex:alpha",
        0,
        1,
        1000,
        true,
        &MonitorPeriod::default(),
    )
    .unwrap();
    let second = store::session_detail(
        &conn,
        "codex:alpha",
        1,
        1,
        1000,
        true,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert_eq!(first.request_count, 3);
    assert_eq!(first.session.totals.request_count, 4);
    assert_eq!(first.turns[0].totals.request_count, 4);
    assert_eq!(first.requests[0].usage.id, "scenario");
    assert_eq!(second.requests[0].usage.id, "unknown-2");
    let unfiltered = store::session_detail(
        &conn,
        "codex:alpha",
        0,
        100,
        1000,
        false,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert_eq!(
        unfiltered
            .requests
            .iter()
            .find(|r| r.usage.id == "priced-zero")
            .unwrap()
            .cost
            .usd,
        Some(0.0)
    );
}

#[test]
fn period_analysis_counts_parent_and_child_requests_once_with_saved_quotes() {
    let fixture = Fixture::new();
    let mut conn = fixture.connection();
    let tx = conn.transaction().unwrap();
    for (tool, id, parent) in [
        ("codex", "parent", None),
        ("codex", "child", Some("parent")),
        ("claude", "work", None),
    ] {
        store::save_session(
            &tx,
            &SessionMeta {
                tool: tool.into(),
                id: id.into(),
                parent_id: parent.map(str::to_owned),
                model: Some("last-model-is-not-a-request-filter".into()),
                updated_at_ms: 2_000,
                status: "active".into(),
                ..Default::default()
            },
        )
        .unwrap();
    }
    for (id, tool, session, stamp, model, mode) in [
        (
            "before",
            "codex",
            "parent",
            999,
            "gpt-6.1-sol",
            Some("standard"),
        ),
        (
            "start",
            "codex",
            "parent",
            1_000,
            "gpt-6.1-sol",
            Some("standard"),
        ),
        ("scenario", "codex", "child", 1_100, "gpt-6.1-sol", None),
        ("unknown", "codex", "child", 1_500, "unknown-model", None),
        ("glm", "claude", "work", 1_700, "glm-5.2", Some("standard")),
        (
            "end",
            "codex",
            "parent",
            2_000,
            "gpt-6.1-sol",
            Some("standard"),
        ),
    ] {
        let usage = UsageRecord {
            id: id.into(),
            tool: tool.into(),
            session_id: session.into(),
            timestamp_ms: stamp,
            turn_id: id.into(),
            model: Some(model.into()),
            mode: mode.map(str::to_owned),
            mode_basis: "response_reported".into(),
            input_tokens: 1_000,
            context_tokens: Some(1_000),
            output_tokens: 100,
            cache_read_tokens: 200,
            ..Default::default()
        };
        store::save_usage(&tx, &usage, i64::MAX, 2_000).unwrap();
    }
    tx.commit().unwrap();
    let period = MonitorPeriod {
        start_ms: Some(1_000),
        end_ms: Some(2_000),
        ..Default::default()
    };
    let result = super::analysis::read(&conn, None, &period, "", None, false, 0, 1, 2_000).unwrap();
    assert_eq!(result.totals.request_count, 4);
    assert_eq!(result.totals.total_tokens, 4_400);
    assert_eq!(result.totals.cache_hit_ratio, Some(0.2));
    assert_eq!(result.totals.scenario_requests, 1);
    assert_eq!(result.totals.unpriced_requests, 2);
    assert_eq!(result.session_count, 3);
    assert_eq!(result.sessions.len(), 1);
    assert_eq!(result.by_model.len(), 3);
    assert_eq!(result.by_tool.len(), 2);
    assert_eq!(
        result
            .timeline
            .iter()
            .map(|b| b.totals.request_count)
            .sum::<i64>(),
        4
    );
    assert_eq!(result.latest_request_at_ms["codex"], Some(2_000));
    let filtered = super::analysis::read(
        &conn,
        Some("codex"),
        &MonitorPeriod {
            model: Some("gpt-6.1-sol".into()),
            ..period
        },
        "child",
        None,
        false,
        0,
        100,
        2_000,
    )
    .unwrap();
    assert_eq!(filtered.totals.request_count, 2);
    assert_eq!(filtered.session_count, 1);
    assert_eq!(filtered.sessions[0].totals.request_count, 1);
    assert_eq!(filtered.by_model.len(), 1);
    assert!(filtered
        .available_models
        .contains(&"unknown-model".to_owned()));
}

#[test]
fn turn_index_is_complete_and_request_selection_does_not_shrink_period_totals() {
    let fixture = Fixture::new();
    let mut conn = fixture.connection();
    let tx = conn.transaction().unwrap();
    store::save_session(
        &tx,
        &SessionMeta {
            tool: "codex".into(),
            id: "turns".into(),
            status: "active".into(),
            updated_at_ms: 1_000,
            ..Default::default()
        },
    )
    .unwrap();
    for (id, stamp, turn) in [
        ("old", 999, "old"),
        ("first", 1_000, "one"),
        ("second", 1_500, "two"),
        ("last", 1_900, "one"),
    ] {
        store::save_usage(
            &tx,
            &UsageRecord {
                tool: "codex".into(),
                id: id.into(),
                session_id: "turns".into(),
                timestamp_ms: stamp,
                turn_id: turn.into(),
                model: Some("unknown-model".into()),
                input_tokens: 100,
                output_tokens: 10,
                ..Default::default()
            },
            i64::MAX,
            2_000,
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let period = MonitorPeriod {
        start_ms: Some(1_000),
        end_ms: Some(2_000),
        turn_id: Some("two".into()),
        ..Default::default()
    };
    let detail = store::session_detail(&conn, "codex:turns", 0, 1, 200_000, true, &period).unwrap();
    assert_eq!(detail.session.totals.request_count, 4);
    assert_eq!(detail.filtered_totals.request_count, 3);
    assert_eq!(detail.request_count, 1);
    assert_eq!(detail.requests[0].usage.id, "second");
    assert_eq!(detail.turns.len(), 2);
    assert_eq!(detail.turns[0].id, "one");
    assert_eq!(detail.turns[0].totals.request_count, 2);
    assert_eq!(detail.turns[0].started_at_ms, 1_000);
    assert_eq!(detail.turns[0].updated_at_ms, 1_900);
    let mut sessions = store::sessions(&conn, None, 200_000).unwrap();
    assert_eq!(sessions[0].meta.status, "stale");
    store::filter_sessions(&mut sessions, "", Some(true), false);
    assert_eq!(
        sessions.len(),
        1,
        "a long running turn without a completion event remains visible as unconfirmed"
    );
}

#[test]
fn recent_output_is_visible_when_the_source_has_no_running_marker() {
    let fixture = Fixture::new();
    let mut conn = fixture.connection();
    let tx = conn.transaction().unwrap();
    store::save_usage(
        &tx,
        &UsageRecord {
            tool: "claude".into(),
            id: "recent".into(),
            session_id: "unmarked".into(),
            timestamp_ms: 200_000,
            output_tokens: 120,
            ..Default::default()
        },
        100_000,
        200_000,
    )
    .unwrap();
    tx.commit().unwrap();
    let mut current = store::sessions(&conn, Some("claude"), 200_000).unwrap();
    store::filter_sessions(&mut current, "", Some(true), false);
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].meta.status, "recent");
    assert_eq!(current[0].totals.output_tokens_per_second, 2.0);
    assert_eq!(
        store::sessions(&conn, Some("claude"), 261_000).unwrap()[0]
            .meta
            .status,
        "unknown"
    );
}

#[test]
fn rate_contributors_include_completed_sessions_without_recounting_replays() {
    let fixture = Fixture::new();
    let mut conn = fixture.connection();
    let tx = conn.transaction().unwrap();
    for (id, status, parent) in [
        ("waiting", "active", None),
        ("done", "idle", None),
        ("child", "idle", Some("waiting")),
    ] {
        store::save_session(
            &tx,
            &SessionMeta {
                tool: "codex".into(),
                id: id.into(),
                status: status.into(),
                parent_id: parent.map(str::to_owned),
                updated_at_ms: 200_000,
                ..Default::default()
            },
        )
        .unwrap();
    }
    let mut done = UsageRecord {
        tool: "codex".into(),
        id: "response:done".into(),
        session_id: "done".into(),
        timestamp_ms: 200_000,
        output_tokens: 1200,
        ..Default::default()
    };
    for _ in 0..2 {
        store::save_usage(&tx, &done, 100_000, 200_000).unwrap();
    }
    done.output_tokens = 1260;
    store::save_usage(&tx, &done, 100_000, 201_000).unwrap();
    store::save_usage(
        &tx,
        &UsageRecord {
            tool: "codex".into(),
            id: "response:child".into(),
            session_id: "child".into(),
            timestamp_ms: 200_000,
            output_tokens: 300,
            ..Default::default()
        },
        100_000,
        200_000,
    )
    .unwrap();
    tx.commit().unwrap();
    let all = store::sessions(&conn, None, 201_000).unwrap();
    let contributors = store::rate_sessions(&all);
    assert_eq!(contributors.len(), 3);
    assert_eq!(
        contributors
            .iter()
            .filter(|s| s.meta.status == "active")
            .count(),
        1
    );
    assert_eq!(store::sum_sessions(&all).output_tokens_per_second, 26.0);
    assert_eq!(
        store::sum_sessions(&contributors).output_tokens_per_second,
        26.0
    );
    let waiting = contributors
        .iter()
        .find(|s| s.meta.id == "waiting")
        .unwrap();
    assert_eq!(waiting.totals.output_tokens_per_second, 0.0);
    let expired = store::rate_sessions(&store::sessions(&conn, None, 261_001).unwrap());
    assert_eq!(
        expired.len(),
        1,
        "completed sessions expire, active/unconfirmed remains"
    );
    assert_eq!(store::sum_sessions(&expired).output_tokens_per_second, 0.0);
    let detail = store::session_detail(
        &conn,
        "codex:done",
        0,
        100,
        201_000,
        false,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert_eq!(detail.requests[0].usage.duration_ms, None);
}

#[test]
fn rate_antigravity_long_requests_require_reported_duration_and_recent_endpoint() {
    let fixture = Fixture::new();
    let mut conn = fixture.connection();
    let tx = conn.transaction().unwrap();
    for (id, start, duration) in [
        ("long", 100_000, Some(120_000)),
        ("missing", 100_000, None),
        ("history", 1_000, Some(120_000)),
        ("future", 100_000, Some(200_000)),
    ] {
        store::save_usage(
            &tx,
            &UsageRecord {
                tool: "antigravity".into(),
                id: id.into(),
                session_id: id.into(),
                timestamp_ms: start,
                duration_ms: duration,
                output_tokens: 600,
                ..Default::default()
            },
            200_000,
            220_000,
        )
        .unwrap();
    }
    tx.commit().unwrap();
    let all = store::sessions(&conn, None, 220_000).unwrap();
    assert_eq!(store::sum_sessions(&all).output_tokens_per_second, 10.0);
    assert_eq!(
        store::sum_sessions(&all).request_count,
        4,
        "timing guards never drop durable usage"
    );
    let detail = store::session_detail(
        &conn,
        "antigravity:long",
        0,
        100,
        220_000,
        false,
        &MonitorPeriod::default(),
    )
    .unwrap();
    assert_eq!(
        detail.requests[0].usage.timestamp_ms, 100_000,
        "source start is not rewritten as observed completion"
    );
    assert_eq!(
        store::sum_sessions(&store::sessions(&conn, None, 280_001).unwrap())
            .output_tokens_per_second,
        0.0
    );
}
