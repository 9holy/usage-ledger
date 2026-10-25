//! Fixture integration tests: real discovery, decoder, SQLite store and pricing.
use super::{deepseek, store};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "ledger-dsh-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
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
fn line(value: Value) -> String {
    format!("{value}\n")
}
fn header() -> String {
    line(
        json!({"type":"session","version":4,"id":"fixture-session","createdAt":1700000000000i64,"isSeeded":false,"delegationDepth":0}),
    )
}
fn event(seq: i64, turn: i64) -> String {
    line(
        json!({"type":"assistant/message","seq":seq,"time":1700000001000i64+seq,"surfaceOp":"append","data":{"turn":turn,"step":1,"message":{"content":[{"type":"text","text":"DO_NOT_PERSIST_PRIVATE_PROMPT"}],"source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"}},"usage":{"inputTokens":10,"outputTokens":3,"cacheReadTokens":20,"cacheWriteTokens":0}}}),
    )
}
fn totals(conn: &Connection) -> (i64, i64) {
    conn.query_row("SELECT COUNT(*),COALESCE(SUM(json_extract(usage,'$.inputTokens')),0) FROM monitor_requests", [], |r| Ok((r.get(0)?,r.get(1)?))).unwrap()
}

#[test]
fn compressed_append_restart_is_idempotent_and_keeps_no_message_body() {
    let f = Fixture::new();
    let session_dir = f.0.join("sessions/project/session");
    fs::create_dir_all(&session_dir).unwrap();
    let path = session_dir.join("session.v4.jsonl.zstd");
    let first =
        zstd::stream::encode_all(format!("{}{}", header(), event(0, 1)).as_bytes(), 1).unwrap();
    fs::write(&path, first).unwrap();
    let db = f.0.join("ledger.sqlite");
    let mut conn = Connection::open(&db).unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (1, 30));
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (1, 30));
    drop(conn);
    // A separate appended frame is the upstream default storage representation.
    let frame = zstd::stream::encode_all(event(1, 2).as_bytes(), 1).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(&frame)
        .unwrap();
    let mut conn = Connection::open(&db).unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (2, 60));
    let retained: String = conn
        .query_row(
            "SELECT group_concat(usage,'') FROM monitor_requests",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(!retained.contains("DO_NOT_PERSIST_PRIVATE_PROMPT"));
    assert!(!retained.contains("content"));
    assert!(retained.contains("deepseek-official"));
}

#[test]
fn incomplete_compressed_frame_preserves_history_and_retries_after_append() {
    let f = Fixture::new();
    let path = f.0.join("session.v4.jsonl.zstd");
    fs::write(&path, zstd::stream::encode_all(format!("{}{}", header(), event(0, 1)).as_bytes(), 1).unwrap()).unwrap();
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    let signature: String = conn.query_row("SELECT signature FROM monitor_files", [], |row| row.get(0)).unwrap();
    let frame = zstd::stream::encode_all(event(1, 2).as_bytes(), 1).unwrap();
    fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(&frame[..frame.len() - 1]).unwrap();
    assert!(deepseek::ingest(&mut conn, &path, i64::MAX).is_err());
    assert_eq!(totals(&conn), (1, 30));
    assert_eq!(conn.query_row::<String, _, _>("SELECT signature FROM monitor_files", [], |row| row.get(0)).unwrap(), signature);
    fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(&frame[frame.len() - 1..]).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (2, 60));
}

#[test]
fn discovery_selects_newest_generation_and_ignores_temporaries() {
    let f = Fixture::new();
    for name in [
        "session.v2.jsonl",
        "session.v4.jsonl.zstd",
        "session.v4.jsonl.tmp",
        "session.v04.jsonl",
        "settings.jsonl",
    ] {
        fs::write(f.0.join(name), "").unwrap();
    }
    assert_eq!(
        deepseek::discover(&f.0).unwrap(),
        vec![f.0.join("session.v4.jsonl.zstd")]
    );
}

#[test]
fn corrupt_snapshot_does_not_replace_committed_usage_or_advance_signature() {
    let f = Fixture::new();
    let path = f.0.join("session.v4.jsonl");
    fs::write(&path, format!("{}{}", header(), event(0, 1))).unwrap();
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    let signature: String = conn
        .query_row("SELECT signature FROM monitor_files", [], |r| r.get(0))
        .unwrap();
    fs::write(&path, format!("{}{}{{bad-json}}\n", header(), event(0, 2))).unwrap();
    assert!(deepseek::ingest(&mut conn, &path, i64::MAX).is_err());
    assert_eq!(totals(&conn), (1, 30));
    assert_eq!(
        signature,
        conn.query_row::<String, _, _>("SELECT signature FROM monitor_files", [], |r| r.get(0))
            .unwrap()
    );
}

