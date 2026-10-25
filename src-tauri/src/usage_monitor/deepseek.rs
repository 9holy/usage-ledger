//! Read-only integration for deepseek-ai/deepseek-harness session artifacts.
use super::{deepseek_parser, store};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
};

pub const TOOL: &str = "deepseek-harness";

fn generation(path: &Path) -> Option<u64> {
    let name = path.file_name()?.to_str()?;
    let name = name.strip_suffix(".zstd").unwrap_or(name);
    if name == "session.jsonl" {
        return Some(0);
    }
    let n = name.strip_prefix("session.v")?.strip_suffix(".jsonl")?;
    if n.starts_with('0') || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

/// Only committed generations, never temporary files or older migration copies.
pub fn discover(root: &Path) -> Result<Vec<PathBuf>, String> {
    match fs::metadata(root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
        Ok(_) => {}
    }
    let mut dirs = vec![root.to_owned()];
    let mut selected: BTreeMap<PathBuf, (u64, Vec<PathBuf>)> = BTreeMap::new();
    let mut legacy = Vec::new();
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                dirs.push(path);
            } else if kind.is_file() {
                if let Some(version) = generation(&path) {
                    let slot = selected.entry(dir.clone()).or_insert((version, Vec::new()));
                    if version > slot.0 {
                        *slot = (version, vec![path]);
                    } else if version == slot.0 {
                        slot.1.push(path);
                    }
                } else if dir.parent() == Some(root) && legacy_filename(&path) {
                    // Released pre-generation layout: root/project/<session-id>.jsonl.
                    // Surface an explicit unsupported-version error instead of hiding usage.
                    legacy.push(path);
                }
            }
        }
    }
    for (_, paths) in selected.into_values() {
        if paths.len() != 1 {
            return Err("DeepSeek Harness has conflicting plain/Zstd session generations".into());
        }
        legacy.extend(paths);
    }
    Ok(legacy)
}

/// Called only after successful discovery; other roots and active-file errors remain.
pub fn reconcile_errors(errors: &mut HashMap<PathBuf, String>, root: &Path, selected: &[PathBuf]) {
    errors.retain(|path, _| !path.starts_with(root) || selected.contains(path));
}

fn legacy_filename(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|name| {
            !name.starts_with('.')
                && !name.starts_with("session.")
                && (name.ends_with(".jsonl") || name.ends_with(".jsonl.zstd"))
        })
}

fn fingerprint(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = md5::Context::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hash.consume(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.compute()))
}

pub fn ingest(conn: &mut Connection, path: &Path, live_after: i64) -> Result<bool, String> {
    // Watch notifications may mention retired generations; reconcile selection before reading.
    let parent = path.parent().ok_or("Session artifact has no parent")?;
    if let Some(version) = generation(path) {
        let mut prefix = parent.to_string_lossy().into_owned();
        if !prefix.ends_with(std::path::MAIN_SEPARATOR) {
            prefix.push(std::path::MAIN_SEPARATOR);
        }
        let pattern = prefix.replace('!', "!!").replace('%', "!%").replace('_', "!_") + "%";
        let mut registered = conn.prepare(
            "SELECT path FROM monitor_files WHERE tool=?1 AND path LIKE ?2 ESCAPE '!'",
        ).map_err(|e| e.to_string())?;
        let paths = registered.query_map(params![TOOL, pattern], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for saved in paths {
            let saved = PathBuf::from(saved.map_err(|e| e.to_string())?);
            // A disappeared newer generation is still authoritative after a restart.
            if saved.parent() == Some(parent) && generation(&saved).is_some_and(|old| old > version) {
                return Ok(false);
            }
        }
        if !discover(parent)?.iter().any(|p| p == path) {
            return Ok(false);
        }
    }
    if generation(path).is_none() && !legacy_filename(path) {
        return Ok(false);
    }
    let signature = fingerprint(path)?;
    let key = path.to_string_lossy();
    let previous: Option<String> = conn
        .query_row(
            "SELECT signature FROM monitor_files WHERE path=?1",
            [key.as_ref()],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if previous.as_deref() == Some(&signature) {
        return Ok(false);
    }
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader: Box<dyn Read> = if path.extension().is_some_and(|e| e == "zstd") {
        Box::new(zstd::stream::read::Decoder::new(file).map_err(|e| format!("DeepSeek Zstd: {e}"))?)
    } else {
        Box::new(file)
    };
    let (session, records) = deepseek_parser::parse_artifact(BufReader::new(reader), generation(path))?;
    if fingerprint(path)? != signature {
        return Err("DeepSeek Harness artifact changed while reading; retry snapshot".into());
    }
    let catalog = crate::model_catalog::snapshot();
    let now = crate::ledger_db::now_ms();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    store::save_session(&tx, &session)?;
    let retained: HashSet<&str> = records.iter().map(|r| r.id.as_str()).collect();
    let session_key = store::session_key(TOOL, &session.id);
    let old_ids = {
        let mut query = tx
            .prepare("SELECT id FROM monitor_requests WHERE tool=?1 AND session_key=?2")
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map(params![TOOL, session_key], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for id in old_ids {
        if !retained.contains(id.as_str()) {
            store::remove_snapshot_request(&tx, TOOL, &id)?;
        }
    }
    for usage in records {
        store::save_snapshot_usage_with_catalog(&tx, &usage, live_after, now, &catalog)?;
    }
    tx.execute("INSERT INTO monitor_files(path,tool,offset,signature,state) VALUES(?1,?2,0,?3,'{}') ON CONFLICT(path) DO UPDATE SET signature=excluded.signature", params![key.as_ref(), TOOL, signature]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_canonical_generations_are_admitted() {
        for (name, expected) in [
            ("session.jsonl", Some(0)),
            ("session.v4.jsonl.zstd", Some(4)),
            ("session.v04.jsonl", None),
            ("session.v0.jsonl", None),
            ("session.v4.jsonl.tmp", None),
            ("settings.jsonl", None),
        ] {
            assert_eq!(generation(Path::new(name)), expected);
        }
    }
}
