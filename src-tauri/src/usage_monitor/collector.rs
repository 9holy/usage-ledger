use super::{parser, store, types::SourceStatus, MonitorRuntime};
use notify::{RecursiveMode, Watcher};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::{
    borrow::Cow,
    collections::{HashSet, VecDeque},
    fs::{self, File},
    io::{BufRead, BufReader, Cursor, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::mpsc,
    time::{Duration, Instant, UNIX_EPOCH},
};

const BATCH_LINES: usize = 512;
const MAX_LINE_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct SourceRoot {
    pub tool: String,
    pub path: PathBuf,
}

pub fn roots() -> Result<(Vec<SourceRoot>, Option<String>), String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or("Cannot locate user home")?;
    let mut codex = vec![home.join(".codex")];
    if let Some(p) = std::env::var_os("CODEX_HOME").filter(|path| !path.is_empty()) {
        codex.push(PathBuf::from(p));
    }
    let mut registry_errors = Vec::new();
    match crate::cockpit_data_path::data_dir_from_home(&home) {
        Ok(directory) => {
            let instances = directory.join("codex_instances.json");
            match File::open(&instances) {
                Ok(file) => match serde_json::from_reader::<_, serde_json::Value>(file) {
                    Ok(value) => match value.get("instances").and_then(|value| value.as_array()) {
                        Some(items) => {
                            for (index, item) in items.iter().enumerate() {
                                // InstanceProfile uses serde(rename_all = "camelCase").
                                // Retain the older reader's snake_case compatibility, but
                                // never choose silently between two conflicting homes.
                                let current = item.get("userDataDir");
                                let legacy = item.get("user_data_dir");
                                let selected = match (current, legacy) {
                                    (Some(current), Some(legacy)) if current != legacy => {
                                        registry_errors.push(format!("instance {index} has conflicting data directory fields"));
                                        continue;
                                    }
                                    (Some(value), _) | (_, Some(value)) => value,
                                    _ => {
                                        registry_errors.push(format!("instance {index} has no data directory"));
                                        continue;
                                    }
                                };
                                match selected.as_str().map(str::trim).filter(|value| !value.is_empty()) {
                                    Some(value) if Path::new(value).is_absolute() => codex.push(PathBuf::from(value)),
                                    _ => registry_errors.push(format!("instance {index} requires an absolute data directory")),
                                }
                            }
                        }
                        None => registry_errors.push("instance registry requires an instances array".to_string()),
                    },
                    Err(error) => registry_errors.push(format!("invalid instance registry: {error}")),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => registry_errors.push(format!("instance registry could not be read: {error}")),
            }
        }
        Err(error) => registry_errors.push(error),
    }
    let registry_error = (!registry_errors.is_empty()).then(|| {
        format!("Optional Codex instance registry incomplete: {}", registry_errors.join("; "))
    });
    let mut result = Vec::new();
    for base in codex {
        for folder in ["sessions", "archived_sessions"] {
            result.push(SourceRoot {
                tool: "codex".into(),
                path: base.join(folder),
            });
        }
    }
    let mut claude = vec![home.join(".claude")];
    if let Some(p) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|path| !path.is_empty()) {
        claude.push(PathBuf::from(p));
    }
    for base in claude {
        result.push(SourceRoot {
            tool: "claude".into(),
            path: base.join("projects"),
        });
    }
    for app in ["antigravity", "antigravity-ide", "antigravity-cli"] {
        result.push(SourceRoot {
            tool: "antigravity".into(),
            path: home.join(".gemini").join(app).join("brain"),
        });
    }
    let dsh_home = std::env::var_os("DSH_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".dsh"));
    result.push(SourceRoot {
        tool: super::deepseek::TOOL.into(),
        path: dsh_home.join("sessions"),
    });
    let mut seen = HashSet::new();
    result.retain(|r| seen.insert(r.path.clone()));
    Ok((result, registry_error))
}

fn discover(root: &SourceRoot) -> Result<Vec<PathBuf>, String> {
    if root.tool == super::deepseek::TOOL {
        return super::deepseek::discover(&root.path);
    }
    match fs::metadata(&root.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let mut dirs = vec![root.path.clone()];
    let mut files = Vec::new();
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| format!("{}: {e}", dir.display()))? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                // Antigravity brain also contains large browser artifacts unrelated to usage.
                if root.tool != "antigravity"
                    || dir == root.path
                    || matches!(
                        entry.file_name().to_str(),
                        Some(".system_generated" | "logs" | "subagents")
                    )
                {
                    dirs.push(path);
                }
            } else if kind.is_file() && path.extension().is_some_and(|x| x == "jsonl") {
                if root.tool != "antigravity"
                    || matches!(
                        path.file_name().and_then(|x| x.to_str()),
                        Some("transcript.jsonl")
                    )
                {
                    files.push(path);
                }
            }
        }
    }
    files.sort_by_cached_key(|p| std::cmp::Reverse(fs::metadata(p).and_then(|m| m.modified()).ok()));
    Ok(files)
}

fn registered_coverage(
    known: &HashSet<PathBuf>,
    discovered: &[PathBuf],
) -> Result<(usize, usize), String> {
    let discovered: HashSet<_> = discovered.iter().collect();
    let mut present = 0;
    let mut missing = 0;
    for path in known {
        if discovered.contains(path) {
            present += 1;
            continue;
        }
        match fs::metadata(path) {
            Ok(_) => present += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => missing += 1,
            Err(error) => {
                return Err(format!(
                    "Registered path presence could not be verified: {error}"
                ))
            }
        }
    }
    Ok((present, missing))
}

fn apply(
    conn: &rusqlite::Transaction<'_>,
    parsed: parser::ParsedLine,
    tool: &str,
    path: &Path,
    start: i64,
    now: i64,
    catalog: &crate::model_catalog::CatalogSnapshot,
) -> Result<(), String> {
    super::codex_quota_accounts::save_parsed(conn,path,&parsed)?;
    if let Some(session) = parsed.session {
        if !session.id.is_empty() {
            store::save_session(conn, &session)?;
        }
    }
    for id in parsed.delete_ids {
        store::delete_request(conn, tool, &id)?;
    }
    for usage in parsed.usage {
        store::save_usage_with_catalog(conn, &usage, start, now, catalog)?;
    }
    let mut quotas = parsed.quotas;
    super::quota::bind_codex_observations(conn,path,&mut quotas)?;
    for quota in quotas {
        super::quota::save(conn, &quota)?;
    }
    super::billing::repair_ids(conn,parsed.request_quotas.iter().map(|r|r.id.as_str()))?;
    Ok(())
}