#[test]
fn mismatched_filename_and_header_cannot_replace_committed_usage() {
    let f = Fixture::new();
    let path = f.0.join("session.v4.jsonl");
    fs::write(&path, format!("{}{}", header(), event(0, 1))).unwrap();
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    fs::write(&path, header().replace("\"version\":4", "\"version\":2")).unwrap();
    assert!(deepseek::ingest(&mut conn, &path, i64::MAX).unwrap_err().contains("filename/header"));
    assert_eq!(totals(&conn), (1, 30));
}

#[test]
fn replaced_snapshot_removes_retired_attempts() {
    let f = Fixture::new();
    let path = f.0.join("session.v4.jsonl");
    fs::write(&path, format!("{}{}{}", header(), event(0, 1), event(1, 2))).unwrap();
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (2, 60));
    fs::write(&path, format!("{}{}", header(), event(0, 1))).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (1, 30));
    fs::write(&path, format!("{}{}{}", header(), event(0, 1), event(1, 2))).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (2, 60));
    let aliases: i64 = conn
        .query_row("SELECT COUNT(*) FROM monitor_aliases", [], |r| r.get(0))
        .unwrap();
    assert_eq!(aliases, 0);
}

#[test]
fn route_alias_is_preserved_without_claiming_verified_billing_provider() {
    let log = format!("{}{}", header(), event(0, 1));
    let (_, rows) = super::deepseek_parser::parse_lines(log.as_bytes()).unwrap();
    let catalog = crate::model_catalog::CatalogSnapshot::parse(
        r#"{"deepseek":{"models":{"deepseek-v4-flash":{"cost":{"input":1,"output":2,"cache_read":0.1}}}}}"#,
        "fixture".into(), 0).unwrap();
    let cost = super::pricing::estimate_with_catalog(&rows[0], &catalog);
    assert_eq!(rows[0].provider.as_deref(), Some("deepseek-official"));
    assert!(cost
        .reason
        .as_deref()
        .unwrap()
        .contains("actual_provider_unknown"));
    assert!(cost
        .reason
        .as_deref()
        .unwrap()
        .contains("not_historical_paid_cost"));
}

#[test]
fn torn_snapshot_preserves_previously_committed_history() {
    let f = Fixture::new();
    let path = f.0.join("session.v4.jsonl");
    fs::write(&path, format!("{}{}{}", header(), event(0, 1), event(1, 2))).unwrap();
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    fs::write(&path, format!("{}{}{{\"type\":", header(), event(0, 1))).unwrap();
    assert!(deepseek::ingest(&mut conn, &path, i64::MAX).is_err());
    assert_eq!(totals(&conn), (2, 60));
}

#[test]
fn newer_generation_replaces_usage_instead_of_counting_both() {
    let f = Fixture::new();
    let old = f.0.join("session.v2.jsonl");
    fs::write(
        &old,
        format!(
            "{}{}",
            header().replace("\"version\":4", "\"version\":2"),
            event(0, 1)
        ),
    )
    .unwrap();
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &old, i64::MAX).unwrap();
    let new = f.0.join("session.v4.jsonl");
    fs::write(&new, format!("{}{}", header(), event(0, 2))).unwrap();
    deepseek::ingest(&mut conn, &new, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (1, 30));
    deepseek::ingest(&mut conn, &old, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (1, 30));
}

#[test]
fn disappeared_newest_generation_cannot_roll_back_history_after_restart() {
    let f = Fixture::new();
    let old = f.0.join("session.v2.jsonl");
    let new = f.0.join("session.v4.jsonl");
    fs::write(&old, format!("{}{}", header().replace("\"version\":4", "\"version\":2"), event(0, 1))).unwrap();
    fs::write(&new, format!("{}{}{}", header(), event(0, 1), event(1, 2))).unwrap();
    let db = f.0.join("ledger.sqlite");
    let mut conn = Connection::open(&db).unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &new, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (2, 60));
    drop(conn);
    fs::remove_file(&new).unwrap();
    assert_eq!(deepseek::discover(&f.0).unwrap(), vec![old.clone()]);
    let mut conn = Connection::open(&db).unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &old, i64::MAX).unwrap();
    assert_eq!(totals(&conn), (2, 60));
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_files", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn snapshot_reconciliation_cannot_remove_another_tools_same_request_identity() {
    let f = Fixture::new();
    let path = f.0.join("session.v4.jsonl");
    let log = format!("{}{}", header(), event(0, 1));
    fs::write(&path, &log).unwrap();
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    let (_, mut rows) = super::deepseek_parser::parse_lines(log.as_bytes()).unwrap();
    rows[0].tool = "codex".into();
    let tx = conn.transaction().unwrap();
    store::save_usage(&tx, &rows[0], i64::MAX, 0).unwrap();
    tx.commit().unwrap();
    fs::write(&path, header()).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    let tools: Vec<String> = conn.prepare("SELECT tool FROM monitor_requests").unwrap()
        .query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
    assert_eq!(tools, vec!["codex"]);
    assert_eq!(store::sessions(&conn, Some("codex"), 1_800_000_000_000).unwrap()[0].totals.input_tokens, 30);
}

