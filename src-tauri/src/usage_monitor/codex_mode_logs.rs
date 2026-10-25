use super::{collector::SourceRoot, store, types::SourceStatus};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    time::Duration,
};

const BATCH_ROWS: usize = 512;

pub struct ModeBatch {
    pub observations: Vec<store::RuntimeModeObservation>,
    pub next_cursor: store::RuntimeModeCursor,
    pub invalid_rows: usize,
    pub catching_up: bool,
}

fn metadata_status(path: &Path, error: Option<String>) -> SourceStatus {
    SourceStatus {
        tool: "codex".into(),
        root: path.to_string_lossy().into(),
        status: "metadata".into(),
        files: usize::from(path.is_file()),
        last_scan_ms: crate::ledger_db::now_ms(),
        error,
        ..Default::default()
    }
}

pub fn discover(roots: &[SourceRoot]) -> (Vec<PathBuf>, Vec<SourceStatus>) {
    let homes: BTreeSet<_> = roots
        .iter()
        .filter(|root| root.tool == "codex")
        .filter_map(|root| root.path.parent().map(Path::to_owned))
        .collect();
    let mut paths = Vec::new();
    let mut issues = Vec::new();
    for home in homes {
        let entries = match std::fs::read_dir(&home) {
            Ok(entries) => entries,
            Err(error) => {
                issues.push(metadata_status(
                    &home.join("logs_*.sqlite"),
                    Some(format!("Codex mode log discovery unavailable: {error}")),
                ));
                continue;
            }
        };
        let before = paths.len();
        for entry in entries {
            match entry {
                Ok(entry) => {
                    let name = entry.file_name();
                    if name
                        .to_str()
                        .is_some_and(|name| name.starts_with("logs_") && name.ends_with(".sqlite"))
                    {
                        paths.push(entry.path());
                    }
                }
                Err(error) => issues.push(metadata_status(
                    &home,
                    Some(format!("Codex mode log discovery unavailable: {error}")),
                )),
            }
        }
        if paths.len() == before {
            issues.push(metadata_status(
                &home.join("logs_*.sqlite"),
                Some(
                    "Codex runtime mode logs are not available; missing modes remain unknown"
                        .into(),
                ),
            ));
        }
    }
    paths.sort();
    (paths, issues)
}

// Read only named span attributes, never free text or proximity to a different turn.
fn span_values(body: &str, key: &str) -> Result<Vec<String>, &'static str> {
    let mut values = Vec::new();
    let mut offset = 0;
    while let Some(found) = body[offset..].find(key) {
        let start = offset + found;
        offset = start + key.len();
        if start > 0 && body.as_bytes()[start - 1].is_ascii_alphanumeric()
            || start > 0 && matches!(body.as_bytes()[start - 1], b'_' | b'.')
        {
            continue;
        }
        let after = body[offset..].trim_start();
        let after = after.strip_prefix('"').unwrap_or(after).trim_start();
        let Some(after) = after.strip_prefix('=').or_else(|| after.strip_prefix(':')) else {
            continue;
        };
        let after = after
            .trim_start()
            .strip_prefix('"')
            .unwrap_or(after.trim_start());
        let value: String = after
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
            .collect();
        if value.is_empty() {
            return Err("malformed span identity");
        }
        values.push(value);
    }
    Ok(values)
}

fn exact_identity(
    body: &str,
    keys: &[&str],
    expected: Option<&str>,
) -> Result<String, &'static str> {
    let mut values = Vec::new();
    for key in keys {
        values.extend(span_values(body, key)?);
    }
    let first = values.first().ok_or("missing span identity")?;
    if values.iter().any(|value| value != first)
        || expected.is_some_and(|expected| expected != first)
    {
        return Err("conflicting span identity");
    }
    Ok(first.clone())
}

