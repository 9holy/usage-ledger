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