#[test]
#[ignore = "Requires an explicitly copied Harness sessions directory"]
fn copied_harness_sessions_diagnostic() {
    use std::io::{BufRead, BufReader, Read};
    let root = PathBuf::from(std::env::var_os("USAGE_LEDGER_DSH_COPY").expect("Set USAGE_LEDGER_DSH_COPY to a copied sessions directory"));
    let paths = deepseek::discover(&root).unwrap();
    assert!(!paths.is_empty(), "Copied source contains no canonical session artifacts");
    let mut source_records = 0;
    let mut assistant_records = 0;
    for path in &paths {
        let file = fs::File::open(path).unwrap();
        let reader: Box<dyn Read> = if path.extension().is_some_and(|extension| extension == "zstd") {
            Box::new(zstd::stream::read::Decoder::new(file).unwrap())
        } else { Box::new(file) };
        for line in BufReader::new(reader).lines() {
            let value: Value = serde_json::from_str(&line.unwrap()).unwrap();
            source_records += 1;
            assistant_records += usize::from(matches!(value["type"].as_str(), Some("assistant/message" | "assistant/attempt")));
        }
    }
    let f = Fixture::new();
    let db = f.0.join("isolated.sqlite");
    let mut conn = Connection::open(&db).unwrap();
    store::initialize(&conn).unwrap();
    for path in &paths {
        deepseek::ingest(&mut conn, path, i64::MAX).unwrap();
    }
    let summary = |conn: &Connection| conn.query_row(
        "SELECT COUNT(*),COALESCE(SUM(json_extract(usage,'$.inputTokens')),0),COALESCE(SUM(json_extract(usage,'$.outputTokens')),0),COALESCE(SUM(json_extract(usage,'$.cacheReadTokens')),0),COALESCE(SUM(json_extract(usage,'$.cacheWriteTokens')),0),COALESCE(MAX(timestamp_ms),0) FROM monitor_requests WHERE tool='deepseek-harness'",
        [], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?, row.get::<_, i64>(4)?, row.get::<_, i64>(5)?)),
    ).unwrap();
    let first = summary(&conn);
    drop(conn);
    let mut conn = Connection::open(&db).unwrap();
    store::initialize(&conn).unwrap();
    for path in &paths {
        deepseek::ingest(&mut conn, path, i64::MAX).unwrap();
    }
    assert_eq!(summary(&conn), first);
    let analysis = super::analysis::read(&conn, Some(deepseek::TOOL), &super::types::MonitorPeriod::default(), "", None, false, 0, 100, first.5 + 1).unwrap();
    assert_eq!(analysis.totals.request_count, first.0);
    assert_eq!(analysis.totals.input_tokens, first.1);
    assert_eq!(analysis.totals.output_tokens, first.2);
    assert_eq!(super::live::read(&conn, first.5 + 1, 0, first.5 + 1).unwrap().by_tool.iter().find(|group| group.tool.as_deref() == Some(deepseek::TOOL)).unwrap().windows[0].observed_output_tokens, 0);
    eprintln!("Copied Harness validation: artifacts={}, source_records={}, assistant_records={}, requests={}, input={}, output={}, cache_read={}, cache_write={}, restart_deduplicated=true", paths.len(), source_records, assistant_records, first.0, first.1, first.2, first.3, first.4);
}

#[test]
fn legacy_flat_files_surface_an_explicit_unsupported_format_error() {
    let f = Fixture::new();
    let project = f.0.join("project");
    fs::create_dir_all(&project).unwrap();
    let path = project.join("legacy-id.jsonl");
    fs::write(&path, "{\"type\":\"session\",\"version\":0}\n").unwrap();
    assert_eq!(deepseek::discover(&f.0).unwrap(), vec![path.clone()]);
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    assert!(deepseek::ingest(&mut conn, &path, i64::MAX)
        .unwrap_err()
        .contains("Unsupported DeepSeek Harness session format v0"));
    assert_eq!(totals(&conn), (0, 0));
}