fn parse_observation(
    id: i64,
    ts: i64,
    nanos: i64,
    thread: &str,
    body: &str,
) -> Result<Option<store::RuntimeModeObservation>, &'static str> {
    let thread = exact_identity(
        body,
        &["thread_id", "thread.id", "conversation.id"],
        Some(thread),
    )?;
    let turn = exact_identity(body, &["turn_id", "turn.id", "submission.id"], None)?;
    let offset = body.find("tags_json").ok_or("missing structured tags")? + "tags_json".len();
    let after = body[offset..].trim_start();
    let after = after.strip_prefix('"').unwrap_or(after).trim_start();
    let json = after
        .strip_prefix('=')
        .or_else(|| after.strip_prefix(':'))
        .ok_or("malformed structured tags")?
        .trim_start();
    let value = serde_json::Deserializer::from_str(json)
        .into_iter::<Value>()
        .next()
        .ok_or("missing structured tags")?
        .map_err(|_| "malformed structured tags")?;
    let value = match value {
        Value::String(value) => {
            serde_json::from_str(&value).map_err(|_| "malformed structured tags")?
        }
        value => value,
    };
    let tags = value.as_object().ok_or("tags must be an object")?;
    let tier = match tags.get("service_tier") {
        None => return Ok(None),
        Some(Value::Null) => Some("auto"),
        Some(Value::String(value)) => Some(value.as_str()),
        Some(_) => return Err("service tier must be a string or null"),
    };
    let mode = match tier {
        Some("default" | "standard" | "normal") => "standard",
        Some("priority" | "fast") => "fast",
        Some("ultrafast" | "ultra_fast") => "ultrafast",
        Some("flex") => "flex",
        Some("scale") => "scale",
        Some("auto") => "unknown",
        None => return Ok(None),
        Some(_) => return Err("unrecognized service tier"),
    };
    let observed_at_ms = ts
        .checked_mul(1000)
        .and_then(|ms| ms.checked_add(nanos / 1_000_000))
        .filter(|ms| *ms > 0 && (0..1_000_000_000).contains(&nanos))
        .ok_or("invalid source time")?;
    Ok(Some(store::RuntimeModeObservation {
        session_key: store::session_key("codex", &thread),
        turn_id: turn,
        mode: mode.into(),
        observed_at_ms,
        source_row_id: id,
    }))
}