fn backfill_account_quota_evidence(conn: &mut rusqlite::Connection, home: &Path, reset: i64) -> Result<(), String> {
    let files = {
        let mut query = conn.prepare("SELECT path,offset,signature FROM monitor_files WHERE tool='codex' AND json_extract(state,'$.session.updatedAtMs')>=?1")
            .map_err(|e|e.to_string())?;
        let rows = query.query_map([reset-super::codex_quota_accounts::WEEK_MS],|r|Ok((PathBuf::from(r.get::<_,String>(0)?),r.get::<_,u64>(1)?,r.get::<_,String>(2)?)))
            .map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
    };
    let tx = conn.transaction().map_err(|e|e.to_string())?;
    for (path,offset,signature) in files {
        if super::codex_quota_accounts::home(&path)!=Some(home) { continue; }
        let Some((reader,modified)) = mode_replay_source(&path,offset,&signature)? else {
            eprintln!("Codex quota evidence source is no longer available; saved usage retained: {}",path.display());
            continue;
        };
        let mut reader = reader.take(offset);
        let mut state = parser::ParserState::default();
        let mut line = Vec::new();
        while reader.limit()>0 {
            line.clear();
            let read = reader.by_ref().take(MAX_LINE_BYTES).read_until(b'\n',&mut line).map_err(|e|e.to_string())?;
            let raw = if line.ends_with(b"\n") {
                Cow::Borrowed(std::str::from_utf8(&line).map_err(|e|e.to_string())?)
            } else if read as u64==MAX_LINE_BYTES {
                Cow::Owned(project_large_body(&mut Cursor::new(line.as_slice()).chain(&mut reader))?
                    .ok_or("Incomplete committed Codex quota evidence record")?)
            } else { return Err("Incomplete committed Codex quota evidence record".into()); };
            let mut parsed = parser::parse_line(&mut state,"codex",&path,&raw,modified)?;
            super::quota::bind_codex_observations(&tx,&path,&mut parsed.quotas)?;
            parsed.request_quotas.retain(|q|q.reset_ms==reset);
            super::codex_quota_accounts::save_parsed(&tx,&path,&parsed)?;
            super::billing::repair_ids(&tx,parsed.request_quotas.iter().map(|q|q.id.as_str()))?;
        }
    }
    tx.execute("UPDATE monitor_codex_quota_accounts SET replayed=?3 WHERE home=?1 AND reset_ms=?2",
        params![home.to_string_lossy(),reset,super::codex_quota_accounts::REPLAY_VERSION]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}

#[cfg(test)]
mod account_quota_reconciliation_tests {
    use super::*;

    #[test]
    fn missing_old_source_does_not_block_other_accounts_quota_evidence() {
        use serde_json::json;
        let home=std::env::temp_dir().join(format!("monitor-quota-replay-{}-{}",std::process::id(),crate::ledger_db::now_ms()));
        let path=home.join("sessions/valid.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let tokens=json!({"input_tokens":10,"output_tokens":2,"cached_input_tokens":0});
        let records=[
            json!({"type":"session_meta","timestamp":"2026-10-15T17:00:00Z","payload":{"id":"thread","model":"gpt-6.1-sol"}}),
            json!({"type":"event_msg","timestamp":"2026-10-15T17:01:00Z","payload":{"type":"token_usage_record","thread_id":"thread","turn_id":"turn","response_id":"known","usage":tokens,"thread_token_usage":tokens}}),
            json!({"type":"event_msg","timestamp":"2026-10-15T17:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":tokens,"last_token_usage":tokens},"rate_limits":{"limit_id":"codex","plan_type":"pro","secondary":{"window_minutes":10080,"resets_at":1800000000}}}}),
        ];
        let text=records.iter().map(|r|format!("{r}\n")).collect::<String>();
        fs::write(&path,&text).unwrap();
        let mut conn=Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let state=json!({"session":{"updatedAtMs":1800000000000_i64}}).to_string();
        let missing=home.join("sessions/missing.jsonl");
        for (file,offset) in [(&missing,0),(&path,text.len())] {
            conn.execute("INSERT INTO monitor_files VALUES(?1,'codex',?2,?3,?4)",params![file.to_string_lossy(),offset,format!("{:x}",md5::compute(&text.as_bytes()[..text.len().min(256)])),state]).unwrap();
        }
        backfill_account_quota_evidence(&mut conn,&home,1800000000000).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_request_quota_evidence WHERE id='response-v2:6:threadknown'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        fs::remove_dir_all(home).unwrap();
    }

    #[test]
    #[ignore = "Requires explicit writable ledger copy and a captured authenticated official response"]
    fn reconcile_copied_official_account_snapshot() {
        let path=PathBuf::from(std::env::var_os("MONITOR_QUOTA_REPAIR_COPY").unwrap()).canonicalize().unwrap();
        assert_eq!(path.file_name().unwrap(),"ledger-audit-work.sqlite");
        assert_ne!(path,crate::ledger_db::ledger_db_path().unwrap().canonicalize().unwrap());
        let receipt:serde_json::Value=serde_json::from_slice(&std::fs::read(std::env::var_os("MONITOR_OFFICIAL_ACCOUNT_RECEIPT").unwrap()).unwrap()).unwrap();
        let account=receipt["account"].as_str().unwrap();
        let home=PathBuf::from(receipt["home"].as_str().unwrap());
        assert!(home.is_dir());
        let now=receipt["observedMs"].as_i64().unwrap();
        let mut conn=Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        store::initialize(&conn).unwrap();
        super::super::accounts::save_official_subscription(&conn,account,&receipt["accountCheck"],now).unwrap();
        super::super::codex_quota_accounts::save_authenticated(&conn,&home,account,&receipt["quota"],receipt["quotaObservedMs"].as_i64().unwrap()).unwrap();
        let reset=receipt["quota"]["rate_limit"]["primary_window"]["reset_at"].as_i64().unwrap()*1000;
        backfill_account_quota_evidence(&mut conn,&home,reset).unwrap();
        println!("Captured official subscription and quota evidence reconciled on the explicit copy");
    }

    #[test]
    #[ignore = "Requires an explicit writable ledger copy and authenticated local Codex home"]
    fn reconcile_copied_account_quota() {
        let path=PathBuf::from(std::env::var_os("MONITOR_QUOTA_REPAIR_COPY").unwrap()).canonicalize().unwrap();
        assert_eq!(path.file_name().unwrap(),"ledger-audit-work.sqlite");
        assert_ne!(path,crate::ledger_db::ledger_db_path().unwrap().canonicalize().unwrap());
        let home=PathBuf::from(std::env::var_os("MONITOR_QUOTA_REPAIR_HOME").unwrap());
        let mut conn=Connection::open_with_flags(path,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        store::initialize(&conn).unwrap();
        let mut reader=super::super::codex_quota_accounts::Reader::new();
        let sources=[SourceRoot { tool:"codex".into(),path:home.join("sessions") }];
        for _ in 0..60 {
            let pending=reader.collect(&conn,&sources,crate::ledger_db::now_ms()).unwrap();
            if !pending.is_empty() {
                for (home,reset) in pending { backfill_account_quota_evidence(&mut conn,&home,reset).unwrap(); }
                let count:i64=conn.query_row("SELECT COUNT(*) FROM monitor_request_quota_evidence",[],|r|r.get(0)).unwrap();
                assert!(count>0);
                println!("Reconciled request quota evidence rows: {count}");
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        panic!("Official account quota binding was not received; no guessed account repair was applied");
    }
}

#[derive(Deserialize)]
struct BodyKind {
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize)]
struct BodyEnvelope {
    #[serde(rename = "type")]
    kind: String,
    timestamp: Option<String>,
    payload: BodyKind,
}

fn project_large_body<R: BufRead>(reader: &mut R) -> Result<Option<String>, String> {
    // serde ignores the tool-output body while streaming; multi-megabyte strings are not retained.
    let envelope =
        match BodyEnvelope::deserialize(&mut serde_json::Deserializer::from_reader(&mut *reader)) {
            Ok(value) => value,
            Err(e) if e.is_eof() => return Ok(None),
            Err(e) => return Err(format!("Invalid oversized metadata record: {e}")),
        };
    let irrelevant = envelope.kind == "response_item"
        && matches!(
            envelope.payload.kind.as_deref(),
            Some("function_call_output" | "custom_tool_call_output" | "message" | "reasoning")
        )
        || envelope.kind == "event_msg"
            && envelope.payload.kind.as_deref() == Some("item_completed");
    if !irrelevant {
        return Err(
            "Oversized record contains potentially relevant usage metadata; not discarded".into(),
        );
    }
    let mut end = String::new();
    reader.read_line(&mut end).map_err(|e| e.to_string())?;
    if !end.ends_with('\n') {
        return Ok(None);
    }
    if !end.trim().is_empty() {
        return Err("Unexpected data after oversized JSON record".into());
    }
    Ok(Some(serde_json::json!({"type":envelope.kind,"timestamp":envelope.timestamp,"payload":{"type":envelope.payload.kind}}).to_string()))
}

fn mode_archive_path(path: &Path) -> PathBuf {
    let mut archive = path.as_os_str().to_os_string();
    archive.push(".zst");
    PathBuf::from(archive)
}

fn mode_replay_source(
    path: &Path,
    offset: u64,
    signature: &str,
) -> Result<Option<(impl BufRead, i64)>, String> {
    let (file, compressed) = match File::open(path) {
        Ok(file) => (file, false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match File::open(mode_archive_path(path)) {
                Ok(file) => (file, true),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(format!("Committed Codex source unavailable: {error}")),
            }
        }
        Err(error) => return Err(error.to_string()),
    };
    let meta = file.metadata().map_err(|error| error.to_string())?;
    if !compressed && offset > meta.len() {
        return Err("Codex source is shorter than the committed cursor".into());
    }
    let modified = meta.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as i64);
    let mut reader: Box<dyn BufRead> = if compressed {
        Box::new(BufReader::new(zstd::stream::read::Decoder::new(file).map_err(|error| error.to_string())?))
    } else {
        Box::new(BufReader::new(file))
    };
    let mut prefix = Vec::new();
    reader.by_ref().take(256).read_to_end(&mut prefix).map_err(|error| error.to_string())?;
    if format!("{:x}", md5::compute(&prefix)) != signature {
        return Err("Codex source prefix no longer matches its committed cursor".into());
    }
    Ok(Some((Cursor::new(prefix).chain(reader), modified)))
}

fn upgrade_initial_mode_cursor(
    tx: &rusqlite::Transaction<'_>,
    path: &Path,
    offset: u64,
    signature: &str,
    mut state: parser::ParserState,
) -> Result<Option<parser::ParserState>, String> {
    for cached in state.recent_usage().cloned().collect::<Vec<_>>() {
        if let Some(proven) = store::stored_requested_mode_for_cursor(&tx, &cached)? {
            state.restore_request_mode(&proven);
        }
    }
    let candidates = if let Some(session) = state.session.as_ref() {
        let mut query = tx.prepare_cached("SELECT id FROM monitor_requests WHERE tool='codex' AND session_key=?1 AND EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='requested_mode_ambiguous')")
            .map_err(|error| error.to_string())?;
        let rows = query.query_map([store::session_key("codex", &session.id)], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<HashSet<_>, _>>().map_err(|error| error.to_string())?
    } else {
        HashSet::new()
    };
    if !candidates.is_empty() || state.has_ambiguous_requested_mode() {
        let Some((reader, modified)) = mode_replay_source(path, offset, signature)? else {
            return Ok(None);
        };
        let mut reader = reader.take(offset);
        let mut replayed = parser::ParserState::default();
        let mut line = Vec::new();
        while reader.limit() > 0 {
            let position = offset - reader.limit();
            line.clear();
            let read = reader.by_ref().take(MAX_LINE_BYTES)
                .read_until(b'\n', &mut line).map_err(|error| error.to_string())?;
            let raw = if line.ends_with(b"\n") {
                Cow::Borrowed(std::str::from_utf8(&line).map_err(|error| format!("UTF-8 at byte {position}: {error}"))?)
            } else if read as u64 == MAX_LINE_BYTES {
                let metadata = project_large_body(&mut Cursor::new(line.as_slice()).chain(&mut reader))?
                    .ok_or("Committed Codex prefix contains an incomplete oversized record")?;
                Cow::Owned(metadata)
            } else {
                return Err("Committed Codex prefix does not end on complete records".into());
            };
            let parsed = parser::parse_line(&mut replayed, "codex", path, &raw, modified)
                .map_err(|error| format!("Codex mode replay at byte {position}: {error}"))?;
            for usage in parsed.usage {
                if candidates.contains(&usage.id) && store::repair_initial_requested_mode(&tx, &usage)? {
                    state.restore_request_mode(&usage);
                }
            }
        }
        for usage in parser::finish_batch(&mut replayed).usage {
            if candidates.contains(&usage.id) && store::repair_initial_requested_mode(&tx, &usage)? {
                state.restore_request_mode(&usage);
            }
        }
        if state.session.as_ref().map(|session| (&session.tool, &session.id))
            != replayed.session.as_ref().map(|session| (&session.tool, &session.id))
        {
            return Err("Codex mode replay does not match the stored session identity".into());
        }
        state.restore_requested_mode_from(&replayed);
    }
    tx.execute("UPDATE monitor_files SET state=?1 WHERE path=?2",
        params![serde_json::to_string(&state).map_err(|error| error.to_string())?, path.to_string_lossy()])
        .map_err(|error| error.to_string())?;
    Ok(Some(state))
}

// Only recover the prefix that this ledger previously committed. An archive
// may include later bytes; neither their usage nor their timestamps are evidence
// for this cursor. The preserved cursor may also contain extension fields.
fn replay_archived_response_identity(
    tx: &rusqlite::Transaction<'_>,
    path: &Path,
    offset: u64,
    signature: &str,
    saved: &str,
    replay_key: &str,
) -> Result<bool, String> {
    let Some((reader, modified)) = mode_replay_source(path, offset, signature)? else {
        return Ok(false);
    };
    let (original, _) = saved_parser_state(saved, "codex")?;
    let catalog = crate::model_catalog::snapshot();
    let mut reader = reader.take(offset);
    let mut replayed = parser::ParserState::default();
    let mut line = Vec::new();
    while reader.limit() > 0 {
        let position = offset - reader.limit();
        line.clear();
        let read = reader.by_ref().take(MAX_LINE_BYTES).read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        let raw = if line.ends_with(b"\n") {
            Cow::Borrowed(std::str::from_utf8(&line).map_err(|error| format!("UTF-8 at byte {position}: {error}"))?)
        } else if read as u64 == MAX_LINE_BYTES {
            Cow::Owned(project_large_body(&mut Cursor::new(line.as_slice()).chain(&mut reader))?
                .ok_or("Committed Codex archive contains an incomplete oversized record")?)
        } else {
            return Err("Committed Codex archive does not end on complete records".into());
        };
        let parsed = parser::parse_line(&mut replayed, "codex", path, &raw, modified)
            .map_err(|error| format!("Codex identity replay at byte {position}: {error}"))?;
        apply(&tx, parsed, "codex", path, i64::MAX, 0, &catalog)?;
    }
    apply(&tx, parser::finish_batch(&mut replayed), "codex", path, i64::MAX, 0, &catalog)?;
    if original.session.as_ref().map(|session| (&session.tool, &session.id))
        != replayed.session.as_ref().map(|session| (&session.tool, &session.id))
    {
        return Err("Codex identity archive does not match the committed session".into());
    }
    tx.execute("DELETE FROM monitor_state WHERE key=?1", [replay_key]).map_err(|error| error.to_string())?;
    Ok(true)
}

fn saved_parser_state(json: &str, tool: &str) -> Result<(parser::ParserState, bool), String> {
    let mut saved: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| format!("Stored parser state: {error}"))?;
    if tool == "codex" { parser::scope_cursor_response_ids(&mut saved)?; }
    let legacy = tool == "codex" && saved.get("requested_mode_seen").is_none();
    Ok((serde_json::from_value(saved).map_err(|error| format!("Stored parser state: {error}"))?, legacy))
}

fn enqueue_legacy_mode_archives(
    conn: &Connection,
    pending: &mut VecDeque<(String, PathBuf)>,
    queued: &mut HashSet<PathBuf>,
) -> Result<(), String> {
    let mut query = conn.prepare("SELECT path FROM monitor_files WHERE tool='codex'
        AND (CASE WHEN json_valid(state) THEN json_type(state,'$.requested_mode_seen') IS NULL ELSE 0 END
          OR EXISTS(SELECT 1 FROM monitor_state WHERE key='codex_identity_replay_v2:'||monitor_files.path))")
        .map_err(|error| error.to_string())?;
    let paths = query.query_map([], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?;
    for path in paths {
        let path = PathBuf::from(path.map_err(|error| error.to_string())?);
        if fs::metadata(&path).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            && fs::metadata(mode_archive_path(&path)).is_ok_and(|meta| meta.is_file())
            && queued.insert(path.clone())
        {
            pending.push_back(("codex".into(), path));
        }
    }
    Ok(())
}

// A stable header cannot detect copy-truncate/rewrite when the file regrows
// before the next poll. Persist a small digest at the committed byte boundary;
// regular appends keep it unchanged and at most 4 KiB need to be reread.
fn cursor_tail_digest(reader: &mut (impl Read + Seek), offset: u64) -> Result<String, String> {
    let length = offset.min(4096);
    reader.seek(SeekFrom::Start(offset - length)).map_err(|error| error.to_string())?;
    let mut tail = vec![0; length as usize];
    reader.read_exact(&mut tail).map_err(|error| error.to_string())?;
    Ok(format!("{:x}", md5::compute(tail)))
}

pub fn ingest_file(
    conn: &mut Connection,
    tool: &str,
    path: &Path,
    live_after: i64,
) -> Result<bool, String> {
    if tool == super::deepseek::TOOL {
        return super::deepseek::ingest(conn, path, live_after);
    }
    // The cursor, replay markers and all derived usage belong to one serialized
    // write snapshot. Another collector may have committed while this one waited.
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let key = path.to_string_lossy().to_string();
    let replay_key = format!("codex_identity_replay_v2:{key}");
    let replay_identity = tool == "codex" && tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key=?1)", [&replay_key], |row| row.get::<_,bool>(0),
    ).map_err(|e| e.to_string())?;
    let previous: Option<(u64, String, String)> = tx
        .query_row(
            "SELECT offset,signature,state FROM monitor_files WHERE path=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            if tool == "codex" {
                if let Some((offset, signature, saved)) = previous {
                    if replay_identity {
                        replay_archived_response_identity(&tx, path, offset, &signature, &saved, &replay_key)?;
                    }
                    let (state, legacy) = saved_parser_state(&saved, tool)?;
                    if legacy {
                        upgrade_initial_mode_cursor(&tx, path, offset, &signature, state)?;
                    }
                }
            }
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(false);
        }
        Err(e) => return Err(e.to_string()),
    };
    let meta = file.metadata().map_err(|e| e.to_string())?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);
    let mut reader = BufReader::new(file);
    let mut prefix = [0u8; 256];
    let n = reader.read(&mut prefix).map_err(|e| e.to_string())?;
    // Small prefix identifies replacement/truncation; never hash or reread the whole history.
    let signature = format!("{:x}", md5::compute(&prefix[..n]));
    let (mut offset, mut state, legacy_mode) = match previous {
        Some((off, sig, json)) if !replay_identity && off <= meta.len() && sig == signature => {
            let (state, legacy) = saved_parser_state(&json, tool)?;
            let unchanged = match &state.file_tail_digest {
                Some(saved) => cursor_tail_digest(&mut reader, off)? == *saved,
                None => true, // Existing cursors acquire a digest without replaying old history.
            };
            if unchanged {
                (off, state, legacy)
            } else {
                (0, parser::ParserState::default(), false)
            }
        }
        _ => (0, parser::ParserState::default(), false),
    };
    if legacy_mode {
        let Some(upgraded) = upgrade_initial_mode_cursor(&tx, path, offset, &signature, state)? else {
            return Ok(false);
        };
        state = upgraded;
    }
    if tool == "codex" && offset > 0 && !state.quota_identity_loaded {
        match super::quota::account_from_header(path) {
            Ok(account) => state.quota_account_id = account,
            Err(error) => state.quota_identity_error = Some(error),
        }
        state.quota_identity_loaded = true;
        tx.execute(
            "UPDATE monitor_files SET state=?1 WHERE path=?2",
            params![
                serde_json::to_string(&state).map_err(|e| e.to_string())?,
                key
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    if offset == meta.len() {
        if state.file_tail_digest.is_none() {
            state.file_tail_digest = Some(cursor_tail_digest(&mut reader, offset)?);
            tx.execute("UPDATE monitor_files SET state=?1 WHERE path=?2",
                params![serde_json::to_string(&state).map_err(|error| error.to_string())?, key])
                .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    let catalog = crate::model_catalog::snapshot();
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let now = crate::ledger_db::now_ms();
    let mut line = Vec::new();
    let mut partial = false;
    for _ in 0..BATCH_LINES {
        line.clear();
        let read = reader
            .by_ref()
            .take(MAX_LINE_BYTES)
            .read_until(b'\n', &mut line)
            .map_err(|e| e.to_string())?;
        if read == 0 {
            break;
        }
        if !line.ends_with(b"\n") {
            if read as u64 == MAX_LINE_BYTES {
                if tool != "codex" {
                    return Err(
                        "Oversized usage log requires a supported metadata projection".into(),
                    );
                }
                let projected = project_large_body(&mut Cursor::new(line.as_slice()).chain(&mut reader))?;
                match projected {
                    Some(metadata) => {
                        let next = reader.stream_position().map_err(|error| error.to_string())?;
                        let parsed =
                            parser::parse_line(&mut state, tool, path, &metadata, modified)?;
                        apply(&tx, parsed, tool, path, live_after, now, &catalog)?;
                        offset = next;
                        continue;
                    }
                    None => {
                        partial = true;
                        break;
                    }
                }
            }
            partial = true;
            break;
        }
        let raw = std::str::from_utf8(&line).map_err(|e| format!("UTF-8 at byte {offset}: {e}"))?;
        let parsed = parser::parse_line(&mut state, tool, path, raw, modified)
            .map_err(|e| format!("Record at byte {offset}: {e}"))?;
        apply(&tx, parsed, tool, path, live_after, now, &catalog)?;
        offset += read as u64;
    }
    apply(
        &tx,
        parser::finish_batch(&mut state),
        tool,
        path,
        live_after,
        now,
        &catalog,
    )?;
    state.file_tail_digest = Some(cursor_tail_digest(&mut reader, offset)?);
    tx.execute("INSERT INTO monitor_files(path,tool,offset,signature,state) VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,signature=excluded.signature,state=excluded.state",
        params![key,tool,offset,signature,serde_json::to_string(&state).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    if replay_identity {
        tx.execute("DELETE FROM monitor_state WHERE key=?1", [&replay_key]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(!partial && offset < meta.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::{Totals, UsageRecord};
    use serde_json::{json, Value};

    struct ModeRepairFixture {
        root: PathBuf,
        path: PathBuf,
        source: String,
        conn: Connection,
        first: UsageRecord,
    }

    impl ModeRepairFixture {
        fn new(with_switch: bool) -> Self {
            let root = std::env::temp_dir().join(format!("monitor-mode-repair-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            fs::create_dir_all(&root).unwrap();
            let path = root.join("rollout.jsonl");
            let stamp = "2026-10-26T07:50:00Z";
            let setting = |tier: &str| json!({"type":"event_msg","timestamp":stamp,"payload":{
                "type":"thread_settings_applied","thread_id":"thread","thread_settings":{"service_tier":tier}}});
            let usage = |id: &str| json!({"type":"event_msg","timestamp":stamp,"payload":{
                "type":"token_usage_record","thread_id":"thread","turn_id":"turn","response_id":id,
                "usage":{"input_tokens":1000,"cached_input_tokens":100,"output_tokens":50,
                    "cache_write_input_tokens":0,"reasoning_output_tokens":0}}});
            let mut rows = vec![
                json!({"type":"session_meta","timestamp":stamp,"payload":{"id":"thread","creator_account_id":"a"}}),
                json!({"type":"task_started","timestamp":stamp,"payload":{"turn_id":"turn"}}),
                json!({"type":"turn_context","timestamp":stamp,"payload":{"turn_id":"turn","model":"gpt-6.1-sol"}}),
                setting("default"), usage("first"),
                json!({"type":"event_msg","timestamp":stamp,"payload":{"type":"token_count","rate_limits":{
                    "secondary":{"window_minutes":10080,"used_percent":7,"resets_at":1793603405}}}}),
            ];
            if with_switch {
                rows.extend([setting("priority"), usage("switched")]);
            }
            let source = rows.iter().map(|row| format!("{row}\n")).collect::<String>();
            fs::write(&path, &source).unwrap();
            let mut conn = crate::ledger_db::open(&root.join("ledger.sqlite")).unwrap();
            store::initialize(&conn).unwrap();
            let catalog = crate::model_catalog::CatalogSnapshot::default();
            let mut state = parser::ParserState::default();
            let mut first = None;
            for row in rows {
                let parsed = parser::parse_line(&mut state, "codex", &path, &row.to_string(), 0).unwrap();
                for mut record in parsed.usage {
                    if record.id == "response-v2:6:threadfirst" {
                        first = Some(record.clone());
                        record.requested_mode = None;
                        record.unknown_fields.push("requested_mode_ambiguous".into());
                    }
                    let tx = conn.transaction().unwrap();
                    store::save_usage_with_catalog(&tx, &record, i64::MAX, 0, &catalog).unwrap();
                    tx.commit().unwrap();
                }
            }
            let mut saved = serde_json::to_value(&state).unwrap();
            let object = saved.as_object_mut().unwrap();
            object.remove("requested_mode_seen");
            object.remove("requested_mode_turn_has_usage");
            object.insert("requested_mode_ambiguous".into(), json!(true));
            for row in object.get_mut("recent").unwrap().as_array_mut().unwrap() {
                if row["id"] == "response-v2:6:threadfirst" {
                    row["requestedMode"] = Value::Null;
                    row["unknownFields"].as_array_mut().unwrap().push(json!("requested_mode_ambiguous"));
                }
            }
            conn.execute("INSERT INTO monitor_files(path,tool,offset,signature,state) VALUES(?1,'codex',?2,?3,?4)", params![
                path.to_string_lossy(), source.len() as u64, format!("{:x}", md5::compute(&source.as_bytes()[..256.min(source.len())])), saved.to_string()
            ]).unwrap();
            conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.extension',json('{\"keep\":true}')) WHERE id='response-v2:6:threadfirst'", []).unwrap();
            let cost: String = conn.query_row("SELECT cost FROM monitor_requests WHERE id='response-v2:6:threadfirst'", [], |row| row.get(0)).unwrap();
            conn.execute("UPDATE monitor_requests SET cost=?1 WHERE id='response-v2:6:threadfirst'", [format!(" {cost}\n")]).unwrap();
            conn.execute("INSERT INTO monitor_account_cycles(tool,account_key,slot,window_minutes,start_ms,reset_ms,observed_ms,used_percent) VALUES('codex','account:a','secondary',10080,100,604800100,200,50)", []).unwrap();
            Self { root, path, source, conn, first: first.unwrap() }
        }

        fn request(&self, id: &str) -> (Value, String) {
            self.conn.query_row("SELECT usage,cost FROM monitor_requests WHERE id=?1", [id], |row| {
                Ok((serde_json::from_str(&row.get::<_, String>(0)?).unwrap(), row.get(1)?))
            }).unwrap()
        }

        fn cursor(&self) -> (u64, String, String) {
            self.conn.query_row("SELECT offset,signature,state FROM monitor_files WHERE path=?1", [self.path.to_string_lossy()], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).unwrap()
        }

        fn totals(&self) -> Totals {
            let json: String = self.conn.query_row("SELECT totals FROM monitor_sessions WHERE key='codex:thread'", [], |row| row.get(0)).unwrap();
            serde_json::from_str(&json).unwrap()
        }

        fn cycles(&self) -> String {
            self.conn.query_row("SELECT json_group_array(json_array(id,tool,account_key,slot,window_minutes,start_ms,end_ms,reset_ms,observed_ms,used_percent,exhausted_ms)) FROM monitor_account_cycles", [], |row| row.get(0)).unwrap()
        }
    }

    impl Drop for ModeRepairFixture {
        fn drop(&mut self) {
            let conn = std::mem::replace(&mut self.conn, Connection::open_in_memory().unwrap());
            drop(conn);
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn legacy_initial_mode_repair_preserves_cost_facts_cycles_and_same_id_after_restart() {
        let mut fixture = ModeRepairFixture::new(false);
        let (before, cost) = fixture.request("response-v2:6:threadfirst");
        let cursor = fixture.cursor();
        let totals = fixture.totals();
        let cycles = fixture.cycles();
        assert!(!ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap());
        let (mut expected, unchanged_cost) = fixture.request("response-v2:6:threadfirst");
        assert_eq!(unchanged_cost, cost);
        assert_eq!(expected["requestedMode"], "standard");
        expected["requestedMode"] = Value::Null;
        expected["unknownFields"].as_array_mut().unwrap().push(json!("requested_mode_ambiguous"));
        assert_eq!(expected, before);
        let upgraded = fixture.cursor();
        assert_eq!((&upgraded.0, &upgraded.1), (&cursor.0, &cursor.1));
        assert_eq!(serde_json::from_str::<Value>(&upgraded.2).unwrap()["requested_mode_seen"], true);
        let next = fixture.totals();
        assert_eq!((next.request_count, next.total_tokens, next.priced_cost_usd), (totals.request_count, totals.total_tokens, totals.priced_cost_usd));
        assert_eq!(next.incomplete_requests, totals.incomplete_requests - 1);
        assert_eq!(fixture.cycles(), cycles);
        assert_eq!(fixture.conn.query_row("SELECT COUNT(*) FROM monitor_quotas", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        assert_eq!(fixture.conn.query_row("SELECT COUNT(*) FROM monitor_observations", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        fixture.conn = Connection::open(fixture.root.join("ledger.sqlite")).unwrap();
        assert!(!ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap());
        assert_eq!(fixture.cursor(), upgraded);
        let duplicate = fixture.source.lines().nth(4).unwrap();
        fs::write(&fixture.path, format!("{}{duplicate}\n", fixture.source)).unwrap();
        assert!(!ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap());
        assert_eq!(fixture.request("response-v2:6:threadfirst").1, cost);
        assert!(!fixture.request("response-v2:6:threadfirst").0["unknownFields"].as_array().unwrap().contains(&json!("requested_mode_ambiguous")));
        assert_eq!(fixture.totals().request_count, totals.request_count);
    }

    #[test]
    fn historical_mode_repair_keeps_real_switches_and_rejects_mismatched_facts() {
        let mut fixture = ModeRepairFixture::new(true);
        let before = fixture.request("response-v2:6:threadfirst");
        for change in 0..5 {
            let mut wrong = fixture.first.clone();
            match change {
                0 => wrong.session_id = "other".into(),
                1 => wrong.turn_id = "other".into(),
                2 => wrong.input_tokens += 1,
                3 => wrong.id = "missing".into(),
                _ => wrong.tool = "claude".into(),
            }
            let tx = fixture.conn.transaction().unwrap();
            assert!(!store::repair_initial_requested_mode(&tx, &wrong).unwrap());
            tx.commit().unwrap();
            assert_eq!(fixture.request("response-v2:6:threadfirst"), before);
        }
        let switched = fixture.request("response-v2:6:threadswitched");
        ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap();
        assert_eq!(fixture.request("response-v2:6:threadswitched"), switched);
        assert_eq!(fixture.request("response-v2:6:threadfirst").0["requestedMode"], "standard");
        assert_eq!(fixture.totals().incomplete_requests, 1);
        let totals = serde_json::to_value(fixture.totals()).unwrap();
        let tx = fixture.conn.transaction().unwrap();
        assert!(store::repair_initial_requested_mode(&tx, &fixture.first).unwrap());
        tx.commit().unwrap();
        assert_eq!(serde_json::to_value(fixture.totals()).unwrap(), totals);
    }

    #[test]
    fn invalid_committed_prefix_rolls_back_mode_repair_and_cursor_upgrade() {
        let mut fixture = ModeRepairFixture::new(false);
        let invalid = format!("{}{{invalid}}\n", fixture.source);
        fs::write(&fixture.path, &invalid).unwrap();
        fixture.conn.execute("UPDATE monitor_files SET offset=?1", [invalid.len() as u64]).unwrap();
        let before = fixture.request("response-v2:6:threadfirst");
        let cursor = fixture.cursor();
        let totals = serde_json::to_value(fixture.totals()).unwrap();
        assert!(ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).is_err());
        assert_eq!(fixture.request("response-v2:6:threadfirst"), before);
        assert_eq!(fixture.cursor(), cursor);
        assert_eq!(serde_json::to_value(fixture.totals()).unwrap(), totals);
    }

    #[test]
    fn legacy_cursor_without_candidates_upgrades_without_replaying_history() {
        for missing in [false, true] {
            let mut fixture = ModeRepairFixture::new(false);
            fixture.conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.unknownFields',json('[]'))", []).unwrap();
            fixture.conn.execute("UPDATE monitor_files SET state=json_set(state,'$.requested_mode_ambiguous',json('false'))", []).unwrap();
            if missing {
                fs::remove_file(&fixture.path).unwrap();
            } else {
                let invalid = format!("{}{{invalid}}\n", fixture.source);
                fs::write(&fixture.path, &invalid).unwrap();
                fixture.conn.execute("UPDATE monitor_files SET offset=?1", [invalid.len() as u64]).unwrap();
            }
            assert!(!ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap());
            assert_eq!(serde_json::from_str::<Value>(&fixture.cursor().2).unwrap()["requested_mode_seen"], true);
        }
    }

    #[test]
    fn duplicate_legacy_cursors_reuse_proven_database_mode_without_reverting_it() {
        for with_switch in [false, true] {
            let mut fixture = ModeRepairFixture::new(with_switch);
            let duplicate = fixture.root.join("duplicate.jsonl");
            fs::write(&duplicate, &fixture.source).unwrap();
            let (offset, signature, state) = fixture.cursor();
            fixture.conn.execute("INSERT INTO monitor_files(path,tool,offset,signature,state) VALUES(?1,'codex',?2,?3,?4)",
                params![duplicate.to_string_lossy(), offset, signature, state]).unwrap();
            let cost = fixture.request("response-v2:6:threadfirst").1;
            ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap();
            ingest_file(&mut fixture.conn, "codex", &duplicate, i64::MAX).unwrap();
            let first_usage = fixture.source.lines().nth(4).unwrap();
            fs::write(&duplicate, format!("{}{first_usage}\n", fixture.source)).unwrap();
            ingest_file(&mut fixture.conn, "codex", &duplicate, i64::MAX).unwrap();
            let (usage, unchanged_cost) = fixture.request("response-v2:6:threadfirst");
            assert_eq!(unchanged_cost, cost);
            assert_eq!(usage["requestedMode"], "standard");
            assert!(!usage["unknownFields"].as_array().unwrap().contains(&json!("requested_mode_ambiguous")));
            assert_eq!(fixture.totals().incomplete_requests, i64::from(with_switch));
            let mut new_usage: Value = serde_json::from_str(first_usage).unwrap();
            new_usage["payload"]["response_id"] = json!("brand-new");
            fs::write(&duplicate, format!("{}{first_usage}\n{new_usage}\n", fixture.source)).unwrap();
            ingest_file(&mut fixture.conn, "codex", &duplicate, i64::MAX).unwrap();
            let new = fixture.request("response-v2:6:threadbrand-new").0;
            assert_eq!(new["requestedMode"], if with_switch { Value::Null } else { json!("standard") });
            assert_eq!(new["unknownFields"].as_array().unwrap().contains(&json!("requested_mode_ambiguous")), with_switch);
        }
    }

    #[test]
    fn old_ambiguous_context_without_saved_usage_is_replayed_before_a_new_response() {
        let mut fixture = ModeRepairFixture::new(false);
        let prefix = fixture.source.lines().take(4).map(|line| format!("{line}\n")).collect::<String>();
        fs::write(&fixture.path, &prefix).unwrap();
        fixture.conn.execute("DELETE FROM monitor_requests", []).unwrap();
        fixture.conn.execute("UPDATE monitor_sessions SET totals=?1", [serde_json::to_string(&Totals::default()).unwrap()]).unwrap();
        let mut state: Value = serde_json::from_str(&fixture.cursor().2).unwrap();
        state["recent"] = json!([]);
        state["pending_usage"] = Value::Null;
        fixture.conn.execute("UPDATE monitor_files SET offset=?1,signature=?2,state=?3", params![
            prefix.len() as u64, format!("{:x}", md5::compute(&prefix.as_bytes()[..256.min(prefix.len())])), state.to_string()
        ]).unwrap();
        ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&fixture.cursor().2).unwrap()["requested_mode_ambiguous"], false);
        assert_eq!(fixture.conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        fs::write(&fixture.path, &fixture.source).unwrap();
        ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap();
        assert_eq!(fixture.request("response-v2:6:threadfirst").0["requestedMode"], "standard");
        assert_eq!(fixture.totals().incomplete_requests, 0);
    }

    #[test]
    fn archived_committed_prefix_repairs_original_rows_without_collecting_new_archive_records() {
        let mut fixture = ModeRepairFixture::new(false);
        let archive = mode_archive_path(&fixture.path);
        let compressed = zstd::stream::encode_all(format!("{}{{not_committed}}\n", fixture.source).as_bytes(), 1).unwrap();
        fs::write(&archive, compressed).unwrap();
        fs::remove_file(&fixture.path).unwrap();
        let cost = fixture.request("response-v2:6:threadfirst").1;
        let cycles = fixture.cycles();
        ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap();
        assert_eq!(fixture.request("response-v2:6:threadfirst").0["requestedMode"], "standard");
        assert_eq!(fixture.request("response-v2:6:threadfirst").1, cost);
        assert_eq!(fixture.cycles(), cycles);
        assert_eq!(fixture.conn.query_row("SELECT COUNT(*) FROM monitor_files", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(fixture.totals().request_count, 1);
        let cursor = fixture.cursor();
        ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap();
        assert_eq!(fixture.cursor(), cursor);
    }

    #[test]
    fn registered_legacy_archives_enter_the_production_repair_queue_but_missing_sources_do_not() {
        let mut fixture = ModeRepairFixture::new(false);
        fs::write(mode_archive_path(&fixture.path), zstd::stream::encode_all(fixture.source.as_bytes(), 1).unwrap()).unwrap();
        fs::remove_file(&fixture.path).unwrap();
        fs::write(fixture.root.join("unregistered.jsonl.zst"), b"not a registered source").unwrap();
        assert!(discover(&SourceRoot { tool: "codex".into(), path: fixture.root.clone() }).unwrap().is_empty());
        let (mut pending, mut queued) = (VecDeque::new(), HashSet::new());
        enqueue_legacy_mode_archives(&fixture.conn, &mut pending, &mut queued).unwrap();
        assert_eq!(pending.pop_front(), Some(("codex".into(), fixture.path.clone())));
        assert!(pending.is_empty());
        queued.remove(&fixture.path);
        ingest_file(&mut fixture.conn, "codex", &fixture.path, i64::MAX).unwrap();
        enqueue_legacy_mode_archives(&fixture.conn, &mut pending, &mut queued).unwrap();
        assert!(pending.is_empty());
        assert_eq!(fixture.request("response-v2:6:threadfirst").0["requestedMode"], "standard");

        let mut missing = ModeRepairFixture::new(false);
        fs::remove_file(&missing.path).unwrap();
        let cursor = missing.cursor();
        enqueue_legacy_mode_archives(&missing.conn, &mut pending, &mut queued).unwrap();
        assert!(pending.is_empty());
        assert!(!ingest_file(&mut missing.conn, "codex", &missing.path, i64::MAX).unwrap());
        assert_eq!(missing.cursor(), cursor);
        assert!(missing.request("response-v2:6:threadfirst").0["unknownFields"].as_array().unwrap().contains(&json!("requested_mode_ambiguous")));
    }

    #[test]
    #[ignore = "Requires an explicit writable ledger COPY; never uses a production ledger path"]
    fn repair_initial_modes_on_explicit_ledger_copy() {
        let copy = PathBuf::from(std::env::var_os("MONITOR_INITIAL_MODE_REPAIR_COPY").expect("Set MONITOR_INITIAL_MODE_REPAIR_COPY to an isolated ledger copy")).canonicalize().unwrap();
        let mut protected = Vec::new();
        if let Ok(dir) = std::env::var(crate::ledger_db::LEDGER_DIR_ENV) {
            if !dir.trim().is_empty() { protected.push(crate::ledger_db::ledger_db_path_in(Path::new(dir.trim()))); }
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            for name in [crate::ledger_db::TAURI_APP_ID, crate::ledger_db::FALLBACK_DIR_NAME] {
                protected.push(crate::ledger_db::ledger_db_path_in(&PathBuf::from(&appdata).join(name)));
            }
        }
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            protected.push(crate::ledger_db::ledger_db_path_in(&PathBuf::from(home).join(".local/share").join(crate::ledger_db::FALLBACK_DIR_NAME)));
        }
        assert!(!protected.iter().filter_map(|path| path.canonicalize().ok()).any(|path| path == copy), "The explicit COPY must not be a production ledger path");
        let mut conn = Connection::open_with_flags(&copy,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).unwrap();
        let selected = std::env::var("MONITOR_INITIAL_MODE_REPAIR_SOURCE").ok();
        let sources = {
            let mut query = conn.prepare("SELECT path,offset,signature,state FROM monitor_files f WHERE tool='codex'
                AND json_type(state,'$.requested_mode_seen') IS NULL AND (?1 IS NULL OR path=?1)
                AND (json_extract(state,'$.requested_mode_ambiguous')=1 OR EXISTS(SELECT 1 FROM monitor_requests r WHERE r.tool='codex'
                  AND r.session_key='codex:'||json_extract(f.state,'$.session.id')
                  AND EXISTS(SELECT 1 FROM json_each(r.usage,'$.unknownFields') WHERE value='requested_mode_ambiguous'))) ORDER BY path").unwrap();
            let rows = query.query_map([selected], |row| Ok((PathBuf::from(row.get::<_, String>(0)?), row.get::<_, u64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?)))
                .unwrap().collect::<Result<Vec<_>, _>>().unwrap();
            rows
        };
        let ambiguous = |conn: &Connection| conn.query_row(
            "SELECT COUNT(*) FROM monitor_requests WHERE tool='codex' AND EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='requested_mode_ambiguous')", [],
            |row| row.get::<_, i64>(0)).unwrap();
        let before = ambiguous(&conn);
        let (mut upgraded, mut retained_missing, mut failures) = (0, 0, 0);
        for (index, (path, offset, signature, saved)) in sources.iter().enumerate() {
            let result = (|| {
                let (state, _) = saved_parser_state(saved, "codex")?;
                let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
                    .map_err(|error| error.to_string())?;
                let upgraded = upgrade_initial_mode_cursor(&tx, path, *offset, signature, state)?;
                tx.commit().map_err(|error| error.to_string())?;
                Ok::<_, String>(upgraded)
            })();
            match result {
                Ok(Some(_)) => upgraded += 1,
                Ok(None) => retained_missing += 1,
                Err(error) => { failures += 1; eprintln!("Copied source {index} retained after failure: {error}"); }
            }
        }
        let after = ambiguous(&conn);
        eprintln!("Copied ledger metadata repair: sources={}, upgraded={upgraded}, repaired={}, retained_missing={retained_missing}, failures={failures}, ambiguous={before}->{after}", sources.len(), before - after);
        assert_eq!(failures, 0, "Some copied sources could not be verified; their transactions were rolled back");
    }

    #[test]
    fn concurrent_collector_cannot_rewind_another_collectors_committed_cursor() {
        use std::sync::atomic::{AtomicBool, Ordering};
        static WAITING: AtomicBool = AtomicBool::new(false);
        WAITING.store(false, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("monitor-concurrent-cursor-{}-{}",
            std::process::id(), std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        let mut rows = vec![json!({"type":"session_meta","payload":{"id":"thread","padding":"x".repeat(300)}})];
        rows.extend((0..BATCH_LINES).map(|_| json!({"type":"response_item","payload":{}})));
        rows.push(json!({"type":"token_usage_record","timestamp":"2026-10-15T17:00:00Z","payload":{
            "thread_id":"thread","turn_id":"turn","response_id":"complete","usage":{
                "input_tokens":100,"output_tokens":10,"cached_input_tokens":0,"cache_write_input_tokens":0}}}));
        let source = rows.iter().map(|row| format!("{row}\n")).collect::<String>();
        fs::write(&path, &source).unwrap();
        let db = root.join("ledger.sqlite");
        let mut conn = Connection::open(&db).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        store::initialize(&conn).unwrap();
        let mut competing = Connection::open(&db).unwrap();
        competing.busy_handler(Some(|attempt| {
            WAITING.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(1));
            attempt < 10_000
        })).unwrap();
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        let worker_path = path.clone();
        let worker = std::thread::spawn(move || ingest_file(&mut competing, "codex", &worker_path, i64::MAX));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !WAITING.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(WAITING.load(Ordering::SeqCst), "competing collector did not reach the write lock");
        // The writer already holding the reservation commits the complete file while
        // the second collector is waiting. The waiter must reload that checkpoint.
        let mut state = parser::ParserState::default();
        let catalog = crate::model_catalog::CatalogSnapshot::default();
        for row in &rows {
            let parsed = parser::parse_line(&mut state, "codex", &path, &row.to_string(), 0).unwrap();
            apply(&tx, parsed, "codex", &path, i64::MAX, 0, &catalog).unwrap();
        }
        let offset = source.len() as u64;
        state.file_tail_digest = Some(cursor_tail_digest(&mut Cursor::new(source.as_bytes()), offset).unwrap());
        tx.execute("INSERT INTO monitor_files(path,tool,offset,signature,state) VALUES(?1,'codex',?2,?3,?4)",
            params![path.to_string_lossy(), offset, format!("{:x}", md5::compute(&source.as_bytes()[..256])),
                serde_json::to_string(&state).unwrap()]).unwrap();
        let before_cost: String = tx.query_row("SELECT cost FROM monitor_requests", [], |row| row.get(0)).unwrap();
        tx.commit().unwrap();
        worker.join().unwrap().unwrap();
        let stored_offset: u64 = conn.query_row("SELECT offset FROM monitor_files", [], |row| row.get(0)).unwrap();
        let totals = store::sum_sessions(&store::sessions(&conn, None, 0).unwrap());
        assert_eq!((totals.request_count, totals.input_tokens, totals.output_tokens), (1, 100, 10));
        assert_eq!(conn.query_row::<String, _, _>("SELECT cost FROM monitor_requests", [], |row| row.get(0)).unwrap(), before_cost);
        drop(conn);
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(stored_offset, offset, "a waiting collector must not overwrite a newer committed cursor");
    }

    #[test]
    fn discovery_keeps_newest_first_and_excludes_unrelated_files() {
        let root = std::env::temp_dir().join(format!(
            "monitor-discovery-order-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(root.join("nested")).unwrap();
        let older = root.join("older.jsonl");
        let newer = root.join("nested/newer.jsonl");
        let artifact = root.join("artifact.json");
        for (path, seconds) in [(&older, 100), (&newer, 200), (&artifact, 300)] {
            let file = File::create(path).unwrap();
            file.set_modified(UNIX_EPOCH + Duration::from_secs(seconds)).unwrap();
        }
        let result = discover(&SourceRoot { tool: "codex".into(), path: root.clone() });
        fs::remove_dir_all(root).unwrap();
        assert_eq!(result.unwrap(), [newer, older]);
    }

    #[test]
    fn deepseek_discovery_root_honors_custom_home_and_empty_default() {
        let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("ledger-dsh-discovery-{}", std::process::id()));
        let _home = crate::EnvGuard::set("USERPROFILE", &home);
        let custom = home.join("custom-dsh");
        let override_home = crate::EnvGuard::set("DSH_HOME", &custom);
        let (sources, _) = roots().unwrap();
        assert_eq!(sources.iter().find(|source| source.tool == super::super::deepseek::TOOL).unwrap().path, custom.join("sessions"));
        drop(override_home);
        let _default_home = crate::EnvGuard::set("DSH_HOME", "");
        let (sources, _) = roots().unwrap();
        assert_eq!(sources.iter().find(|source| source.tool == super::super::deepseek::TOOL).unwrap().path, home.join(".dsh/sessions"));
    }

    #[test]
    fn explicit_native_response_ids_control_pairing_across_order_batches_and_replay() {
        use std::io::Write;
        for (reverse,different,split) in [false,true].into_iter().flat_map(|r| [false,true].into_iter()
            .flat_map(move |d| [false,true].into_iter().map(move |s| (r,d,s)))) {
            let root = std::env::temp_dir().join(format!("monitor-native-alias-{}-{}-{reverse}-{different}-{split}",std::process::id(),
                std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
            let path = root.join("sessions/rollout.jsonl");
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let tokens = json!({"input_tokens":100,"output_tokens":20,"cached_input_tokens":0,
                "cache_write_input_tokens":0,"reasoning_output_tokens":0});
            let legacy_id = if different { "other-r" } else { "native-r" };
            let legacy = json!({"type":"event_msg","timestamp":"2026-10-15T17:01:00Z","payload":{
                "type":"token_count","response_id":legacy_id,"info":{"total_token_usage":tokens,"last_token_usage":tokens},
                "rate_limits":{"limit_id":"codex","plan_type":"pro","secondary":{"window_minutes":10080,"resets_at":1800000000}}}});
            let canonical = json!({"type":"token_usage_record","timestamp":"2026-10-15T17:01:00Z","payload":{
                "thread_id":"thread","turn_id":"turn","response_id":"native-r","response_model":"actual-model",
                "usage":tokens,"thread_token_usage":tokens}});
            let headers = [json!({"type":"session_meta","payload":{"id":"thread"}}),
                json!({"type":"turn_context","payload":{"turn_id":"turn","model":"requested-model"}})];
            let events = if reverse { [canonical,legacy] } else { [legacy,canonical] };
            fs::write(&path, headers.iter().map(|row|format!("{row}\n")).collect::<String>()).unwrap();
            let ledger = root.join("ledger.sqlite");
            let mut conn = crate::ledger_db::open(&ledger).unwrap();
            store::initialize(&conn).unwrap();
            for event in &events {
                let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
                writeln!(file,"{event}").unwrap();
                drop(file);
                if split {
                    ingest_file(&mut conn,"codex",&path,i64::MAX).unwrap();
                    drop(conn);
                    conn = crate::ledger_db::open(&ledger).unwrap();
                    store::initialize(&conn).unwrap();
                }
            }
            for _ in 0..2 {
                ingest_file(&mut conn,"codex",&path,i64::MAX).unwrap();
                let totals = store::sum_sessions(&store::sessions(&conn,None,0).unwrap());
                let count = if different { 2 } else { 1 };
                assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens),(count,count*100,count*20),
                    "reverse={reverse} different={different} split={split}");
                let (id,model,basis):(String,String,String) = conn.query_row(
                    "SELECT id,json_extract(usage,'$.model'),json_extract(usage,'$.usageBasis') FROM monitor_requests WHERE json_extract(usage,'$.requestId')='native-r'",[],
                    |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
                assert_eq!(model,"actual-model");
                assert_eq!(basis,"token_usage_record");
                assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_aliases WHERE tool='codex' AND id=?1",[&id],|row|row.get::<_,i64>(0)).unwrap(),0);
                assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_request_quota_evidence WHERE id=?1",[&id],|row|row.get::<_,i64>(0)).unwrap(),i64::from(!different));
                let quota_id = parser::codex_request_id("thread",legacy_id);
                assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_request_quota_evidence WHERE id=?1",[quota_id],|row|row.get::<_,i64>(0)).unwrap(),1);
                // Re-open with a deliberately invalidated file cursor to exercise replay.
                conn.execute("DELETE FROM monitor_files",[]).unwrap();
                drop(conn);
                conn = crate::ledger_db::open(&ledger).unwrap();
                store::initialize(&conn).unwrap();
            }
            drop(conn);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn native_cumulative_only_events_cannot_replace_request_usage_or_partially_commit() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("monitor-native-cumulative-{}-{}",std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let path = root.join("sessions/known.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let tokens = |input,output| json!({"input_tokens":input,"output_tokens":output,
            "cached_input_tokens":0,"cache_write_input_tokens":0,"reasoning_output_tokens":0});
        let header = json!({"type":"session_meta","payload":{"id":"thread"}});
        let canonical = json!({"type":"token_usage_record","timestamp":"2026-10-15T17:01:00Z","payload":{
            "thread_id":"thread","turn_id":"turn","response_id":"native-r","usage":tokens(10,2),"thread_token_usage":tokens(100,20)}});
        let cumulative = json!({"type":"event_msg","timestamp":"2026-10-15T17:02:00Z","payload":{
            "type":"token_count","response_id":"native-r","info":{"total_token_usage":tokens(100,20)},
            "rate_limits":{"limit_id":"codex","plan_type":"pro","secondary":{"window_minutes":10080,"resets_at":1800000000}}}});
        fs::write(&path,format!("{header}\n{canonical}\n")).unwrap();
        let ledger = root.join("ledger.sqlite");
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        ingest_file(&mut conn,"codex",&path,i64::MAX).unwrap();
        drop(conn);
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file,"{cumulative}").unwrap();drop(file);
        ingest_file(&mut conn,"codex",&path,i64::MAX).unwrap();
        let totals = store::sum_sessions(&store::sessions(&conn,None,0).unwrap());
        assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens),(1,10,2));
        assert_eq!(conn.query_row("SELECT json_extract(usage,'$.usageBasis') FROM monitor_requests",[],|row|row.get::<_,String>(0)).unwrap(),"token_usage_record");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_request_quota_evidence",[],|row|row.get::<_,i64>(0)).unwrap(),1);
        let ambiguous = root.join("sessions/ambiguous.jsonl");
        fs::write(&ambiguous,format!("{header}\n")).unwrap();
        ingest_file(&mut conn,"codex",&ambiguous,i64::MAX).unwrap();
        let before:(u64,String,String) = conn.query_row("SELECT offset,signature,state FROM monitor_files WHERE path=?1",[ambiguous.to_string_lossy()],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        let mut file = fs::OpenOptions::new().append(true).open(&ambiguous).unwrap();
        writeln!(file,"{cumulative}\n{canonical}").unwrap();drop(file);
        assert!(ingest_file(&mut conn,"codex",&ambiguous,i64::MAX).unwrap_err().contains("cumulative-only usage"));
        let after:(u64,String,String) = conn.query_row("SELECT offset,signature,state FROM monitor_files WHERE path=?1",[ambiguous.to_string_lossy()],
            |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
        assert_eq!(before,after,"an ambiguous source must leave the committed cursor untouched");
        let totals = store::sum_sessions(&store::sessions(&conn,None,0).unwrap());
        assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens),(1,10,2));
        let sibling = root.join("sessions/sibling.jsonl");
        let mut other=canonical;
        other["payload"]["response_id"]=json!("sibling-r");
        fs::write(&sibling,format!("{header}\n{other}\n")).unwrap();
        ingest_file(&mut conn,"codex",&sibling,i64::MAX).unwrap();
        let totals = store::sum_sessions(&store::sessions(&conn,None,0).unwrap());
        assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens),(2,20,4));
        drop(conn);fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn response_namespace_upgrade_recovers_colliding_threads_from_sources_and_survives_restart() {
        use std::io::Write;
        let root = std::env::temp_dir().join(format!("monitor-response-namespace-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap();
        let ledger = root.join("ledger.sqlite");
        let event = |thread: &str, input, output, minute| json!({"type":"token_usage_record",
            "timestamp":format!("2026-10-15T17:{minute:02}:00Z"),"payload":{
                "thread_id":thread,"turn_id":format!("turn-{thread}"),"response_id":"local-response-id",
                "usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":0,
                    "cache_write_input_tokens":0,"reasoning_output_tokens":0}}});
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        let mut paths = Vec::new();
        for (thread, input, output) in [("one",10,2),("two",20,4)] {
            let path = root.join(format!("{thread}.jsonl"));
            let rows = [json!({"type":"session_meta","timestamp":"2026-10-15T17:00:00Z","payload":{"id":thread}}),
                json!({"type":"turn_context","payload":{"turn_id":format!("turn-{thread}"),"model":"gpt-6.1-sol"}}),
                event(thread,input,output,1)];
            let source = rows.iter().map(|row| format!("{row}\n")).collect::<String>();
            fs::write(&path, &source).unwrap();
            let mut state = parser::ParserState::default();
            let mut usage = None;
            for row in rows {
                usage = parser::parse_line(&mut state, "codex", &path, &row.to_string(), 0).unwrap().usage.into_iter().next().or(usage);
            }
            // Simulate the previous release: only the second thread survived
            // its global response-ID overwrite; both files were fully consumed.
            if thread == "two" {
                let mut old = usage.unwrap();
                old.id = "response:local-response-id".into();
                let tx = conn.transaction().unwrap();
                store::save_usage_with_catalog(&tx, &old, i64::MAX, 0, &crate::model_catalog::CatalogSnapshot::default()).unwrap();
                tx.commit().unwrap();
            }
            let old_cursor = serde_json::to_string(&state).unwrap().replace(
                &parser::codex_request_id(thread,"local-response-id"), "response:local-response-id");
            conn.execute("INSERT INTO monitor_files VALUES(?1,'codex',?2,?3,?4)", params![path.to_string_lossy(),source.len(),
                format!("{:x}",md5::compute(&source.as_bytes()[..source.len().min(256)])),old_cursor]).unwrap();
            paths.push(path);
        }
        conn.execute("DELETE FROM monitor_state WHERE key='codex_response_namespace_v2'", []).unwrap();
        drop(conn);
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
        for path in &paths { ingest_file(&mut conn, "codex", path, i64::MAX).unwrap(); }
        let totals = store::sum_sessions(&store::sessions(&conn, None, 0).unwrap());
        assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens), (2,30,6));
        for thread in ["one","two"] {
            let id = parser::codex_request_id(thread,"local-response-id");
            let (session, native): (String,String) = conn.query_row("SELECT session_key,json_extract(usage,'$.requestId') FROM monitor_requests WHERE id=?1", [&id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
            assert_eq!(session, format!("codex:{thread}"));
            assert_eq!(native, "local-response-id");
        }
        drop(conn);
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        for path in &paths { ingest_file(&mut conn, "codex", path, i64::MAX).unwrap(); }
        let mut file = fs::OpenOptions::new().append(true).open(&paths[0]).unwrap();
        writeln!(file,"{}",event("one",10,5,2)).unwrap();
        drop(file);
        ingest_file(&mut conn,"codex",&paths[0],i64::MAX).unwrap();
        let totals = store::sum_sessions(&store::sessions(&conn, None, 0).unwrap());
        assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens), (2,30,9));
        assert_eq!(conn.query_row("SELECT json_extract(usage,'$.outputTokens') FROM monitor_requests WHERE id=?1", [parser::codex_request_id("two","local-response-id")], |row| row.get::<_,i64>(0)).unwrap(), 4);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_state WHERE key LIKE 'codex_identity_replay_v2:%'", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn response_namespace_upgrade_recovers_only_committed_archives_and_preserves_cursors() {
        let root = std::env::temp_dir().join(format!("monitor-response-archive-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap();
        let ledger = root.join("ledger.sqlite");
        let event = |thread: &str, input, output, minute| json!({"type":"token_usage_record",
            "timestamp":format!("2026-10-15T17:{minute:02}:00Z"),"payload":{
                "thread_id":thread,"turn_id":format!("turn-{thread}"),"response_id":"local-response-id",
                "usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":0,
                    "cache_write_input_tokens":0,"reasoning_output_tokens":0}}});
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        let mut paths = Vec::new();
        for (thread, input, output) in [("one",10,2),("two",20,4)] {
            let path = root.join(format!("{thread}.jsonl"));
            let rows = [json!({"type":"session_meta","timestamp":"2026-10-15T17:00:00Z","payload":{"id":thread}}),
                json!({"type":"turn_context","payload":{"turn_id":format!("turn-{thread}"),"model":"gpt-6.1-sol"}}),
                event(thread,input,output,1)];
            let source = rows.iter().map(|row| format!("{row}\n")).collect::<String>();
            fs::write(mode_archive_path(&path), zstd::stream::encode_all(
                format!("{source}{{not_committed}}\n").as_bytes(), 1).unwrap()).unwrap();
            let mut state = parser::ParserState::default();
            let mut usage = None;
            for row in rows {
                usage = parser::parse_line(&mut state, "codex", &path, &row.to_string(), 0).unwrap().usage.into_iter().next().or(usage);
            }
            // Simulate the previous release: only the second thread survived
            // its global response-ID overwrite; both files were fully consumed.
            if thread == "two" {
                let mut old = usage.unwrap();
                old.id = "response:local-response-id".into();
                let tx = conn.transaction().unwrap();
                store::save_usage_with_catalog(&tx, &old, i64::MAX, 0, &crate::model_catalog::CatalogSnapshot::default()).unwrap();
                tx.commit().unwrap();
            }
            let old_cursor = serde_json::to_string(&state).unwrap().replace(
                &parser::codex_request_id(thread,"local-response-id"), "response:local-response-id");
            conn.execute("INSERT INTO monitor_files VALUES(?1,'codex',?2,?3,?4)", params![path.to_string_lossy(),source.len(),
                format!("{:x}",md5::compute(&source.as_bytes()[..source.len().min(256)])),old_cursor]).unwrap();
            paths.push(path);
        }
        conn.execute("UPDATE monitor_files SET state=json_set(state,'$.cursorExtension',json_object('keep',json('true')))", []).unwrap();
        conn.execute("DELETE FROM monitor_state WHERE key='codex_response_namespace_v2'", []).unwrap();
        drop(conn);
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |row| row.get::<_,i64>(0)).unwrap(), 1);
        let saved_cursors: Vec<_> = paths.iter().map(|path| conn.query_row(
            "SELECT offset,signature,state FROM monitor_files WHERE path=?1", [path.to_string_lossy()],
            |row| Ok((row.get::<_,u64>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?))).unwrap()).collect();
        let (mut pending, mut queued) = (VecDeque::new(), HashSet::new());
        enqueue_legacy_mode_archives(&conn, &mut pending, &mut queued).unwrap();
        assert_eq!(pending.len(), 2, "modern cursors still need identity archive recovery");
        while let Some((tool,path)) = pending.pop_front() {
            ingest_file(&mut conn, &tool, &path, 0).unwrap();
        }
        for (path, before) in paths.iter().zip(&saved_cursors) {
            let after = conn.query_row("SELECT offset,signature,state FROM monitor_files WHERE path=?1", [path.to_string_lossy()],
                |row| Ok((row.get::<_,u64>(0)?, row.get::<_,String>(1)?, row.get::<_,String>(2)?))).unwrap();
            assert_eq!(&after, before, "committed cursor and its extension must be preserved");
            assert_eq!(serde_json::from_str::<Value>(&after.2).unwrap()["cursorExtension"]["keep"], true);
        }
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_observations", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        let totals = store::sum_sessions(&store::sessions(&conn, None, 0).unwrap());
        assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens), (2,30,6));
        for thread in ["one","two"] {
            let id = parser::codex_request_id(thread,"local-response-id");
            let (session, native): (String,String) = conn.query_row("SELECT session_key,json_extract(usage,'$.requestId') FROM monitor_requests WHERE id=?1", [&id], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
            assert_eq!(session, format!("codex:{thread}"));
            assert_eq!(native, "local-response-id");
        }
        drop(conn);
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        for path in &paths { ingest_file(&mut conn, "codex", path, i64::MAX).unwrap(); }
        let totals = store::sum_sessions(&store::sessions(&conn, None, 0).unwrap());
        assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens), (2,30,6));
        assert!(paths.iter().all(|path| !path.exists()));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_observations", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_state WHERE key LIKE 'codex_identity_replay_v2:%'", [], |row| row.get::<_,i64>(0)).unwrap(), 0);
        drop(conn);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rewritten_file_with_the_same_header_and_size_replays_new_requests() {
        let root = std::env::temp_dir().join(format!("monitor-cursor-rewrite-{}-{}", std::process::id(),
            std::time::SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("rollout.jsonl");
        let ledger = root.join("ledger.sqlite");
        let header = json!({"type":"session_meta","timestamp":"2026-10-26T07:50:00Z",
            "payload":{"id":"thread","padding":"x".repeat(300)}});
        let usage = |id: &str| json!({"type":"event_msg","timestamp":"2026-10-26T07:50:00Z","payload":{
            "type":"token_usage_record","thread_id":"thread","turn_id":"turn","response_id":id,
            "usage":{"input_tokens":1000,"cached_input_tokens":100,"output_tokens":50,
                "cache_write_input_tokens":0,"reasoning_output_tokens":0}}});
        let original = format!("{header}\n{}\n", usage("old"));
        let rewritten = format!("{header}\n{}\n", usage("new"));
        assert_eq!(original.len(), rewritten.len());
        assert_eq!(&original.as_bytes()[..256], &rewritten.as_bytes()[..256]);
        fs::write(&path, original).unwrap();
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        ingest_file(&mut conn, "codex", &path, i64::MAX).unwrap();
        drop(conn);
        fs::write(&path, rewritten).unwrap();
        let mut conn = crate::ledger_db::open(&ledger).unwrap();
        store::initialize(&conn).unwrap();
        ingest_file(&mut conn, "codex", &path, i64::MAX).unwrap();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM monitor_requests WHERE id='response-v2:6:threadnew'", [], |row| row.get(0)).unwrap();
        // Re-reading the unchanged replacement is idempotent and retains the old history.
        ingest_file(&mut conn, "codex", &path, i64::MAX).unwrap();
        let requests: i64 = conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |row| row.get(0)).unwrap();
        drop(conn);
        fs::remove_dir_all(root).unwrap();
        assert_eq!(count, 1);
        assert_eq!(requests, 2);
    }

    #[test]
    fn empty_client_home_overrides_do_not_collect_from_the_working_directory() {
        let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!("ledger-empty-client-home-{}", std::process::id()));
        let _home = crate::EnvGuard::set("USERPROFILE", &home);
        let _codex = crate::EnvGuard::set("CODEX_HOME", "");
        let _claude = crate::EnvGuard::set("CLAUDE_CONFIG_DIR", "");
        let (sources, _) = roots().unwrap();
        let paths = |tool: &str| sources.iter().filter(|source| source.tool == tool)
            .map(|source| source.path.clone()).collect::<Vec<_>>();
        assert_eq!(paths("codex"), [home.join(".codex/sessions"), home.join(".codex/archived_sessions")]);
        assert_eq!(paths("claude"), [home.join(".claude/projects")]);
    }

    #[test]
    fn registered_presence_is_not_confused_with_discovery_filters_or_read_failure() {
        let name = format!(
            "monitor-presence-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let present = std::env::temp_dir().join(name);
        fs::write(&present, b"").unwrap();
        let missing = present.with_extension("missing");
        let result = registered_coverage(&HashSet::from([present.clone(), missing.clone()]), &[]);
        let unreadable_as_directory = discover(&SourceRoot {
            tool: "codex".into(),
            path: present.clone(),
        });
        fs::remove_file(&present).unwrap();
        assert_eq!(result.unwrap(), (1, 1));
        assert!(unreadable_as_directory.is_err());
        assert!(discover(&SourceRoot {
            tool: "codex".into(),
            path: missing
        })
        .unwrap()
        .is_empty());
    }
    #[test]
    fn oversized_tool_body_is_streamed_without_losing_the_following_record() {
        let body = serde_json::json!({"type":"response_item","timestamp":"2026-10-16T00:00:00Z","payload":{"type":"custom_tool_call_output","output":"PRIVATE BODY".repeat(100)}});
        let text = format!("{body}\n{{\"next\":true}}\n");
        let mut reader = BufReader::new(std::io::Cursor::new(text.as_bytes()));
        let mut prefix = Vec::new();
        reader.by_ref().take(64).read_to_end(&mut prefix).unwrap();
        let metadata = project_large_body(&mut Cursor::new(prefix).chain(&mut reader)).unwrap().unwrap();
        let next = reader.stream_position().unwrap();
        assert!(!metadata.contains("PRIVATE BODY"));
        assert_eq!(next, body.to_string().len() as u64 + 1);
        let mut tail = String::new();
        reader.read_line(&mut tail).unwrap();
        assert!(tail.contains("next"));
        let mut limited = BufReader::new(std::io::Cursor::new(text.as_bytes()));
        let boundary = body.to_string().len() as u64;
        assert!(project_large_body(&mut limited.by_ref().take(boundary)).unwrap().is_none());
        assert_eq!(limited.stream_position().unwrap(), boundary);
    }
    #[test]
    fn incomplete_large_record_does_not_advance_a_committed_cursor() {
        let mut reader = BufReader::new(std::io::Cursor::new(
            b"{\"type\":\"response_item\",\"payload\":{\"output\":\"unfinished",
        ));
        assert!(project_large_body(&mut reader).unwrap().is_none());
    }
}

pub fn run(runtime: MonitorRuntime) -> Result<(), String> {
    let mut conn = crate::ledger_db::open_default().map_err(|e| e.to_string())?;
    store::initialize(&conn)?;
    store::backfill_unquoted(&mut conn)?;
    super::quota::bootstrap(&conn)?;
    super::billing::bootstrap(&mut conn)?;
    let started = crate::ledger_db::now_ms();
    let (sender, receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|e| e.to_string())?;
    let mut watched = HashSet::new();
    let mut pending = VecDeque::new();
    let mut queued = HashSet::new();
    enqueue_legacy_mode_archives(&conn, &mut pending, &mut queued)?;
    let mut sources = Vec::<SourceRoot>::new();
    let mut discovery = Instant::now() - Duration::from_secs(30);
    let mut statuses = Vec::<SourceStatus>::new();
    let mut mode_paths = Vec::new();
    let mut mode_discovery_issues = Vec::new();
    let mut mode_statuses = Vec::new();
    let mut mode_read = Instant::now() - Duration::from_secs(2);
    let mut file_errors = std::collections::HashMap::<PathBuf, String>::new();
    let mut watcher_error: Option<String> = None;
    let mut coverage = super::live::CoverageWriter::new("jsonl");
    let mut account_quota_reader = super::codex_quota_accounts::Reader::new();
    loop {
        if discovery.elapsed() >= Duration::from_secs(30) {
            watcher_error = None;
            // The revision check is cheap; a new snapshot only revisits still-unquoted rows.
            store::backfill_unquoted(&mut conn)?;
            super::quota::collect_offline(&conn)?;
            match super::request_accounts::collect(&mut conn, crate::ledger_db::now_ms()) {
                Ok(n) if n>0 => if let Err(error)=super::billing::seed_proxy_requests(&mut conn){eprintln!("API billing evidence unavailable: {error}");},
                Err(error) => eprintln!("Request account evidence unavailable: {error}"),
                _ => {},
            }
            // JSONL can arrive after its proxy metadata. Reconcile dirty usage
            // even when this refresh imported no new proxy rows (or the source is offline).
            if let Err(error) = super::billing::reconcile_proxy_requests(&mut conn) {
                eprintln!("API billing evidence reconciliation unavailable: {error}");
            }
            if let Err(error) = super::accounts::capture_subscription_dates(&conn) {
                eprintln!("Subscription date cache unavailable: {error}");
            }
            let (mut discovered, registry_error) = roots()?;
            if registry_error.is_some() {
                for old in &sources {
                    if !discovered.iter().any(|r| r.path == old.path) {
                        discovered.push(old.clone());
                    }
                }
            }
            sources = discovered;
            match account_quota_reader.collect(&conn,&sources,crate::ledger_db::now_ms()) {
                Ok(bindings) => for (home,reset) in bindings {
                    if let Err(error)=backfill_account_quota_evidence(&mut conn,&home,reset) {
                        eprintln!("Codex account quota reconciliation unavailable: {error}");
                    }
                },
                Err(error) => eprintln!("Codex account quota binding unavailable: {error}"),
            }
            (mode_paths, mode_discovery_issues) = super::codex_mode_logs::discover(&sources);
            let registered = {
                let mut query = conn
                    .prepare("SELECT tool,path FROM monitor_files")
                    .map_err(|error| error.to_string())?;
                let rows = query
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            PathBuf::from(row.get::<_, String>(1)?),
                        ))
                    })
                    .map_err(|error| error.to_string())?;
                rows.collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?
            };
            statuses.clear();
            if let Some(error) = registry_error {
                statuses.push(SourceStatus {
                    tool: "codex".into(),
                    root: "Cockpit Codex instance discovery".into(),
                    status: "partial".into(),
                    error: Some(error),
                    last_scan_ms: crate::ledger_db::now_ms(),
                    ..Default::default()
                });
            }
            for root in &sources {
                let mut status = SourceStatus {
                    tool: root.tool.clone(),
                    root: root.path.to_string_lossy().into(),
                    status: if root.path.exists() {
                        "watching"
                    } else {
                        "missing"
                    }
                    .into(),
                    last_scan_ms: crate::ledger_db::now_ms(),
                    ..Default::default()
                };
                let known: HashSet<_> = registered
                    .iter()
                    .filter(|(tool, path)| tool == &root.tool && path.starts_with(&root.path))
                    .map(|(_, path)| path.clone())
                    .collect();
                status.registered_files = known.len();
                if root.path.exists() && !watched.contains(&root.path) {
                    match watcher.watch(&root.path, RecursiveMode::Recursive) {
                        Ok(()) => {
                            watched.insert(root.path.clone());
                        }
                        Err(e) => {
                            status.error=Some(format!("File watcher unavailable; 30-second reconciliation remains active: {e}"));
                        }
                    }
                }
                match discover(root) {
                    Ok(files) => {
                        if root.tool == super::deepseek::TOOL {
                            // Retired generations are no longer retried; their stale errors
                            // must not permanently suppress coverage of a healthy replacement.
                            super::deepseek::reconcile_errors(&mut file_errors, &root.path, &files);
                        }
                        status.files = files.len();
                        match registered_coverage(&known, &files) {
                            Ok((present, missing)) => {
                                status.present_registered_files = Some(present);
                                status.missing_registered_files = Some(missing);
                            }
                            Err(error) => {
                                status.status = "partial".into();
                                status.error = Some(error);
                            }
                        }
                        for file in files {
                            if queued.insert(file.clone()) {
                                pending.push_back((root.tool.clone(), file));
                            }
                        }
                    }
                    Err(e) => {
                        status.status = "error".into();
                        status.error = Some(e);
                    }
                }
                if root.tool == "antigravity" && status.files > 0 && status.error.is_none() {
                    status.status = "partial".into();
                    status.error=Some("Conversation discovery only where transcripts lack usage; quota is not token evidence".into());
                }
                conn.execute("INSERT INTO monitor_sources(root,data) VALUES(?1,?2) ON CONFLICT(root) DO UPDATE SET data=excluded.data",
                    params![status.root,serde_json::to_string(&status).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
                statuses.push(status);
            }
            discovery = Instant::now();
            super::live::prune(&conn, crate::ledger_db::now_ms())?;
        }
        let timeout = if pending.is_empty() {
            Duration::from_secs(2)
        } else {
            Duration::ZERO
        };
        if let Ok(event) = receiver.recv_timeout(timeout) {
            match event {
                Ok(event) => {
                    for path in event.paths {
                        if let Some(root) = sources.iter().find(|s| path.starts_with(&s.path)) {
                            if path.extension().is_some_and(|s| {
                                s == "jsonl" || (root.tool == super::deepseek::TOOL && s == "zstd")
                            }) && path.is_file()
                                && (root.tool != "antigravity"
                                    || path.file_name().is_some_and(|s| s == "transcript.jsonl"))
                                && queued.insert(path.clone())
                            {
                                pending.push_front((root.tool.clone(), path));
                            }
                        }
                    }
                }
                Err(e) => {
                    watcher_error = Some(format!("File watcher: {e}"));
                }
            }
        }
        if let Some((tool, path)) = pending.pop_front() {
            queued.remove(&path);
            match ingest_file(&mut conn, &tool, &path, started) {
                Ok(more) => {
                    file_errors.remove(&path);
                    if more && queued.insert(path.clone()) {
                        pending.push_back((tool, path));
                    }
                }
                Err(e) => {
                    file_errors.insert(path, e);
                }
            }
        }
        coverage.observe(&conn, "*", crate::ledger_db::now_ms(), true)?;
        if mode_read.elapsed() >= Duration::from_secs(2) {
            mode_statuses = mode_discovery_issues.clone();
            mode_statuses.extend(super::codex_mode_logs::collect(&mut conn, &mode_paths));
            mode_read = Instant::now();
        }
        for tool in ["codex", "claude", "deepseek-harness"] {
            let relevant: Vec<_> = statuses
                .iter()
                .filter(|status| status.tool == tool)
                .collect();
            let failed = watcher_error.is_some()
                || !relevant.iter().any(|status| status.status == "watching")
                || relevant.iter().any(|status| {
                    matches!(status.status.as_str(), "error" | "partial")
                        || status.error.is_some()
                        || (status.status == "missing" && status.registered_files > 0)
                })
                || file_errors.keys().any(|path| {
                    sources
                        .iter()
                        .any(|root| root.tool == tool && path.starts_with(&root.path))
                });
            if failed {
                coverage.observe(&conn, tool, crate::ledger_db::now_ms(), false)?;
            } else if pending.iter().any(|(pending_tool, _)| pending_tool == tool) {
                coverage.pause(&conn, tool)?;
            } else {
                coverage.observe(&conn, tool, crate::ledger_db::now_ms(), true)?;
            }
        }
        let mut state = runtime.inner.lock().map_err(|e| e.to_string())?;
        state.collected_at_ms = crate::ledger_db::now_ms();
        state.collecting = !pending.is_empty();
        state.sources = statuses.clone();
        state.sources.extend(mode_statuses.iter().cloned());
        state.error = file_errors
            .iter()
            .next()
            .map(|(p, e)| {
                format!(
                    "{} file(s) could not be collected; {}: {e}",
                    file_errors.len(),
                    p.display()
                )
            })
            .or_else(|| watcher_error.clone());
    }
}