#[test]
fn retired_encoding_conflicts_do_not_hide_newest_generation() {
    for higher_first in [false, true] {
        let f = Fixture::new();
        let dir = f.0.join("sessions/project/session");
        fs::create_dir_all(&dir).unwrap();
        let names = if higher_first {
            vec![
                "session.v4.jsonl",
                "session.v2.jsonl",
                "session.v2.jsonl.zstd",
            ]
        } else {
            vec![
                "session.v2.jsonl",
                "session.v2.jsonl.zstd",
                "session.v4.jsonl",
            ]
        };
        for name in names {
            fs::write(dir.join(name), "").unwrap();
        }
        assert_eq!(
            deepseek::discover(&f.0.join("sessions")).unwrap(),
            vec![dir.join("session.v4.jsonl")]
        );
        fs::write(dir.join("session.v4.jsonl.zstd"), "").unwrap();
        assert!(deepseek::discover(&f.0.join("sessions")).is_err());
    }
}

#[test]
fn authoritative_snapshot_missing_fields_matches_a_fresh_import() {
    let f = Fixture::new();
    let path = f.0.join("session.v4.jsonl");
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    fs::write(&path, format!("{}{}", header(), event(0, 1))).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    let mut replacement: Value = serde_json::from_str(&event(0, 1)).unwrap();
    replacement["data"]["usage"]
        .as_object_mut()
        .unwrap()
        .remove("cacheReadTokens");
    replacement["data"]["usage"]["totalTokens"] = json!(13);
    replacement["data"]["message"]
        .as_object_mut()
        .unwrap()
        .remove("source");
    fs::write(&path, format!("{}{}", header(), line(replacement))).unwrap();
    deepseek::ingest(&mut conn, &path, i64::MAX).unwrap();
    let mut fresh = Connection::open_in_memory().unwrap();
    store::initialize(&fresh).unwrap();
    deepseek::ingest(&mut fresh, &path, i64::MAX).unwrap();
    let stored = |db: &Connection| -> String {
        db.query_row("SELECT usage FROM monitor_requests", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(stored(&conn), stored(&fresh));
    let row: Value = serde_json::from_str(&stored(&conn)).unwrap();
    assert_eq!(row["inputTokens"], 10);
    assert_eq!(row["cacheReadTokens"], 0);
    assert!(row["unknownFields"]
        .as_array()
        .unwrap()
        .contains(&json!("cache_read_tokens")));
    assert!(row["model"].is_null());
    assert_eq!(totals(&conn), (1, 10));
}

#[test]
fn generic_partial_chunk_enrichment_remains_enabled() {
    let (_, rows) =
        super::deepseek_parser::parse_lines(format!("{}{}", header(), event(0, 1)).as_bytes())
            .unwrap();
    let mut conn = Connection::open_in_memory().unwrap();
    store::initialize(&conn).unwrap();
    let tx = conn.transaction().unwrap();
    store::save_session(
        &tx,
        &super::types::SessionMeta {
            tool: rows[0].tool.clone(),
            id: rows[0].session_id.clone(),
            ..Default::default()
        },
    )
    .unwrap();
    store::save_usage(&tx, &rows[0], i64::MAX, 0).unwrap();
    let mut partial = rows[0].clone();
    partial.cache_read_tokens = 0;
    partial.unknown_fields.push("cache_read_tokens".into());
    store::save_usage(&tx, &partial, i64::MAX, 0).unwrap();
    let read: i64 = tx
        .query_row(
            "SELECT json_extract(usage,'$.cacheReadTokens') FROM monitor_requests",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(read, 20);
}

#[test]
fn successful_discovery_clears_only_retired_source_errors() {
    let root = PathBuf::from("sessions");
    let retired = root.join("project/session/session.v2.jsonl");
    let active = root.join("project/session/session.v4.jsonl");
    let unrelated = PathBuf::from("other/session.jsonl");
    let mut errors = std::collections::HashMap::from([
        (retired.clone(), "old corruption".to_string()),
        (active.clone(), "active failure".to_string()),
        (unrelated.clone(), "other collector".to_string()),
    ]);
    deepseek::reconcile_errors(&mut errors, &root, &[active.clone()]);
    assert!(!errors.contains_key(&retired));
    assert!(errors.contains_key(&active));
    assert!(errors.contains_key(&unrelated));
}