pub fn read_batch(
    source: &Connection,
    cursor: &store::RuntimeModeCursor,
) -> Result<ModeBatch, String> {
    // Keep the checkpoint check and consumed rows in one read-only SQLite snapshot.
    let source = source
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let upper = source
        .query_row(
            "SELECT id,ts,ts_nanos FROM logs ORDER BY id DESC LIMIT 1",
            [],
            |row| {
                Ok(store::RuntimeModeCursor {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    ts_nanos: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or_default();
    let checkpoint = if cursor.id > 0 {
        source
            .query_row(
                "SELECT ts,ts_nanos FROM logs WHERE id=?1",
                [cursor.id],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?
    } else {
        None
    };
    let after_id = if cursor.id == 0 || checkpoint == Some((cursor.ts, cursor.ts_nanos)) {
        cursor.id
    } else {
        0
    };
    let mut statement = source.prepare("SELECT id,ts,ts_nanos,thread_id,feedback_log_body FROM logs
        WHERE id>?1 AND id<=?2 AND target='feedback_tags' AND module_path='codex_core::session::turn'
        ORDER BY id LIMIT ?3").map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![after_id, upper.id, BATCH_ROWS], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut batch = ModeBatch {
        observations: Vec::new(),
        next_cursor: upper.clone(),
        invalid_rows: 0,
        catching_up: false,
    };
    let mut read = 0;
    let mut last = store::RuntimeModeCursor::default();
    for row in rows {
        let (id, ts, nanos, thread, body) = row.map_err(|error| error.to_string())?;
        read += 1;
        last = store::RuntimeModeCursor {
            id,
            ts: Some(ts),
            ts_nanos: Some(nanos),
        };
        match thread
            .as_deref()
            .ok_or("missing thread identity")
            .and_then(|thread| parse_observation(id, ts, nanos, thread, &body))
        {
            Ok(Some(observation)) => batch.observations.push(observation),
            Ok(None) => {}
            Err(_) => batch.invalid_rows += 1,
        }
    }
    if read == BATCH_ROWS {
        batch.catching_up = last.id < upper.id;
        batch.next_cursor = last;
    }
    Ok(batch)
}

pub fn collect(conn: &mut Connection, paths: &[PathBuf]) -> Vec<SourceStatus> {
    paths.iter().map(|path| {
        let result = (|| {
            let source = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
                .map_err(|error| error.to_string())?;
            source.busy_timeout(Duration::from_millis(500)).map_err(|error| error.to_string())?;
            let source_path = path.to_string_lossy();
            let cursor = store::runtime_mode_cursor(conn, &source_path)?;
            let batch = read_batch(&source, &cursor)?;
            if batch.next_cursor != cursor || !batch.observations.is_empty() {
                store::apply_runtime_mode_batch(conn, &source_path, &batch.observations, &batch.next_cursor)?;
            }
            Ok::<_,String>(if batch.invalid_rows > 0 {
                Some(format!("{} runtime mode log rows have invalid tags or identities; their modes remain unknown", batch.invalid_rows))
            } else if batch.catching_up {
                Some("Runtime mode history is still being collected; uncollected modes remain unknown".into())
            } else { None })
        })();
        metadata_status(path, match result { Ok(issue) => issue, Err(error) => Some(format!("Runtime mode logs unavailable: {error}")) })
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body(thread: &str, turn: &str, tags: &str) -> String {
        format!("session_task.run{{thread_id={thread}}}: run_turn{{turn_id={turn} thread.id={thread} turn.id={turn} submission.id={turn}}}: tags_json={tags}")
    }
    #[test]
    fn exact_span_and_structured_tier_are_required_not_collaboration_mode() {
        let row = parse_observation(
            7,
            100,
            123_000_000,
            "thread",
            &body("thread", "turn", r#"{"service_tier":"priority"}"#),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            (
                row.session_key.as_str(),
                row.turn_id.as_str(),
                row.mode.as_str(),
                row.observed_at_ms
            ),
            ("codex:thread", "turn", "fast", 100123)
        );
        let quoted = serde_json::to_string(r#"{"service_tier":"default"}"#).unwrap();
        assert_eq!(
            parse_observation(8, 100, 0, "thread", &body("thread", "turn", &quoted))
                .unwrap()
                .unwrap()
                .mode,
            "standard"
        );
        assert!(parse_observation(
            9,
            100,
            0,
            "thread",
            &body("other", "turn", r#"{"service_tier":"priority"}"#)
        )
        .is_err());
        assert!(parse_observation(
            9,
            100,
            0,
            "thread",
            &body(
                "thread",
                "turn",
                r#"{"mode":"fast","collaboration_mode":{"mode":"default"}}"#
            )
        )
        .unwrap()
        .is_none());
        assert!(parse_observation(
            9,
            100,
            0,
            "thread",
            &body("thread", "turn", r#"{"service_tier":null}"#)
        )
        .unwrap()
        .is_none());
        assert!(
            parse_observation(9, 100, 0, "thread", &body("thread", "turn", "bad-json")).is_err()
        );
        let conflict = body("thread", "turn", r#"{"service_tier":"priority"}"#) + " turn_id=other";
        assert!(parse_observation(9, 100, 0, "thread", &conflict).is_err());
    }
    #[test]
    fn incremental_batches_consume_invalid_rows_and_recover_reset_without_skipping() {
        let source = Connection::open_in_memory().unwrap();
        source.execute_batch("CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,target TEXT,module_path TEXT,feedback_log_body TEXT)").unwrap();
        for id in 1..=514 {
            source.execute("INSERT INTO logs VALUES(?1,100,0,'thread','feedback_tags','codex_core::session::turn',?2)",params![id,if id==512 {"bad".into()} else {body("thread","turn",r#"{"service_tier":"priority"}"#)}]).unwrap();
        }
        let first = read_batch(&source, &store::RuntimeModeCursor::default()).unwrap();
        assert_eq!(
            (
                first.next_cursor.id,
                first.observations.len(),
                first.invalid_rows,
                first.catching_up
            ),
            (512, 511, 1, true)
        );
        assert_eq!(
            (first.next_cursor.ts, first.next_cursor.ts_nanos),
            (Some(100), Some(0))
        );
        let next = read_batch(&source, &first.next_cursor).unwrap();
        assert_eq!(
            (
                next.next_cursor.id,
                next.observations.len(),
                next.invalid_rows,
                next.catching_up
            ),
            (514, 2, 0, false)
        );
        assert!(read_batch(&source, &next.next_cursor)
            .unwrap()
            .observations
            .is_empty());
        source.execute("DELETE FROM logs WHERE id>1", []).unwrap();
        let reset = read_batch(&source, &next.next_cursor).unwrap();
        assert_eq!((reset.next_cursor.id, reset.observations.len()), (1, 1));
    }

    #[test]
    fn auto_is_explicit_unknown_evidence_not_missing_after_priority() {
        let fast = parse_observation(
            1,
            100,
            0,
            "thread",
            &body("thread", "turn", r#"{"service_tier":"priority"}"#),
        )
        .unwrap()
        .unwrap();
        let auto = parse_observation(
            2,
            101,
            0,
            "thread",
            &body("thread", "turn", r#"{"service_tier":"auto"}"#),
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            (fast.mode.as_str(), auto.mode.as_str()),
            ("fast", "unknown")
        );
        assert_eq!(
            (auto.session_key, auto.turn_id),
            (fast.session_key, fast.turn_id)
        );
        assert!(
            parse_observation(3, 102, 0, "thread", &body("thread", "turn", r#"{}"#))
                .unwrap()
                .is_none()
        );
        let cleared = parse_observation(4, 103, 0, "thread", &body("thread", "turn", r#"{"service_tier":null}"#)).unwrap().unwrap();
        assert_eq!(cleared.mode, "unknown");
    }

    #[test]
    fn recreated_database_with_higher_max_replays_once_using_checkpoint_identity() {
        let source = Connection::open_in_memory().unwrap();
        source.execute_batch("CREATE TABLE logs(id INTEGER PRIMARY KEY,ts INTEGER,ts_nanos INTEGER,thread_id TEXT,target TEXT,module_path TEXT,feedback_log_body TEXT)").unwrap();
        let tag = body("thread", "turn", r#"{"service_tier":"priority"}"#);
        source.execute("INSERT INTO logs VALUES(1000,100,5,'thread','feedback_tags','codex_core::session::turn',?1)",[&tag]).unwrap();
        let old = read_batch(&source, &store::RuntimeModeCursor::default())
            .unwrap()
            .next_cursor;
        assert_eq!(old.id, 1000);
        source.execute("DELETE FROM logs", []).unwrap();
        for id in [1, 1000, 1500] {
            source.execute("INSERT INTO logs VALUES(?1,200,6,'thread','feedback_tags','codex_core::session::turn',?2)",params![id,&tag]).unwrap();
        }
        let replay = read_batch(&source, &old).unwrap();
        assert_eq!(
            replay
                .observations
                .iter()
                .map(|row| row.source_row_id)
                .collect::<Vec<_>>(),
            vec![1, 1000, 1500]
        );
        assert_eq!(
            (
                replay.next_cursor.id,
                replay.next_cursor.ts,
                replay.next_cursor.ts_nanos
            ),
            (1500, Some(200), Some(6))
        );
        let unchanged = read_batch(&source, &replay.next_cursor).unwrap();
        assert!(unchanged.observations.is_empty());
        assert_eq!(unchanged.next_cursor, replay.next_cursor);
    }

    #[test]
    #[ignore = "explicit opt-in, read-only local metadata evidence"]
    fn local_runtime_mode_read_only_dry_run() {
        let path = std::env::var("CODEX_MODE_LOG_DRY_RUN_PATH").unwrap();
        let expected_at: i64 = std::env::var("CODEX_MODE_LOG_EXPECTED_AT_MS")
            .unwrap()
            .parse()
            .unwrap();
        let source = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        let mut cursor = store::RuntimeModeCursor::default();
        loop {
            let batch = read_batch(&source, &cursor).unwrap();
            if let Some(row) = batch
                .observations
                .iter()
                .find(|row| row.observed_at_ms == expected_at)
            {
                assert_eq!(row.mode, "fast");
                println!("READ_ONLY_RUNTIME_MODE_FOUND mode=fast observed_at_ms={expected_at}");
                return;
            }
            if !batch.catching_up {
                panic!("Expected exact runtime metadata was not parsed");
            }
            assert!(batch.next_cursor.id > cursor.id);
            cursor = batch.next_cursor;
        }
    }
}
