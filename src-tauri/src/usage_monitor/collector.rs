use super::{parser, store, types::SourceStatus, MonitorRuntime};
use notify::{RecursiveMode, Watcher};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
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
    if let Some(p) = std::env::var_os("CODEX_HOME") {
        codex.push(PathBuf::from(p));
    }
    let instances = home.join(".antigravity_cockpit/codex_instances.json");
    let mut registry_error = None;
    if instances.exists() {
        match File::open(&instances)
            .map_err(|e| e.to_string())
            .and_then(|f| {
                serde_json::from_reader::<_, serde_json::Value>(f).map_err(|e| e.to_string())
            }) {
            Ok(value) => {
                if let Some(items) = value.get("instances").and_then(|v| v.as_array()) {
                    for item in items {
                        if let Some(p) = item
                            .get("user_data_dir")
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.trim().is_empty())
                        {
                            codex.push(PathBuf::from(p));
                        }
                    }
                }
            }
            Err(e) => {
                registry_error = Some(format!("Optional Codex instance registry unavailable: {e}"))
            }
        }
    }
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
    if let Some(p) = std::env::var_os("CLAUDE_CONFIG_DIR") {
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
    start: i64,
    now: i64,
    catalog: &crate::model_catalog::CatalogSnapshot,
) -> Result<(), String> {
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
    for quota in parsed.quotas {
        super::quota::save(conn, &quota)?;
    }
    Ok(())
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

fn project_large_body<R: Read + Seek>(
    reader: &mut BufReader<R>,
    offset: u64,
) -> Result<Option<(String, u64)>, String> {
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
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
    let next = reader.stream_position().map_err(|e| e.to_string())?;
    Ok(Some((serde_json::json!({"type":envelope.kind,"timestamp":envelope.timestamp,"payload":{"type":envelope.payload.kind}}).to_string(),next)))
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
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
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
    let key = path.to_string_lossy().to_string();
    let previous: Option<(u64, String, String)> = conn
        .query_row(
            "SELECT offset,signature,state FROM monitor_files WHERE path=?1",
            [&key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (mut offset, mut state) = match previous {
        Some((off, sig, json)) if off <= meta.len() && sig == signature => (
            off,
            serde_json::from_str::<parser::ParserState>(&json)
                .map_err(|e| format!("Stored parser state: {e}"))?,
        ),
        _ => (0, parser::ParserState::default()),
    };
    if tool == "codex" && offset > 0 && !state.quota_identity_loaded {
        match super::quota::account_from_header(path) {
            Ok(account) => state.quota_account_id = account,
            Err(error) => state.quota_identity_error = Some(error),
        }
        state.quota_identity_loaded = true;
        conn.execute(
            "UPDATE monitor_files SET state=?1 WHERE path=?2",
            params![
                serde_json::to_string(&state).map_err(|e| e.to_string())?,
                key
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    if offset == meta.len() {
        return Ok(false);
    }
    let catalog = crate::model_catalog::snapshot();
    reader
        .seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
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
                match project_large_body(&mut reader, offset)? {
                    Some((metadata, next)) => {
                        let parsed =
                            parser::parse_line(&mut state, tool, path, &metadata, modified)?;
                        apply(&tx, parsed, tool, live_after, now, &catalog)?;
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
        apply(&tx, parsed, tool, live_after, now, &catalog)?;
        offset += read as u64;
    }
    apply(
        &tx,
        parser::finish_batch(&mut state),
        tool,
        live_after,
        now,
        &catalog,
    )?;
    tx.execute("INSERT INTO monitor_files(path,tool,offset,signature,state) VALUES(?1,?2,?3,?4,?5)
        ON CONFLICT(path) DO UPDATE SET offset=excluded.offset,signature=excluded.signature,state=excluded.state",
        params![key,tool,offset,signature,serde_json::to_string(&state).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(!partial && offset < meta.len())
}

#[cfg(test)]
mod tests {
    use super::*;
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
        let (metadata, next) = project_large_body(&mut reader, 0).unwrap().unwrap();
        assert!(!metadata.contains("PRIVATE BODY"));
        assert_eq!(next, body.to_string().len() as u64 + 1);
        let mut tail = String::new();
        reader.read_line(&mut tail).unwrap();
        assert!(tail.contains("next"));
    }
    #[test]
    fn incomplete_large_record_does_not_advance_a_committed_cursor() {
        let mut reader = BufReader::new(std::io::Cursor::new(
            b"{\"type\":\"response_item\",\"payload\":{\"output\":\"unfinished",
        ));
        assert!(project_large_body(&mut reader, 0).unwrap().is_none());
    }
}

pub fn run(runtime: MonitorRuntime) -> Result<(), String> {
    let mut conn = crate::ledger_db::open_default().map_err(|e| e.to_string())?;
    store::initialize(&conn)?;
    store::backfill_unquoted(&mut conn)?;
    super::quota::bootstrap(&conn)?;
    let started = crate::ledger_db::now_ms();
    let (sender, receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = sender.send(event);
    })
    .map_err(|e| e.to_string())?;
    let mut watched = HashSet::new();
    let mut pending = VecDeque::new();
    let mut queued = HashSet::new();
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
    loop {
        if discovery.elapsed() >= Duration::from_secs(30) {
            watcher_error = None;
            // The revision check is cheap; a new snapshot only revisits still-unquoted rows.
            store::backfill_unquoted(&mut conn)?;
            super::quota::collect_offline(&conn)?;
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
